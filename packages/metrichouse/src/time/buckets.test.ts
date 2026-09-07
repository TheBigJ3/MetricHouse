import { describe, expect, it } from 'vitest'
import {
  assertResolution,
  bucketRange,
  bucketStart,
  closedUpTo,
  isClosed,
  isOpen,
  nextBoundary,
} from './buckets.js'

/**
 * Asserts `fn` throws a *real* validation error — not the `not implemented`
 * sentinel the stub throws. Without this guard every rejection test below
 * would pass trivially against an unimplemented function and report a false
 * green. Delete it once the stubs are gone if you like; it costs nothing.
 */
function expectRejected(fn: () => unknown): Error {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught, 'expected the call to throw').toBeInstanceOf(Error)
  const err = caught as Error
  expect(err.message, 'still throwing the stub sentinel').not.toMatch(/not implemented/i)
  return err
}

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

  it('matches the worked example in 07-buckets.md', () => {
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
    expectRejected(() => bucketStart(1000, res))
  })
})

describe('nextBoundary', () => {
  it('returns the start of the following bucket', () => {
    expect(nextBoundary(0, SEC)).toBe(1000)
    expect(nextBoundary(500, SEC)).toBe(1000)
    expect(nextBoundary(999, SEC)).toBe(1000)
  })

  it('advances past a timestamp sitting exactly on a boundary', () => {
    // a ts on a boundary belongs to the bucket starting there, so the next
    // boundary is one full resolution later — never the ts itself
    expect(nextBoundary(1000, SEC)).toBe(2000)
  })

  it('is always bucketStart + resolution', () => {
    for (const ts of [0, 1, 999, 1000, 123_456_789]) {
      expect(nextBoundary(ts, SEC)).toBe(bucketStart(ts, SEC) + SEC)
    }
  })
})

describe('bucketRange', () => {
  it('returns every bucket start in a half-open window', () => {
    expect(bucketRange(0, 3000, SEC)).toEqual([0, 1000, 2000])
  })

  it('includes the bucket a mid-bucket start falls into', () => {
    // the window begins at 500, inside bucket 0 — that bucket holds data in
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

  it('produces 300 buckets for 1s resolution over 5m — the spec example', () => {
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

describe('isOpen', () => {
  it('is true only inside the half-open window', () => {
    expect(isOpen(1000, SEC, 1000)).toBe(true)
    expect(isOpen(1000, SEC, 1500)).toBe(true)
    expect(isOpen(1000, SEC, 1999)).toBe(true)
    expect(isOpen(1000, SEC, 2000)).toBe(false)
    expect(isOpen(1000, SEC, 999)).toBe(false)
  })
})

describe('isClosed', () => {
  it('requires the bucket to have ended AND outlived grace', () => {
    const b = 1000
    // bucket covers [1000, 2000); with 2s grace it is claimable from 4000
    expect(isClosed(b, SEC, 1999, 2 * SEC)).toBe(false) // still open
    expect(isClosed(b, SEC, 2000, 2 * SEC)).toBe(false) // ended, in grace
    expect(isClosed(b, SEC, 3999, 2 * SEC)).toBe(false) // still in grace
    expect(isClosed(b, SEC, 4000, 2 * SEC)).toBe(true) // grace expired
  })

  it('collapses to the boundary when grace is zero', () => {
    expect(isClosed(1000, SEC, 1999, 0)).toBe(false)
    expect(isClosed(1000, SEC, 2000, 0)).toBe(true)
  })

  it('is never true for a bucket that is still open', () => {
    for (const now of [1000, 1500, 1999]) {
      expect(isOpen(1000, SEC, now) && isClosed(1000, SEC, now, 2 * SEC)).toBe(false)
    }
  })
})

describe('closedUpTo', () => {
  it('matches the worked example in 07-buckets.md', () => {
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

  it('moves backwards as grace grows', () => {
    const now = Date.parse('2026-09-05T14:08:09Z')
    expect(closedUpTo(SEC, now, 0)).toBeGreaterThan(closedUpTo(SEC, now, 5 * SEC))
  })
})

describe('closedUpTo agrees with isClosed', () => {
  // The invariant the flush engine depends on. If this fails, one of the two
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
    expectRejected(() => assertResolution(7 * SEC, MIN))
    expectRejected(() => assertResolution(45 * SEC, MIN))
  })

  it('rejects a resolution coarser than the flush interval', () => {
    expectRejected(() => assertResolution(5 * MIN, MIN))
  })

  it.each([0, -1, 1.5])('rejects resolution %p', (res) => {
    expectRejected(() => assertResolution(res, MIN))
  })

  it('explains itself', () => {
    // note: must not match the stub's own 'assertResolution: not implemented'
    expect(expectRejected(() => assertResolution(7 * SEC, MIN)).message).toMatch(/divide|evenly/i)
  })
})
