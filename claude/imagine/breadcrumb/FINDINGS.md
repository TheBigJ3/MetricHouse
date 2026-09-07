# Findings — Breadcrumb

Built against MetricHouse after two rounds of revisions, on the one thing
neither previous project had: **no process**. Serverless functions and edge
middleware, where the runtime freezes the isolate the instant a response is
returned.

**9 flaws · 5 missing configs · 0 missing stat types.**

Zero new primitives for the second round running. Every finding here is about
the runtime contract, not the data model — which is a good sign about the data
model and a bad one about the runtime contract.

---

## Blocking

### B01 · `.add()` is fire-and-forget, and serverless discards the isolate

`src/lib/analytics.ts`, everywhere

The spec makes two decisions that are individually correct and jointly fatal
here: writes go **straight to the driver, pipelined over an event-loop tick**,
and `.add()` **never throws or blocks** on the hot path.

```ts
export async function POST(req) {
  signup.add({ variant })           // queued in the coalescing window
  return Response.json({ ok: 1 })   // isolate FREEZES here
}                                   // the pipeline never flushes
```

The write is discarded. No error, no warning, no way to detect it from inside —
`onError` never fires because nothing failed, the process simply stopped
existing. This is not an edge case; it is every request on Vercel, Cloudflare,
Lambda, Deno Deploy, and Netlify, which is where most of the dashboards this
library was written for actually run.

**Fix:** `house.drain(): Promise<void>`, resolving when every queued write has
reached the driver, so it can be handed to `waitUntil()`. The driver already
knows when its pipeline settles — nothing exposes it. Breadcrumb's workaround is
`setTimeout(0)` and a hope.

Worth pairing with `writeMode: 'immediate' | 'microtask'`, because in a function
handling one request there is nothing to coalesce and the window buys only risk.

### B02 · `stage: 'memory'` silently loses everything, and is the obvious choice

`src/metrics/schema.ts`

Memory-staged events drain at `maxSize`, at `maxAge`, or on `close()`. In a
serverless isolate none of the three happens: it handles a handful of requests
and is discarded without a signal. Every memory-staged event is lost.

The config type-checks, reads as the sensible performance choice for
high-volume events, and quietly discards data. Breadcrumb ships `stage: 'redis'`
and pays a round trip per event — correct, but nothing told us.

**Fix:** the house should refuse `stage: 'memory'` when it cannot guarantee a
drain. A `runtime: 'serverless'` option (or detection via `process.env.VERCEL`,
`navigator.userAgent === 'Cloudflare-Workers'`) that hard-errors at declare time
is better than a footgun that only shows up as missing data.

---

## Painful but shippable

### B03 · `createHouse` assumes a connected TCP client at module scope

`src/metrics/house.ts`

`08-house.md` opens with top-level `await client.connect()`. Three problems:

1. Edge runtimes have no `net` — the only Redis available is HTTP (Upstash
   REST), and there is no HTTP driver.
2. Module scope runs on every **cold start**, so "connect once at boot" becomes
   a few thousand handshakes an hour that do nothing.
3. No lazy connect, so a cold start pays the handshake even for a request that
   emits no metrics.

Breadcrumb hand-rolls ~140 lines of Upstash REST driver and a lazy singleton.

**Fix:** ship `httpRedis({ url, token })` as a first-class driver, and let
`createHouse` accept a client factory it calls on first write rather than a
connected client.

### B05 · One entry point puts the DDL generator in an edge bundle

`src/middleware.ts`

`import { counter } from 'metrichouse'` reaches the write path, every driver,
the DDL generator, the schema differ, and the migration renderer. Tree-shaking
removes some; the driver registry and DDL type maps are reachable from the
metric objects themselves and survive.

Edge middleware has a hard bundle ceiling and runs on every request to every
page. Shipping a SQL generator into it is absurd and currently unavoidable.

**Fix:** subpath exports — `metrichouse/core` (declare + write), `metrichouse/ddl`,
`metrichouse/cli`, `metrichouse/testing`, and each driver behind its own
specifier.

### B06 · Flush is all-or-nothing against a wall-clock ceiling

`src/app/api/cron/flush/route.ts`

Explicit flush is the **best** decision in the spec for this environment — no
timer survives a runtime with no processes, and a Vercel Cron hitting
`/api/cron/flush` is exactly right.

But the endpoint has a 60-second ceiling and `flush()` does not know. A backlog
that takes 90 seconds livelocks: every invocation claims the whole thing, runs
out of time, releases the claim, and the next one repeats it. Nothing is lost —
the claim/ack design holds perfectly — but nothing ever completes, and each
individual flush "fails" cleanly enough that health looks fine.

`rowBatch` bounds what reaches the sink per call, not what gets claimed, so it
does not help.

**Fix:** `flush({ deadline })` — claim only what can plausibly ship in the time
remaining, ack what shipped, return `{ complete: false, remaining }` so the next
invocation continues instead of restarting.

