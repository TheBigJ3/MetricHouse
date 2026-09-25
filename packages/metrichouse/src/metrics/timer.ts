/**
 * Timer — how long something took, folded into a gauge.
 *
 * `23-patterns.md` already settled where a duration belongs: a completed
 * duration is one observation, so it goes on a gauge for min/max/mean and on
 * an event when you want percentiles. This file adds no storage model. What it
 * adds is the part everyone writes by hand and gets subtly wrong — the start
 * timestamp, the `finally`, the clock that can run backwards.
 *
 * **Why a handle, not implicit linking.** `start()` returns the state rather
 * than filing it somewhere for `end()` to find. A call stack cannot tell two
 * concurrent requests apart — they are byte-identical when they share a call
 * site — and async context would tie `core` to `node:async_hooks`, which an
 * edge bundle cannot import. A handle needs no registry, so it cannot leak: an
 * abandoned one is garbage, and not ending it *is* how you cancel it. It also
 * does not care whether two timings nest or merely overlap, which a LIFO stack
 * does.
 *
 * **Which clock.** Durations come from `performance.now()`, which is monotonic;
 * `Date.now()` can step backwards under NTP and produce a negative latency.
 * The *bucket* still comes from the house clock, at `end()` — a timing lands in
 * the bucket where it completed. On Cloudflare Workers `performance.now()`
 * only advances across I/O, so a timer there measures I/O-bound work and
 * reads pure CPU work as zero.
 */

import type { Claim, GaugeCell, RecoveryReport } from '../drivers/types.js'
import type { FlushOptions, MetricFlushReport } from '../runtime/flush.js'
import type { SnapshotOptions } from '../runtime/live.js'
import { encodeDimKey } from '../schema/dims.js'
import {
  assertValue,
  type InferShape,
  type MarkOptional,
  type RequiredKeys,
  type Shape,
  type ShapeArgs,
} from '../schema/types.js'
import type { DurationInput } from '../time/duration.js'
import {
  type Gauge,
  type GaugeAggregate,
  type GaugeLiveRow,
  type GaugeRow,
  type GaugeTotals,
  gauge,
} from './gauge.js'
import type {
  AnyMetric,
  ClaimOptions,
  DimsArgs,
  MaterializedBatch,
  MetricBinding,
  RowShape,
  WriteContext,
  WriteFn,
} from './types.js'
import { assertMetricName, assertSink } from './types.js'

/**
 * What a timer ships unless told otherwise: the gauge's five, minus `last`.
 *
 * `last` is the one aggregate that means nothing for a duration. Of many
 * operations finishing in the same bucket, the last to finish is arbitrary —
 * it is not the latest state of anything. Ask for it explicitly if you want it.
 */
export const TIMER_AGGREGATES = ['min', 'max', 'sum', 'count'] as const

/**
 * The field a timing carries onto a `record` event, and a name no timer dim
 * may take — reserved whether or not `record` is set, so adding it later can
 * never invalidate a declaration that used to work.
 */
export const DURATION_FIELD = 'duration_ms'

export interface TimerConfig<D extends Shape> {
  /** Omit entirely for a timer with no dimensions. */
  readonly dims?: D
  readonly resolution: DurationInput
  /** Minimum shipping cadence. Omit it to take `defaults.flush` from the house. */
  readonly flush?: DurationInput
  /**
   * How long a window waits after it ends before a flush may claim it, so
   * timings recorded inside it have time to reach storage. Default `'2s'`.
   */
  readonly grace?: DurationInput
  /** Which aggregates reach your sink. Default {@link TIMER_AGGREGATES}. */
  readonly aggregate?: readonly GaugeAggregate[]
  /**
   * An event every timing is also recorded to, by metric name — for when
   * min/max/mean is not enough and you need percentiles.
   *
   * The event must declare the timer's dims plus `duration_ms: float()`;
   * spreading `...myTimer.dims` into its fields is the whole declaration. It
   * keeps its own staging, sampling and sink, so the gauge can stay exact while
   * the event table holds a sampled slice — the same split `derive` makes.
   *
   * Named rather than passed, like a `derive` target, and resolved at the first
   * timing, so the two may be declared in either order.
   */
  readonly record?: string
  /**
   * Where this timer's rows go. Required — see the counter for why.
   *
   * A timer is a gauge of durations, so it receives {@link GaugeRow}.
   */
  readonly write: WriteFn<GaugeRow<D>>
}

