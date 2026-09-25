/**
 * The opt-in scheduler — what turns `flush: '5m'` from a floor into a cadence.
 *
 * A metric's `flush` setting is a **minimum**: it bounds how often a metric is
 * willing to ship, and something still has to ask. On a long-lived process
 * that something can be a timer, and this is it — one interval per metric, at
 * that metric's own cadence, so a schema of forty metrics on nine different
 * cadences needs no cron entries and no coordination.
 *
 * ```
 * house.start()   ->  setInterval(metric.flushMs) per metric
 * house.stop()    ->  clear, wait for running ticks, drain, final flush
 * ```
 *
 * **Opt-in, and started by you, because a timer is not portable.** On Workers,
 * Vercel edge and Lambda the isolate is frozen the moment a response is
 * returned: an interval either never fires or is killed partway through a
 * write. That is the whole reason `createHouse` starts nothing on its own and
 * is safe to call at module scope. On those runtimes the pump is a cron
 * calling `house.flush()`, or a handler calling `metric.flush()`, and this
 * file is not involved.
 */

import type { AnyMetric } from '../metrics/types.js'

export interface SchedulerOptions {
  /** Read late: `register()` can add a metric after the scheduler is running. */
  readonly metrics: () => readonly AnyMetric[]
  /**
   * Where a failed tick goes.
   *
   * A scheduled flush has no caller to return a report to — nobody is holding
   * the promise — so a sink that throws would otherwise be an unhandled
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

export function createScheduler(options: SchedulerOptions): Scheduler {
  const timers = new Map<string, ReturnType<typeof setInterval>>()
  /**
   * Metrics whose tick has not returned yet.
   *
   * A sink slower than the cadence would otherwise stack ticks on top of each
   * other, and the second one claims what the first is still writing — which
   * is legal (the claims are disjoint) but doubles the pressure on the sink
   * exactly when it is already struggling. Skipping is the right answer: the
   * next tick is one interval away, and the data is not going anywhere.
   */
  const inFlight = new Map<string, Promise<void>>()
  let running = false

  async function run(metric: AnyMetric): Promise<void> {
    try {
      const report = await metric.flush()
      if (report.error !== undefined) options.onError?.(report.error, { metric: metric.name })
    } catch (error) {
      // flush reports its own failures, so this is one it could not: an
      // unbound metric, or a release that failed. Same destination: there is
      // no caller to hand it to.
      options.onError?.(error, { metric: metric.name })
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

  function schedule(metric: AnyMetric): void {
    if (timers.has(metric.name)) return

    const timer = setInterval(() => {
      tick(metric)
    }, metric.flushMs)

    // metrics should not be the reason a process stays alive. A server is held
    // open by its listener; when that closes, a pending flush interval keeping
    // the process running would look like a hang. Node-only, hence the guard.
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()

    timers.set(metric.name, timer)
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
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
      // `run` never rejects, so this only waits
      await Promise.all([...inFlight.values()])
    },
  }
}
