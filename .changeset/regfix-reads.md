---
"metrichouse": patch
---

Fix the reads.

- A stored series key the current declaration cannot decode, such as text under an `int()` dim, a removed `oneOf` member, a dim removed from the end or a value stored as absent for a dim that is now required, no longer fails the flush of its metric and `snapshot()`. It is reported to `onError` once per process with the metric, the dim, the stored text and the reason, and its rows ship with the stored text as the value of each dim that cannot be read. Other series ship as usual. This holds for a counter, gauge, level and timer. A level still leaves such a series out of its carry and `totals()`.
- A number or a timestamp stored in a dim key is decoded only from the text MetricHouse writes for it, so `0x1F`, `1e3`, ` 7`, `+5` and `007` are no longer read as numbers.
- Docs: a `oneOf` member or a `.default()` added to an optional dim reaches processes still on the old declaration as keys they cannot decode during a rolling deploy, and the dim errors that docs quote start with the metric name.
