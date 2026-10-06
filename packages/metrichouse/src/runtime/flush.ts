/**
 * Flush. One metric's trip to its own sink, and the house's fan-out over it.
 *
 * A metric owns its cadence, its sink and its retry state, so `metric.flush()`
 * is the whole unit:
 *
 * ```
 * cadence -> turn -> claimBatch(now) -> shipClaim -> ack | release
 * ```
 *
 * {@link runFlush} is a loop over that and nothing else. The house is a
 * convenience for callers holding a whole schema, such as a cron handler that wants
 * everything, not the place the logic lives. Flushing one metric never needs
 * a house at all.
 *
 * **Nothing in this file knows what a bucket is.** The metric turns `now` into
 * whatever claim its own storage model needs, a watermark over closed buckets
 * for a counter, the staged backlog for an event, so a new primitive is the
 * five {@link AnyMetric} batch methods plus this mixin, and no edit here.
 */

import type { Driver, RecoveryReport, ShipTurn } from '../drivers/types.js'
import { type AnyMetric, SETTLE, type WriteFn } from '../metrics/types.js'
import { type ShipOutcome, shipClaim } from './ship.js'

export type FlushSkipReason = 'cadence' | 'not-selected'

/** What {@link AnyMetric.flush} accepts. */
export interface FlushOptions {
  /** Ignore the cadence and ship everything closed now. */
  readonly force?: boolean
  /**
   * The last flush this process will make. Ignores this process's own
   * cadence, and also ships windows that have ended but are still inside
   * grace.
   *
   * On a driver that is shared and durable it still waits for the turn every
   * process takes, unless `force` is passed too. The rows it leaves stay in
   * storage, and whichever process takes the next turn ships them, so a
   * rolling deploy does not send one small insert per stopping process.
   *
   * Grace exists for writes still on their way to the driver. A process that
   * is stopping has drained its own writes already, so the only window worth
   * keeping back is the one still open. A write from another instance that
   * arrives after this is moved into the oldest window that has not shipped,
   * so nothing is lost by not waiting.
   *
   * On a driver that is not durable it also ships every window ahead of the
   * clock. Data lands there when the clock steps back, and nothing will be
   * left to ship it once the process ends.
   */
  readonly final?: boolean
}

/** What {@link runFlush} accepts, on top of the per-metric options. */
export interface HouseFlushOptions extends FlushOptions {
  /**
   * Restrict the flush to these metric names. A name no registered metric
   * has is listed in {@link FlushReport.unmatched}.
   */
  readonly only?: readonly string[]
  /**
   * Throw instead, before anything is flushed, when `only` names a metric
   * this house does not hold. Off by default, because a metric may be
   * registered later and a name for it is not a mistake.
   */
  readonly strict?: boolean
}

export interface MetricFlushReport {
  readonly buckets: number
  readonly rows: number
  readonly skipped: boolean
  readonly reason?: FlushSkipReason
  /**
   * How long until the cadence lets this metric ship again: until nine tenths
   * of the interval has passed since the last shipment, since a call that
   * early already counts as on time.
   */
  readonly nextEligibleInMs?: number
  readonly error?: unknown
  /**
   * Set beside `error` when claims before the one that failed were written.
   *
   * A flush that claims more than once can fail partway. `buckets` and `rows`
   * count every claim handed to the sink, the failed one included, and this
   * says how many of them the sink took. Those rows have left storage. The
   * rest are back in the live set, unless `releaseError` says otherwise.
   */
  readonly written?: { readonly buckets: number; readonly rows: number }
  /**
   * Set when the sink failed and putting its rows back failed too.
   *
   * `error` is still the sink's own failure. This says the rows did not go
   * back to the live set: they are held in the claim, which a durable
   * driver's recovery returns once `recoverAfter` has passed, and which a
   * driver that is not durable loses.
   */
  readonly releaseError?: unknown
  /**
   * Set when this flush found a claim a dead flusher had left behind and put
   * it back before claiming.
   *
   * Absent on the ordinary flush, so its presence is the signal: something
   * crashed between claiming a batch and settling it. The rows are in this
   * flush, or in the next one, either way, but the crash is worth logging.
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
  /**
   * The names in `only` that matched no metric registered when the call was
   * made, in the order given. Empty when every name matched, or when there
   * was no `only`.
   */
  readonly unmatched: string[]
  /** For callers who would rather have an exception than inspect a report. */
  throwIfFailed(): void
}

