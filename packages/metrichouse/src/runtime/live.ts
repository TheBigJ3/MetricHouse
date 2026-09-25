/**
 * Live read — what is still in the driver, shaped for a dashboard.
 *
 * Everything here is **pure**. A driver hands over `BucketRow`s, the metric
 * turns each into the row its sink would receive, and this file does the rest:
 * filter, stamp, collapse, order, cut. Keeping it free of both storage and
 * metric config is what makes the awkward parts — a partial bucket, a rollup
 * that has to merge folds rather than add them — testable without a driver and
 * without a clock.
 *
 * ```
 * readBuckets -> materialize -> filter dims -> stamp -> collapse -> order -> limit
 * ```
 *
 * **The open bucket is partial, and every row says so.** A bucket that has not
 * closed is by definition incomplete: poll a `10s` counter at an arbitrary
 * moment and you read a window that is on average half full. Shown as a count
 * that is ~50% low; shown as a rate it sawtooths at every boundary and looks
 * like a traffic pattern that is not there. So `complete` defaults to `true`
 * and excludes the open bucket outright, and any row that *is* partial carries
 * `bucket_open` and `bucket_elapsed_ms` so extrapolating is a decision made
 * with the numbers rather than an accident.
 */

import type { Row } from '../metrics/types.js'
import { type InferShape, isDate, type Shape, type Simplify } from '../schema/types.js'

/**
 * How to collapse buckets before returning them.
 *
 * `'none'` keeps one row per bucket per series — the shape a chart wants.
 * `'sum'` merges every bucket of a series into one row, dropping `bucket_ts`
 * and `id` with them, because neither survives the merge: the id identifies one
 * bucket's row and there is no longer one bucket.
 *
 * The spec names a third mode, `'window'`, without defining what it collapses.
 * It is left out rather than guessed at — see the note in the README about
 * adding things when something forces them.
 */
export type RollupMode = 'none' | 'sum'

export type Direction = 'asc' | 'desc'

export interface SnapshotOptions {
  /**
   * Partial match on declared dims — `{ park: 'riverside' }` against a metric
   * keyed by three of them. Filtered here rather than in the driver: the key
   * is a cross-product, so only a *leading* subset could be matched as a
   * prefix, and a rule that works for some dims and not others is worse than
   * one that always works.
   */
  readonly dims?: Record<string, unknown>
  /** Lower bound on `bucket_ts`, inclusive. */
  readonly from?: number | Date
  /** Upper bound on `bucket_ts`, exclusive. */
  readonly to?: number | Date
  /**
   * Exclude the bucket still accumulating. **Defaults to `true`** — the
   * correct-but-stale answer, because the alternative silently under-reports.
   */
  readonly complete?: boolean
  /** Default `'none'`. */
  readonly rollup?: RollupMode
  /** Collapse to these declared dims, merging everything else away. */
  readonly groupBy?: readonly string[]
  /** A column to sort on before `limit` applies, so `limit` means top-K. */
  readonly orderBy?: string
  /** Default `'desc'`, which is what makes an unqualified top-K the top. */
  readonly direction?: Direction
  readonly limit?: number
}

/**
 * One live row: the row a sink would receive, plus how finished it is.
 *
 * Not typed as `Row & …` because a rolled-up row has no `id` — it is no longer
 * one bucket's row. Without a rollup or a `groupBy`, every row carries `id` and
 * `bucket_ts` exactly as `write()` would see them, which is what lets a
 * dashboard stitch live rows onto history from the database and know when the
 * two are the same row.
 */
export type LiveRow = Record<string, unknown> & {
  bucket_open: boolean
  bucket_elapsed_ms: number
}

/** What every live row carries on top of the row a sink would receive. */
export type LiveFields = { bucket_open: boolean; bucket_elapsed_ms: number }

/**
 * The identity columns, present only while the row is still one bucket's row.
 *
 * `rollup: 'sum'` merges every bucket of a series, so neither `id` nor
 * `bucket_ts` survives — there is no longer one bucket for them to name. A
 * `groupBy` keeps buckets but may merge series, so `bucket_ts` survives and
 * `id` becomes optional: it is kept when the grouping turned out to be a no-op
 * for that row and dropped otherwise, which is a runtime fact about the data
 * rather than a static one about the options.
 *
 * A caller that widens its options to `SnapshotOptions` before passing them
 * gets the unrolled shape, because at that point the type has nothing left to
 * read. Pass the object literal inline to keep the narrowing.
 */
export type LiveIdentity<O extends SnapshotOptions> = O extends { rollup: 'sum' }
  ? Record<never, never>
  : O extends { groupBy: readonly string[] }
    ? { id?: string; bucket_ts: Date }
    : { id: string; bucket_ts: Date }

/** The dims a row keeps: every declared one, or those `groupBy` named. */
export type LiveDims<D extends Shape, O extends SnapshotOptions> = O extends {
  groupBy: readonly (infer K)[]
}
  ? // bracketed so `groupBy: []`, where K is never, keeps no dims rather than
    // distributing over nothing and making the whole row `never`
    [K] extends [keyof InferShape<D>]
    ? Pick<InferShape<D>, K>
    : InferShape<D>
  : InferShape<D>

