/**
 * Counter — an integer (or float) accumulated per series, per time bucket.
 *
 * The one primitive that genuinely cannot be rebuilt after the fact: once the
 * increments are discarded, no query brings the per-second count back.
 *
 * A declaration is **inert**. `counter()` opens nothing and touches no driver;
 * calling `.add()` before a house has bound it throws rather than silently
 * dropping the write.
 *
 * Spec: initialPlan/03-counter.md, 01-schema.md, 07-buckets.md
 */

import { type Cell, type Driver, isGaugeCell } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { assertDimsLegal, decodeDimKey, encodeDimKey } from '../schema/dims.js'
import type { FieldType, InferShape, Shape, Simplify } from '../schema/types.js'
import { assertResolution, bucketStart } from '../time/buckets.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import { bucketedLifecycle } from './bucketed.js'
import type { AnyMetric, DimsArgs, MetricBinding, Row, RowShape, WriteFn } from './types.js'

export type { DimsArgs, RowColumn, RowShape } from './types.js'

/** The row shape a counter's `write()` receives. */
export type CounterRow<D extends Shape> = Simplify<
  { id: string; bucket_ts: Date } & InferShape<D> & { value: number }
>

export interface CounterConfig<D extends Shape> {
  /** Omit entirely for a counter with no dimensions. */
  readonly dims?: D
  /** Bucket width, e.g. `'1s'`. Parsed once, here, never on the write path. */
  readonly resolution: DurationInput
  /** Minimum shipping cadence, e.g. `'5m'`. Must be a whole multiple of `resolution`. */
  readonly flush: DurationInput
  /** How long past a boundary a late write still lands in the closed bucket. Default `'2s'`. */
  readonly grace?: DurationInput
  /** `int()` (default) or `float()`. Decides whether `.add()` accepts fractions. */
  readonly value?: FieldType<number, false>
  /** This metric's sink. Falls back to the house's `write` when omitted. */
  readonly write?: WriteFn
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
  readonly write: WriteFn | undefined

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
  const flushMs = parseDuration(config.flush)
  const graceMs = parseDuration(config.grace ?? '2s')
  assertResolution(resolutionMs, flushMs)

  const isFloat = config.value?.kind === 'float'

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
    if (isGaugeCell(cell)) {
      throw new Error(`${name}: expected a counter cell but the driver returned a gauge fold`)
    }
    return cell
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

  return {
    ...bucketedLifecycle({
      name,
      resolutionMs,
      graceMs,
      driver: activeDriver,
      materialize,
      totalOf,
    }),

    name,
    kind: 'counter',
    dims,
    resolutionMs,
    flushMs,
    graceMs,
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

      track(active.driver.increment([{ metric: name, bucketTs, dimKey, delta }]), active.onError)
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
}
