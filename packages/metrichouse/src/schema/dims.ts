/**
 * Dimensions — encoding a set of declared values into one series key.
 *
 * The key is the full cross-product of dim values, which is what makes
 * "Willow at riverside" answerable later, and what makes cardinality
 * multiply. Values are open and unguarded by design; the projection in
 * `metrichouse cost` is the answer, not a runtime cap.
 */

import { assertValue, type FieldType, type Shape } from './types.js'

/** Separates encoded values in a key. */
export const DIM_SEPARATOR = '|'

/**
 * Marks an absent optional dim. Two characters, and unreachable by escaping:
 * a literal backslash is always doubled, so a real value can never produce it.
 * Without a distinct sentinel, an absent dim and an empty string collide.
 */
export const DIM_ABSENT = '\\0'

/**
 * Canonical declaration order — the object's own key order.
 *
 * The key depends on this, so **reordering dims is a breaking schema change**:
 * existing rows encoded under the old order will not match new ones.
 */
/**
 * Split a key on unescaped separators.
 *
 * A plain `key.split('|')` is wrong: an escaped `\|` inside a value would
 * split there and shift every following segment. The scan skips the character
 * after a backslash, which is exactly what escaping guaranteed is literal.
 */
function splitKey(key: string): string[] {
  const segments: string[] = []
  let current = ''

  for (let i = 0; i < key.length; i++) {
    const char = key[i] as string

    if (char === ESCAPE) {
      // the next character is literal by construction — carry both through
      current += char + (key[i + 1] ?? '')
      i++
      continue
    }

    if (char === DIM_SEPARATOR) {
      segments.push(current)
      current = ''
      continue
    }

    current += char
  }

  segments.push(current)
  return segments
}

/** The escape character. A literal one in a value is always doubled. */
const ESCAPE = '\\'

export function dimOrder(dims: Shape): string[] {
  return Object.keys(dims)
}

/**
 * Refuse a name no row can carry.
 *
 * `row.__proto__ = value` sets the row's prototype rather than adding a
 * column, so a dim or field with that name would be accepted and then be
 * missing from every row a sink receives.
 */
export function assertShapeNames(shape: Shape, metricName: string, noun = 'dim'): void {
  if (Object.hasOwn(shape, '__proto__')) {
    throw new Error(
      `${metricName}: a ${noun} cannot be named "__proto__", because JavaScript treats that ` +
        "key as an object's prototype and no row could carry it",
    )
  }
}

export function assertDimsLegal(dims: Shape, metricName: string): void {
  assertShapeNames(dims, metricName)
  for (const [key, type] of Object.entries(dims)) {
    if (!type.dimLegal) {
      throw new Error(
        `${metricName}: dim ${JSON.stringify(key)} declares ${type.kind}(), which cannot be ` +
          'encoded into a series key — put it on an event instead',
      )
    }
  }
}

export function escapeDimValue(value: string): string {
  // backslash first: escaping the separator introduces backslashes of its own
  return value
    .split(ESCAPE)
    .join(ESCAPE + ESCAPE)
    .split(DIM_SEPARATOR)
    .join(ESCAPE + DIM_SEPARATOR)
}

export function unescapeDimValue(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string
    if (char === ESCAPE && i + 1 < value.length) {
      out += value[i + 1] as string
      i++
      continue
    }
    out += char
  }
  return out
}

/**
 * Half of a UTF-16 surrogate pair with the other half missing.
 *
 * Legal in a JavaScript string and not in UTF-8. Redis stores a key as UTF-8,
 * so the client replaces each one with U+FFFD on the way in, and two different
 * values that differ only there end up as one series.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function encodeDimValue(type: FieldType, value: unknown): string {
  if (type.kind === 'ts') return String((value as Date).getTime())
  if (type.kind === 'bool') return value ? 'true' : 'false'

  const text = String(value)
  if (LONE_SURROGATE.test(text)) {
    throw new Error(
      `dim value ${JSON.stringify(text)} holds half of a surrogate pair, which cannot be ` +
        'stored as UTF-8. It usually means a string was cut in the middle of an emoji',
    )
  }
  return text
}

export function decodeDimValue(type: FieldType, raw: string): unknown {
  if (type.kind === 'ts') return new Date(Number(raw))
  if (type.kind === 'bool') return raw === 'true'
  if (type.kind === 'int' || type.kind === 'float') return Number(raw)
  // a member comes back as the member, so `oneOf([1, 2, 4])` returns the
  // number 2 and not the text "2" it was stored as
  if (type.kind === 'oneOf') return type.values?.find((member) => String(member) === raw) ?? raw
  return raw
}

/**
 * The caller's own value for `key`, and never one inherited from a prototype.
 *
 * `values.constructor` is `Object` on every object literal, so reading a dim
 * named `constructor` without this check finds a function the caller never
 * passed.
 */
function own(values: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(values, key) ? values[key] : undefined
}

export function encodeDimKey(dims: Shape, values: Record<string, unknown>): string {
  const filled = applyDimDefaults(dims, values)
  validateDims(dims, filled)

  return dimOrder(dims)
    .map((key) => {
      const value = own(filled, key)
      if (value === undefined) return DIM_ABSENT
      return escapeDimValue(encodeDimValue(dims[key] as FieldType, value))
    })
    .join(DIM_SEPARATOR)
}

export function decodeDimKey(dims: Shape, key: string): Record<string, unknown> {
  const order = dimOrder(dims)

  // a metric with no dims has exactly one series, keyed by the empty string
  if (order.length === 0) {
    if (key !== '') {
      throw new Error(`decodeDimKey: expected an empty key, got ${JSON.stringify(key)}`)
    }
    return {}
  }

  const segments = splitKey(key)
  if (segments.length !== order.length) {
    throw new Error(
      `decodeDimKey: expected ${order.length} segments for [${order.join(', ')}], ` +
        `got ${segments.length}`,
    )
  }

  const values: Record<string, unknown> = {}
  order.forEach((name, index) => {
    const segment = segments[index] as string
    // an absent optional dim comes back missing, not as an undefined key
    if (segment === DIM_ABSENT) return
    values[name] = decodeDimValue(dims[name] as FieldType, unescapeDimValue(segment))
  })
  return values
}

export function applyDimDefaults(
  dims: Shape,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...values }

  for (const [key, type] of Object.entries(dims)) {
    // only a genuinely absent key is filled — a falsy value the caller
    // supplied is theirs, and '' or 0 must survive
    if (own(filled, key) === undefined && type.hasDefault) {
      filled[key] = type.defaultValue
    }
  }

  return filled
}

/**
 * Check a value set against a declared shape.
 *
 * `noun` names what is being checked in the error text. Dims are the default
 * because they were the first caller; event fields pass `'field'`, and the
 * only difference between the two is what a mistake should be called — the
 * required/optional/default rules are identical.
 */
export function validateDims(dims: Shape, values: Record<string, unknown>, noun = 'dim'): void {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(dims, key)) {
      throw new Error(
        `unknown ${noun} ${JSON.stringify(key)} — declared ${noun}s are ` +
          `[${dimOrder(dims).join(', ')}]`,
      )
    }
  }

  for (const [key, type] of Object.entries(dims)) {
    const value = own(values, key)

    if (value === undefined) {
      if (!type.isOptional) {
        throw new Error(`missing required ${noun} ${JSON.stringify(key)}`)
      }
      continue
    }

    assertValue(type, value, key)
  }
}
