/**
 * Counter — an integer (or float) accumulated per series, per time bucket.
 *
 * The one primitive that genuinely cannot be rebuilt after the fact: once the
 * increments are discarded, no query brings the per-second count back.
 *
 * A declaration is **inert**. `counter()` opens nothing and touches no driver;
 * calling `.add()` before a house has bound it throws rather than silently
 * dropping the write.
 */

import { type Cell, type Driver, isGaugeCell } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { metricFlush } from '../runtime/flush.js'
import type { LiveRowOf, SnapshotOptions } from '../runtime/live.js'
import { shipOpenSeries } from '../runtime/ship.js'
import { assertDimsLegal, decodeDimKey, encodeDimKey } from '../schema/dims.js'
import type { FieldType, InferShape, Shape, Simplify } from '../schema/types.js'
import { assertResolution, bucketStart } from '../time/buckets.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import { bucketedLifecycle, bucketedReader, DEFAULT_GRACE_MS } from './bucketed.js'
import type {
  AnyMetric,
  DimsArgs,
  MetricBinding,
  Row,
  RowShape,
  WriteContext,
  WriteFn,
} from './types.js'

export type { DimsArgs, RowColumn, RowShape } from './types.js'

/** The row shape a counter's `write()` receives. */
export type CounterRow<D extends Shape> = Simplify<
  { id: string; bucket_ts: Date } & InferShape<D> & { value: number }
>

/**
 * One live row from a counter, typed to its dims and to the options asked for.
 *
 * The same columns as {@link CounterRow}, plus `bucket_open` and
 * `bucket_elapsed_ms` — minus whatever a `rollup` or a `groupBy` merged away.
 */
export type CounterLiveRow<
  D extends Shape,
  O extends SnapshotOptions = Record<never, never>,
> = LiveRowOf<D, { value: number }, O>

export interface CounterConfig<D extends Shape> {
  /** Omit entirely for a counter with no dimensions. */
  readonly dims?: D
  /** Bucket width, e.g. `'1s'`. Parsed once, here, never on the write path. */
  readonly resolution: DurationInput
  /**
   * Minimum shipping cadence, e.g. `'5m'`. Must be a whole multiple of
   * `resolution`.
   *
   * Omit it to take `defaults.flush` from the house — cadence is a delivery
   * setting, and a schema shared by a dev branch and a production fleet may
   * have no opinion worth forcing on both.
   */
  readonly flush?: DurationInput
  /** How long past a boundary a late write still lands in the closed bucket. Default `'2s'`. */
  readonly grace?: DurationInput
  /** `int()` (default) or `float()`. Decides whether `.add()` accepts fractions. */
  readonly value?: FieldType<number, false>
  /**
   * Where this counter's rows go. Required: a counter that measures something
   * and ships it nowhere is a misconfiguration, and the only moment it can be
   * caught for free is here.
   *
   * Receives {@link CounterRow}, so each dim in `rows` has the type it was
   * declared with.
   */
  readonly write: WriteFn<CounterRow<D>>
}

// extends AnyMetric so the compiler, not a test, guarantees a counter is
// something a house can register and a flush can materialize
export interface Counter<D extends Shape> extends AnyMetric {
  readonly name: string
  readonly kind: 'counter'
  readonly dims: D

  /** Resolved at declare time — the write path never parses a duration. */
  readonly resolutionMs: number
  readonly flushMs: number
  readonly graceMs: number
  readonly isFloat: boolean

  /**
   * The sink this counter was declared with, receiving typed rows.
   *
   * A method for the reason {@link AnyMetric.write} gives, and for one more:
   * `add` and `current` are methods too, so a `Counter<D>` stays assignable to
   * a counter declared with wider dims. The config is where your function is
   * checked strictly.
   */
  write(rows: CounterRow<D>[], context: WriteContext): Promise<void> | void

  readonly isBound: boolean

  /**
   * Attach a driver. Called by the house; a metric belongs to exactly one, and
   * binding twice throws rather than quietly redirecting writes.
   */
  bind(binding: MetricBinding): void

  // the numeric overload is declared first on purpose: `InferShape<{}>` is
  // `{}`, which accepts a number, so `.add(5)` on a dimensionless counter
  // would otherwise bind 5 as the dims argument
  /** Increment by `delta`, which may be negative. */
  add(delta: number, ...dims: DimsArgs<D>): void
  /** Increment by 1. */
  add(...dims: DimsArgs<D>): void

  /**
   * The live value of the open bucket, before anything has been flushed.
   *
   * With dims, that one series. **Without dims, the metric's total** — every
   * series summed. A counter tracks one thing; its dims are extra information
   * riding along, and asking for `dogs_walked` should not require naming a
   * breed. For a counter that declares no dims the two are the same number.
   *
   * `0` when nothing has been recorded.
   */
  current(dims?: InferShape<D>): Promise<number>

