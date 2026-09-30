# Deployment targets

The only thing that really changes between platforms is who asks for a flush, and
whether the driver can be trusted to hold data between requests.

<figure class="mh-figure">
  <img src="/diagrams/runtime-pumping.svg" alt="A long running server uses house.start and house.stop. A serverless platform uses a cron calling house.flush and awaits house.drain." />
  <figcaption>Two shapes, depending on whether your process stays alive.</figcaption>
</figure>

## The decision in one table

| Platform | Driver | Delivery | Who flushes |
| --- | --- | --- | --- |
| Node server, one instance | `memory()` | `'staged'` | `house.start()` |
| Node server, several instances | `ioredis()` | `'staged'` | `house.start()` |
| Vercel functions | `ioredis()` | `'staged'` | A cron route |
| Cloudflare Workers | `ioredis()` | `'staged'` | A scheduled handler |
| AWS Lambda | `ioredis()` | `'staged'` | An EventBridge rule |
| Any serverless, no Redis | `memory()` | `'immediate'` | Nothing for events and logs, plus `drain()`. See below for folded metrics |

## A Node server

The straightforward case. The process stays alive, so a timer works.

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import * as schema from './schema.js'
import { logger } from '../logger.js'

export const house = createHouse({
  driver: memory(),
  schema,
  defaults: { flush: '1m' },
  onError: (error, { metric }) => logger.error({ err: error, metric }),
  onWarn: (message) => logger.warn({ message }, 'metrichouse'),
})
```

```ts
// server.ts
import { house } from './metrics/house.js'

const server = app.listen(3000)
house.start()

async function shutdown() {
  server.close()
  await house.stop()     // clears timers, waits for running flushes, drains, flushes the rest
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

Move to `ioredis()` when you run more than one instance and want live reads to
describe the whole fleet rather than one process. Every instance runs the same
`house.start()`. They take turns through Redis, so each metric ships once per
interval for the fleet, however many instances there are. See
[Several processes on one driver](/guide/flushing#several-processes-on-one-driver).

## Vercel

Functions freeze the moment a response is returned, so a timer never fires. Use a
shared driver and flush from a cron route.

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import { Redis } from 'ioredis'
import * as schema from './schema.js'

// Safe at module scope: createHouse opens no connections, and the client
// factory is not called until the first write.
export const house = createHouse({
  driver: ioredis(() => new Redis(process.env.REDIS_URL!)),
  schema,
  defaults: { flush: '1m' },
})
```

```ts
// app/api/track/route.ts
import { pageViews } from '@/metrics/schema'
import { house } from '@/metrics/house'

export async function POST(request: Request) {
  const { path } = await request.json()

  pageViews.add({ path })

  // The isolate may freeze as soon as we return, so make sure the write landed.
  await house.drain()

  return Response.json({ ok: true })
}
```

```ts
// app/api/cron/flush/route.ts
import { house } from '@/metrics/house'

export const dynamic = 'force-dynamic'

export async function GET() {
  const report = await house.flush()
  return Response.json({ ok: report.ok, metrics: report.metrics })
}
```

```json
// vercel.json
{
  "crons": [{ "path": "/api/cron/flush", "schedule": "* * * * *" }]
}
```

A minute is the finest schedule Vercel crons support. Each metric still honours
its own cadence, so a five minute metric ships every five minutes. A call in
between is a clock comparison when this instance made the last shipment. A
cron usually lands on a fresh or different instance that has not, so it asks
Redis for the metric's turn, one round trip per metric, and is refused there.

## Cloudflare Workers

```ts
import { house } from './metrics/house'
import { requests } from './metrics/schema'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    requests.add({ route: new URL(request.url).pathname })

    const response = await handle(request)

    // Keeps the isolate alive until the write reaches Redis.
    ctx.waitUntil(house.drain())

    return response
  },

  async scheduled(_event: ScheduledEvent, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(house.flush())
  },
}
```

```toml
# wrangler.toml
[triggers]
crons = ["* * * * *"]
```

::: warning Timers on Workers
`performance.now()` on Workers only advances across input and output, so a
[timer](/primitives/timer) measures work that waits on the network or on storage
and reads pure computation as zero. Counters, gauges, events and logs are
unaffected.
:::

## AWS Lambda

```ts
// handler.ts
import { house } from './metrics/house.js'
import { requests } from './metrics/schema.js'

export const handler = async (event: APIGatewayProxyEvent) => {
  requests.add({ route: event.path })

  const response = await handle(event)

  // The runtime freezes after this returns.
  await house.drain()

  return response
}

