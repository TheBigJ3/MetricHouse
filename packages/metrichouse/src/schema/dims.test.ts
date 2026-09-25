import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyDimDefaults,
  assertDimsLegal,
  DIM_ABSENT,
  decodeDimKey,
  dimOrder,
  encodeDimKey,
  escapeDimValue,
  unescapeDimValue,
  validateDims,
} from './dims.js'
import { bool, int, json, oneOf, str, ts } from './types.js'

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

// built per-test: the stubs throw, and a module-scope call would take the
// whole file down instead of failing one assertion at a time
const makeDims = () => ({ dogName: str(), park: str(), kind: oneOf(['solid', 'liquid']) })
let dims: ReturnType<typeof makeDims>
beforeEach(() => {
  dims = makeDims()
})

describe('dimOrder', () => {
  it('is the declaration order of the object', () => {
    expect(dimOrder(dims)).toEqual(['dogName', 'park', 'kind'])
  })

  it('is order-sensitive — reordering dims is a breaking schema change', () => {
    expect(dimOrder({ b: str(), a: str() })).toEqual(['b', 'a'])
    expect(dimOrder({ a: str(), b: str() })).toEqual(['a', 'b'])
  })

  it('handles an empty dim set', () => {
    expect(dimOrder({})).toEqual([])
  })
})

describe('assertDimsLegal', () => {
  it('accepts every keyable type', () => {
    expect(() =>
      assertDimsLegal({ a: str(), b: int(), c: bool(), d: ts(), e: oneOf(['x']) }, 'm'),
    ).not.toThrow()
  })

  it('rejects json() — a payload cannot be a series key', () => {
    const err = expectRejected(() => assertDimsLegal({ payload: json() }, 'dog_poops'))
    expect(err.message).toMatch(/payload/)
    expect(err.message).toMatch(/dog_poops/)
  })
})

describe('escaping', () => {
  it('escapes backslash and separator', () => {
    expect(escapeDimValue('a|b')).toBe('a\\|b')
    expect(escapeDimValue('a\\b')).toBe('a\\\\b')
  })

  it('leaves ordinary values alone', () => {
    expect(escapeDimValue('Willow')).toBe('Willow')
    expect(escapeDimValue('')).toBe('')
  })

  it('round-trips values containing both metacharacters', () => {
    for (const raw of ['a|b', 'a\\b', '\\|', '|\\', 'a\\|b', '\\\\', '||', DIM_ABSENT, '']) {
      expect(unescapeDimValue(escapeDimValue(raw))).toBe(raw)
    }
  })

  it('never lets an escaped value collide with the absent sentinel', () => {
    // this is the bug that would silently merge "absent" with a literal '\0'
    expect(escapeDimValue(DIM_ABSENT)).not.toBe(DIM_ABSENT)
  })
})

describe('encodeDimKey', () => {
  it('joins in declaration order', () => {
    expect(encodeDimKey(dims, { dogName: 'Willow', park: 'riverside', kind: 'solid' })).toBe(
      'Willow|riverside|solid',
    )
  })

  it('ignores the order the caller happened to write', () => {
    const a = encodeDimKey(dims, { kind: 'solid', park: 'riverside', dogName: 'Willow' })
    const b = encodeDimKey(dims, { dogName: 'Willow', park: 'riverside', kind: 'solid' })
    expect(a).toBe(b)
  })

  it('distinguishes series that differ in one dim', () => {
    const w = { dogName: 'Willow', park: 'riverside', kind: 'solid' } as const
    expect(encodeDimKey(dims, w)).not.toBe(encodeDimKey(dims, { ...w, park: 'central' }))
  })

  it('escapes values so a separator in data cannot forge a boundary', () => {
    const key = encodeDimKey(dims, { dogName: 'a|b', park: 'c', kind: 'solid' })
    expect(key).toBe('a\\|b|c|solid')
    expect(decodeDimKey(dims, key)).toEqual({ dogName: 'a|b', park: 'c', kind: 'solid' })
  })

  it('does not conflate an empty string with an absent optional dim', () => {
    const d = { a: str(), b: str().optional() }
    expect(encodeDimKey(d, { a: 'x', b: '' })).not.toBe(encodeDimKey(d, { a: 'x' }))
  })

  it('keeps key arity fixed whether or not optionals are present', () => {
    const d = { a: str(), b: str().optional() }
    const present = encodeDimKey(d, { a: 'x', b: 'y' }).split('|').length
    const absent = encodeDimKey(d, { a: 'x' }).split('|').length
    expect(absent).toBe(present)
  })

  it('encodes non-strings', () => {
    const d = { n: int(), flag: bool(), at: ts() }
    expect(encodeDimKey(d, { n: 7, flag: false, at: new Date(1500) })).toBe('7|false|1500')
  })

  it('applies defaults for omitted keys', () => {
    const d = { a: str(), b: str().default('riverside') }
    expect(encodeDimKey(d, { a: 'x' })).toBe(encodeDimKey(d, { a: 'x', b: 'riverside' }))
  })

  it('encodes an empty dim set as an empty key', () => {
    expect(encodeDimKey({}, {})).toBe('')
  })

  it('rejects a missing required dim', () => {
    expect(expectRejected(() => encodeDimKey(dims, { dogName: 'Willow' })).message).toMatch(/park/)
  })

  it('rejects an unknown key', () => {
    const err = expectRejected(() =>
      encodeDimKey(dims, { dogName: 'W', park: 'r', kind: 'solid', breed: 'corgi' }),
    )
    expect(err.message).toMatch(/breed/)
  })

  it('rejects a value outside a oneOf set', () => {
    expectRejected(() => encodeDimKey(dims, { dogName: 'W', park: 'r', kind: 'gas' }))
  })
})

