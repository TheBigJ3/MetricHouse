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
`Number.POSITIVE_INFINITY`. Anything else has to be a positive whole number,
and the driver throws when it is created if it is not. `NaN` would otherwise
switch the cap off without a word, and `0` would refuse every write.

These limits exist because an unbounded dimension in a single process is an out
of memory crash with no warning. The cap turns it into a loud error that names
the metric, which is a much better failure. Leave them on.

::: warning A crash between claim and write loses that window
The memory driver's claim holds data in a map rather than moving it somewhere
durable, so `capabilities.durable` is `false`. A failed *write* recovers
perfectly. A failed *process* loses the window in flight. The house warns about
this once at startup through `onWarn`, and once more for each event declared
`durability: 'durable'`.
:::

## ioredis

Shared, durable storage over an existing Redis client.

```ts
import { Redis } from 'ioredis'
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

The driver also keeps each metric's turn to ship, in one small key per metric,
`mh:turn:<metric>`, holding when the turn was taken and a token unique to it. Every instance can run its own flush timers, and each
metric still ships once per interval for the whole fleet. See
[Several processes on one driver](/guide/flushing#several-processes-on-one-driver).

### Passing a client lazily

Pass a function instead of a client and it is called on the first write rather
than when the module loads. That keeps importing your schema from opening a
socket, which matters in tests and build steps.

```ts
const driver = ioredis(() => new Redis(process.env.REDIS_URL!))
```

The function may be `async`, for a client that needs a secret fetched first. If
it throws or rejects, every write waiting on that attempt fails with its error,
and the next write calls the function again. A failure at startup does not
leave the driver failing for the rest of the process.

A client made by that function belongs to the driver, and nothing else can
reach it to close it. Call `driver.close()` when you are done, after
`house.stop()`, or a script will never exit:

```ts
await house.stop()      // the final flush still needs the connection
await driver.close()    // now the process can exit
```

`close()` does nothing to a client you passed in yourself. That one is yours to
close with `client.quit()`.

### Options

```ts
ioredis(client, {
  namespace: 'mh',         // key prefix
  maxPipelineSize: 1000,   // commands or scripts per round trip
  recoverAfter: '5m',      // how long a claim may be held before it counts as abandoned
})
```

Give two houses that share one Redis different namespaces. Every key this driver
creates starts with that prefix. Two houses given the same namespace share every
metric of the same name, and nothing warns you, because the two can be in
different processes that cannot see each other.

Neither a namespace nor a metric name may contain a colon or whitespace, and
that is what keeps two namespaces apart. Every key is the namespace, a short
type, then the metric, joined with colons. With a colon allowed in either, the
key for an event named `checkout` under namespace `org:e` would be the same as
the key for one named `e:checkout` under namespace `org`. A namespace with a
colon throws when the driver is created. So does one holding half of a UTF-16
surrogate pair, such as a string cut in the middle of an emoji. Redis keeps
keys as UTF-8, which cannot hold one, and every such namespace would reach
Redis as the same replacement character.

`maxPipelineSize` bounds how many commands, or Lua scripts, go to Redis in one
round trip. A batch larger than that is sent in several. Most writes are one
script per window, so this mostly matters to a level carrying a series through a
long gap, which can be ten thousand windows. All the round trips of one call
go out together, so a later call from the same process never lands between
them. Each Lua script in them is applied or refused on its own, though, and so
is each slice of 1000 operations for one window, so a refusal partway through a
large call keeps what came before it. It has to be a positive whole
number, and anything else throws when the driver is created. That includes
`NaN`, which is what `Number(process.env.MH_PIPELINE)` gives when the variable
is not set.

A Redis restart, or a dropped connection, is safe for your totals. ioredis sends
a command again after it reconnects if the first send got no reply, and the first
send may already have run. Every write carries this driver's id and a sequence
number, and Redis records which ones it has applied, so the second arrival does
nothing. Acking, releasing and recovering a claim, and claiming records, are
recorded the same way, along with the reply the first arrival gave, so a resent
ack does not fail a flush that succeeded and a resent recovery still reports the
claims it put back. The record is one small key per driver, `mh:w:<id>`, trimmed
as replies arrive and expired a day after the driver's last write.

This holds with `commandTimeout` set too. A write the client gave up on, because
it timed out or its connection closed, may still reach Redis later, since
ioredis resends it after a reconnect. Its record is kept until a write sent
after it has been answered. Redis answers a connection's commands in the order
they were sent, so by then the one given up on has run or never will.

`recoverAfter` is the one number behind crash recovery. A claim held by a flusher
that is still writing looks exactly like a claim held by one that has died, and
how long it has been held is all there is to tell them apart. Keep it above your
sink's timeout. Lower and a slow write can have its window taken back and shipped
by another instance, which duplicates those rows and fails the original
acknowledgement. Higher and a crashed window waits longer to ship. Nothing is
lost either way. A claim's age is measured by Redis's clock, not the clock of
the host that claimed it or the host checking it, so hosts whose clocks disagree
do not take each other's claims early.

### What Redis it needs

Redis 4.0 or later. The scripts set several hash fields in one `HSET`, which
Redis 4.0 added, and read Redis's clock with `TIME` inside a script that also
writes, which needs the effects replication that Redis 3.2 introduced and
Redis 5 made the default. The driver switches it on itself where it is not.

Redis Cluster is not supported. A cluster refuses a script that touches keys in
more than one hash slot, and the keys one script touches carry no hash tag to
put them in the same slot. The driver also loads each script with `SCRIPT LOAD`
on the one connection it has, and a cluster node does not share its scripts
with the others. Use a single primary, with replicas if you want them.

Set `maxmemory-policy` to `noeviction`. Under it, Redis that runs out of memory
refuses new writes, and the driver reports each one as an error. Any other
policy deletes keys instead. An `allkeys-*` policy can take any of them,
staged records and open windows included. A `volatile-*` policy takes keys that
have an expiry first, and the only keys this driver gives one are its
`mh:w:<id>` records of which writes it has applied. Losing one means a write
that ioredis sends again after a reconnect is applied a second time, and a
counter counts it twice.

A flush claims everything below its watermark in one script, and Redis runs
nothing else while a script runs. Claiming a window or two of a few thousand
series costs a few milliseconds. A backlog of about a million cells, from a
metric that has not flushed for a long time or one with a very large number of
series, holds Redis for about a second, and every other client waits that
long. Keeping flushes on schedule is what keeps claims small.

### Durable events on Redis

An event declared [`durability: 'durable'`](/primitives/event#durability) needs
nothing from the driver beyond the append it already makes: `record()` waits for
Redis to answer it. What that answer means is up to how Redis is run.

| Redis setting | Why |
| --- | --- |
| `appendonly yes` | without it Redis keeps records only in memory and in snapshots, and a crash loses everything since the last snapshot |
| `appendfsync always` | Redis writes the batch of commands it has just run to disk, and only then answers them. Under the default, `everysec`, it answers first and writes within the second |
| `maxmemory-policy noeviction` | any other policy deletes keys when memory runs short. `allkeys-*` can delete staged records, and `volatile-*` deletes the driver's records of which writes it has applied, so a resent write applies twice. See [What Redis it needs](#what-redis-it-needs) |

The driver checks none of these, because many hosted Redis services refuse the
`CONFIG` command that would read them.

`appendfsync` is the same choice Postgres makes with `synchronous_commit`, and it
costs the same. Under `always`, every write to that Redis waits for one disk
sync, and Redis gives one sync to every command that arrived together, so a burst
of records shares it. Under `everysec`, a durable record costs one round trip,
and a Redis crash can lose the last second of records that `record()` had
already resolved.

Replication is asynchronous, so a failover to a replica can lose records the
primary had answered, whatever `appendfsync` says. MetricHouse does not wait for
replicas.

When Redis is down, a durable record rejects, and the request waiting on it
fails. That makes Redis a dependency of every request that records one. How
long the rejection takes is up to the ioredis client: its `maxRetriesPerRequest`,
which retries twenty times by default, and `commandTimeout`. The same settings
decide how long `house.stop()` waits for durable records still in flight while
Redis is not answering. A client that retries without limit keeps a durable
record waiting until Redis answers, and a `commandTimeout` rejects records that
Redis usually applied anyway, as
[a rejected promise](/primitives/event#durability) describes.

### Looking at a running system

The driver exposes two extras beyond the standard contract:

```ts
const driver = ioredis(client)

