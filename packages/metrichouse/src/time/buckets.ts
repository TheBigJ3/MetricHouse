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
 * epoch, not from process start — so every instance agrees on boundaries with
 * no coordination. That property is why the open bucket is exact across a
 * fleet, and it is worth a test that two different "now"s inside one window
 * produce the same start.
 *
 * @throws if `resolutionMs` is not a positive integer, or `tsMs` is negative or
 * not a finite number
 */
export function bucketStart(_tsMs: number, _resolutionMs: number): number {
  if (!Number.isSafeInteger(_resolutionMs) || _resolutionMs <= 0) {
    throw new Error(`bucketStart: resolutionMs must be a positive integer, got ${_resolutionMs}`)
  }
  // fractions are fine and are floored with everything else: a clock built
  // from `performance.timeOrigin + performance.now()` reads 1790363788005.463,
  // and that instant belongs to a bucket like any other
  if (!Number.isFinite(_tsMs) || _tsMs < 0 || _tsMs > Number.MAX_SAFE_INTEGER) {
    throw new Error(`bucketStart: tsMs must be a non-negative number of milliseconds, got ${_tsMs}`)
  }

  return Math.floor(_tsMs / _resolutionMs) * _resolutionMs
}

/**
 * The instant the bucket containing `tsMs` closes — i.e. the start of the next
 * one.
 *
 * A timestamp sitting exactly on a boundary belongs to the bucket that
 * *starts* there, so `nextBoundary(b, res)` is `b + res`, never `b`.
 *
 * @throws if `resolutionMs` is not a positive integer
 */
export function nextBoundary(_tsMs: number, _resolutionMs: number): number {
  return bucketStart(_tsMs, _resolutionMs) + _resolutionMs
}

/**
 * Every bucket start overlapping the half-open window `[fromMs, toMs)`.
 *
 * Ascending, beginning at `bucketStart(fromMs)` — so a window starting
 * mid-bucket still includes that bucket, because it holds data in range.
 * Returns `[]` when `toMs <= fromMs`.
 *
 * @throws if `resolutionMs` is not a positive integer
 */
export function bucketRange(_fromMs: number, _toMs: number, _resolutionMs: number): number[] {
  const result = []

  let i = bucketStart(_fromMs, _resolutionMs)
  while (i < _toMs) {
    result.push(i)
    i += _resolutionMs
  }

  return result
}

/**
 * Is `nowMs` inside this bucket? Half-open: `[bucketTs, bucketTs + res)`.
 */
export function isOpen(_bucketTs: number, _resolutionMs: number, _nowMs: number): boolean {
  const nowBucket = bucketStart(_nowMs, _resolutionMs)
  const currentBucket = bucketStart(_bucketTs, _resolutionMs)
  return nowBucket === currentBucket
}

/**
 * Has this bucket ended *and* outlived its grace period?
 *
 * `grace` holds a just-closed bucket back from being claimed, because a write
 * stamped inside it can still be on its way to storage. A write stamped
 * `:06.999` that reaches Redis at `:07.050` still lands in the `:06` bucket
 * when grace is `2s`. A write *stamped* `:07.001` belongs to the `:07` bucket
 * whatever grace is.
 *
 * True when `nowMs >= bucketTs + resolutionMs + graceMs`.
 */
export function isClosed(
  _bucketTs: number,
  _resolutionMs: number,
  _nowMs: number,
  _graceMs: number,
): boolean {
  const isEnded = !isOpen(_bucketTs, _resolutionMs, _nowMs)
  const isPastGrace = _nowMs >= _bucketTs + _resolutionMs + _graceMs
  return isEnded && isPastGrace
}

/**
 * The flush watermark: every bucket **strictly below** this value is claimable.
 *
 * This is the single number the flush engine asks for, and it must agree
 * exactly with {@link isClosed}:
 *
 * ```
 * isClosed(b, res, now, grace)  <=>  b < closedUpTo(res, now, grace)
 * ```
 *
 * That equivalence is a test in this file. If it ever fails, one of the two is
 * off by a bucket, and the consequence is a double-shipped or dropped window.
 *
 * @throws if `resolutionMs` is not a positive integer
 */
export function closedUpTo(_resolutionMs: number, _nowMs: number, _graceMs: number): number {
  // a clock closer to the epoch than grace has closed nothing yet, which is a
  // watermark of zero rather than a negative instant
  return bucketStart(Math.max(0, _nowMs - _graceMs), _resolutionMs)
}

/**
 * Resolution must divide the flush interval evenly, so a shipment never splits
 * a bucket in half.
 *
 * `resolution: '1s'` with `flush: '5m'` is 300 whole buckets per flush.
 * `resolution: '7s'` with `flush: '1m'` is not, and is rejected at declare
 * time rather than discovered as a torn window in production.
 *
 * The metric-level wrapper (`assertResolution(metric)` in the spec) lands once
 * there is a metric type; this is the arithmetic underneath it.
 *
 * @throws if resolution is not positive, or does not divide `flushMs` evenly
 */
export function assertResolution(_resolutionMs: number, _flushMs: number): void {
  if (!Number.isSafeInteger(_resolutionMs) || _resolutionMs <= 0) {
    throw new Error(
      `assertResolution: resolutionMs must be a positive integer, got ${_resolutionMs}`,
    )
  }
  if (!Number.isSafeInteger(_flushMs) || _flushMs <= 0) {
    throw new Error(`assertResolution: flushMs must be a positive integer, got ${_flushMs}`)
  }

  if (_flushMs % _resolutionMs !== 0) {
    throw new Error(
      `assertResolution: resolution ${formatDuration(_resolutionMs)} does not divide flush ` +
        `${formatDuration(_flushMs)} evenly - a shipment would split a bucket`,
    )
  }
}