/**
 * The cadence and retry state one metric carries between its own flushes.
 *
 * Private to the metric now, rather than held by the house in a map keyed by
 * name. A metric that ships itself, on a scheduler tick, from a cron, from a
 * test, has to count its own attempts, and a second bookkeeper would disagree
 * with the first the moment either was used alone.
 */
interface FlushState {
  /**
   * When this process last actually shipped rows of this metric. Unset until
   * the first one, so a fresh metric ships as soon as anything is closed
   * rather than sitting on data for a full interval, whatever the clock
   * reads. An empty flush does not move it.
   *
   * With a shared driver this is only the half of the cadence this process
   * can see for itself, checked first because it costs nothing. The turn the
   * driver keeps is the half every process sees.
   */
  lastFlushMs: number | undefined
  /**
   * Which flush set `lastFlushMs`, counted in the order the cadence let them
   * through. A flush that finishes after one let through later leaves
   * `lastFlushMs` alone, since the later one shipped more recently.
   */
  lastFlushSeq: number
  /** How many flushes the cadence has let through, the last one's number. */
  admitted: number
  /**
   * When each flush the cadence has let through, and that has not finished
   * yet, was let through, and its number in that order.
   *
   * The cadence counts from whichever was let through last, of these and of
   * the flush that set `lastFlushMs`. A flush still inside its sink has not
   * set `lastFlushMs` yet, and a second flush that looked only at that would
   * ship beside it in the same interval. One that finishes having shipped
   * nothing leaves this set and moves nothing, so the flush after it goes
   * ahead. Compared by order rather than by time, because a clock that
   * stepped back makes a newer flush's time the smaller one.
   */
  readonly inFlight: Set<Admitted>
}

/** A flush the cadence let through: its `now`, and its number in that order. */
interface Admitted {
  readonly at: number
  readonly seq: number
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

/**
 * How early a flush may arrive and still count as on time: a tenth of the
 * cadence.
 *
 * A tenth rather than a few milliseconds, because the caller's clock is not
 * the only one that drifts. A cron that fires a few hundred milliseconds
 * earlier within its minute than it did the last time would otherwise be
 * refused, and the metric would wait a whole interval for the next call.
 */
export function cadenceSlack(flushMs: number): number {
  return flushMs / 10
}

/**
 * How many claims one flush may make before it stops, when each claim is
 * capped by a `claimLimit`.
 */
const CLAIM_CAP = 100

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
   * {@link shipClaim} needs the finished {@link AnyMetric}, including the
   * five batch methods and any decoration a wrapper kind added on top, and
   * this mixin is spread into that object while it is still being built.
   */
  readonly self: () => AnyMetric
  /**
   * The failure count to share with the metric's other shipping paths. A kind
   * that only ships through `flush()` can leave it out.
   */
  readonly attempts?: Attempts
  /**
   * The driver that keeps this metric's turn to ship, so every process
   * sharing it holds to one cadence between them. See {@link Driver.takeTurn}.
   * Asked only when its capabilities say it is shared: a driver no other
   * process can see has nobody to take turns with.
   *
   * Left out, or answering `undefined`, the cadence is this process's alone.
   * That is right for a locally staged event, whose records only this process
   * holds: a turn another process took would stop it shipping its own.
   */
  readonly sharedDriver?: () => Driver | undefined
  /**
   * The most rows one claim of this metric carries, when it has a limit.
   *
   * A claim that comes back with this many may have left more behind, so the
   * flush claims again rather than leaving the rest for the next interval.
   * Left out, one claim takes everything there is, and a second would find
   * nothing.
   */
  readonly claimLimit?: number
  /**
   * Whether what this metric holds outlives the process.
   *
   * A final flush on a metric whose storage does not stops claiming only at a
   * claim that comes back empty, with no cap, because whatever it leaves
   * behind ends with the process. Left out, the storage counts as outliving
   * it, and the cap applies.
   */
  readonly outlivesProcess?: () => boolean
  /**
   * Run before anything else in each flush, the cadence check included, and
   * inside the flush `house.stop()` waits for. A gauge or a level declared
   * with `collect` collects here when no scheduler is running. Must not
   * reject: a failure belongs to whatever it ran, not to the flush.
   */
  readonly before?: (options: FlushOptions) => Promise<void>
}

