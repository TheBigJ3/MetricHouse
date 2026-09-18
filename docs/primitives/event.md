# event

An event is a record kept whole. It is the home for everything a counter has to
throw away: user ids, request ids, free text, JSON payloads. Two identical events
are two rows, because the point of an event is the detail, and detail does not
survive being added together.

```ts
import { event, int, json, oneOf, str } from 'metrichouse/core'

export const checkoutAttempted = event('checkout_attempted', {
  fields: {
    userId: str(),
    plan: oneOf(['starter', 'pro', 'enterprise']),
    outcome: oneOf(['paid', 'failed']),
    amountCents: int(),
    failureReason: str().optional(),
    processor: json<{ name: string; latencyMs: number }>().optional(),
  },
  flush: '30s',
  write: async (rows) => clickhouse.insert({ table: 'checkout_attempted', values: rows }),
})
```

```ts
checkoutAttempted.record({
  userId: 'u_4821',
  plan: 'pro',
  outcome: 'paid',
  amountCents: 4_999,
  processor: { name: 'stripe', latencyMs: 210 },
})
```

## Use it for

Anything with per item detail. Purchases, signups, feature use, audit records,
page views, API calls with a request id, webhook deliveries.

## Fields, not dimensions

An event declares `fields` rather than `dims`, and the difference matters:

- Fields are not used to build a label key, so high cardinality is fine. A `userId`
  field is normal. A `userId` dimension is a mistake.
- `json()` is allowed on a field and rejected on a dimension.
- Nothing is merged, so every field reaches your table exactly as written.

## Writing

```ts
checkoutAttempted.record({ userId: 'u_1', plan: 'pro', outcome: 'paid', amountCents: 4999 })

// Several in one round trip.
checkoutAttempted.recordMany([
  { userId: 'u_1', plan: 'pro', outcome: 'paid', amountCents: 4999 },
  { userId: 'u_2', plan: 'starter', outcome: 'failed', amountCents: 900 },
])
```

`record()` returns immediately. Use `drain()` when you need to know it landed.

### Choosing the timestamp

Every record gets a `ts`. By default it is stamped when you call `record()`.

```ts
// Take it from a declared ts() field instead.
export const deviceReading = event('device_reading', {
  fields: {
    occurredAt: ts(),
    deviceId: str(),
    celsius: float(),
  },
  timestamp: 'occurredAt',     // must name a ts() field
  flush: '1m',
  write,
})

// Now a backlog uploaded hours later still lands on the right timestamps.
deviceReading.record({
  occurredAt: new Date('2026-09-17T09:14:02Z'),
  deviceId: 'dev_88',
  celsius: 4.2,
})
```

Override either one at the call site:

```ts
checkoutAttempted.record(fields, { at: new Date('2026-09-17T09:14:02Z') })
```

There is also a `_ingested_at` column on every row, stamped when `record()` ran.
Comparing it with `ts` is how you tell a backfilled row from a live one.

## Where records wait

```ts
stage: 'driver'    // the default
stage: 'local'
```

**`'driver'`** appends each record to the bound driver and claims it on flush. It
is as durable and as shared as that driver is. On Redis, that means a record
survives a crash. Use it for anything that matters.

**`'local'`** buffers records in an array inside your process and ships them when
one of four things happens: the buffer reaches `batch.maxSize`, `batch.maxAge`
passes, you call `flush()`, or you call `drain()`.

```ts
export const pageViewed = event('page_viewed', {
  fields: { path: str(), userId: str().optional() },
  stage: 'local',
  batch: { maxSize: 500, maxAge: '10s' },
  write: toClickHouse('page_viewed'),
})
```

Local staging costs nothing per event and loses everything on a crash. Use it for
page views, not for money.

| | `'driver'` | `'local'` |
| --- | --- | --- |
| Cost per record | One driver write | Pushing onto an array |
| Survives a crash | Yes, with a durable driver | No |
| Shared across processes | Yes, with a shared driver | No |
| Ships on | `flush()` | Size, age, `flush()` or `drain()` |

## Sampling

Keep a fraction of events. The counters you derive stay exact either way, because
derive runs before sampling.

```ts
export const pageViewed = event('page_viewed', {
  fields: { path: str(), statusCode: int() },

  // A flat rate.
  sample: 0.05,

  flush: '30s',
  write,
})
```

A function is evaluated per event, so you can keep everything interesting and
sample the rest:

