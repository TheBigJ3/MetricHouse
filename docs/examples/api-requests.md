# API requests

A counter, a timer and a log covering one HTTP service. This is the setup most
services end up with.

## What each part answers

| Metric | Question |
| --- | --- |
| `httpRequests` | How many requests, by route and status |
| `httpLatency` | How long they took |
| `httpLatencySamples` | What the p95 and p99 are |
| `appLog` | What the application said while handling them |

## The schema

```ts
// metrics/schema.ts
import { counter, event, float, log, oneOf, str, timer } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const
// OTHER catches OPTIONS, HEAD and anything else, so a preflight cannot throw.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'] as const

export const httpRequests = counter('http_requests', {
  dims: {
    route: str(),                  // the pattern, never the raw URL
    method: oneOf(METHODS),
    status: oneOf(STATUS_CLASSES), // classes, not codes
  },
  resolution: '10s',
  flush: '1m',
  write: toClickHouse('http_requests'),
})

export const httpLatency = timer('http_latency', {
  dims: {
    route: str(),
    status: oneOf(STATUS_CLASSES),
  },
  resolution: '10s',
  flush: '1m',

  // Every timing is also written here, so percentiles are available.
  record: 'http_latency_samples',

  write: toClickHouse('http_latency'),
})

export const httpLatencySamples = event('http_latency_samples', {
  fields: {
    ...httpLatency.dims,
    duration_ms: float(),
  },

  // Keep every slow request. Sample the rest, because percentiles are stable
  // on a sample and the timer stays exact either way.
  sample: (fields) => (fields.duration_ms > 1_000 ? 1 : 0.1),

  flush: '1m',
  write: toClickHouse('http_latency_samples'),
})

export const appLog = log('app_log', {
  fields: {
    service: str(),
    requestId: str().optional(),
    userId: str().optional(),
    route: str().optional(),
  },
  levels: ['debug', 'info', 'warn', 'error'],
  minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  flush: '10s',
  write: toClickHouse('app_log'),
})
```

## The house

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import { Redis } from 'ioredis'
import * as schema from './schema.js'
import { logger } from '../logger.js'

// Several instances behind a load balancer, so the totals have to be shared.
export const house = createHouse({
  driver: ioredis(() => new Redis(process.env.REDIS_URL!)),
  schema,
  defaults: { flush: '1m', grace: '5s' },
  onError: (error, { metric }) => logger.error({ err: error, metric }, 'metric failed'),
  onWarn: (message) => logger.warn({ message }, 'metrichouse'),
})

logger.info({ delivery: house.delivery }, 'metrics ready')
```

## One middleware

Everything above is written from a single place.

```ts
// middleware/observability.ts
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { appLog, httpLatency, httpRequests } from '../metrics/schema.js'

type StatusClass = '2xx' | '3xx' | '4xx' | '5xx'
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OTHER'

// Clamped, so a 1xx or an unusual code still lands in a declared class.
const statusClass = (code: number): StatusClass =>
  code >= 500 ? '5xx' : code >= 400 ? '4xx' : code >= 300 ? '3xx' : '2xx'

const KNOWN_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const methodOf = (method: string): Method =>
  KNOWN_METHODS.includes(method) ? (method as Method) : 'OTHER'

declare module 'express-serve-static-core' {
  interface Request {
    log: ReturnType<typeof appLog.child>
    requestId: string
  }
}

export function observability(req: Request, res: Response, next: NextFunction) {
  const requestId = req.header('x-request-id') ?? randomUUID()
  req.requestId = requestId
  res.setHeader('x-request-id', requestId)

  // A child logger carrying the request context into every line downstream.
  req.log = appLog.child({ service: 'api', requestId })

  // Nothing is bound yet: the route and the status are only known at the end.
  const span = httpLatency.start()

  // Only 'finish' records. A client that hangs up before the response is
  // written fires 'close' alone, with statusCode still at its default of 200,
  // so recording it would count a fast success that never happened.
  res.on('finish', () => {
    // The route is read here, after routing has run, and the mount path is
    // added so a router mounted at /orders does not collapse into '/:id'.
    const route = req.route ? (req.baseUrl ?? '') + req.route.path : 'unmatched'
    const status = statusClass(res.statusCode)

    httpRequests.add({ route, method: methodOf(req.method), status })

    const durationMs = span.end({ route, status })

    if (res.statusCode >= 500) {
      req.log.error('request failed', { route, userId: req.auth?.userId })
    } else if (durationMs > 1_000) {
      req.log.warn('slow request', { route, userId: req.auth?.userId })
    }
  })

  next()
}
```

Three details worth copying:

- **`start()` with no dimensions, `end()` with all of them.** The route and the
  status class are only known once the response is finished.
- **Only `finish` records.** A dropped connection fires `close` with no
  response written, and `res.statusCode` is still 200 at that point. Recording
  it would file an aborted request as a fast success, so the middleware skips it.
- **Unknown methods and odd status codes are mapped, not cast.** `OPTIONS` and
  `HEAD` become `OTHER`, and the status class is clamped to the four declared
  ones. A value outside a `oneOf()` set throws, and inside a `finish` handler
  that would crash the process.

## Using the logger downstream

```ts
app.post('/orders', async (req, res) => {
  req.log.info('creating order', { userId: req.auth?.userId })

  try {
    const order = await createOrder(req.body)
    res.json(order)
  } catch (error) {
    req.log.error(error as Error, { userId: req.auth?.userId })
    res.status(500).json({ error: 'could not create order' })
  }
})
```

## Running it

```ts
// server.ts
import { house } from './metrics/house.js'
import { observability } from './middleware/observability.js'

