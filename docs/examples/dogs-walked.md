# Dogs walked

A counter with dimensions, followed all the way from the first write to the first
chart. If you want one example to read end to end, read this one.

The scenario is a small business that walks dogs. We want to know how many walks
happened, broken down by who did them, which park they went to, and how long the
walk was booked for.

## The metric

```ts
// metrics/schema.ts
import { counter, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const dogsWalked = counter('dogs_walked', {
  dims: {
    // A small, known set of staff. Safe as a dimension.
    walker: str(),

    // A small, known set of parks. Also safe.
    park: str(),

    // Three booking lengths. A closed set, so a typo is a compile error.
    duration: oneOf(['30min', '60min', '90min']),
  },

  // One row per minute is plenty. Nobody needs per second detail on dog walks.
  resolution: '1m',

  // Ship every five minutes. One insert instead of five.
  flush: '5m',

  write: toClickHouse('dogs_walked'),
})
```

Notice what is **not** a dimension. The dog's name, the customer id and the
booking id would all create one series per value, which turns a handful of rows
into thousands. Those belong on an [event](/primitives/event), which we add
below.

## The house

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import * as schema from './schema.js'
import { logger } from '../logger.js'

export const house = createHouse({
  driver: memory(),
  schema,
  onError: (error, { metric }) => logger.error({ err: error, metric }, 'metric failed'),
  onWarn: (message) => logger.warn({ message }, 'metrichouse'),
})
```

## Writing

```ts
// services/walks.ts
import { dogsWalked } from '../metrics/schema.js'

export async function completeWalk(walk: Walk) {
  await db.walks.markComplete(walk.id)

  dogsWalked.add({
    walker: walk.walkerName,
    park: walk.park,
    duration: walk.bookedDuration,
  })
}
```

That is the whole write path. `add()` returns immediately and never throws
because the database was slow.

Walking three dogs at once is one call:

```ts
dogsWalked.add(3, { walker: 'Sam', park: 'riverside', duration: '60min' })
```

## Reading it live

```ts
// Walks completed this minute, by this walker at this park.
await dogsWalked.current({ walker: 'Sam', park: 'riverside', duration: '60min' })
// 4

// Every combination added together.
await dogsWalked.current()
// 17

// The busiest parks right now, across everything not yet shipped.
await dogsWalked.snapshot({
  rollup: 'sum',
  groupBy: ['park'],
  orderBy: 'value',
  direction: 'desc',
  limit: 5,
})
// [
//   { park: 'riverside', value: 42, bucket_open: false, bucket_elapsed_ms: 300000 },
//   { park: 'central',   value: 28, bucket_open: false, bucket_elapsed_ms: 300000 },
// ]
```

## Running it

```ts
// server.ts
import { house } from './metrics/house.js'

const server = app.listen(3000)
house.start()

process.on('SIGTERM', async () => {
  server.close()
  await house.stop()
  process.exit(0)
})
```

## The table

::: code-group

```sql [ClickHouse]
CREATE TABLE dogs_walked (
  id         String,
  bucket_ts  DateTime64(3),
  walker     LowCardinality(String),
  park       LowCardinality(String),
  duration   LowCardinality(String),
  value      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, walker, park, duration);
```

```sql [Postgres]
CREATE TABLE dogs_walked (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  walker     TEXT NOT NULL,
  park       TEXT NOT NULL,
  duration   TEXT NOT NULL,
  value      BIGINT NOT NULL
);
CREATE INDEX ON dogs_walked (bucket_ts);
```

:::

The column list is not guesswork:

```ts
dogsWalked.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'walker', 'park', 'duration', 'value']
```

## What arrives

```
id                                bucket_ts            walker  park       duration  value
4f2c18a6e1d9b0c73a5e8f21b6d40c99  2026-09-17 14:03:00  Sam     riverside  60min     4
a91e5b7c2d380f4419ce6a05d7b2f318  2026-09-17 14:03:00  Sam     central    30min     2
7d10c4b9e5a2f68301bd97e4c2a5f0b6  2026-09-17 14:04:00  Alex    riverside  90min     1
```

With five walkers, four parks and three durations, that is at most sixty rows a
minute, and in practice far fewer because most combinations never happen in any
given minute. A row only exists where something was actually counted.

## Queries

```sql
-- Walks per day, per walker.
SELECT
  toDate(bucket_ts) AS day,
  walker,
  sum(value)        AS walks