// A second function on an EventBridge rule, every minute.
export const flushHandler = async () => {
  const report = await house.flush()
  if (!report.ok) throw new Error('flush failed, see metric reports')
}
```

## Serverless with no Redis

If you do not want a shared driver, use `memory()` with immediate delivery. Rows
reach your database as they are written, so nothing depends on an isolate
surviving.

```ts
export const house = createHouse({
  driver: memory(),
  schema,
  delivery: 'immediate',
})
```

The cost is one database call per application write, and folded metrics resend
the same row id with a rising running total, so your table must keep the newest
row per id. Read [Delivery modes](/guide/delivery) before choosing this.

Events and logs ship on `record()` and leave the driver, so they need no flush.
Counters, gauges, levels and timers do not: immediate delivery sends their open
window and deletes nothing, so their finished windows stay in the isolate's
memory until a `flush()` claims them. Call `house.flush()` at the end of a
request, after `drain()`, so a warm isolate does not fill up with windows
that already reached your table. Each metric's cadence keeps that to one
shipment per interval.

## Changing a schema with data in storage

A schema is code, and code is deployed while the driver still holds what the
previous release wrote. With `memory()` there is nothing to inherit, because the
data dies with the process. With `ioredis()` there is, and the rules below
decide what happens to it.

**Drain before a change that touches stored shapes.** Stop writing, run
`await house.drain()`, then a final `await house.flush({ final: true })` and check
`pending()` on each event and log reads 0. Anything the driver no longer holds
cannot disagree with the new declaration.

**A rolling deploy runs both releases at once.** For a while some processes
still hold the old declaration and share a Redis with processes on the new one.
Each process does what its own declaration says, so:

- **A dim added at the end reaches old processes as a key they cannot read.** A
  process on the old declaration that flushes a series written by a new one
  finds one segment more than it declares, and its flush throws
  `decodeDimKey`. Deploy a dim change as a full stop and restart, not a rolling deploy.
- **A changed `holdFor` is not in effect until the last old process is gone.**
  A level series keeps carrying for the `holdFor` of whichever process flushes
  it, so during the roll the old value still applies.
- **A changed dim type now fails loudly.** A stored key that the new type cannot
  decode makes the metric's flush or read throw. It is not read back as a wrong
  value.

**A metric name is the key everything is stored under.**

| Change | What stays in the driver | What you see |
| --- | --- | --- |
| Rename a metric | The old name's windows, unshipped | The new name starts empty, and the old data never ships |
| Remove a metric | Its windows, unshipped | Nothing reads them, and they occupy Redis until you delete them |
| Reuse a name for a different kind, such as a counter that becomes a gauge | The old kind's windows | The flush throws a kind mismatch until those windows are deleted |

Flush the old metric to the end before you rename or remove it, and delete its
keys from Redis afterwards. They sit under the `namespace` you gave `ioredis()` (`mh` by default),
followed by the old metric name.

**Staged records keep the values they were written with.** An event or log on
`stage: 'driver'` holds each record as it was staged. If the new declaration
narrows a field, for example a `oneOf()` that drops a value, a record already
staged can still carry the dropped value. Ship those records before the change.

**A resolution change leaves old windows on the old boundaries.** A window
already in storage keeps the boundaries it was written on, and the new
resolution applies to what is written from then on. Flush every window before
you change `resolution`, so no series is split across two grids. See
[Buckets and time](/guide/buckets-and-time#where-the-boundaries-are).

## Testing

Use `memory()` and an injected clock. Real time is not needed and makes tests
slow and flaky.

```ts
import { beforeEach, expect, it } from 'vitest'
import { counter, createHouse, str } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'

it('ships one row per path per minute', async () => {
  const written: Record<string, unknown>[][] = []

  let clock = Date.UTC(2026, 0, 1, 12, 0, 0)

  const pageViews = counter('page_views', {
    dims: { path: str() },
    resolution: '1m',
    flush: '1m',
    write: (rows) => {
      written.push(rows)
    },
  })

  const house = createHouse({
    driver: memory(),
    schema: [pageViews],
    now: () => clock,
  })

  pageViews.add({ path: '/a' })
  pageViews.add({ path: '/a' })
  pageViews.add({ path: '/b' })
  await house.drain()

  expect(await pageViews.current({ path: '/a' })).toBe(2)

  // Move past the minute boundary and past the grace period.
  clock += 90_000

  const report = await house.flush()

  expect(report.ok).toBe(true)
  expect(written[0]).toHaveLength(2)
  expect(written[0]?.[0]).toMatchObject({ path: '/a', value: 2 })
})
```

Three things make this reliable:

- **`now: () => clock`** replaces the real clock, so you move time instead of
  waiting for it.
- **`await house.drain()`** makes sure writes reached the driver before you read.
- **Moving past `resolution + grace`** is what makes a window eligible to ship.
  A flush before that correctly reports nothing.

Use `flush({ force: true })` when you would rather ignore the cadence than move
the clock.

## Bundle size

Import the specific entry points in anything that ships to a browser or an edge
runtime.

| Import | Contains |
| --- | --- |
| `metrichouse/core` | Declaring, writing, reading, flushing |
| `metrichouse/memory` | The memory driver |
| `metrichouse/ioredis` | The Redis driver |
| `metrichouse` | Everything, for Node servers where size is not a concern |

The package is marked side effect free, so a bundler removes what you do not use.

## Checklist

- [ ] The driver matches how many processes you run.
- [ ] `house.delivery` is logged at startup.
- [ ] Something asks for a flush: `start()`, a cron, or immediate delivery.
- [ ] `drain()` runs before a serverless response returns.
- [ ] `stop()` runs on `SIGTERM`.
- [ ] `onError` and `onWarn` reach your logger.
- [ ] Tables exist and treat `id` as unique.
