---
'metrichouse': minor
---

Add the `timer` primitive — a gauge of durations.

`timer(name, config)` measures how long something took and folds each duration
into a gauge, so min/max/mean are live-readable and merge across buckets. It
adds no storage model; it owns the start timestamp, the `finally`, and the
monotonic clock.

- **`start(dims?)` returns a handle**; `handle.end(dims?)` records and returns
  milliseconds. Dims unknown at start — a status code — are supplied at the
  end, and may override one bound earlier. The handle is the state, so there
  is no registry to leak and overlapping timings need not nest. `end()` is
  idempotent, because it lives in `catch` and `finally` blocks where a throw
  would replace the error being handled.
- **`time(dims?, fn)`** times a sync or async function and returns what it
  returns. Failures are recorded and rethrown unchanged; invalid dims or an
  unbound timer are rejected before `fn` runs, never after.
- **`observe(ms, dims?)`** records a duration measured elsewhere.
- **`record: 'event_name'`** also records `{ ...dims, duration_ms }` to an event
  for percentiles. The pairing is validated at the first timing, a broken one
  is reported through `onError` while the gauge still records, and the event
  keeps its own sampling — exact aggregate, sampled detail.

Durations come from `performance.now()`, not `Date.now()`, which can step
backwards; the bucket is where the timing completed. `aggregate` defaults to
`min`/`max`/`sum`/`count` — `last` is arbitrary for a duration. `MetricKind`
gains `'timer'`.

`RequiredKeys`, `ShapeArgs` and `MarkOptional` move from `log` into the schema
types and are exported, since both presets need them. `LogFieldsArgs` is now an
alias of `ShapeArgs`, unchanged in behavior.
