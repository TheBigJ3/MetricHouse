# House

The house is the runtime instance: it binds a [driver](09-drivers.md) to your schema, holds the global fallback write function, and exposes flush and snapshot. Metrics are inert declarations until a house registers them — calling `.add()` on an unbound metric throws with a clear message rather than silently dropping data.

## Main functions

**Construction**
- `createHouse(config)` — bind driver + schema, returns the house

Config fields:
- `driver` — `redis(client)` or `memory()`
- `schema` — the imported schema module, or an array of metrics
- `write` — global fallback sink for metrics without their own
- `namespace` — key prefix, so several apps can share one Redis
- `onError` / `onWarn` — see [19-diagnostics.md](19-diagnostics.md)
- `defaults` — `resolution` / `flush` / `grace` applied where a metric omits them
- `runtime` — `'server'` (default) | `'serverless'` | `'edge'`; detected when omitted, and changes which configurations are legal ([24-runtimes.md](24-runtimes.md))
- `writeMode` — `'microtask'` (default) or `'immediate'`

**Registration**
- `.register(...metrics)` — bind metrics declared after boot
- `.bind(values)` — supply constant values for dims every metric declares (service, region, release), filled in on every write so call sites never repeat them
- `.metrics()` — every bound metric
- `.get(name)` — look one up by name

**Operations**
- `.flush(opts?)` — see [12-flush.md](12-flush.md)
- `.backfill(metric, observations, opts?)` — historical raw data, folded and identified ([22-ingest.md](22-ingest.md))
- `.ingest(metricName, rows, opts?)` — pre-materialized rows from an upstream house
- `.snapshot(opts?)` — see [15-live-read.md](15-live-read.md)
- `.stats()` — counters about MetricHouse itself
- `.drain(opts?)` — resolve when every queued write has reached the driver; the only write guarantee in a runtime with no `SIGTERM`
- `.close()` — drain memory-staged batches, release claims, close the driver

## Rules

- A metric binds to exactly **one** house; binding twice throws.
- `createHouse` is safe to call at module scope — it opens no connections of its own, it uses the client you hand it.
- `close()` is the only thing that flushes without you asking, and only for memory-staged batches that would otherwise be lost.
- `close()` never runs in a serverless isolate. `drain()` does, and must be awaited or handed to `waitUntil()` before the response returns.

## In use

```ts
// metrics/house.ts
import { createHouse, redis } from 'metrichouse'
import { createClient } from 'redis'
import * as schema from './schema'
import { ch } from '../lib/clickhouse'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

export const house = createHouse({
  driver: redis(client),
  schema,
  namespace: 'dogwalk',

  // fallback for any metric without its own write()
  write: async (rows, ctx) => ch.insert(ctx.metric, rows),

  defaults: { resolution: '1s', flush: '5m', grace: '2s' },
  onError: (err, ctx) => console.error('[metrichouse]', ctx.metric, err),
})

// constant dims, supplied once — never repeated at a call site
house.bind({
  service: 'dogwalk',
  environment: process.env.NODE_ENV ?? 'dev',
  region: process.env.FLY_REGION ?? 'iad',
  release: process.env.GIT_SHA ?? 'dev',
})
```

```ts
// server entry
import { house } from './metrics/house'

process.on('SIGTERM', async () => {
  await house.flush({ force: true })
  await house.close()
})
```

```ts
// a worker, a cron, or the collector
setInterval(() => house.flush(), 10_000)
// dog_poops still ships only every 5m — `flush` is a minimum cadence
```
