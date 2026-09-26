/**
 * Gauge. Point-in-time values, folded per series per bucket into the
 * mergeable set: `last`, `min`, `max`, `sum`, `count`.
 *
 * Average is deliberately **not** stored. It is `sum / count` at query time,
 * and unlike the five stored aggregates it cannot be merged across buckets
 * without lying. The mean of two means is not the mean.
 *
 * **Not a level.** A gauge answers "what values were observed in this bucket".
 * A bucket with no observations is *absent*, which on a chart is a hole rather
 * than a held value. For a quantity that persists between observations, such as
 * queue depth or requests in flight, `level()` is the primitive: it keeps one
 * value per series and carries it into the buckets nobody wrote to.
 */

import { type Cell, type GaugeCell, isGaugeCell } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { metricFlush } from '../runtime/flush.js'
import type { LiveRowOf, SnapshotOptions } from '../runtime/live.js'
import { assertDimsLegal, dimKeyDecoder, dimKeyEncoder } from '../schema/dims.js'
import type { InferShape, Shape, Simplify } from '../schema/types.js'
import { bucketStart } from '../time/buckets.js'
import type { DurationInput } from '../time/duration.js'
import { bucketedBinding, bucketedLifecycle, bucketedReader, seriesKey } from './bucketed.js'
import type {
  AnyMetric,
  DimsArgs,
  MetricBinding,
  MetricKind,
  Row,
  RowColumn,
  RowShape,
  WriteContext,
  WriteFn,
} from './types.js'
import { assertMetricName, assertSink, dimColumns, pendingWrites } from './types.js'

/** The five stored aggregates, in column order. */
export const GAUGE_AGGREGATES = ['last', 'min', 'max', 'sum', 'count'] as const

export type GaugeAggregate = (typeof GAUGE_AGGREGATES)[number]

/**
 * What merging across series can honestly report.
 *
 * `last` is absent on purpose: with several series there is no single latest
 * observation, and inventing one would be the same mistake as storing `avg`.
 */
export type GaugeTotals = Omit<GaugeCell, 'last'>

/** The row shape a gauge's `write()` receives. */
export type GaugeRow<D extends Shape> = Simplify<
  { id: string; bucket_ts: Date } & InferShape<D> & Partial<Record<GaugeAggregate, number>>
>

/**
 * One live row from a gauge.
 *
 * The aggregate columns are `Partial` for the same reason {@link GaugeRow} is:
 * which of the five reach a row is a runtime `aggregate` setting, and a gauge
 * is not generic in it.
 */
export type GaugeLiveRow<
  D extends Shape,
  O extends SnapshotOptions = Record<never, never>,
> = LiveRowOf<D, Partial<Record<GaugeAggregate, number>>, O>

export interface GaugeConfig<D extends Shape> {
  /** Omit entirely for a gauge with no dimensions. */
  readonly dims?: D
  readonly resolution: DurationInput
  /** Minimum shipping cadence. Omit it to take `defaults.flush` from the house. */
  readonly flush?: DurationInput
  /**
   * How long a window waits after it ends before a flush may claim it, so
   * writes stamped inside it have time to reach storage. Default `'2s'`.
   */
  readonly grace?: DurationInput
  /**
   * Which aggregates reach your sink. Defaults to all five.
   *
   * All five are always folded. The saving is columns written, not work done,
   * and keeping the fold complete means widening this later needs no
   * migration of what is already in flight.
   */
  readonly aggregate?: readonly GaugeAggregate[]
  /**
   * Where this gauge's rows go. Required. See the counter for why.
   *
   * Receives {@link GaugeRow}: dims typed, aggregates `Partial` for the same
   * reason the row type gives.
   */
  readonly write: WriteFn<GaugeRow<D>>
}

/**
 * `K` is the kind this metric reports to a sink. It is a parameter, not the
 * constant `'gauge'`, for the same reason {@link stagedMetric} takes one: a
 * `timer` is a gauge of durations and must still say `'timer'` in a
 * {@link WriteContext}.
 *
 * The claim path reads `kind` off whatever object the flush engine was handed,
 * so a wrapper's own `kind` is enough there. Immediate delivery has no such
 * indirection, because the gauge ships itself from inside, so the kind has to be
 * something it knows.
 */
export interface Gauge<D extends Shape, K extends MetricKind = 'gauge'> extends AnyMetric {
  /** @internal The shared read path behind `current` and `totals`. */
  openFolds(dims?: InferShape<D>): Promise<GaugeCell[]>
  readonly name: string
  readonly kind: K
  readonly dims: D
  readonly resolutionMs: number
  readonly flushMs: number
  readonly graceMs: number
  readonly aggregate: readonly GaugeAggregate[]
  /** The sink this gauge was declared with. A method, as on the counter. */
  write(rows: GaugeRow<D>[], context: WriteContext): Promise<void> | void
  readonly isBound: boolean

  bind(binding: MetricBinding): void

  /** Record one observation into the current bucket. */
  set(value: number, ...dims: DimsArgs<D>): void

