# Serverless analytics

Page views and product events on a platform where the process freezes the moment
a response is returned. The example uses Next.js on Vercel, and the same shape
works on Cloudflare Workers and Lambda.

## What is different here

A timer inside a frozen isolate never fires, so nothing ships on its own. Two
separate things have to happen:

- **On every request**, `await house.drain()` so writes reach the driver before
  the process freezes.
- **On a schedule**, a cron route calls `house.flush()` so finished windows leave
  the driver and reach your database.

The driver has to be shared, because the isolate that took the write is probably
not the one that will flush it.

## The schema

```ts
// metrics/schema.ts
import { counter, event, int, json, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

const DEVICES = ['desktop', 'mobile', 'tablet', 'bot'] as const

// Exact page view counts, cheap to chart.
export const pageViews = counter('page_views', {
  dims: {
    // The route pattern, never the raw URL with its query string.
    path: str(),
    device: oneOf(DEVICES),
    country: str().default('unknown'),
  },
  resolution: '1m',
  flush: '1m',
  write: toClickHouse('page_views'),
})

// The detail behind them, sampled.
export const pageViewed = event('page_viewed', {
  fields: {
    sessionId: str(),
    userId: str().optional(),
    path: str(),
    referrer: str().optional(),
    device: oneOf(DEVICES),
    country: str().default('unknown'),
    viewportWidth: int().optional(),
    utm: json<Record<string, string>>().optional(),
  },

  // Durable staging, because a frozen isolate cannot ship a local buffer.
  stage: 'driver',
  flush: '1m',

  // Drop bots entirely. Sample everything else.
  sample: (fields) => (fields.device === 'bot' ? 0 : 0.2),

  // The counter is exact whatever the sampling does, because derive runs first.
  derive: {
    page_views: (fields) => ({
      dims: { path: fields.path, device: fields.device, country: fields.country },
    }),
  },

  write: toClickHouse('page_viewed'),
})

// Product events, kept in full.
export const productEvent = event('product_event', {
  fields: {
    sessionId: str(),
    userId: str().optional(),
    name: str(),
    properties: json<Record<string, unknown>>().optional(),
  },
  stage: 'driver',
  flush: '1m',

  // After an outage the backlog can be large. Bound what one insert carries.
  claimLimit: 10_000,

  write: toClickHouse('product_event'),
})
```

## The house

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import Redis from 'ioredis'
import * as schema from './schema.js'

// Safe at module scope. createHouse opens no connections, and the client
// factory is not called until the first write, so importing this file in a
// build step never touches the network.
export const house = createHouse({
  driver: ioredis(() => new Redis(process.env.REDIS_URL!)),
  schema,
  defaults: { flush: '1m' },
  onError: (error, { metric }) => console.error(`[${metric}]`, error),
})
```

## The tracking route

```ts
// app/api/track/route.ts
import { NextRequest } from 'next/server'
import { house } from '@/metrics/house'
import { pageViewed, productEvent } from '@/metrics/schema'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const body = await request.json()

  const country = request.headers.get('x-vercel-ip-country') ?? 'unknown'
  const device = detectDevice(request.headers.get('user-agent'))

  if (body.type === 'pageview') {
    pageViewed.record({
      sessionId: body.sessionId,
      userId: body.userId,
      path: body.path,
      referrer: body.referrer,
      device,
      country,
      viewportWidth: body.viewportWidth,
      utm: body.utm,
    })
  } else {
    productEvent.record({
      sessionId: body.sessionId,
      userId: body.userId,
      name: body.name,
      properties: body.properties,
    })
  }

  // The isolate may freeze as soon as we return. This is what guarantees the
  // write actually reached Redis.
  await house.drain()

  return Response.json({ ok: true })
}
```

::: warning drain is not optional here
Without `await house.drain()`, the response returns, the isolate freezes, and the
write that was still in flight never lands. This is the single most common
mistake on serverless.
:::

## The flush route

```ts
// app/api/cron/flush/route.ts
import { house } from '@/metrics/house'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  // Vercel signs cron requests. Reject anything else.
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 })
  }

  const report = await house.flush()

  if (!report.ok) {
    console.error('flush failed', report.metrics)
    // A non 200 makes the failure visible in the cron history. Nothing is lost
    // either way, because unshipped data stays in Redis.
    return Response.json({ ok: false, metrics: report.metrics }, { status: 500 })
  }

  return Response.json({ ok: true, durationMs: report.durationMs, metrics: report.metrics })
}
```

```json
// vercel.json
{
  "crons": [{ "path": "/api/cron/flush", "schedule": "* * * * *" }]
}
```

One minute is the finest schedule Vercel crons support, and it is enough. Each
metric still honours its own cadence, so a five minute metric ships every five
minutes and the calls in between cost a single clock comparison.

## Reading it live

Because the driver is shared, any isolate can read the current numbers.

```ts
// app/api/live/route.ts
import { house } from '@/metrics/house'
import { pageViews } from '@/metrics/schema'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [topPaths, thisMinute, backlog] = await Promise.all([
    pageViews.snapshot({
      rollup: 'sum',
      groupBy: ['path'],
      orderBy: 'value',
      direction: 'desc',
      limit: 10,
    }),
    pageViews.current(),
    house.snapshot({ only: ['product_event'] }),
  ])

  return Response.json({
    topPaths,
    viewsThisMinute: thisMinute,
    unshippedEvents: backlog.product_event?.length ?? 0,
  })
}
```

## Without Redis

If you do not want to run Redis, use the memory driver with immediate delivery.
Rows reach your database as they are written, so nothing depends on an isolate
surviving.

```ts
export const house = createHouse({
  driver: memory(),
  delivery: 'immediate',
  schema,
})
```

The trade is real:

- One database call per tracked event, rather than one per minute.
- **Events are exact, and counters, gauges and timers are not.** Each isolate
  keeps its own running total for a window, and every isolate sends it under the
  same row id, because the id comes from the metric, the window and the labels.
  Your table keeps whichever total arrived last, which is one isolate's share. In
  a test with many isolates the table held 32 where 1,595 had been counted.
- So on this setup, record what you want to count as an event, and count it in
  your database. `derive` does not help here: the counter it feeds has the same
  problem. For exact counters across isolates you need a shared driver.
- Live reads only see the isolate you happen to be in.

Read [Delivery modes](/guide/delivery) before choosing this.

## Cloudflare Workers

The same schema, a different pump.

```ts
// worker.ts
import { house } from './metrics/house'
import { pageViewed } from './metrics/schema'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const body = await request.json()

    pageViewed.record({
      sessionId: body.sessionId,
      path: body.path,
      device: body.device,
      country: request.cf?.country ?? 'unknown',
    })

    // Keeps the isolate alive until the write reaches Redis, without making the
    // user wait for it.
    ctx.waitUntil(house.drain())

    return Response.json({ ok: true })
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

