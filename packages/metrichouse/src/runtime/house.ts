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
import type { MetricFlushState } from './flush.js'
import { type FlushContext, type FlushOptions, type FlushReport, runFlush } from './flush.js'

/** An array of metrics, or an imported schema module. */
export type SchemaInput = readonly AnyMetric[] | Record<string, unknown>

export interface HouseConfig {
  readonly driver: Driver
  readonly schema?: SchemaInput
  /** Fallback sink for metrics that do not declare their own. */
  readonly write?: WriteFn
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  readonly onError?: (error: unknown, context: { metric: string }) => void
  readonly onWarn?: (message: string, context: { metric?: string }) => void
}

export interface House {
  /** Bind metrics declared after boot. */
  register(...metrics: AnyMetric[]): void
  metrics(): AnyMetric[]
  get(name: string): AnyMetric | undefined
  flush(options?: FlushOptions): Promise<FlushReport>
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

    async drain(): Promise<void> {
      await Promise.all([...registry.values()].map((metric) => metric.drain()))
    },
  }
}