### B09 · No local buffer means Redis latency is request latency

`src/middleware.ts`

"Straight to the driver, pipelined, no local buffer" assumes Redis is next to
the app. Breadcrumb's middleware runs in 18 regions against one primary. A page
view in Sydney adds ~230 ms to a request whose entire budget is 300 ms.

Tollgate never found this: single region, Redis as a sidecar. The decision was
right for that shape and is wrong for this one.

**Fix:** the mechanism already exists, from an unexpected direction — a regional
house whose `write()` posts to a central `house.ingest()` is the Coldchain C03
federation path. What is missing is a `region` concept, so a house knows which
Redis is local and a dashboard can tell regional buckets apart.

### B04 · The coalescing window buys nothing and costs correctness

`src/metrics/house.ts`

One request emits three or four writes. There is nothing to coalesce, and
deferring them to the end of the tick is precisely how B01 happens. Covered by
B01's fix; noted separately because `writeMode: 'immediate'` is useful on its
own for anyone who would rather pay latency than risk loss.

### B07 · Testing works, and every project writes the same helper differently

`src/__tests__/funnel.test.ts`

The memory driver's `.dump()` makes state reachable, so no test-only fake is
strictly required — the earlier decision not to ship one holds up. But a test
wants "did signup step 2 record once for treatment", and gets back a bucket map
keyed by an encoded dim string. `metric.snapshot()` is closer but is async,
returns buckets rather than a count, and still needs dim matching.

This is the second project to want it — Tollgate's `reconcile()` is the same
wish in a different shape.

**Fix, small:** `metric.testValue(dims): number` exported from a
`metrichouse/testing` subpath, so it never reaches a production bundle.

### B08 · No way to mark a metric as edge-safe

`src/middleware.ts`, `src/metrics/schema.ts`

Nothing in a declaration says whether a metric is safe to write from a context
with no `waitUntil`. Breadcrumb's `pageViews` write in middleware is the least
reliable line in the codebase and looks identical to every other `.add()`.

**Fix:** a lint rule or a declaration flag is probably over-engineering. A
paragraph in the docs about which runtimes can guarantee a drain is not.

---

## Missing configs

| # | Config | For |
|---|---|---|
| 1 | `house.drain(): Promise<void>` | `waitUntil()` on every serverless platform (B01) |
| 2 | `writeMode: 'immediate' \| 'microtask'` | one-request isolates (B01, B04) |
| 3 | `flush({ deadline })` → `{ complete, remaining }` | function timeouts (B06) |
| 4 | `httpRedis()` driver + lazy client factory | edge runtimes, cold starts (B03) |
| 5 | subpath exports incl. `metrichouse/testing` | bundle size, test ergonomics (B05, B07) |

## Missing stat types

None. Funnels are counter dims, variants are dims, uniques are `distinct()`,
revenue is a float counter, sessionization is plating.

---

## Scorecard across all three projects

| Feature | Tollgate | Coldchain | Breadcrumb |
| --- | --- | --- | --- |
| chef rule (no histograms, no query engine) | held | held | held |
| resolution ⟂ flush | held | held | held |
| deterministic ids | held | held (across a network) | held |
| explicit `flush()` | held | held (bandwidth-shaped) | **best decision in the spec** |
| per-metric `write()` | held | held | held |
| pre-declared dims | held | held | held |
| `level()` | added here | held, with `totalTtl` cost | unused |
| `distinct()` | added here | held | held |
| `derive` | added here | held, broke on backfill | held |
| `bind()` + shared dims | added here | held | held |
| `complete` / `bucket_open` | added here | held | held |
| `at:` backdating | added here | **broke** → `backfill()` | n/a |
| `_ingested_at` | — | added here | held (browser clocks) |
| `ingest()` federation | — | added here | **wanted again** for multi-region |
| memory driver | fine | levels reset on reboot | **silently lossy** |
| no local buffer | fine (sidecar Redis) | fine | **wrong across regions** |
| `.add()` never throws | good | good | **hides isolate freeze** |
| bundle size | n/a | n/a | **one entry point is a problem** |

## Ranked: what to change next

1. **B01** — `house.drain()`. Without it MetricHouse silently loses data on the
   most common deployment target for the exact use case that motivated it.
2. **B02** — refuse `stage: 'memory'` where a drain cannot be guaranteed. The
   ergonomic default should not be the lossy one.
3. **B05** — subpath exports. Cheap, and unblocks edge, testing, and cold start
   at once.
4. **B03** — an HTTP driver. Serverless Redis is HTTP Redis.
5. **B06** — `flush({ deadline })`. The livelock is quiet and the fix is bounded.

The pattern across three projects is worth naming: **the data model has held up
under every workload thrown at it, and the runtime contract has broken under
each new one.** Buckets, dims, identity, and the chef rule needed two additions
in three projects. The assumptions about processes, timers, connections, and
bundles have needed something every time.
