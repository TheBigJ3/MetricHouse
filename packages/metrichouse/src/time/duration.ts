/**
 * Duration parsing.
 *
 * Every time-shaped config field in MetricHouse — `resolution`, `flush`,
 * `grace`, `retention`, `totalTtl` — is a duration. This is the bottom of the
 * dependency graph: nothing here imports anything.
 */

/** Units accepted by {@link parseDuration}. Lowercase only. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'

/**
 * A duration string (`'5m'`) or a plain number, which is already milliseconds.
 */
export type DurationInput = string | number

/** Milliseconds per unit. The authoritative list of what parses. */
export const UNIT_MS: Record<DurationUnit, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
}

const UNIT_MS_ENTRIES = Object.entries(UNIT_MS) as [DurationUnit, number][]

/**
 * Parse a duration into milliseconds.
 *
 * Accepted:
 * - `'500ms' | '30s' | '5m' | '2h' | '7d'` — integer + lowercase unit
 * - surrounding whitespace, which is trimmed
 * - a plain `number`, taken as milliseconds already
 * - zero (`'0s'` → `0`) — a zero `grace` is meaningful. Rejecting a zero
 *   *resolution* is {@link assertResolution}'s job, not this function's.
 *
 * Rejected, each with a message naming the input:
 * - negatives (`'-5m'`) — never meaningful
 * - fractions (`'1.5m'`) — write `'90s'`. Deliberately strict: loosening this
 *   later is safe, tightening it is not
 * - a bare numeric string (`'5'`) — ambiguous. A bare `number` means ms; a
 *   bare numeric *string* is an error
 * - uppercase units (`'5M'`) — `M` is minutes or months depending on who you
 *   ask, so neither is accepted
 * - unknown units, empty strings, `NaN`, `Infinity`, non-integer numbers
 *
 * @throws if the input is not a valid duration
 */
export function parseDuration(_input: DurationInput): number {
  if (typeof _input === 'number') {
    if (!Number.isSafeInteger(_input) || _input < 0) {
      throw new Error(`parseDuration: ${_input}`)
    }
    return _input + 0 // normalize -0
  }
  if (typeof _input !== 'string') {
    throw new Error(`parseDuration: expected a string or number, got ${typeof _input}`)
  }
  const trimmed = _input.trim()
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(trimmed)
  if (!match) throw new Error(`parseDuration: ${JSON.stringify(trimmed)}`)

  const value = Number(match[1]) * UNIT_MS[match[2] as DurationUnit]
  if (!Number.isSafeInteger(value)) {
    throw new Error(`parseDuration: ${JSON.stringify(trimmed)} overflows the safe integer range`)
  }
  return value
}

/**
 * Render milliseconds back to the most compact exact duration string.
 *
 * Picks the largest unit that divides evenly, so `90_000` is `'90s'` (not
 * `'1.5m'`, which would not parse) and `300_000` is `'5m'`. Zero is `'0ms'`.
 *
 * Must satisfy, for every value {@link parseDuration} accepts:
 * `parseDuration(formatDuration(ms)) === ms`
 *
 * @throws if `ms` is negative, fractional, or not finite
 */
export function formatDuration(_ms: number): string {
  if (!Number.isSafeInteger(_ms) || _ms < 0) {
    throw new Error(`formatDuration: ${_ms}`)
  }

  if (_ms === 0) return '0ms'

  for (const [unit, divisor] of UNIT_MS_ENTRIES) {
    if (_ms % divisor === 0) {
      return `${_ms / divisor}${unit}`
    }
  }

  throw new Error(`formatDuration: ${_ms} is not divisible by any unit`)
}
