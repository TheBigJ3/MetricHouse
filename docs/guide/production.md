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
| Any serverless, no Redis | `memory()` | `'immediate'` | Nothing, plus `drain()` |

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
  await house.stop()     // clears timers, drains, forces a final flush
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

Move to `ioredis()` when you run more than one instance and want live reads to
describe the whole fleet rather than one process.

## Vercel

Functions freeze the moment a response is returned, so a timer never fires. Use a
shared driver and flush from a cron route.

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import Redis from 'ioredis'
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
its own cadence, so a five minute metric ships every five minutes and the calls
in between cost one clock comparison.

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
