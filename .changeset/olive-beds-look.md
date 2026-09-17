---
'metrichouse': minor
---

Add `snapshot()` — the read path, and a kind-erased surface for it.

`current()` answered one number about the open bucket. Everything else still in
the driver — closed buckets not yet flushed and acked, which on a metric with a
long cadence is most of the useful history — was unreachable. `snapshot()` is
that read, and it lands on `AnyMetric` rather than on each kind, because the
write path has had the equivalent abstraction since day one in the four batch
methods and the read path had none.

- **`metric.snapshot(options?)`** — `dims` (partial match), `from` / `to`,
  `complete`, `rollup`, `groupBy`, `orderBy` / `direction`, `limit`.
- **The open bucket is partial, and every row says so.** `bucket_open` and
  `bucket_elapsed_ms` on every live row, and `complete` defaults to `true`, so
  the partial window is excluded unless asked for. Polling a `10s` counter
  mid-window reads ~50% low as a count and sawtooths as a rate; the default is
  correct-but-stale and opting out comes with the numbers to extrapolate from.
- **`house.snapshot(options?)`** across every metric, keyed by name, read in
  parallel; **`house.current()`** for just the open buckets, each metric against
  its own resolution.
- **`AnyMetric` gains `storage`, `snapshot()` and `rowShape()`.** `storage` is
  `'bucketed' | 'staged'` — the distinction the library was already built around,
  said out loud instead of inferred from `kind` against a hardcoded list.
- **A staged kind answers with its unshipped records**, every one
  `bucket_open: false`, because a record is complete the instant it is appended
  and there is no partial window for `complete` to exclude. The aggregate-only
  options are ignored rather than rejected, so one set of them can be handed to a
  mixed schema.
- **Rows keep the identity a sink would give them** — `id` and `bucket_ts`,
  unless a `rollup` or a `groupBy` merged the row that owned them, in which case
  both are dropped rather than left pointing at a row that no longer exists.
- **`bucketedReader()`** is exported beside `bucketedLifecycle()`: a new
  aggregate kind supplies `materialize` and `mergeValues` and inherits filtering,
  rollup, ordering and top-K. The engine in `runtime/live.ts` is pure, so the
  awkward parts are testable without a driver or a clock.

- **Rows are typed to the metric that produced them.** `counter.snapshot()`
  returns `park: string` and `kind: 'solid' | 'liquid'`, not `unknown` per key,
  and the row type depends on the options: `rollup: 'sum'` drops `id` and
  `bucket_ts` from the type because it drops them from the row, and a `groupBy`
  keeps only the dims it named. A log's `level` narrows to its declared levels.
  The erased `AnyMetric.snapshot()` is unchanged — the concrete kinds narrow it,
  which is legal because a typed row is still a `LiveRow`.

`rollup` takes `'none'` and `'sum'`. The spec's third mode, `'window'`, is left
out rather than guessed at — it names a collapse it never defines.

Options are read through a `const` type parameter, so an inline
`{ rollup: 'sum' }` keeps its literal type. A caller that widens its options to
`SnapshotOptions` first gets the unrolled row shape, because at that point the
type has nothing left to read.
