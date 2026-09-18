# log

A log is an event with three reserved fields: `ts`, `level` and `message`. It
adds no storage of its own. Underneath it stages, batches, claims and flushes
exactly like an [event](/primitives/event), because it is one.

What it adds is the part that usually makes people install a second library: a
severity level, a filter that drops the noisy half before it costs anything, an
`Error` overload that puts the stack somewhere you can query, and a child logger
that carries context.

```ts
import { log, str } from 'metrichouse/core'

export const appLog = log('app_log', {
  fields: { service: str(), requestId: str().optional() },
  minLevel: 'info',
  flush: '30s',
  write: async (rows) => clickhouse.insert({ table: 'app_log', values: rows }),
})
```

```ts
appLog.info('server started', { service: 'checkout' })
appLog.warn('payment processor slow', { service: 'checkout' })
appLog.error(new Error('card declined'), { service: 'checkout' })
```

## Why it is here

Logs are the one signal that matters most in the minute a process is dying. A
separate logging library means a second transport, a second flush schedule and
second crash behaviour to reason about. Sharing the event pipeline means a log
inherits the staging guarantees rather than reimplementing them.

## Levels

The default levels are `['debug', 'info', 'warn', 'error']`, and each one becomes
a method.

```ts
appLog.debug('cache miss', { service: 'api' })
appLog.info('order placed', { service: 'api' })
appLog.warn('retrying upstream', { service: 'api' })
appLog.error('upstream unavailable', { service: 'api' })
```

Declare your own set and the type narrows to exactly what you list.

```ts
export const auditLog = log('audit_log', {
  fields: { actorId: str(), action: str() },
  levels: ['routine', 'sensitive', 'critical'],    // ascending severity
  minLevel: 'routine',
  flush: '10s',
  write: toS3('audit'),
})

auditLog.sensitive('permissions changed', { actorId: 'u_1', action: 'grant_admin' })

auditLog.info('...')
//       ^^^^ Type error: this log has no 'info' method
```

Order is severity, lowest first. That is the only ordering that works for a
custom set, so it is a declaration rather than a formality.

### minLevel

Anything below `minLevel` is dropped before its fields are checked and before
anything is queued.

```ts
export const appLog = log('app_log', {
  fields: { service: str() },
  minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  flush: '30s',
  write: toClickHouse('app_log'),
})

// In production this costs one array index and returns.
appLog.debug('request headers', { service: 'api' })
```

Dropped means dropped. No record is created, no field is validated and nothing is
queued.

### Choosing a level at runtime

```ts
appLog.at(level, 'message from upstream', { service: 'gateway' })
```

`at()` throws if the level is not one you declared. A log line with a level
nothing queries is worse than a loud failure at the one call site that could have
a typo.

### Try it

`minLevel` is the setting with the largest effect on what a log costs. Drag it
and watch both the volume and the bill.

<MhLogFilter />

Moving `minLevel` from `debug` to `info` in a busy service usually removes most
of the volume, and the dropped lines cost one array index each. Nothing is
built, nothing is validated, nothing is queued.

## Errors

Any level accepts an `Error` instead of a string. The message goes in the
`message` column and the stack goes in a reserved `error_stack` column.

```ts
try {
  await chargeCard(order)
} catch (error) {
  appLog.error(error as Error, { service: 'checkout', requestId })
}
```

```ts
{
  level: 'error',
  message: 'card declined',
  error_stack: 'Error: card declined\n    at chargeCard (...)',
}
```

::: tip A logger never takes down a request
Every other call in MetricHouse throws on a bad value. A log message does not. If
you pass something that is neither a string nor an `Error`, it is turned into a
string. That call is made from inside `catch` blocks, and a logger that throws
there replaces the error you were handling.
:::

## Child loggers

`child()` returns a logger that merges fields into every call it makes. It is how
a request id reaches every line without being threaded through every function.

```ts
const requestLog = appLog.child({ service: 'checkout', requestId: 'req_9f21' })

requestLog.info('checkout opened')
requestLog.warn('processor slow')
requestLog.error(new Error('declined'))
// every line carries service and requestId
```

Children nest, and each one adds to what its parent bound.

```ts
const serviceLog = appLog.child({ service: 'checkout' })
const requestLog = serviceLog.child({ requestId: 'req_9f21' })
const userLog = requestLog.child({ userId: 'u_42' })
```

A bound field becomes optional rather than absent in the child's type. That means
`child({ service })` satisfies a required field, and overriding it at one call
site is still allowed:

```ts
requestLog.info('retrying', { requestId: 'req_9f22' })   // the call site wins
```

A child is not a metric. It stages into the log that made it and shares its batch
settings and its write function.

## Tune it

Underneath, a log stages and batches exactly like an event, so the same controls
apply.

<MhEventFlow metric="app_log" kind="log" />

## Reading

```ts
await appLog.pending()          // lines staged, not yet shipped
await appLog.peek(20)           // the first 20 as rows, without consuming
await appLog.snapshot({ limit: 100 })
```

A snapshot row's `level` is typed to the levels you declared.

## The rows you receive

```ts
{
  id: '019278b4-3c21-7a4e-9f10-8c2d5b6e1a03',
  ts: Date,
  level: 'error',
  message: 'card declined',
  error_stack: 'Error: card declined\n    at ...',   // only when an Error was passed
  service: 'checkout',                               // your declared fields
  requestId: 'req_9f21',
  _ingested_at: Date,
}
```

Column order is `id, ts, level, message, error_stack`, then your fields, then
`_ingested_at`.

