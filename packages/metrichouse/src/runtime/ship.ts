/**
 * One claim, all the way to the sink and back.
 *
 * ```
 * claim -> materialize -> write
 *                           |
 *         ok -> ack   fail -> release
 * ```
 *
 * Extracted because there are two callers, not one: `metric.flush()` ships on a
 * cadence, and a locally staged event ships itself the moment `batch.maxSize`
 * is reached, and nobody calls flush for that one. Both have to delete after the
 * write and only after it, and having that rule written down twice is how the
 * two eventually disagree.
 *
 * Nothing here knows what a bucket is. The metric claimed the data and the
 * metric turns it into rows; this is only the part that must not get the order
 * wrong.
 */

import {
  type BucketRow,
  type Cell,
  type Claim,
  type Driver,
  isEmptyClaim,
} from '../drivers/types.js'
import type {
  AnyMetric,
  MaterializedBatch,
  MetricKind,
  Row,
  WriteContext,
  WriteFn,
} from '../metrics/types.js'
import type { Attempts } from './flush.js'

/**
 * What a sink threw, or an error saying it threw nothing.
 *
 * `Promise.reject()` rejects with `undefined`, and a report whose `error` is
 * `undefined` reads as a success. The rows would be released and the flush
 * counted as done, so the next one waits a full cadence for no reason.
 */
function sinkFailure(metric: string, thrown: unknown): unknown {
  return thrown === undefined ? new Error(`${metric}: the sink rejected without a reason`) : thrown
}

export interface ShipOutcome {
  readonly buckets: number
  readonly rows: number
  /** Set when the sink threw. The claim has been released by then, unless `releaseError` is set. */
  readonly error?: unknown
  /**
   * Set when the sink threw and putting the rows back failed as well. The
   * rows are still held in the claim, where recovery finds them on a durable
   * driver. Kept apart from `error`, so the sink's own failure is not lost.
   */
  readonly releaseError?: unknown
  /**
   * Set when the sink succeeded and the ack after it failed. The rows were
   * written; the claim was usually taken back by another flusher first.
   */
  readonly ackError?: unknown
}

/**
 * Materialize a claim, hand it to the sink, then settle it.
 *
 * An empty claim is acked without calling the sink, because a sink is a
 * network call and there is nothing to send. A `release` that fails after the
 * sink did is reported as `releaseError`, beside the sink's error rather than
 * in place of it: the data is neither shipped nor back in the live set, and
 * both facts are worth knowing.
 */
export async function shipClaim(
  metric: AnyMetric,
  claim: Claim,
  sink: WriteFn,
  options: { attempts: Attempts; source: WriteContext['source'] },
): Promise<ShipOutcome> {
  if (isEmptyClaim(claim)) return settle(metric, claim, { buckets: 0, rows: 0 })

  // inside the try with the sink: a claim that cannot be turned into rows has
  // to go back to the live set exactly as a failed write does, or its data is
  // left in a claim that nothing will ever settle
  let batch: MaterializedBatch | undefined
  try {
    batch = metric.materializeClaim(claim)
    await sink(batch.rows, {
      metric: metric.name,
      kind: metric.kind,
      bucketFrom: batch.bucketFrom,
      bucketTo: batch.bucketTo,
      total: batch.total,
      attempt: options.attempts.current,
      source: options.source,
    })
  } catch (thrown) {
    // counted before the release, so a send that picks these rows up the
    // moment they are back already sees the failure
    options.attempts.current += 1
    const failed = {
      buckets: batch?.buckets ?? 0,
      rows: batch?.rows.length ?? 0,
      error: sinkFailure(metric.name, thrown),
    }
    // the data becomes claimable again, unchanged and with the same row ids
    try {
      await metric.releaseBatch(claim)
    } catch (releaseError) {
      return { ...failed, releaseError }
    }
    return failed
  }

  options.attempts.current = 1

  // only now is anything deleted
  return settle(metric, claim, { buckets: batch.buckets, rows: batch.rows.length })
}

/**
 * Ack a claim whose rows are written, or that had none.
 *
 * A failed ack is reported beside the counts rather than as a failure: the
 * rows are in the sink by now, and only the claim is left unsettled.
 */
async function settle(
  metric: AnyMetric,
  claim: Claim,
  shipped: { buckets: number; rows: number },
): Promise<ShipOutcome> {
  try {
    await metric.ackBatch(claim)
  } catch (ackError) {
    return { ...shipped, ackError }
  }
  return shipped
}

/** What {@link shipOpenSeries} needs to turn one live series into a send. */
export interface OpenSeriesShip {
  readonly metric: string
  readonly kind: MetricKind
  readonly resolutionMs: number
  readonly driver: Driver
  /** The open bucket the write just landed in. */
  readonly bucketTs: number
  /** The one series that changed, not the whole bucket. */
  readonly dimKey: string
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly totalOf: (rows: readonly Row[]) => number
  readonly sink: WriteFn
  /** The metric's failure count, shared with its flushes. */
  readonly attempts: Attempts
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
 * carrying the same row id, which a store upserting on that id would take as
 * the new truth. Reading instead leaves the bucket live and accumulating, so
 * every send is the cumulative value and the last one wins correctly.
 *
 * It follows that there is nothing to release. A sink that throws leaves the
 * data exactly where it was: the next write to this series sends it again, and
 * `flush()` will ship it regardless once the bucket closes. The error is the
 * caller's to report, and for a metric that is `onError`, because `.add()` has
 * already returned.
 *
 * Only the series that changed is read. The cost of immediate delivery scales
 * with writes, not with the cardinality of the metric.
 */
export async function shipOpenSeries(ship: OpenSeriesShip): Promise<void> {
  let live = await ship.driver.readBuckets({
    metric: ship.metric,
    dimKey: ship.dimKey,
    from: ship.bucketTs,
    to: ship.bucketTs + ship.resolutionMs,
  })

  // nothing where the write was aimed: a flush claimed that window before the
  // write arrived, so the driver moved the write forward to the oldest window
  // that has not shipped. That is the earliest one still live from here on
  if (live.length === 0) {
    const later = await ship.driver.readBuckets({
      metric: ship.metric,
      dimKey: ship.dimKey,
      from: ship.bucketTs,
    })
    const landed = later[0]
    // nothing at all: a flush claimed the landing window too, and it ships
    // the same id with the same fold
    if (landed === undefined) return
    live = [landed]
  }

  const bucketTs = (live[0] as BucketRow).bucketTs
  const rows = live.map((row) => ship.materialize(row.bucketTs, row.dimKey, row.value))

  try {
    await ship.sink(rows, {
      metric: ship.metric,
      kind: ship.kind,
      bucketFrom: bucketTs,
      bucketTo: bucketTs + ship.resolutionMs,
      total: ship.totalOf(rows),
      // nothing was claimed, so a failure has nothing to release: the next
      // write sends the window again. It is still a failure in a row, and the
      // count is the one this metric's flushes use
      attempt: ship.attempts.current,
      source: 'immediate',
    })
  } catch (thrown) {
    ship.attempts.current += 1
    throw sinkFailure(ship.metric, thrown)
  }
  ship.attempts.current = 1
}
