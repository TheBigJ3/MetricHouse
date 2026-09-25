# timer

A timer measures how long something took. It stores durations the way a
[gauge](/primitives/gauge) stores readings, and adds the parts that are easy to
get wrong by hand: the start timestamp, the `finally`, and the clock that can
run backwards.

```ts
import { oneOf, str, timer } from 'metrichouse/core'

export const httpLatency = timer('http_latency', {
  dims: { route: str(), status: oneOf(['ok', 'error']) },
  resolution: '10s',
  flush: '1m',
  write: async (rows) => clickhouse.insert({ table: 'http_latency', values: rows }),
})
```

```ts
const order = await httpLatency.time({ route: '/checkout', status: 'ok' }, async () => {
  return createOrder(input)
})
```

| | |
| --- | --- |
| Import | `import { timer } from 'metrichouse/core'` |
| Answers | How long did this take |
| Storage | Durations folded into `min`, `max`, `sum` and `count` per window per series |
| Row | `{ id, bucket_ts, ...dims, min, max, sum, count }` |
| Write with | [`time()`](#timer-time), [`start()`](#timer-start) and [`end()`](#handle-end), [`observe()`](#timer-observe) |
| Read with | [`current()`](#timer-current), [`totals()`](#timer-totals), [`snapshot()`](#timer-snapshot) |
| Use it for | Request latency, query time, job duration, anything with a stopwatch around it |

A timer stores four numbers rather than every duration, so a p95 comes from
[pairing it with an event](#record).

## timer()

```ts
timer<D>(name: string, config: TimerConfig<D>): Timer<D>
```

Declares a timer. It is inert until a [house](/guide/the-house) binds it, and
timing on an unbound timer throws.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | [The metric name](#name) |
| `config.dims` | shape | no | [Labels to break the duration down by](#dims) |
| `config.resolution` | duration | yes | [How wide one window is](#resolution) |
| `config.flush` | duration | no | [The fastest this may ship](#flush) |
| `config.grace` | duration | no | [How long a window waits for timings on their way](#grace) |
| `config.aggregate` | array | no | [Which columns reach your sink](#aggregate) |
| `config.record` | event name | no | [An event every timing is also written to](#record) |
| `config.write` | function | yes | [Where the rows go](#write) |

### name

```ts
timer('http_latency', { ... })
```

A non empty string, unique inside a house.

### dims

```ts
dims?: Record<string, FieldType>      // default: none
```

The labels a duration is broken down by. Route, operation, table and outcome
are the usual ones.

```ts
dims: { route: str(), status: oneOf(['ok', 'error']) }
```

A dim may not be called `duration_ms`. That name is reserved for the field a
timing carries onto a [`record`](#record) event, whether or not you use one.

```ts
import { DURATION_FIELD } from 'metrichouse/core'
// 'duration_ms'
```

A timer takes its dims across several calls, so the rules about when the
argument may be left out matter more here than elsewhere.
[dims](/reference/dims#when-the-argument-may-be-left-out) has them.

### resolution

```ts
resolution: DurationInput      // required
```

How wide one window is. Several timings per window make `min` and `max`
meaningful, so `'10s'` suits a busy route and `'1m'` suits a background job.
[Buckets and time](/guide/buckets-and-time) covers the choice.

### flush

```ts
flush?: DurationInput      // default: the house default
```

The fastest this timer may ship. `resolution` has to divide it evenly.
Identical to [the counter's](/primitives/counter#flush).

### grace

```ts
grace?: DurationInput      // default: '2s'
```

How long a window waits after it ends before a flush may claim it, so timings
recorded inside it have time to reach storage. A timing lands in the window its
`end()` is called in, not the one it started in, so a slow operation that
crosses a boundary is counted in the later window. Grace does not change that.
Identical to [the counter's](/primitives/counter#grace).

### aggregate

```ts
aggregate?: readonly ('last' | 'min' | 'max' | 'sum' | 'count')[]
// default: ['min', 'max', 'sum', 'count']
```

Which columns reach your sink. A timer leaves `last` out by default, because
the last operation to finish inside a window is an arbitrary one rather than
the latest state of anything.

```ts
timer('checkout', { aggregate: ['min', 'max', 'sum', 'count', 'last'], ...rest })
```

```ts
import { TIMER_AGGREGATES } from 'metrichouse/core'
// ['min', 'max', 'sum', 'count']
```

### record

```ts
record?: string      // default: none
```

Names an [event](/primitives/event) that every timing is also written to, for
when four numbers are not enough and you need percentiles.

```ts
export const httpLatency = timer('http_latency', {
  dims: { route: str(), status: oneOf(['ok', 'error']) },
  resolution: '10s',
  flush: '1m',

  // The name of an event this timer also writes to.
  record: 'http_latency_samples',

  write: toClickHouse('http_latency'),
})

// The declaration is the timer's dims plus duration_ms.
export const httpLatencySamples = event('http_latency_samples', {
  fields: {
    ...httpLatency.dims,
    duration_ms: float(),
  },

  // Percentiles are stable on a sample. The timer stays exact either way.
  sample: 0.1,

  flush: '1m',
  write: toClickHouse('http_latency_samples'),
})
```

Rules for the pairing:

| Rule | Why |
| --- | --- |
| The target must be an event | Nothing else keeps individual durations |
| It must declare `duration_ms: float()` | That is the column a timing writes |
| It must declare every dim the timer has | Spreading `...timer.dims` is the whole declaration |
| Any other required field is rejected | A timing has no value to put in one. Make them optional or give them defaults |
| The event is named rather than passed | Resolution happens at the first timing, so the two can be declared in either order |
| The event keeps its own staging, sampling and sink | The timer stays exact while the sample table holds a slice |
| A broken pairing goes to `onError` | The timing is still recorded on the timer. A misconfigured sample table must not lose the measurement |

```sql
SELECT
  route,
  quantile(0.50)(duration_ms) AS p50,
  quantile(0.95)(duration_ms) AS p95,
  quantile(0.99)(duration_ms) AS p99
FROM http_latency_samples
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY route;
```

### write

```ts
write: (rows: GaugeRow<D>[], context: WriteContext) => Promise<void> | void
```

Where the rows go. Required. A timer is a gauge of durations, so it hands over
`GaugeRow`, with each aggregate typed `number | undefined` because
[`aggregate`](#aggregate) decides at run time which of them a row carries.

## timer.time()

```ts
time<T>(dims: Dims, fn: () => T): T
time<T>(fn: () => T): T      // only when no dim is required
```

Runs a function, records how long it took, and returns whatever the function
returned. It handles both synchronous and asynchronous functions.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `dims` | the declared shape | when any dim is required | The labels for this timing |
| `fn` | `() => T` | yes | The work being measured |

```ts
const user = await httpLatency.time({ route: '/users/:id', status: 'ok' }, async () => {
  return db.users.findById(id)
})
```

**Returns** exactly what `fn` returned, including its promise when `fn` is
asynchronous.

The duration is recorded whether `fn` returns or throws. A request that times
out after thirty seconds is the latency you most need to see, so dropping
failures would hide it. Whatever `fn` throws is rethrown unchanged.

**Throws before `fn` runs** when the timer is unbound or the dims are wrong,
and never after, when the work has already happened.

## timer.start()

```ts
start(dims?: Partial<Dims>): TimerHandle
```

Starts a timing and returns a handle. Use it when part of the labelling is only
known at the end, which is usually the outcome.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `dims` | any subset of the declared shape | no | The labels already known |

```ts
const span = httpLatency.start({ route: '/checkout' })

try {
  await chargeCard(order)
  span.end({ status: 'ok' })
} catch (error) {
  span.end({ status: 'error' })
  throw error
}
```

**Returns** a [`TimerHandle`](#handle-end), whose type remembers which keys were
bound here, so `end()` asks only for what is left.

**Throws** when the timer is unbound, or a dim given here is undeclared or ill
typed. A required dim that is still missing is only checkable at `end()`.

The handle is the whole state, so there is no registry and nothing to leak. An
abandoned handle is garbage, not ending one is how a timing is cancelled, and
two timings may nest or overlap freely.

## handle.end()

```ts
end(dims?: Dims): number
```

Stops the timing, records it, and returns the duration in milliseconds.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `dims` | the keys `start()` did not bind | when any of them is required | The rest of the labels |

```ts
span.end({ status: 'ok' })    // records, and returns the milliseconds
span.end()                    // legal once nothing is left to supply
```

A dim given here overrides one bound at `start()`, because the end of an
operation knows more than its beginning did.

**Idempotent.** A second call records nothing and returns the first duration.
Throwing would be louder, and `end()` lives in `catch` and `finally` blocks,
where a throw replaces the error you were handling.

**Throws** when the merged dims are incomplete or invalid. Nothing is recorded,
and the handle stays open so a corrected call can still end it.

## handle.elapsed()

```ts
elapsed(): number
```

Milliseconds since `start()`, without ending anything. Once `end()` has
succeeded it returns the recorded duration and stops moving.

```ts
if (span.elapsed() > 1_000) log.warn('slow checkout', { requestId })
```

## timer.observe()

```ts
observe(ms: number, dims?: Dims): void
```

Records a duration measured somewhere else: a query time a database reported, a
timing that arrived in an upstream header.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ms` | `number` | yes | The duration in milliseconds. Negative and non finite values throw |
| `dims` | the declared shape | when any dim is required | The labels for this timing |

```ts
httpLatency.observe(queryTimeMs, { route: '/checkout', status: 'ok' })
```

## timer.current()

```ts
current(dims: Dims): Promise<GaugeCell | undefined>
current(): Promise<GaugeCell | undefined>      // no dims declared
```

The open window's fold of durations for one series.

```ts
await httpLatency.current({ route: '/checkout', status: 'ok' })
// { last: 34.2, min: 12.4, max: 3400.2, sum: 5012.9, count: 18 }
```

**Returns** the fold, or `undefined` when nothing has been timed in this
window. All five numbers are folded live whatever
[`aggregate`](#aggregate) ships.

## timer.totals()

```ts
totals(): Promise<GaugeTotals | undefined>
```

Every series in the open window, merged into `min`, `max`, `sum` and `count`.
There is no `last`, for the reason
[a gauge gives](/primitives/gauge#gauge-totals).

## timer.snapshot()

```ts
snapshot<O extends SnapshotOptions>(options?: O): Promise<GaugeLiveRow<D, O>[]>
```

Every unflushed window of durations, as rows.

```ts
await httpLatency.snapshot({ rollup: 'sum', groupBy: ['route'] })
```

Options are the gauge's, and they are listed in
[Snapshot options](/reference/snapshot-options).

## timer.flush()

```ts
flush(options?: FlushOptions): Promise<MetricFlushReport>
```

Ships every closed window to this timer's own `write` function. The
[`record`](#record) event keeps its own cadence and flushes separately.
[Flush options](/reference/flush-options) covers the argument and the report.

## timer.drain()

```ts
drain(): Promise<void>
```

Resolves once every timing recorded so far has reached the driver.

## timer.rowShape()

```ts
rowShape(): RowShape
```

```ts
httpLatency.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'route', 'status', 'min', 'max', 'sum', 'count']
```

## Properties

| Property | Type | Value |
| --- | --- | --- |
| `name` | `string` | The name it was declared with |
| `kind` | `'timer'` | |
| `storage` | `'bucketed'` | It folds timings into windows |
| `dims` | `Shape` | The declared dims |
| `resolutionMs` | `number` | `resolution`, parsed |
| `flushMs` | `number` | `flush`, parsed, including one taken from the house |
| `graceMs` | `number` | `grace`, parsed. `2000` by default |
| `aggregate` | `readonly GaugeAggregate[]` | The columns this timer writes |
| `record` | `string \| undefined` | The event timings are also written to |
| `isBound` | `boolean` | `true` once a house has registered it |
| `write` | `WriteFn` | The function it was declared with |

## Which clock

Durations come from `performance.now()`, which only moves forward. `Date.now()`
can step backwards when the system clock is adjusted, and a negative latency in
your data is worse than a slightly imprecise one.

The window a timing lands in still comes from the house clock, read when the
timing ends. A timing is recorded where it completed.

Sub microsecond digits are rounded away, because they are scheduler jitter
rather than signal, and they would turn every `sum` column into a number with
eleven decimal places.

::: warning Cloudflare Workers
On Workers, `performance.now()` only advances across input and output. A timer
there measures work that waits on the network or on storage, and reads pure
computation as zero. Everything else in MetricHouse is unaffected.
:::

## The row

```ts
{
  id: '...',
  bucket_ts: Date,
  route: '/checkout',
  status: 'ok',
  min: 12.4,
  max: 3400.2,
  sum: 5012.9,
  count: 18,
}
```

| Column | Meaning |
| --- | --- |
| `id` | Derived from the name, the window and the dim values |
| `bucket_ts` | The start of the window |
| one per dim | The label values for this series |
| `min` | The fastest timing in this window |
| `max` | The slowest |
| `sum` | Every duration added together |
| `count` | How many timings there were |

Inside `write`, each row is a `GaugeRow<D>`, because a timer is a gauge of
durations. The average is `sum / count`, for the reason
[a gauge gives](/primitives/gauge#why-there-is-no-average).

### Queries

```sql
SELECT
  route,
  sum(sum) / sum(count) AS avg_ms,
  min(min)              AS fastest_ms,
  max(max)              AS slowest_ms
FROM http_latency
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY route;
```

For percentiles, query the [`record`](#record) event instead.

## Patterns

### Timing database queries, with percentiles

```ts
// metrics/schema.ts
import { event, float, oneOf, str, timer } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const dbQuery = timer('db_query', {
  dims: {
    operation: oneOf(['select', 'insert', 'update', 'delete']),
    table: str(),
    outcome: oneOf(['ok', 'error']),
  },

  resolution: '10s',
  flush: '1m',

  record: 'db_query_samples',
  write: toClickHouse('db_query'),
})

export const dbQuerySamples = event('db_query_samples', {
  fields: {
    ...dbQuery.dims,
    duration_ms: float(),
  },

  // Keep every slow query. Sample the fast ones.
  sample: (fields) => (fields.duration_ms > 500 ? 1 : 0.05),

  flush: '1m',
  write: toClickHouse('db_query_samples'),
})
```

```ts
// db/instrument.ts
import { dbQuery } from '../metrics/schema.js'

type Operation = 'select' | 'insert' | 'update' | 'delete'

export async function timed<T>(
  operation: Operation,
  table: string,
  run: () => Promise<T>,
): Promise<T> {
  // Bind what we know now. The outcome is only known at the end.
  const span = dbQuery.start({ operation, table })

  try {
    const result = await run()
    span.end({ outcome: 'ok' })
    return result
  } catch (error) {
    span.end({ outcome: 'error' })
    throw error
  }
}
```

```ts
// Usage.
const user = await timed('select', 'users', () => db.users.findById(id))
await timed('insert', 'orders', () => db.orders.create(order))
```

```sql
-- Average and worst case per table, from the exact timer.
SELECT
  table,
  operation,
  sum(count)            AS queries,
  sum(sum) / sum(count) AS avg_ms,
  max(max)              AS slowest_ms
FROM db_query
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY table, operation
ORDER BY avg_ms DESC;

-- Percentiles, from the sampled event.
SELECT
  table,
  quantile(0.95)(duration_ms) AS p95,
  quantile(0.99)(duration_ms) AS p99
FROM db_query_samples
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY table
ORDER BY p95 DESC;
```

### Timing a whole HTTP handler

```ts
// middleware/latency.ts
import { httpLatency } from '../metrics/schema.js'

export function latencyMiddleware(req, res, next) {
  const span = httpLatency.start({ route: req.route?.path ?? 'unmatched' })

  res.on('finish', () => {
    span.end({ status: res.statusCode >= 500 ? 'error' : 'ok' })
  })

  // A connection dropped before the response finished is still a timing worth
  // having. end() is idempotent, so both handlers firing is harmless.
  res.on('close', () => {
    span.end({ status: 'error' })
  })

  next()
}
```

Both `finish` and `close` can fire for the same response, and the timing should
be recorded once, by whichever came first. That is what
[`end()`](#handle-end) being idempotent buys.

## Playground

### The fold

These are durations in one window. Drag them and watch the four stored numbers
move.

<MhFoldExplorer metric="http_latency" kind="timer" unit="ms" :start="[34, 12, 128, 3400]" :max="4000" />

Notice what `max` does when one timing is slow, and what the average does. That
gap is why [`record`](#record) exists.

### The windows

<MhBucketExplorer metric="http_latency" kind="timer" resolution="10s" flush="1m" grace="2s" :series="20" />

Drag `grace` past `resolution` and the detail strip makes the consequence
obvious: a window then waits longer than it was open.