/** One timing in progress. */
export interface TimerHandle<D extends Shape> {
  /**
   * Milliseconds since `start()`, without ending. Frozen at the recorded
   * duration once `end()` has succeeded.
   */
  elapsed(): number

  /**
   * Stop, record, and return the duration in milliseconds.
   *
   * Takes whatever dims `start()` did not — a status code is usually only
   * known at the end — and a dim given here overrides one bound at start.
   *
   * **Idempotent.** A second call records nothing and returns the first
   * duration. Throwing would be louder, but `end()` lives in `catch` and
   * `finally` blocks, where a throw replaces the error you were handling.
   *
   * @throws if the merged dims are incomplete or invalid. Nothing is recorded,
   * and the handle stays open so a corrected call can still end it.
   */
  end(...dims: ShapeArgs<D>): number
}

/** `time(fn)` is only legal when no dim is required. */
export type TimeArgs<D extends Shape, T> = [RequiredKeys<D>] extends [never]
  ? [fn: () => T] | [dims: InferShape<D>, fn: () => T]
  : [dims: InferShape<D>, fn: () => T]

export interface Timer<D extends Shape> extends AnyMetric {
  readonly name: string
  readonly kind: 'timer'
  readonly dims: D
  readonly resolutionMs: number
  readonly flushMs: number
  readonly graceMs: number
  readonly aggregate: readonly GaugeAggregate[]
  /** The event timings are also recorded to, if any. */
  readonly record: string | undefined
  /** The sink this timer was declared with. A method, as on the counter. */
  write(rows: GaugeRow<D>[], context: WriteContext): Promise<void> | void
  readonly isBound: boolean

  bind(binding: MetricBinding): void

  /**
   * Start a timing, binding any dims already known.
   *
   * @throws if the timer is unbound, or a dim given here is undeclared or
   * ill-typed. A missing required dim is only checkable at `end()`.
   */
  start<const B extends Partial<InferShape<D>> = Record<never, never>>(
    dims?: B,
  ): TimerHandle<MarkOptional<D, keyof B>>

  /**
   * Time a function, sync or async, and return what it returns.
   *
   * The duration is recorded whether `fn` returns or throws: a request that
   * times out after 30 seconds is exactly the latency you most need to see,
   * and dropping failures would hide it. Split by outcome with a dim on
   * `start()`/`end()` instead.
   *
   * @throws before `fn` runs if the timer is unbound or the dims are invalid —
   * never after, when the work has already happened. Whatever `fn` throws is
   * rethrown unchanged.
   */
  time<T>(...args: TimeArgs<D, T>): T

  /**
   * Record a duration measured somewhere else — a query time a database
   * reported, a timing from an upstream header.
   *
   * @throws if `ms` is negative or not finite, or the dims are invalid.
   */
  observe(ms: number, ...dims: ShapeArgs<D>): void

  /** The open bucket's fold of durations for one series. See `Gauge.current`. */
  current(...dims: DimsArgs<D>): Promise<GaugeCell | undefined>

  /** Every series in the open bucket, merged. See `Gauge.totals`. */
  totals(): Promise<GaugeTotals | undefined>

  drain(): Promise<void>
  /** Every unflushed bucket of durations. See `snapshot` on a gauge. */
  snapshot<const O extends SnapshotOptions = Record<never, never>>(
    options?: O,
  ): Promise<GaugeLiveRow<D, O>[]>

  rowShape(): RowShape
}

/** A handle as the implementation sees it, before `D` narrows what `end()` accepts. */
interface OpenTiming {
  elapsed(): number
  end(values?: Record<string, unknown>): number
}

/** The one piece of an event a timer needs. */
interface RecordTarget {
  record(fields: Record<string, unknown>): void
}

/**
 * Sub-microsecond digits are scheduler jitter, not signal, and they turn every
 * `sum` column into `36.12345678901`.
 */
