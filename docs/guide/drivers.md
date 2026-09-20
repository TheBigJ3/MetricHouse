# Drivers

A driver is where running totals and staged records live between the moment you
write them and the moment they reach your database. MetricHouse ships two.

| Driver | Import | Survives a restart | Shared across processes |
| --- | --- | --- | --- |
| `memory()` | `metrichouse/memory` | No | No |
| `ioredis()` | `metrichouse/ioredis` | Yes | Yes |

## memory

Plain JavaScript maps inside your process. No dependencies, no setup.

```ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'

const house = createHouse({ driver: memory(), schema })
```

Use it when:

- You are developing or writing tests.
- You run exactly one process, and a crash losing the last interval of data is
  acceptable.

Do not use it when:

- You run several instances and want one shared set of totals.
- The data is financial or otherwise cannot be lost.
- You are on serverless or edge, where nothing keeps the process alive to flush
  what is in it.

### Options

```ts
memory({
  maxSeries: 100_000,    // distinct dimension combinations per metric
  maxStaged: 100_000,    // staged event records per metric
})
```

Both default to 100,000 and both can be disabled with
`Number.POSITIVE_INFINITY`.

These limits exist because an unbounded dimension in a single process is an out
of memory crash with no warning. The cap turns it into a loud error that names
the metric, which is a much better failure. Leave them on.

::: warning A crash between claim and write loses that window
The memory driver's claim holds data in a map rather than moving it somewhere
durable, so `capabilities.durable` is `false`. A failed *write* recovers
perfectly. A failed *process* loses the window in flight. The house warns about
this once at startup through `onWarn`.
:::

## ioredis

Shared, durable storage over an existing Redis client.

```ts
import Redis from 'ioredis'
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'

const house = createHouse({
  driver: ioredis(new Redis(process.env.REDIS_URL!)),
  schema,
})
```

Writes go straight to Redis, pipelined, with no local buffer. Every instance
contributes to the same window, so a live read is exact across your whole fleet
rather than per process.

A claim is a real move into a key of its own, so it outlives the process that
took it. If a flusher dies holding one, a later flush finds it and merges it back
into the live set before claiming, so those rows ship rather than sitting in
Redis for ever. See [Recovering a crashed flush](/guide/reliability#recovering-a-crashed-flush).

### Passing a client lazily

Pass a function instead of a client and it is called on the first write rather
than when the module loads. That keeps importing your schema from opening a
socket, which matters in tests and build steps.

```ts
const driver = ioredis(() => new Redis(process.env.REDIS_URL!))
```

### Options

```ts
ioredis(client, {
  namespace: 'mh',         // key prefix
  maxPipelineSize: 1000,   // commands per round trip
  recoverAfter: '5m',      // how long a claim may be held before it counts as abandoned
})
```

Give two houses that share one Redis different namespaces. Every key this driver
creates starts with that prefix.

`recoverAfter` is the one number behind crash recovery. A claim held by a flusher
that is still writing looks exactly like a claim held by one that has died, and
how long it has been held is all there is to tell them apart. Keep it above your
sink's timeout. Lower and a slow write can have its window taken back and shipped
by another instance, which duplicates those rows and fails the original
acknowledgement. Higher and a crashed window waits longer to ship. Nothing is
lost either way.

### Looking at a running system

The driver exposes two extras beyond the standard contract:

```ts
const driver = ioredis(client)

driver.keyFor('http_requests', bucketTs)
// 'mh:b:http_requests:1789000260000'   the exact key, for redis-cli

await driver.scanSeries('http_requests')
// every distinct dimension combination currently live for this metric
```

`scanSeries` is how you watch for a dimension that is growing without bound. The
Redis driver has no limit of its own, so this is your early warning.

::: warning Installing ioredis
`ioredis` is an optional peer dependency. Importing `metrichouse/ioredis` is what
requires it, so an app that only uses `metrichouse/memory` never needs it
installed. The driver types the client structurally, which means it never imports
the package itself.
:::

## Capabilities

Every driver declares what it can honestly promise.

```ts
driver.capabilities
// {
//   durable: boolean,     // survives a process restart
//   shared: boolean,      // visible to other processes
//   atomicMerge: boolean, // concurrent writes to one series merge safely
// }
```

| | `memory()` | `ioredis()` |
| --- | --- | --- |
| `durable` | `false` | `true` |
| `shared` | `false` | `true` |
| `atomicMerge` | `true` | `true` |

The house reads these at startup. A driver that cannot survive a restart triggers
a warning through `onWarn`, and `delivery: 'auto'` uses them to decide when to
ship. See [Delivery modes](/guide/delivery).

## Choosing one

| Situation | Driver |
| --- | --- |
| Tests and local development | `memory()` |
| One long running server, some loss acceptable | `memory()` |
| Several instances behind a load balancer | `ioredis()` |
| Data you cannot lose | `ioredis()` |
| Serverless or edge | `ioredis()`, or `memory()` with immediate delivery |
| You want live reads across the whole fleet | `ioredis()` |

## Switching between them

The driver is a house setting, not a metric setting, so the same schema file runs
against either one without editing a metric.

```ts
const driver =
  process.env.NODE_ENV === 'production'
    ? ioredis(() => new Redis(process.env.REDIS_URL!))
    : memory()

export const house = createHouse({ driver, schema })
```

## Writing your own

The `Driver` interface is sixteen methods. It is exported, so a driver for
DynamoDB, Cloudflare Durable Objects, Postgres or anything else is an ordinary
object.

```ts
import type { Driver } from 'metrichouse/core'

export function myDriver(): Driver {
  return {
    capabilities: { durable: true, shared: true, atomicMerge: true },

    async increment(ops) { /* ... */ },
    async observe(ops) { /* ... */ },
    async append(ops) { /* ... */ },

    async readBuckets(query) { /* ... */ },
    async readPending(query) { /* ... */ },
    async countPending(metric) { /* ... */ },

    async claim(metric, upToBucketTs) { /* ... */ },
    async claimRecords(metric, limit) { /* ... */ },
    async ack(claim) { /* ... */ },
    async release(claim) { /* ... */ },
    async recover(metric) { /* ... */ },
  }
}
```

The full method by method contract, including the rules a driver has to obey, is
in the [driver contract reference](/reference/driver-contract).

## In production

A Redis setup with connection handling and health reporting:

```ts
// metrics/driver.ts
import Redis from 'ioredis'
import { ioredis } from 'metrichouse/ioredis'
import { logger } from '../logger.js'

let client: Redis | undefined

function connect(): Redis {
  if (client) return client

  client = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
  })

  client.on('error', (error) => logger.error({ err: error }, 'redis error'))
  client.on('reconnecting', () => logger.warn('redis reconnecting'))

  return client
}

export const driver = ioredis(connect, {
  namespace: process.env.METRICS_NAMESPACE ?? 'mh',
  maxPipelineSize: 1000,
  // comfortably longer than the sink timeout, so a slow write is never
  // mistaken for a dead process
  recoverAfter: '5m',
})

export async function seriesReport(metrics: string[]) {
  const report: Record<string, number> = {}
  for (const metric of metrics) {
    report[metric] = (await driver.scanSeries(metric)).length
  }
  return report
}
```

```ts
// A scheduled check that shouts before a dimension runs away.
setInterval(async () => {
  const report = await seriesReport(house.metrics().map((m) => m.name))

  for (const [metric, count] of Object.entries(report)) {
    if (count > 50_000) {
      logger.warn({ metric, count }, 'metric has a very large number of series')
    }
  }
}, 300_000)
```
