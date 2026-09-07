# Diagnostics

Diagnostics is the library's own error surface: write failures, driver outages, dropped operations, and flush timing, delivered through hooks rather than thrown exceptions on the hot path. `add()` and `record()` never throw in production — a metrics library that takes down a request handler is worse than a missing metric.

## Main functions

**Hooks** — on `createHouse`
- `onError(err, ctx)` — driver failure, write failure after retries, claim recovery failure
- `onWarn(warn, ctx)` — degraded but working: memory driver in production, `maxSeries` hit, lock lost, late write past `grace`
- `onFlush(report)` — every flush report, for wiring MetricHouse into your own monitoring

**Self-observability**
- `house.stats()` — `{ opsWritten, opsDropped, flushes, flushErrors, rowsShipped, lastFlushAt, lastWriteAt, driverLatencyMs, seriesLive }`; `lastWriteAt` is per metric, and is the closest MetricHouse can honestly get to an ingest-health signal
- `house.health()` — `{ ok, driver: 'up' | 'down', pendingClaims, oldestUnflushedBucket }`, for a `/healthz` handler
- `house.resetStats()`

**Error types**
- `MetricHouseError` with a `code`, so you can branch instead of matching strings:
  - `UNBOUND_METRIC` — `.add()` before `createHouse` registered it (this one **does** throw; it is a wiring bug, not a runtime condition)
  - `DUPLICATE_BINDING` — a metric registered to two houses
  - `INVALID_DIMS` — unknown key, missing required dim, bad `oneOf` member
  - `DRIVER_UNAVAILABLE` — driver rejected a write
  - `WRITE_FAILED` — your sink threw; claim released, rows retried
  - `CLAIM_LOST` — a claim expired mid-write; the data is recoverable, the ack is not
  - `SCHEMA_INCOMPATIBLE` — from `assertCompatible`
  - `LATE_WRITE` — an `at:` timestamp landed in a claimed or flushed bucket; carries the drift and where it was actually attributed ([07-buckets.md](07-buckets.md))
  - `INVALID_TIMESTAMP` — an `at:` more than one resolution in the future
  - `DERIVE_FAILED` — an event's `derive` function threw; the event was still staged
  - `SERIES_BUDGET` — memory driver `maxSeries` reached
  - `STAGE_UNSAFE` — `stage: 'memory'` or the memory driver declared under a runtime that cannot drain ([24-runtimes.md](24-runtimes.md))
  - `DRAIN_TIMEOUT` — `drain({ timeout })` elapsed with writes still in flight; the writes may or may not have landed, which is the honest answer

**Strictness**
- `strict: true` on the house — turn `INVALID_DIMS` into a throw instead of a drop-and-warn. Recommended in development, off in production.

## What health cannot tell you

`health()` reports on writes MetricHouse **received**. It cannot report on
writes that never arrived — a fleet where 4,000 devices went silent an hour ago
is broken, and every signal here says healthy, because everything that did
arrive was handled promptly.

`lastWriteAt` per metric is the closest honest approximation and catches a
metric that has gone entirely quiet. Per-series staleness is a question for your
database, not for a collection library.

## The rule on the hot path

| Condition | Production | `strict: true` |
| --- | --- | --- |
| Invalid dims | drop, `onWarn` | throw |
| Late `at:` write | attribute to oldest open bucket, `onWarn` | throw |
| `derive` throws | stage the event anyway, `onError` | throw |
| Driver down | drop, `onError` | throw |
| Unbound metric | throw | throw |
| Sink throws | release claim, retry, `onError` | same |

## In use

```ts
export const house = createHouse({
  driver: redis(client),
  schema,
  strict: process.env.NODE_ENV !== 'production',

  onError: (err, ctx) => {
    logger.error({ code: err.code, metric: ctx.metric }, err.message)
  },
  onWarn: (warn, ctx) => {
    logger.warn({ code: warn.code, metric: ctx.metric }, warn.message)
  },
  onFlush: (report) => {
    logger.info({ ms: report.durationMs, rows: report.totalRows }, 'flush')
  },
})
```

```ts
// /healthz
app.get('/healthz', async (_req, res) => {
  const h = await house.health()
  res.status(h.ok ? 200 : 503).json(h)
})

// {
//   ok: true,
//   driver: 'up',
//   pendingClaims: 0,
//   oldestUnflushedBucket: '2026-09-05T14:03:07Z',
// }
```

```ts
await house.stats()
// {
//   opsWritten: 148_213,
//   opsDropped: 0,
//   flushes: 41,
//   flushErrors: 1,
//   rowsShipped: 33_284,
//   lastFlushAt: '2026-09-05T14:08:09Z',
//   driverLatencyMs: { p50: 0.4, p99: 2.1 },
//   seriesLive: { dog_poops: 3, bowl_level: 12 },
// }
```
