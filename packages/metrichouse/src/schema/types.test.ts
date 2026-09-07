import { describe, expect, it } from 'vitest'
import { assertValue, bool, float, type InferShape, int, json, oneOf, str, ts } from './types.js'

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

describe('constructors', () => {
  it('tag their kind', () => {
    expect(str().kind).toBe('str')
    expect(int().kind).toBe('int')
    expect(float().kind).toBe('float')
    expect(bool().kind).toBe('bool')
    expect(ts().kind).toBe('ts')
    expect(json().kind).toBe('json')
    expect(oneOf(['a', 'b']).kind).toBe('oneOf')
  })

  it('are required and undefaulted by default', () => {
    const t = str()
    expect(t.isOptional).toBe(false)
    expect(t.hasDefault).toBe(false)
    expect(t.defaultValue).toBeUndefined()
  })

  it('are legal as dims, except json', () => {
    for (const t of [str(), int(), float(), bool(), ts(), oneOf(['a'])]) {
      expect(t.dimLegal).toBe(true)
    }
    // a payload cannot be losslessly encoded into a series key
    expect(json().dimLegal).toBe(false)
  })

  it('carries the closed set on oneOf, in declaration order', () => {
    expect(oneOf(['solid', 'liquid']).values).toEqual(['solid', 'liquid'])
    expect(str().values).toBeUndefined()
  })

  it('rejects an empty oneOf', () => {
    expectRejected(() => oneOf([]))
  })
})

describe('modifiers', () => {
  it('optional() marks the key omittable', () => {
    expect(str().optional().isOptional).toBe(true)
  })

  it('default() also marks it omittable, and records the value', () => {
    const t = str().default('riverside')
    expect(t.isOptional).toBe(true)
    expect(t.hasDefault).toBe(true)
    expect(t.defaultValue).toBe('riverside')
  })

  it('does not mutate the receiver — declarations are inert and shareable', () => {
    const base = str()
    const opt = base.optional()
    const def = base.default('x')
    expect(base.isOptional).toBe(false)
    expect(base.hasDefault).toBe(false)
    expect(opt).not.toBe(base)
    expect(def).not.toBe(base)
  })

  it('preserves kind and the oneOf set through modifiers', () => {
    const t = oneOf(['solid', 'liquid']).optional()
    expect(t.kind).toBe('oneOf')
    expect(t.values).toEqual(['solid', 'liquid'])
  })

  it('chains', () => {
    const t = str().optional().default('x')
    expect(t.isOptional).toBe(true)
    expect(t.defaultValue).toBe('x')
  })

  it('rejects a default that does not satisfy the type', () => {
    expectRejected(() => oneOf(['solid', 'liquid']).default('gas' as 'solid'))
  })
})

describe('assertValue', () => {
  it('accepts values matching the type', () => {
    expect(() => assertValue(str(), 'Willow', 'dogName')).not.toThrow()
    expect(() => assertValue(int(), 7, 'n')).not.toThrow()
    expect(() => assertValue(float(), 1.5, 'n')).not.toThrow()
    expect(() => assertValue(bool(), false, 'b')).not.toThrow()
    expect(() => assertValue(ts(), new Date(), 't')).not.toThrow()
    expect(() => assertValue(oneOf(['solid', 'liquid']), 'solid', 'kind')).not.toThrow()
  })

  it('accepts anything for json', () => {
    expect(() => assertValue(json(), { a: [1, { b: null }] }, 'payload')).not.toThrow()
  })

  it('rejects a wrong primitive', () => {
    expectRejected(() => assertValue(str(), 7, 'dogName'))
    expectRejected(() => assertValue(int(), 'seven', 'n'))
    expectRejected(() => assertValue(bool(), 'true', 'b'))
    expectRejected(() => assertValue(ts(), 1_700_000_000_000, 't'))
  })

  it('requires int to be a safe integer, but lets float be fractional', () => {
    expectRejected(() => assertValue(int(), 1.5, 'n'))
    expectRejected(() => assertValue(int(), Number.NaN, 'n'))
    expect(() => assertValue(float(), 1.5, 'n')).not.toThrow()
  })

  it('rejects non-finite floats', () => {
    expectRejected(() => assertValue(float(), Number.POSITIVE_INFINITY, 'n'))
    expectRejected(() => assertValue(float(), Number.NaN, 'n'))
  })

  it('rejects a value outside a oneOf set', () => {
    expectRejected(() => assertValue(oneOf(['solid', 'liquid']), 'gas', 'kind'))
  })

  it('rejects undefined — omission is checked before this point', () => {
    expectRejected(() => assertValue(str(), undefined, 'dogName'))
  })

  it('names the offending key', () => {
    expect(expectRejected(() => assertValue(str(), 7, 'dogName')).message).toMatch(/dogName/)
  })
})

/**
 * Type-level assertions. These are checked by `pnpm typecheck`, not at
 * runtime — a red squiggle here is a real failure even though vitest is green.
 */
const makeDims = () => ({
  dogName: str(),
  park: str().optional(),
  kind: oneOf(['solid', 'liquid']),
  visits: int().default(1),
})

type Equal<X, Y> =
  (<G>() => G extends X ? 1 : 2) extends <G>() => G extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

// oneOf narrows to a union; optional() and default() keys become omittable
type _InferShapeIsExact = Expect<
  Equal<
    InferShape<ReturnType<typeof makeDims>>,
    { dogName: string; kind: 'solid' | 'liquid'; park?: string; visits?: number }
  >
>

// oneOf is the narrowed union, not string — this is what makes a typo at the
// call site a compile error rather than a new series
type _KindIsNarrowed = Expect<
  Equal<InferShape<ReturnType<typeof makeDims>>['kind'], 'solid' | 'liquid'>
>

describe('InferShape', () => {
  it('is asserted at the type level above', () => {
    expect(true).toBe(true)
  })
})
