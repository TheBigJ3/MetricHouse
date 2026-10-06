import { isDeepStrictEqual } from 'node:util'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyDimDefaults,
  assertDimsLegal,
  DIM_ABSENT,
  decodeDimKey,
  dimKeyCurrent,
  dimKeyDecoder,
  dimKeyEncoder,
  dimKeyReader,
  dimOrder,
  encodeDimKey,
  escapeDimValue,
  isDecodableDimKey,
  isShorterDimKey,
  reportedOnce,
  unescapeDimValue,
  validateDims,
} from './dims.js'
import { bool, float, int, json, oneOf, str, ts } from './types.js'

// built per test, so no test can change the shape another one reads
const makeDims = () => ({ dogName: str(), park: str(), kind: oneOf(['solid', 'liquid']) })
let dims: ReturnType<typeof makeDims>
beforeEach(() => {
  dims = makeDims()
})

describe('dimOrder', () => {
  it('is the declaration order of the object', () => {
    expect(dimOrder(dims)).toEqual(['dogName', 'park', 'kind'])
  })

  it('is order-sensitive, so reordering dims is a breaking schema change', () => {
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

  it('rejects json(), since a payload cannot be a series key', () => {
    expect(() => assertDimsLegal({ payload: json() }, 'dog_poops')).toThrow(
      'dog_poops: dim "payload" declares json(), which cannot be encoded into a series key. ' +
        'Put it on an event instead',
    )
  })

  it('rejects a name JavaScript would move ahead of the others', () => {
    // `{ region, 2024 }` lists 2024 first, so the declared order is gone
    // before any code can read it
    expect(() => assertDimsLegal({ region: str(), 2024: str() }, 'm')).toThrow(
      new Error(
        'm: a dim cannot be named "2024", because JavaScript lists a key that reads as a whole number before every other key, and the order you declared would be lost. Give it a name such as "dim_2024"',
      ),
    )
  })

  it('accepts a name that reads like a number but keeps its place', () => {
    // a leading zero, or a value past the largest array index, is an
    // ordinary key and stays where it was written
    const kept = { region: str(), '01': str(), '4294967295': str() }
    expect(() => assertDimsLegal(kept, 'm')).not.toThrow()
    expect(dimOrder(kept)).toEqual(['region', '01', '4294967295'])
  })

  it('rejects a name among the columns the metric writes itself', () => {
    expect(() => assertDimsLegal({ value: str() }, 'm', ['id', 'value'])).toThrow(
      new Error('m: dim "value" is a reserved column. MetricHouse writes [id, value] on every row'),
    )
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
    expect(() => encodeDimKey(dims, { dogName: 'Willow' })).toThrow('missing required dim "park"')
  })

  it('rejects an unknown key', () => {
    expect(() =>
      encodeDimKey(dims, { dogName: 'W', park: 'r', kind: 'solid', breed: 'corgi' }),
    ).toThrow('unknown dim "breed". The declared dims are [dogName, park, kind]')
  })

  it('rejects a value outside a oneOf set', () => {
    expect(() => encodeDimKey(dims, { dogName: 'W', park: 'r', kind: 'gas' })).toThrow(
      'kind: "gas" is not one of ["solid", "liquid"]',
    )
  })
})

describe('decodeDimKey', () => {
  it.each([
    ['int', int(), 'abc', 'is not a safe integer'],
    ['int', int(), '2.5', 'is not a safe integer'],
    ['float', float(), 'abc', 'is not a finite number'],
    ['ts', ts(), 'soon', 'is not a valid timestamp'],
    ['bool', bool(), 'yes', 'is not "true" or "false"'],
    ['oneOf', oneOf(['a', 'b']), 'c', 'is not one of the declared members'],
  ])('refuses a stored value the dim %s can no longer hold', (kind, type, raw, why) => {
    const shape = { x: type }
    const message =
      `decodeDimKey: dim "x" is declared as ${kind}(), but the stored value ` +
      `${JSON.stringify(raw)} ${why}. The stored series was written under an earlier declaration`
    expect(() => decodeDimKey(shape, raw)).toThrow(new Error(message))
    expect(() => dimKeyDecoder(shape)(raw)).toThrow(new Error(message))
  })

  it('refuses an absent marker for a dim that is required or defaulted now', () => {
    expect(() => decodeDimKey({ a: str(), b: str() }, `x|${DIM_ABSENT}`)).toThrow(
      new Error(
        'decodeDimKey: dim "b" is required now, but the stored key has no value for it. The ' +
          'stored series was written under an earlier declaration',
      ),
    )
    expect(() => decodeDimKey({ a: str().default('d') }, DIM_ABSENT)).toThrow(/is defaulted now/)
  })

  it('reads a key back with the marker for an optional dim', () => {
    expect(decodeDimKey({ a: str(), b: str().optional() }, `x|${DIM_ABSENT}`)).toEqual({ a: 'x' })
  })

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

  it('reads the dims a key written before they were added as absent', () => {
    const decoded = decodeDimKey(dims, 'Willow|riverside')
    expect(decoded).toEqual({ dogName: 'Willow', park: 'riverside' })
    expect('kind' in decoded).toBe(false)
  })

  it('rejects a key with more segments than dims', () => {
    expect(() => decodeDimKey(dims, 'Willow|riverside|solid|extra')).toThrow(
      'decodeDimKey: expected at most 3 segments for [dogName, park, kind], got 4',
    )
  })

  it('reads the empty key as every dim absent when two or more are declared', () => {
    expect(decodeDimKey({ shard: int(), route: str() }, '')).toEqual({})
    expect(decodeDimKey({ route: str(), shard: int() }, '')).toEqual({})
  })

  it('reads the empty key as a single dim absent when its type never encodes to empty', () => {
    for (const type of [int(), float(), bool(), ts(), oneOf(['a', 1])]) {
      expect(decodeDimKey({ only: type }, '')).toEqual({})
    }
  })

  it('reads the empty key as the empty value of a single dim that can encode to it', () => {
    expect(decodeDimKey({ only: str() }, '')).toEqual({ only: '' })
    expect(decodeDimKey({ only: oneOf(['', 'a']) }, '')).toEqual({ only: '' })
  })
})

describe('decodeDimKey on numbers and timestamps', () => {
  it.each([
    ['int', int(), ['0x1F', '1e3', ' 7', '7 ', '+5', '007', '-0', '7.0']],
    ['float', float(), ['0x1F', '1e3', ' 7', '+5', '007', '-0', '1.0', '.5', '1E+21']],
    ['ts', ts(), ['007', '-0', '+5', ' 7', '1e3']],
  ])('refuses text the encoder never writes for a %s', (_kind, type, texts) => {
    for (const raw of texts) {
      expect(() => decodeDimKey({ x: type }, raw), JSON.stringify(raw)).toThrow(
        /^decodeDimKey: dim "x"/,
      )
      expect(() => dimKeyDecoder({ x: type })(raw), JSON.stringify(raw)).toThrow(
        /^decodeDimKey: dim "x"/,
      )
    }
  })

  it('reads back every number the encoder writes, at the ends of the range', () => {
    const ints = [0, 1, -1, 123456789, -123456789, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]
    for (const n of ints) {
      expect(decodeDimKey({ x: int() }, encodeDimKey({ x: int() }, { x: n }))).toEqual({ x: n })
    }
    const floats = [
      0,
      0.1,
      -1.5,
      1e21,
      -1e21,
      1e-7,
      5e-324,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      2 ** 53,
    ]
    for (const n of floats) {
      expect(decodeDimKey({ x: float() }, encodeDimKey({ x: float() }, { x: n }))).toEqual({ x: n })
    }
  })

  it('reads negative zero, which the encoder writes as "0", back as zero', () => {
    expect(encodeDimKey({ x: float() }, { x: -0 })).toBe('0')
    expect(decodeDimKey({ x: float() }, '0')).toEqual({ x: 0 })
  })
})

describe('dimKeyCurrent', () => {
  it('answers what isShorterDimKey and isDecodableDimKey say together for every key', () => {
    const shapes = [
      {},
      { only: str() },
      { only: int() },
      { a: str(), b: int().optional() },
      { a: str(), b: str().default('d') },
      { a: int(), b: bool(), c: oneOf(['x', 'y']) },
    ]
    const fragments = ['', 'a', 'x', '1', '0x1', 'true', '\\', '\\|', DIM_ABSENT, '-0']
    const keys = new Set<string>()
    for (const one of fragments) {
      keys.add(one)
      for (const two of fragments) {
        keys.add(`${one}|${two}`)
        for (const three of fragments) keys.add(`${one}|${two}|${three}`)
      }
    }
    keys.add('a|b|c|d')
    for (const shape of shapes) {
      const current = dimKeyCurrent(shape)
      for (const key of keys) {
        expect(current(key), `${JSON.stringify(Object.keys(shape))} ${JSON.stringify(key)}`).toBe(
          !isShorterDimKey(shape, key) && isDecodableDimKey(shape, key),
        )
      }
    }
  })
})

describe('dimKeyReader', () => {
  const shape = { a: int(), b: str().optional(), c: ts().optional() }

  function reader() {
    const errors: string[] = []
    const read = dimKeyReader(shape, 'orders', (error) => errors.push(error.message))
    return { read, errors }
  }

  it('reads a key it can read as dimKeyDecoder does and reports nothing', () => {
    const { read, errors } = reader()
    expect(read(`5|x|${DIM_ABSENT}`)).toEqual({ a: 5, b: 'x' })
    expect(errors).toEqual([])
  })

  it('returns the stored text of a dim it cannot read and reports the dim and the text', () => {
    const { read, errors } = reader()
    expect(read('abc|x|1500')).toEqual({ a: 'abc', b: 'x', c: new Date(1500) })
    expect(errors).toEqual([
      'orders: stored series key "abc|x|1500" cannot be read under the current dims: dim "a" is ' +
        'declared as int(), but the stored value "abc" is not a safe integer. The stored series ' +
        "was written under an earlier declaration. It ships with the stored text as each unreadable dim's value",
    ])
  })

  it('returns every unreadable dim as text, undoes its escapes and leaves an absent marker absent', () => {
    const { read } = reader()
    const values = read(`0x1F|a\\|b|nope`)
    expect(values).toEqual({ a: '0x1F', b: 'a|b', c: 'nope' })
    expect(read(`abc|${DIM_ABSENT}|${DIM_ABSENT}`)).toEqual({ a: 'abc' })
  })

  it('returns the dims a key with too many segments has a dim for and reports the count', () => {
    const { read, errors } = reader()
    expect(read('1|x|1500|extra')).toEqual({ a: 1, b: 'x', c: new Date(1500) })
    expect(errors).toEqual([
      'orders: stored series key "1|x|1500|extra" cannot be read under the current dims: expected ' +
        "at most 3 segments for [a, b, c], got 4. It ships with the stored text as each unreadable dim's value",
    ])
  })

  it('reports a dim that is required now but stored as absent, and leaves it out', () => {
    const errors: string[] = []
    const read = dimKeyReader({ a: str(), b: str() }, 'orders', (error) =>
      errors.push(error.message),
    )
    expect(read(`x|${DIM_ABSENT}`)).toEqual({ a: 'x' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('dim "b" is required now')
  })

  it('reports each key once however often it is read, and each different key once', () => {
    const { read, errors } = reader()
    read('abc')
    read('abc')
    read('abd')
    read('abc')
    expect(errors).toHaveLength(2)
  })

  it('reports past 10,000 unreadable keys once, and not again on the next read', () => {
    const { read, errors } = reader()
    for (let i = 0; i < 10_001; i++) read(`x${i}`)
    expect(errors).toHaveLength(10_001)
    expect(errors.at(-1)).toBe(
      'orders: more than 10,000 stored series keys cannot be read under the current dims. Each ' +
        "ships with the stored text as each unreadable dim's value, and no more are reported",
    )
    for (let i = 0; i < 10_002; i++) read(`x${i}`)
    expect(errors).toHaveLength(10_001)
  })
})

describe('reportedOnce', () => {
  function tracked(cap: number) {
    let overflows = 0
    const reported = reportedOnce(cap, () => {
      overflows += 1
    })
    return { reported, overflows: () => overflows }
  }

  it('says to report an id the first time only', () => {
    const { reported } = tracked(3)
    expect(reported.first('a')).toBe(true)
    expect(reported.first('a')).toBe(false)
    expect(reported.first('b')).toBe(true)
  })

  it('keeps exactly as many ids as the cap without overflowing', () => {
    const { reported, overflows } = tracked(2)
    expect([reported.first('a'), reported.first('b')]).toEqual([true, true])
    expect(overflows()).toBe(0)
  })

  it('overflows once past the cap, and keeps what it holds rather than evicting', () => {
    const { reported, overflows } = tracked(2)
    reported.first('a')
    reported.first('b')
    expect([reported.first('c'), reported.first('d'), reported.first('c')]).toEqual([
      false,
      false,
      false,
    ])
    expect(overflows()).toBe(1)
    expect([reported.first('a'), reported.first('b')]).toEqual([false, false])
  })

  it('takes new ids again once forgetting brings it below the cap, and overflows again when full', () => {
    const { reported, overflows } = tracked(2)
    reported.first('a')
    reported.first('b')
    reported.first('c')
    reported.forget('a')
    expect(reported.first('c')).toBe(true)
    expect(reported.first('d')).toBe(false)
    expect(overflows()).toBe(2)
  })

  it('stays silent after forgetting an id it never held while still at the cap', () => {
    const { reported, overflows } = tracked(1)
    reported.first('a')
    reported.first('b')
    reported.forget('z')
    expect(reported.first('c')).toBe(false)
    expect(overflows()).toBe(1)
  })

  it('keeps only the staged ids it holds, and takes new ids again below the cap', () => {
    const { reported, overflows } = tracked(2)
    reported.first('a')
    reported.first('b')
    reported.first('c')
    reported.keepOnly(new Set(['b', 'z']))
    expect(reported.size).toBe(1)
    expect([reported.first('b'), reported.first('a'), reported.first('d')]).toEqual([
      false,
      true,
      false,
    ])
    expect(overflows()).toBe(2)
  })

  it('stays silent after keeping every id it holds while at the cap', () => {
    const { reported, overflows } = tracked(1)
    reported.first('a')
    reported.first('b')
    reported.keepOnly(new Set(['a']))
    expect(reported.first('c')).toBe(false)
    expect(overflows()).toBe(1)
  })
})

describe('isShorterDimKey', () => {
  it('is false for the empty key of a metric with no dims', () => {
    expect(isShorterDimKey({}, '')).toBe(false)
  })

  it('is true for the empty key under two or more dims', () => {
    expect(isShorterDimKey({ a: str(), b: str() }, '')).toBe(true)
  })

  it('is true for the empty key under one dim that never encodes to empty', () => {
    expect(isShorterDimKey({ a: int() }, '')).toBe(true)
  })

  it('is false for the empty key under one dim that can encode to empty', () => {
    expect(isShorterDimKey({ a: str() }, '')).toBe(false)
    expect(isShorterDimKey({ a: oneOf(['', 'x']) }, '')).toBe(false)
  })

  it('is true for a key with fewer segments than dims', () => {
    expect(isShorterDimKey(dims, 'Willow|riverside')).toBe(true)
  })

  it('counts an escaped separator as part of a value', () => {
    // `a\|b` is one escaped value, so these keys hold three segments and two
    expect(isShorterDimKey(dims, 'a\\|b|riverside|solid')).toBe(false)
    expect(isShorterDimKey(dims, 'a\\|b|riverside')).toBe(true)
  })

  it('is false for a key with as many segments as dims, or more', () => {
    expect(isShorterDimKey(dims, 'Willow|riverside|solid')).toBe(false)
    expect(isShorterDimKey(dims, 'Willow|riverside|solid|extra')).toBe(false)
  })
})

describe('dimKeyDecoder', () => {
  /**
   * What one decode did: each key in order with its value, or the message it
   * threw. A Date becomes its time as text, because two Invalid Dates hold NaN
   * and would never compare equal as dates.
   */
  function outcome(decode: () => Record<string, unknown>): unknown {
    try {
      return Object.entries(decode()).map(([key, value]) => [
        key,
        value instanceof Date ? `date ${value.getTime()}` : value,
      ])
    } catch (err) {
      return { threw: (err as Error).message }
    }
  }

  it('returns and throws exactly what decodeDimKey does for every key', () => {
    // raw segments rather than encoded values, so the keys include ones no
    // encoder writes: a lone or trailing backslash, an escaped separator, an
    // absent marker, text an int or a bool cannot hold
    const fragments = ['', 'a', '\\', '\\|', '\\\\', DIM_ABSENT, '1', 'x1', 'true']
    const keys = new Set<string>()
    const grow = (prefix: string[]): void => {
      keys.add(prefix.join('|'))
      if (prefix.length === 4) return
      for (const fragment of fragments) grow([...prefix, fragment])
    }
    grow([])

    const declarations = [
      {},
      { only: str() },
      { only: int() },
      { only: oneOf(['', 1, 'a']) },
      { name: str(), count: int(), on: bool() },
      { name: str().optional(), at: ts(), kind: oneOf(['a', '1']), n: float() },
    ]

    const mismatches: unknown[] = []
    for (const declared of declarations) {
      const decode = dimKeyDecoder(declared)
      for (const key of keys) {
        const fast = outcome(() => decode(key))
        const full = outcome(() => decodeDimKey(declared, key))
        if (!isDeepStrictEqual(fast, full)) mismatches.push({ declared, key, fast, full })
      }
    }

    expect(keys.size).toBeGreaterThan(5_000)
    expect(mismatches).toEqual([])
  })

  it('reads a key written before a dim was added with that dim absent', () => {
    const decoded = dimKeyDecoder(dims)('Willow|riverside')
    expect(decoded).toEqual({ dogName: 'Willow', park: 'riverside' })
    expect('kind' in decoded).toBe(false)
  })

  it('reads the empty key as every dim absent when two or more are declared', () => {
    expect(dimKeyDecoder(dims)('')).toEqual({})
  })

  it('returns a new object on every call', () => {
    const decode = dimKeyDecoder(dims)
    const first = decode('Willow|riverside|solid')
    first.park = 'hilltop'
    expect(decode('Willow|riverside|solid')).toEqual({
      dogName: 'Willow',
      park: 'riverside',
      kind: 'solid',
    })
  })

  it('rejects a key with more segments than dims, with the message decodeDimKey gives', () => {
    expect(() => dimKeyDecoder(dims)('Willow|riverside|solid|extra')).toThrow(
      'decodeDimKey: expected at most 3 segments for [dogName, park, kind], got 4',
    )
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
    expect(() => validateDims(dims, { dogName: 'W', kind: 'solid' })).toThrow(
      'missing required dim "park"',
    )
  })

  it('rejects an unknown key, naming it', () => {
    expect(() =>
      validateDims(dims, { dogName: 'W', park: 'r', kind: 'solid', breed: 'corgi' }),
    ).toThrow('unknown dim "breed". The declared dims are [dogName, park, kind]')
  })

  it('rejects a bad oneOf member, naming the key', () => {
    expect(() => validateDims(dims, { dogName: 'W', park: 'r', kind: 'gas' })).toThrow(
      'kind: "gas" is not one of ["solid", "liquid"]',
    )
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

describe('dimKeyEncoder', () => {
  it('encodes a values object again after the caller changes it', () => {
    const encode = dimKeyEncoder(dims)
    const values: Record<string, unknown> = { dogName: 'Willow', park: 'riverside', kind: 'solid' }
    expect(encode(values)).toBe('Willow|riverside|solid')
    values.park = 'hilltop'
    values.kind = 'liquid'
    expect(encode(values)).toBe('Willow|hilltop|liquid')
  })

  it('reads a property the caller made non enumerable as absent', () => {
    const encode = dimKeyEncoder({ dogName: str(), park: str().optional() })
    const values = { dogName: 'Willow' }
    Object.defineProperty(values, 'park', { value: 'riverside', enumerable: false })
    expect(encode(values)).toBe(`Willow|${DIM_ABSENT}`)
  })

  it('treats null values as no dims', () => {
    expect(dimKeyEncoder({})(null as never)).toBe('')
    expect(() => dimKeyEncoder(dims)(null as never)).toThrow('missing required dim "dogName"')
  })

  it('reports an undeclared key before a missing dim', () => {
    expect(() => dimKeyEncoder(dims)({ breed: 'corgi' })).toThrow(
      'unknown dim "breed". The declared dims are [dogName, park, kind]',
    )
  })

  it('reports a wrong type in a later dim before an unstorable value in an earlier one', () => {
    const encode = dimKeyEncoder({ tenant: str(), count: int() })
    expect(() => encode({ tenant: 'a\uD83D', count: 'x' })).toThrow(
      'count: expected a safe integer, got "x"',
    )
    expect(() => encode({ tenant: 'a\uD83D', count: 1 })).toThrow(/surrogate/)
  })

  it('starts every message with the metric name when it is given one', () => {
    const encode = dimKeyEncoder({ tenant: str(), count: int() }, 'seats')
    expect(() => encode({ tenant: 'a' })).toThrow(new Error('seats: missing required dim "count"'))
    expect(() => encode({ tenant: 'a', count: 1, x: 1 })).toThrow(
      new Error('seats: unknown dim "x". The declared dims are [tenant, count]'),
    )
    expect(() => encode({ tenant: 'a', count: 'x' })).toThrow(
      new Error('seats: count: expected a safe integer, got "x"'),
    )
    expect(() => encode({ tenant: 'a\uD83D', count: 1 })).toThrow(/^seats: dim value "a/)
  })

  it('fills a default the caller left out', () => {
    const encode = dimKeyEncoder({ park: str().default('riverside'), kind: str() })
    expect(encode({ kind: 'solid' })).toBe('riverside|solid')
  })
})
