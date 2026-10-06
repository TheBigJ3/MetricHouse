/**
 * Collect. A callback a gauge or a level runs a little before each of its
 * windows closes, to copy in a value that lives somewhere else.
 *
 * A queue depth kept in your own Redis keys, a pool size another library
 * reports, a row count in a table: the value already exists, and what it
 * needs is to be read once per window and written to the metric while that
 * window is still open. Without this, every such metric needs a timer of its
 * own, armed by hand and cleared by hand at shutdown.
 *
 * ```
 * house.start()   ->  per metric with collect, a timer at each window's end
 *                     minus collectLead, re-armed after every run
 * metric.flush()  ->  without start(), collect first, once per window
 * house.stop()    ->  collect once more, drain, then the final flush
 * ```
 *
 * **Once per window, in this process.** Whatever asks, a timer, a flush, a
 * stop, the window open at that moment is collected at most once. A collect
 * still running when the next one is due is skipped rather than stacked.
 *
 * **Once per window, across a fleet, when the driver is shared.** Every
 * server runs the same code, and a queue depth read by ten of them is the
 * same number written ten times. `collectScope: 'fleet'` takes a turn from
 * the driver first, the same turn a flush takes, under a key no metric can
 * have, so one process per window runs it.
 */

import type { Driver } from '../drivers/types.js'
import { type Collector, type MetricBinding, reportError } from '../metrics/types.js'
import { bucketStart } from '../time/buckets.js'
import { type DurationInput, formatDuration, parseDuration } from '../time/duration.js'
import type { FlushOptions } from './flush.js'

/** Who runs collect each window. See {@link CollectOptions.collectScope}. */
export type CollectScope = 'fleet' | 'process'

/** The collect settings a gauge or a level accepts. `M` is the metric itself. */
export interface CollectOptions<M> {
  /**
   * Called a little before each window of the metric closes, with the metric,
   * so the writes it makes land in the window that is closing. A throw or a
   * rejection goes to the house's `onError` and stops nothing else.
   */
  readonly collect?: (metric: M) => void | Promise<void>
  /**
   * How long before the end of each window to call `collect`. Default: one
   * second, or a tenth of the resolution when that is shorter. Has to be
   * longer than zero and shorter than the resolution.
   */
  readonly collectLead?: DurationInput
  /**
   * `'fleet'` (the default): on a shared driver, one process per window runs
   * collect. `'process'`: every process runs it every window. On a driver
   * that is not shared the two are the same.
   */
  readonly collectScope?: CollectScope
}

/**
 * Appended to a metric's name to make the key its collect turn is kept
 * under. A metric name may not hold a colon, so no metric's own flush turn is
 * ever kept under the same key.
 */
export const COLLECT_TURN_SUFFIX = ':collect'

/** The longest default lead, one second. */
const MAX_DEFAULT_LEAD_MS = 1_000

/**
 * The lead a metric gets when it declares none: one second, or a tenth of
 * the resolution when that is shorter, so a `100ms` window is collected 10ms
 * before it ends rather than before it starts.
 */
export function defaultCollectLead(resolutionMs: number): number {
  return Math.min(MAX_DEFAULT_LEAD_MS, resolutionMs / 10)
}

/** What a collector reads from the metric it belongs to. */
export interface CollectorHost<M> {
  readonly name: string
  readonly resolutionMs: number
  isBound(): boolean
  /** The binding. Called only once {@link isBound} is true. */
  active(): MetricBinding
  /** The finished metric, handed to `collect`. */
  self(): M
}

/**
 * Check the collect settings and build the collector, or return `undefined`
 * when the metric declares no `collect`.
 *
 * @throws naming the metric, for a `collect` that is not a function, a lead
 * that does not parse, is zero, or is not shorter than the resolution, an
 * unknown scope, and a lead or a scope given without `collect`
 */