```ts
export const apiCall = event('api_call', {
  fields: { route: str(), statusCode: int(), durationMs: float() },

  sample: (fields) => {
    if (fields.statusCode >= 500) return 1        // keep every error
    if (fields.durationMs > 1000) return 1        // keep every slow call
    if (fields.route === '/health') return 0      // drop health checks entirely
    return 0.05                                   // keep 5% of the rest
  },

  flush: '30s',
  write,
})
```

The rate that applied lands in a `_sample_rate` column, so a query can scale the
numbers back up:

```sql
SELECT route, sum(1 / _sample_rate) AS estimated_calls
FROM api_call
GROUP BY route;
```

## Tune it

Events are not folded, so the settings that matter are different ones: where
records wait, what moves them, and how many you keep.

<MhEventFlow metric="checkout_attempted" kind="event" />

Two things to try:

- **Set `stage` to `'local'` and drop the rate.** The batch stops filling before
  `maxAge` fires, so age becomes the trigger rather than size.
- **Pull `sample` down to 5 percent.** The stored rows fall by twenty times. The
  counters you derive from this event do not move at all, because derive runs
  before sampling.

## Deriving counters

An event can increment counters as a side effect of being recorded, which removes
the hand written second write path that people forget to keep in step.

```ts
export const checkouts = counter('checkouts', {
  dims: { plan: oneOf(['starter', 'pro', 'enterprise']), outcome: oneOf(['paid', 'failed']) },
  resolution: '1m',
  flush: '1m',
  write: toClickHouse('checkouts'),
})

export const revenue = counter('revenue_cents', {
  dims: { plan: oneOf(['starter', 'pro', 'enterprise']) },
  resolution: '1m',
  flush: '1m',
  write: toClickHouse('revenue_cents'),
})

export const checkoutAttempted = event('checkout_attempted', {
  fields: {
    userId: str(),
    plan: oneOf(['starter', 'pro', 'enterprise']),
    outcome: oneOf(['paid', 'failed']),
    amountCents: int(),
  },

  derive: {
    checkouts: (fields) => ({
      dims: { plan: fields.plan, outcome: fields.outcome },
    }),
    revenue_cents: (fields) =>
      fields.outcome === 'paid'
        ? { dims: { plan: fields.plan }, value: fields.amountCents }
        : [],           // an empty array records nothing
  },

  sample: 0.05,
  flush: '30s',
  write: toClickHouse('checkout_attempted'),
})
```

Rules worth knowing:

- Targets are named by metric name and resolved lazily, so schema files can be
  declared in any order.
- Only counters can be derive targets.
- **Derive runs before sampling, always.** The counters stay exact and unbiased
  while the event table holds a representative slice. That ordering is the whole
  value of the feature and cannot be changed.
- Returning an array records several increments from one event.
- A broken derive is reported through `onError` and the event is still recorded.
  A mistake in a derived counter must not lose the underlying fact.

## Reading

```ts
await checkoutAttempted.pending()     // 128 records staged, not yet shipped
await checkoutAttempted.peek(10)      // the first 10 as rows, without consuming
await checkoutAttempted.snapshot({ limit: 50 })
```

Every snapshot row reads `bucket_open: false`. A record is complete the instant
it is written, so there is no partial window to exclude.

## The rows you receive

```ts
{
  id: '019278b4-3c21-7a4e-9f10-8c2d5b6e1a03',   // UUID version 7
  ts: Date,                                      // when it happened
  userId: 'u_4821',
  plan: 'pro',
  outcome: 'paid',
  amountCents: 4999,
  processor: '{"name":"stripe","latencyMs":210}',  // json arrives as a string
  _ingested_at: Date,                            // when record() ran
  _sample_rate: 0.05,                            // only if the metric samples
}
```

The id is a UUID version 7, so it sorts by time. It is minted when you call
`record()` rather than at flush time, which is what makes a retried batch resend
the same rows instead of new ones.

