# Memory driver

The memory driver implements the full driver contract with plain `Map`s, so single-process apps, CLIs, cron jobs, and tests get identical behavior with no Redis. It is legitimate for production on one process and gives up exactly two things: sharing across instances, and surviving a crash.

It is also the **scaffold every other driver is built on**. The behaviour that
made it here first got lifted into
[`contract.ts`](../../packages/metrichouse/src/drivers/contract.ts), an
executable suite both drivers run — so "identical behavior with no Redis" is a
thing CI checks rather than a thing this page claims. See
[09-drivers.md](09-drivers.md).

## Main functions

**Construction**
- `memory(opts?)`

Opts:
- `maxSeries` — hard ceiling on live dim keys per metric; past it, writes are refused with an error naming the metric (the one place a guard exists, because there is no Redis to page you)
- `maxStaged` — the same ceiling for staged [event](05-events.md) records, counting what is in flight as well as what is waiting; a whole `append` batch is refused rather than partly staged, because a partial append would be re-sent whole on retry and duplicate the half that landed
- `maxBuckets` — ceiling on unflushed buckets per metric, protects an app that never calls `flush()`

**Driver interface** — see [09-drivers.md](09-drivers.md)
- `increment` / `observe` / `append` — synchronous under the hood, returned as resolved promises
- `claim` — moves buckets to an in-flight map; `ack` deletes, `release` merges back
- `recoverStale` — always returns `[]`; a crash took the process and the data with it
- `capabilities` — `{ durable: false, shared: false, atomicMerge: true, sketches: true, retention: true }`; a level's running total is process-local and resets on restart

**Inspection**
- `.dump()` — every live bucket as a plain object
- `.reset()` — drop everything, no flush
- `.size()` — `{ series, buckets, pendingEvents, bytesApprox }`
- `.dumpTotals(metric)` / `.restoreTotals(metric, map)` — the memory driver's level totals are process-local, so a long-lived single-process deployment should persist them on shutdown and reseed on boot

## Not for serverless

The memory driver is legitimate for a **long-lived** single process. It is
rejected under `runtime: 'serverless'` or `'edge'`, because an isolate that
handles a handful of requests and is discarded loses everything it held and
never runs `close()`. See [24-runtimes.md](24-runtimes.md).

## The guard asymmetry, on purpose

`maxSeries` exists here and **not** on the Redis driver, which is a deliberate
inconsistency worth knowing before you move between them.

Redis has `redis-cli`, `INFO memory`, an eviction policy, and usually someone
watching it. A runaway dim there is visible and survivable. The memory driver
has none of that: an unbounded dim is a silent heap climb inside the process
serving requests, and the first symptom is an OOM kill.

So the memory driver caps and warns; Redis stays open and is analysed
statically by `metrichouse check` instead. Moving from `memory()` to
`ioredis()` **removes** a guard you may have been relying on, at the same
moment it **adds** durability — which is why `maxSeries` and `maxStaged` live
in `memory.test.ts` and not in the shared contract.

## What the house does differently here

Because `capabilities.durable` is `false`, the house downgrades the metric's guarantee from at-least-once to best-effort and says so once at boot through `onWarn`. Everything else — bucketing, cadence, row shapes, ids — is byte-identical to Redis, so moving a single-process app to multi-instance is a one-line driver swap.

## In use

```ts
import { createHouse, memory } from 'metrichouse'
import * as schema from './schema'

export const house = createHouse({
  driver: memory({ maxSeries: 50_000 }),
  schema,
  write: async (rows, ctx) => ch.insert(ctx.metric, rows),
})
```

A cron job — the whole lifecycle in one process:

```ts
import { house } from './metrics/house'
import { dogPoops } from './metrics/schema'

for (const walk of await loadWalks()) {
  dogPoops.add(walk.count, { dogName: walk.dogName, park: walk.park })
}

await house.flush({ force: true })   // don't wait on the 5m cadence
await house.close()
```

Swapping to shared, durable storage later:

```diff
- driver: memory({ maxSeries: 50_000 }),
+ driver: ioredis(client),
```
