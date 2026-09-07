/**
 * One claim, all the way to the sink and back.
 *
 * ```
 * claim -> materialize -> write
 *                           |
 *         ok -> ack   fail -> release
 * ```
 *
 * Extracted because there are two callers, not one: `house.flush()` ships on a
 * cadence, and a locally staged event ships itself the moment `batch.maxSize`
 * is reached — nobody calls flush for that one. Both have to delete after the
 * write and only after it, and having that rule written down twice is how the
 * two eventually disagree.
 *
 * Nothing here knows what a bucket is. The metric claimed the data and the
 * metric turns it into rows; this is only the part that must not get the order
 * wrong.
 *
 * Spec: initialPlan/12-flush.md
 */

import { type Claim, isEmptyClaim } from '../drivers/types.js'
import type { AnyMetric, WriteContext, WriteFn } from '../metrics/types.js'

export interface ShipOutcome {
  readonly buckets: number
  readonly rows: number
  /** Set when the sink threw. The claim has been released by then. */
  readonly error?: unknown
}

/**
 * Materialize a claim, hand it to the sink, then settle it.
 *
 * An empty claim is acked without calling the sink — a sink is a network call
 * and there is nothing to send. `release` failing is not swallowed: it means
 * the data is neither shipped nor back in the live set, which is the one
 * situation worth an exception rather than a report field.
 */
export async function shipClaim(
  metric: AnyMetric,
  claim: Claim,
  sink: WriteFn,
  options: { attempt: number; source: WriteContext['source'] },
): Promise<ShipOutcome> {
  if (isEmptyClaim(claim)) {
    await metric.ackBatch(claim)
    return { buckets: 0, rows: 0 }
  }

  const batch = metric.materializeClaim(claim)

  try {
    await sink(batch.rows, {
      metric: metric.name,
      kind: metric.kind,
      bucketFrom: batch.bucketFrom,
      bucketTo: batch.bucketTo,
      total: batch.total,
      attempt: options.attempt,
      source: options.source,
    })
  } catch (error) {
    // the data becomes claimable again, unchanged and with the same row ids
    await metric.releaseBatch(claim)
    return { buckets: batch.buckets, rows: batch.rows.length, error }
  }

  // only now is anything deleted
  await metric.ackBatch(claim)
  return { buckets: batch.buckets, rows: batch.rows.length }
}