Inside `write`, each row is an `EventRow`, with every field typed as you declared
it. `processor` is the one to watch: its type is the object you recorded, and it
arrives as a string. See [Rows are typed](../guide/writing-a-sink.md#rows-are-typed).

::: code-group

```sql [ClickHouse]
CREATE TABLE checkout_attempted (
  id             String,
  ts             DateTime64(3),
  userId         String,
  plan           LowCardinality(String),
  outcome        LowCardinality(String),
  amountCents    Int64,
  failureReason  Nullable(String),
  processor      Nullable(String),
  _ingested_at   DateTime64(3),
  _sample_rate   Float64
)
ENGINE = ReplacingMergeTree
ORDER BY (ts, id);
```

```sql [Postgres]
CREATE TABLE checkout_attempted (
  id             TEXT PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL,
  "userId"       TEXT NOT NULL,
  plan           TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  "amountCents"  BIGINT NOT NULL,
  "failureReason" TEXT,
  processor      JSONB,
  _ingested_at   TIMESTAMPTZ NOT NULL,
  _sample_rate   DOUBLE PRECISION
);
CREATE INDEX ON checkout_attempted (ts);
```

:::

## Reserved column names

A field may not be named `id`, `ts`, `_ingested_at` or `_sample_rate`.
MetricHouse owns those on every event row, and the check runs at declaration time.

```ts
import { RESERVED_EVENT_COLUMNS } from 'metrichouse/core'
// ['id', 'ts', '_ingested_at', '_sample_rate']
```

## Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `fields` | shape | required | The record schema. `json()` is allowed |
| `stage` | `'driver'` or `'local'` | `'driver'` | Where records wait |
| `batch.maxSize` | number | `500` | Local staging: ship at this many |
| `batch.maxAge` | duration | `'10s'` | Local staging: ship this long after the first |
| `flush` | duration | `'30s'` | The fastest this may ship |
| `timestamp` | `'auto'` or a field name | `'auto'` | Where `ts` comes from |
| `sample` | number or function | keep everything | The fraction to keep |
| `derive` | record of functions | none | Counters this event also increments |
| `claimLimit` | number | unlimited | Records one flush may carry |
| `write` | function | required | Where the rows go |

::: tip Set claimLimit if your backlog can get large
By default a claim takes the whole backlog. After a long outage that can be more
rows than your database will accept in one statement. `claimLimit: 10_000` bounds
it, and the rest ships on the following flush.
:::

## In production

Product analytics that feeds exact counters and a sampled detail table.

```ts
// metrics/schema.ts
import { counter, event, float, int, json, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const apiCalls = counter('api_calls', {
  dims: {
    route: str(),
    status: oneOf(['2xx', '4xx', '5xx']),
    tier: oneOf(['free', 'pro', 'enterprise']),
  },
  resolution: '10s',
  flush: '1m',
  write: toClickHouse('api_calls'),
})

export const apiCallDetail = event('api_call_detail', {
  fields: {
    // High cardinality, which is exactly what an event is for.
    requestId: str(),
    accountId: str(),
    route: str(),
    statusCode: int(),
    durationMs: float(),
    tier: oneOf(['free', 'pro', 'enterprise']),
    userAgent: str().optional(),
    errorMessage: str().optional(),
    requestMeta: json<Record<string, unknown>>().optional(),
  },

  // Durable staging: this table is what an incident review reads.
  stage: 'driver',
  flush: '30s',

  // A long outage should not produce a single enormous insert.
  claimLimit: 10_000,

  // Keep every failure and every slow call. Sample the healthy majority.
  sample: (fields) => {
    if (fields.statusCode >= 500) return 1
    if (fields.durationMs > 2_000) return 1
    if (fields.route === '/health') return 0
    return fields.tier === 'enterprise' ? 0.5 : 0.02
  },

  // The counter stays exact whatever the sampling does, because derive runs
  // first.
  derive: {
    api_calls: (fields) => ({
      dims: {
        route: fields.route,
        status: `${Math.floor(fields.statusCode / 100)}xx` as '2xx' | '4xx' | '5xx',
        tier: fields.tier,
      },
    }),
  },

  write: toClickHouse('api_call_detail'),
})
```

```ts
// middleware/track.ts
import { randomUUID } from 'node:crypto'
import { apiCallDetail } from '../metrics/schema.js'

export function trackApiCall(req, res, next) {
  const requestId = req.header('x-request-id') ?? randomUUID()
  const startedAt = performance.now()

  res.on('finish', () => {
    apiCallDetail.record({
      requestId,
      accountId: req.auth?.accountId ?? 'anonymous',
      route: req.route?.path ?? 'unmatched',
      statusCode: res.statusCode,
      durationMs: performance.now() - startedAt,
      tier: req.auth?.tier ?? 'free',
      userAgent: req.header('user-agent'),
      errorMessage: res.locals.error?.message,
    })
  })

  next()
}
```

```sql
-- Exact call volume, from the counter.
SELECT route, sum(value) AS calls
FROM api_calls
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY route;

-- Slowest accounts, from the sampled detail, scaled back up.
SELECT
  accountId,
  quantile(0.95)(durationMs) AS p95_ms,
  sum(1 / _sample_rate)      AS estimated_calls
FROM api_call_detail
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY accountId
ORDER BY p95_ms DESC
LIMIT 20;
```

The counter answers "how many", exactly and cheaply. The event answers "which
ones and why", on a slice of the traffic. Neither has to be kept in step by hand.