/**
 * The flush half of a metric, as a mixin.
 *
 * The counterpart to `bucketedLifecycle` and `stagedMetric` on the delivery
 * side: those say what a claim *is* for a storage model, this says what
 * happens to one. Every kind gets the identical cadence rule, the identical
 * retry counting, and the identical "an empty flush is not a flush".
 */
export function metricFlush(
  options: MetricFlushOptions,
): Required<Pick<AnyMetric, 'flush' | typeof SETTLE>> {
  const state: FlushState = {
    lastFlushMs: undefined,
    lastFlushSeq: 0,
    admitted: 0,
    inFlight: new Set(),
  }
  const attempts = options.attempts ?? createAttempts()
  /**
   * Flushes of this metric that have not returned yet, however they were
   * started: a scheduler tick, a cron, a direct call.
   *
   * `house.stop()` waits for them before its final flush. One still inside
   * its sink when that flush looks would put its rows back afterwards if the
   * sink failed, and nothing would ship them.
   */
  const running = new Set<Promise<MetricFlushReport>>()

  return {
    flush(flushOptions: FlushOptions = {}): Promise<MetricFlushReport> {
      // the tracked chain is what the caller gets, so a flush nobody awaits
      // that rejects, an unbound one, is still an unhandled rejection rather
      // than swallowed by the bookkeeping
      const tracked: Promise<MetricFlushReport> = flushOnce(flushOptions).finally(() => {
        running.delete(tracked)
      })
      running.add(tracked)
      return tracked
    },

    async [SETTLE](): Promise<boolean> {
      // loops rather than waiting once: a flush started while this waits is
      // one that could still put rows back after the final flush has looked
      let waited = false
      while (running.size > 0) {
        waited = true
        await Promise.allSettled([...running])
      }
      return waited
    },
  }

  async function flushOnce(flushOptions: FlushOptions): Promise<MetricFlushReport> {
    // first, and awaited, so its writes have been issued before the cadence
    // and the clock are read. They land in the window open now, which this
    // flush does not claim
    if (options.before !== undefined) await options.before(flushOptions)
    const metric = options.self()
    // reads the bound clock, so an unbound metric fails here rather than
    // claiming against `Date.now` and a driver that does not exist
    const now = options.now()
    const final = flushOptions.final === true

    // 1. cadence. `flush` is a minimum, so a scheduler tick or a cron call
    //    that arrives early is a no-op. `lastFlushMs` advances only when
    //    rows were written.
    //
    //    A clock that has stepped backwards since the last flush reads a
    //    negative elapsed time. That is not "too soon", it is "no longer
    //    comparable", and holding the metric back until the clock caught up
    //    would stall it for as long as the step was.
    //
    //    A call a little early counts as on time. The scheduler's interval
    //    runs on a different clock from `now()`, and a tick can fire a
    //    millisecond before `now()` agrees a full interval has passed. A
    //    cron fires wherever in its minute the platform gets to it. Refusing
    //    either would push that metric back a whole interval.
    //
    //    A flush still running counts as the latest shipment, until it
    //    finishes having shipped nothing.
    const flushMs = options.flushMs()
    const ignoreCadence = flushOptions.force === true || final
    const gapMs = flushMs - cadenceSlack(flushMs)
    const since = latestShipment()
    if (!ignoreCadence && since !== undefined) {
      const elapsed = now - since
      if (elapsed >= 0 && elapsed < gapMs) {
        return {
          buckets: 0,
          rows: 0,
          skipped: true,
          reason: 'cadence',
          nextEligibleInMs: gapMs - elapsed,
        }
      }
    }

    // added before the first `await`, so a flush called while this one waits
    // for its turn already sees it
    const entry = { at: now, seq: ++state.admitted }
    state.inFlight.add(entry)
    try {
      return await shipWithTurn(metric, entry, final, gapMs, flushOptions)
    } finally {
      state.inFlight.delete(entry)
    }
  }

  /**
   * When the flush let through last was let through, of the one that set
   * `lastFlushMs` and the ones still running, if there is any.
   */
  function latestShipment(): number | undefined {
    let latest = state.lastFlushMs
    let seq = state.lastFlushSeq
    for (const running of state.inFlight) {
      if (running.seq > seq) {
        latest = running.at
        seq = running.seq
      }
    }
    return latest
  }

  /** Record a flush that shipped, unless one let through after it already has. */
  function shipped(entry: Admitted): void {
    if (entry.seq < state.lastFlushSeq) return
    state.lastFlushMs = entry.at
    state.lastFlushSeq = entry.seq
  }

  /** Step 1's second half, the turn, then steps 2 to 5. */
  async function shipWithTurn(
    metric: AnyMetric,
    entry: Admitted,
    final: boolean,
    gapMs: number,
    flushOptions: FlushOptions,
  ): Promise<MetricFlushReport> {
    //    Then the turn every process sharing the driver keeps, since this
    //    process may not be the one that shipped last. `force` takes it with
    //    no gap, so the processes that keep to the cadence count from what it
    //    shipped. `final` waits for it like any flush when storage outlives
    //    this process, since whoever takes the next turn ships what it
    //    leaves, and takes it with no gap when storage does not.
    const now = entry.at
    const driver = options.sharedDriver?.()
    let turn: { readonly driver: Driver; readonly taken: ShipTurn & { granted: true } } | undefined
    if (driver?.capabilities.shared === true && driver.takeTurn !== undefined) {
      const waits = flushOptions.force !== true && (!final || driver.capabilities.durable)
      let taken: ShipTurn
      try {
        taken = await driver.takeTurn(options.name, now, waits ? gapMs : 0)
      } catch (error) {
        return { buckets: 0, rows: 0, skipped: false, error }
      }
      if (!taken.granted) {
        return {
          buckets: 0,
          rows: 0,
          skipped: true,
          reason: 'cadence',
          nextEligibleInMs: taken.lastTakenAt + gapMs - now,
        }
      }
      turn = { driver, taken }
    }

    const { report, wrote } = await ship(metric, entry, final)

    // a turn that wrote nothing, because nothing was closed or because the
    // sink failed, was not a shipment, for the same reason those leave
    // `lastFlushMs` alone. Given back on a best effort basis: failing to
    // means the fleet waits one interval before the next try, and the
    // flush's own failure, if it had one, is already in the report
    if (turn !== undefined && !wrote) {
      try {
        await turn.driver.returnTurn?.(options.name, turn.taken.turn, turn.taken.previous)
      } catch {
        // see above
      }
    }
    return report
  }

  /**
   * Steps 2 to 5, for a flush the cadence has let through. `wrote` says
   * whether any claim reached the sink and was written, which `rows` cannot:
   * it also counts the rows of a write that failed.
   */
  async function ship(
    metric: AnyMetric,
    entry: Admitted,
    final: boolean,
  ): Promise<{ report: MetricFlushReport; wrote: boolean }> {
    const now = entry.at
    // 2. recover. A batch claimed by a flusher that then died is already
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
    //    every other metric flushed.
    //
    //    One claim, unless it came back full. A metric with a `claimLimit`
    //    caps each claim, and with the turn every process shares, one claim
    //    per flush would cap what the whole fleet ships in an interval. So a
    //    claim that carried the limit is followed by another, until one
    //    carries less. A final flush claims again until one comes back empty,
    //    since a process that is stopping has no later flush to wait for.
    //    The cap stops either chasing records another process is still
    //    appending. A final flush on storage that ends with this process has
    //    no cap: what it left behind would be lost, and no other process
    //    appends to storage only this one can see.
    let buckets = 0
    let rows = 0
    const written = { buckets: 0, rows: 0 }
    let ackError: unknown

    /**
     * The report for a claim or a sink that failed, carrying what the
     * claims before it wrote and every ack that failed after them.
     */
    const failed = (error: unknown, releaseError?: unknown) => {
      if (written.rows > 0) shipped(entry)
      const report = {
        buckets,
        rows,
        skipped: false,
        error,
        ...(written.rows > 0 && { written }),
        ...(releaseError !== undefined && { releaseError }),
        ...(ackError !== undefined && { ackError }),
        ...repair,
      }
      return { report, wrote: written.rows > 0 }
    }

    const cap =
      final && options.outlivesProcess?.() === false ? Number.POSITIVE_INFINITY : CLAIM_CAP
    for (let claims = 0; claims < cap; claims++) {
      let outcome: ShipOutcome
      try {
        // what is claimable is the metric's judgement, not this file's
        const claim = await metric.claimBatch(now, { final })
        outcome = await shipClaim(metric, claim, options.sink(), { attempts, source: 'flush' })
      } catch (error) {
        return failed(error)
      }

      buckets += outcome.buckets
      rows += outcome.rows
      if (outcome.error !== undefined) return failed(outcome.error, outcome.releaseError)
      written.buckets += outcome.buckets
      written.rows += outcome.rows
      if (outcome.ackError !== undefined) ackError ??= outcome.ackError
      if (outcome.rows === 0) break
      const full = options.claimLimit !== undefined && outcome.rows >= options.claimLimit
      if (!final && !full) break
    }
    const wrote = written.rows > 0

    const settled = { ...repair, ...(ackError !== undefined && { ackError }) }

    if (rows === 0) {
      // deliberately does NOT advance lastFlushMs. The cadence bounds how
      // often this metric *ships*, and nothing shipped. Advancing here would
      // let an empty flush eat the cadence, so data that closed a second
      // later would then wait a full interval. The coarser the resolution,
      // the worse it gets, because early flushes always find the only bucket
      // still open.
      return { report: { buckets: 0, rows: 0, skipped: false, ...settled }, wrote }
    }

    shipped(entry)

    return { report: { buckets, rows, skipped: false, ...settled }, wrote }
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
  const registered = context.metrics
  const unmatched = unmatchedNames(options.only, registered)
  if (options.strict === true) assertMatched('house.flush', unmatched, registered)

  const metrics: Record<string, MetricFlushReport> = {}
  let ok = true

  for (const metric of registered) {
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
    unmatched,
    throwIfFailed(): void {
      if (ok) return
      const failed = Object.entries(metrics)
        .filter(([, report]) => report.error !== undefined)
        .map(([name]) => name)
      throw new Error(`flush failed for ${failed.join(', ')}`)
    },
  }
}

/**
 * The names in `only` that no metric in `registered` has, each once, in the
 * order they were given.
 *
 * A typo in `only` otherwise flushes or reads nothing and says nothing, which
 * looks like a quiet metric rather than a mistake.
 */
export function unmatchedNames(
  only: readonly string[] | undefined,
  registered: readonly AnyMetric[],
): string[] {
  if (only === undefined) return []
  const names = new Set(registered.map((metric) => metric.name))
  return [...new Set(only)].filter((name) => !names.has(name))
}

/**
 * Throw for a `strict` call whose `only` named a metric the house does not
 * hold.
 *
 * @throws naming every unmatched name and every registered metric
 */
export function assertMatched(
  label: string,
  unmatched: readonly string[],
  registered: readonly AnyMetric[],
): void {
  if (unmatched.length === 0) return
  const named = unmatched.map((name) => JSON.stringify(name)).join(', ')
  const which =
    unmatched.length === 1 ? 'which is not a registered metric' : 'which are not registered metrics'
  const held = registered.map((metric) => metric.name)
  throw new Error(
    `${label}: only names ${named}, ${which}` +
      (held.length > 0
        ? `. The registered metrics are [${held.join(', ')}]`
        : '. None is registered'),
  )
}