app.use(observability)

const server = app.listen(3000)
house.start()

async function shutdown() {
  server.close()
  await house.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

## A live endpoint

Useful long before your dashboards exist.

```ts
app.get('/internal/live', async (_req, res) => {
  const [byRoute, latency, errors] = await Promise.all([
    httpRequests.snapshot({
      rollup: 'sum',
      groupBy: ['route'],
      orderBy: 'value',
      direction: 'desc',
      limit: 20,
    }),
    httpLatency.snapshot({ rollup: 'sum', groupBy: ['route'] }),
    httpRequests.snapshot({ dims: { status: '5xx' }, rollup: 'sum', groupBy: ['route'] }),
  ])

  res.json({ byRoute, latency, errors })
})
```

## The tables

```sql
CREATE TABLE http_requests (
  id         String,
  bucket_ts  DateTime64(3),
  route      String,
  method     LowCardinality(String),
  status     LowCardinality(String),
  value      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, route, method, status);

CREATE TABLE http_latency (
  id         String,
  bucket_ts  DateTime64(3),
  route      String,
  status     LowCardinality(String),
  min        Float64,
  max        Float64,
  sum        Float64,
  count      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, route, status);

CREATE TABLE http_latency_samples (
  id            String,
  ts            DateTime64(3),
  route         String,
  status        LowCardinality(String),
  duration_ms   Float64,
  _ingested_at  DateTime64(3),
  _sample_rate  Float64
)
ENGINE = MergeTree
ORDER BY (ts, route)
TTL toDateTime(ts) + INTERVAL 14 DAY;

CREATE TABLE app_log (
  id            String,
  ts            DateTime64(3),
  level         LowCardinality(String),
  message       String,
  error_stack   Nullable(String),
  service       LowCardinality(String),
  requestId     Nullable(String),
  userId        Nullable(String),
  route         Nullable(String),
  _ingested_at  DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (ts, level)
TTL toDateTime(ts) + INTERVAL 30 DAY;
```

## Queries

```sql
-- Requests per minute and error rate, per route.
SELECT
  toStartOfMinute(bucket_ts)      AS minute,
  route,
  sum(value)                      AS requests,
  sumIf(value, status = '5xx')    AS errors,
  errors / requests               AS error_rate
FROM http_requests
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY minute, route
ORDER BY minute;
```

```sql
-- Average and worst latency, from the exact timer.
SELECT
  route,
  sum(count)            AS timings,
  sum(sum) / sum(count) AS avg_ms,
  max(max)              AS slowest_ms
FROM http_latency
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY route
ORDER BY avg_ms DESC;
```

```sql
-- Percentiles, from the sampled event.
SELECT
  route,
  quantile(0.50)(duration_ms) AS p50,
  quantile(0.95)(duration_ms) AS p95,
  quantile(0.99)(duration_ms) AS p99
FROM http_latency_samples
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY route
ORDER BY p95 DESC;
```

```sql
-- Every log line for one request, in order.
SELECT ts, level, message, error_stack
FROM app_log
WHERE requestId = 'req_9f21'
ORDER BY ts;
```

## Cost

At 1,000 requests a second across 40 routes. A folded table gets at most one
row per series per bucket, and a day holds 8,640 ten second buckets. Assume each
route is called with one method and two status classes, so there are 80 series:

| Table | Rows per day | Why |
| --- | --- | --- |
| `http_requests` | at most 691,200 | 80 series times 8,640 buckets, and fewer when a series is quiet |
| `http_latency` | at most 691,200 | 40 routes times 2 status classes is the same 80 series |
| `http_latency_samples` | about 8.6 million | 1,000 a second is 86.4 million requests a day, and 10 percent of them are kept, plus every request over a second |
| `app_log` | depends on your code | Warnings and errors only, at `minLevel: 'info'` |

The two folded tables stay small whatever the traffic does, because their size
depends on how many routes you have rather than how many requests arrive. The
sample table is the one to watch, and `sample` is the setting that controls it.