`ctx.waitUntil()` is better than `await` on the request path, because the user
gets their response immediately and the platform still keeps the isolate alive
until the write finishes.

## The tables

```sql
CREATE TABLE page_views (
  id         String,
  bucket_ts  DateTime64(3),
  path       String,
  device     LowCardinality(String),
  country    LowCardinality(String),
  value      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, path, device, country);

CREATE TABLE page_viewed (
  id             String,
  ts             DateTime64(3),
  sessionId      String,
  userId         Nullable(String),
  path           String,
  referrer       Nullable(String),
  device         LowCardinality(String),
  country        LowCardinality(String),
  viewportWidth  Nullable(Int64),
  utm            Nullable(String),
  _ingested_at   DateTime64(3),
  _sample_rate   Float64
)
ENGINE = MergeTree
ORDER BY (ts, path);

CREATE TABLE product_event (
  id            String,
  ts            DateTime64(3),
  sessionId     String,
  userId        Nullable(String),
  name          String,
  properties    Nullable(String),
  _ingested_at  DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (ts, name);
```

## Queries

```sql
-- Exact page views per day, from the counter.
SELECT toDate(bucket_ts) AS day, path, sum(value) AS views
FROM page_views
WHERE bucket_ts >= today() - 30
GROUP BY day, path
ORDER BY day, views DESC;
```

```sql
-- Sessions and estimated views, from the sampled detail scaled back up.
SELECT
  path,
  uniq(sessionId)       AS sampled_sessions,
  sum(1 / _sample_rate) AS estimated_views
FROM page_viewed
WHERE ts >= now() - INTERVAL 7 DAY
GROUP BY path
ORDER BY estimated_views DESC;
```

```sql
-- A signup funnel from product events.
SELECT
  countIf(name = 'signup_started')   AS started,
  countIf(name = 'signup_email')     AS email_entered,
  countIf(name = 'signup_completed') AS completed,
  completed / started                AS conversion
FROM product_event
WHERE ts >= now() - INTERVAL 7 DAY;
```

## Checklist for serverless

- [ ] The driver is shared, or delivery is immediate.
- [ ] `await house.drain()` runs on every request that writes.
- [ ] A cron route calls `house.flush()`, and it is authenticated.
- [ ] Events use `stage: 'driver'`, never `'local'`.
- [ ] `claimLimit` is set on high volume events.
- [ ] `createHouse` is at module scope, and the client is passed as a factory.