::: code-group

```sql [ClickHouse]
CREATE TABLE app_log (
  id            String,
  ts            DateTime64(3),
  level         LowCardinality(String),
  message       String,
  error_stack   Nullable(String),
  service       LowCardinality(String),
  requestId     Nullable(String),
  _ingested_at  DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (ts, level)
TTL toDateTime(ts) + INTERVAL 30 DAY;
```

```sql [Postgres]
CREATE TABLE app_log (
  id            TEXT PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  level         TEXT NOT NULL,
  message       TEXT NOT NULL,
  error_stack   TEXT,
  service       TEXT NOT NULL,
  "requestId"   TEXT,
  _ingested_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON app_log (ts DESC);
CREATE INDEX ON app_log (level, ts DESC);
```

:::

## Reserved names

A declared field may not be named `id`, `ts`, `level`, `message`, `error_stack`,
`_ingested_at` or `_sample_rate`.

```ts
import { RESERVED_LOG_COLUMNS } from 'metrichouse/core'
```

A level name may not shadow a method on the logger, so `levels: ['debug', 'drain']`
is rejected at declaration time rather than turning `logger.drain()` into
something that writes a log line.

## Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `fields` | shape | none | Extra fields beyond the reserved ones |
| `levels` | array of strings | `['debug','info','warn','error']` | Ascending severity |
| `minLevel` | one of `levels` | the lowest | Drop anything below this |
| `stage` | `'driver'` or `'local'` | `'driver'` | Where lines wait |
| `batch.maxSize` | number | `500` | Local staging: ship at this many |
| `batch.maxAge` | duration | `'10s'` | Local staging: ship this long after the first |
| `flush` | duration | `'30s'` | The fastest this may ship |
| `claimLimit` | number | unlimited | Lines one flush may carry |
| `write` | function | required | Where the rows go |

## In production

A request scoped logger wired into Express, shipping to S3 as newline delimited
JSON.

```ts
// metrics/schema.ts
import { log, str } from 'metrichouse/core'

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const
type Level = (typeof LEVELS)[number]

// Validate the environment variable here, so a typo is a startup failure with a
// clear message rather than a log that silently drops everything.
function configuredLevel(): Level {
  const value = process.env.LOG_LEVEL ?? 'info'
  if (!LEVELS.includes(value as Level)) {
    throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}, got ${value}`)
  }
  return value as Level
}

export const appLog = log('app_log', {
  fields: {
    service: str(),
    env: str().default(process.env.NODE_ENV ?? 'development'),
    requestId: str().optional(),
    userId: str().optional(),
    route: str().optional(),
  },

  levels: LEVELS,
  minLevel: configuredLevel(),

  // Durable staging, so a crash does not take the last thirty seconds of logs
  // with it. This is the one signal that matters most while a process is dying.
  stage: 'driver',
  flush: '10s',

  // Bound, so an outage does not produce one enormous upload.
  claimLimit: 5_000,

  write: async (rows) => {
    const ndjson = rows.map((row) => JSON.stringify(row)).join('\n')
    const day = new Date().toISOString().slice(0, 10)

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.LOG_BUCKET!,
        Key: `app_log/${day}/${crypto.randomUUID()}.ndjson`,
        Body: ndjson,
        ContentType: 'application/x-ndjson',
      }),
    )
  },
})
```

```ts
// middleware/logger.ts
import { randomUUID } from 'node:crypto'
import { appLog } from '../metrics/schema.js'

declare module 'express-serve-static-core' {
  interface Request {
    log: ReturnType<typeof appLog.child>
  }
}

export function requestLogger(req, res, next) {
  const requestId = req.header('x-request-id') ?? randomUUID()

  // One child per request. Every line it writes carries this context.
  req.log = appLog.child({
    service: 'api',
    requestId,
    route: req.route?.path ?? req.path,
  })

  res.setHeader('x-request-id', requestId)

  res.on('finish', () => {
    if (res.statusCode >= 500) {
      req.log.error('request failed', { userId: req.auth?.userId })
    } else if (res.statusCode >= 400) {
      req.log.warn('request rejected', { userId: req.auth?.userId })
    } else {
      req.log.info('request completed', { userId: req.auth?.userId })
    }
  })

  next()
}
```

```ts
// Anywhere downstream.
app.post('/orders', async (req, res) => {
  req.log.info('creating order')

  try {
    const order = await createOrder(req.body)
    req.log.info('order created', { userId: order.userId })
    res.json(order)
  } catch (error) {
    req.log.error(error as Error)     // message and stack both land as columns
    res.status(500).json({ error: 'could not create order' })
  }
})
```

### Also writing to the console

MetricHouse does not print anything. In development you usually want both.

```ts
function withConsole(name: string) {
  return async (rows: Record<string, unknown>[]) => {
    if (process.env.NODE_ENV !== 'production') {
      for (const row of rows) {
        console.log(`[${row.level}] ${row.message}`, row)
      }
    }
    await toS3(name)(rows)
  }
}
```

Or print at the call site for immediate feedback, and let MetricHouse handle
storage.

```sql
-- Error rate by service, per hour.
SELECT
  toStartOfHour(ts) AS hour,
  service,
  countIf(level IN ('error', 'fatal')) AS errors,
  count()                              AS lines
FROM app_log
WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY hour, service
ORDER BY errors DESC;

-- Every line for one request.
SELECT ts, level, message, error_stack
FROM app_log
WHERE requestId = 'req_9f21'
ORDER BY ts;
```
