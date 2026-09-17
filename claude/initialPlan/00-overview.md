# MetricHouse — Overview

MetricHouse is a TypeScript collection layer that owns the parts of metrics a query can never reconstruct: bucket boundaries, atomic aggregation, durable staging, and flush. It writes nothing itself — you declare metrics in a Drizzle-style schema file and supply the function that puts rows in your database.

## The rule

> The chef cooks the food. Someone else plates it.

MetricHouse owns anything that is **lost forever if not captured at write time**. It refuses to own anything **derivable at query time**. That single line decides every open question below — it is why there is a counter primitive but no histogram, and why there is no query engine and no dashboard.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Runtime | TypeScript / Node |
| Shape | Library + optional collector process |
| Datastore | **Never touched.** No SQL emitted, no schema diffed, no connection opened — you configure `write` and `flush` |
| Schema | Pre-declared, plain TS, types inferred (no client codegen) |
| Read path | Live read of unflushed data only — no query layer over the DB |
| Live rows | Carry `bucket_open` + `bucket_elapsed_ms`; `complete: true` excludes the open bucket |
| Backdating | `add(n, dims, { at })` accepted within `grace`, warned past it |
| Historical data | `house.backfill()` / `house.ingest()` — bypasses buckets entirely |
| Federation | One house's `write()` is another's `ingest()`; ids carry idempotency across hops |
| Primitives | counter, gauge, **level**, event, log, **distinct**, timer — no histogram (derive it in SQL) |
| Metadata | Counter/gauge → declared bucketing dims. Event/log → free payload |
| Dim keying | Cross-product — one series per unique combination |
| Cardinality | Open values, no runtime guard — `metrichouse check` projects the cost statically |
| Write path | Straight to driver, pipelined, no local buffer |
| Runtime | `runtime: 'server' \| 'serverless' \| 'edge'`; `drain()` is the only write guarantee where there is no `SIGTERM` |
| Packaging | Subpath exports — `metrichouse/core` for the write path, drivers behind their own specifiers |
| Flush trigger | Explicit — you call `flush()` |
| Resolution vs flush | Independent, per-metric configurable |
| Durability | At-least-once on Redis, best-effort in memory |
| Dedupe | Deterministic row `id` on every row |
| After ack | Buckets deleted — opt-in `retention` TTL per metric |
| Sink | Per-metric `write()` fn, flattened typed rows, global fallback |
| Memory driver | Full parity, legitimate for single-process production |

## Data flow

```
  app code
    dogPoops.add({ dogName: 'Willow', park: 'riverside' })
         │
         ▼
   ┌───────────┐  pipelined, no local buffer
   │  metric   │────────────────────────────┐
   └───────────┘                            ▼
                                   ┌──────────────────┐
                                   │      driver      │  redis | memory
                                   │   open buckets   │
                                   └──────────────────┘
                                        │        ▲
                    house.flush()       │        │  live read
                     claim closed       ▼        │  .current() / .snapshot()
                                   ┌──────────────────┐
                                   │   flush engine   │
                                   └──────────────────┘
                                            │  typed rows + deterministic id
                                            ▼
                                   ┌──────────────────┐
                                   │  your write()    │ → ClickHouse / anything
                                   └──────────────────┘
                                            │  ack
                                            ▼
                                     buckets deleted
```

## Index

**Definition**
- [01-schema.md](01-schema.md) — declaration layer and type inference
- [02-dims.md](02-dims.md) — dimensions, encoding, composite keys

**Primitives** (file numbers are stable ids, not read order)
- [03-counter.md](03-counter.md) — counter
- [04-gauge.md](04-gauge.md) — gauge
- [20-level.md](20-level.md) — level (up/down, carry-forward)
- [21-distinct.md](21-distinct.md) — distinct (unique counts)
- [05-events.md](05-events.md) — events
- [06-logs.md](06-logs.md) — logs
- [26-timer.md](26-timer.md) — timer (durations, as a gauge preset)

**Time**
- [07-buckets.md](07-buckets.md) — resolution, boundaries, open vs closed

**Runtime**
- [08-house.md](08-house.md) — the runtime instance
- [09-drivers.md](09-drivers.md) — driver contract
- [10-driver-redis.md](10-driver-redis.md) — Redis driver
- [11-driver-memory.md](11-driver-memory.md) — memory driver

**Write path**
- [12-flush.md](12-flush.md) — flush engine
- [13-sink.md](13-sink.md) — your write function
- [14-identity.md](14-identity.md) — row ids and dedupe

**Read path**
- [15-live-read.md](15-live-read.md) — current and unflushed buckets

**Write path (cont.)**
- [22-ingest.md](22-ingest.md) — historical data and federation

**Recipes**
- [23-patterns.md](23-patterns.md) — time-in-state, ratios, funnels, and what not to build

**Runtime**
- [24-runtimes.md](24-runtimes.md) — serverless, edge, drain, and the platform matrix
- [25-packaging.md](25-packaging.md) — subpath exports and testing helpers

**Tooling**
- [17-cli.md](17-cli.md) — CLI
- [18-collector.md](18-collector.md) — optional collector
- [19-diagnostics.md](19-diagnostics.md) — errors and self-observability

## Revisions

Everything below came out of building [Tollgate](../imagine/tollgate/) — an LLM
gateway written against this spec before any of it existed. Full reasoning in
[FINDINGS.md](../imagine/tollgate/FINDINGS.md).

