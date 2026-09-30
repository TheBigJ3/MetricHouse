/**
 * Counter. An integer (or float) accumulated per series, per time bucket.
 *
 * The one primitive that genuinely cannot be rebuilt after the fact: once the
 * increments are discarded, no query brings the per-second count back.
 *
 * A declaration is **inert**. `counter()` opens nothing and touches no driver;
 * calling `.add()` before a house has bound it throws rather than silently
 * dropping the write.
 */

import { type Cell, isGaugeCell } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { metricFlush } from '../runtime/flush.js'
import { type LiveRowOf, liveColumns, type SnapshotOptions } from '../runtime/live.js'
import { assertDimsLegal, dimKeyDecoder, dimKeyEncoder } from '../schema/dims.js'
import type { FieldType, InferRow, InferShape, Shape, Simplify } from '../schema/types.js'
import { bucketStart } from '../time/buckets.js'
import type { DurationInput } from '../time/duration.js'
import { bucketedBinding, bucketedLifecycle, bucketedReader } from './bucketed.js'
import type {
  AnyMetric,
  DimsArgs,
  MetricBinding,
  Row,
  RowShape,
  WriteContext,
  WriteFn,
} from './types.js'
import {
  assertDeltaOrDims,
  assertMetricName,
  assertSink,
  assertWhole,
  dimColumns,
  pendingWrites,
  SETTLE_WRITES,
} from './types.js'

/** The columns a counter writes on every row itself, which no dim may take. */
const COUNTER_COLUMNS = ['id', 'bucket_ts', 'value'] as const

export type { DimsArgs, RowColumn, RowShape } from './types.js'

/** The row shape a counter's `write()` receives. */
export type CounterRow<D extends Shape> = Simplify<
  { id: string; bucket_ts: Date } & InferRow<D> & { value: number }
>

/**
 * One live row from a counter, typed to its dims and to the options asked for.
 *
 * The same columns as {@link CounterRow}, plus `bucket_open` and
 * `bucket_elapsed_ms`, minus whatever a `rollup` or a `groupBy` merged away.
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
   * Omit it to take `defaults.flush` from the house. Cadence is a delivery
   * setting, and a schema shared by a dev branch and a production fleet may
   * have no opinion worth forcing on both.
   */
  readonly flush?: DurationInput
  /**
   * How long a window waits after it ends before a flush may claim it, so
   * writes stamped inside it have time to reach storage. Default `'2s'`.
   */
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

  /** Resolved at declare time, so the write path never parses a duration. */
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
   * With dims, that one series. **Without dims, the metric's total**, every
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
   * the only way to know a write landed, and on a runtime with no `SIGTERM`
   * it is the only write guarantee there is.
   */
  drain(): Promise<void>

  /** The runtime column list a sink will receive, in order. */
  rowShape(): RowShape

  /** Turn one stored cell into the row a sink receives. */
  materialize(bucketTs: number, dimKey: string, cell: Cell): Row
  /** This batch's headline number, every increment in it. */
  totalOf(rows: readonly Row[]): number
}

/**
 * Declare a counter.
 *
 * Validated eagerly, at declare time, because every one of these is a
 * programming error that should surface when the schema file is read rather
 * than at the first write:
 * - the name must be a non-empty string
 * - dims must all be keyable, so `json()` is rejected
 * - `resolution` must divide `flush` evenly, or a shipment splits a bucket
 *
 * @throws if the configuration is invalid
 */
