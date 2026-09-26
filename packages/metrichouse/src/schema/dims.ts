/**
 * Dimensions. Encoding a set of declared values into one series key.
 *
 * The key is the full cross-product of dim values, which is what makes
 * "Willow at riverside" answerable later, and what makes cardinality
 * multiply. Values are open and unguarded by design. The memory driver's
 * `maxSeries` is the only runtime cap.
 */

import type { LiveFields } from '../runtime/live.js'
import { assertValue, type FieldType, type Shape } from './types.js'

/** Separates encoded values in a key. */
const DIM_SEPARATOR = '|'

/** The escape character. A literal one in a value is always doubled. */
const ESCAPE = '\\'

/**
 * Marks an absent optional dim. Two characters, and unreachable by escaping:
 * a literal backslash is always doubled, so a real value can never produce it.
 * Without a distinct sentinel, an absent dim and an empty string collide.
 */
export const DIM_ABSENT = '\\0'

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
      // the next character is literal by construction, so carry both through
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

/**
 * Canonical declaration order, which is the object's own key order.
 *
 * The key depends on this, so **reordering dims is a breaking schema change**:
 * existing rows encoded under the old order will not match new ones.
 */
export function dimOrder(dims: Shape): string[] {
  return Object.keys(dims)
}

/**
 * The columns every live row a snapshot returns carries, added after the
 * metric's own. A dim or field of either name would be overwritten in every
 * snapshot row. The same two keys as `LiveFields` in runtime/live.ts.
 */
const LIVE_ROW_COLUMNS: readonly string[] = [
  'bucket_open',
  'bucket_elapsed_ms',
] satisfies readonly (keyof LiveFields)[]

/**
 * True for a key JavaScript lists before every other key.
 *
 * An object keeps its keys in the order they were written, except for a key
 * that reads as an array index, a whole number below 2^32 - 1 written without
 * a leading zero. Those come first, smallest first, whatever order they were
 * written in. The declared order is then lost before any code can see it.
 */
function isArrayIndex(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1
}

/**
 * Refuse a name no row can carry, or one whose place in the row cannot be
 * kept.
 *
 * `row.__proto__ = value` sets the row's prototype rather than adding a
 * column, so a dim or field with that name would be accepted and then be
 * missing from every row a sink receives. A name in `columns` is one the
 * metric writes on every row itself, and a dim or field of that name would
 * overwrite it or be overwritten.
 */
export function assertShapeNames(
  shape: Shape,
  metricName: string,
  noun = 'dim',
  columns: readonly string[] = [],
): void {
  if (Object.hasOwn(shape, '__proto__')) {
    throw new Error(
      `${metricName}: a ${noun} cannot be named "__proto__", because JavaScript treats that ` +
        "key as an object's prototype and no row could carry it",
    )
  }
  for (const key of Object.keys(shape)) {
    if (LIVE_ROW_COLUMNS.includes(key)) {
      throw new Error(
        `${metricName}: a ${noun} cannot be named ${JSON.stringify(key)}, because every row ` +
          'snapshot() returns carries a column of that name',
      )
    }
    if (columns.includes(key)) {
      throw new Error(
        `${metricName}: ${noun} ${JSON.stringify(key)} is a reserved column. MetricHouse ` +
          `writes [${columns.join(', ')}] on every row`,
      )
    }
    if (isArrayIndex(key)) {
      throw new Error(
        `${metricName}: a ${noun} cannot be named ${JSON.stringify(key)}, because JavaScript ` +
          'lists a key that reads as a whole number before every other key, and the order ' +
          `you declared would be lost. Give it a name such as "${noun}_${key}"`,
      )
    }
  }
}

/**
 * Refuse a dim no series key can hold, or one that shares a name with a
 * column in `columns`, the ones the metric writes on every row itself.
 */
export function assertDimsLegal(
  dims: Shape,
  metricName: string,
  columns: readonly string[] = [],
): void {
  assertShapeNames(dims, metricName, 'dim', columns)
  for (const [key, type] of Object.entries(dims)) {
    if (!type.dimLegal) {
      throw new Error(
        `${metricName}: dim ${JSON.stringify(key)} declares ${type.kind}(), which cannot be ` +
          'encoded into a series key. Put it on an event instead',
      )
    }
  }
}

