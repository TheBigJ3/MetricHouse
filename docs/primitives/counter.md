# counter

A counter tallies occurrences. It is the one metric that genuinely cannot be
rebuilt after the fact: once you throw away the increments, no query brings the
per second count back.

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

## Use it for

Requests served, errors, signups, emails sent, cache misses, bytes transferred,
money taken, jobs completed. Anything you would answer with "how many".

## Writing

`add()` has four shapes, and they all do the same thing.

```ts
// A metric with dimensions.
httpRequests.add({ route: '/checkout', status: '2xx' })      // adds 1
httpRequests.add(5, { route: '/checkout', status: '2xx' })   // adds 5

// A metric with no dimensions.
jobsProcessed.add()                                          // adds 1
jobsProcessed.add(5)
```

`add()` returns immediately. It does not wait for storage and it never throws
because storage was slow. It does throw straight away if the values are wrong,
because that is a mistake in your code rather than a transient failure.

### Negative values

Deltas may be negative, which is how you record a reversal on the same metric.

```ts
payments.add(4_999, { currency: 'usd', status: 'captured' })
payments.add(-4_999, { currency: 'usd', status: 'refunded' })
```

### Whole numbers by default

A counter accepts whole numbers only unless you say otherwise.

```ts
const requests = counter('requests', {
  resolution: '1m',
  flush: '1m',
  write,
})

requests.add(1.5)
// Error: declares an integer counter, so 1.5 is not a legal delta
```

```ts
import { float } from 'metrichouse/core'

const bytesTransferred = counter('bytes_transferred', {
  value: float(),          // now fractions are allowed
  resolution: '1m',
  flush: '1m',
  write,
})
```

::: tip Money belongs in whole units
Store cents as `int()`, not dollars as `float()`. A counter folds by adding, and
repeated floating point addition is exactly where money goes missing.
:::

## Reading

```ts
// The window still filling, for one series.
await httpRequests.current({ route: '/checkout', status: '2xx' })   // 42

// Every series added together.
await httpRequests.current()                                        // 1337

// Every unshipped window, as rows.
await httpRequests.snapshot()

// The top ten routes right now.
await httpRequests.snapshot({
  rollup: 'sum',
  groupBy: ['route'],
  orderBy: 'value',
  limit: 10,
})
```

An unseen series returns `0` rather than `undefined`, because a dashboard should
render a zero rather than a gap. Full details in
[Reading live data](/guide/reading-live-data).

## Tune it

Drag the settings and watch what they do to the shape of the data. The two outer
boxes are consecutive flush windows, and the cells inside each one are the
buckets that ship together.

<MhBucketExplorer metric="http_requests" kind="counter" resolution="10s" flush="1m" :series="12" />

Three things are worth discovering here:

- **Widening `flush` does not lose detail.** The bucket count per window goes up,
  the rows per day stay the same, and only the number of calls to your database
  falls.
- **Widening `resolution` is the only setting that reduces rows.** It is also the
  only one that loses detail.
- **Label combinations multiply everything.** Drag that slider to 100,000 and
  watch the daily row count, then read
  [Metrics and dimensions](/guide/metrics-and-dimensions).

For what a bucket row actually is once it reaches your table, and how to pick
these two settings deliberately, see
[Buckets and time](/guide/buckets-and-time).

## The rows you receive

```ts
{
  id: '4f2c18a6e1d9b0c73a5e8f21b6d40c99',
  bucket_ts: Date,      // the start of the window
  route: '/checkout',   // one key per declared dimension
  status: '2xx',
  value: 42,
}
```

Inside `write`, each row is a `CounterRow`. `route` is a `string`, `status` is
one of the four values you listed, and `value` is a `number`. See [Rows are typed](../guide/writing-a-sink.md#rows-are-typed).

```ts
httpRequests.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'route', 'status', 'value']
```

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

## Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the number down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late write may still land |
| `value` | `int()` or `float()` | `int()` | Whether fractions are allowed |
| `write` | function | required | Where the rows go |

## Querying what you stored

Because rows are already grouped by window, the queries are small.

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

## In production

A full request counter on Express, with the pieces you would actually ship.

```ts
// metrics/schema.ts
import { counter, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const httpRequests = counter('http_requests', {
  dims: {
    // The route pattern, never the raw URL. '/users/:id', not '/users/98421'.
    route: str(),
    method: oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
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

const statusClass = (code: number) => `${Math.floor(code / 100)}xx` as '2xx' | '3xx' | '4xx' | '5xx'

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    httpRequests.add({
      // req.route is the pattern, so '/users/98421' is recorded as '/users/:id'.
      route: req.route?.path ?? 'unmatched',
      method: req.method as 'GET',
      status: statusClass(res.statusCode),
    })
  })

  next()
}
```

Three decisions worth copying:

- **Route patterns, not raw paths.** A raw path creates one series per URL, which
  is one series per user id in the path.
- **Status classes, not codes.** Four values instead of forty, and it is what a
  chart shows anyway.
- **`'unmatched'` as a fallback.** Requests that match no route still get counted,
  under one label rather than one per bad URL.

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