export function counter<D extends Shape = Record<never, never>>(
  name: string,
  config: CounterConfig<D>,
): Counter<D> {
  assertMetricName(name, 'counter')
  assertSink(config.write, name)

  const dims = (config.dims ?? {}) as D
  assertDimsLegal(dims, name, COUNTER_COLUMNS)

  // the flush engine and the open series path carry rows of every kind, so
  // they take the sink erased. `materialize` builds each row from the declared
  // dims, and that is what makes the narrower type in the config true
  const sink = config.write as WriteFn

  const slot = bucketedBinding({
    name,
    kind: 'counter',
    resolution: config.resolution,
    flush: config.flush,
    grace: config.grace,
    materialize,
    totalOf,
    sink,
  })
  const { resolutionMs } = slot

  const isFloat = config.value?.kind === 'float'

  /** Writes issued but not yet acknowledged by the driver. */
  const writes = pendingWrites(name)

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

  // built once, here: every write encodes a key and every row a flush or a
  // snapshot builds decodes one, against a declaration that never changes
  const encodeKey = dimKeyEncoder(dims, name)
  const decodeKey = dimKeyDecoder(dims)

  /** Applies defaults, validates, and encodes. Throws on a bad dim set. */
  function keyFor(values: InferShape<D> | undefined): string {
    return encodeKey((values ?? {}) as Record<string, unknown>)
  }

  function materialize(bucketTs: number, dimKey: string, cell: Cell): Row {
    return {
      id: rowId(name, bucketTs, dimKey),
      bucket_ts: new Date(bucketTs),
      ...decodeKey(dimKey),
      value: asCount(cell),
    }
  }

  function totalOf(rows: readonly Row[]): number {
    return rows.reduce((sum, row) => sum + (row.value as number), 0)
  }

  /**
   * The sum of the values a live read merges, for an integer counter refused
   * when a double cannot hold it exactly.
   *
   * Each series is kept below `Number.MAX_SAFE_INTEGER` by the driver, but
   * several of them added together can pass it, and the answer would be a
   * different whole number with nothing to say so. Whole numbers are added as
   * BigInts, so a running sum that passes the limit and comes back is judged
   * by its exact total and not by where the doubles rounded on the way.
   *
   * A stored fraction, which a series holds after a `float()` counter was
   * declared as an integer one, cannot be a BigInt. Those are added as doubles
   * and refused when the total is not a whole number.
   */
  function exactSum(values: readonly number[], what: string): number {
    if (isFloat) return values.reduce((sum, value) => sum + value, 0)

    if (values.every(Number.isInteger)) {
      let exact = 0n
      for (const value of values) exact += BigInt(value)
      if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          `${name}: ${what} would be ${exact}, which is past ${Number.MAX_SAFE_INTEGER}, the ` +
            'largest whole number a double holds exactly',
        )
      }
      return Number(exact)
    }

    const total = values.reduce((sum, value) => sum + value, 0)
    if (!Number.isInteger(total)) {
      throw new Error(
        `${name}: ${what} would be ${total}, which is not a whole number. A stored value is a ` +
          'fraction, which happens when a float counter is declared as an integer one',
      )
    }
    if (!Number.isSafeInteger(total)) {
      throw new Error(
        `${name}: ${what} would be ${total}, which is past ${Number.MAX_SAFE_INTEGER}, the ` +
          'largest whole number a double holds exactly',
      )
    }
    return total
  }

  /** Counters merge by adding, across buckets and across series alike. */
  function mergeValues(rows: readonly Row[]): Record<string, unknown> {
    return {
      value: exactSum(
        rows.map((row) => row.value as number),
        'a merged value',
      ),
    }
  }

  // named, so the flush mixin can reach the finished metric. It is spread
  // into this object while the object is still being built
  const self: Counter<D> = {
    ...bucketedLifecycle({
      name,
      resolutionMs,
      graceMs: slot.graceMs,
      driver: slot.driver,
      materialize,
      totalOf,
      sendsSoFar: slot.sendsSoFar,
    }),

    ...bucketedReader<D, { value: number }>({
      name,
      resolutionMs,
      dims,
      driver: slot.driver,
      now: slot.now,
      materialize,
      mergeValues,
      columns: () => liveColumns(self.rowShape()),
      assertCell: asCount,
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
    kind: 'counter',
    storage: 'bucketed',
    dims,
    resolutionMs,

    // getters, because either may come from the house and a metric is declared
    // before it is bound
    get flushMs(): number {
      return slot.flushMs()
    },

    get graceMs(): number {
      return slot.graceMs()
    },

    isFloat,
    write: config.write,

    get isBound(): boolean {
      return slot.isBound()
    },

    bind: slot.bind,
    unbind: slot.unbind,

    add(first?: number | InferShape<D>, second?: InferShape<D>): void {
      const active = slot.active()

      // `.add()`, `.add(dims)`, `.add(delta)` and `.add(delta, dims)` all
      // collapse into one implementation
      assertDeltaOrDims(name, first)
      const delta = typeof first === 'number' ? first : 1
      const values = (typeof first === 'number' ? second : first) as InferShape<D> | undefined

      if (!Number.isFinite(delta)) {
        throw new Error(`${name}: delta must be a finite number, got ${delta}`)
      }
      if (!isFloat) assertWhole(name, 'counter', delta, 'delta')

      // validated before the clock is read, so a rejected write never
      // half-commits and never depends on when it was rejected
      const dimKey = keyFor(values)
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      const write = active.driver.increment([
        { metric: name, bucketTs, dimKey, delta, ...(!isFloat && { integer: true }) },
      ])
      writes.track(slot.deliver(write, bucketTs, dimKey), () => active.onError)
    },

    async current(values?: InferShape<D>): Promise<number> {
      const active = slot.active()
      const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

      // the whole metric's total, added up in storage rather than by reading
      // every series. Only for whole numbers, and only when the driver says
      // the sum is exact: then it is the number adding the rows below gives,
      // and it is always one a double holds exactly. A float counter always
      // reads the rows, because the order fractions are added in changes the
      // last bits of their sum
      if (values === undefined && !isFloat && active.driver.sumBuckets) {
        const total = await active.driver.sumBuckets({
          metric: name,
          from: bucketTs,
          to: bucketTs + resolutionMs,
        })
        if (total !== undefined) return total
      }

      const rows = await active.driver.readBuckets({
        metric: name,
        from: bucketTs,
        to: bucketTs + resolutionMs,
        // no dims means every series, which summed is the metric's total
        ...(values !== undefined && { dimKey: keyFor(values) }),
      })

      // an unseen series is zero, not absent, so a dashboard renders 0
      return exactSum(
        rows.map((row) => asCount(row.value)),
        'the total across series',
      )
    },

    drain(): Promise<void> {
      return writes.drain()
    },

    [SETTLE_WRITES](): Promise<void> {
      return writes.settle()
    },

    materialize,
    totalOf,

    rowShape(): RowShape {
      return {
        columns: [
          { name: 'id', kind: 'str', optional: false },
          { name: 'bucket_ts', kind: 'ts', optional: false },
          ...dimColumns(dims),
          { name: 'value', kind: isFloat ? 'float' : 'int', optional: false },
        ],
      }
    },
  }

  return self
}
