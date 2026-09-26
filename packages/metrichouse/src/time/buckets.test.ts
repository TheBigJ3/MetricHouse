import { describe, expect, it } from 'vitest'
import { assertResolution, bucketRange, bucketStart, closedUpTo } from './buckets.js'

const SEC = 1000
const MIN = 60_000

describe('bucketStart', () => {
  it('floors to the epoch-aligned boundary', () => {
    expect(bucketStart(0, SEC)).toBe(0)
    expect(bucketStart(999, SEC)).toBe(0)
    expect(bucketStart(1000, SEC)).toBe(1000)
    expect(bucketStart(1001, SEC)).toBe(1000)
    expect(bucketStart(1999, SEC)).toBe(1000)
  })

  it('floors a timestamp partway through a second to the start of that second', () => {
    const ts = Date.parse('2026-09-05T14:03:07.482Z')
    expect(bucketStart(ts, SEC)).toBe(1_788_616_987_000)
    expect(new Date(bucketStart(ts, SEC)).toISOString()).toBe('2026-09-05T14:03:07.000Z')
  })

  it('is aligned to the epoch, not to process start', () => {
    // every instant inside one window must land on the same start, which is
    // what lets N instances agree on boundaries with no coordination
    const base = bucketStart(Date.now(), MIN)
    for (const offset of [0, 1, 5000, 30_000, MIN - 1]) {
      expect(bucketStart(base + offset, MIN)).toBe(base)
    }
  })

  it('is idempotent', () => {
    const b = bucketStart(Date.parse('2026-09-05T14:03:07.482Z'), 10 * SEC)
    expect(bucketStart(b, 10 * SEC)).toBe(b)
  })

  it('handles coarse resolutions', () => {
    expect(bucketStart(Date.parse('2026-09-05T14:03:07Z'), MIN)).toBe(
      Date.parse('2026-09-05T14:03:00Z'),
    )
    expect(bucketStart(Date.parse('2026-09-05T14:03:07Z'), 60 * MIN)).toBe(
      Date.parse('2026-09-05T14:00:00Z'),
    )
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects resolution %p', (res) => {
    expect(() => bucketStart(1000, res)).toThrow(
      `bucketStart: resolutionMs must be a positive integer, got ${res}`,
    )
  })
})

describe('bucketRange', () => {
  it('returns every bucket start in a half-open window', () => {
    expect(bucketRange(0, 3000, SEC)).toEqual([0, 1000, 2000])
  })

  it('includes the bucket a mid-bucket start falls into', () => {
    // the window begins at 500, inside bucket 0. That bucket holds data in
    // range, so it must be returned
    expect(bucketRange(500, 2500, SEC)).toEqual([0, 1000, 2000])
  })

  it('excludes a bucket starting exactly at the end of the window', () => {
    expect(bucketRange(0, 2000, SEC)).toEqual([0, 1000])
  })

  it('returns a single bucket for a sub-resolution window', () => {
    expect(bucketRange(100, 200, SEC)).toEqual([0])
  })

  it('returns [] when the window is empty or inverted', () => {
    expect(bucketRange(1000, 1000, SEC)).toEqual([])
    expect(bucketRange(2000, 1000, SEC)).toEqual([])
  })

  it('produces 300 buckets for 1s resolution over 5m', () => {
    const from = Date.parse('2026-09-05T14:03:00Z')
    const range = bucketRange(from, from + 5 * MIN, SEC)
    expect(range).toHaveLength(300)
    expect(range[0]).toBe(from)
    expect(range.at(-1)).toBe(from + 299 * SEC)
  })

  it('is strictly ascending with no gaps', () => {
    const range = bucketRange(0, 10_000, SEC)
    for (let i = 1; i < range.length; i++) {
      expect((range[i] as number) - (range[i - 1] as number)).toBe(SEC)
    }
  })
})

