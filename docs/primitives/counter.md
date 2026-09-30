# counter

A counter tallies occurrences. Every increment folds into one number per label
combination per time window, and that number is the one thing no later query
can rebuild once the increments are gone.

```ts
import { counter, oneOf, str } from 'metrichouse/core'

export const httpRequests = counter('http_requests', {
  dims: {
    route: str(),
    status: oneOf(['2xx', '3xx', '4xx', '5xx']),
  },
  resolution: '10s',
  flush: '1m',
  write: async (rows) => clickhouse.insert({ table: 'http_requests', values: rows }),
})
```

```ts
httpRequests.add({ route: '/checkout', status: '2xx' })
```

| | |
| --- | --- |
| Import | `import { counter } from 'metrichouse/core'` |
| Answers | How many times did this happen |
| Storage | Folded into one row per window per series |
| Row | `{ id, bucket_ts, ...dims, value }` |
| Write with | [`add()`](#counter-add) |
| Read with | [`current()`](#counter-current), [`snapshot()`](#counter-snapshot) |
| Use it for | Requests, errors, signups, emails sent, cache misses, bytes, money taken |

Methods below are written as `counter.add()`. In your own code that is the name
you gave the metric, so `httpRequests.add()`.

## counter()

```ts
counter<D>(name: string, config: CounterConfig<D>): Counter<D>
```

Declares a counter. The returned object is inert until a
[house](/guide/the-house) binds it to a driver, and writing to an unbound
counter throws rather than dropping the write.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | [The metric name](#name) |
| `config.dims` | shape | no | [Labels to break the number down by](#dims) |
| `config.resolution` | duration | yes | [How wide one window is](#resolution) |
| `config.flush` | duration | no | [The fastest this may ship](#flush) |
| `config.grace` | duration | no | [How long a window waits for writes on their way](#grace) |
| `config.value` | field type | no | [Whether fractions are allowed](#value) |
| `config.write` | function | yes | [Where the rows go](#write) |

Every check runs when the module is imported, so a mistake in the declaration
is a startup failure rather than a surprise at the first write.

### name

```ts
counter('http_requests', { ... })
```

A non empty string, unique inside a house. It names the metric in every row id,
in flush reports, in error messages, and in whatever table you store the rows
in. Two metrics sharing a name throw at `createHouse`.

### dims

```ts
dims?: Record<string, FieldType>      // default: none
```

The labels this number is broken down by. Each distinct combination of values
becomes its own running total, and its own row per window.

```ts
dims: {
  route: str(),
  status: oneOf(['2xx', '3xx', '4xx', '5xx']),
}
```

Leave it out for a counter that is a single number.

```ts
const jobsProcessed = counter('jobs_processed', { resolution: '1m', flush: '1m', write })
jobsProcessed.add()
```

A dim cannot be named `id`, `bucket_ts` or `value`, the columns a counter
writes on every row itself.

[dims](/reference/dims) covers the declaration, the argument at each call site,
the series key underneath and what cardinality costs.

### resolution

```ts
resolution: DurationInput      // required
```

How wide one time window is. One window becomes one row per series, so this is
the setting that decides how much detail you keep and how many rows you write.

```ts
resolution: '10s'    // 8,640 windows per series per day
resolution: '1m'     // 1,440
```

Windows are aligned to the Unix epoch, so servers that started at different
moments agree on every boundary. [Durations](/reference/durations) covers the
format and [Buckets and time](/guide/buckets-and-time) covers the choice.

### flush

```ts
flush?: DurationInput      // default: the house default
```

The fastest this counter may ship. A flush that arrives earlier than this does
nothing and reports why, so the setting is a floor rather than a schedule.

`resolution` has to divide `flush` evenly, because a shipment carries whole
windows.

```ts
resolution: '10s', flush: '1m'    // 6 windows per shipment
resolution: '7s',  flush: '1m'    // Error: 7s does not divide 1m evenly
```

Omit it to take `defaults.flush` from the house. A counter with neither throws
when the house registers it, naming both places the setting could come from, and
stays unregistered, so the same counter can be registered once the mistake is
fixed.

`flush` becomes the delay of a timer, so it has to be longer than zero and at
most `2147483647` milliseconds, just under 25 days. See
[Durations](/reference/durations#settings-a-timer-waits-for).

### grace

```ts
grace?: DurationInput      // default: the house default, then '2s'
```

How long a window waits after it ends before a flush may claim it. A write is
stamped with its window when `add()` is called and reaches storage a moment
later, so a write stamped `:09.998` can arrive at `:10.001`. Grace holds the
window back until writes like that have landed. It never moves a write into an
earlier window: an `add()` called at `:10.001` counts in the `:10` window.

A write that arrives after its window was claimed anyway is moved forward into
the oldest window that has not shipped. See
[Buckets and time](/guide/buckets-and-time#a-write-that-misses-its-window).

```ts
grace: '5s'     // a slow upstream, so give writes longer to arrive
grace: '0s'     // ship the instant a window closes
```

Grace delays every shipment by its own length, so it trades freshness for
completeness.

### value

```ts
value?: FieldType<number, false>      // default: int()
```

Whether `add()` accepts fractions. A counter is whole numbers by default,
because folding by addition is where repeated floating point arithmetic goes
wrong.

```ts
requests.add(1.5)
// Error: declares an integer counter, so 1.5 is not a legal delta. Declare
// `value: float()` if fractions are intended
```

An integer counter also stops at `9007199254740991`, `Number.MAX_SAFE_INTEGER`.
Past it a double cannot hold every whole number, so a total there would stop
being exact without any error. A delta past it throws at `add()`, and an
`add()` whose total would pass it is refused by the driver and reported to
`onError`, leaving the total where it was. A `float()` counter has no such
limit.

```ts
import { float } from 'metrichouse/core'

const bytesTransferred = counter('bytes_transferred', {
  value: float(),
  resolution: '1m',
  flush: '1m',
  write,
})
```

::: tip Money belongs in whole units
Store cents with `int()` rather than dollars with `float()`. A counter folds by
adding, and repeated floating point addition is exactly where money goes
missing.
:::

### write

```ts
write: (rows: CounterRow<D>[], context: WriteContext) => Promise<void> | void
```

Where the rows go. Required, because a counter that measures something and
ships it nowhere is a mistake best caught at declaration.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `rows` | `CounterRow<D>[]` | The finished rows, with every dim typed as declared |
| `context` | `WriteContext` | Which metric, which window, how many, and which attempt |

Throwing from `write` returns the rows to the live set, and the same rows come
back on the next flush with `context.attempt` raised.
[Writing a sink](/guide/writing-a-sink) covers the whole contract, and
[the context](/guide/writing-a-sink#the-context) covers every field of the
second argument.

## counter.add()

```ts
add(delta: number, dims: Dims): void
add(dims: Dims): void
add(delta: number): void      // no dims declared
add(): void                   // no dims declared
```

Adds to the window that is open right now.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `delta` | `number` | `1` | How much to add. May be negative |
| `dims` | the declared shape | required once any dim is declared | [The labels for this increment](/reference/dims#the-dims-argument) |

```ts
httpRequests.add({ route: '/checkout', status: '2xx' })      // adds 1
httpRequests.add(5, { route: '/checkout', status: '2xx' })   // adds 5

jobsProcessed.add()                                          // adds 1
jobsProcessed.add(5)
```

**Returns** nothing, and returns before storage has acknowledged anything. Call
[`drain()`](#counter-drain) when you need to know a write landed.

**Throws immediately** when the mistake is in your code:

| Message | Cause |
| --- | --- |
| `not bound to a house` | The counter was never registered |
| `delta must be a finite number` | `NaN` or `Infinity` |
| `the first argument must be a number or a dims object, got bigint` | A bigint, boolean or string where a delta goes. TypeScript allows it on a counter with no dims |
| `the first argument must be a number or a plain dims object, got a Date` | A `Date`, an array or a boxed `Number` where a delta goes, which TypeScript also allows there |
| `declares an integer counter, so 1.5 is not a legal delta` | A fraction without `value: float()` |
| `9007199254740992 is past 9007199254740991` | A whole delta too large for a double to hold exactly, on an integer counter |
| `missing required dim "status"` | A declared dim with no value and no default |
| `unknown dim "pakr"` | A key that is not declared |

A failure on the way to storage cannot be thrown at a caller that has already
returned, so it goes to the house's `onError` handler instead.

### Negative deltas

A delta may be negative, which is how a reversal is recorded on the same
metric.

```ts
payments.add(4_999, { currency: 'usd', status: 'captured' })
payments.add(-4_999, { currency: 'usd', status: 'refunded' })
```

## counter.current()

```ts
current(dims?: InferShape<D>): Promise<number>
```

The live value of the window still filling.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | the declared shape | every series | Which series to read |

```ts
await httpRequests.current({ route: '/checkout', status: '2xx' })   // 42
await httpRequests.current()                                        // 1337
```

**Returns** a number. With dim values, that one series. Without them, every
series added together, which is the metric's own total. A series nothing has
written to returns `0`, so a dashboard renders a zero rather than a gap.

On an integer counter, a total across series past `9007199254740991` rejects
rather than returning a nearby whole number, and so does a `snapshot()` that
merges series or windows past it. Each series stays below it on its own, but
several added together can pass it. `context.total` in a sink is a plain sum
of doubles, and past that range it is rounded.

This reads the open window only. For the finished windows that have not shipped
yet, use [`snapshot()`](#counter-snapshot).

On `ioredis()`, the total of an integer counter is added up inside Redis, so a
window with a hundred thousand series sends back one number. The driver does
this only when no order of adding could change the answer, and otherwise sends
every series for the counter to add, so the result is the same either way. A
float counter always adds the series itself. See
[sumBuckets](/reference/driver-contract#sumbuckets).

## counter.snapshot()

```ts
snapshot<O extends SnapshotOptions>(options?: O): Promise<CounterLiveRow<D, O>[]>
```

Every window still held by the driver, as rows: the open one, and any closed
window that has not been flushed and acknowledged.

```ts
await httpRequests.snapshot()

await httpRequests.snapshot({
  rollup: 'sum',
  groupBy: ['route'],
  orderBy: 'value',
  limit: 10,
})
```

**Returns** rows carrying the same columns your `write` function would receive,
plus `bucket_open` and `bucket_elapsed_ms`. The row type follows the options,
so a rollup that dropped `bucket_ts` is a compile error when you read it.

Every option is listed in [Snapshot options](/reference/snapshot-options), and
[Reading live data](/guide/reading-live-data) covers what to build with them.

## counter.flush()

```ts
flush(options?: FlushOptions): Promise<MetricFlushReport>
```

Ships every closed window to this counter's own `write` function and settles
the claim. Needs no house.

```ts
await httpRequests.flush()
await httpRequests.flush({ force: true })
```

**Returns** a report rather than rejecting, because a flush that fails has
already put its rows back. [Flush options](/reference/flush-options) covers the
argument and every field of the report.

## counter.drain()

```ts
drain(): Promise<void>
```

Resolves once every `add()` issued so far has reached the driver.

```ts
httpRequests.add({ route: '/checkout', status: '2xx' })
await httpRequests.drain()
```

On a runtime that freezes the moment a response is returned, this is the only
write guarantee there is. `house.drain()` does the same across a whole schema.

## counter.rowShape()

```ts
rowShape(): RowShape
```

The exact columns your `write` function will receive, in order.

```ts
httpRequests.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'route', 'status', 'value']

httpRequests.rowShape()
// { columns: [
//     { name: 'id',        kind: 'str',   optional: false },
//     { name: 'bucket_ts', kind: 'ts',    optional: false },
//     { name: 'route',     kind: 'str',   optional: false },
//     { name: 'status',    kind: 'oneOf', optional: false },
//     { name: 'value',     kind: 'int',   optional: false },
//   ] }
```

This is the honest answer to "what columns does my table need", and it is how
a generic sink builds a statement without being told the schema twice. A column
is `optional: true` only for a dim marked `.optional()`. A dim with a
`.default()` is never null, so its column is not.

## Properties

Everything a counter reports about itself, all read only.

| Property | Type | Value |
| --- | --- | --- |
| `name` | `string` | The name it was declared with |
| `kind` | `'counter'` | |
| `storage` | `'bucketed'` | It folds writes into windows |
| `dims` | `Shape` | The declared dims |
| `resolutionMs` | `number` | `resolution`, parsed |
| `flushMs` | `number` | `flush`, parsed, including one taken from the house |
| `graceMs` | `number` | `grace`, parsed, including one taken from the house. `2000` when neither sets it |
| `isFloat` | `boolean` | `true` when `value: float()` was declared |
| `isBound` | `boolean` | `true` once a house has registered it |
| `write` | `WriteFn` | The function it was declared with |

Five more methods move a batch through a flush: `recoverBatch()`,
`claimBatch()`, `materializeClaim()`, `ackBatch()` and `releaseBatch()`. You
call them when you are building a metric type of your own. See
[Extension points](/reference/#extension-points).

## The row

```ts
{
  id: '4f2c18a6e1d9b0c73a5e8f21b6d40c99',
  bucket_ts: Date,      // the start of the window
  route: '/checkout',   // one column per declared dim
  status: '2xx',
  value: 42,
}
```

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Derived from the name, the window and the dim values, so a resent row carries the same id |
| `bucket_ts` | `Date` | The start of the window |
| one per dim | as declared | The label values for this series |
| `value` | `number` | Every delta in this window, added together |

Inside `write`, each row is a `CounterRow<D>`, so `route` is a `string` and
`status` is one of the four values you listed. See
[Rows are typed](/guide/writing-a-sink#rows-are-typed).

### Table schema

::: code-group

```sql [ClickHouse]
CREATE TABLE http_requests (
  id         String,
  bucket_ts  DateTime64(3),
  route      String,
  status     LowCardinality(String),
  value      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, route, status);
```

```sql [Postgres]
CREATE TABLE http_requests (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  route      TEXT NOT NULL,
  status     TEXT NOT NULL,
  value      BIGINT NOT NULL
);
CREATE INDEX ON http_requests (bucket_ts, route);
```

:::

Treating `id` as unique is what makes a retried shipment harmless.
[Making a duplicate harmless](/guide/reliability#making-a-duplicate-harmless)
covers the pattern for each database.

### Queries

Rows are already grouped by window, so the queries stay small.

```sql
-- Requests per minute, per route, for the last hour.
SELECT
  toStartOfMinute(bucket_ts) AS minute,
  route,
  sum(value) AS requests
FROM http_requests
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY minute, route
ORDER BY minute;
```

```sql
-- Error rate per route.
SELECT
  route,
  sum(value) AS total,
  sumIf(value, status = '5xx') AS errors,
  errors / total AS error_rate
FROM http_requests
WHERE bucket_ts >= now() - INTERVAL 1 DAY
GROUP BY route
ORDER BY error_rate DESC;
```

## Patterns

### Counting requests

A full request counter on Express, with the pieces you would actually ship.

```ts
// metrics/schema.ts
import { counter, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const httpRequests = counter('http_requests', {
  dims: {
    // The route pattern, never the raw URL. '/users/:id', not '/users/98421'.
    route: str(),
    method: oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER']),
    // Status classes, not codes. Four values instead of forty.
    status: oneOf(['2xx', '3xx', '4xx', '5xx']),
  },

  // One row per ten seconds is enough to see a spike, and is 8,640 rows per
  // series per day rather than 86,400.
  resolution: '10s',
  flush: '1m',

  write: toClickHouse('http_requests'),
})
```

```ts
// middleware/metrics.ts
import type { NextFunction, Request, Response } from 'express'
import { httpRequests } from '../metrics/schema.js'

// Clamped, so a 1xx or an unusual code still lands in a declared class.
const statusClass = (code: number): '2xx' | '3xx' | '4xx' | '5xx' =>
  code >= 500 ? '5xx' : code >= 400 ? '4xx' : code >= 300 ? '3xx' : '2xx'

const KNOWN = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
type Method = (typeof KNOWN)[number] | 'OTHER'
// OPTIONS, HEAD and anything else map to OTHER. A value outside oneOf() throws,
// and inside a 'finish' handler that would crash the process.
const methodOf = (method: string): Method =>
  (KNOWN as readonly string[]).includes(method) ? (method as Method) : 'OTHER'

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    // A client that hangs up first fires 'close' only, so 'finish' is the one
    // to count. Its statusCode would still be the default 200.
    httpRequests.add({
      // req.route is the pattern, so '/users/98421' is recorded as '/users/:id'.
      // The mount path is added so a mounted router does not collapse into '/:id'.
      route: req.route ? (req.baseUrl ?? '') + req.route.path : 'unmatched',
      method: methodOf(req.method),
      status: statusClass(res.statusCode),
    })
  })

  next()
}
```

Three decisions worth copying:

- **Route patterns rather than raw paths.** A raw path creates one series per
  URL, which is one series per user id in the path.
- **Status classes rather than codes.** Four values instead of forty, and it is
  what a chart shows anyway.
- **`'unmatched'` as a fallback.** Requests that match no route are still
  counted, under one label rather than one per bad URL.

### Counting money

```ts
export const revenue = counter('revenue_cents', {
  dims: {
    currency: oneOf(['usd', 'eur', 'gbp']),
    plan: oneOf(['starter', 'pro', 'enterprise']),
    kind: oneOf(['charge', 'refund']),
  },

  // Finer detail, because reconciling a payment incident by the second is
  // worth the extra rows.
  resolution: '1s',

  // A slower cadence, because this ships to a table people run reports over.
  flush: '5m',

  // Payments can be recorded well after they happen.
  grace: '30s',

  write: toClickHouse('revenue_cents'),
})

// Cents, as whole numbers.
revenue.add(4_999, { currency: 'usd', plan: 'pro', kind: 'charge' })
revenue.add(4_999, { currency: 'usd', plan: 'pro', kind: 'refund' })
```

```sql
SELECT
  toDate(bucket_ts)                              AS day,
  currency,
  sumIf(value, kind = 'charge') / 100.0          AS charged,
  sumIf(value, kind = 'refund') / 100.0          AS refunded,
  (charged - refunded)                           AS net
FROM revenue_cents
WHERE bucket_ts >= today() - 30
GROUP BY day, currency
ORDER BY day;
```

## Playground

Drag the settings and watch what they do to the shape of the data. The two
outer boxes are consecutive flush windows, and the cells inside each one are
the windows that ship together.

<MhBucketExplorer metric="http_requests" kind="counter" resolution="10s" flush="1m" :series="12" />

Three things are worth discovering here:

- **Widening `flush` does not lose detail.** The window count per shipment goes
  up, the rows per day stay the same, and only the number of calls to your
  database falls.
- **Widening `resolution` is the only setting that reduces rows.** It is also
  the only one that loses detail.
- **Label combinations multiply everything.** Drag that slider to 100,000 and
  watch the daily row count, then read [dims](/reference/dims#choosing-what-to-label).
