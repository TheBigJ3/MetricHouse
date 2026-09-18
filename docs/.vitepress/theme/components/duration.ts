/**
 * Duration helpers for the interactive playgrounds.
 *
 * Mirrors what `parseDuration` and `formatDuration` do in the package, so the
 * numbers a reader drags to are the numbers the library would compute.
 */

export interface Choice {
  readonly label: string
  readonly ms: number
}

const choice = (label: string, ms: number): Choice => ({ label, ms })

/** Bucket widths, from sub second to an hour. */
export const RESOLUTIONS: Choice[] = [
  choice('100ms', 100),
  choice('250ms', 250),
  choice('500ms', 500),
  choice('1s', 1_000),
  choice('2s', 2_000),
  choice('5s', 5_000),
  choice('10s', 10_000),
  choice('15s', 15_000),
  choice('30s', 30_000),
  choice('1m', 60_000),
  choice('2m', 120_000),
  choice('5m', 300_000),
  choice('15m', 900_000),
  choice('1h', 3_600_000),
]

/** Shipping cadences. */
export const FLUSHES: Choice[] = [
  choice('1s', 1_000),
  choice('5s', 5_000),
  choice('10s', 10_000),
  choice('30s', 30_000),
  choice('1m', 60_000),
  choice('2m', 120_000),
  choice('5m', 300_000),
  choice('10m', 600_000),
  choice('15m', 900_000),
  choice('30m', 1_800_000),
  choice('1h', 3_600_000),
  choice('6h', 21_600_000),
  choice('1d', 86_400_000),
]

/** Grace periods. Zero is legal and meaningful. */
export const GRACES: Choice[] = [
  choice('0s', 0),
  choice('500ms', 500),
  choice('1s', 1_000),
  choice('2s', 2_000),
  choice('5s', 5_000),
  choice('10s', 10_000),
  choice('30s', 30_000),
  choice('1m', 60_000),
]

export const DAY_MS = 86_400_000

/** Find the index of a label, or fall back to something sensible. */
export function indexOf(choices: Choice[], label: string, fallback = 0): number {
  const found = choices.findIndex((one) => one.label === label)
  return found === -1 ? fallback : found
}

/** Short human counts: 1.2k, 3.4M, 5.1B. */
export function count(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${round(value / 1_000)}k`
  if (value < 1_000_000_000) return `${round(value / 1_000_000)}M`
  return `${round(value / 1_000_000_000)}B`
}

function round(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
}

/**
 * A stable pseudo random number in [0, 1).
 *
 * Deterministic on purpose: these components are rendered on the server first,
 * and `Math.random()` would produce different bar heights on each side and a
 * hydration mismatch.
 */
export function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}