export function escapeDimValue(value: string): string {
  // nearly every value holds neither character, and two scans cost less than
  // the four copies the split and join below would make of it
  if (!value.includes(ESCAPE) && !value.includes(DIM_SEPARATOR)) return value
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

/** True when `text` holds half of a surrogate pair, which UTF-8 cannot store. */
export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text)
}

function encodeDimValue(type: FieldType, value: unknown): string {
  if (type.kind === 'ts') return String((value as Date).getTime())
  if (type.kind === 'bool') return value ? 'true' : 'false'

  const text = String(value)
  if (hasLoneSurrogate(text)) {
    throw new Error(
      `dim value ${JSON.stringify(text)} holds half of a surrogate pair, which cannot be ` +
        'stored as UTF-8. It usually means a string was cut in the middle of an emoji',
    )
  }
  return text
}

function decodeDimValue(type: FieldType, raw: string): unknown {
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

/**
 * The caller's own enumerable value for `key`, the same set of keys an object
 * spread copies. A property the caller defined as non enumerable reads as
 * absent, as it did when the values were copied before they were read.
 *
 * {@link own} is enough where the values are a spread copy already, as in
 * {@link applyDimDefaults}, because a copy holds only enumerable keys. The
 * series key encoder reads the caller's object itself, so it needs this one.
 */
function ownEnumerable(values: object, key: string): unknown {
  return Object.prototype.propertyIsEnumerable.call(values, key)
    ? (values as Record<string, unknown>)[key]
    : undefined
}

/**
 * An encoder for one dims declaration, for a metric to build once and call
 * on every write.
 *
 * Does what {@link encodeDimKey} does, in the same order and with the same
 * errors: an undeclared key, then each declared dim in order, missing or of
 * the wrong type, then a value no key can store. Only the work that depends on
 * the declaration alone moves out of the call, which is listing its dims.
 * Nothing is kept from one call's values to the next, so a caller may reuse
 * and change one values object between writes.
 */
export function dimKeyEncoder(dims: Shape): (values: Record<string, unknown>) => string {
  const entries = Object.entries(dims) as [string, FieldType][]
  const declared = entries.map(([key]) => key)

  return (values) => {
    // `null` and `undefined` spread to nothing, so they are no dims at all
    const given: object = values ?? {}

    for (const key of Object.keys(given)) {
      if (!Object.hasOwn(dims, key)) {
        throw new Error(
          `unknown dim ${JSON.stringify(key)}. The declared dims are [${declared.join(', ')}]`,
        )
      }
    }

    // every dim is checked before any is encoded, so a bad type in a later
    // dim is reported ahead of a value an earlier one cannot store
    const filled: unknown[] = new Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      const [key, type] = entries[i] as [string, FieldType]
      let value = ownEnumerable(given, key)
      if (value === undefined && type.hasDefault) value = type.defaultValue
      if (value === undefined) {
        if (!type.isOptional) throw new Error(`missing required dim ${JSON.stringify(key)}`)
      } else {
        assertValue(type, value, key)
      }
      filled[i] = value
    }

    let key = ''
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) key += DIM_SEPARATOR
      const value = filled[i]
      key +=
        value === undefined
          ? DIM_ABSENT
          : escapeDimValue(encodeDimValue((entries[i] as [string, FieldType])[1], value))
    }
    return key
  }
}

/**
 * Encode one set of dim values. A metric builds a {@link dimKeyEncoder} once
 * instead, so its write path never lists the declaration again.
 */
export function encodeDimKey(dims: Shape, values: Record<string, unknown>): string {
  return dimKeyEncoder(dims)(values)
}

/**
 * True when a value of this type can encode to the empty string: any string,
 * or a `oneOf` that lists `''`. A number, a boolean and a Date never do.
 */
function canEncodeEmpty(type: FieldType): boolean {
  if (type.kind === 'str') return true
  return type.kind === 'oneOf' && (type.values ?? []).some((member) => String(member) === '')
}

