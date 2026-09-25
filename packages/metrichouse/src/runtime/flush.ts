/**
 * Flush — one metric's trip to its own sink, and the house's fan-out over it.
 *
 * A metric owns its cadence, its sink and its retry state, so `metric.flush()`
 * is the whole unit:
 *
 * ```
 * cadence -> claimBatch(now) -> shipClaim -> ack | release
 * ```
 *
 * {@link runFlush} is a loop over that and nothing else. The house is a
 * convenience for callers holding a whole schema — a cron handler that wants
 * everything — not the place the logic lives. Flushing one metric never needs
 * a house at all.
 *
 * **Nothing in this file knows what a bucket is.** The metric turns `now` into
 * whatever claim its own storage model needs — a watermark over closed buckets
 * for a counter, the staged backlog for an event — so a new primitive is the
 * four {@link AnyMetric} batch methods plus this mixin, and no edit here.
 */

import type { RecoveryReport } from '../drivers/types.js'
import type { AnyMetric, WriteFn } from '../metrics/types.js'
import { type ShipOutcome, shipClaim } from './ship.js'

export type FlushSkipReason = 'cadence' | 'not-selected'

/** What {@link AnyMetric.flush} accepts. */
export interface FlushOptions {
  /** Ignore the cadence and ship everything closed now. */
  readonly force?: boolean
  /**
   * The last flush this process will make. Implies `force`, and also ships
   * windows that have ended but are still inside grace.
   *
   * Grace exists for writes still on their way to the driver. A process that
   * is stopping has drained its own writes already, so the only window worth
   * keeping back is the one still open. A write from another instance that
   * arrives after this is moved into the oldest window that has not shipped,
   * so nothing is lost by not waiting.
   */
  readonly final?: boolean
}

/** What {@link runFlush} accepts, on top of the per-metric options. */
export interface HouseFlushOptions extends FlushOptions {
  /** Restrict the flush to these metric names. */
  readonly only?: readonly string[]
}

export interface MetricFlushReport {
  readonly buckets: number
  readonly rows: number
  readonly skipped: boolean
  readonly reason?: FlushSkipReason
  /** How long until the cadence lets this metric ship again. */
  readonly nextEligibleInMs?: number
  readonly error?: unknown
  /**
   * Set when this flush found a claim a dead flusher had left behind and put
   * it back before claiming.
   *
   * Absent on the ordinary flush, so its presence is the signal: something
   * crashed between claiming a batch and settling it. The rows are in this
   * flush, or in the next one, either way — but the crash is worth logging.
   */
  readonly recovered?: RecoveryReport
  /**
   * Set when the recovery pass itself failed. Separate from `error`, which
   * means the *sink* failed: the flush below it still ran, and `rows` says
   * what it shipped.
   */
  readonly recoveryError?: unknown
  /**
   * Set when the sink took the rows but the claim could not be settled
   * afterwards.
   *
   * The rows were written, so this flush still counts as a success. It
   * usually means another flusher decided the claim was abandoned and put it
   * back, which happens when a sink runs longer than `recoverAfter`. Those
   * rows will arrive a second time with the same ids.
   */
  readonly ackError?: unknown
}

export interface FlushReport {
  readonly ok: boolean
  readonly durationMs: number
  readonly metrics: Record<string, MetricFlushReport>
  /** For callers who would rather have an exception than inspect a report. */
  throwIfFailed(): void
}

/**
 * The cadence and retry state one metric carries between its own flushes.
 *
 * Private to the metric now, rather than held by the house in a map keyed by
 * name. A metric that ships itself — on a scheduler tick, from a cron, from a
 * test — has to count its own attempts, and a second bookkeeper would disagree
 * with the first the moment either was used alone.
 */
interface FlushState {
  /**
   * When this metric last actually shipped rows. Unset until the first one,
   * so a fresh metric ships as soon as anything is closed rather than sitting
   * on data for a full interval, whatever the clock reads. An empty flush
   * does not move it.
   */
  lastFlushMs: number | undefined
}

/**
 * How many times in a row this metric's writes have failed, plus one.
 *
 * An object rather than a number so every path that ships a metric can share
 * it: `flush()`, a locally staged event shipping on `batch.maxSize`, and
 * immediate delivery all report the same `attempt`, and a failure on one of
 * them is counted by the next. Reset to `1` by the first write that succeeds.
 *
 * Counted in this process only. A second process shipping the same metric
 * keeps its own count.
 */
export interface Attempts {
  current: number
}

/** A fresh count, for a metric that has not failed yet. */
export function createAttempts(): Attempts {
  return { current: 1 }
}

/** What a metric supplies to get a {@link AnyMetric.flush} of its own. */
export interface MetricFlushOptions {
  readonly name: string
  /** Read late: a cadence may come from the house, and a metric is declared before it is bound. */
  readonly flushMs: () => number
  /** This metric's sink. */
  readonly sink: () => WriteFn
  /** The bound clock. Throws if the metric has no house yet. */
  readonly now: () => number
  /**
   * The metric itself, resolved at call time rather than captured.
   *
   * {@link shipClaim} needs the finished {@link AnyMetric} — including the
   * four batch methods and any decoration a wrapper kind added on top — and
   * this mixin is spread into that object while it is still being built.
   */
  readonly self: () => AnyMetric
  /**
   * The failure count to share with the metric's other shipping paths. A kind
   * that only ships through `flush()` can leave it out.
   */
  readonly attempts?: Attempts
}

