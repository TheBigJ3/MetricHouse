# log

A log is an [event](/primitives/event) with three reserved columns: `ts`,
`level` and `message`. Underneath it stages, batches, claims and flushes
exactly as an event does, and on top it adds a severity level, a filter that
drops the noisy half before it costs anything, an `Error` overload that puts
the stack somewhere queryable, and a child logger that carries context.

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

| | |
| --- | --- |
| Import | `import { log } from 'metrichouse/core'` |
| Answers | What did the application say, and how serious was it |
| Storage | Staged whole, never merged |
| Row | `{ id, ts, level, message, error_stack?, ...fields, _ingested_at }` |
| Write with | [the level methods](#log-level), [`at()`](#log-at), [`child()`](#log-child) |
| Read with | [`pending()`](#log-pending), [`peek()`](#log-peek), [`snapshot()`](#log-snapshot) |
| Use it for | Application messages, request lines, audit trails |

Logs matter most in the minute a process is dying, which is why they share the
event pipeline rather than arriving with a second transport, a second cadence
and second crash behaviour to reason about.

## log()

```ts
log<F, L>(name: string, config: LogConfig<F, L>): Log<F, L>
```

Declares a log. It is inert until a [house](/guide/the-house) binds it, and
writing to an unbound log throws.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | [The metric name](#name) |
| `config.fields` | shape | no | [Extra columns beyond the reserved ones](#fields) |
| `config.levels` | array of strings | no | [The closed set of levels](#levels) |
| `config.minLevel` | one of `levels` | no | [The lowest level kept](#minlevel) |
| `config.stage` | `'driver'` or `'local'` | no | [Where lines wait](#stage) |
| `config.batch` | object | no | [Local staging size and age limits](#batch) |
| `config.flush` | duration | no | [The fastest this may ship](#flush) |
| `config.claimLimit` | number | no | [Lines one flush may carry](#claimlimit) |
| `config.write` | function | yes | [Where the rows go](#write) |

### name

```ts
log('app_log', { ... })
```

A non empty string, unique inside a house.

### fields

```ts
fields?: Record<string, FieldType>      // default: none
```

Extra columns, alongside the reserved three. Every
[field type](/reference/field-types) is legal, including `json()`.

```ts
fields: {
  service: str(),
  env: str().default('production'),
  requestId: str().optional(),
}
```

A field may not be named `id`, `ts`, `level`, `message`, `error_stack`,
`_ingested_at` or `_sample_rate`, and the check runs at declaration.
[fields](/reference/fields) covers the argument in full.

### levels

```ts
levels?: readonly string[]      // default: ['debug', 'info', 'warn', 'error']
```

The closed set of levels, in ascending severity. The order is what
[`minLevel`](#minlevel) compares on, so it is a declaration rather than a
formality.

Each level becomes a method, and the type narrows to exactly what you list.

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

```ts
import { DEFAULT_LOG_LEVELS } from 'metrichouse/core'
// ['debug', 'info', 'warn', 'error']
```

Three things throw at declaration: an empty set, a level declared twice, and a
level that would shadow a method on the logger. `levels: ['debug', 'drain']` is
the third one, and catching it here is better than having `logger.drain()`
quietly write a log line.

### minLevel

```ts
minLevel?: L[number]      // default: the lowest declared level
```

Drops anything below this level before it reaches the driver.

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

Dropped means dropped. No record is created, no field is validated and nothing
is queued, so a filtered call costs one comparison.

A `minLevel` that is not one of the declared levels throws at declaration.

### stage

```ts
stage?: 'driver' | 'local'      // default: 'driver'
```

Where lines wait between the call and your `write` function. Identical to
[the event's](/primitives/event#stage).

Prefer `'driver'` on a durable driver. A crash is the moment the last thirty
seconds of logs are worth the most, and local staging is the one setting that
would lose them.

### batch

```ts
batch?: { maxSize?: number; maxAge?: DurationInput }
// defaults: { maxSize: 500, maxAge: '10s' }
```

Local staging only, and ignored when `stage: 'driver'`. Identical to
[the event's](/primitives/event#batch).

### flush

```ts
flush?: DurationInput      // default: the house default, then '30s'
```

The fastest this log may ship. A log has no resolution for a cadence to divide,
so any duration is legal.

### claimLimit

```ts
claimLimit?: number      // default: unlimited
```

How many lines one flush may carry. Identical to
[the event's](/primitives/event#claimlimit), and worth setting on a log that
uploads a file per flush.

### write

```ts
write: (rows: LogRow<F, L>[], context: WriteContext) => Promise<void> | void
```

Where the rows go. Required.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `rows` | `LogRow<F, L>[]` | The reserved columns, your declared fields, and `level` typed to the levels you declared |
| `context` | `WriteContext` | Which metric, the span of line timestamps, how many, and which attempt |

MetricHouse prints nothing of its own. A `write` function that also calls
`console.log` is how you get both, and
[Also writing to the console](#also-writing-to-the-console) shows one.

## Level methods {#log-level}

```ts
info(message: string | Error, fields?: InferShape<F>): void
```

One method per declared level. With the default levels that is `debug()`,
`info()`, `warn()` and `error()`.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `message` | `string` or `Error` | yes | The line. An `Error` also fills `error_stack` |
| `fields` | the declared shape | when any field is required | [The values for this line](/reference/fields#on-a-log) |

```ts
appLog.debug('cache miss', { service: 'api' })
appLog.info('order placed', { service: 'api' })
appLog.warn('retrying upstream', { service: 'api' })
appLog.error('upstream unavailable', { service: 'api' })
```

The fields argument may be left out once nothing in the shape is still
required, which is what makes `log.info('started')` legal on a log whose fields
are all optional or bound by a [`child()`](#log-child).

**Returns** nothing. A line below [`minLevel`](#minlevel) returns immediately
and stages nothing.

**Throws** on an unbound log, or on a field that is unknown, missing or ill
typed. The message itself never throws, which is the next section.

### An Error as the message

Any level accepts an `Error` in place of a string. The message goes in
`message` and the stack goes in the reserved `error_stack` column.

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

An error that arrives without a stack, which happens with a rethrown or cross
realm error, still gets a header line, because that is worth more than an empty
column.

::: tip A logger never takes down a request
Every other call in MetricHouse throws on a bad value. A log message does not.
Something that is neither a string nor an `Error` is turned into a string. This
call is made from inside `catch` blocks, and a logger that throws there
replaces the error you were handling.
:::

## log.at()

```ts
at(level: L[number], message: string | Error, fields?: InferShape<F>): void
```

Writes at a level chosen while the program runs: one parsed from an upstream
payload, or carried in a variable.

```ts
appLog.at(level, 'message from upstream', { service: 'gateway' })
```

**Throws** when `level` is not one of the declared levels. A log line with a
level nothing queries is worse than a loud failure at the one call site that
could have a typo.

## log.child()

```ts
child(fields: Partial<InferShape<F>>): ChildLog
```

Returns a logger that merges `fields` into every call it makes. It is how a
request id reaches every line without being threaded through every function.

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

A bound field becomes omittable rather than absent in the child's type, so
`child({ service })` satisfies a required field and a call site may still
override it.

```ts
requestLog.info('retrying', { requestId: 'req_9f22' })   // the call site wins
```

A child carries the same level methods, `at()` and `child()`, plus `bound`,
which is a frozen copy of the fields it adds.

| Member | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | The log this child writes into |
| `bound` | `Readonly<Record<string, unknown>>` | The fields merged into every call |

A child is not a metric. It stages into the log that made it and shares its
batch settings, its cadence and its `write` function.

## log.pending()

```ts
pending(): Promise<number>
```

How many lines are staged and not yet shipped.

```ts
await appLog.pending()     // 128
```

## log.peek()

```ts
peek(n?: number): Promise<Row[]>
```

The first `n` staged lines as rows, without consuming them. Identical to
[the event's](/primitives/event#event-peek).

```ts
await appLog.peek(20)
```

## log.snapshot()

```ts
snapshot(options?: SnapshotOptions): Promise<LogLiveRow<F, L>[]>
```

Unshipped lines as typed rows, with `level` narrowed to the levels you
declared.

```ts
await appLog.snapshot({ limit: 100 })
await appLog.snapshot({ from: Date.now() - 60_000, orderBy: 'ts', direction: 'asc' })
```

Never partial, for the reason [an event gives](/primitives/event#event-snapshot).
Options are in [Snapshot options](/reference/snapshot-options).

## log.flush()

```ts
flush(options?: FlushOptions): Promise<MetricFlushReport>
```

Claims the staged lines, up to [`claimLimit`](#claimlimit), and ships them.
[Flush options](/reference/flush-options) covers the argument and the report.

## log.drain()

```ts
drain(): Promise<void>
```

Resolves once every line written so far has reached the driver. On a locally
staged log it also ships what is buffered.

## log.rowShape()

```ts
rowShape(): RowShape
```

```ts
appLog.rowShape().columns.map((c) => c.name)
// ['id', 'ts', 'level', 'message', 'error_stack', 'service', 'requestId',
//  '_ingested_at']
```

## Properties

| Property | Type | Value |
| --- | --- | --- |
| `name` | `string` | The name it was declared with |
| `kind` | `'log'` | |
| `storage` | `'staged'` | It keeps each line whole |
| `fields` | `Shape` | The fields you declared. The reserved three are not among them |
| `levels` | `readonly string[]` | The declared levels, lowest severity first |
| `minLevel` | `string` | The lowest level kept |
| `stage` | `'driver'` or `'local'` | Where lines wait |
| `flushMs` | `number` | `flush`, parsed, including one taken from the house |
| `isBound` | `boolean` | `true` once a house has registered it |
| `write` | `WriteFn` | The function it was declared with |

## The row

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

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | A UUID version 7, minted when the line was written |
| `ts` | `Date` | When the line was written |
| `level` | one of `levels` | The severity |
| `message` | `string` | The line |
| `error_stack` | `string` | Present only on a line written with an `Error` |
| one per field | as declared | Your values |
| `_ingested_at` | `Date` | When the call ran |

Column order is `id, ts, level, message, error_stack`, then your fields, then
`_ingested_at`. A log never samples, so there is no `_sample_rate`.

Inside `write`, each row is a `LogRow<F, L>`, with `level` typed to the levels
you declared. See [Rows are typed](/guide/writing-a-sink#rows-are-typed).

### Table schema

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

### Reserved names

```ts
import { RESERVED_LOG_COLUMNS } from 'metrichouse/core'
// ['id', 'ts', 'level', 'message', 'error_stack', '_ingested_at', '_sample_rate']
```

A declared field may not take one of those names. A level may not shadow a
method on the logger. Both are checked at declaration.

### Queries

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

## Patterns

### A request scoped logger

```ts
// metrics/schema.ts
import { log, str } from 'metrichouse/core'

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const
type Level = (typeof LEVELS)[number]

// Validate the environment variable here, so a typo is a startup failure with
// a clear message rather than a log that silently drops everything.
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

MetricHouse prints nothing. In development you usually want both.

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

Printing at the call site is the other option, and it gives immediate feedback
while MetricHouse handles storage.

## Playground

### The filter

`minLevel` is the setting with the largest effect on what a log costs. Drag it
and watch both the volume and the bill.

<MhLogFilter />

Moving `minLevel` from `debug` to `info` in a busy service usually removes most
of the volume, and each dropped line costs one array index.

### Staging and batching

Underneath, a log stages and batches exactly like an event, so the same
controls apply.

<MhEventFlow metric="app_log" kind="log" />
