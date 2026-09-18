# timer

A timer measures how long something took. It is a [gauge](/primitives/gauge) of
durations, so it adds no storage of its own. What it adds is the part everyone
writes by hand and gets subtly wrong: the start timestamp, the `finally`, and the
clock that can run backwards.

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

## Three ways to record

### time: wrap a function

The simplest one. It returns whatever the function returns, and works with both
synchronous and asynchronous functions.

```ts
const user = await httpLatency.time({ route: '/users/:id', status: 'ok' }, async () => {
  return db.users.findById(id)
})
```

The duration is recorded whether the function returns or throws. A request that
times out after thirty seconds is exactly the latency you most need to see, so
dropping failures would hide it. Whatever the function throws is rethrown
unchanged.

If the timer is not registered, or the dimension values are wrong, `time()` throws
**before** your function runs, never after the work has already happened.

### start and end: when the outcome is known later

A status code is usually only known at the end. `start()` returns a handle, and
`end()` takes the rest of the labels.

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

```ts
span.elapsed()   // milliseconds so far, without ending
span.end()       // records, and returns the duration in milliseconds
```

A dimension given at the end overrides one bound at the start, because the end
knows more than the start did.

`end()` is idempotent. A second call records nothing and returns the first
duration. Throwing would be louder, but `end()` lives in `catch` and `finally`
blocks, where a throw replaces the error you were handling.

The handle is the state, so there is no registry to leak. An abandoned handle is
garbage, and not ending it is how you cancel a timing. It also does not care
whether two timings nest or merely overlap, which a stack based approach does.

### observe: a duration measured somewhere else

```ts
httpLatency.observe(queryTimeMs, { route: '/checkout', status: 'ok' })
```

Use this for a duration your database reported, or one that arrived in an
upstream header.

## Which clock

Durations come from `performance.now()`, which only moves forward.
`Date.now()` can step backwards when the system clock is adjusted, and a negative
latency in your data is worse than a slightly imprecise one.

The *window* a timing lands in still comes from the house clock, read when the
timing ends. A timing is recorded where it completed.

::: warning Cloudflare Workers
On Workers, `performance.now()` only advances across input and output. A timer
there measures work that waits on the network or on storage, and reads pure
computation as zero. Everything else in MetricHouse is unaffected.
:::

## What it stores

The same five numbers a gauge folds, minus `last` by default.

| Column | Meaning |
| --- | --- |
| `min` | The fastest in this window |
| `max` | The slowest |
| `sum` | Every duration added together |
| `count` | How many timings there were |

`last` is left out because it means nothing for a duration. Of many operations
finishing in the same window, the last to finish is arbitrary. Ask for it
explicitly if you want it:

```ts
timer('checkout', { aggregate: ['min', 'max', 'sum', 'count', 'last'], ... })
```

The average is `sum / count`, exactly as for a gauge.

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

Inside `write`, each row is a `GaugeRow`, because a timer is a gauge of
durations. Your dimensions have the types you declared, and each aggregate is
typed `number | undefined`. See [Rows are typed](../guide/writing-a-sink.md#rows-are-typed).

### Try the fold

These are durations in one bucket. Drag them and watch the four stored numbers
move.

<MhFoldExplorer metric="http_latency" kind="timer" unit="ms" :start="[34, 12, 128, 3400]" :max="4000" />

Notice what `max` does when one timing is slow, and what the average does. That
gap is the reason the next section exists.

## Percentiles

A timer cannot give you a p95. It stores four numbers, not the individual
durations, and a percentile needs the values.

Point the timer at an event and every timing is recorded there too.

```ts
import { event, float, oneOf, str, timer } from 'metrichouse/core'

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

  // Percentiles are stable on a sample. The gauge stays exact either way.
  sample: 0.1,

  flush: '1m',
  write: toClickHouse('http_latency_samples'),
})
```

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

Rules for the pairing:

- The event must declare `duration_ms: float()`. Spreading `...timer.dims` into
  its fields is the rest of the declaration.
- Any other required field on the event is rejected, because a timing cannot
  supply one. Make them optional or give them defaults.
- The event is named rather than passed, and resolved at the first timing, so the
  two can be declared in either order.
- The event keeps its own staging, sampling and write function, so the timer stays
  exact while the sample table holds a slice.
- A broken pairing is reported through `onError` and the timing is still recorded
  on the timer. A misconfigured sample table must not lose the measurement.

## Tune it

A timer buckets like a gauge, so the settings behave identically. What changes is
that a slow operation can finish well after the window it started in, which is
what `grace` covers.

<MhBucketExplorer metric="http_latency" kind="timer" resolution="10s" flush="1m" grace="2s" :series="20" />

Drag `grace` past `resolution` and the detail strip makes the consequence
obvious: a bucket then waits longer than it was open.

## Reading

```ts
await httpLatency.current({ route: '/checkout', status: 'ok' })
// { last: 34.2, min: 12.4, max: 3400.2, sum: 5012.9, count: 18 }

await httpLatency.totals()
// every route merged

await httpLatency.snapshot({ rollup: 'sum', groupBy: ['route'] })
```

## Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the duration down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late timing may still land |
| `aggregate` | array | `['min','max','sum','count']` | Which columns reach your sink |
| `record` | event name | none | An event every timing is also written to |
| `write` | function | required | Where the rows go |

A dimension may not be called `duration_ms`. That name is reserved for the field a
timing carries onto a `record` event, whether or not you use one.

## In production

Database query timings, broken down by operation, with percentiles available from
a sampled event.

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

For the common case where the outcome does not need a label, `time()` is shorter:

```ts
const rows = await dbQuery.time({ operation: 'select', table: 'users', outcome: 'ok' }, () =>
  db.users.findMany(),
)
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

That last detail is why `end()` is idempotent. Both `finish` and `close` can fire
for the same response, and the timing should be recorded once, by whichever came
first.

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
  quantile(0.50)(duration_ms) AS p50,
  quantile(0.95)(duration_ms) AS p95,
  quantile(0.99)(duration_ms) AS p99
FROM db_query_samples
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY table
ORDER BY p95 DESC;
```
