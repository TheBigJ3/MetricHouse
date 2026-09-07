# benchmarks/

Performance harness for the paths where MetricHouse sits in front of a request.

## Why this is level 1

The design puts a network call on the hot path — writes go straight to the
driver with no local buffer. That is a deliberate trade for exact live reads,
and it is only defensible if the overhead is measured and published rather than
asserted.

[Breadcrumb flaw B09](../claude/imagine/breadcrumb/FINDINGS.md) is what happens when it
is not: ~230 ms added to a 300 ms request budget, discovered by reasoning about
it rather than by a number in CI.

## What to measure

**Write path** — the number that goes in the README
- `.add()` overhead, single write vs. pipelined batch
- `httpRedis()` vs. TCP `redis()`
- `writeMode: 'immediate'` vs `'microtask'`
- `memory()` as the floor

**Aggregation**
- `MERGE_GAUGE` Lua vs. naive read-modify-write
- `APPLY_DELTA` under contention from N writers
- dim key encoding at 1, 4, and 8 dimensions

**Flush**
- rows/second through a no-op sink, by `rowBatch`
- claim/ack round trips per flush
- cost of `yieldBetweenBatches` on request latency under load

**Cardinality**
- Redis memory per series, measured against what `metrichouse cost` predicts

That last one matters most: `cost` makes a promise about production, and a
prediction nobody checks is a guess with a table around it.
