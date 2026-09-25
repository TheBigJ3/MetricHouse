/**
 * Type builders.
 *
 * A declaration is inert data: `str()` returns a descriptor, not a validator
 * bound to anything. The house reads these later; the type system reads them
 * immediately, which is what makes `.add()` narrow without codegen.
 */

/** Every type a dim or field can declare. */
export type TypeKind = 'str' | 'int' | 'float' | 'bool' | 'oneOf' | 'ts' | 'json'

/**
 * A declared type.
 *
 * `TOptional` tracks omittability *at the call site*, and `.default()` sets it
 * as surely as `.optional()` does — a dim with a default may be omitted, which
 * is the only thing the caller's types care about. The runtime difference
 * survives in {@link FieldType.hasDefault}.
 */
export interface FieldType<TValue = unknown, TOptional extends boolean = boolean> {
  readonly kind: TypeKind
  /** May the caller omit this key? True for `.optional()` and `.default()`. */
  readonly isOptional: TOptional
  readonly hasDefault: boolean
  readonly defaultValue: TValue | undefined
  /** `oneOf` only: the closed set, in declaration order. */
  readonly values: readonly TValue[] | undefined
  /** False for `json()` — you cannot key a series on a payload. */
  readonly dimLegal: boolean

  /** Clone, marked omittable. */
  optional(): FieldType<TValue, true>
  /** Clone, carrying a value used when the call omits this key. */
  default(value: TValue): FieldType<TValue, true>
}

/** A set of declared types, keyed by name. Declaration order is significant. */
export type Shape = Record<string, FieldType>

/** The value type a declared type accepts. */
export type InferValue<F> = F extends FieldType<infer V, boolean> ? V : never

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K]['isOptional'] extends true ? K : never
}[keyof S]

/**
 * The object a call site passes — required keys required, `.optional()` and
 * `.default()` keys omittable, `oneOf` narrowed to its union.
 */
/** Flattens an intersection into one object type, so hovers and type equality behave. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

export type InferShape<S extends Shape> = Simplify<
  {
    [K in Exclude<keyof S, OptionalKeys<S>>]: InferValue<S[K]>
  } & {
    [K in OptionalKeys<S>]?: InferValue<S[K]>
  }
>

/** The keys a call site must supply — neither `.optional()` nor `.default()`. */
export type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>

/**
 * A values argument, omittable only when nothing in the shape is required.
 *
 * Stricter than `DimsArgs`, which demands the argument whenever any dim is
 * declared: this one lets `log.info('started')` and `span.end()` stand alone
 * once every remaining key is optional.
 */
export type ShapeArgs<S extends Shape> = [RequiredKeys<S>] extends [never]
  ? [values?: InferShape<S>]
  : [values: InferShape<S>]

/**
 * The same shape with `K` made omittable — what is left to supply once some
 * values have been bound in advance.
 *
 * Omittable rather than *removed*: removing a bound key satisfies it, which is
 * the point of binding, but would also make overriding it at one call site a
 * type error. A bound value is a default, not a lock.
 */
export type MarkOptional<S extends Shape, K extends PropertyKey> = {
  [P in keyof S]: P extends K ? FieldType<InferValue<S[P]>, true> : S[P]
}

/** Everything a constructor can vary. Carried through modifiers unchanged. */
interface TypeOpts<TValue> {
  hasDefault?: boolean
  defaultValue?: TValue
  values?: readonly TValue[]
  dimLegal?: boolean
}

/**
 * Build a descriptor. Modifiers call back into this rather than mutating, so
 * every declaration is a fresh frozen object and sharing one across metrics is
 * safe.
 */
function make<TValue, TOptional extends boolean>(
  kind: TypeKind,
  isOptional: TOptional,
  opts: TypeOpts<TValue> = {},
): FieldType<TValue, TOptional> {
  const self: FieldType<TValue, TOptional> = {
    kind,
    isOptional,
    hasDefault: opts.hasDefault ?? false,
    defaultValue: opts.defaultValue,
    values: opts.values,
    dimLegal: opts.dimLegal ?? true,

    optional: () => make<TValue, true>(kind, true, opts),

    default: (value: TValue) => {
      // validated here, at declare time, rather than at the first write
      assertValue(self as FieldType, value, `default for ${kind}()`)
      // assertValue lets any payload through, because an event checks json
      // while it converts it. A default is never converted until the first
      // record, so it is checked here instead
      if (kind === 'json') jsonText(value, `default for ${kind}()`)
      return make<TValue, true>(kind, true, { ...opts, hasDefault: true, defaultValue: value })
    },
  }
  return Object.freeze(self)
}

