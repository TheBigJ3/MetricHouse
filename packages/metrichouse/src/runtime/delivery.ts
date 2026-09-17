/**
 * Delivery — how a house gets rows out, as distinct from what a metric
 * measures.
 *
 * A metric declares **measurement**: resolution, dims, which aggregates it
 * keeps. Those decide what the data *means*, and they belong in the schema
 * file that travels between deployments. How that data reaches your `write()`
 * is a property of the **deployment**, not of the metric — a dev branch on the
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
 * - A **staged** kind — event, log — is complete the moment it is recorded, so
 *   immediate delivery claims it and ships it exactly as a flush would, just
 *   without waiting for one. The records leave the driver.
 * - A **bucketed** kind — counter, gauge, timer — is *not* complete: its bucket
 *   is still open and still folding. Immediate delivery ships the **cumulative**
 *   open bucket through the read path and deletes nothing, so each send carries
 *   a running total that supersedes the one before it. Shipping one row per
 *   `add()` would be silent corruption: {@link rowId} hashes the bucket and the
 *   dims and *not* the value, so every increment in a bucket mints the same id,
 *   and a store upserting on that id would keep the last `value: 1` it saw.
 *
 * That asymmetry means immediate delivery **replaces** flush for staged kinds
 * and **does not** for bucketed ones. A bucketed metric still needs `flush()`
 * to claim and delete its closed buckets, or they accumulate in the driver
 * forever. The final flush row carries the same id and the complete fold, so it
 * supersedes every partial send — the two paths converge rather than fight.
 *
 * Spec: initialPlan/08-house.md, 12-flush.md, 14-identity.md
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
 */
export interface HouseDefaults {
  readonly flushMs?: number
  readonly graceMs?: number
}

/**
 * Resolve the mode a metric is bound with. A metric never sees `'auto'`.
 */
export function resolveDelivery(
  config: DeliveryConfig | undefined,
  capabilities: DriverCapabilities,
): DeliveryMode {
  if (config === undefined) return 'staged'
  if (config !== 'auto') return config
  return capabilities.durable ? 'staged' : 'immediate'
}
