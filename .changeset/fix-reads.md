---
"metrichouse": patch
---

- A gauge `totals()` or a merged `sum` across series that passes the largest double throws instead of returning `Infinity`.
- A row's `.default()` dim or field is typed as always present on sink rows and live rows. Call sites still may omit it.
- The published type declarations no longer include the internal `Gauge.openFolds`.
- `snapshot({ orderBy })` throws for a name that is not a column of the metric even when there are no rows, and no longer accepts an inherited property such as `toString`.
- Declaration errors for a `resolution` that does not divide `flush` start with the metric name.
- A wrong-type value passed to a gauge, level or timer is named by its type in the error, and a cell of the wrong kind names the kind the driver returned.
- A counter's `add()` errors for a missing or unknown dim start with the metric name, as do the same errors from a gauge, level and timer.
- An integer counter adds totals across series and windows exactly, and refuses one only when the exact total passes `Number.MAX_SAFE_INTEGER`.
- A stored fraction on an integer metric, left by changing `float()` to `int()`, is reported as not a whole number and no longer as an overflow. Both drivers.
- A stored dim value the current declaration cannot hold, such as text under an `int()` dim, a removed `oneOf` member or a missing value for a required dim, throws `decodeDimKey` naming the dim. A level stops carrying such a series.
