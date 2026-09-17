/**
 * Gauge — point-in-time values, folded per series per bucket into the
 * mergeable set: `last`, `min`, `max`, `sum`, `count`.
 *
 * Average is deliberately **not** stored. It is `sum / count` at query time,
 * and unlike the five stored aggregates it cannot be merged across buckets
 * without lying — the mean of two means is not the mean.
 *
 * **Not a level.** A gauge answers "what values were observed in this bucket".
 * A bucket with no observations is *absent*, which on a chart is a hole rather
 * than a held value. For a quantity that persists between observations — queue
 * depth, in-flight requests — use `level()`.
 *
 * Spec: initialPlan/04-gauge.md
 */

import { type Cell, type Driver, type GaugeCell, isGaugeCell } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { shipOpenSeries } from '../runtime/ship.js'
import { assertDimsLegal, decodeDimKey, encodeDimKey } from '../schema/dims.js'
import type { InferShape, Shape, Simplify } from '../schema/types.js'
import { assertResolution, bucketStart } from '../time/buckets.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import { bucketedLifecycle, DEFAULT_GRACE_MS } from './bucketed.js'
import type {
  AnyMetric,
  DimsArgs,
  MetricBinding,
  MetricKind,
  Row,
  RowColumn,
  RowShape,
  WriteFn,
} from './types.js'

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

export interface GaugeConfig<D extends Shape> {
  /** Omit entirely for a gauge with no dimensions. */
  readonly dims?: D
  readonly resolution: DurationInput
  /** Minimum shipping cadence. Omit it to take `defaults.flush` from the house. */
  readonly flush?: DurationInput
  /** How long past a boundary a late write still lands in the closed bucket. Default `'2s'`. */
  readonly grace?: DurationInput
  /**
   * Which aggregates reach your sink. Defaults to all five.
   *
   * All five are always folded — the saving is columns written, not work done,
   * and keeping the fold complete means widening this later needs no
   * migration of what is already in flight.
   */
  readonly aggregate?: readonly GaugeAggregate[]
  /** This gauge's sink. Falls back to the house's `write` when omitted. */
  readonly write?: WriteFn
}

/**
 * `K` is the kind this metric reports to a sink. It is a parameter, not the
 * constant `'gauge'`, for the same reason {@link stagedMetric} takes one: a
 * `timer` is a gauge of durations and must still say `'timer'` in a
 * {@link WriteContext}.
 *
 * The claim path reads `kind` off whatever object the flush engine was handed,
 * so a wrapper's own `kind` is enough there. Immediate delivery has no such
 * indirection — the gauge ships itself, from inside — so the kind has to be
 * something it knows.
 */
export interface Gauge<D extends Shape, K extends MetricKind = 'gauge'> extends AnyMetric {
  /** @internal — shared read path behind `current` and `totals`. */
  openFolds(dims?: InferShape<D>): Promise<GaugeCell[]>
  readonly name: string
  readonly kind: K
  readonly dims: D
  readonly resolutionMs: number
  readonly flushMs: number
  readonly graceMs: number
  readonly aggregate: readonly GaugeAggregate[]
  readonly write: WriteFn | undefined
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
   * Every series in the open bucket, merged — the gauge equivalent of a
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
  /** This batch's headline number — every observed value in it. */
  totalOf(rows: readonly Row[]): number
}

/**
 * Declare a gauge.
 *
 * @throws if the configuration is invalid — see `counter()` for the same
 * declare-time checks on name, dims and resolution.
 */
