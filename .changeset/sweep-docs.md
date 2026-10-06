---
"metrichouse": patch
---

- The `InferRow` and `Turn` types are exported from `metrichouse/core`. `InferRow` is the object a row carries, where `InferShape` is the object a call takes, and the two differ for a key declared with `.default()`.
- Docs: counters, gauges, levels and timers are not exact across isolates on `memory()` with immediate delivery, and the guides that recommended it for serverless now say so.
- Docs: the ClickHouse table that lets a flush row win under immediate delivery is `ReplacingMergeTree(final)`.
- Docs: `inc()` and `dec()` add up in any order only when every write to a series is one of them and none lands past `holdFor`, and the upgrade notes list every level rule 0.7.0 applies differently.
