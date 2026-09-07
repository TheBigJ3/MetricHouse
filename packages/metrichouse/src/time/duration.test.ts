import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration, UNIT_MS } from './duration.js'

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

describe('parseDuration', () => {
  it('parses every unit', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('7d')).toBe(604_800_000)
  })

  it('agrees with the UNIT_MS table', () => {
    for (const [unit, ms] of Object.entries(UNIT_MS)) {
      expect(parseDuration(`1${unit}`)).toBe(ms)
      expect(parseDuration(`3${unit}`)).toBe(ms * 3)
    }
  })

  it('accepts zero — a zero grace is meaningful', () => {
    expect(parseDuration('0s')).toBe(0)
    expect(parseDuration('0ms')).toBe(0)
    expect(parseDuration(0)).toBe(0)
  })

  it('trims surrounding whitespace', () => {
    expect(parseDuration('  5m  ')).toBe(300_000)
  })

  it('takes a plain number as milliseconds already', () => {
    expect(parseDuration(2000)).toBe(2000)
    expect(parseDuration(1)).toBe(1)
  })

  it('handles large values without losing precision', () => {
    expect(parseDuration('365d')).toBe(365 * 86_400_000)
  })

  it.each([
    ['-5m', 'negative'],
    ['-1ms', 'negative'],
    ['1.5m', 'fractional'],
    ['0.5s', 'fractional'],
    ['5', 'bare numeric string is ambiguous'],
    ['5M', 'uppercase unit'],
    ['5S', 'uppercase unit'],
    ['5y', 'unknown unit'],
    ['5w', 'unknown unit'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['m', 'no quantity'],
    ['5m5s', 'compound durations are not supported'],
    ['5 m', 'internal whitespace'],
    ['abc', 'not a duration'],
  ])('rejects %j (%s)', (input) => {
    expectRejected(() => parseDuration(input))
  })

  it.each([
    [-1, 'negative number'],
    [1.5, 'fractional number'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('rejects the number %p (%s)', (input) => {
    expectRejected(() => parseDuration(input))
  })

  it('names the offending input in the error', () => {
    expect(expectRejected(() => parseDuration('5y')).message).toMatch(/5y/)
  })
})

describe('formatDuration', () => {
  it('picks the largest unit that divides evenly', () => {
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(604_800_000)).toBe('7d')
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(500)).toBe('500ms')
  })

  it('does not emit a fraction it could not parse back', () => {
    // 90s is 1.5m — must stay seconds, because '1.5m' is rejected on the way in
    expect(formatDuration(90_000)).toBe('90s')
    expect(formatDuration(1500)).toBe('1500ms')
  })

  it('renders zero', () => {
    expect(formatDuration(0)).toBe('0ms')
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (ms) => {
    expectRejected(() => formatDuration(ms))
  })
})

describe('round trip', () => {
  const values = [
    0, 1, 500, 999, 1000, 1500, 2000, 30_000, 60_000, 90_000, 300_000, 3_600_000, 5_400_000,
    86_400_000, 604_800_000,
  ]

  it('parseDuration(formatDuration(ms)) === ms', () => {
    for (const ms of values) {
      expect(parseDuration(formatDuration(ms))).toBe(ms)
    }
  })
})
