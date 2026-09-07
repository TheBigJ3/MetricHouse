# Gauge

A gauge records point-in-time values and folds them per (dimension combination, time bucket) into the mergeable set: `last`, `min`, `max`, `sum`, `count`. Average is deliberately **not** stored — it is `sum / count` at query time, and unlike the five stored aggregates it cannot be merged across buckets without lying.

## Main functions

**Declaration**
- `gauge(name, config)`

Config fields:
- `dims`, `resolution`, `flush`, `grace`, `retention`, `write` — same as [counter](03-counter.md)
- `aggregate` — subset of `['last','min','max','sum','count']`, default all five; fewer aggregates means fewer columns

**Write**
- `.set(value, dims?)` — record an observation into the current bucket
- `.setMany(entries)` — one pipeline round trip

**Read** — unflushed data only
- `.current(dims?)` — the open bucket's folded aggregates
- `.snapshot(opts?)` — every unflushed bucket

**Introspection**
- `.rowShape()` — the typed row your `write()` will receive

## Not a level

A gauge answers "what were the values observed in this bucket". If nothing was
observed, the bucket is **absent** — which on a chart is a hole, not a held
value. For a quantity that persists between observations (in-flight requests,
queue depth, active connections) use [`level()`](20-level.md): it stores deltas,
carries forward, and has `inc()` / `dec()`.

## Internals worth knowing

`min`, `max`, and `last` are not increments, so the Redis driver folds them in a Lua script rather than `HINCRBY` — one atomic read-modify-write per field, still pipelined. See [10-driver-redis.md](10-driver-redis.md).

## In use

```ts
// metrics/schema.ts
import { gauge, str } from 'metrichouse'
import { ch } from '../lib/clickhouse'

export const bowlLevel = gauge('bowl_level', {
  dims: { bowlId: str(), room: str() },
  resolution: '10s',
  flush: '1m',
  aggregate: ['last', 'min', 'max', 'sum', 'count'],
  write: async (rows) => ch.insert('bowl_level', rows),
})
```

```ts
import { bowlLevel } from './metrics/schema'

bowlLevel.set(0.82, { bowlId: 'b1', room: 'kitchen' })
bowlLevel.set(0.79, { bowlId: 'b1', room: 'kitchen' })
bowlLevel.set(0.91, { bowlId: 'b1', room: 'kitchen' })

await bowlLevel.current({ bowlId: 'b1', room: 'kitchen' })
// -> { last: 0.91, min: 0.79, max: 0.91, sum: 2.52, count: 3 }
```

Row handed to `write()`:

```ts
{
  id: 'd41c…',
  bucket_ts: 2026-09-05T14:03:10Z,
  bowlId: 'b1',
  room: 'kitchen',
  last: 0.91, min: 0.79, max: 0.91, sum: 2.52, count: 3,
}
```

```sql
-- average is derived, and merges correctly across any window
SELECT toStartOfHour(bucket_ts) AS h, sum(sum) / sum(count) AS avg_level
FROM bowl_level GROUP BY h;
```
