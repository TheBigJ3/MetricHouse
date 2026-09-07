# Level

A level is a quantity that goes up and down and *persists between observations* — in-flight requests, queue depth, active sessions, open connections. It is stored as a **delta per bucket** so N instances sum correctly with no coordination, and read as a running total so a bucket with no activity means "unchanged" rather than "zero".

> Added after [Tollgate](../imagine/tollgate/FINDINGS.md) — flaw 03. A gauge could not express concurrency at all: it has no `inc`/`dec`, and an empty bucket renders as a hole in the chart instead of a held value.

## Main functions

**Declaration**
- `level(name, config)`

Config fields:
- `dims`, `resolution`, `flush`, `grace`, `write` — as [counter](03-counter.md)
- `value` — `int()` (default) or `float()`
- `initial` — the level a never-before-seen series starts at, default `0`
- `totalTtl` — expire a series' running total after this long with no activity, default `'30d'`; refreshed on every `inc`/`dec`, so live series never expire
- `evictAtZero` — drop the total field when the level returns to `initial`, default `false`

**Write**
- `.inc(dims?)` / `.inc(n, dims?)` — raise the level
- `.dec(dims?)` / `.dec(n, dims?)` — lower it
- `.set(value, dims?)` — jump to an absolute value; the driver computes the delta atomically
- `.reset(dims?)` — back to `initial`, emitting the delta that gets it there

**Read**
- `.current(dims?)` — the level right now, from the running total, not from summing buckets
- `.snapshot(opts?)` — per-bucket deltas, unflushed only

## How it is stored

Two things, and the difference matters:

```
{ns}:l:{metric}:total          HASH   dimKey -> current level   (never bucketed, never flushed)
{ns}:l:{metric}:{bucketTs}     HASH   dimKey -> delta           (flushed, then deleted)
```

`current()` reads `total` — one field read, always exact, no history scan. The bucketed deltas are what reach your database, and the level is reconstructed there with a window function.

**The trade-off, stated plainly:** `total` is the only state in MetricHouse with a lifetime longer than a flush. It is not deleted on ack, because deleting it would lose the level.

`totalTtl` (default `'30d'`) is the bound: a series with no `inc`/`dec` for that long is a dead series, not a held value, and its field expires. The TTL refreshes on every write, so anything live is never touched.

`evictAtZero` is the other knob and is **off by default**, because it is usually wrong. A level whose resting state *is* `initial` — a door that is normally closed, a pool that is normally idle — churns the key on every transition. Turn it on only when zero genuinely means "gone".

On the memory driver the total is process-local, so a restart resets every level to `initial`. Use `dumpTotals()` on shutdown and `restoreTotals()` on boot for a long-lived single-process deployment; see [11-driver-memory.md](11-driver-memory.md).

## In use

```ts
// metrics/schema.ts
import { level, str } from 'metrichouse'

export const inFlight = level('in_flight', {
  dims: { tenantId: str(), model: str() },
  resolution: '1s',
  flush: '30s',
  write: async (rows) => ch.insert('in_flight', rows),
})
```

```ts
// no instanceId dim, no local Map, no bookkeeping
export async function handle(req) {
  inFlight.inc({ tenantId: req.tenantId, model: req.model })
  try {
    return await callProvider(req)
  } finally {
    inFlight.dec({ tenantId: req.tenantId, model: req.model })
  }
}

await inFlight.current({ tenantId: 't_42', model: 'claude-opus-5' })
// -> 14        exact, across every instance, regardless of bucket activity
```

Rows handed to `write()` — deltas, not levels:

```ts
[
  { id: 'b71a…', bucket_ts: '14:03:07', tenantId: 't_42', model: '…', delta:  6 },
  { id: '9c40…', bucket_ts: '14:03:08', tenantId: 't_42', model: '…', delta: -2 },
  // 14:03:09 absent — nothing changed, and that is the point
]
```

```sql
-- the level at any point, carry-forward included, in one window function
SELECT bucket_ts,
       sum(sum(delta)) OVER (PARTITION BY tenantId, model ORDER BY bucket_ts) AS level
FROM in_flight FINAL
GROUP BY bucket_ts, tenantId, model;
```

A quiet bucket contributes nothing to the running sum, so the level holds. That is the whole fix.
