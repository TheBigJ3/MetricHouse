---
"metrichouse": minor
---

- `gauge()` and `level()` take `collect`, a function called a little before each window closes with the metric itself, so a value held somewhere else, such as a queue length in your own Redis, is read and written into the window that is closing. `collectLead` says how long before the end of the window, by default one second or a tenth of a shorter resolution, and has to be longer than zero and shorter than the resolution. `collectScope: 'fleet'`, the default, has one process per window run it on a shared driver, by taking a turn under the metric name followed by `:collect`, and `collectScope: 'process'` has every process run it.
- With `house.start()`, a timer per metric calls `collect` at each window's end minus its lead. The timers are unreferenced and cleared by `house.stop()`. Without `start()`, every `flush()` calls it first, at most once per window, and a final flush leaves it to `house.stop()`, which calls it once more and drains what it wrote before the final flush.
- A `collect` that throws or rejects goes to `onError` and never stops a flush. One still running when the next is due makes that one skip. `drain()` and `house.stop()` wait for a `collect` still running and for the writes it makes.
- `CollectOptions` and `CollectScope` are exported as types from `metrichouse/core`.