/**
 * True when `key` is the empty key a metric with no dims stores its series
 * under, rather than a key written under `dims`.
 *
 * With two dims or more, a key written under them always holds a separator,
 * so the empty key can only be an older one. With one dim, it is older unless
 * that dim can itself encode to the empty string, and then the two cannot be
 * told apart and the key is read as that value.
 */
function isKeyFromNoDims(dims: Shape, order: readonly string[], key: string): boolean {
  if (key !== '' || order.length === 0) return false
  return order.length > 1 || !canEncodeEmpty(dims[order[0] as string] as FieldType)
}

/**
 * True when `key` was stored under an older declaration that had fewer dims
 * than `dims`, so {@link decodeDimKey} reads the dims it has no value for as
 * absent. A level reads its held series through this, because a series under
 * an older key is not the one the metric writes to now.
 */
export function isShorterDimKey(dims: Shape, key: string): boolean {
  const order = dimOrder(dims)
  if (isKeyFromNoDims(dims, order, key)) return true
  if (order.length === 0) return false
  return splitKey(key).length < order.length
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

  // the one series of a metric that had no dims, stored before its dims were
  // declared. Splitting it would read its empty text as the first dim's value,
  // a 0 or a false that was never recorded
  if (isKeyFromNoDims(dims, order, key)) return {}

  // fewer segments than dims is a key written before a dim was added at the
  // end. The dims it has no segment for were never recorded, so they come
  // back absent. More segments than dims means a dim was removed or the dims
  // were reordered, and nothing says which value belongs to which dim
  const segments = splitKey(key)
  if (segments.length > order.length) {
    throw new Error(
      `decodeDimKey: expected at most ${order.length} segments for [${order.join(', ')}], ` +
        `got ${segments.length}`,
    )
  }

  const values: Record<string, unknown> = {}
  order.forEach((name, index) => {
    const segment = segments[index]
    // an absent optional dim comes back missing, not as an undefined key
    if (segment === undefined || segment === DIM_ABSENT) return
    values[name] = decodeDimValue(dims[name] as FieldType, unescapeDimValue(segment))
  })
  return values
}

/**
 * A decoder for one dims declaration, for a metric to build once and call on
 * every row it materializes.
 *
 * Returns what {@link decodeDimKey} returns for every key, and throws what it
 * throws. Most keys hold no escape character, and for those a plain split is
 * the exact segmentation and every segment is already unescaped, so the
 * character by character scan is skipped. Any key the plain split cannot
 * speak for goes to {@link decodeDimKey} whole: a metric with no dims, the
 * empty key, a key with an escape or an absent marker in it (the marker holds
 * one), and a key with more segments than dims, which is an error.
 */
export function dimKeyDecoder(dims: Shape): (key: string) => Record<string, unknown> {
  const order = dimOrder(dims)
  const types = order.map((name) => dims[name] as FieldType)

  return (key) => {
    if (order.length === 0 || key === '' || key.includes(ESCAPE)) return decodeDimKey(dims, key)

    const segments = key.split(DIM_SEPARATOR)
    if (segments.length > order.length) return decodeDimKey(dims, key)

    // fewer segments than dims is a key from before a dim was added at the
    // end, and the dims past its last segment stay absent, as they do there
    const values: Record<string, unknown> = {}
    for (let i = 0; i < segments.length; i++) {
      values[order[i] as string] = decodeDimValue(types[i] as FieldType, segments[i] as string)
    }
    return values
  }
}

export function applyDimDefaults(
  dims: Shape,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...values }

  for (const [key, type] of Object.entries(dims)) {
    // only a genuinely absent key is filled. A falsy value the caller
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
 * only difference between the two is what a mistake should be called. The
 * required/optional/default rules are identical.
 */
export function validateDims(dims: Shape, values: Record<string, unknown>, noun = 'dim'): void {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(dims, key)) {
      throw new Error(
        `unknown ${noun} ${JSON.stringify(key)}. The declared ${noun}s are ` +
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
