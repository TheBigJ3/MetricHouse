# event

An event keeps each record whole. It is the home for everything a counter has
to throw away: user ids, request ids, free text, JSON payloads. Two identical
events are two rows.

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

| | |
| --- | --- |
| Import | `import { event } from 'metrichouse/core'` |
| Answers | What exactly happened, with all the detail |
| Storage | Staged whole, never merged |
| Row | `{ id, ts, ...fields, _ingested_at, _sample_rate? }` |
| Write with | [`record()`](#event-record), [`recordMany()`](#event-recordmany) |
| Read with | [`pending()`](#event-pending), [`peek()`](#event-peek), [`snapshot()`](#event-snapshot) |
| Use it for | Purchases, signups, feature use, audit records, page views, API calls |

An event declares [`fields`](/reference/fields) where a folded metric declares
[`dims`](/reference/dims). Fields are never used to build a series key, so
values that are unique per record are ordinary here.

## event()

```ts
event<F>(name: string, config: EventConfig<F>): Event<F>
```

Declares an event. It is inert until a [house](/guide/the-house) binds it, and
recording to an unbound event throws.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | [The metric name](#name) |
| `config.fields` | shape | yes | [The record schema](#fields) |
| `config.stage` | `'driver'` or `'local'` | no | [Where records wait](#stage) |
| `config.batch` | object | no | [Local staging size and age limits](#batch) |
| `config.flush` | duration | no | [The fastest this may ship](#flush) |
| `config.timestamp` | `'auto'` or a field name | no | [Where `ts` comes from](#timestamp) |
| `config.sample` | number or function | no | [The fraction to keep](#sample) |
| `config.derive` | record of functions | no | [Counters this event also increments](#derive) |
| `config.claimLimit` | number | no | [Records one flush may carry](#claimlimit) |
| `config.write` | function | yes | [Where the rows go](#write) |

### name

```ts
event('checkout_attempted', { ... })
```

A non empty string, unique inside a house. It is also the name a
[`derive`](#derive) target or a timer's [`record`](/primitives/timer#record)
setting uses to find this event.

### fields

```ts
fields: Record<string, FieldType>      // required
```

The record schema. Every one of the seven
[field types](/reference/field-types) is legal here, including `json()`.

```ts
fields: {
  userId: str(),
  plan: oneOf(['starter', 'pro', 'enterprise']),
  amountCents: int(),
  failureReason: str().optional(),
  processor: json<{ name: string; latencyMs: number }>().optional(),
}
```

A field may not take one of the reserved column names, and the check runs at
declaration. [fields](/reference/fields) covers the argument in full.

### stage

```ts
stage?: 'driver' | 'local'      // default: 'driver'
```

Where records wait between `record()` and your `write` function.

| | `'driver'` | `'local'` |
| --- | --- | --- |
| Where a record sits | The bound driver | An array in this process |
| Cost per record | One driver write | Pushing onto an array |
| Survives a crash | Yes, with a durable driver | No |
| Shared across processes | Yes, with a shared driver | No |
| Ships on | `flush()` | [`batch.maxSize`](#batch), [`batch.maxAge`](#batch), `flush()` or `drain()` |

```ts
export const pageViewed = event('page_viewed', {
  fields: { path: str(), userId: str().optional() },
  stage: 'local',
  batch: { maxSize: 500, maxAge: '10s' },
  write: toClickHouse('page_viewed'),
})
```

Local staging costs nothing per event and loses everything on a crash. Use it
for page views, and use `'driver'` for money.

### batch

```ts
batch?: { maxSize?: number; maxAge?: DurationInput }
// defaults: { maxSize: 500, maxAge: '10s' }
```

Local staging only, and ignored entirely when `stage: 'driver'`.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxSize` | `number` | `500` | Ship once this many records are buffered |
| `maxAge` | duration | `'10s'` | Ship this long after the first record in a batch |

The age clock starts at the first record of a batch, so `maxAge` bounds how
long the oldest record waits rather than the newest. A `maxSize` that is not a
positive whole number throws at declaration.

When a send fails, its records go back into the buffer ahead of anything newer,
and the age clock starts again. They are retried `maxAge` later, whether or not
another record arrives, so a sink that recovers is caught up without anyone
calling `flush()`. Two batches that fail one after the other go back in the
order they were recorded.

### flush

```ts
flush?: DurationInput      // default: the house default, then '30s'
```

The fastest this event may ship when something calls `flush()`. An event has no
resolution for a cadence to divide, so any duration is legal and a default is
always available.

This is separate from [`batch`](#batch), which ships a locally staged buffer
without anyone calling `flush()`.

### timestamp

```ts
timestamp?: 'auto' | TsFieldOf<F>      // default: 'auto'
```

Where each record's `ts` column comes from.

| Value | Meaning |
| --- | --- |
| `'auto'` | Stamped from the house clock when `record()` runs |
| a field name | Taken from that field, which has to be declared `ts()` |

```ts
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

// A backlog uploaded hours later still lands on the right timestamps.
deviceReading.record({
  occurredAt: new Date('2026-09-17T09:14:02Z'),
  deviceId: 'dev_88',
  celsius: 4.2,
})
```

`TsFieldOf<F>` is the names of the fields declared `ts()`, so naming any other
field is a type error. Naming a field that is not declared, or one that is not
`ts()`, also throws at declaration, for code that gets past the types. An optional `ts()` field that a call site leaves out falls back to
the clock rather than stamping the epoch.

Whatever this says, [`record(fields, { at })`](#event-record) overrides it for
one call.

### sample

```ts
sample?: number | ((fields: InferShape<F>) => number)      // default: keep everything
```

The fraction of records to keep, from `0` to `1`. A rate outside that range
throws, at declaration for a number and at `record()` for a function.

```ts
sample: 0.05      // keep one in twenty
```

A function is evaluated per record, so the interesting traffic stays whole
while the rest is thinned.

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

The rate that applied lands in a `_sample_rate` column, so a query can scale
the numbers back up.

```sql
SELECT route, sum(1 / _sample_rate) AS estimated_calls
FROM api_call
GROUP BY route;
```

The function sees the complete record, with defaults already filled in, and it
runs after [`derive`](#derive). Counters fed by this event therefore stay exact
whatever fraction of the event table you keep.

### derive

```ts
derive?: Record<string, (fields: InferShape<F>) => DeriveTarget | DeriveTarget[]>
```

Counters this event also increments, keyed by metric name. It replaces the hand
written second write path that people forget to keep in step.

```ts
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

Each function returns one target, several targets, or none.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | an object | `{}` | The labels for the increment, checked against the target counter's declared dims |
| `value` | `number` | `1` | How much to add. A whole number unless the counter is declared `value: float()` |

The types cannot tie `dims` to the counter's shape, because a target is named by
a string. Every target is checked when it runs instead, and a wrong one is
reported to `onError` with the event and the target in the message.

| Rule | Detail |
| --- | --- |
| Targets are named, not passed | Resolved at the first `record()`, so schema files may be declared in any order |
| Only a counter can be a target | Anything else throws when the first record resolves it |
| Derive counts every record | Sampled out or kept, every record that passes validation is derived. This is not configurable, and it is the whole value of the feature |
| Derive runs after validation | A call that throws increments nothing. In `recordMany`, one bad record means nothing is derived for any of them |
| An array records several increments | One fact can feed two counters, or one counter twice |
| A function's targets apply together | Every target a function returns is checked first. If one is wrong, none of that function's increments are applied |
| A broken derive goes to `onError` | The event is still recorded. A mistake in a derived counter must not lose the underlying fact |
| The increment lands in the open window | The counter's window is the one `now` falls in, even for a record with an older `ts`. A counter cannot be written in the past |

### claimLimit

```ts
claimLimit?: number      // default: unlimited
```

How many records one flush may carry. By default a claim takes the whole
backlog, the same way a counter's claim takes every closed window.

```ts
claimLimit: 10_000
```

Set it when the backlog can outgrow what your database will accept in one
statement. After a long outage an unbounded claim is one enormous insert, and
the rest of the backlog ships on the following flush either way.

The places that have to empty the backlog still do, in batches of this size:
[`drain()`](#event-drain) and `batch.maxAge` ship every locally staged record,
and a [final flush](/reference/flush-options#final), which `house.stop()` makes,
keeps claiming until nothing is left. A full buffer on `batch.maxSize` ships
batches while it is still full and leaves the rest to the age clock.

A limit that is not a positive whole number throws at declaration.

### write

```ts
write: (rows: EventRow<F>[], context: WriteContext) => Promise<void> | void
```

Where the rows go. Required.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `rows` | `EventRow<F>[]` | Every declared field typed as declared, plus the reserved columns |
| `context` | `WriteContext` | Which metric, the span of record timestamps, how many, and which attempt |

`context.buckets` is `0` here, because an event has no windows.
`context.total` is the number of rows.
[Writing a sink](/guide/writing-a-sink) covers the whole contract.

## event.record()

```ts
record(fields: InferShape<F>, options?: { at?: Date | number }): void
```

Stages one record.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `fields` | the declared shape | yes | [The values for this record](/reference/fields#the-fields-argument) |
| `options.at` | `Date` or epoch milliseconds | no | The `ts` for this record, overriding [`timestamp`](#timestamp). It has to be a time a `Date` can hold, within about 275,000 years of 1970 |

```ts
checkoutAttempted.record({ userId: 'u_1', plan: 'pro', outcome: 'paid', amountCents: 4_999 })

checkoutAttempted.record(fields, { at: new Date('2026-09-17T09:14:02Z') })
```

**Returns** nothing, and returns before storage has acknowledged anything. Use
[`drain()`](#event-drain) when you need to know it landed.

**Throws immediately** on an unbound event, an unknown or ill typed field, a
missing required field, a `json()` value JSON cannot hold, an `at` that is
neither a `Date` nor finite epoch milliseconds, or a `sample` function returning
something outside `[0, 1]`. A call that throws changes nothing: no record is
staged and no derived counter moves.

What happens inside one call, in order: defaults are filled in, fields are
checked, `ts` is chosen, [`sample`](#sample) decides, and the stored copy is
made. Only once all of that has passed does [`derive`](#derive) run and the
record get staged with its `id` and `_ingested_at`. `derive` still runs for a
record that sampling dropped.

The stored copy is taken at the call. A `json()` value is turned into its JSON
text there and a `Date` is copied, so changing the object you passed afterwards
does not change what ships.

## event.recordMany()

```ts
recordMany(fields: readonly InferShape<F>[], options?: { at?: Date | number }): void
```

Stages several records in one round trip to the driver.

```ts
checkoutAttempted.recordMany([
  { userId: 'u_1', plan: 'pro', outcome: 'paid', amountCents: 4_999 },
  { userId: 'u_2', plan: 'starter', outcome: 'failed', amountCents: 900 },
])
```

Every record is checked before any of them is derived or staged. If one of them
is wrong the call throws and nothing happens, the same as a single `record()`.
Each record is sampled on its own, so a call that succeeds can still stage some
records and drop others. `at` applies to all of them.

## event.pending()

```ts
pending(): Promise<number>
```

How many records have not shipped yet: those waiting for a flush, plus those a
flush has claimed and is still writing. A sink that hangs therefore shows up as
a backlog rather than as zero.

```ts
await checkoutAttempted.pending()     // 128
```

This is the number to watch on a health endpoint. A backlog that climbs between
flushes means the sink is slower than the traffic.
[What to watch](/guide/reliability#backlog) covers the alarm worth setting.

## event.peek()

```ts
peek(n?: number): Promise<EventRow<F>[]>
```

The first `n` records waiting for a flush, as rows, without consuming them.
Records a flush has claimed and is still writing are not among them.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `n` | `number` | every staged record | How many to return |

```ts
await checkoutAttempted.peek(10)
```

Records come back in the order they were staged, as the rows your `write`
function would receive. Nothing is claimed, so the next flush still ships them.
`peek(0)` returns nothing, and a negative or fractional `n` throws.

## event.snapshot()

```ts
snapshot(options?: SnapshotOptions): Promise<EventLiveRow<F>[]>
```

Unshipped records as live rows: `peek()` with the rest of the snapshot
vocabulary.

```ts
await checkoutAttempted.snapshot({ limit: 50 })
await checkoutAttempted.snapshot({ from: Date.now() - 60_000, orderBy: 'ts', direction: 'asc' })
```

Every row reads `bucket_open: false` and `bucket_elapsed_ms: 0`. A record is
complete the instant it is staged, so there is no partial window to exclude.

`orderBy` sorts every waiting record before `limit` takes the first ones, so
`{ orderBy: 'amountCents', limit: 10 }` is the ten largest. Without `orderBy`,
`limit` takes the first records in the order they were staged. An `orderBy`
naming a column the rows do not have throws, as it does for every other type.

The options that only mean something to a window, which are `dims`, `complete`,
`rollup` and `groupBy`, are ignored rather than rejected, so one options object
works across a mixed schema. See
[Snapshot options](/reference/snapshot-options#where-they-are-accepted).

## event.flush()

```ts
flush(options?: FlushOptions): Promise<MetricFlushReport>
```

Claims the staged backlog, up to [`claimLimit`](#claimlimit), and ships it.
[Flush options](/reference/flush-options) covers the argument and the report.

## event.drain()

```ts
drain(): Promise<void>
```

Resolves once every `record()` issued so far has reached the driver. On a
locally staged event it also ships whatever is buffered, because that buffer is
the only place those records exist.

## event.rowShape()

```ts
rowShape(): RowShape
```

```ts
checkoutAttempted.rowShape().columns.map((c) => c.name)
// ['id', 'ts', 'userId', 'plan', 'outcome', 'amountCents', 'failureReason',
//  'processor', '_ingested_at', '_sample_rate']
```

`_sample_rate` appears only on an event that declares [`sample`](#sample).

## Properties

| Property | Type | Value |
| --- | --- | --- |
| `name` | `string` | The name it was declared with |
| `kind` | `'event'` | |
| `storage` | `'staged'` | It keeps each record whole |
| `fields` | `Shape` | The declared fields |
| `stage` | `'driver'` or `'local'` | Where records wait |
| `flushMs` | `number` | `flush`, parsed, including one taken from the house |
| `isBound` | `boolean` | `true` once a house has registered it |
| `write` | `WriteFn` | The function it was declared with |

An event reports an empty `dims`, a `resolutionMs` of `1` and a `graceMs` of
`0`, because it has no windows. Those three exist so a house can hold every
metric type in one list.

## The row

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

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | A UUID version 7, so it sorts by time. Minted at `record()`, which is what makes a retried batch resend the same rows |
| `ts` | `Date` | When the record happened. See [`timestamp`](#timestamp) |
| one per field | as declared | Your values. A `json()` field arrives as a string |
| `_ingested_at` | `Date` | When `record()` ran. Comparing it with `ts` tells a backfilled row from a live one |
| `_sample_rate` | `number` | The rate that applied, present only when the event samples |

Inside `write`, each row is an `EventRow<F>`. See
[Rows are typed](/guide/writing-a-sink#rows-are-typed).

### Table schema

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

### Reserved column names

A field may not be named `id`, `ts`, `_ingested_at` or `_sample_rate`.

```ts
import { RESERVED_EVENT_COLUMNS } from 'metrichouse/core'
// ['id', 'ts', '_ingested_at', '_sample_rate']
```

## Patterns

### An exact counter beside a sampled detail table

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
ones and why", on a slice of the traffic. Neither has to be kept in step by
hand.

## Playground

Events are not folded, so the settings that matter are different ones: where
records wait, what moves them, and how many you keep.

<MhEventFlow metric="checkout_attempted" kind="event" />

Two things to try:

- **Set `stage` to `'local'` and drop the rate.** The batch stops filling before
  `maxAge` fires, so age becomes the trigger rather than size.
- **Pull `sample` down to 5 percent.** The stored rows fall by twenty times, and
  the counters derived from this event do not move at all.