describe('closedUpTo', () => {
  it('holds back the windows that ended less than grace ago', () => {
    const now = Date.parse('2026-09-05T14:08:09Z')
    const watermark = closedUpTo(SEC, now, 2 * SEC)
    expect(watermark).toBe(1_788_617_287_000)
    expect(new Date(watermark).toISOString()).toBe('2026-09-05T14:08:07.000Z')
  })

  it('returns a bucket boundary', () => {
    const now = Date.parse('2026-09-05T14:08:09.482Z')
    const w = closedUpTo(SEC, now, 2 * SEC)
    expect(bucketStart(w, SEC)).toBe(w)
  })

  it('takes a window exactly when its grace runs out', () => {
    // bucket [1000, 2000) with 2s grace is claimable from 4000, not before
    expect(closedUpTo(SEC, 3999, 2 * SEC)).toBe(1000)
    expect(closedUpTo(SEC, 4000, 2 * SEC)).toBe(2000)
    // with no grace, from the moment it ends
    expect(closedUpTo(SEC, 1999, 0)).toBe(1000)
    expect(closedUpTo(SEC, 2000, 0)).toBe(2000)
  })

  it('moves backwards as grace grows', () => {
    const now = Date.parse('2026-09-05T14:08:09Z')
    expect(closedUpTo(SEC, now, 0)).toBeGreaterThan(closedUpTo(SEC, now, 5 * SEC))
  })
})

/**
 * The definition {@link closedUpTo} has to agree with, written the long way:
 * a bucket is claimable once it has ended and outlived its grace.
 */
function isClosed(bucketTs: number, resolutionMs: number, nowMs: number, graceMs: number) {
  const ended = bucketStart(nowMs, resolutionMs) !== bucketStart(bucketTs, resolutionMs)
  return ended && nowMs >= bucketTs + resolutionMs + graceMs
}

describe('closedUpTo agrees with isClosed', () => {
  // The invariant the flush engine depends on. If this fails, the watermark
  // is off by a bucket and a window gets double-shipped or dropped.
  it('isClosed(b) <=> b < closedUpTo()', () => {
    const now = Date.parse('2026-09-05T14:08:09.482Z')

    for (const res of [SEC, 10 * SEC, MIN]) {
      for (const grace of [0, SEC, 2 * SEC, 30 * SEC]) {
        const watermark = closedUpTo(res, now, grace)
        const first = bucketStart(now, res) - 20 * res

        for (let b = first; b <= bucketStart(now, res) + res; b += res) {
          expect({ b, closed: isClosed(b, res, now, grace) }).toEqual({
            b,
            closed: b < watermark,
          })
        }
      }
    }
  })
})

describe('assertResolution', () => {
  it('accepts a resolution that divides the flush interval evenly', () => {
    expect(() => assertResolution(SEC, 5 * MIN)).not.toThrow() // 300 buckets
    expect(() => assertResolution(10 * SEC, MIN)).not.toThrow() // 6 buckets
    expect(() => assertResolution(MIN, MIN)).not.toThrow() // 1 bucket
  })

  it('rejects a resolution that would split a bucket across shipments', () => {
    expect(() => assertResolution(7 * SEC, MIN)).toThrow(
      'assertResolution: resolution 7s does not divide flush 1m evenly, and a shipment would split a bucket',
    )
    expect(() => assertResolution(45 * SEC, MIN)).toThrow(
      'assertResolution: resolution 45s does not divide flush 1m evenly, and a shipment would split a bucket',
    )
  })

  it('rejects a resolution coarser than the flush interval', () => {
    expect(() => assertResolution(5 * MIN, MIN)).toThrow(
      'assertResolution: resolution 5m does not divide flush 1m evenly, and a shipment would split a bucket',
    )
  })

  it.each([0, -1, 1.5])('rejects resolution %p', (res) => {
    expect(() => assertResolution(res, MIN)).toThrow(
      `assertResolution: resolutionMs must be a positive integer, got ${res}`,
    )
  })
})

describe('clocks that are not whole milliseconds, or are near the epoch', () => {
  it('floors a fractional timestamp into its bucket', () => {
    expect(bucketStart(1_790_363_788_005.463, 1_000)).toBe(1_790_363_788_000)
  })

  it('refuses a timestamp that is not a finite, non-negative number', () => {
    expect(() => bucketStart(Number.NaN, 1_000)).toThrow(/non-negative number/)
    expect(() => bucketStart(-1, 1_000)).toThrow(/non-negative number/)
  })

  it('closes nothing while the clock is closer to the epoch than grace', () => {
    expect(closedUpTo(1_000, 500, 2_000)).toBe(0)
  })
})
