# Writing a sink

A sink is the `write` function you put on every metric. It is the boundary
between MetricHouse and your storage, and it is the only part of the pipeline you
have to write yourself.

```ts
type WriteFn<R extends Row = Row> = (rows: R[], context: WriteContext) => Promise<void> | void
```

`R` is the type of one row. You never write it yourself: TypeScript works it out
from the dimensions or fields declared next to `write`, so each metric's rows
arrive already typed.

Return normally and the data is deleted. Throw and it comes back on the next
attempt.

## The simplest one

```ts
const pageViews = counter('page_views', {
  dims: { path: str() },
  resolution: '1m',
  flush: '5m',
  write: async (rows) => {
    await db.insertInto('page_views').values(rows).execute()
  },
})
```

That is a complete sink. Everything below is detail you can add when you need it.

## The rows you receive

Every row is a plain object with an `id` and whatever columns that metric type
produces.

::: code-group

```ts [counter]
{
  id: '4f2c18a6e1d9b0c73a5e8f21b6d40c99',
  bucket_ts: Date,      // the start of the time window
  ...yourDims,          // one key per declared dimension
  value: 42,
}
```

```ts [gauge]
{
  id: '...',
  bucket_ts: Date,
  ...yourDims,
  last: 1266,           // only the aggregates you asked for
  min: 1266,
  max: 1301,
  sum: 5148,
  count: 4,
}
```

```ts [event]
{
  id: '019278b4-...',   // a UUID version 7
  ts: Date,             // when the event happened
  ...yourFields,        // json fields arrive as strings
  _ingested_at: Date,   // when record() was called
  _sample_rate: 0.05,   // only if the metric samples
}
```

```ts [log]
{
  id: '019278b4-...',
  ts: Date,
  level: 'warn',
  message: 'processor slow',
  error_stack: '...',   // only when an Error was passed
  ...yourFields,
  _ingested_at: Date,
}
```

```ts [timer]
{
  id: '...',
  bucket_ts: Date,
  ...yourDims,
  min: 12.4,            // milliseconds, fractional
  max: 3400.2,
  sum: 5012.9,
  count: 18,
}
```

:::

You never have to guess. Ask the metric:

```ts
httpRequests.rowShape()
// {
//   columns: [
//     { name: 'id',        kind: 'str',   optional: false },
//     { name: 'bucket_ts', kind: 'ts',    optional: false },
//     { name: 'route',     kind: 'str',   optional: false },
//     { name: 'status',    kind: 'oneOf', optional: false },
//     { name: 'value',     kind: 'int',   optional: false },
//   ]
// }
```

This is the honest column list, in order, and it is the right way to generate a
table definition or check that your schema still matches.

### Rows are typed

`rows` has the type of the metric it belongs to. Every dimension or field comes
back as the type you declared it with, and a column the metric never produces is
a type error.

```ts
const httpRequests = counter('http_requests', {
  dims: { route: str(), status: oneOf(['2xx', '4xx', '5xx']) },
  resolution: '10s',
  flush: '1m',
  write: async (rows) => {
    rows[0].route      // string
    rows[0].status     // '2xx' | '4xx' | '5xx'
    rows[0].value      // number
    rows[0].bucket_ts  // Date
    rows[0].method
    //      ^^^^^^ Type error: this counter has no method dimension
  },
})
```

