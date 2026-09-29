/**
 * The house, the runtime instance.
 *
 * Binds a driver to your schema and exposes flush, snapshot and drain across
 * all of it. Metrics are inert declarations until a house registers them.
 *
 * A house is **somewhere to keep a set of metrics**, not the thing that ships
 * them. Each metric owns its cadence, its sink and its retry state, so
 * `metric.flush()` works alone; `house.flush()` is the loop over that for a
 * caller holding a whole schema, and `house.start()` is the optional timer
 * that pumps it for you on a long-lived process.
 *
 * `createHouse` opens no connections and starts no timers of its own. It uses
 * the driver you hand it, so it is safe to call at module scope, which is the
 * only thing that works on a runtime that re-runs module scope on every cold
 * start.
 */

import type { Driver } from '../drivers/types.js'
import { type AnyMetric, isMetric, SETTLE } from '../metrics/types.js'
import { bucketStart } from '../time/buckets.js'
import { type DurationInput, parseDuration, parseInterval } from '../time/duration.js'
import {
  type DeliveryConfig,
  type DeliveryMode,
  type HouseDefaults,
  resolveDelivery,
} from './delivery.js'
import {
  assertMatched,
  type FlushContext,
  type FlushReport,
  type HouseFlushOptions,
  runFlush,
  unmatchedNames,
} from './flush.js'
import type { LiveRow, SnapshotOptions } from './live.js'
import { createScheduler, type Scheduler } from './scheduler.js'

/** An array of metrics, or an imported schema module. */
export type SchemaInput = readonly AnyMetric[] | Record<string, unknown>

/**
 * Delivery settings this house supplies where a metric declares none.
 *
 * Durations, not milliseconds: this is the configuration surface, and it is
 * parsed once at `createHouse` so the write path never sees a string.
 */
export interface HouseDefaultsConfig {
  readonly flush?: DurationInput
  readonly grace?: DurationInput
}

export interface HouseSnapshotOptions extends SnapshotOptions {
  /** Restrict the snapshot to these metric names. */
  readonly only?: readonly string[]
  /**
   * Throw instead, before anything is read, when `only` names a metric this
   * house does not hold. Off by default, because a metric may be registered
   * later and a name for it is not a mistake.
   */
  readonly strict?: boolean
}

/** Live rows per metric, keyed by name, the same shape a flush report uses. */
export type HouseSnapshot = Record<string, LiveRow[]>

export interface HouseConfig {
  readonly driver: Driver
  readonly schema?: SchemaInput
  /**
   * How this house gets rows out. `'staged'` (the default) waits for
   * `flush()`, `'immediate'` ships as data arrives, `'auto'` asks the driver.
   *
   * A deployment setting, not a schema one: the same metrics run on a dev
   * branch against `memory()` and in production against Redis, and only one of
   * those has a reason to hold data back. See
   * [delivery.ts](./delivery.ts) for what each mode does to each storage model.
   */
  readonly delivery?: DeliveryConfig
  /** Cadence and grace for metrics that declare neither. */
  readonly defaults?: HouseDefaultsConfig
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  readonly onError?: (error: unknown, context: { metric: string }) => void
  readonly onWarn?: (message: string, context: { metric?: string }) => void
}

export interface House {
  /** How this house delivers, with `'auto'` already resolved. */
  readonly delivery: DeliveryMode
  /** Bind metrics declared after boot. */
  register(...metrics: AnyMetric[]): void
  metrics(): AnyMetric[]
  get(name: string): AnyMetric | undefined
  /**
   * Flush every registered metric to its own sink, in registration order.
   *
   * A fan-out over `metric.flush()` and nothing more. Each metric still
   * honours its own cadence, so calling this every ten seconds ships a
   * five-minute metric every five minutes. The convenience is that a cron
   * handler holding a whole schema does not have to loop.
   */
  flush(options?: HouseFlushOptions): Promise<FlushReport>

  /** Is the scheduler ticking? */
  readonly running: boolean

