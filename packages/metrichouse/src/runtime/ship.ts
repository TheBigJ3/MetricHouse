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

import { type Cell, type Claim, type Driver, isEmptyClaim } from '../drivers/types.js'
import type { AnyMetric, MetricKind, Row, WriteContext, WriteFn } from '../metrics/types.js'

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

/** What {@link shipOpenSeries} needs to turn one live series into a send. */
export interface OpenSeriesShip {
  readonly metric: string
  readonly kind: MetricKind
  readonly resolutionMs: number
  readonly driver: Driver
  /** The open bucket the write just landed in. */
  readonly bucketTs: number
  /** The one series that changed — not the whole bucket. */
  readonly dimKey: string
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly totalOf: (rows: readonly Row[]) => number
  readonly sink: WriteFn
}

/**
 * Ship one still-open series straight to the sink, claiming nothing.
 *
 * ```
 * read -> materialize -> write        no claim, no ack, nothing deleted
 * ```
 *
 * The counterpart to {@link shipClaim} for `delivery: 'immediate'` on a
 * bucketed metric, and deliberately **not** built on a claim. A claim moves
 * data out of the live set and an ack deletes it; do that to a bucket that is
 * still folding and the next send carries only what arrived since, while
 * carrying the same row id — which a store upserting on that id would take as
 * the new truth. Reading instead leaves the bucket live and accumulating, so
 * every send is the cumulative value and the last one wins correctly.
 *
 * It follows that there is nothing to release. A sink that throws leaves the
 * data exactly where it was: the next write to this series sends it again, and
 * `flush()` will ship it regardless once the bucket closes. The error is the
 * caller's to report — for a metric that is `onError`, because `.add()` has
 * already returned.
 *
 * Only the series that changed is read. The cost of immediate delivery scales
 * with writes, not with the cardinality of the metric.
 */
export async function shipOpenSeries(ship: OpenSeriesShip): Promise<void> {
  const bucketTo = ship.bucketTs + ship.resolutionMs

  const live = await ship.driver.readBuckets({
    metric: ship.metric,
    dimKey: ship.dimKey,
    from: ship.bucketTs,
    to: bucketTo,
  })

  // a concurrent flush claimed the bucket between the write and this read —
  // that flush owns the data now, and it ships the same id with the same fold
  if (live.length === 0) return

  const rows = live.map((row) => ship.materialize(row.bucketTs, row.dimKey, row.value))

  await ship.sink(rows, {
    metric: ship.metric,
    kind: ship.kind,
    bucketFrom: ship.bucketTs,
    bucketTo,
    total: ship.totalOf(rows),
    // nothing was claimed, so nothing can be retried — a resend is whatever
    // the next write produces, and it is a first attempt at that value
    attempt: 1,
    source: 'immediate',
  })
}