FROM dogs_walked
WHERE bucket_ts >= today() - 30
GROUP BY day, walker
ORDER BY day, walks DESC;
```

```sql
-- Busiest hour of the week, for scheduling.
SELECT
  toDayOfWeek(bucket_ts) AS weekday,
  toHour(bucket_ts)      AS hour,
  sum(value)             AS walks
FROM dogs_walked
GROUP BY weekday, hour
ORDER BY walks DESC
LIMIT 10;
```

```sql
-- Revenue estimate from booking lengths.
SELECT
  toDate(bucket_ts) AS day,
  sumIf(value, duration = '30min') * 20
    + sumIf(value, duration = '60min') * 35
    + sumIf(value, duration = '90min') * 50 AS revenue_gbp
FROM dogs_walked
GROUP BY day
ORDER BY day DESC;
```

## Adding the detail

The counter cannot tell you which dog, which customer, or what the walker wrote
in the notes. Add an event for that, and let it feed the counter so the two can
never disagree.

```ts
// metrics/schema.ts
import { counter, event, float, int, json, oneOf, str } from 'metrichouse/core'

export const dogsWalked = counter('dogs_walked', {
  dims: { walker: str(), park: str(), duration: oneOf(['30min', '60min', '90min']) },
  resolution: '1m',
  flush: '5m',
  write: toClickHouse('dogs_walked'),
})

export const walkCompleted = event('walk_completed', {
  fields: {
    // High cardinality, which is exactly what an event is for.
    walkId: str(),
    customerId: str(),
    dogName: str(),
    walker: str(),
    park: str(),
    duration: oneOf(['30min', '60min', '90min']),
    distanceKm: float(),
    priceGbp: int(),
    notes: str().optional(),
    gpsTrack: json<Array<{ lat: number; lng: number }>>().optional(),
  },

  flush: '1m',

  // One fact recorded once. The counter is incremented from it, so there is no
  // second write path to forget.
  derive: {
    dogs_walked: (fields) => ({
      dims: {
        walker: fields.walker,
        park: fields.park,
        duration: fields.duration,
      },
    }),
  },

  write: toClickHouse('walk_completed'),
})
```

Now the write path records one fact:

```ts
export async function completeWalk(walk: Walk) {
  await db.walks.markComplete(walk.id)

  walkCompleted.record({
    walkId: walk.id,
    customerId: walk.customerId,
    dogName: walk.dogName,
    walker: walk.walkerName,
    park: walk.park,
    duration: walk.bookedDuration,
    distanceKm: walk.distanceKm,
    priceGbp: walk.priceGbp,
    notes: walk.notes,
    gpsTrack: walk.gpsTrack,
  })

  // dogs_walked was incremented by derive. No second call needed.
}
```

```sql
-- Which customers walk most often.
SELECT customerId, count() AS walks, sum(priceGbp) AS spend_gbp
FROM walk_completed
WHERE ts >= now() - INTERVAL 90 DAY
GROUP BY customerId
ORDER BY spend_gbp DESC
LIMIT 20;
```

```sql
-- Average distance by booking length.
SELECT duration, avg(distanceKm) AS avg_km, count() AS walks
FROM walk_completed
GROUP BY duration;
```

## What this example demonstrates

- **Dimensions are for small, known sets.** Walkers, parks and booking lengths.
  Not dog names or booking ids.
- **`resolution` and `flush` are separate.** One minute of detail, one insert
  every five minutes.
- **A live read needs no database.** `current()` and `snapshot()` answer from
  memory.
- **Counters and events work together.** The counter is small and fast to chart.
  The event holds everything else. `derive` keeps them in step.
