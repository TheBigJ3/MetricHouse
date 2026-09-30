/**
 * Bucket boundaries.
 *
 * A bucket is an epoch-aligned window of a metric's `resolution`. Resolution
 * and flush cadence are independent: a metric can hold 1-second fidelity while
 * shipping every 5 minutes.
 *
 * This is the subtlest arithmetic in the project. Getting {@link closedUpTo}
 * wrong either ships a bucket twice or loses one, and neither surfaces until
 * there is a real driver underneath.
 */

import { formatDuration } from './duration.js'

/**
 * Floor a timestamp to the start of its epoch-aligned bucket.
 *
 * Epoch-aligned means buckets are multiples of `resolutionMs` from the Unix
 * epoch, not from process start, so every instance agrees on boundaries with
 * no coordination. That property is why the open bucket is exact across a
 * fleet, and it is worth a test that two different "now"s inside one window
 * produce the same start.
 *
 * @throws if `resolutionMs` is not a positive integer, or `tsMs` is negative or
 * not a finite number
 */
export function bucketStart(tsMs: number, resolutionMs: number): number {
  if (!Number.isSafeInteger(resolutionMs) || resolutionMs <= 0) {
    throw new Error(`bucketStart: resolutionMs must be a positive integer, got ${resolutionMs}`)
  }
  // fractions are fine and are floored with everything else: a clock built
  // from `performance.timeOrigin + performance.now()` reads 1790363788005.463,
  // and that instant belongs to a bucket like any other
  if (!Number.isFinite(tsMs) || tsMs < 0 || tsMs > Number.MAX_SAFE_INTEGER) {
    throw new Error(`bucketStart: tsMs must be a non-negative number of milliseconds, got ${tsMs}`)
  }

  return Math.floor(tsMs / resolutionMs) * resolutionMs
}

/**
 * Every bucket start overlapping the half-open window `[fromMs, toMs)`.
 *
 * Ascending, beginning at `bucketStart(fromMs)`, so a window starting
 * mid-bucket still includes that bucket, because it holds data in range.
 * Returns `[]` when `toMs <= fromMs`.
 *
 * @throws if `resolutionMs` is not a positive integer
 */
export function bucketRange(fromMs: number, toMs: number, resolutionMs: number): number[] {
  const result = []

  let i = bucketStart(fromMs, resolutionMs)
  while (i < toMs) {
    result.push(i)
    i += resolutionMs
  }

  return result
}

/**
 * The flush watermark: every bucket **strictly below** this value is claimable.
 *
 * This is the single number the flush engine asks for. A bucket `b` belongs
 * below it exactly when it has ended *and* outlived its grace period:
 *
 * ```
 * b < closedUpTo(res, now, grace)  <=>  b has ended and now >= b + res + grace
 * ```
 *
 * `grace` holds a just-closed bucket back from being claimed, because a write
 * stamped inside it can still be on its way to storage. A write stamped
 * `:06.999` that reaches Redis at `:07.050` still lands in the `:06` bucket
 * when grace is `2s`. A write *stamped* `:07.001` belongs to the `:07` bucket
 * whatever grace is.
 *
 * `buckets.test.ts` checks that equivalence. If it ever fails, the watermark
 * is off by a bucket, and the consequence is a double-shipped or dropped
 * window.
 *
 * @throws if `resolutionMs` is not a positive integer
 */
export function closedUpTo(resolutionMs: number, nowMs: number, graceMs: number): number {
  // a clock closer to the epoch than grace has closed nothing yet, which is a
  // watermark of zero rather than a negative instant
  return bucketStart(Math.max(0, nowMs - graceMs), resolutionMs)
}

/**
 * Resolution must divide the flush interval evenly, so a shipment never splits
 * a bucket in half.
 *
 * `resolution: '1s'` with `flush: '5m'` is 300 whole buckets per flush.
 * `resolution: '7s'` with `flush: '1m'` is not, and is rejected at declare
 * time rather than discovered as a torn window in production.
 *
 * The message starts with `name`, the metric, like every other declaration error.
 *
 * @throws if resolution is not positive, or does not divide `flushMs` evenly
 */
export function assertResolution(name: string, resolutionMs: number, flushMs: number): void {
  if (!Number.isSafeInteger(resolutionMs) || resolutionMs <= 0) {
    throw new Error(`${name}: resolutionMs must be a positive integer, got ${resolutionMs}`)
  }
  if (!Number.isSafeInteger(flushMs) || flushMs <= 0) {
    throw new Error(`${name}: flushMs must be a positive integer, got ${flushMs}`)
  }

  if (flushMs % resolutionMs !== 0) {
    throw new Error(
      `${name}: resolution ${formatDuration(resolutionMs)} does not divide flush ` +
        `${formatDuration(flushMs)} evenly, and a shipment would split a bucket`,
    )
  }
}