  /**
   * Every unflushed bucket, as typed rows.
   *
   * Narrows {@link AnyMetric.snapshot} to this counter's dims: `park` comes
   * back a `string` rather than an `unknown`, and a `rollup` or `groupBy`
   * changes the row type to match what it actually merged away.
   */
  snapshot<const O extends SnapshotOptions = Record<never, never>>(
    options?: O,
  ): Promise<CounterLiveRow<D, O>[]>

  /**
   * Resolve when every write issued so far has reached the driver.
   *
   * `.add()` returns before the driver has acknowledged anything, so this is
   * the only way to know a write landed — and on a runtime with no `SIGTERM`
   * it is the only write guarantee there is.
   */
  drain(): Promise<void>

  /** The runtime column list a sink will receive, in order. */
  rowShape(): RowShape

  /** Turn one stored cell into the row a sink receives. */
  materialize(bucketTs: number, dimKey: string, cell: Cell): Row
  /** This batch's headline number — every increment in it. */
  totalOf(rows: readonly Row[]): number
}

/**
 * Declare a counter.
 *
 * Validated eagerly, at declare time, because every one of these is a
 * programming error that should surface when the schema file is read rather
 * than at the first write:
 * - the name must be a non-empty string
 * - dims must all be keyable — `json()` is rejected
 * - `resolution` must divide `flush` evenly, or a shipment splits a bucket
 *
 * @throws if the configuration is invalid
 */
