# Findings

What building Tollgate against `initialPlan/` actually turned up. Each item
is marked in the source at the point where the workaround was written.

**14 flaws · 9 missing configs · 4 missing stat types.** Five of them would
stop Tollgate shipping.

---

## Blocking

### 11 · The open bucket is always an undercount, and nothing marks it

`src/dashboard/live.ts`

This is the headline feature and it is subtly wrong. `requests` has
resolution `10s`. A dashboard polling at an arbitrary moment reads a bucket
that is on average half full. Shown as a count it is ~50% low; shown as a
rate it is wrong by however far into the bucket the poll landed. Every series
sawtooths — dips at each boundary, recovers — which reads as a real traffic
pattern and is not one.

The row carries `bucket_ts` but no "is this bucket open" flag and no elapsed
fraction, so a caller cannot correct for it without recomputing the boundary
from the resolution. Which means the dashboard has to hardcode each metric's
resolution, defeating the point of declaring it once.

Tollgate's workaround drops the open bucket and shows the last closed one —
making the live number up to 10 seconds stale, for a feature whose whole
purpose was to not be stale.

**Fix:** `snapshot({ complete: true })` to exclude the open bucket, and put
`bucket_open: boolean` + `bucket_elapsed_ms` on live rows so a caller can
extrapolate deliberately. Cheap; the driver already knows both.

### 05 · Rows shipped = series × buckets, and nothing warns you

`src/metrics/schema.ts`

`resolution` and `flush` being independent is the design's best idea and its
sharpest edge. Tollgate's honest cardinality:

```
tenants(500) × models(12) × endpoints(6) × status(5) = 180,000 series
resolution '1s', flush '30s'                         =      30 buckets
                                                       ─────────────────
                                                        5,400,000 rows
```

Per flush. Every 30 seconds. The two knobs multiply and the multiplication is
invisible at declaration time — nothing in the schema, the CLI, or the DDL
output says what a metric will cost. `requests` had to be coarsened to `10s`,
which surrenders exactly the per-second fidelity the design exists to protect.

**Fix:** `metrichouse check` should print projected rows-per-flush per metric
from declared dims × resolution, and the schema should reject a combination
above a threshold unless explicitly acknowledged. This is a static analysis,
not a runtime guard — it does not reopen the cardinality decision.

### 01 · No float counter

`src/metrics/schema.ts`, `src/gateway/proxy.ts`, `src/gateway/billing.ts`

A request costs `$0.00042`. `counter` is `Int64`. Tollgate stores
micro-dollars and divides by `1e6`, which:

- truncates below `1e-6` USD, per request, accumulating in one party's favour
- leaks the unit into every query, the invoice generator, and the dashboard
- makes `cost_micro_usd` a name that will outlive anyone who remembers why

Redis has `HINCRBYFLOAT`. This is a spec gap, not a storage limit.

**Fix:** `counter(name, { value: float() })` → `Float64` column, `HINCRBYFLOAT`
in the driver. Or a distinct `sum()` primitive.

### 03 · No up/down gauge, and gauges do not carry forward

`src/metrics/schema.ts`, `src/gateway/proxy.ts`, `src/dashboard/live.ts`

Concurrency is a *level*, not a rate. Two separate problems:

1. There is no `inc()` / `dec()`. `set(value)` requires the caller to already
   know the total — so Tollgate keeps the real count in a module-local `Map`
   and reports it. That map is unbounded and nothing cleans it up.
2. A bucket with no observations is **absent**, not "unchanged". A quiet 10s
   window renders as a hole, not as "still 14 in flight".

Because the workaround is per-process, `inFlight` needs an `instanceId` dim,
and the dashboard must sum each instance's last value per bucket — which dips
whenever a pod is idle. The carry-forward problem, now visible in the UI.

**Fix:** a `level()` primitive with `inc()` / `dec()` / `set()`, stored as a
delta per bucket and read as a running sum, so it is correct across N
instances without an `instanceId` dim and correct across quiet buckets.

### 06 · No backdating — `at:` does not exist

`src/gateway/proxy.ts`

A streamed completion runs 40 seconds. Tokens are produced across that whole
window and every one of them lands in whatever bucket is open when the stream
*finishes*. On `10s` resolution: four empty buckets and one spike, for every
long request.

The per-second fidelity the design protects so carefully is destroyed at the
call site. Emitting per chunk is worse — it multiplies write volume by token
count and still cannot attribute a chunk to the instant it was produced.

**Fix:** `add(n, dims, { at: timestampMs })`, routed to that bucket if it is
still open or within `grace`, otherwise to the oldest open bucket with a
`LATE_WRITE` warn. Interacts with claim/ack and needs care — a backdated write
into a claimed bucket must go somewhere defined.

---

## Painful but shippable

