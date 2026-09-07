/**
 * The flush engine.
 *
 * Decides *which* metrics ship and *when*; {@link shipClaim} does the shipping.
 * A metric's `flush` setting is a **minimum cadence**, not a schedule: calling
 * `house.flush()` every 10 seconds still ships a 5-minute metric every 5
 * minutes.
 *
 * ```
 * cadence -> metric.claimBatch(now) -> shipClaim -> ack | release
 * ```
 *
 * **Nothing in this file knows what a bucket is.** The metric turns `now` into
 * whatever claim its own storage model needs — a watermark over closed buckets
 * for a counter, the staged backlog for an event — so a new primitive is four
 * methods on {@link AnyMetric} and no edit here.
 *
 * Spec: initialPlan/12-flush.md
 */

import type { AnyMetric, WriteFn } from '../metrics/types.js'
import { shipClaim } from './ship.js'

export type FlushSkipReason = 'cadence' | 'not-selected'

export interface FlushOptions {
  /** Restrict the flush to these metric names. */
  readonly only?: readonly string[]
  /** Ignore the per-metric cadence and ship everything closed now. */
  readonly force?: boolean
}

export interface MetricFlushReport {
  readonly buckets: number
  readonly rows: number
  readonly skipped: boolean
  readonly reason?: FlushSkipReason
  /** How long until the cadence lets this metric ship again. */
  readonly nextEligibleInMs?: number
  readonly error?: unknown
}

export interface FlushReport {
  readonly ok: boolean
  readonly durationMs: number
  readonly metrics: Record<string, MetricFlushReport>
  /** For callers who would rather have an exception than inspect a report. */
  throwIfFailed(): void
}

/** Per-metric state the house owns across calls. */
export interface MetricFlushState {
  /**
   * When this metric last actually shipped rows. Zero until the first one, so
   * a fresh house ships as soon as anything is closed rather than sitting on
   * data for a full interval. An empty flush does not move it.
   */
  lastFlushMs: number
  /** `1` on a first try, incremented each time a write fails and releases. */
  attempt: number
}

export interface FlushContext {
  readonly now: () => number
  readonly metrics: readonly AnyMetric[]
  /** The metric's own sink, or the house fallback. */
  readonly sinkFor: (metric: AnyMetric) => WriteFn | undefined
  readonly state: Map<string, MetricFlushState>
}

function stateFor(context: FlushContext, name: string): MetricFlushState {
  let state = context.state.get(name)
  if (!state) {
    state = { lastFlushMs: 0, attempt: 1 }
    context.state.set(name, state)
  }
  return state
}

export async function runFlush(
  context: FlushContext,
  options: FlushOptions = {},
): Promise<FlushReport> {
  const startedAt = context.now()
  const metrics: Record<string, MetricFlushReport> = {}
  let ok = true

  for (const metric of context.metrics) {
    if (options.only && !options.only.includes(metric.name)) {
      metrics[metric.name] = { buckets: 0, rows: 0, skipped: true, reason: 'not-selected' }
      continue
    }

    const report = await flushOne(context, metric, options)
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

async function flushOne(
  context: FlushContext,
  metric: AnyMetric,
  options: FlushOptions,
): Promise<MetricFlushReport> {
  const state = stateFor(context, metric.name)
  const now = context.now()

  // 1. cadence — `flush` is a minimum, so most calls are a no-op for most
  //    metrics. `lastFlushMs` advances only on success.
  const elapsed = now - state.lastFlushMs
  if (!options.force && elapsed < metric.flushMs) {
    return {
      buckets: 0,
      rows: 0,
      skipped: true,
      reason: 'cadence',
      nextEligibleInMs: metric.flushMs - elapsed,
    }
  }

  const sink = context.sinkFor(metric)
  if (!sink) {
    // loudly, rather than skipping: a metric with nowhere to ship is a
    // misconfiguration that would otherwise look like a quiet success
    return {
      buckets: 0,
      rows: 0,
      skipped: false,
      error: new Error(
        `${metric.name}: no write() — declare one on the metric or pass one to createHouse`,
      ),
    }
  }

  // 2. claim — atomically invisible to live reads and to a second flusher.
  //    What is claimable is the metric's judgement, not this file's.
  const claim = await metric.claimBatch(now)

  // 3. ship — materialize, write, then ack or release
  const outcome = await shipClaim(metric, claim, sink, {
    attempt: state.attempt,
    source: 'flush',
  })

  if (outcome.error !== undefined) {
    state.attempt += 1
    return { buckets: outcome.buckets, rows: outcome.rows, skipped: false, error: outcome.error }
  }

  if (outcome.rows === 0) {
    // deliberately does NOT advance lastFlushMs. The cadence bounds how often
    // this metric *ships*, and nothing shipped. Advancing here would let an
    // empty flush eat the cadence, so data that closed a second later would
    // then wait a full interval — the coarser the resolution, the worse it
    // gets, because early flushes always find the only bucket still open.
    return { buckets: 0, rows: 0, skipped: false }
  }

  state.lastFlushMs = now
  state.attempt = 1

  return { buckets: outcome.buckets, rows: outcome.rows, skipped: false }
}