export function str(): FieldType<string, false> {
  return make<string, false>('str', false)
}

export function int(): FieldType<number, false> {
  return make<number, false>('int', false)
}

export function float(): FieldType<number, false> {
  return make<number, false>('float', false)
}

export function bool(): FieldType<boolean, false> {
  return make<boolean, false>('bool', false)
}

/** A timestamp. Carried as a `Date`; encoded as epoch milliseconds. */
export function ts(): FieldType<Date, false> {
  return make<Date, false>('ts', false)
}

/**
 * A closed set, narrowed to a union at the call site.
 *
 * `oneOf(['solid', 'liquid'])` makes `.add({ kind: 'sold' })` a type error.
 * The `const` type parameter means a caller need not write `as const`, though
 * writing it is harmless.
 */
export function oneOf<const T extends readonly (string | number)[]>(
  values: T,
): FieldType<T[number], false> {
  if (values.length === 0) {
    throw new Error('oneOf: the set must declare at least one member')
  }

  // a dim is stored as text, so two members that print the same would come
  // back as whichever of them was declared first
  const printed = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`oneOf: members must be strings or finite numbers, got ${describe(value)}`)
    }
    if (printed.has(String(value))) {
      throw new Error(
        `oneOf: ${JSON.stringify(value)} prints the same as another member, so the two could ` +
          'not be told apart once stored',
      )
    }
    printed.add(String(value))
  }

  return make<T[number], false>('oneOf', false, { values: Object.freeze([...values]) })
}

/**
 * An arbitrary payload. Legal on event and log fields, **rejected as a dim** —
 * a payload cannot be losslessly encoded into a series key.
 */
export function json<T = unknown>(): FieldType<T, false> {
  return make<T, false>('json', false, { dimLegal: false })
}

/**
 * True for a `Date`, including one made in another realm.
 *
 * `instanceof Date` is false for a Date built inside `vm`, a worker or an
 * iframe, because each realm has its own `Date` constructor. The internal
 * class tag is the same everywhere, so this reads that instead.
 */
export function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]'
}

/**
 * The JSON text for a `json()` value, or a thrown error naming the field.
 *
 * `JSON.stringify` is what every driver and every sink ends up running on the
 * value, so it is also the test of whether the value is legal. It throws on a
 * BigInt and on a cycle, and it returns `undefined` for a function, a symbol
 * and `undefined` itself. Catching those at `record()` means the caller hears
 * about them, where a failure at flush would take the whole batch down.
 */
export function jsonText(value: unknown, label: string): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: json() needs a value JSON can hold, and this one failed: ${reason}`)
  }
  if (text === undefined) {
    throw new Error(`${label}: json() needs a value JSON can hold, got ${describe(value)}`)
  }
  return text
}

/**
 * Assert a runtime value satisfies a declared type.
 *
 * `label` is interpolated into the message so a failure names the offending
 * key rather than making the caller guess which dim was wrong.
 *
 * `undefined` is rejected here — omission is {@link FieldType.isOptional}'s
 * business, checked before this is called.
 *
 * @throws if the value does not satisfy the type
 */
export function assertValue(type: FieldType, value: unknown, label: string): void {
  if (value === undefined) {
    throw new Error(`${label}: a value is required`)
  }

  switch (type.kind) {
    case 'json':
      // a payload is whatever the caller says it is
      return

    case 'str':
      if (typeof value !== 'string') {
        throw new Error(`${label}: expected a string, got ${describe(value)}`)
      }
      return

    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`${label}: expected a safe integer, got ${describe(value)}`)
      }
      return

    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}: expected a finite number, got ${describe(value)}`)
      }
      return

    case 'bool':
      if (typeof value !== 'boolean') {
        throw new Error(`${label}: expected a boolean, got ${describe(value)}`)
      }
      return

    case 'ts':
      if (!isDate(value) || Number.isNaN(value.getTime())) {
        throw new Error(`${label}: expected a valid Date, got ${describe(value)}`)
      }
      return

    case 'oneOf':
      if (!type.values?.includes(value as never)) {
        const members = type.values?.map((v) => JSON.stringify(v)).join(', ') ?? ''
        throw new Error(`${label}: ${describe(value)} is not one of [${members}]`)
      }
      return
  }
}

/** A short, safe rendering of an arbitrary value for an error message. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (isDate(value)) return `Date(${value.toISOString()})`
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  return typeof value
}
