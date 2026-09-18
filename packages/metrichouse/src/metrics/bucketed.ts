/**
 * The batch lifecycle shared by every aggregate primitive.
 *
 * Counter and gauge differ in what a cell *is* and what a row looks like, and
 * in nothing else: both bucket by resolution, both claim on a watermark, both
 * hand the driver's claim/ack/release back untouched. That common part lives
 * here so a third aggregate kind — `level()` is the one coming — implements
 * `materialize` and `totalOf` and inherits the rest.
 */

import { type Cell, type Claim, type Driver, isBucketClaim } from '../drivers/types.js'
import {
  applySnapshot,
  type LiveRow,
  type MergeValues,
  type SnapshotOptions,
  snapshotRange,
  type TypedSnapshot,
} from '../runtime/live.js'
import type { Shape } from '../schema/types.js'
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

/**
 * The read half, for a kind whose live data is buckets.
 *
 * Generic in the dims and in the value columns the kind adds, so a counter's
 * snapshot returns rows with `park: string` and `value: number` rather than
 * `unknown` per key. The erased {@link AnyMetric.snapshot} stays as it is —
 * this narrows it, which is legal precisely because a typed row is still a
 * {@link LiveRow}.
 */
export type BucketedReader<D extends Shape, V> = TypedSnapshot<D, V>

export interface BucketedReaderOptions {
  readonly name: string
  readonly resolutionMs: number
  /** Declared dims, for validating a `dims` filter and a `groupBy`. */
  readonly dims: Shape
  /** Read late, not captured: a metric is declared before it is bound. */
  readonly driver: () => Driver
  readonly now: () => number
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly mergeValues: MergeValues
}

/**
 * Live read for a bucketed kind.
 *
 * The sibling of {@link bucketedLifecycle}: that one is the write path's shared
 * half, this one is the read path's. Both exist so a third aggregate kind
 * supplies what is actually different about it — how a cell becomes a row, and
 * how two of them merge — and inherits everything else.
 *
 * The clock is read once per call and passed down, so every row in one snapshot
 * agrees about which bucket is open. Reading it per row would let a snapshot
 * that straddles a boundary report two different answers about the same window.
 */
export function bucketedReader<D extends Shape, V>(
  options: BucketedReaderOptions,
): BucketedReader<D, V> {
  const { name, resolutionMs, dims, driver, now, materialize, mergeValues } = options

  // the one cast: `applySnapshot` works in erased rows because filtering and
  // merging are the same work whatever the columns are called, and the kind
  // supplies the type that says what they are. Casting here rather than at each
  // of the three call sites keeps it to one place that can be checked.
  const reader = {
    async snapshot(snapshotOptions: SnapshotOptions = {}): Promise<LiveRow[]> {
      const nowMs = now()
      const range = snapshotRange(snapshotOptions, resolutionMs, nowMs)

      const live = await driver().readBuckets({ metric: name, ...range })

      return applySnapshot(
        live.map((row) => ({
          bucketTs: row.bucketTs,
          row: materialize(row.bucketTs, row.dimKey, row.value),
        })),
        snapshotOptions,
        { metric: name, dims, resolutionMs, nowMs, mergeValues },
      )
    },
  }

  return reader as unknown as BucketedReader<D, V>
}

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
