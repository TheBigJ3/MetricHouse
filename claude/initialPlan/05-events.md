# Events

Events are discrete typed records that are never aggregated, which makes them the home for the high-cardinality metadata a counter cannot hold — `userId`, `requestId`, a free-text note, a JSON payload. Each event type picks its own staging: durable through the bound driver, or batched locally in the process when volume matters more than surviving a crash.

## Main functions

**Declaration**
- `event(name, config)`

Config fields:
- `fields` — declared payload schema; `json()` is legal here, unlike dims
- `stage` — `'driver'` (durable, at-least-once) or `'local'` (cheap, lost on crash)
- `batch` — `{ maxSize: 500, maxAge: '10s' }`, when a locally staged batch ships
- `flush` — minimum shipping cadence for driver-staged events, default `'30s'`
- `claimLimit` — records one flush may carry; unlimited by default, the same as a counter's claim taking every closed bucket
- `write` — this event type's sink; falls back to the house's
- `timestamp` — `'auto'` (default, stamped at `record()`) or a `ts()` field name you supply; `record(fields, { at })` overrides both. MetricHouse additionally stamps a reserved `_ingested_at` on every row, which is the only way to tell a backfilled row from a live one after the fact — **at `record()`, not at flush**, so a released batch resends byte-identical rows
- `sample` — `number` or `(fields) => number`; the effective rate is written to a reserved `_sample_rate` column so queries can scale correctly
- `derive` — counters/levels this event also writes, computed **before** sampling

**Write**
- `.record(fields)` — stage one event
- `.record(fields, { at })` — attribute to a specific timestamp
- `.recordMany(fields[])` — stage many in one round trip

**Read**
- `.pending()` — how many events are staged and not yet shipped
- `.peek(n?)` — inspect staged events without consuming them

**Introspection**
- `.rowShape()` — the typed row your `write()` will receive

## Staging, per type

| | `stage: 'driver'` | `stage: 'local'` |
| --- | --- | --- |
| Survives crash | yes | no |
| Shared across instances | yes | no |
| Cost per event | one driver append | none until batch ships |
| Drained by | `flush()` or the collector | `flush()`, `drain()`, or automatically at `maxSize` / `maxAge` |

Use `'driver'` for an audit log. Use `'local'` for pageviews.

`drain()` ships a local batch, which the first draft left to `close()`. It ships
**once**: a sink that throws releases those records back into the buffer, and
re-shipping whatever is in the buffer would spin against a sink that is down.

**`stage: 'local'` is rejected at declare time under `runtime: 'serverless'`
or `'edge'`.** A local batch ships at `maxSize`, at `maxAge`, on `flush()` or
on `drain()`, and an isolate is discarded before any of them — so the config
would type-check and silently drop every event. See
[24-runtimes.md](24-runtimes.md). (`runtime` does not exist yet, so this is not
enforced in code.)

> **Renamed during implementation: `'redis' | 'memory'` became
> `'driver' | 'local'`.** Two reasons, both discovered by writing it. `'redis'`
> named a product the staging code never mentions — it means "whatever driver
> this house is bound to", and on the memory driver that path is real and
> tested. And `'memory'` collided head-on with the *memory driver*:
> `stage: 'memory'` on `memory()` would have named two unrelated things, one of
> which is durable-ish and one of which is not.

## Sampling and derived metrics

`sample` drops events before staging; `derive` writes counters from every event
whether it survives sampling or not. The order is fixed and matters: **derive
first, then sample.** So the counters stay exact and unbiased while the event
table holds a representative slice with its rate on every row.

This is the answer to writing one fact six times. The event declares the
fan-out, the schema owns it, and the two can no longer drift.

```ts
export const requestCompleted = event('request_completed', {
  fields: { tenantId: str(), model: str(), status: str(), inputTokens: int(), outputTokens: int() },

  // exact, from every event
  derive: {
    requests: (e) => [{ dims: { tenantId: e.tenantId, model: e.model, status: e.status }, value: 1 }],
    tokens: (e) => [
      { dims: { tenantId: e.tenantId, model: e.model, kind: 'input'  }, value: e.inputTokens  },
      { dims: { tenantId: e.tenantId, model: e.model, kind: 'output' }, value: e.outputTokens },
    ],
  },

  // sampled, for drill-down
  sample: (e) => (e.status === 'ok' ? 0.05 : 1.0),

  stage: 'driver',
  write: async (rows) => ch.insert('request_completed', rows),
})
```

A `derive` function that throws reaches `onError` and the event is still staged
— a broken fan-out must not lose the evidence. The same applies to a target no
metric declares, and to a target that is not a counter. (`DERIVE_FAILED` as a
typed code waits on [19-diagnostics.md](19-diagnostics.md), which has no code
yet; today it is a plain `Error` on the metric's `onError`.)

## In use

```ts
// metrics/schema.ts
import { event, str, int, ts, json } from 'metrichouse'
import { ch } from '../lib/clickhouse'

export const walkStarted = event('walk_started', {
  fields: {
    dogName: str(),
    walkerId: str(),
    requestId: str(),               // unbounded — fine here, never a dim
    routeMeters: int().optional(),
    weather: json<{ tempC: number; rain: boolean }>().optional(),
  },
  stage: 'driver',
  flush: '30s',
  write: async (rows) => ch.insert('walk_started', rows),
})

export const pageView = event('page_view', {
  fields: { path: str(), sessionId: str() },
  stage: 'local',
  batch: { maxSize: 1000, maxAge: '5s' },
  write: async (rows) => ch.insert('page_view', rows),
})
```

```ts
import { walkStarted } from './metrics/schema'

walkStarted.record({
  dogName: 'Willow',
  walkerId: 'u_42',
  requestId: req.id,
  routeMeters: 1840,
  weather: { tempC: 14, rain: true },
})
```

Row handed to `write()` — `id` and `ts` are minted at `record()` time, so a retried flush carries the same id:

```ts
{
  id: '018f7c2a…',            // uuidv7, assigned on record()
  ts: 2026-09-05T14:03:07.482Z,
  dogName: 'Willow',
  walkerId: 'u_42',
  requestId: 'req_9f21',
  routeMeters: 1840,
  weather: '{"tempC":14,"rain":true}',   // a json() field arrives stringified
  _ingested_at: 2026-09-05T14:03:07.482Z,
}
```

```sql
-- the histogram MetricHouse refuses to build, built in one line
SELECT quantiles(0.5, 0.95, 0.99)(routeMeters) FROM walk_started;
```