export function gauge<D extends Shape = Record<never, never>, K extends MetricKind = 'gauge'>(
  name: string,
  config: GaugeConfig<D>,
  kind: K = 'gauge' as K,
): Gauge<D, K> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('gauge: name must be a non-empty string')
  }

  const dims = (config.dims ?? {}) as D
  assertDimsLegal(dims, name)

  const resolutionMs = parseDuration(config.resolution)
  const ownFlushMs = config.flush === undefined ? undefined : parseDuration(config.flush)
  const ownGraceMs = config.grace === undefined ? undefined : parseDuration(config.grace)
  if (ownFlushMs !== undefined) assertResolution(resolutionMs, ownFlushMs)

  const aggregate = config.aggregate ?? GAUGE_AGGREGATES
  if (aggregate.length === 0) {
    throw new Error(`${name}: aggregate must name at least one of ${GAUGE_AGGREGATES.join(', ')}`)
  }
  for (const column of aggregate) {
    if (!GAUGE_AGGREGATES.includes(column)) {
      throw new Error(`${name}: unknown aggregate ${JSON.stringify(column)}`)
    }
  }

  let binding: MetricBinding | undefined
  const pending = new Set<Promise<void>>()

  function asFold(cell: Cell): GaugeCell {
    if (!isGaugeCell(cell)) {
      throw new Error(`${name}: expected a gauge fold but the driver returned a counter cell`)
    }
    return cell
  }

  /** The metric's own cadence, or the house's. See the counter for the rule. */
  function effectiveFlushMs(): number {
    const ms = ownFlushMs ?? binding?.defaults?.flushMs
    if (ms === undefined) {
      throw new Error(
        `${name}: no flush cadence — declare flush on the gauge, or defaults.flush on the house`,
      )
    }
    return ms
  }

  function effectiveGraceMs(): number {
    return ownGraceMs ?? binding?.defaults?.graceMs ?? DEFAULT_GRACE_MS
  }

  function activeBinding(): MetricBinding {
    if (!binding) {
      throw new Error(
        `${name}: not bound to a house — pass it to createHouse({ schema }) before writing`,
      )
    }
    return binding
  }

  function keyFor(values: InferShape<D> | undefined): string {
    return encodeDimKey(dims, (values ?? {}) as Record<string, unknown>)
  }

  /**
   * Under `delivery: 'immediate'`, follow the observation with a send of the
   * whole open fold for this series — `min` and `max` are only right once the
   * driver has merged the value that triggered the send.
   */
  function deliver(write: Promise<void>, bucketTs: number, dimKey: string): Promise<void> {
    if (binding?.delivery !== 'immediate') return write
    return write.then(() => shipOpen(bucketTs, dimKey))
  }

  async function shipOpen(bucketTs: number, dimKey: string): Promise<void> {
    const active = activeBinding()
    const sink = config.write ?? active.write
    if (!sink) {
      throw new Error(
        `${name}: delivery is 'immediate', so this gauge ships without waiting for flush() — ` +
          'it needs a write() declared on the metric or on createHouse',
      )
    }

    await shipOpenSeries({
      metric: name,
      kind,
      resolutionMs,
      driver: active.driver,
      bucketTs,
      dimKey,
      materialize,
      totalOf,
      sink,
    })
  }

  function track(write: Promise<void>, onError: MetricBinding['onError']): void {
    const settled = write
      .catch((error: unknown) => {
        if (!onError) throw error
        onError(error, { metric: name })
      })
      .finally(() => {
        pending.delete(settled)
      })
    pending.add(settled)
  }

  function activeDriver(): Driver {
    return activeBinding().driver
  }

  function materialize(bucketTs: number, dimKey: string, cell: Cell): Row {
    const fold = asFold(cell)
    const row: Row = {
      id: rowId(name, bucketTs, dimKey),
      bucket_ts: new Date(bucketTs),
      ...decodeDimKey(dims, dimKey),
    }
    // only the declared aggregates become columns
    for (const column of aggregate) row[column] = fold[column]
    return row
  }

  function totalOf(rows: readonly Row[]): number {
    // every observed value added up — `sum` is exactly that, per series
    return rows.reduce((total, row) => total + (typeof row.sum === 'number' ? row.sum : 0), 0)
  }

  return {
    ...bucketedLifecycle({
      name,
      resolutionMs,
      graceMs: effectiveGraceMs,
      driver: activeDriver,
      materialize,
      totalOf,
    }),

    name,
    kind,
    dims,
    resolutionMs,

    get flushMs(): number {
      return effectiveFlushMs()
    },

    get graceMs(): number {
      return effectiveGraceMs()
    },

    aggregate,
    write: config.write,

    get isBound(): boolean {
      return binding !== undefined
    },

    bind(next: MetricBinding): void {
      if (binding) {
        throw new Error(`${name}: already bound to a house — a metric belongs to exactly one`)
      }
      binding = next
      if (ownFlushMs === undefined) assertResolution(resolutionMs, effectiveFlushMs())
    },

    set(value: number, ...args: DimsArgs<D>): void {
      const active = activeBinding()

      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${name}: an observation must be a finite number, got ${String(value)}`)
      }

      const dimKey = keyFor(args[0])
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const write = active.driver.observe([{ metric: name, bucketTs, dimKey, value }])
      track(deliver(write, bucketTs, dimKey), active.onError)
    },

    async openFolds(values?: InferShape<D>): Promise<GaugeCell[]> {
      const active = activeBinding()
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const rows = await active.driver.readBuckets({
        metric: name,
        from: bucketTs,
        to: bucketTs + resolutionMs,
        ...(values !== undefined && { dimKey: keyFor(values) }),
      })
      return rows.map((row) => asFold(row.value))
    },

    async current(...args: DimsArgs<D>): Promise<GaugeCell | undefined> {
      const folds = await this.openFolds(args[0] ?? ({} as InferShape<D>))
      return folds[0]
    },

    async totals(): Promise<GaugeTotals | undefined> {
      const folds = await this.openFolds()
      if (folds.length === 0) return undefined

      return {
        min: Math.min(...folds.map((fold) => fold.min)),
        max: Math.max(...folds.map((fold) => fold.max)),
        sum: folds.reduce((total, fold) => total + fold.sum, 0),
        count: folds.reduce((total, fold) => total + fold.count, 0),
      }
    },

    async drain(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    },

    materialize,
    totalOf,

    rowShape(): RowShape {
      const columns: RowColumn[] = [
        { name: 'id', kind: 'str', optional: false },
        { name: 'bucket_ts', kind: 'ts', optional: false },
        ...Object.keys(dims).map((column) => {
          const type = dims[column]
          return {
            name: column,
            kind: type?.kind ?? 'str',
            optional: type?.isOptional ?? false,
          }
        }),
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
}
