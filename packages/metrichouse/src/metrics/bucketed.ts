/**
 * The batch lifecycle shared by every aggregate primitive.
 *
 * Counter and gauge differ in what a cell *is* and what a row looks like, and
 * in nothing else: both bucket by resolution, both claim on a watermark, both
 * hand the driver's claim/ack/release back untouched. That common part lives
 * here so a third aggregate kind — `level()` is the one coming — implements
 * `materialize` and `totalOf` and inherits the rest.
 *
 * Spec: initialPlan/12-flush.md, 07-buckets.md
 */

import { type Cell, type Claim, type Driver, isBucketClaim } from '../drivers/types.js'
import { closedUpTo } from '../time/buckets.js'
import type { AnyMetric, MaterializedBatch, Row } from './types.js'

/**
 * How long past a boundary a late write still lands in the closed bucket, when
 * neither the metric nor the house says otherwise.
 *
 * Shared by every bucketed kind so the number is written once: a counter and a
 * gauge disagreeing about it would put the same late write in two different
 * buckets.
 */
export const DEFAULT_GRACE_MS = 2_000

/** The four {@link AnyMetric} methods that move a batch. */
export type BatchLifecycle = Pick<
  AnyMetric,
  'claimBatch' | 'materializeClaim' | 'ackBatch' | 'releaseBatch'
>

export interface BucketedOptions {
  readonly name: string
  readonly resolutionMs: number
  /**
   * Read late, not captured: grace may come from the house, and a metric is
   * declared before it is bound.
   */
  readonly graceMs: () => number
  /** Read late, not captured: a metric is declared before it is bound. */
  readonly driver: () => Driver
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly totalOf: (rows: readonly Row[]) => number
}

export function bucketedLifecycle(options: BucketedOptions): BatchLifecycle {
  const { name, resolutionMs, graceMs, driver, materialize, totalOf } = options

  /**
   * A bucketed metric can only ever be handed back the claim it asked for. A
   * record claim here means a driver returned the wrong storage model, which
   * would otherwise surface as rows silently missing from a flush.
   */
  function assertBuckets(claim: Claim): asserts claim is Extract<Claim, { kind: 'buckets' }> {
    if (!isBucketClaim(claim)) {
      throw new Error(`${name}: expected a bucket claim but the driver returned staged records`)
    }
  }

  return {
    async claimBatch(nowMs: number): Promise<Claim> {
      // everything strictly below this has ended and outlived grace
      return driver().claim(name, closedUpTo(resolutionMs, nowMs, graceMs()))
    },

    materializeClaim(claim: Claim): MaterializedBatch {
      assertBuckets(claim)

      const rows: Row[] = []
      for (const bucket of claim.buckets) {
        for (const [dimKey, cell] of bucket.values) {
          rows.push(materialize(bucket.bucketTs, dimKey, cell))
        }
      }

      const first = claim.buckets[0]?.bucketTs ?? 0
      const last = claim.buckets.at(-1)?.bucketTs ?? 0

      return {
        rows,
        bucketFrom: first,
        // one resolution past the newest bucket — the window is half-open
        bucketTo: last + resolutionMs,
        total: totalOf(rows),
        buckets: claim.buckets.length,
      }
    },

    async ackBatch(claim: Claim): Promise<void> {
      await driver().ack(claim)
    },

    async releaseBatch(claim: Claim): Promise<void> {
      await driver().release(claim)
    },
  }
}