  /**
   * The open bucket's fold for one series, or `undefined` if nothing has been
   * observed.
   *
   * `undefined` rather than a zeroed cell: a `min` of 0 for a gauge nobody has
   * written to is a lie, and a chart should show a gap.
   */
  current(...dims: DimsArgs<D>): Promise<GaugeCell | undefined>

  /**
   * Every unflushed bucket of folds, as typed rows.
   *
   * A `rollup` merges the folds the way the five aggregates merge: `sum` and
   * `count` add, `min` and `max` take the extreme, `last` is the latest in
   * bucket order.
   */
  snapshot<const O extends SnapshotOptions = Record<never, never>>(
    options?: O,
  ): Promise<GaugeLiveRow<D, O>[]>

  /**
   * Every series in the open bucket, merged, the gauge equivalent of a
   * counter's total.
   *
   * Returns {@link GaugeTotals}, which has no `last`: with several series
   * there is no single latest observation, and inventing one would be the same
   * mistake as storing `avg`.
   */
  totals(): Promise<GaugeTotals | undefined>

  drain(): Promise<void>
  rowShape(): RowShape

  /** Turn one stored fold into the row a sink receives. */
  materialize(bucketTs: number, dimKey: string, cell: Cell): Row
  /** This batch's headline number, every observed value in it. */
  totalOf(rows: readonly Row[]): number
}

/**
 * Declare a gauge.
 *
 * @throws if the configuration is invalid. See `counter()` for the same
 * declare-time checks on name, dims and resolution.
 */
