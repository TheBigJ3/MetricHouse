/**
 * The opt-in scheduler, which turns `flush: '5m'` from a floor into a cadence.
 *
 * A metric's `flush` setting is a **minimum**: it bounds how often a metric is
 * willing to ship, and something still has to ask. On a long-lived process
 * that something can be a timer, and this is it. One interval per metric, at
 * that metric's own cadence, so a schema of forty metrics on nine different
 * cadences needs no cron entries and no coordination.
 *
 * ```
 * house.start()   ->  per metric, a first tick at its offset, then
 *                     setInterval(metric.flushMs)
 * house.stop()    ->  clear, wait for running ticks, drain, final flush
 * ```
 *
 * **Offset per metric, so a server's metrics do not all ship in one
 * second.** Timers armed together fire together, and forty metrics on
 * `flush: '1m'` would send forty inserts in the same moment every minute.
 * Each metric's first tick waits {@link firstTickDelay}, a fixed point
 * inside its interval worked out from its name. The same name gets the same
 * offset on every server, and none of it changes how often a metric ships:
 * that is still the cadence, and on a shared driver the turn.
 *
 * **Opt-in, and started by you, because a timer is not portable.** On Workers,
 * Vercel edge and Lambda the isolate is frozen the moment a response is
 * returned: an interval either never fires or is killed partway through a
 * write. That is the whole reason `createHouse` starts nothing on its own and
 * is safe to call at module scope. On those runtimes the pump is a cron
 * calling `house.flush()`, or a handler calling `metric.flush()`, and this
 * file is not involved.
 */

import { type AnyMetric, reportError } from '../metrics/types.js'

export interface SchedulerOptions {
  /** Read late: `register()` can add a metric after the scheduler is running. */
  readonly metrics: () => readonly AnyMetric[]
  /**
   * Where a failed tick goes.
   *
   * A scheduled flush has no caller to return a report to, since nobody is holding
   * the promise, so a sink that throws would otherwise be an unhandled
   * rejection or, worse, silence.
   */
  readonly onError?: (error: unknown, context: { metric: string }) => void
}

export interface Scheduler {
  readonly running: boolean
  /** Begin ticking. Idempotent: starting a running scheduler does nothing. */
  start(): void
  /** Schedule a metric registered after {@link start}. No-op while stopped. */
  add(metric: AnyMetric): void
  /**
   * Stop ticking, and resolve once every tick already running has finished.
   *
   * Waiting matters because a tick is a flush in progress. If it is still
   * inside the sink when the caller moves on to a final flush and then exits,
   * a failed write goes back to the driver after the final flush has already
   * looked, and a successful one is cut off when the process ends. Does not
   * flush.
   */
  stop(): Promise<void>
}

/**
 * How long after `start()` a metric's first tick fires: a point in
 * `[0, flushMs)` taken from a 32 bit FNV-1a hash of its name.
 *
 * A hash rather than a random draw, so a restart or another server puts the
 * metric at the same point, and a test can say where that is.
 */
export function firstTickDelay(name: string, flushMs: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % flushMs
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  /** metric -> the timer it is waiting on: its first tick's, then its interval. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Metrics whose tick has not returned yet.
   *
   * A sink slower than the cadence would otherwise stack ticks on top of each
   * other, and the second one claims what the first is still writing, which
   * is legal (the claims are disjoint) but doubles the pressure on the sink
   * exactly when it is already struggling. Skipping is the right answer: the
   * next tick is one interval away, and the data is not going anywhere.
   */
  const inFlight = new Map<string, Promise<void>>()
  let running = false

  async function run(metric: AnyMetric): Promise<void> {
    // with no handler a scheduled failure is an unhandled rejection, as a
    // failed write is. A handler that throws is raised the same way rather
    // than making this reject, so `stop()` still reaches its drain and its
    // final flush
    const report = (error: unknown) => reportError(options.onError, error, { metric: metric.name })
    try {
      const flushed = await metric.flush()
      if (flushed.error !== undefined) report(flushed.error)
      if (flushed.releaseError !== undefined) report(flushed.releaseError)
      // a failed recovery pass does not stop the flush below it, so it is not
      // `error`. A scheduled flush has no caller to read the report, and
      // this is the only place it can be heard
      if (flushed.recoveryError !== undefined) report(flushed.recoveryError)
    } catch (error) {
      // flush reports its own failures, so this is one it could not, such as
      // an unbound metric. Same destination: there is no caller to hand it to
      report(error)
    } finally {
      inFlight.delete(metric.name)
    }
  }

  function tick(metric: AnyMetric): void {
    if (inFlight.has(metric.name)) return
    // set before the first await inside `run`, so a second tick arriving
    // while this one is in the sink sees it and skips
    inFlight.set(metric.name, run(metric))
  }

  // metrics should not be the reason a process stays alive. A server is held
  // open by its listener; when that closes, a pending flush timer keeping the
  // process running would look like a hang. Node-only, hence the guard.
  function unref(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  }

  function schedule(metric: AnyMetric): void {
    if (timers.has(metric.name)) return

    const delay = firstTickDelay(metric.name, metric.flushMs)
    const first = setTimeout(() => {
      tick(metric)
      const interval = setInterval(() => {
        tick(metric)
      }, metric.flushMs)
      unref(interval)
      timers.set(metric.name, interval)
    }, delay)
    unref(first)

    timers.set(metric.name, first)
  }

  return {
    get running(): boolean {
      return running
    },

    start(): void {
      if (running) return
      running = true
      for (const metric of options.metrics()) schedule(metric)
    },

    add(metric: AnyMetric): void {
      if (!running) return
      schedule(metric)
    },

    async stop(): Promise<void> {
      running = false
      // clearTimeout clears an interval too, so one call covers a metric
      // still waiting on its first tick and one already ticking
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      // `run` never rejects, so this only waits
      await Promise.all([...inFlight.values()])
    },
  }
}
