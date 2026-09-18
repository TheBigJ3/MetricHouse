# Online users

A number that exists whether or not you look at it, sampled on a timer, and read
back live for a status page.

## The metric

```ts
// metrics/schema.ts
import { gauge, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const onlineUsers = gauge('online_users', {
  dims: {
    region: oneOf(['us-east', 'eu-west', 'ap-south']),
    plan: oneOf(['free', 'pro', 'enterprise']),
  },

  // One row per minute per region per plan. Nine series, 1,440 rows a day each.
  resolution: '1m',
  flush: '1m',

  write: toClickHouse('online_users'),
})
```

A gauge rather than a counter, because this is a value that exists at a moment in
time. Counting connections as they open and subtracting as they close would drift
the first time a connection dies without a clean close.

## The house

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import * as schema from './schema.js'

export const house = createHouse({
  driver: memory(),
  schema,
  onError: (error, { metric }) => console.error(`[${metric}]`, error),
  onWarn: (message) => console.warn('[metrichouse]', message),
})
```

Use `ioredis()` instead if you run more than one instance and want the numbers to
describe the whole fleet.

## Sampling

Nothing samples for you. A gauge only has a value when you write one.

```ts
// metrics/sampler.ts
import { onlineUsers } from './schema.js'
import { sessions } from '../sessions.js'

export function startSampling() {
  // Every ten seconds gives six observations per minute, so min and max are
  // meaningful and no minute is ever empty.
  const handle = setInterval(async () => {
    const counts = await sessions.countActiveByRegionAndPlan()

    for (const { region, plan, count } of counts) {
      onlineUsers.set(count, { region, plan })
    }
  }, 10_000)

  // Sampling should never be the reason the process stays alive.
  handle.unref()

  return () => clearInterval(handle)
}
```

::: tip Write a zero rather than skipping
If a region has nobody online, write `0` rather than skipping it. A missing
observation and a zero look identical in a chart, and only one of them is true.
:::

## Wiring it up

```ts
// server.ts
import { house } from './metrics/house.js'
import { startSampling } from './metrics/sampler.js'

const server = app.listen(3000)

house.start()
const stopSampling = startSampling()

async function shutdown() {
  server.close()
  stopSampling()
  await house.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

## Reading it live

The point of a gauge is that you can read it before it ships.

```ts
// routes/status.ts
import { onlineUsers } from '../metrics/schema.js'

app.get('/status', async (_req, res) => {
  const overall = await onlineUsers.totals()
  const usEast = await onlineUsers.current({ region: 'us-east', plan: 'pro' })

  res.json({
    // totals() has no `last`, because with several series there is no single
    // latest observation.
    onlineNow: overall?.sum ?? 0,
    peakThisMinute: overall?.max ?? 0,

    // current() is undefined when nothing has been observed this minute.
    usEastPro: usEast?.last ?? 0,
  })
})
```

A breakdown for a small dashboard:

```ts
app.get('/status/regions', async (_req, res) => {
  const rows = await onlineUsers.snapshot({
    complete: false,             // include the minute still filling
    rollup: 'sum',
    groupBy: ['region'],
    orderBy: 'max',
    direction: 'desc',
  })

  res.json(rows)
})
```

## The table

::: code-group

```sql [ClickHouse]
CREATE TABLE online_users (
  id         String,
  bucket_ts  DateTime64(3),
  region     LowCardinality(String),
  plan       LowCardinality(String),
  last       Float64,
  min        Float64,
  max        Float64,
  sum        Float64,
  count      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, region, plan);
```

```sql [Postgres]
CREATE TABLE online_users (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  region     TEXT NOT NULL,
  plan       TEXT NOT NULL,
  last       DOUBLE PRECISION NOT NULL,
  min        DOUBLE PRECISION NOT NULL,
  max        DOUBLE PRECISION NOT NULL,
  sum        DOUBLE PRECISION NOT NULL,
  count      BIGINT NOT NULL
);
CREATE INDEX ON online_users (bucket_ts, region);
```

:::

## Queries

```sql
-- Average concurrency per hour, per region.
SELECT
  toStartOfHour(bucket_ts) AS hour,
  region,
  sum(sum) / sum(count) AS avg_online,
  max(max)              AS peak_online
FROM online_users
WHERE bucket_ts >= now() - INTERVAL 7 DAY
GROUP BY hour, region
ORDER BY hour;
```

```sql
-- The busiest minute of each day, for capacity planning.
SELECT
  toDate(bucket_ts) AS day,
  max(max)          AS peak_concurrent_users
FROM online_users
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```

```sql
-- How much of the peak comes from enterprise accounts.
SELECT
  toStartOfHour(bucket_ts)              AS hour,
  maxIf(max, plan = 'enterprise')       AS peak_enterprise,
  max(max)                              AS peak_total
FROM online_users
WHERE bucket_ts >= now() - INTERVAL 1 DAY
GROUP BY hour
ORDER BY hour;
```

## What you get

```
bucket_ts            region    plan        last  min   max   sum    count
2026-09-17 14:03:00  us-east   pro         1297  1284  1301  7764   6
2026-09-17 14:03:00  us-east   free        4102  4088  4133  24_642 6
2026-09-17 14:03:00  eu-west   pro          642   630   651   3852   6
```

Six observations a minute, folded into one row each. Nine series means nine rows
a minute, about 13,000 a day, which any database will store for years without
noticing.