export function counter<D extends Shape = Record<never, never>>(
  name: string,
  config: CounterConfig<D>,
): Counter<D> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('counter: name must be a non-empty string')
  }

  const dims = (config.dims ?? {}) as D
  assertDimsLegal(dims, name)

  // parsed once, here — the write path does integer math and never sees a
  // duration string
  const resolutionMs = parseDuration(config.resolution)
  const ownFlushMs = config.flush === undefined ? undefined : parseDuration(config.flush)
  const ownGraceMs = config.grace === undefined ? undefined : parseDuration(config.grace)
  // still eager when the metric declares its own cadence, which is the case
  // that used to be the only one: a bad pair is a programming error and should
  // surface when the schema file is read, not at the first flush
  if (ownFlushMs !== undefined) assertResolution(resolutionMs, ownFlushMs)

  const isFloat = config.value?.kind === 'float'

  // the flush engine and the open series path carry rows of every kind, so
  // they take the sink erased. `materialize` builds each row from the declared
  // dims, and that is what makes the narrower type in the config true
  const sink = config.write as WriteFn

  let binding: MetricBinding | undefined

  /**
   * Writes issued but not yet acknowledged by the driver.
   *
   * A Set with self-removal rather than a growing array: a long-lived server
   * flushes on a schedule but may never call `drain()`, and an array would
   * retain every promise it ever created.
   */
  const pending = new Set<Promise<void>>()

  /** The driver stores whatever a metric wrote; a counter only writes numbers. */
  function asCount(cell: Cell): number {
    if (typeof cell !== 'number') {
      throw new Error(
        `${name}: expected a counter cell but the driver returned a ` +
          `${isGaugeCell(cell) ? 'gauge fold' : 'level'}`,
      )
    }
    return cell
  }

  /**
   * The metric's own cadence, or the house's. Resolved on every read rather
   * than at bind, so nothing has to care which came first.
   */
  function effectiveFlushMs(): number {
    const ms = ownFlushMs ?? binding?.defaults?.flushMs
    if (ms === undefined) {
      throw new Error(
        `${name}: no flush cadence — declare flush on the counter, or defaults.flush on the house`,
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

  /** Applies defaults, validates, and encodes. Throws on a bad dim set. */
  function keyFor(values: InferShape<D> | undefined): string {
    return encodeDimKey(dims, (values ?? {}) as Record<string, unknown>)
  }

  function track(write: Promise<void>, onError: MetricBinding['onError']): void {
    const settled = write
      .catch((error: unknown) => {
        // `.add()` already returned, so this cannot be thrown at the caller.
        // With no handler it surfaces as an unhandled rejection, which is
        // noisy — and better than a write disappearing in silence.
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

  function nowMs(): number {
    return (activeBinding().now ?? Date.now)()
  }

  /**
   * Under `delivery: 'immediate'`, follow the write with a send of the whole
   * open bucket for this series.
   *
   * Chained onto the driver write rather than racing it: the fold has to
   * include the increment that triggered the send, or the sink is told a total
   * that is already stale by one.
   */
  function deliver(write: Promise<void>, bucketTs: number, dimKey: string): Promise<void> {
    if (binding?.delivery !== 'immediate') return write
    return write.then(() => shipOpen(bucketTs, dimKey))
  }

  async function shipOpen(bucketTs: number, dimKey: string): Promise<void> {
    const active = activeBinding()

    await shipOpenSeries({
      metric: name,
      kind: 'counter',
      resolutionMs,
      driver: active.driver,
      bucketTs,
      dimKey,
      materialize,
      totalOf,
      sink,
    })
  }

  function materialize(bucketTs: number, dimKey: string, cell: Cell): Row {
    return {
      id: rowId(name, bucketTs, dimKey),
      bucket_ts: new Date(bucketTs),
      ...decodeDimKey(dims, dimKey),
      value: asCount(cell),
    }
  }

  function totalOf(rows: readonly Row[]): number {
    return rows.reduce((sum, row) => sum + (row.value as number), 0)
  }

  /** Counters merge by adding, across buckets and across series alike. */
  function mergeValues(rows: readonly Row[]): Record<string, unknown> {
    return { value: totalOf(rows) }
  }

  // named, so the flush mixin can reach the finished metric — it is spread
  // into this object while the object is still being built
  const self: Counter<D> = {
    ...bucketedLifecycle({
      name,
      resolutionMs,
      graceMs: effectiveGraceMs,
      driver: activeDriver,
      materialize,
      totalOf,
    }),

    ...bucketedReader<D, { value: number }>({
      name,
      resolutionMs,
      dims,
      driver: activeDriver,
      now: nowMs,
      materialize,
      mergeValues,
    }),

    ...metricFlush({
      name,
      flushMs: effectiveFlushMs,
      sink: () => sink,
      now: nowMs,
      self: () => self,
    }),

    name,
    kind: 'counter',
    storage: 'bucketed',
    dims,
    resolutionMs,

    // getters, because either may come from the house and a metric is declared
    // before it is bound
    get flushMs(): number {
      return effectiveFlushMs()
    },

    get graceMs(): number {
      return effectiveGraceMs()
    },

    isFloat,
    write: config.write,

    get isBound(): boolean {
      return binding !== undefined
    },

    bind(next: MetricBinding): void {
      if (binding) {
        throw new Error(`${name}: already bound to a house — a metric belongs to exactly one`)
      }
      binding = next
      // the half of validation that could not run at declare time: a cadence
      // taken from the house is only knowable now, and createHouse is still
      // early enough to be a boot failure rather than a flush-time surprise
      if (ownFlushMs === undefined) assertResolution(resolutionMs, effectiveFlushMs())
    },

    add(first?: number | InferShape<D>, second?: InferShape<D>): void {
      const active = activeBinding()

      // `.add()`, `.add(dims)`, `.add(delta)` and `.add(delta, dims)` all
      // collapse into one implementation
      const delta = typeof first === 'number' ? first : 1
      const values = (typeof first === 'number' ? second : first) as InferShape<D> | undefined

      if (!Number.isFinite(delta)) {
        throw new Error(`${name}: delta must be a finite number, got ${delta}`)
      }
      if (!isFloat && !Number.isSafeInteger(delta)) {
        throw new Error(
          `${name}: declares an integer counter, so ${delta} is not a legal delta — ` +
            'declare `value: float()` if fractions are intended',
        )
      }

      // validated before the clock is read, so a rejected write never
      // half-commits and never depends on when it was rejected
      const dimKey = keyFor(values)
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const write = active.driver.increment([{ metric: name, bucketTs, dimKey, delta }])
      track(deliver(write, bucketTs, dimKey), active.onError)
    },

    async current(values?: InferShape<D>): Promise<number> {
      const active = activeBinding()
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const rows = await active.driver.readBuckets({
        metric: name,
        from: bucketTs,
        to: bucketTs + resolutionMs,
        // no dims means every series, which summed is the metric's total
        ...(values !== undefined && { dimKey: keyFor(values) }),
      })

      // an unseen series is zero, not absent — a dashboard should render 0
      return rows.reduce((sum, row) => sum + asCount(row.value), 0)
    },

    async drain(): Promise<void> {
      // loops rather than awaiting once: a write issued while we were waiting
      // is still a write issued before drain() resolves
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    },

    materialize,
    totalOf,

    rowShape(): RowShape {
      return {
        columns: [
          { name: 'id', kind: 'str', optional: false },
          { name: 'bucket_ts', kind: 'ts', optional: false },
          ...Object.keys(dims).map((column) => {
            const type = dims[column] as FieldType
            return { name: column, kind: type.kind, optional: type.isOptional }
          }),
          { name: 'value', kind: isFloat ? 'float' : 'int', optional: false },
        ],
      }
    },
  }

  return self
}