driver.keyFor('http_requests', bucketTs)
// 'mh:b:http_requests:1789000260000'   the exact key, for redis-cli

await driver.scanSeries('http_requests')
// every distinct dimension combination currently live for this metric

await driver.close()
// closes the client this driver made from a factory
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

## Upgrading

- **0.4.x and 0.5.x cannot share a namespace with newer versions.** 0.4 cannot
  read the stamped records newer versions write, and 0.5 drops the `__mh_*`
  fields they carry. Upgrade from either with a full stop and drain: stop every
  process, ship what is staged, then start the new version. A rolling deploy
  puts both versions on one namespace and breaks the older one.
- **Drain events staged by 0.4.0 first.** A record staged by 0.4.0 with a
  `json()` field holding a string is stored without the marker newer versions
  use, so it ships as the bare string instead of parsed JSON. Flush every event
  and log to the end on 0.4.0 before upgrading.
- Between later versions, follow
  [Changing a schema with data in storage](/guide/production#changing-a-schema-with-data-in-storage)
  for a schema change, and the changelog for anything else.

## Writing your own

The `Driver` interface is fourteen methods and a `capabilities` property. It is exported, so a driver for
DynamoDB, Cloudflare Durable Objects, Postgres or anything else is an ordinary
object.

```ts
import type { Driver } from 'metrichouse/core'

export function myDriver(): Driver {
  return {
    capabilities: { durable: true, shared: true, atomicMerge: true },

    // Writes.
    async increment(ops) {},
    async observe(ops) {},
    async setLevel(ops) {},
    async append(ops) {},
    async dropLevels(metric, dimKeys, writtenBefore) {},

    // Reads.
    async readLevels(metric) { return [] },
    async readBuckets(query) { return [] },
    async readPending(query) { return [] },
    async countPending(metric) { return 0 },

    // Claims. Each returns the claim or report the contract describes.
    async claim(metric, upToBucketTs) { throw new Error('not implemented') },
    async claimRecords(metric, limit) { throw new Error('not implemented') },
    async ack(claim) {},
    async release(claim) {},
    async recover(metric) { throw new Error('not implemented') },
  }
}
```

The bodies are placeholders, so this compiles and does nothing useful yet.
Fill in each one from the contract.

Two more methods are optional. `readLevel` reads one series of a level, and
`sumBuckets` adds up an integer counter's window where the data lives. Leave
them out and every answer stays the same: `level.current(dims)` and
`counter.current()` read through the fourteen methods instead, which fetches
every series. Add them when your storage is across a network and a metric has
many series. The [optional reads](/reference/driver-contract#optional-reads)
section says what each one has to return.

The full method by method contract, including the rules a driver has to obey, is
in the [driver contract reference](/reference/driver-contract).

## In production

A Redis setup with connection handling and health reporting:

```ts
// metrics/driver.ts
import { Redis } from 'ioredis'
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
