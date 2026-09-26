/**
 * Delivery. How a house gets rows out, as distinct from what a metric
 * measures.
 *
 * A metric declares **measurement**: resolution, dims, which aggregates it
 * keeps. Those decide what the data *means*, and they belong in the schema
 * file that travels between deployments. How that data reaches your `write()`
 * is a property of the **deployment**, not of the metric. A dev branch on the
 * memory driver and a production fleet on Redis run the same schema and want
 * opposite answers.
 *
 * ```
 * staged     add() -> driver -> flush() claims -> write()    the default
 * immediate  add() -> driver -> write(), now                 nobody calls flush()
 * ```
 *
 * **The two storage models diverge here**, and the difference is not cosmetic:
 *
 * - A **staged** kind (event, log) is complete the moment it is recorded, so
 *   immediate delivery claims it and ships it exactly as a flush would, just
 *   without waiting for one. The records leave the driver.
 * - A **bucketed** kind (counter, gauge, timer) is *not* complete: its bucket
 *   is still open and still folding. Immediate delivery ships the **cumulative**
 *   open bucket through the read path and deletes nothing, so each send carries
 *   a running total that supersedes the one before it. Shipping one row per
 *   `add()` would be silent corruption: {@link rowId} hashes the bucket and the
 *   dims and *not* the value, so every increment in a bucket mints the same id,
 *   and a store upserting on that id would keep the last `value: 1` it saw.
 *
 * That asymmetry means immediate delivery **replaces** flush for staged kinds
 * and **does not** for bucketed ones. A bucketed metric still needs
 * `metric.flush()`, from a scheduler tick, a cron, or `house.flush()`, to
 * claim and delete its closed buckets, or they accumulate in the driver
 * forever. The final flush row carries the same id and the complete fold, so it
 * supersedes every partial send, and the two paths converge rather than fight.
 */

import type { DriverCapabilities } from '../drivers/types.js'

/** How a metric's data reaches the sink, once a house has resolved it. */
export type DeliveryMode = 'staged' | 'immediate'

/**
 * What a house accepts.
 *
 * `'auto'` asks the driver. A driver that cannot survive a restart holds data
 * at risk for no benefit, so there is nothing to gain by waiting for a flush
 * and a loss window to close by shipping now.
 */
export type DeliveryConfig = DeliveryMode | 'auto'

/**
 * Delivery settings a house supplies where a metric stays silent.
 *
 * Filled in, never overridden: a metric that declares `flush: '5m'` because it
 * carries money keeps it whatever the house says. Delivery *mode* is the one
 * thing a house overrides outright, because "this runtime cannot flush" is a
 * fact about the deployment that a schema file has no standing to contradict.
 *
 * A sink is **not** on this list. Where a metric's rows go is part of what the
 * metric is, not of how the deployment delivers it, so `write` is declared on
 * the metric and required there.
 */
export interface HouseDefaults {
  readonly flushMs?: number
  readonly graceMs?: number
}

/**
 * Resolve the mode a metric is bound with. A metric never sees `'auto'`.
 *
 * @throws for a value that is none of the three. It often comes from an
 * environment variable, where TypeScript cannot check it, and a typo would
 * otherwise behave as `'staged'` while the house reported the typo.
 */
export function resolveDelivery(
  config: DeliveryConfig | undefined,
  capabilities: DriverCapabilities,
): DeliveryMode {
  if (config === undefined || config === 'staged') return 'staged'
  if (config === 'immediate') return 'immediate'
  if (config === 'auto') return capabilities.durable ? 'staged' : 'immediate'
  throw new Error(
    `createHouse: delivery must be 'staged', 'immediate' or 'auto', got ${JSON.stringify(config)}`,
  )
}