| # | Change | Why |
| --- | --- | --- |
| 11 | `bucket_open` on live rows, `complete: true` | the open bucket is always partial; dashboards were sawtoothing |
| 05 | `metrichouse check` projects rows-per-flush | rows = series × buckets, and the multiplication was invisible |
| 03 | `level()` primitive | concurrency could not be expressed at all |
| 01 | `counter({ value: float() })` | money truncated to integers |
| 06 | `add(n, dims, { at })` | a 40s stream dumped every token into one bucket |
| 10 | opt-in `retention` TTL | delete-on-ack forced a second Redis counter for quotas |
| 04 | `event({ derive })` | one fact was six hand-maintained writes |
| 08 | `event({ sample })` + `_sample_rate` | no way to sample high-volume events |
| 13 | `snapshot({ orderBy, groupBy, limit })` | 24k rows over the wire to render 20 |
| 12 | `defineDefaults({ dims })`, `house.bind()` | provenance re-declared on every metric |
| 07 | `flush({ rowBatch, yieldBetweenBatches })` | a 5.4M-row flush blocked the request loop |
| — | `distinct()` primitive | uniques cannot be derived, and sampling destroys them |

### Round two — [Coldchain](../imagine/coldchain/) (100k IoT devices)

Built specifically to attack the round-one fixes. Five of six held;
[FINDINGS.md](../imagine/coldchain/FINDINGS.md) has the scorecard.

| # | Change | Why |
| --- | --- | --- |
| C01 + C03 | [`house.backfill()` / `house.ingest()`](22-ingest.md) | `at:` collapsed a six-day backlog into one bucket; and an edge house had good rows with nowhere to send them |
| C02 | reserved `_ingested_at` | untrusted device clocks; a backfilled row was indistinguishable from a live one |
| C06 | `level({ totalTtl })` | 100k permanent hash fields, and `evictAtZero` made it worse |
| C07 | `dumpTotals()` / `restoreTotals()` | memory-driver levels reset on every gateway reboot |
| C04 | [23-patterns.md](23-patterns.md) | time-in-state is a counter plus `at:` — a recipe, not a primitive |
| C09 | `lastWriteAt` in `house.stats()` | health reported flush lag, never ingest lag |

**Zero new primitives.** Everything Coldchain needed already existed after round
one, or was correctly someone else's job.

### Round three — [Breadcrumb](../imagine/breadcrumb/) (serverless analytics)

The first workload with **no process**. Every finding was about the runtime
contract; none was about the data model.
[FINDINGS.md](../imagine/breadcrumb/FINDINGS.md) has the cross-project scorecard.

| # | Change | Why |
| --- | --- | --- |
| B01 | [`house.drain()`](24-runtimes.md) | the isolate freezes on response; queued writes vanished with no error |
| B02 | `runtime` refuses `stage: 'memory'` | the lossy config was the ergonomic default and failed invisibly |
| B04 | `writeMode: 'immediate'` | one-request isolates have nothing to coalesce |
| B06 | `flush({ deadline })` → `{ complete, remaining }` | a backlog longer than the function timeout livelocked |
| B03 | [`httpRedis()`](10-driver-redis.md) + lazy client factory | edge runtimes have no TCP; module scope runs on every cold start |
| B05 | [subpath exports](25-packaging.md) | one entry point reached build tooling from edge middleware |
| B07 | `metrichouse/testing` | second project to hand-roll the same assertion helper |

**Zero new primitives, again.** The pattern across three projects: the data
model has held under every workload, and the runtime contract has broken under
each new one.

Two findings from round one were **accepted without a change**:

- **No live percentiles** (#02). Live read sees counters, gauges and levels;
  staged events are opaque, so p95 for the current window is unavailable.
  This is the cost of dropping histograms and it is worth paying — see
  [15-live-read.md](15-live-read.md), which now says so explicitly instead of
  leaving it to be discovered.
- **No cardinality guard on Redis** (#05). Still open values, still no runtime
  cap. The fix is the static projection in `metrichouse check`, not a guard.
  The memory driver keeps its `maxSeries` because nothing else is watching it;
  [11-driver-memory.md](11-driver-memory.md) now names the asymmetry.

## Reverted — the no-SQL boundary

MetricHouse sits between the data and the datastore. It emits no SQL, diffs no
schema, and opens no connection: you configure `write` and `flush`, and the
shape of what they land in is yours. DDL generation (`16-ddl.md`) and the
migration commands are deleted, not relocated, and three earlier revisions went
with them.

| # | Reverted | Consequence |
| --- | --- | --- |
| 09 | `str().lowCardinality()` | its only effect was `LowCardinality(String)` in generated DDL — no generator, no effect. Column types are yours |
| 14 | `ddl({ readPattern })` | the `AggregatingMergeTree` projection is yours to write if you want it |
| C05 | metric-level `rollup` | **the underlying problem is real and now unanswered by MetricHouse.** Coldchain's 7-year regulated retention at 60s resolution needs an aggregating TTL; writing it correctly is on you, and `last` in particular does not survive a rollup |
| — | `.describe(text)` | it existed to become a column comment |

`snapshot({ rollup })` in [15-live-read.md](15-live-read.md) is unrelated and
unaffected — that one collapses buckets in memory on the read path.

**What this costs, stated plainly.** [Identity](14-identity.md) mints a stable
row id so a retry is recognisable, but convergence happens in *your* store.
Build the destination to upsert on `id` or fold duplicates at read time —
MetricHouse cannot check that you did, and will not warn you.
