/**
 * The house — the runtime instance.
 *
 * Binds a driver to your schema, holds the global fallback sink, and exposes
 * flush and drain. Metrics are inert declarations until a house registers
 * them.
 *
 * `createHouse` opens no connections of its own — it uses the driver you hand
 * it — so it is safe to call at module scope, which is the only thing that
 * works on a runtime that re-runs module scope on every cold start.
 *
 * Spec: initialPlan/08-house.md
 */

import type { Driver } from '../drivers/types.js'
import { type AnyMetric, isMetric, type WriteFn } from '../metrics/types.js'
import { bucketStart } from '../time/buckets.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import {
  type DeliveryConfig,
  type DeliveryMode,
  type HouseDefaults,
  resolveDelivery,
} from './delivery.js'
import type { MetricFlushState } from './flush.js'
import { type FlushContext, type FlushOptions, type FlushReport, runFlush } from './flush.js'
import type { LiveRow, SnapshotOptions } from './live.js'

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
}

/** Live rows per metric, keyed by name — the same shape a flush report uses. */
export type HouseSnapshot = Record<string, LiveRow[]>

export interface HouseConfig {
  readonly driver: Driver
  readonly schema?: SchemaInput
  /** Fallback sink for metrics that do not declare their own. */
  readonly write?: WriteFn
  /**
   * How this house gets rows out — `'staged'` (the default) waits for
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
  flush(options?: FlushOptions): Promise<FlushReport>

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
   * Every metric's open bucket — the cheap dashboard call.
   *
   * Bucketed kinds only. A staged metric has no open bucket to report, so it is
   * absent from the result rather than present and empty, which would read as
   * "nothing happening" instead of "wrong question" — `pending()` is what
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
  return values.filter(isMetric)
}

export function createHouse(config: HouseConfig): House {
  const now = config.now ?? Date.now
  const registry = new Map<string, AnyMetric>()
  const flushState = new Map<string, MetricFlushState>()

  // resolved once, at boot: `'auto'` is a question about the driver, and the
  // driver cannot change under a house
  const delivery: DeliveryMode = resolveDelivery(config.delivery, config.driver.capabilities)

  const defaults: HouseDefaults = {
    ...(config.defaults?.flush !== undefined && { flushMs: parseDuration(config.defaults.flush) }),
    ...(config.defaults?.grace !== undefined && { graceMs: parseDuration(config.defaults.grace) }),
  }

  // said once, at boot: a driver that cannot survive a restart cannot honour
  // at-least-once, and the difference should not be discovered during an
  // incident
  if (!config.driver.capabilities.durable) {
    config.onWarn?.(
      'driver is not durable — at-least-once degrades to best-effort, and a crash ' +
        'between claim and ack loses that window',
      {},
    )
  }

  // also said once: immediate delivery changes what a sink must do about
  // duplicate ids, and finding that out from a wrong dashboard is worse than
  // hearing it at boot
  if (delivery === 'immediate') {
    config.onWarn?.(
      "delivery is 'immediate' — bucketed rows are resent as their bucket fills, so the sink " +
        'must keep the newest row per id rather than fold duplicates together. Staged kinds ' +
        'ship without flush(); bucketed kinds still need it to retire closed buckets',
      {},
    )
  }

  function register(...metrics: AnyMetric[]): void {
    for (const metric of metrics) {
      const existing = registry.get(metric.name)
      if (existing && existing !== metric) {
        throw new Error(`createHouse: two metrics are both named ${JSON.stringify(metric.name)}`)
      }

      // throws if the metric already belongs to another house
      metric.bind({
        driver: config.driver,
        now,
        delivery,
        defaults,
        // named, not captured: `register` can add a derive target after the
        // event that names it, and a lazy lookup is what makes that legal
        resolve: (target) => registry.get(target),
        ...(config.onError && { onError: config.onError }),
        ...(config.write && { write: config.write }),
      })
      registry.set(metric.name, metric)
    }
  }

  register(...collect(config.schema))

  const flushContext: FlushContext = {
    now,
    get metrics(): AnyMetric[] {
      return [...registry.values()]
    },
    sinkFor: (metric) => metric.write ?? config.write,
    state: flushState,
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

    flush(options?: FlushOptions): Promise<FlushReport> {
      return runFlush(flushContext, options)
    },

    async snapshot(options: HouseSnapshotOptions = {}): Promise<HouseSnapshot> {
      const { only, ...perMetric } = options
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