export function createCollector<M>(
  host: CollectorHost<M>,
  options: CollectOptions<M>,
): Collector | undefined {
  const { name, resolutionMs } = host
  const { collect, collectLead, collectScope } = options

  if (collect === undefined) {
    for (const [setting, value] of [
      ['collectLead', collectLead],
      ['collectScope', collectScope],
    ] as const) {
      if (value !== undefined) {
        throw new Error(`${name}: ${setting} is set, but collect is not, so nothing would run`)
      }
    }
    return undefined
  }
  if (typeof collect !== 'function') {
    throw new Error(`${name}: collect must be a function, got ${typeof collect}`)
  }
  const callback = collect

  const scope: CollectScope = collectScope ?? 'fleet'
  if (scope !== 'fleet' && scope !== 'process') {
    throw new Error(
      `${name}: collectScope must be 'fleet' or 'process', got ${JSON.stringify(scope)}`,
    )
  }

  const leadMs = collectLead === undefined ? defaultCollectLead(resolutionMs) : parseLead()
  function parseLead(): number {
    let ms: number
    try {
      ms = parseDuration(collectLead as DurationInput)
    } catch (error) {
      throw new Error(`${name}: collectLead: ${(error as Error).message}`)
    }
    if (ms === 0) {
      throw new Error(
        `${name}: collectLead must be longer than zero, got ${JSON.stringify(collectLead)}`,
      )
    }
    // a resolution that is not positive is refused on its own terms, with
    // its own message, when the metric is declared or bound
    if (resolutionMs > 0 && ms >= resolutionMs) {
      throw new Error(
        `${name}: collectLead is ${formatDuration(ms)}, and it must be shorter than the ` +
          `resolution, ${formatDuration(resolutionMs)}, so that collect runs inside the ` +
          'window it writes to',
      )
    }
    return ms
  }

  const turnKey = `${name}${COLLECT_TURN_SUFFIX}`
  /**
   * The window the last collect in this process was for. Compared for
   * equality rather than order, so a clock that steps backwards collects
   * again straight away rather than waiting to catch up.
   */
  let lastWindow: number | undefined
  /** The collect still running, which the next one skips rather than joins. */
  let running: Promise<void> | undefined

  /**
   * Run `collect` for `window`, after taking the fleet's turn for it when
   * the driver is shared. Never rejects: a failure goes to `onError`.
   */
  async function collectFor(binding: MetricBinding, window: number): Promise<void> {
    try {
      const driver: Driver = binding.driver
      if (scope === 'fleet' && driver.capabilities.shared && driver.takeTurn !== undefined) {
        // stamped with the window rather than the clock, so every process
        // asking about one window asks with the same number, and a gap of one
        // resolution refuses everything but the first of them
        const taken = await driver.takeTurn(turnKey, window, resolutionMs)
        if (!taken.granted) return
      }
      await callback(host.self())
    } catch (error) {
      reportError(binding.onError, error, { metric: name })
    }
  }

  /** Called on a bound metric only: by its timer, by `house.stop()`, and by {@link beforeFlush}. */
  function run(): Promise<void> {
    // skipped rather than stacked: two reads of the same source racing each
    // other write two values into one window, and the slow one is usually a
    // source that is struggling already
    if (running !== undefined) return Promise.resolve()
    const binding = host.active()
    const window = bucketStart((binding.now ?? Date.now)(), resolutionMs)
    if (window === lastWindow) return Promise.resolve()
    // before the first await, so a second call in the same tick sees it
    lastWindow = window
    const work: Promise<void> = collectFor(binding, window).finally(() => {
      if (running === work) running = undefined
    })
    running = work
    return work
  }

  return {
    leadMs,
    scope,

    delay(): number {
      const binding = host.active()
      const now = (binding.now ?? Date.now)()
      let at = bucketStart(now, resolutionMs) + resolutionMs - leadMs
      // strictly after now, so a timer that has just fired, or one whose run
      // was skipped, is armed for the next window rather than this one again
      if (at <= now) at += resolutionMs
      return at - now
    },

    run,

    beforeFlush(options: FlushOptions): Promise<void> {
      // an unbound metric has no driver to write to and no clock to read.
      // Its flush throws next, with the message that says so
      if (!host.isBound()) return Promise.resolve()
      // with the scheduler running, its timers collect, near each window's
      // end. A final flush leaves it to `house.stop()`, which collects and
      // drains before it, so a stopping process does not exit with a write
      // still on its way
      if (host.active().scheduled?.() === true || options.final === true) {
        return Promise.resolve()
      }
      return run()
    },

    async idle(): Promise<void> {
      while (running !== undefined) await running
    },
  }
}
