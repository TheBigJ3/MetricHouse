---
"metrichouse": minor
---

Fix the drivers.

- A turn to ship now carries a token of its own, so a flush that wrote nothing no longer gives back a turn another flush took in the same millisecond. `takeTurn` answers `{ granted: true, turn, previous }` with `Turn` objects of `{ at, token }`, and `returnTurn(metric, turn, previous)` takes the turn it gives back. A custom driver that implements the two has to follow. The Redis driver reads a turn stored by an earlier version.
- The Redis driver mints claim ids in the process, as the metric and a UUID version 7, instead of from a counter in Redis. A counter that Redis rolled back after losing its latest writes handed out an id still in flight, and settling one claim settled the other. Claims taken under the old ids still recover and settle. `IoredisClient` no longer needs `incr`.
- `claim()` throws on a watermark that is not a finite number in both drivers, instead of storing `NaN` and letting late writes land in windows that already shipped.
- `memory()` copies a record's fields on `append` and hands out copies from `readPending`, `readLevels` and `readLevel`, so editing either one no longer changes what is stored.
- A `memory()` release stopped by a cell of another kind now leaves the claim in flight and the live set unchanged, instead of settling the claim and losing it.
- `memory({ maxSeries, maxStaged })` throws on anything but a positive whole number or `Number.POSITIVE_INFINITY`, instead of treating `NaN` as no cap and `0` as a cap that refuses every write.
- The Redis driver issues every round trip of one call before any call made after it, so a call split by `maxPipelineSize` no longer has another call's writes land between its halves.
- The Redis driver puts a record staged before sequence stamps back ahead of stamped records on release and recovery, the order it reads them in.
- The Redis driver refuses a namespace holding half of a surrogate pair, which Redis would store as the same key as other such namespaces.
- The Redis driver reads back a record field named `__mh_x` that a version before 0.6.0 stored, instead of renaming it `x`.
- Docs: `maxmemory-policy noeviction` is the only safe eviction policy, Redis 4.0 is the minimum version, Redis Cluster is not supported, a large claim backlog blocks Redis while it is claimed, and a refusal is all or nothing per script call of up to 1000 operations.
