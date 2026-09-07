# Distinct

A distinct counts unique values — active tenants, distinct API keys, sessions seen — using a HyperLogLog sketch, so it answers "how many uniques right now" without keeping every value. It exists because unique counts are the one aggregate that **cannot** be derived from counters and that [event sampling](05-events.md) actively destroys.

> Added after [Tollgate](../imagine/tollgate/FINDINGS.md) — missing stat type 3. Sampling events at 5% and computing uniques from the survivors is not an approximation, it is a different number.

## Main functions

**Declaration**
- `distinct(name, config)`

Config fields:
- `dims` — bucketing dimensions, as elsewhere
- `of` — a type builder describing what is being counted (`str()`, `int()`)
- `resolution`, `flush`, `grace`, `write`
- `precision` — HLL precision, default `14` (~0.81% error, 12 KB per series)

**Write**
- `.add(value, dims?)` — record one observation
- `.addMany(values, dims?)` — one round trip

**Read**
- `.current(dims?)` — approximate unique count for the open bucket
- `.count(opts?)` — unique count across every unflushed bucket, merged
- `.snapshot(opts?)` — per-bucket counts and sketches

## Scope, stated up front

`distinct` is a **live-read primitive**. It gives you cheap, mergeable uniques over the unflushed window, which is exactly the question a dashboard asks and exactly the one counters cannot answer.

For historical uniques, use ClickHouse over an [event](05-events.md) table — `uniq(tenantId)` or `uniqExact(tenantId)`. That is the plating, and it is better than anything MetricHouse would ship.

**The interop caveat:** Redis HLL sketches and ClickHouse `AggregateFunction(uniq, …)` states are different formats and cannot be converted. So a flushed row carries two things:

- `approx_count` — correct for that bucket, and **not summable** across buckets (summing overcounts anything seen twice)
- `sketch` — the raw Redis HLL bytes, mergeable by anything that speaks that format, opaque to ClickHouse

If you need unique counts over arbitrary historical windows, the event table is the answer and this metric is the live-window companion to it. Both is the normal configuration, not a redundancy.

## In use

```ts
import { distinct, str } from 'metrichouse'

export const activeTenants = distinct('active_tenants', {
  of: str(),
  dims: { region: str(), model: str() },
  resolution: '60s',
  flush: '5m',
  precision: 14,
  write: async (rows) => ch.insert('active_tenants', rows),
})
```

```ts
activeTenants.add(req.tenantId, { region: 'iad', model: req.model })

await activeTenants.current({ region: 'iad', model: 'claude-opus-5' })
// -> 312          uniques in the open minute

await activeTenants.count()
// -> 1_847        merged across every unflushed bucket, sketches unioned
```

Row handed to `write()`:

```ts
{
  id: 'f22e…',
  bucket_ts: '14:03:00',
  region: 'iad',
  model: 'claude-opus-5',
  approx_count: 312,
  sketch: <Buffer …>,      // Redis HLL bytes
}
```

```sql
-- correct: per-bucket uniques
SELECT bucket_ts, region, approx_count FROM active_tenants FINAL;

-- WRONG, and the reason approx_count is named that way
SELECT region, sum(approx_count) FROM active_tenants GROUP BY region;

-- correct historical uniques — the event table, unsampled or sample-aware
SELECT toStartOfDay(ts) AS d, uniq(tenantId)
FROM request_completed WHERE _sample_rate = 1.0 GROUP BY d;
```