export function gauge<D extends Shape = Record<never, never>, K extends MetricKind = 'gauge'>(
  name: string,
  config: GaugeConfig<D>,
  kind: K = 'gauge' as K,
): Gauge<D, K> {
  assertMetricName(name, 'gauge')
  assertSink(config.write, name)

  const dims = (config.dims ?? {}) as D

  // erased for the engine, which carries rows of every kind. See the counter
  const sink = config.write as WriteFn

  const slot = bucketedBinding({
    name,
    kind,
    resolution: config.resolution,
    flush: config.flush,
    grace: config.grace,
    materialize,
    totalOf,
    sink,
  })
  const { resolutionMs } = slot

  const aggregate = config.aggregate ?? GAUGE_AGGREGATES
  if (aggregate.length === 0) {
    throw new Error(`${name}: aggregate must name at least one of ${GAUGE_AGGREGATES.join(', ')}`)
  }
  for (const column of aggregate) {
    if (!GAUGE_AGGREGATES.includes(column)) {
      throw new Error(`${name}: unknown aggregate ${JSON.stringify(column)}`)
    }
  }
  if (new Set(aggregate).size !== aggregate.length) {
    throw new Error(
      `${name}: aggregate names ${JSON.stringify(aggregate)}, and each one may appear once, ` +
        'because each becomes one column of the row',
    )
  }
  // after the aggregates, because the ones declared are columns of every row
  // and a dim may take none of them
  assertDimsLegal(dims, name, ['id', 'bucket_ts', ...aggregate])

  const writes = pendingWrites(name)

  function asFold(cell: Cell): GaugeCell {
    if (!isGaugeCell(cell)) {
      throw new Error(`${name}: expected a gauge fold but the driver returned a counter cell`)
    }
    return cell
  }

  // built once, here: every write encodes a key and every row a flush or a
  // snapshot builds decodes one, against a declaration that never changes
  const encodeKey = dimKeyEncoder(dims)
  const decodeKey = dimKeyDecoder(dims)

  function keyFor(values: InferShape<D> | undefined): string {
    return encodeKey((values ?? {}) as Record<string, unknown>)
  }

  /**
   * The fold's `sum` for each row this metric built, whether or not `sum` is
   * one of its columns.
   *
   * A sink is told every observed value added up as the batch total, and a
   * gauge that ships only `min` and `max` still observed values. Weak, so a
   * row a sink has let go of takes its entry with it.
   */
  const sums = new WeakMap<Row, number>()

  function materialize(bucketTs: number, dimKey: string, cell: Cell): Row {
    const fold = asFold(cell)
    const row: Row = {
      id: rowId(name, bucketTs, dimKey),
      bucket_ts: new Date(bucketTs),
      ...decodeKey(dimKey),
    }
    // only the declared aggregates become columns
    for (const column of aggregate) row[column] = fold[column]
    sums.set(row, fold.sum)
    return row
  }

  function totalOf(rows: readonly Row[]): number {
    // every observed value added up, which is `sum` per series
    return rows.reduce((total, row) => {
      const sum = sums.get(row) ?? row.sum
      return total + (typeof sum === 'number' ? sum : 0)
    }, 0)
  }

  /**
   * Merge folds the way the five aggregates merge, which is the reason those
   * five and not `avg`: `sum` and `count` add, `min` and `max` take the
   * extreme, and `last` is the latest, answerable only because rows arrive in
   * ascending bucket order.
   *
   * Merging across *series* takes the same path, and `last` is the one column
   * it cannot always answer: inside one window, a fold does not record which
   * series was observed most recently. So `last` is kept when one series holds
   * the newest window in the group, and left off the row when several do,
   * which is the same reason `totals()` has no `last`.
   */
  function mergeValues(rows: readonly Row[]): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    const numbers = (column: GaugeAggregate): number[] =>
      rows.map((row) => row[column]).filter((value): value is number => typeof value === 'number')

    for (const column of aggregate) {
      switch (column) {
        case 'last': {
          const newest = lastOf(rows)
          if (newest !== undefined) merged.last = newest
          break
        }
        case 'min':
          // a loop and not Math.min(...values): a spread of a hundred thousand
          // rows is a hundred thousand arguments, which overflows the stack
          merged.min = numbers('min').reduce((low, value) => Math.min(low, value), Infinity)
          break
        case 'max':
          merged.max = numbers('max').reduce((high, value) => Math.max(high, value), -Infinity)
          break
        case 'sum':
          merged.sum = totalOf(rows)
          break
        case 'count':
          merged.count = numbers('count').reduce((total, value) => total + value, 0)
          break
      }
    }
    return merged
  }

  /** `last` of the newest window, if only one series holds that window. */
  function lastOf(rows: readonly Row[]): number | undefined {
    const newest = rows.at(-1)
    if (newest === undefined) return undefined
    const newestAt = (newest.bucket_ts as Date).getTime()
    const dimNames = Object.keys(dims)
    const series = new Set<string>()
    for (const row of rows) {
      if ((row.bucket_ts as Date).getTime() !== newestAt) continue
      series.add(seriesKey(dimNames, row))
    }
    return series.size === 1 ? (newest.last as number | undefined) : undefined
  }

  // named, so the flush mixin can reach the finished metric. See the counter
  const self: Gauge<D, K> = {
    ...bucketedLifecycle({
      name,
      resolutionMs,
      graceMs: slot.graceMs,
      driver: slot.driver,
      materialize,
      totalOf,
    }),

    ...bucketedReader<D, Partial<Record<GaugeAggregate, number>>>({
      name,
      resolutionMs,
      dims,
      driver: slot.driver,
      now: slot.now,
      materialize,
      mergeValues,
      assertCell: asFold,
    }),

    ...metricFlush({
      name,
      flushMs: slot.flushMs,
      sink: () => sink,
      now: slot.now,
      self: () => self,
      attempts: slot.attempts,
      sharedDriver: slot.driver,
    }),

    name,
    kind,
    storage: 'bucketed',
    dims,
    resolutionMs,

    get flushMs(): number {
      return slot.flushMs()
    },

    get graceMs(): number {
      return slot.graceMs()
    },

    aggregate,
    write: config.write,

    get isBound(): boolean {
      return slot.isBound()
    },

    bind: slot.bind,
    unbind: slot.unbind,

    set(value: number, ...args: DimsArgs<D>): void {
      const active = slot.active()

      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${name}: an observation must be a finite number, got ${String(value)}`)
      }

      const dimKey = keyFor(args[0])
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const write = active.driver.observe([{ metric: name, bucketTs, dimKey, value }])
      writes.track(slot.deliver(write, bucketTs, dimKey), () => active.onError)
    },

    async openFolds(values?: InferShape<D>): Promise<GaugeCell[]> {
      const active = slot.active()
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const rows = await active.driver.readBuckets({
        metric: name,
        from: bucketTs,
        to: bucketTs + resolutionMs,
        ...(values !== undefined && { dimKey: keyFor(values) }),
      })
      return rows.map((row) => asFold(row.value))
    },

    // through `self` rather than `this`, so `setInterval(temp.totals)` works
    // on a method passed around on its own
    async current(...args: DimsArgs<D>): Promise<GaugeCell | undefined> {
      const folds = await self.openFolds(args[0] ?? ({} as InferShape<D>))
      return folds[0]
    },

    async totals(): Promise<GaugeTotals | undefined> {
      const folds = await self.openFolds()
      if (folds.length === 0) return undefined

      return {
        // a loop and not Math.min(...folds): one argument per series
        // overflows the stack somewhere past a hundred thousand of them
        min: folds.reduce((low, fold) => Math.min(low, fold.min), Infinity),
        max: folds.reduce((high, fold) => Math.max(high, fold.max), -Infinity),
        sum: folds.reduce((total, fold) => total + fold.sum, 0),
        count: folds.reduce((total, fold) => total + fold.count, 0),
      }
    },

    drain(): Promise<void> {
      return writes.drain()
    },

    materialize,
    totalOf,

    rowShape(): RowShape {
      const columns: RowColumn[] = [
        { name: 'id', kind: 'str', optional: false },
        { name: 'bucket_ts', kind: 'ts', optional: false },
        ...dimColumns(dims),
        // count is a whole number of observations; the rest are values
        ...aggregate.map((column) => ({
          name: column,
          kind: column === 'count' ? ('int' as const) : ('float' as const),
          optional: false,
        })),
      ]
      return { columns }
    },
  }

  return self
}