These are the same types [`snapshot()`](./reading-live-data.md#types-follow-the-options)
returns, without the two liveness columns, `bucket_open` and
`bucket_elapsed_ms`, which only a live read adds. Each type is exported from
`metrichouse/core` for when you want to name it.

| Kind | Each row is a | Typed from |
| --- | --- | --- |
| `counter` | `CounterRow<D>` | `D`, the declared dimensions |
| `gauge`, `timer` | `GaugeRow<D>` | `D`, the declared dimensions |
| `event` | `EventRow<F>` | `F`, the declared fields |
| `log` | `LogRow<F, L>` | `F`, the declared fields, and `L`, the declared levels |

Two columns are typed more loosely than they arrive:

- **A gauge's or a timer's aggregates** are typed `number | undefined`. Which of
  them reach a row is decided by the `aggregate` setting when the program runs,
  and the type does not follow that setting.
- **A `json()` field** is typed as the value you recorded, but it arrives as a
  string. TypeScript cannot tell a `json()` field apart from any other field once
  its type has been worked out, so only these docs can tell you.

In production, name the columns you insert instead of passing each row through.
Then a schema change breaks the build at the sink, before it can reach the
table.

```ts
const httpRequests = counter('http_requests', {
  dims: { route: str(), status: oneOf(['2xx', '4xx', '5xx']) },
  resolution: '10s',
  flush: '1m',
  write: async (rows) => {
    await db
      .insertInto('http_requests')
      .values(
        rows.map((row) => ({
          id: row.id,
          bucket_ts: row.bucket_ts,
          // Renaming the route dimension in the schema stops this line
          // compiling. Passing the whole row through would only find out
          // when the insert runs.
          route: row.route,
          status: row.status,
          // The table calls it requests. The rename is typed too.
          requests: row.value,
        })),
      )
      // A retry resends the same id, and this turns the second insert
      // into an update.
      .onConflict((oc) =>
        oc.column('id').doUpdateSet((eb) => ({ requests: eb.ref('excluded.requests') })),
      )
      .execute()
  },
})
```

## The context

The second argument describes the batch.

```ts
interface WriteContext {
  metric: string        // 'http_requests'
  kind: 'counter' | 'gauge' | 'event' | 'log' | 'timer'
  bucketFrom: number    // oldest window start, or oldest record timestamp
  bucketTo: number      // one window past the newest, so the range is [from, to)
  total: number         // this batch's headline number
  attempt: number       // 1 on the first try, higher after a failure
  source: 'flush' | 'batch' | 'immediate'
}
```

`total` means something slightly different per metric type, and always means the
obvious thing:

| Kind | `total` is |
| --- | --- |
| `counter` | every increment in the batch added up |
| `gauge`, `timer` | every observed value added up |
| `event`, `log` | how many records are in the batch |

That is useful when your sink only wants the headline and does not care about the
breakdown:

```ts
write: async (rows, context) => {
  statsd.gauge(`${context.metric}.rows`, rows.length)
  statsd.gauge(`${context.metric}.total`, context.total)
  await db.insert(rows)
}
```

`source` tells you why this call happened:

| Value | Meaning |
| --- | --- |
| `'flush'` | A normal flush, from a timer, a cron or a direct call |
| `'batch'` | A locally staged event filled up and shipped itself |
| `'immediate'` | Immediate delivery. Treat as last write wins on `id` |

## Row ids and duplicates

Every row carries an `id`, and what that id means depends on the metric type.

**Counters, gauges and timers** derive their id from the metric name, the window
and the dimension values. The same window shipped twice produces exactly the same
id, with no stored state anywhere. That is what makes a retry safe.

**Events and logs** get a UUID version 7 minted when you call `record()`. Two
identical events are two different rows, because the whole point of an event is
the detail. The id is minted at record time rather than at flush time, so a
retried batch resends the same rows rather than new ones.

MetricHouse guarantees the same id. Whether your table collapses the two rows is
your table's decision.

::: code-group

```sql [ClickHouse]
-- Keeps the newest row per sorting key.
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
```

:::

```ts
// Postgres, with the upsert that makes a retry harmless.
write: async (rows) => {
  await sql`
    INSERT INTO http_requests ${sql(rows, 'id', 'bucket_ts', 'route', 'status', 'value')}
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value
  `
}
```

Use `DO UPDATE` rather than `DO NOTHING`. A resent aggregate row may carry a
larger value than the first send if a late write landed in the meantime, and you
want the newer number.

There is also a helper that names the columns your table should treat as unique:

```ts
import { naturalKey } from 'metrichouse/core'

naturalKey(httpRequests.dims)   // ['bucket_ts', 'route', 'status']
```

## Retries and failure

Throwing is how you say the write failed.

```ts
write: async (rows, context) => {
  try {
    await clickhouse.insert({ table: 'http_requests', values: rows })
  } catch (error) {
    logger.error({ err: error, attempt: context.attempt, rows: rows.length })
    throw error        // the rows come back next flush, unchanged
  }
}
```

When you throw:

- Nothing is deleted.
- The data goes back into the live set exactly as it was.
- The next flush sends the same rows, with the same ids, and `attempt` goes up.

`attempt` is useful for changing behaviour after repeated failure:

```ts
write: async (rows, context) => {
  if (context.attempt > 5) {
    await s3.put(`failed/${context.metric}/${Date.now()}.json`, JSON.stringify(rows))
    return          // return normally so it stops being retried
  }
  await clickhouse.insert({ table: context.metric, values: rows })
}
```

::: warning Do not swallow errors silently
A sink that catches and returns tells MetricHouse the write succeeded, and the
data is deleted. If you catch, either genuinely store the rows somewhere else, or
rethrow.
:::

## Sending several metrics to one place

Each metric declares its own `write`, so a shared helper is the normal pattern.
A helper typed with `Row[]` fits every metric, because every row is a `Row`.
Inside the helper the columns read as `unknown`, which is fine for code that
hands rows straight to a database client.

```ts
// metrics/sinks.ts
import type { Row, WriteContext } from 'metrichouse/core'
import { clickhouse } from '../clickhouse.js'

export function toClickHouse(table: string) {
  return async (rows: Row[], context: WriteContext) => {
    await clickhouse.insert({
      table,
      values: rows,
      format: 'JSONEachRow',
    })
    logger.debug({ table, rows: rows.length, source: context.source })
  }
}
```

```ts
// metrics/schema.ts
export const httpRequests = counter('http_requests', {
  dims: { route: str(), status: oneOf(['2xx', '4xx', '5xx']) },
  resolution: '10s',
  flush: '1m',
  write: toClickHouse('http_requests'),
})

export const httpLatency = timer('http_latency', {
  dims: { route: str() },
  resolution: '10s',
  flush: '1m',
  write: toClickHouse('http_latency'),
})
```

Because the write function is per metric, a schema whose counters go to
ClickHouse and whose logs go to S3 needs no special handling. There was never one
shared destination to special case.

```ts
export const appLog = log('app_log', {
  fields: { service: str() },
  flush: '30s',
  write: async (rows) => {
    const ndjson = rows.map((row) => JSON.stringify(row)).join('\n')
    await s3.putObject({
      Bucket: 'app-logs',
      Key: `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.ndjson`,
      Body: ndjson,
    })
  },
})
```

## Handling dates and JSON

`bucket_ts`, `ts` and `_ingested_at` arrive as JavaScript `Date` objects, and any
`ts()` field you declared does too. Most database clients accept a `Date`
directly. If yours wants something else, convert in the sink. The row is typed,
so `bucket_ts` is already known to be a `Date`:

```ts
write: async (rows) => {
  await clickhouse.insert({
    table: 'http_requests',
    values: rows.map((row) => ({
      ...row,
      bucket_ts: row.bucket_ts.toISOString(),
    })),
    format: 'JSONEachRow',
  })
}
```

Fields declared with `json()` arrive already turned into a string, so the column
they want is text. That is deliberate: a payload column is nearly always stored
as text or as the database's own JSON type, and both accept a string. The row
type still shows the value you recorded, as [Rows are typed](#rows-are-typed)
explains.

## In production

A sink with a timeout, size limits and a dead letter path:

```ts
import type { Row, WriteContext } from 'metrichouse/core'

const MAX_ROWS_PER_INSERT = 10_000
const WRITE_TIMEOUT_MS = 15_000

export function toClickHouse(table: string) {
  return async (rows: Row[], context: WriteContext) => {
    // A long outage can produce a very large batch. Chunk it.
    for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT)

      await withTimeout(
        clickhouse.insert({ table, values: chunk, format: 'JSONEachRow' }),
        WRITE_TIMEOUT_MS,
      )
    }

    metrics.inserted.inc(rows.length, { table })
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`write timed out after ${ms}ms`)), ms),
    ),
  ])
}
```

Points worth keeping:

- **Chunk large batches.** If your database was unreachable for an hour, the
  first successful flush carries an hour of data.
- **Time out.** A write that hangs forever holds a claim forever, and that data
  is invisible to live reads until it settles.
- **Make it idempotent.** Retries are normal, not exceptional.
- **Do not rewrite the data.** Rename columns and change types if you must, but
  the ids and the values should reach your table unchanged.