function toMicros(ms: number): number {
  return Math.round(ms * 1000) / 1000
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Declare a timer.
 *
 * @throws if the configuration is invalid — an empty name, a dim named
 * `duration_ms`, an empty `record`, plus every check `gauge()` makes.
 */
export function timer<D extends Shape = Record<never, never>>(
  name: string,
  config: TimerConfig<D>,
): Timer<D> {
  assertMetricName(name, 'timer')
  assertSink(config.write, name)

  const dims = (config.dims ?? {}) as D

  if (DURATION_FIELD in dims) {
    throw new Error(
      `${name}: dim ${JSON.stringify(DURATION_FIELD)} is reserved — it is the field a timing ` +
        'carries onto a record event',
    )
  }
  if (config.record !== undefined) {
    if (typeof config.record !== 'string' || config.record.trim() === '') {
      throw new Error(`${name}: record must name an event`)
    }
    if (config.record === name) {
      throw new Error(`${name}: record names the timer itself — it must name an event`)
    }
  }

  // the gauge is told it is a timer: it ships itself under `delivery:
  // 'immediate'`, and a sink should not be told a timing came from a gauge
  const inner: Gauge<D, 'timer'> = gauge(
    name,
    {
      dims,
      resolution: config.resolution,
      aggregate: config.aggregate ?? TIMER_AGGREGATES,
      ...(config.flush !== undefined && { flush: config.flush }),
      ...(config.grace !== undefined && { grace: config.grace }),
      write: config.write,
    },
    'timer',
  )

  let binding: MetricBinding | undefined
  let recordTarget: RecordTarget | undefined

  function assertBound(): void {
    if (!inner.isBound) {
      throw new Error(
        `${name}: not bound to a house — pass it to createHouse({ schema }) before timing`,
      )
    }
  }

  /** The partial check `start()` can make: every key given must be declared and well-typed. */
  function assertKnownDims(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      const type = Object.hasOwn(dims, key) ? dims[key] : undefined
      if (!type) {
        throw new Error(
          `unknown dim ${JSON.stringify(key)} — declared dims are [${Object.keys(dims).join(', ')}]`,
        )
      }
      if (value !== undefined) assertValue(type, value, key)
    }
  }

  /** See `event()`'s function of the same name: a detached failure must not vanish. */
  function reportDetached(error: unknown): void {
    const onError = binding?.onError
    if (onError) {
      onError(error, { metric: name })
      return
    }
    void Promise.reject(error)
  }

  /**
   * Find and check the `record` event once.
   *
   * Checked here rather than left to the event's own validation so a
   * misconfiguration says what is wrong with the *pairing* — "declare
   * duration_ms: float()" — instead of "unknown field" on every timing.
   */
  function resolveRecordTarget(target: string): RecordTarget {
    if (recordTarget) return recordTarget

    const metric = binding?.resolve?.(target)
    if (!metric) {
      throw new Error(
        `${name}: record names ${JSON.stringify(target)}, which no metric in this house ` +
          'declares — register it alongside the timer',
      )
    }
    if (metric.kind !== 'event') {
      throw new Error(
        `${name}: record target ${JSON.stringify(target)} is a ${metric.kind}, and a timing can ` +
          'only be recorded to an event',
      )
    }

    const fields = (metric as unknown as { fields: Shape }).fields
    if (fields[DURATION_FIELD]?.kind !== 'float') {
      throw new Error(
        `${name}: record target ${JSON.stringify(target)} must declare ` +
          `${DURATION_FIELD}: float() — a duration is fractional milliseconds`,
      )
    }

    const missing = Object.keys(dims).filter((key) => !(key in fields))
    if (missing.length > 0) {
      throw new Error(
        `${name}: record target ${JSON.stringify(target)} does not declare ` +
          `[${missing.join(', ')}] — spread the timer's dims into its fields`,
      )
    }

    const unfillable = Object.entries(fields)
      .filter(([key, type]) => key !== DURATION_FIELD && !(key in dims) && !type.isOptional)
      .map(([key]) => key)
    if (unfillable.length > 0) {
      throw new Error(
        `${name}: record target ${JSON.stringify(target)} requires [${unfillable.join(', ')}], ` +
          'which a timing cannot supply — make them optional or give them defaults',
      )
    }

    recordTarget = metric as unknown as RecordTarget
    return recordTarget
  }

  /**
   * The single write path — `end()`, `time()` and `observe()` all land here.
   *
   * The gauge first, and synchronously, so bad dims throw at the caller. The
   * event second, and detached: the gauge observation has already been made,
   * and a broken pairing must not turn a recorded timing into a thrown one.
   */
  function recordTiming(ms: number, values: Record<string, unknown>): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new Error(
        `${name}: a duration must be a finite, non-negative number, got ${String(ms)}`,
      )
    }

    inner.set(ms, ...([values] as DimsArgs<D>))

    if (config.record === undefined) return
    try {
      resolveRecordTarget(config.record).record({ ...values, [DURATION_FIELD]: ms })
    } catch (error) {
      reportDetached(error)
    }
  }

  function start(bound: Record<string, unknown> = {}): OpenTiming {
    assertBound()
    assertKnownDims(bound)

    const startedAt = performance.now()
    let recorded: number | undefined

    return {
      elapsed(): number {
        return recorded ?? toMicros(performance.now() - startedAt)
      },

      end(values?: Record<string, unknown>): number {
        if (recorded !== undefined) return recorded

        const ms = toMicros(performance.now() - startedAt)
        // the end's dims win: it knows more than the start did. A key the end
        // passes as `undefined` has nothing to say, so it leaves the start's
        // value in place rather than erasing it
        const given = Object.entries(values ?? {}).filter(([, value]) => value !== undefined)
        recordTiming(ms, { ...bound, ...Object.fromEntries(given) })
        // set only once the write is accepted, so a throw leaves the handle open
        recorded = ms
        return ms
      },
    }
  }

  const self = {
    name,
    kind: 'timer' as const,
    storage: 'bucketed' as const,
    dims,
    resolutionMs: inner.resolutionMs,

    // read through, not copied: the gauge resolves these against its binding,
    // and a timer declared before its house would otherwise freeze the wrong
    // answer at construction
    get flushMs(): number {
      return inner.flushMs
    },

    get graceMs(): number {
      return inner.graceMs
    },

    aggregate: inner.aggregate,
    record: config.record,
    write: config.write,

    get isBound(): boolean {
      return inner.isBound
    },

    bind(next: MetricBinding): void {
      // the gauge refuses a second house; only remember a binding it accepted
      inner.bind(next)
      binding = next
    },

    unbind(): void {
      inner.unbind()
      binding = undefined
      recordTarget = undefined
    },

    start,

    time(...args: unknown[]): unknown {
      const [values, fn] = args.length >= 2 ? args : [undefined, args[0]]
      if (typeof fn !== 'function') {
        throw new Error(`${name}: time() needs a function to time`)
      }

      // everything that can fail is checked before the work runs
      assertBound()
      encodeDimKey(dims, (values ?? {}) as Record<string, unknown>)

      const handle = start((values ?? {}) as Record<string, unknown>)

      let result: unknown
      try {
        result = fn()
      } catch (error) {
        handle.end()
        throw error
      }

      if (isThenable(result)) {
        return result.then(
          (value) => {
            handle.end()
            return value
          },
          (error: unknown) => {
            handle.end()
            throw error
          },
        )
      }

      handle.end()
      return result
    },

    observe(ms: number, values?: Record<string, unknown>): void {
      assertBound()
      recordTiming(ms, values ?? {})
    },

    current(...args: DimsArgs<D>): Promise<GaugeCell | undefined> {
      return inner.current(...args)
    },

    totals(): Promise<GaugeTotals | undefined> {
      return inner.totals()
    },

    drain(): Promise<void> {
      return inner.drain()
    },

    snapshot<const O extends SnapshotOptions = Record<never, never>>(
      options?: O,
    ): Promise<GaugeLiveRow<D, O>[]> {
      return inner.snapshot(options)
    },

    rowShape(): RowShape {
      return inner.rowShape()
    },

    // the bucketed lifecycle, untouched — the flush engine talks to the gauge
    // underneath and only learns from `kind` that a timer was involved
    /**
     * Delegated, not reimplemented: the cadence and retry state belong to the
     * one thing that actually holds the buckets. A timer that counted its own
     * attempts would disagree with the gauge underneath it.
     */
    flush(options?: FlushOptions): Promise<MetricFlushReport> {
      return inner.flush(options)
    },

    recoverBatch(): Promise<RecoveryReport> {
      return inner.recoverBatch()
    },

    claimBatch(nowMs: number, options?: ClaimOptions): Promise<Claim> {
      return inner.claimBatch(nowMs, options)
    },

    materializeClaim(claim: Claim): MaterializedBatch {
      return inner.materializeClaim(claim)
    },

    ackBatch(claim: Claim): Promise<void> {
      return inner.ackBatch(claim)
    },

    releaseBatch(claim: Claim): Promise<void> {
      return inner.releaseBatch(claim)
    },
  }

  return self as unknown as Timer<D>
}