/**
 * One live row, typed to the metric that produced it.
 *
 * `D` is the declared dims and `V` the value columns the kind adds — `{ value:
 * number }` for a counter, the folded aggregates for a gauge. The result stays
 * assignable to {@link LiveRow}, which is what lets a concrete kind narrow
 * `AnyMetric.snapshot()` instead of replacing it.
 */
export type LiveRowOf<D extends Shape, V, O extends SnapshotOptions> = Simplify<
  LiveIdentity<O> & LiveDims<D, O> & V & LiveFields
>

/**
 * `snapshot()` as a concrete kind exposes it, narrowed to its own row.
 *
 * The options are a `const` type parameter so an inline `{ rollup: 'sum' }`
 * keeps its literal type and the row shape can depend on it. Without that the
 * option would widen to `RollupMode` and every row would claim an `id` it may
 * not have.
 */
export interface TypedSnapshot<D extends Shape, V> {
  snapshot<const O extends SnapshotOptions = Record<never, never>>(
    options?: O,
  ): Promise<LiveRowOf<D, V, O>[]>
}

/** A materialized row, with the bucket it came from kept alongside. */
export interface BucketedRow {
  readonly bucketTs: number
  readonly row: Row
}

/**
 * Merge the value columns of several rows into one.
 *
 * Kind-specific, because merging is the one thing the two aggregate kinds do
 * differently: a counter adds, a gauge folds `min`/`max`/`sum`/`count` and
 * takes the latest `last`. Rows arrive **in ascending bucket order**, which is
 * what makes `last` answerable at all.
 */
export type MergeValues = (rows: readonly Row[]) => Record<string, unknown>

function asMs(at: number | Date): number {
  return isDate(at) ? at.getTime() : at
}

/**
 * Reject a filter naming a dim the metric does not declare.
 *
 * A typo here is silent otherwise: `{ pakr: 'riverside' }` matches nothing and
 * renders as an empty chart, which reads like an outage.
 */
function assertDimsKnown(
  dims: Shape,
  named: Iterable<string>,
  label: string,
  metric: string,
): void {
  for (const key of named) {
    if (!Object.hasOwn(dims, key)) {
      const declared = Object.keys(dims)
      throw new Error(
        `${metric}: ${label} names ${JSON.stringify(key)}, which is not a declared dim` +
          (declared.length > 0 ? ` — this metric has [${declared.join(', ')}]` : ' — it has none'),
      )
    }
  }
}

/**
 * The bucket range a snapshot should ask the driver for.
 *
 * `complete` and `to` are both upper bounds and both apply: `to` restricts the
 * range, `complete` refuses the partial bucket, and asking for one does not
 * waive the other.
 */
export function snapshotRange(
  options: SnapshotOptions,
  resolutionMs: number,
  nowMs: number,
): { from?: number; to?: number } {
  const openStart = Math.floor(nowMs / resolutionMs) * resolutionMs
  const asked = options.to === undefined ? undefined : asMs(options.to)
  const complete = options.complete ?? true

  const to = complete ? Math.min(asked ?? Number.POSITIVE_INFINITY, openStart) : asked

  return {
    ...(options.from !== undefined && { from: asMs(options.from) }),
    ...(to !== undefined && Number.isFinite(to) && { to }),
  }
}

/** Is this bucket still accumulating, and how far into it are we? */
export function liveness(
  bucketTs: number,
  resolutionMs: number,
  nowMs: number,
): { bucket_open: boolean; bucket_elapsed_ms: number } {
  const elapsed = nowMs - bucketTs
  return {
    bucket_open: elapsed < resolutionMs,
    // a closed bucket is fully elapsed however long ago it ended, and a clock
    // that stepped backwards reads zero rather than negative
    bucket_elapsed_ms: Math.max(0, Math.min(elapsed, resolutionMs)),
  }
}

/**
 * Filter, collapse, order and cut — the whole read path after materialization.
 *
 * @throws if `dims` or `groupBy` names something the metric does not declare
 */
export function applySnapshot(
  rows: readonly BucketedRow[],
  options: SnapshotOptions,
  context: {
    readonly metric: string
    readonly dims: Shape
    readonly resolutionMs: number
    readonly nowMs: number
    readonly mergeValues: MergeValues
  },
): LiveRow[] {
  const { metric, dims, resolutionMs, nowMs, mergeValues } = context

  if (options.dims) assertDimsKnown(dims, Object.keys(options.dims), 'dims', metric)
  if (options.groupBy) assertDimsKnown(dims, options.groupBy, 'groupBy', metric)

  // 1. partial dim match
  const matched = options.dims
    ? rows.filter((one) =>
        Object.entries(options.dims as Record<string, unknown>).every(([key, value]) =>
          sameValue(one.row[key], value),
        ),
      )
    : [...rows]

  // ascending, so a merge can answer "last" and a rollup's window reads
  // forwards — the driver already sorts, and a filter cannot unsort, but
  // nothing downstream should have to know that
  matched.sort((a, b) => a.bucketTs - b.bucketTs)

  const rollup = options.rollup ?? 'none'
  const collapsing = rollup !== 'none' || options.groupBy !== undefined

  const live: LiveRow[] = collapsing
    ? collapse(matched, options, { dims, resolutionMs, nowMs, mergeValues, rollup })
    : matched.map((one) => ({ ...one.row, ...liveness(one.bucketTs, resolutionMs, nowMs) }))

  return orderAndLimit(live, options, metric)
}