describe('decodeDimKey', () => {
  it('inverts encodeDimKey', () => {
    const values = { dogName: 'Willow', park: 'riverside', kind: 'solid' }
    expect(decodeDimKey(dims, encodeDimKey(dims, values))).toEqual(values)
  })

  it('restores declared types, not strings', () => {
    const d = { n: int(), flag: bool(), at: ts() }
    const values = { n: 7, flag: false, at: new Date(1500) }
    expect(decodeDimKey(d, encodeDimKey(d, values))).toEqual(values)
  })

  it('omits absent optional dims rather than setting them undefined', () => {
    const d = { a: str(), b: str().optional() }
    const decoded = decodeDimKey(d, encodeDimKey(d, { a: 'x' }))
    expect(decoded).toEqual({ a: 'x' })
    expect('b' in decoded).toBe(false)
  })

  it('round-trips values full of metacharacters', () => {
    for (const raw of ['a|b', 'a\\b', '|', '\\', '\\|\\|', DIM_ABSENT, '']) {
      const values = { dogName: raw, park: 'p', kind: 'solid' as const }
      expect(decodeDimKey(dims, encodeDimKey(dims, values))).toEqual(values)
    }
  })

  it('rejects a key with the wrong number of segments', () => {
    expectRejected(() => decodeDimKey(dims, 'Willow|riverside'))
    expectRejected(() => decodeDimKey(dims, 'Willow|riverside|solid|extra'))
  })
})

describe('applyDimDefaults', () => {
  it('fills omitted keys that declare a default', () => {
    const d = { a: str(), b: str().default('riverside') }
    expect(applyDimDefaults(d, { a: 'x' })).toEqual({ a: 'x', b: 'riverside' })
  })

  it('leaves a provided value alone, including a falsy one', () => {
    const d = { a: str().default('fallback'), n: int().default(9) }
    expect(applyDimDefaults(d, { a: '', n: 0 })).toEqual({ a: '', n: 0 })
  })

  it('leaves optional keys without a default absent', () => {
    const d = { a: str(), b: str().optional() }
    expect(applyDimDefaults(d, { a: 'x' })).toEqual({ a: 'x' })
  })

  it('does not mutate the caller object', () => {
    const d = { a: str(), b: str().default('r') }
    const input = { a: 'x' }
    applyDimDefaults(d, input)
    expect(input).toEqual({ a: 'x' })
  })
})

describe('validateDims', () => {
  it('accepts a complete value set', () => {
    expect(() =>
      validateDims(dims, { dogName: 'Willow', park: 'riverside', kind: 'solid' }),
    ).not.toThrow()
  })

  it('rejects a missing required dim, naming it', () => {
    expect(
      expectRejected(() => validateDims(dims, { dogName: 'W', kind: 'solid' })).message,
    ).toMatch(/park/)
  })

  it('rejects an unknown key, naming it', () => {
    expect(
      expectRejected(() =>
        validateDims(dims, { dogName: 'W', park: 'r', kind: 'solid', breed: 'corgi' }),
      ).message,
    ).toMatch(/breed/)
  })

  it('rejects a bad oneOf member, naming the key', () => {
    expect(
      expectRejected(() => validateDims(dims, { dogName: 'W', park: 'r', kind: 'gas' })).message,
    ).toMatch(/kind/)
  })

  it('accepts an omitted optional dim', () => {
    const d = { a: str(), b: str().optional() }
    expect(() => validateDims(d, { a: 'x' })).not.toThrow()
  })
})

describe('values that used to slip through', () => {
  it('decodes a numeric oneOf member as the number it was declared as', () => {
    const party = { size: oneOf([1, 2, 4]) }
    expect(decodeDimKey(party, encodeDimKey(party, { size: 2 }))).toEqual({ size: 2 })
  })

  it('refuses a oneOf whose members print the same', () => {
    expect(() => oneOf(['2', 2])).toThrow(/prints the same/)
  })

  it('treats keys named after Object.prototype as unknown, not as present', () => {
    const plain = { tier: str() }
    expect(() => validateDims(plain, { tier: 'vip', constructor: 'x' })).toThrow(/unknown dim/)
    expect(() => validateDims(plain, JSON.parse('{"tier":"vip","__proto__":1}'))).toThrow(
      /unknown dim/,
    )
  })

  it('lets an optional dim named constructor be left out', () => {
    const shape = { constructor: str().optional(), toString: str().default('x') }
    expect(() => validateDims(shape, applyDimDefaults(shape, {}))).not.toThrow()
    expect(decodeDimKey(shape, encodeDimKey(shape, {}))).toEqual({ toString: 'x' })
  })

  it('accepts a Date made in another realm', async () => {
    const { runInNewContext } = await import('node:vm')
    const foreign = runInNewContext('new Date(5000)') as Date
    const shape = { at: ts() }
    expect(decodeDimKey(shape, encodeDimKey(shape, { at: foreign }))).toEqual({
      at: new Date(5000),
    })
  })

  it('refuses a dim value holding half of a surrogate pair', () => {
    const shape = { tenant: str() }
    expect(() => encodeDimKey(shape, { tenant: 'a\uD83D' })).toThrow(/surrogate/)
    expect(() => encodeDimKey(shape, { tenant: 'a😀' })).not.toThrow()
  })
})