### 10 · "Delete on ack" makes MetricHouse unusable for rate limiting

`src/gateway/ratelimit.ts`

A quota is "tokens in the last hour". Live read holds at most `flush`-worth
(60s). ClickHouse holds the rest but needs a network round trip and `FINAL`.
Neither is an hour, and stitching them on the hot path double-counts any
bucket that flushes between the two calls.

Tollgate ships a **second, parallel counter in raw Redis** with its own keys
and TTL. That is the failure mode worth naming: the project set out to have
one metrics system and ended up with two, because the first one deletes its
data the moment it becomes durable.

**Fix:** the `retention` knob that was considered and dropped — keep acked
buckets under a TTL. Opt-in, per metric, default off.

### 04 · No linked emission — one fact, six hand-maintained writes

`src/metrics/schema.ts`, `src/gateway/proxy.ts`, `src/gateway/billing.ts`

Every request writes one event (drill-down) *and* six counter increments
(aggregation), describing the same fact. Nothing enforces agreement. Adding a
token kind means editing one function and three declarations and hoping.
`billing.ts` carries a `reconcile()` query whose only job is detecting when
they drift — a test for a bug the schema could make impossible.

**Fix:** let an event declare derived counters:

```ts
event('request_completed', {
  fields: { ... },
  derive: {
    tokens: (e) => [{ dims: { kind: 'input' }, value: e.inputTokens }, ...],
    requests: (e) => [{ dims: { status: e.status }, value: 1 }],
  },
})
```