/**
 * Merge rows that share a group.
 *
 * The group is the dims being kept, plus the bucket when buckets are being
 * kept. `id` and `bucket_ts` survive only when the group is still one bucket's
 * worth of one series — anything else and they would name a row that no longer
 * exists.
 */
function collapse(
  rows: readonly BucketedRow[],
  options: SnapshotOptions,
  context: {
    readonly dims: Shape
    readonly resolutionMs: number
    readonly nowMs: number
    readonly mergeValues: MergeValues
    readonly rollup: RollupMode
  },
): LiveRow[] {
  const { dims, resolutionMs, nowMs, mergeValues, rollup } = context
  const kept = options.groupBy ?? Object.keys(dims)
  const keepsBuckets = rollup === 'none'
  const keepsEverySeries = kept.length === Object.keys(dims).length

  const groups = new Map<string, BucketedRow[]>()
  for (const one of rows) {
    const key = JSON.stringify([
      keepsBuckets ? one.bucketTs : 0,
      ...kept.map((dim) => one.row[dim]),
    ])
    const group = groups.get(key)
    if (group) group.push(one)
    else groups.set(key, [one])
  }

  const out: LiveRow[] = []
  for (const group of groups.values()) {
    const first = group[0] as BucketedRow
    const merged: LiveRow = {
      // one bucket, one series, merged with nothing: the row is intact and
      // keeps the identity a sink would give it
      ...(keepsBuckets && keepsEverySeries && group.length === 1 ? { id: first.row.id } : {}),
      ...(keepsBuckets ? { bucket_ts: first.row.bucket_ts } : {}),
      ...Object.fromEntries(kept.map((dim) => [dim, first.row[dim]])),
      ...mergeValues(group.map((one) => one.row)),
      // partial if any constituent bucket is, and elapsed across all of them —
      // "of the window this covers, this much has happened"
      bucket_open: false,
      bucket_elapsed_ms: 0,
    }

    // once per bucket, not once per row: three series merged inside one
    // window still cover that one window, and counting its elapsed time three
    // times would make it look three times as long
    const buckets = new Set(group.map((one) => one.bucketTs))
    for (const bucketTs of buckets) {
      const state = liveness(bucketTs, resolutionMs, nowMs)
      if (state.bucket_open) merged.bucket_open = true
      merged.bucket_elapsed_ms += state.bucket_elapsed_ms
    }

    out.push(merged)
  }

  return out
}

/**
 * Check a `limit` before anything is read with it.
 *
 * @throws unless it is a whole number of rows, zero or more
 */
export function assertLimit(limit: unknown, metric: string, label = 'limit'): void {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`${metric}: ${label} must be a non-negative integer, got ${String(limit)}`)
  }
}

/**
 * Sort, then take — in that order, so `limit` means top-K and not "the first K".
 *
 * Exported for the staged kinds, whose rows are records rather than buckets
 * but sort and cut by the same rules.
 */
export function orderAndLimit<R extends Record<string, unknown>>(
  rows: R[],
  options: SnapshotOptions,
  metric: string,
): R[] {
  const { orderBy, limit } = options
  if (limit !== undefined) assertLimit(limit, metric)

  if (orderBy !== undefined) {
    // any row will do, not only the first: a merged gauge row can leave
    // `last` off while its neighbours keep it
    const sample = rows[0]
    if (sample !== undefined && !rows.some((row) => row[orderBy] !== undefined)) {
      throw new Error(
        `${metric}: orderBy names ${JSON.stringify(orderBy)}, which is not a column on these ` +
          `rows — they have [${Object.keys(sample).join(', ')}]`,
      )
    }

    const sign = (options.direction ?? 'desc') === 'desc' ? -1 : 1
    rows.sort((a, b) => {
      // a row without the column goes last whichever way the sort runs, so
      // a top ten is ten rows that have the value being ranked
      const left = a[orderBy]
      const right = b[orderBy]
      if (left === undefined || right === undefined) {
        return left === undefined ? (right === undefined ? 0 : 1) : -1
      }
      return sign * compare(left, right)
    })
  }

  return limit === undefined ? rows : rows.slice(0, limit)
}

/**
 * Does a row's dim equal the value a filter asked for?
 *
 * A `ts()` dim comes back as a fresh `Date`, so `===` against the caller's
 * `Date` is never true. Dates compare by the instant they name.
 */
function sameValue(actual: unknown, wanted: unknown): boolean {
  if (isDate(actual) && isDate(wanted)) return actual.getTime() === wanted.getTime()
  return actual === wanted
}

/** Numbers and dates by value, everything else by its string form. */
function compare(a: unknown, b: unknown): number {
  const left = isDate(a) ? a.getTime() : a
  const right = isDate(b) ? b.getTime() : b

  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right))
}