  /**
   * Start flushing each metric on its own cadence.
   *
   * Turns `flush: '5m'` from a floor into a schedule: one interval per metric,
   * at that metric's `flushMs`, so nothing else has to pump. Idempotent, and
   * a metric registered afterwards is scheduled as it arrives.
   *
   * **For a long-lived process only.** On Workers, Vercel edge and Lambda the
   * isolate is frozen between requests and the interval never fires. There,
   * keep calling `flush()` from a cron. Nothing starts on its own precisely so
   * that `createHouse` stays safe at module scope on those runtimes.
   */
  start(): void

  /**
   * Stop the scheduler and get everything out.
   *
   * Clears the intervals, waits for every flush still running however it was
   * started and drains the writes still on their way to the driver, taking
   * turns until a wait for flushes that follows a drain finds none, then
   * makes a final flush past this process's cadence and every grace period.
   * On shared durable storage that flush still waits for the turn every
   * process takes, and what it leaves ships with the next one. A call
   * while one is running returns the same promise, unless `start()` came in
   * between: that call clears the intervals again at once and runs its own
   * steps once the earlier call has finished. What it cannot ship is the open
   * bucket: it has not closed, and shipping a partial fold under the same
   * row id is the corruption `delivery: 'immediate'` exists to handle.
   */
  stop(): Promise<FlushReport>

  /**
   * Every registered metric's unflushed data, in one call.
   *
   * Options that only mean something to an aggregate are ignored by a staged
   * kind rather than rejected, so one set of them can be handed to a mixed
   * schema. Metrics are read in parallel: these are independent reads and a
   * dashboard is waiting on all of them.
   */
  snapshot(options?: HouseSnapshotOptions): Promise<HouseSnapshot>

  /**
   * Every metric's open bucket, the cheap dashboard call.
   *
   * Bucketed kinds only. A staged metric has no open bucket to report, so it is
   * absent from the result rather than present and empty, which would read as
   * "nothing happening" instead of "wrong question". `pending()` is what
   * counts an unshipped backlog.
   */
  current(): Promise<HouseSnapshot>

  /**
   * Resolve when every queued write has reached the driver.
   *
   * The only write guarantee on a runtime with no `SIGTERM`, where the isolate
   * freezes the moment the response is returned.
   */
  drain(): Promise<void>
}

function collect(schema: SchemaInput | undefined): AnyMetric[] {
  if (!schema) return []
  const values = Array.isArray(schema) ? schema : Object.values(schema)
  // a module that exports one metric under two names, `export { a as b }`,
  // lists it twice, and it is still one metric
  return [...new Set(values.filter(isMetric))]
}