One write at the call site, fan-out owned by the schema. Note this collides
with sampling (#08): derived counters must be computed pre-sample.

### 02 · No live percentiles — the real cost of dropping histograms

`src/metrics/schema.ts`, `src/dashboard/live.ts`

Deriving percentiles from events in SQL is right for history — `queries.sql`
proves it. But live read only sees counters and gauges; staged events are
opaque. So **p95 for the current window is unavailable at any price.** The
latency panel shows min/max/avg from a gauge and blanks for p95/p99, or falls
back to a ClickHouse query that lags by `flush`.

This may be an acceptable consequence rather than a flaw — but it should be a
stated one, because "see the current bucket on the dashboard" and "no
histograms" quietly conflict for exactly one metric type, and latency is the
metric people most want percentiles for.

**Options:** accept it and document it; or add a mergeable sketch as a
*storage* type (not a query feature) so live read can answer p95 without
MetricHouse ever computing a histogram at rest.

### 08 · No sampling

`src/gateway/proxy.ts`

At 5k req/s, `request_completed` is 5k rows/s of staged events. Tollgate wants
5% of successes and 100% of errors. The spec has no knob, so `proxy.ts` does
the coin flip by hand — and nothing on the row records the rate, so every
query over the table must know it out of band and multiply.

**Fix:** `sample: 0.05 | ((fields) => number)` on an event, with the effective
rate written to a reserved `_sample_rate` column so queries can scale
correctly and reconciliation stops being guesswork.

### 13 · No ordering or top-K on live read

`src/dashboard/live.ts`

The default dashboard view is "top 20 tenants by spend right now". With
500 × 12 × 4 series, `costMicroUsd.snapshot()` pulls ~24,000 rows out of Redis
to render 20. `snapshot` takes `limit`, but a limit without an ordering is an
arbitrary 20.

**Fix:** `snapshot({ orderBy: 'value', direction: 'desc', limit: 20 })` and a
`groupBy` that collapses in the driver rather than in JS.

### 12 · `defineDefaults` does not merge dims

`src/metrics/schema.ts`, `src/metrics/house.ts`

Four provenance columns — `service`, `environment`, `region`, `release` — are
constant for the process lifetime and belong on every row. `defineDefaults`
merges `resolution`/`flush`/`grace` but not `dims`, so each metric
re-declares them and every `.add()` in `proxy.ts` spreads a `PROVENANCE`
constant.

This is the predicted cost of rejecting built-in provenance, and it landed
exactly as predicted: the fields did not go away, they moved into userland and
now have to stay in sync by hand. Types catch omissions, which helps — but it
is four extra properties on every metric call in the codebase.

**Fix:** `defineDefaults({ dims: { ... } })` merging into declarations, plus
`house.bind({ ...values })` supplying constant dim values once at boot. No
reserved names, no opinion about what provenance means.

### 07 · Flush runs on the request event loop with no yield

`src/metrics/house.ts`

Tollgate has 6 pods and no worker tier, so `setInterval(() => house.flush())`
lives in the request process. `flush({ concurrency })` limits parallel
*metrics*, but a single metric shipping 5.4M rows serializes them in one
uninterrupted stretch of JS. Requests stall.

**Fix:** `flush({ rowBatch: 50_000, yieldBetweenBatches: true })`, calling the
sink repeatedly per metric with `ctx.batch` / `ctx.batchCount` so the caller
can stream inserts.

---

## Minor

### 09 · No `LowCardinality` without a closed set

Model names change monthly. `oneOf([...])` gives the ClickHouse
`LowCardinality(String)` mapping but needs a redeploy for a new model.
`str()` accepts anything but maps to plain `String`.

**Fix:** `str().lowCardinality()` — open values, narrow storage hint.

### 14 · The DDL generator has no read-side opinion

`src/gateway/billing.ts`

`ReplacingMergeTree` sorted on the natural key is correct for dedupe, but
`SELECT` without `FINAL` can see duplicates, and `FINAL` over 12 months of
partitions is expensive enough that Tollgate invoices off a replica. The DDL
generator is the only component that knows the natural key well enough to
also emit an `AggregatingMergeTree` projection or a scheduled `OPTIMIZE`.

**Fix:** `ddl({ readPattern: 'aggregate' })` emitting a matching projection.

### Asymmetric cardinality guard

Not a flaw so much as an inconsistency: the memory driver has `maxSeries`, the
Redis driver deliberately has none. Same footgun, two different behaviours.
Worth making the asymmetry explicit in the docs so nobody discovers it by
moving from `memory()` to `redis()` and losing a guard they were relying on.

---

## Missing configs, collected

| # | Config | For |
|---|---|---|
| 1 | `counter({ value: float() })` | money, ratios |
| 2 | `add(n, dims, { at })` | streaming, backfill, ingest of external events |
| 3 | `event({ sample })` + `_sample_rate` column | high-volume events |
| 4 | `counter({ retention: '1h' })` | rate limits, quotas, sliding windows |
| 5 | `defineDefaults({ dims })`, `house.bind(values)` | provenance without reserved names |
| 6 | `str().lowCardinality()` | open sets that are still narrow |
| 7 | `snapshot({ orderBy, direction, groupBy, limit })` | top-K dashboards |
| 8 | `flush({ rowBatch, yieldBetweenBatches })` | flushing inside a request process |
| 9 | `snapshot({ complete })`, `bucket_open` on rows | correct live rates |

## Missing stat types

1. **`level()`** — up/down with `inc`/`dec`, delta-stored, carry-forward on
   read. Concurrency, queue depth, active sessions, connection pools. Cannot
   be built from a counter or a gauge; Tollgate needed it immediately.
2. **`sum()` / float counter** — see #01. Arguably a config on `counter`,
   but the DDL and driver paths differ enough to be worth naming.
3. **`distinct()`** — unique count (HyperLogLog; Redis has `PFADD`). "Unique
   tenants active right now", "unique API keys per model". This one is a
   genuine chef-not-plating case: it **cannot** be derived from counters, and
   deriving it from events breaks the moment sampling is enabled — the two
   features are mutually destructive without it.
4. **A mergeable distribution sketch** — optional, and only if #02 is judged
   a flaw rather than an accepted trade-off.

---

## What held up

Worth saying plainly, because the list above is one-sided.

- **Resolution independent of flush was the right call.** `queries.sql` rolls
  the same stored data to per-second, per-minute, and per-hour panels with no
  config change. The row-count edge (#05) is a tooling gap, not a design error.
- **Storing `sum` + `count` instead of `avg` was right,** and the reason shows
  up immediately: `sum(sum) / sum(count)` merges across any window, `avg(avg)`
  does not. Nobody had to think about it.
- **Deterministic row ids carried the billing argument.** A duplicated flush
  converges. The only surprise was the read-side cost of `FINAL` (#14).
- **Per-metric write functions paid off harder than expected.** `audit_log`
  going to Kafka while everything else goes to ClickHouse is four lines in one
  declaration, with no plugin, no adapter, and no config file.
- **Dropping histograms was right for history and wrong only for live** (#02).
  Six lines of SQL replace an entire subsystem.
- **Pre-declared dims caught the cardinality problem at design time.** #05 is
  in this document because the schema made it countable before anything ran.
  A free-form metadata model would have shipped and found out in production.

---

## Ranked: what to change before v1

1. **#11** — live rows must say whether the bucket is open. The headline
   feature is quietly wrong without it, and the fix is small.
2. **#05** — `metrichouse check` printing projected rows-per-flush. Static,
   cheap, and turns the sharpest edge into a compile-time answer.
3. **#03** — `level()`. The first metric Tollgate could not express at all.
4. **#01** — float counters. Small change, and the alternative is a unit leak
   that reaches the invoice.
5. **#06** — `at:`. Without it, any workload with requests longer than one
   bucket has systematically wrong timing, and that is most workloads.

#10 (`retention`) is sixth and the most likely to be argued about — it
reopens "delete on ack", but Tollgate's second Redis counter is the concrete
cost of leaving it closed.