/**
 * The flush half of a metric, as a mixin.
 *
 * The counterpart to `bucketedLifecycle` and `stagedMetric` on the delivery
 * side: those say what a claim *is* for a storage model, this says what
 * happens to one. Every kind gets the identical cadence rule, the identical
 * retry counting, and the identical "an empty flush is not a flush".
 */
export function metricFlush(options: MetricFlushOptions): Pick<AnyMetric, 'flush'> {
  const state: FlushState = { lastFlushMs: undefined }
  const attempts = options.attempts ?? createAttempts()

  return {
    async flush(flushOptions: FlushOptions = {}): Promise<MetricFlushReport> {
      const metric = options.self()
      // reads the bound clock, so an unbound metric fails here rather than
      // claiming against `Date.now` and a driver that does not exist
      const now = options.now()
      const final = flushOptions.final === true

      // 1. cadence — `flush` is a minimum, so a scheduler tick or a cron call
      //    that arrives early is a no-op. `lastFlushMs` advances only on
      //    success.
      //
      //    A clock that has stepped backwards since the last flush reads a
      //    negative elapsed time. That is not "too soon", it is "no longer
      //    comparable", and holding the metric back until the clock caught up
      //    would stall it for as long as the step was.
      const flushMs = options.flushMs()
      if (!flushOptions.force && !final && state.lastFlushMs !== undefined) {
        const elapsed = now - state.lastFlushMs
        if (elapsed >= 0 && elapsed < flushMs) {
          return {
            buckets: 0,
            rows: 0,
            skipped: true,
            reason: 'cadence',
            nextEligibleInMs: flushMs - elapsed,
          }
        }
      }

      // 2. recover — a batch claimed by a flusher that then died is already
      //    out of the live set, so `claimBatch` cannot reach it however long
      //    it waits. Putting it back first is what lets this flush ship it.
      //
      //    After the cadence check, because recovered data can only leave on a
      //    flush that is actually going to claim, and wrapped because this is
      //    a repair rather than a precondition: a recovery that keeps failing
      //    must not turn into a metric that never ships again.
      let recovered: RecoveryReport | undefined
      let recoveryError: unknown
      try {
        const pass = await metric.recoverBatch()
        // absent unless it found something, so a caller can treat the field's
        // presence as the news rather than reading a zero on every flush
        if (pass.claims > 0) recovered = pass
      } catch (error) {
        recoveryError = error
      }
      const repair = {
        ...(recovered !== undefined && { recovered }),
        ...(recoveryError !== undefined && { recoveryError }),
      }

      // 3 and 4. claim, then ship. A driver that cannot be reached fails the
      //    claim, and that comes back in the report like a sink failure does:
      //    a caller flushing a whole house should hear about it and still see
      //    every other metric flushed
      let outcome: ShipOutcome
      try {
        // what is claimable is the metric's judgement, not this file's
        const claim = await metric.claimBatch(now, { final })
        outcome = await shipClaim(metric, claim, options.sink(), { attempts, source: 'flush' })
      } catch (error) {
        return { buckets: 0, rows: 0, skipped: false, error, ...repair }
      }

      if (outcome.error !== undefined) {
        return {
          buckets: outcome.buckets,
          rows: outcome.rows,
          skipped: false,
          error: outcome.error,
          ...repair,
        }
      }

      const settled = {
        ...repair,
        ...(outcome.ackError !== undefined && { ackError: outcome.ackError }),
      }

      if (outcome.rows === 0) {
        // deliberately does NOT advance lastFlushMs. The cadence bounds how
        // often this metric *ships*, and nothing shipped. Advancing here would
        // let an empty flush eat the cadence, so data that closed a second
        // later would then wait a full interval — the coarser the resolution,
        // the worse it gets, because early flushes always find the only bucket
        // still open.
        return { buckets: 0, rows: 0, skipped: false, ...settled }
      }

      state.lastFlushMs = now

      return { buckets: outcome.buckets, rows: outcome.rows, skipped: false, ...settled }
    },
  }
}

export interface FlushContext {
  readonly now: () => number
  readonly metrics: readonly AnyMetric[]
}

/**
 * Flush every metric in a house, in registration order, and collect the
 * reports.
 *
 * Sequential rather than parallel: these are independent writes, but they are
 * writes, and a cron handler flushing forty metrics at once into one database
 * is a thundering herd the caller did not ask for. A caller who wants the
 * concurrency has `metric.flush()` and `Promise.all`.
 */
export async function runFlush(
  context: FlushContext,
  options: HouseFlushOptions = {},
): Promise<FlushReport> {
  const startedAt = context.now()
  const metrics: Record<string, MetricFlushReport> = {}
  let ok = true

  for (const metric of context.metrics) {
    if (options.only && !options.only.includes(metric.name)) {
      metrics[metric.name] = { buckets: 0, rows: 0, skipped: true, reason: 'not-selected' }
      continue
    }

    let report: MetricFlushReport
    try {
      report = await metric.flush(options)
    } catch (error) {
      // a metric's flush reports its own failures, so this is the rare one it
      // could not: an unbound metric, or a release that failed after a sink
      // did. It still must not stop the metrics after it from shipping
      report = { buckets: 0, rows: 0, skipped: false, error }
    }
    metrics[metric.name] = report
    if (report.error !== undefined) ok = false
  }

  const durationMs = context.now() - startedAt

  return {
    ok,
    durationMs,
    metrics,
    throwIfFailed(): void {
      if (ok) return
      const failed = Object.entries(metrics)
        .filter(([, report]) => report.error !== undefined)
        .map(([name]) => name)
      throw new Error(`flush failed for ${failed.join(', ')}`)
    },
  }
}