export function createHouse(config: HouseConfig): House {
  const now = config.now ?? Date.now
  const registry = new Map<string, AnyMetric>()
  /** Set by `stop()` and cleared by `start()`. Metrics read it before arming a timer. */
  let stopped = false

  const scheduler: Scheduler = createScheduler({
    metrics: () => [...registry.values()],
    ...(config.onError && { onError: config.onError }),
  })

  // resolved once, at boot: `'auto'` is a question about the driver, and the
  // driver cannot change under a house
  const delivery: DeliveryMode = resolveDelivery(config.delivery, config.driver.capabilities)

  const defaults: HouseDefaults = {
    ...(config.defaults?.flush !== undefined && {
      flushMs: parseInterval(config.defaults.flush, 'createHouse: defaults.flush'),
    }),
    ...(config.defaults?.grace !== undefined && { graceMs: parseDuration(config.defaults.grace) }),
  }

  // said once, at boot: a driver that cannot survive a restart cannot honour
  // at-least-once, and the difference should not be discovered during an
  // incident
  if (!config.driver.capabilities.durable) {
    config.onWarn?.(
      'driver is not durable, so at-least-once degrades to best-effort, and a crash ' +
        'between claim and ack loses that window',
      {},
    )
  }

  // also said once: immediate delivery changes what a sink must do about
  // duplicate ids, and finding that out from a wrong dashboard is worse than
  // hearing it at boot
  if (delivery === 'immediate') {
    config.onWarn?.(
      "delivery is 'immediate', so bucketed rows are resent as their bucket fills. The sink " +
        'must keep the newest row per id rather than fold duplicates together. Staged kinds ' +
        'ship without flush(); bucketed kinds still need it to retire closed buckets',
      {},
    )
  }

  /**
   * Say at boot when a durable event cannot get the promise it asks for.
   *
   * Warned rather than refused, so the same schema runs in a test against
   * `memory()`. A record then resolves once it is in this process's memory,
   * which a crash takes with it.
   */
  function warnIfDurableIsNot(metric: AnyMetric): void {
    if (!('durability' in metric) || metric.durability !== 'durable') return
    if (config.driver.capabilities.durable) return
    config.onWarn?.(
      `${metric.name}: durability is 'durable', but the driver cannot survive a restart, so ` +
        'record() resolves once the record is staged and a crash still loses it',
      { metric: metric.name },
    )
  }

  /**
   * Bind every metric, or none of them.
   *
   * All or nothing because a bound metric cannot be bound again: if the
   * fourth metric in a schema failed and the first three stayed bound, fixing
   * the fourth and calling `createHouse` again would fail on the first three.
   * So every check that can be made up front is made first, and a bind that
   * still throws undoes the ones before it.
   */
  function register(...metrics: AnyMetric[]): void {
    const incoming = [...new Set(metrics)].filter((metric) => registry.get(metric.name) !== metric)

    const names = new Map<string, AnyMetric>()
    for (const metric of incoming) {
      const existing = registry.get(metric.name) ?? names.get(metric.name)
      if (existing && existing !== metric) {
        throw new Error(`createHouse: two metrics are both named ${JSON.stringify(metric.name)}`)
      }
      if (metric.isBound) {
        throw new Error(
          `${metric.name}: already bound to a house, and a metric belongs to exactly one`,
        )
      }
      names.set(metric.name, metric)
    }

    const bound: AnyMetric[] = []
    try {
      for (const metric of incoming) {
        metric.bind({
          driver: config.driver,
          now,
          delivery,
          defaults,
          // named, not captured: `register` can add a derive target after the
          // event that names it, and a lazy lookup is what makes that legal
          resolve: (target) => registry.get(target),
          stopped: () => stopped,
          ...(config.onError && { onError: config.onError }),
        })
        bound.push(metric)
      }
    } catch (error) {
      for (const metric of bound) metric.unbind()
      throw error
    }

    for (const metric of incoming) {
      warnIfDurableIsNot(metric)
      registry.set(metric.name, metric)
      // a metric added while the scheduler is running gets its interval now,
      // rather than at the next start() that may never come
      scheduler.add(metric)
    }
  }

  register(...collect(config.schema))

  const flushContext: FlushContext = {
    now,
    get metrics(): AnyMetric[] {
      return [...registry.values()]
    },
  }

  /**
   * Calls to `house.flush()` that have not returned yet.
   *
   * A house flush visits its metrics one at a time, so while `stop()` waits
   * for one metric's flush, the same house flush can still start the next.
   * `stop()` waits for these as well as for each metric's own flushes.
   */
  const houseFlushes = new Set<Promise<FlushReport>>()

  /**
   * Resolve once no house flush and no metric flush is running, `true` when
   * there was one to wait for.
   *
   * Passes repeat until one finds nothing to wait for. A pass that waited may
   * have let a house flush move on to a metric whose wait had resolved
   * earlier in that pass, and the next pass catches that flush.
   */
  async function settleFlushes(): Promise<boolean> {
    let waitedAtAll = false
    for (;;) {
      if (houseFlushes.size > 0) {
        waitedAtAll = true
        await Promise.allSettled([...houseFlushes])
        continue
      }
      const waited = await Promise.all(
        [...registry.values()].map((metric) => metric[SETTLE]?.() ?? false),
      )
      if (houseFlushes.size === 0 && !waited.includes(true)) return waitedAtAll
      waitedAtAll = true
    }
  }

  /**
   * Resolve once no flush is running and no write is on its way to the
   * driver.
   *
   * A write may be issued while a flush is waited for, and a flush may start
   * while the writes drain, so the two waits take turns until a wait for
   * flushes that follows a drain finds none.
   */
  async function settleEverything(): Promise<void> {
    // the flushes first: a tick or a cron still inside its sink puts its rows
    // back if it fails, and the final flush is what ships them
    await settleFlushes()
    for (;;) {
      // a write still in flight to the driver is not yet claimable, and
      // flushing before it lands would leave it behind in a process that is
      // about to exit
      await Promise.all([...registry.values()].map((metric) => metric.drain()))
      if (!(await settleFlushes())) return
    }
  }

  /**
   * The `stop()` in progress, which a second call joins rather than repeats.
   * `start()` forgets it, so a `stop()` after a restart stops the scheduler
   * that restart started.
   */
  let stopping: Promise<FlushReport> | undefined
  /**
   * Resolves once the latest shutdown has finished, however it ended. The
   * next one waits for it, so two shutdowns never run their steps at once.
   */
  let lastShutdown: Promise<void> = Promise.resolve()

  function shutdown(): Promise<FlushReport> {
    // first, so a send that fails while stopping arms no retry timer
    stopped = true
    // cleared now rather than after an earlier shutdown, so no interval a
    // `start()` armed in between is left running. What it returns waits for
    // a tick still inside its sink
    const ticks = scheduler.stop()
    const earlier = lastShutdown
    let finished = (): void => {}
    lastShutdown = new Promise<void>((resolve) => {
      finished = resolve
    })

    // assigned before its body gets past the first `await`, which is when the
    // `finally` below can first compare against it
    let run: Promise<FlushReport> | undefined
    run = (async () => {
      try {
        await earlier
        await ticks
        // then every other flush still running, a cron's `house.flush()` with
        // metrics still to visit or a direct `metric.flush()`, and every
        // write. The flushes' failures are already in their own reports, so
        // only the waiting matters here
        await settleEverything()
        // final, so windows still inside grace go too. Only the open window
        // is left, which is the one thing a stopping process cannot finish.
        // Not forced: on shared durable storage a final flush waits for the
        // turn, and what it leaves ships with whoever takes the next one
        return await runFlush(flushContext, { final: true })
      } finally {
        if (stopping === run) stopping = undefined
        finished()
      }
    })()
    return run
  }

  return {
    delivery,

    register,

    metrics(): AnyMetric[] {
      return [...registry.values()]
    },

    get(name: string): AnyMetric | undefined {
      return registry.get(name)
    },

    flush(options?: HouseFlushOptions): Promise<FlushReport> {
      // the tracked chain is what the caller gets, so a flush nobody awaits
      // that rejects, a strict one naming an unknown metric, is still an
      // unhandled rejection rather than swallowed by the bookkeeping
      const tracked: Promise<FlushReport> = runFlush(flushContext, options).finally(() => {
        houseFlushes.delete(tracked)
      })
      houseFlushes.add(tracked)
      return tracked
    },

    get running(): boolean {
      return scheduler.running
    },

    start(): void {
      stopped = false
      stopping = undefined
      scheduler.start()
    },

    stop(): Promise<FlushReport> {
      // a second call while one is running, from a SIGINT and a SIGTERM
      // handler both, waits for the same final flush rather than making one
      // of its own that finds everything already claimed
      stopping ??= shutdown()
      return stopping
    },

    async snapshot(options: HouseSnapshotOptions = {}): Promise<HouseSnapshot> {
      const { only, strict, ...perMetric } = options
      if (strict === true) {
        const registered = [...registry.values()]
        assertMatched('house.snapshot', unmatchedNames(only, registered), registered)
      }
      const wanted = [...registry.values()].filter(
        (metric) => only === undefined || only.includes(metric.name),
      )

      const snapshot: HouseSnapshot = {}
      await Promise.all(
        wanted.map(async (metric) => {
          snapshot[metric.name] = await metric.snapshot(perMetric)
        }),
      )
      return snapshot
    },

    async current(): Promise<HouseSnapshot> {
      const nowMs = now()
      const bucketed = [...registry.values()].filter((metric) => metric.storage === 'bucketed')

      const snapshot: HouseSnapshot = {}
      await Promise.all(
        bucketed.map(async (metric) => {
          // each metric's own resolution decides which bucket is open, so the
          // lower bound is per metric rather than one shared timestamp
          snapshot[metric.name] = await metric.snapshot({
            complete: false,
            from: bucketStart(nowMs, metric.resolutionMs),
          })
        }),
      )
      return snapshot
    },

    async drain(): Promise<void> {
      await Promise.all([...registry.values()].map((metric) => metric.drain()))
    },
  }
}
