# Collector

The collector is a reference process that does nothing but call `house.flush()` on a schedule while holding a Redis lock, so N app instances never flush the same buckets. It is entirely optional and deliberately boring — it exists only because *something* has to call `flush()`, and most people want that something off their request path.

## Main functions

**Construction**
- `createCollector(config)`

Config fields:
- `house` — the house to flush
- `interval` — how often to call `flush()`, default `'10s'`; per-metric `flush` cadence still governs what actually ships
- `lock` — `{ key, ttl, enabled }`; on by default when the driver reports `capabilities.shared`
- `recoverEvery` — how often to run `house.recover()` for buckets orphaned by a crashed flusher, default `'1m'`
- `onTick(report)` — observe every flush report
- `shutdownGrace` — how long a final forced flush may take on `SIGTERM`, default `'10s'`

**Lifecycle**
- `.start()` — begin ticking; resolves once the first tick completes
- `.stop()` — stop ticking, run one final `flush({ force: true })`, release the lock
- `.tick()` — run one cycle manually, for tests
- `.isLeader()` — whether this process currently holds the lock

**Entry point**
- `npx metrichouse collect` — the same thing, configured from `metrichouse.config.ts`

## The lock

A short-lived Redis lock, renewed on each tick, held for `ttl` (default `2 × interval`). Whoever holds it flushes; everyone else ticks and does nothing. If the holder dies, the lock expires, another instance takes over, and `recover()` reclaims any claim the dead process left in flight — so the worst case is a delayed flush, never a lost or double-counted bucket.

Losing the lock is not an error. It is the normal state for every instance but one.

## In use

```ts
// collector.ts
import { createCollector } from 'metrichouse/collector'
import { house } from './metrics/house'

const collector = createCollector({
  house,
  interval: '10s',
  lock: { key: 'dogwalk:flush', ttl: '20s' },
  recoverEvery: '1m',
  onTick: (report) => {
    if (!report.ok) console.error('[collector]', report.metrics)
  },
})

await collector.start()

process.on('SIGTERM', () => collector.stop())
```

```console
$ node collector.js
  [collector] leader acquired  dogwalk:flush
  [collector] tick  dog_poops skipped (cadence, 3m41s)  walk_started 214 rows
  [collector] tick  dog_poops 300 buckets 812 rows  walk_started 198 rows
```

Three instances, one flusher:

```
instance-a  ── tick ──  isLeader: true   → flush()  → your write()
instance-b  ── tick ──  isLeader: false  → no-op
instance-c  ── tick ──  isLeader: false  → no-op

instance-a dies
instance-b  ── tick ──  lock expired, acquired → recover() → flush()
```

If you would rather not run this, don't. A cron calling `npx metrichouse flush` or a `setInterval` in an existing worker is the same thing with fewer moving parts — the collector just adds the lock and the crash recovery.
