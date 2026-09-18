# Examples

Each example is a complete small setup: the metric declarations, the code that
writes to them, the table to store the rows in, and a query or two you would
actually run. Copy one and change the names.

| Example | Shows |
| --- | --- |
| [Online users](/examples/online-users) | A gauge sampled on a timer, and a live read that drives a status page |
| [Dogs walked](/examples/dogs-walked) | A counter with dimensions, from first write to first chart |
| [API requests](/examples/api-requests) | A counter, a timer and a log working together on one service |
| [Background jobs](/examples/background-jobs) | Job outcomes, durations and failures in a worker process |
| [Serverless analytics](/examples/serverless-analytics) | Page views on a platform that freezes between requests |

## What they have in common

Every example follows the same three files.

```
metrics/
  sinks.ts     the write functions, shared between metrics
  schema.ts    the metric declarations
  house.ts     the driver, the defaults and the error handling
```

That split is worth keeping. The schema travels between environments unchanged,
and the house is where the deployment specific decisions live.

## A sink to start from

Most examples use this helper. Swap the body for your own database client.

```ts
// metrics/sinks.ts
import type { Row, WriteContext } from 'metrichouse/core'
import { createClient } from '@clickhouse/client'

const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL })

export function toClickHouse(table: string) {
  return async (rows: Row[], context: WriteContext) => {
    // A long outage produces a large batch. Chunk it.
    for (let i = 0; i < rows.length; i += 10_000) {
      await clickhouse.insert({
        table,
        values: rows.slice(i, i + 10_000),
        format: 'JSONEachRow',
      })
    }

    if (context.attempt > 1) {
      console.warn(`${context.metric}: succeeded on attempt ${context.attempt}`)
    }
  }
}
```

For Postgres:

```ts
// metrics/sinks.ts
import type { Row } from 'metrichouse/core'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)

export function toPostgres(table: string, columns: string[]) {
  // Every column except the key gets overwritten when a row is resent.
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(', ')

  return async (rows: Row[]) => {
    for (let i = 0; i < rows.length; i += 5_000) {
      const chunk = rows.slice(i, i + 5_000)

      await sql`
        INSERT INTO ${sql(table)} ${sql(chunk, ...columns)}
        ON CONFLICT (id) DO UPDATE SET ${sql.unsafe(updates)}
      `
    }
  }
}
```

And the simplest one of all, which is a perfectly good place to start:

```ts
export const toConsole = (table: string) => (rows: Row[]) => {
  console.log(table, rows)
}
```
