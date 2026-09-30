import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { bool, type FieldType, float, int, json, oneOf, str, ts } from '../schema/types.js'
import { type Counter, type CounterLiveRow, type CounterRow, counter } from './counter.js'
import type { WriteFn } from './types.js'

/** A sink that keeps nothing, for declaration tests that never ship. */
const discard: WriteFn = () => {}

const makeDims = () => ({
  dogName: str(),
  park: str(),
  kind: oneOf(['solid', 'liquid']),
})
type Dims = ReturnType<typeof makeDims>

const WILLOW = { dogName: 'Willow', park: 'riverside', kind: 'solid' } as const

/** A controllable clock, so bucket boundaries are exact instead of racy. */
let clock: number
let driver: Driver
const now = () => clock

function make(overrides: Partial<Parameters<typeof counter<Dims>>[1]> = {}): Counter<Dims> {
  return counter('dog_poops', {
    dims: makeDims(),
    resolution: '1s',
    flush: '5m',
    ...overrides,
    write: overrides.write ?? discard,
  })
}

function bound(overrides = {}): Counter<Dims> {
  const metric = make(overrides)
  metric.bind({ driver, now })
  return metric
}

beforeEach(() => {
  clock = 1_788_616_987_482 // mid-bucket, on purpose
  driver = memory()
})

describe('declaration', () => {
  it('exposes what it was declared with', () => {
    const metric = make()
    expect(metric.name).toBe('dog_poops')
    expect(metric.kind).toBe('counter')
    expect(Object.keys(metric.dims)).toEqual(['dogName', 'park', 'kind'])
  })

  it('parses durations once, at declare time', () => {
    const metric = make({ resolution: '10s', flush: '1m', grace: '5s' })
    expect(metric.resolutionMs).toBe(10_000)
    expect(metric.flushMs).toBe(60_000)
    expect(metric.graceMs).toBe(5000)
  })

  it('defaults grace to 2s', () => {
    expect(make().graceMs).toBe(2000)
  })

  it('defaults to an integer counter', () => {
    expect(make().isFloat).toBe(false)
    expect(make({ value: float() }).isFloat).toBe(true)
    expect(make({ value: int() }).isFloat).toBe(false)
  })

  it('rejects a resolution that does not divide the flush interval', () => {
    // a shipment would split a bucket in half
    expect(() => make({ resolution: '7s', flush: '1m' })).toThrow(
      'dog_poops: resolution 7s does not divide flush 1m evenly, and a shipment would ' +
        'split a bucket',
    )
  })

  it('rejects a json() dim, since a payload cannot be a series key', () => {
    expect(() =>
      counter('dog_poops', {
        write: discard,
        dims: { payload: json() },
        resolution: '1s',
        flush: '5m',
      }),
    ).toThrow(
      'dog_poops: dim "payload" declares json(), which cannot be encoded into a series key. ' +
        'Put it on an event instead',
    )
  })

  it('rejects an empty name', () => {
    expect(() =>
      counter('', { write: discard, dims: makeDims(), resolution: '1s', flush: '5m' }),
    ).toThrow('counter: name must be a non-empty string')
    expect(() =>
      counter('   ', { write: discard, dims: makeDims(), resolution: '1s', flush: '5m' }),
    ).toThrow('counter: name must be a non-empty string')
  })

  it('rejects a malformed duration', () => {
    expect(() => make({ resolution: '1.5s' })).toThrow('parseDuration: "1.5s"')
  })

  it('accepts a metric with no dims', () => {
    const metric = counter('boots', { write: discard, dims: {}, resolution: '1s', flush: '1s' })
    expect(metric.name).toBe('boots')
  })
})

describe('dimensionless counters', () => {
  const online = () => counter('online_users', { write: discard, resolution: '1s', flush: '5m' })

  it('needs no dims at all', () => {
    const metric = online()
    expect(metric.dims).toEqual({})
    expect(metric.rowShape().columns.map((c) => c.name)).toEqual(['id', 'bucket_ts', 'value'])
  })

  it('increments with no arguments', async () => {
    const metric = online()
    metric.bind({ driver, now })
    metric.add()
    metric.add()
    await metric.drain()
    expect(await metric.current()).toBe(2)
  })

  it('takes a bare delta without a dims object', async () => {
    // the numeric overload is declared first, so 5 is a delta and not dims
    const metric = online()
    metric.bind({ driver, now })
    metric.add(5)
    await metric.drain()
    expect(await metric.current()).toBe(5)
  })

  it('is one series no matter how many times it is written', async () => {
    const metric = online()
    metric.bind({ driver, now })
    for (let i = 0; i < 1000; i++) metric.add()
    await metric.drain()
    expect(await driver.readBuckets({ metric: 'online_users' })).toHaveLength(1)
  })

  it('still accepts an explicit empty object', async () => {
    const metric = online()
    metric.bind({ driver, now })
    metric.add({})
    metric.add(2, {})
    await metric.drain()
    expect(await metric.current({})).toBe(3)
  })

  it('refuses a first argument that is neither a delta nor dims', async () => {
    // TypeScript accepts these on a metric with no dims, where the first
    // position also takes a dims object
    const metric = online()
    metric.bind({ driver, now })
    expect(() => metric.add(5n as unknown as number)).toThrow(
      new Error(
        'online_users: the first argument must be a number or a dims object, got bigint. Convert a bigint with Number() first',
      ),
    )
    expect(() => metric.add(true as unknown as number)).toThrow(
      new Error('online_users: the first argument must be a number or a dims object, got boolean'),
    )
    await metric.drain()
    expect(await metric.current()).toBe(0)
  })

  it('refuses an object that is not a plain dims object', async () => {
    // each is an object, and TypeScript accepts all three on a metric with no dims
    const metric = online()
    metric.bind({ driver, now })
    const refusal = (value: unknown) => () => metric.add(value as Record<never, never>)
    expect(refusal(new Date())).toThrow(
      new Error(
        'online_users: the first argument must be a number or a plain dims object, got a Date',
      ),
    )
    expect(refusal([])).toThrow(
      new Error(
        'online_users: the first argument must be a number or a plain dims object, got an array',
      ),
    )
    expect(refusal(new Number(5))).toThrow(
      new Error(
        'online_users: the first argument must be a number or a plain dims object, got a Number',
      ),
    )
    metric.add(Object.create(null))
    await metric.drain()
    expect(await metric.current()).toBe(1)
  })
})

describe('inert until bound', () => {
  it('starts unbound', () => {
    expect(make().isBound).toBe(false)
  })

  it('throws on add rather than dropping the write', () => {
    expect(() => make().add(WILLOW)).toThrow(
      'dog_poops: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
  })

  it('throws on current', async () => {
    await expect(make().current(WILLOW)).rejects.toThrow(/bound|register|house/i)
  })

  it('is bound after bind', () => {
    expect(bound().isBound).toBe(true)
  })

  it('refuses a second binding, since a metric belongs to one house', () => {
    const metric = bound()
    expect(() => metric.bind({ driver: memory(), now })).toThrow(
      new Error('dog_poops: already bound to a house, and a metric belongs to exactly one'),
    )
  })

  it('stays unbound when a binding with no cadence is refused', () => {
    const metric = counter('odd', { resolution: '1s', write: discard })
    expect(() => metric.bind({ driver, now })).toThrow(
      new Error(
        'odd: no flush cadence. Declare flush on the counter, or defaults.flush on the house',
      ),
    )
    expect(metric.isBound).toBe(false)
    metric.bind({ driver, now, defaults: { flushMs: 60_000 } })
    expect(metric.isBound).toBe(true)
  })

  it('stays unbound when the house cadence does not divide its resolution', () => {
    const metric = counter('odd', { resolution: '7s', write: discard })
    expect(() => metric.bind({ driver, now, defaults: { flushMs: 60_000 } })).toThrow(
      /does not divide/,
    )
    expect(metric.isBound).toBe(false)
  })
})

describe('add', () => {
  it('increments by 1 by default', async () => {
    const metric = bound()
    metric.add(WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(1)
  })

  it('increments by an explicit delta', async () => {
    const metric = bound()
    metric.add(3, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(3)
  })

  it('accumulates within one bucket', async () => {
    const metric = bound()
    metric.add(WILLOW)
    metric.add(WILLOW)
    metric.add(5, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(7)
  })

  it('counts into two series when one dims object is changed and reused between writes', async () => {
    const metric = bound()
    const values: { dogName: string; park: string; kind: 'solid' | 'liquid' } = { ...WILLOW }
    metric.add(values)
    values.park = 'hilltop'
    metric.add(2, values)
    await metric.drain()
    const cells = await driver.readBuckets({ metric: 'dog_poops' })
    expect(cells.map((cell) => [cell.dimKey, cell.value])).toEqual([
      ['Willow|hilltop|solid', 2],
      ['Willow|riverside|solid', 1],
    ])
  })

  it('accepts a negative delta', async () => {
    const metric = bound()
    metric.add(5, WILLOW)
    metric.add(-2, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(3)
  })

  it('separates series by dim values', async () => {
    const metric = bound()
    metric.add(WILLOW)
    metric.add(2, { dogName: 'Rex', park: 'central', kind: 'liquid' })
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(1)
  })

  it('starts a new bucket when the clock crosses a boundary', async () => {
    const metric = bound()
    metric.add(WILLOW)
    await metric.drain()

    clock += 1000 // next 1s bucket
    expect(await metric.current(WILLOW)).toBe(0)

    metric.add(4, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(4)

    // the earlier bucket is still held, unflushed
    const rows = await driver.readBuckets({ metric: 'dog_poops' })
    expect(rows.map((r) => r.value)).toEqual([1, 4])
  })

  it('keeps writes inside one bucket regardless of where in it they land', async () => {
    const metric = bound()
    metric.add(WILLOW) // at .482
    clock += 517 // .999, the last millisecond of the same second
    metric.add(WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(2)
  })

  it('applies dim defaults', async () => {
    const metric = counter('d', {
      write: discard,
      dims: { a: str(), b: str().default('riverside') },
      resolution: '1s',
      flush: '5m',
    })
    metric.bind({ driver, now })
    metric.add({ a: 'x' })
    await metric.drain()
    expect(await metric.current({ a: 'x', b: 'riverside' })).toBe(1)
  })
})

describe('add validates synchronously', () => {
  it('rejects a missing required dim', () => {
    const metric = bound()
    // a programming error: it surfaces at the call site, not in onError
    expect(() => metric.add({ dogName: 'W', kind: 'solid' } as never)).toThrow(
      new Error('dog_poops: missing required dim "park"'),
    )
  })

  it('rejects an unknown dim', () => {
    const metric = bound()
    expect(() => metric.add({ ...WILLOW, breed: 'corgi' } as never)).toThrow(
      new Error('dog_poops: unknown dim "breed". The declared dims are [dogName, park, kind]'),
    )
  })

  it('rejects a value outside a oneOf set', () => {
    const metric = bound()
    expect(() => metric.add({ ...WILLOW, kind: 'gas' } as never)).toThrow(
      'kind: "gas" is not one of ["solid", "liquid"]',
    )
  })

  it('rejects a fractional delta on an integer counter', () => {
    const metric = bound()
    expect(() => metric.add(1.5, WILLOW)).toThrow(
      new Error(
        'dog_poops: declares an integer counter, so 1.5 is not a legal delta. Declare `value: float()` if fractions are intended',
      ),
    )
  })

  it('says a whole delta past the safe range is too large, not a fraction', () => {
    const metric = bound()
    expect(() => metric.add(2 ** 53, WILLOW)).toThrow(
      new Error(
        'dog_poops: 9007199254740992 is past 9007199254740991, the largest whole number a double holds exactly, so an integer counter cannot take it',
      ),
    )
  })

  it('refuses an integer total that would pass the largest safe integer', async () => {
    const errors: unknown[] = []
    const metric = make()
    metric.bind({ driver, now, onError: (error) => errors.push(error) })
    metric.add(Number.MAX_SAFE_INTEGER, WILLOW)
    metric.add(2, WILLOW)
    await metric.drain()

    expect(errors.map((error) => (error as Error).message)).toEqual([
      'memory driver: dog_poops total would be 9007199254740992, which is past ' +
        '9007199254740991, the largest whole number a double holds exactly, so the write ' +
        'was refused',
    ])
    expect(await metric.current(WILLOW)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('accepts a fractional delta when the counter declares float', async () => {
    const metric = make({ value: float() })
    metric.bind({ driver, now })
    metric.add(0.5, WILLOW)
    metric.add(0.25, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBeCloseTo(0.75)
  })

  it('rejects a non-finite delta', () => {
    const metric = make({ value: float() })
    metric.bind({ driver, now })
    expect(() => metric.add(Number.NaN, WILLOW)).toThrow(
      'dog_poops: delta must be a finite number, got NaN',
    )
    expect(() => metric.add(Number.POSITIVE_INFINITY, WILLOW)).toThrow(
      'dog_poops: delta must be a finite number, got Infinity',
    )
  })

  it('writes nothing when validation fails', async () => {
    const metric = bound()
    expect(() => metric.add({ dogName: 'W' } as never)).toThrow(
      new Error('dog_poops: missing required dim "park"'),
    )
    await metric.drain()
    expect(await driver.readBuckets({ metric: 'dog_poops' })).toEqual([])
  })
})

describe('transport failures', () => {
  const failing = (): Driver => ({
    ...memory(),
    increment: () => Promise.reject(new Error('redis is down')),
  })

  it('routes a driver rejection to onError instead of throwing from add', async () => {
    const onError = vi.fn()
    const metric = make()
    metric.bind({ driver: failing(), now, onError })

    expect(() => metric.add(WILLOW)).not.toThrow()
    await metric.drain()

    expect(onError.mock.calls).toEqual([[new Error('redis is down'), { metric: 'dog_poops' }]])
  })

  it('does not reject drain, since a failed write is reported, not thrown at the flusher', async () => {
    const metric = make()
    metric.bind({ driver: failing(), now, onError: () => {} })
    metric.add(WILLOW)
    await expect(metric.drain()).resolves.toBeUndefined()
  })
})

describe('drain', () => {
  it('resolves immediately when nothing is pending', async () => {
    await expect(bound().drain()).resolves.toBeUndefined()
  })

  it('waits for every write issued before it', async () => {
    const metric = bound()
    for (let i = 0; i < 50; i++) metric.add(WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(50)
  })

  it('is safe to call repeatedly', async () => {
    const metric = bound()
    metric.add(WILLOW)
    await metric.drain()
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(1)
  })
})

describe('current', () => {
  it('is 0 for a series that has never been written', async () => {
    expect(await bound().current(WILLOW)).toBe(0)
  })

  it('reads only the open bucket, not the whole unflushed window', async () => {
    const metric = bound()
    metric.add(3, WILLOW)
    await metric.drain()
    clock += 1000
    metric.add(1, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(1)
  })

  it('validates its dims like add does', async () => {
    await expect(bound().current({ dogName: 'W' } as never)).rejects.toThrow(/park/)
  })

  it('reads the window a write lands in when the clock is behind the watermark', async () => {
    const metric = bound()
    metric.add(1, WILLOW)
    await metric.drain()
    clock += 3000
    await metric.flush({ force: true })

    // an NTP correction steps the clock back, so this add moves forward
    clock -= 4000
    metric.add(5, WILLOW)
    await metric.drain()
    expect(await metric.current(WILLOW)).toBe(5)
    expect(await metric.current()).toBe(5)
  })
})

describe('a change of resolution', () => {
  /** On a five minute boundary, and five seconds past a seven second one. */
  const base = 1_788_616_800_000
  const minute = 60_000

  /**
   * A one minute counter that shipped the window at `base + 7m` and has one
   * write in the open window at `base + 8m`, then the same counter redeclared
   * at `resolution`, bound to the same storage.
   */
  async function redeclared(resolution: string) {
    const shared = memory()
    let at = base + 7 * minute + 10_000
    const before = counter('orders', { resolution: '1m', flush: '1m', write: discard })
    before.bind({ driver: shared, now: () => at })
    before.add()
    at = base + 8 * minute + 1000
    before.add()
    await before.drain()
    at = base + 8 * minute + 3000
    await before.flush()

    const shipped: [number, number][] = []
    const after = counter('orders', {
      resolution,
      flush: resolution,
      write: (rows) => {
        for (const row of rows) shipped.push([row.bucket_ts.getTime() - base, row.value])
      },
    })
    after.bind({ driver: shared, now: () => at })
    return {
      after,
      shipped,
      at: (ms: number) => {
        at = ms
      },
    }
  }

  it('lands a late write on the first window of a coarser grid past the watermark', async () => {
    const { after, shipped, at } = await redeclared('5m')
    at(base + 8 * minute + 10_000)
    after.add(2)
    await after.drain()

    at(base + 15 * minute + 3000)
    await after.flush()
    expect(shipped).toEqual([
      [8 * minute, 1],
      [10 * minute, 2],
    ])
  })

  it('lands a late write on the first window of a finer grid past the watermark', async () => {
    const { after, shipped, at } = await redeclared('7s')
    at(base + 8 * minute + 2000)
    after.add(2)
    await after.drain()

    at(base + 9 * minute)
    await after.flush()
    // the seven second grid has a boundary 485 seconds past `base`
    expect(shipped).toEqual([
      [8 * minute, 1],
      [485_000, 2],
    ])
  })
})

describe('current() with no dims is the metric total', () => {
  it('refuses a total across series a double cannot hold exactly', async () => {
    const metric = bound()
    metric.add(Number.MAX_SAFE_INTEGER, WILLOW)
    metric.add(2, { ...WILLOW, park: 'central' })
    await metric.drain()

    await expect(metric.current()).rejects.toThrow(
      'dog_poops: the total across series would be 9007199254740993, which is past ' +
        '9007199254740991, the largest whole number a double holds exactly',
    )
    await expect(metric.snapshot({ complete: false, groupBy: [] })).rejects.toThrow(
      /^dog_poops: a merged value would be 9007199254740993/,
    )
  })

  it('judges a total by its exact sum, not by where the running sum rounded', async () => {
    const metric = bound()
    metric.add(Number.MAX_SAFE_INTEGER, { ...WILLOW, park: 'a' })
    metric.add(2, { ...WILLOW, park: 'b' })
    metric.add(-Number.MAX_SAFE_INTEGER, { ...WILLOW, park: 'c' })
    await metric.drain()

    // as doubles the running sum reaches 2 ** 53 and comes back as 1
    expect(await metric.current()).toBe(2)
    const [merged] = await metric.snapshot({ complete: false, groupBy: [] })
    expect(merged?.value).toBe(2)

    // the same across buckets of one series, which a rollup adds
    const series = { ...WILLOW, park: 'd' }
    metric.add(Number.MAX_SAFE_INTEGER, series)
    clock += 1000
    metric.add(2, series)
    clock += 1000
    metric.add(-Number.MAX_SAFE_INTEGER, series)
    await metric.drain()
    const [rolled] = await metric.snapshot({ complete: false, rollup: 'sum', dims: series })
    expect(rolled?.value).toBe(2)
  })

  it('names a stored fraction, not an overflow, when an integer counter reads one', async () => {
    await driver.increment([
      {
        metric: 'dog_poops',
        bucketTs: 1_788_616_987_000,
        resolutionMs: 1000,
        dimKey: 'Willow|a|solid',
        delta: 2.5,
      },
      {
        metric: 'dog_poops',
        bucketTs: 1_788_616_987_000,
        resolutionMs: 1000,
        dimKey: 'Willow|b|solid',
        delta: 1,
      },
    ])
    const metric = bound()
    await expect(metric.current()).rejects.toThrow(
      'dog_poops: the total across series would be 3.5, which is not a whole number. A stored ' +
        'value is a fraction, which happens when a float counter is declared as an integer one',
    )
  })

  it('adds series past the safe range when the counter declares float', async () => {
    const metric = make({ value: float() })
    metric.bind({ driver, now })
    metric.add(Number.MAX_SAFE_INTEGER, WILLOW)
    metric.add(2, { ...WILLOW, park: 'central' })
    await metric.drain()
    expect(await metric.current()).toBe(2 ** 53)
  })
  it('sums every series, since the counter tracks one thing', async () => {
    const metric = bound()
    metric.add(WILLOW)
    metric.add(WILLOW)
    metric.add(3, { dogName: 'Rex', park: 'central', kind: 'liquid' })
    await metric.drain()

    expect(await metric.current(WILLOW)).toBe(2)
    expect(await metric.current()).toBe(5)
  })

  it('rises on every add regardless of which dims came with it', async () => {
    const metric = bound()
    for (const dogName of ['a', 'b', 'c', 'd']) {
      metric.add({ dogName, park: 'riverside', kind: 'solid' })
    }
    await metric.drain()
    expect(await metric.current()).toBe(4)
  })

  it('is 0 before anything is recorded', async () => {
    expect(await bound().current()).toBe(0)
  })

  it('covers only the open bucket', async () => {
    const metric = bound()
    metric.add(2, WILLOW)
    await metric.drain()
    clock += 1000
    metric.add(5, WILLOW)
    await metric.drain()
    expect(await metric.current()).toBe(5)
  })

  it('matches the single series when the counter has no dims', async () => {
    const metric = counter('online', { write: discard, resolution: '1s', flush: '5m' })
    metric.bind({ driver, now })
    metric.add(3)
    await metric.drain()
    expect(await metric.current()).toBe(3)
    expect(await metric.current({})).toBe(3)
  })

  it('totals an integer counter in storage without reading its series', async () => {
    // a driver whose cell read fails, so only a total added up in storage
    // can answer
    const base = memory()
    driver = {
      ...base,
      readBuckets: async (query) => {
        if (query.dimKey === undefined) throw new Error('read every series')
        return base.readBuckets(query)
      },
    }
    const metric = bound()
    metric.add(2, WILLOW)
    metric.add(3, { ...WILLOW, park: 'central' })
    await metric.drain()
    expect(await metric.current()).toBe(5)
  })

  it('answers every total the same through a driver without sumBuckets', async () => {
    const MAX = Number.MAX_SAFE_INTEGER
    const cases: { fractional: boolean; deltas: number[] }[] = [
      { fractional: false, deltas: [2, 3, -1] },
      { fractional: false, deltas: [MAX, 2] },
      // the true total is 2, and rounding in the order the series are read
      // gives 1. Both drivers have to give the exact one
      { fractional: false, deltas: [MAX, 2, -MAX] },
      { fractional: true, deltas: [0.1, 0.2, 0.3] },
      { fractional: true, deltas: [MAX, 2] },
    ]
    const answer = async (plain: boolean, fractional: boolean, deltas: number[]) => {
      const { sumBuckets: _, ...required } = memory()
      driver = plain ? required : memory()
      const metric = make(fractional ? { value: float() } : {})
      metric.bind({ driver, now })
      deltas.forEach((delta, i) => {
        metric.add(delta, { ...WILLOW, dogName: `dog${i}` })
      })
      await metric.drain()
      return metric.current().then(
        (total) => ({ total }),
        (error: Error) => ({ error: error.message }),
      )
    }
    for (const { fractional, deltas } of cases) {
      expect(await answer(false, fractional, deltas)).toEqual(
        await answer(true, fractional, deltas),
      )
    }
    expect(await answer(false, false, [MAX, 2, -MAX])).toEqual({ total: 2 })
  })
})

describe('rowShape', () => {
  it('is id, bucket_ts, dims in declaration order, then value', () => {
    expect(
      make()
        .rowShape()
        .columns.map((c) => c.name),
    ).toEqual(['id', 'bucket_ts', 'dogName', 'park', 'kind', 'value'])
  })

  it('reports the declared kind of each column', () => {
    const columns = make().rowShape().columns
    expect(columns.map((c) => c.kind)).toEqual(['str', 'ts', 'str', 'str', 'oneOf', 'int'])
  })

  it('reports float when the counter declares it', () => {
    const columns = make({ value: float() }).rowShape().columns
    expect(columns.at(-1)).toEqual({ name: 'value', kind: 'float', optional: false })
  })

  it('marks optional dims optional', () => {
    const metric = counter('d', {
      write: discard,
      dims: { a: str(), b: str().optional() },
      resolution: '1s',
      flush: '5m',
    })
    expect(metric.rowShape().columns.map((c) => c.optional)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ])
  })

  it('marks a dim with a default as a column every row carries', () => {
    const metric = counter('d', {
      write: discard,
      dims: { referrer: str().default('direct') },
      resolution: '1s',
      flush: '5m',
    })
    expect(metric.rowShape().columns[2]).toEqual({
      name: 'referrer',
      kind: 'str',
      optional: false,
    })
  })
})

/**
 * Type-level assertions, checked by `pnpm typecheck`, not by vitest. A green
 * test run does not mean these hold.
 */
type Equal<X, Y> =
  (<G>() => G extends X ? 1 : 2) extends <G>() => G extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

type _RowIsFlat = Expect<
  Equal<
    CounterRow<Dims>,
    {
      id: string
      bucket_ts: Date
      dogName: string
      park: string
      kind: 'solid' | 'liquid'
      value: number
    }
  >
>

// Never called. Declared solely so `tsc` checks these call sites. A
// `declare const` at module scope has no runtime binding, so this has to live
// inside a function body or it executes on import.
function _callSiteTypes(metric: Counter<Dims>): void {
  // the whole point of InferShape: a typo in a closed set is a compile error
  // @ts-expect-error 'sold' is not a declared member of kind
  metric.add({ dogName: 'Willow', park: 'riverside', kind: 'sold' })

  // @ts-expect-error park is required
  metric.add({ dogName: 'Willow', kind: 'solid' })

  // @ts-expect-error breed was never declared
  metric.add({ dogName: 'W', park: 'r', kind: 'solid', breed: 'corgi' })

  metric.add({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
  metric.add(3, { dogName: 'Willow', park: 'riverside', kind: 'liquid' })

  // @ts-expect-error dims are required when the metric declares any
  metric.add()

  // @ts-expect-error same, with an explicit delta
  metric.add(3)
}

/** A dimensionless counter must accept every one of these. */
function _dimlessCallSiteTypes(metric: Counter<Record<never, never>>): void {
  metric.add()
  metric.add(5)
  metric.add({})
  metric.add(5, {})
  void metric.current()
}
void _dimlessCallSiteTypes
void _callSiteTypes

describe('declaration checks every kind shares', () => {
  it('refuses a name with a colon or whitespace in it', () => {
    const write: WriteFn = () => {}
    expect(() => counter('e:checkout', { resolution: '1s', flush: '1m', write })).toThrow(
      /may not contain a colon or whitespace/,
    )
    expect(() => counter('http requests', { resolution: '1s', flush: '1m', write })).toThrow(
      /may not contain a colon or whitespace/,
    )
    expect(() =>
      counter('http.requests-v2', { resolution: '1s', flush: '1m', write }),
    ).not.toThrow()
  })

  it('refuses a metric declared without a sink', () => {
    expect(() =>
      counter('sold', { resolution: '1s', flush: '1m' } as unknown as Parameters<
        typeof counter
      >[1]),
    ).toThrow(/write must be a function/)
  })

  it('refuses a name no report could be keyed by', () => {
    const write: WriteFn = () => {}
    expect(() => counter('__proto__', { resolution: '1s', flush: '1m', write })).toThrow(
      'counter: a metric cannot be named "__proto__", because reports are keyed by metric ' +
        "name and JavaScript treats that key as an object's prototype",
    )
  })

  it('refuses a name holding half of a surrogate pair', () => {
    const write: WriteFn = () => {}
    expect(() => counter('a\uD800', { resolution: '1s', flush: '1m', write })).toThrow(
      /half of a surrogate pair/,
    )
    expect(() => counter('a\uD83D\uDE00', { resolution: '1s', flush: '1m', write })).not.toThrow()
  })

  it.each(['id', 'bucket_ts', 'value'])('refuses a dim named %s, a column it writes', (dim) => {
    const write: WriteFn = () => {}
    expect(() =>
      counter('by_col', { dims: { [dim]: str() }, resolution: '1s', flush: '1m', write }),
    ).toThrow(
      `by_col: dim "${dim}" is a reserved column. MetricHouse writes [id, bucket_ts, value] ` +
        'on every row',
    )
  })

  it.each(['bucket_open', 'bucket_elapsed_ms'])(
    'refuses a dim named %s, a live read column',
    (dim) => {
      const write: WriteFn = () => {}
      expect(() =>
        counter('doors', { dims: { [dim]: str() }, resolution: '1s', flush: '1m', write }),
      ).toThrow(
        `doors: a dim cannot be named "${dim}", because every row snapshot() returns carries a ` +
          'column of that name',
      )
    },
  )

  it('refuses a flush cadence a timer cannot wait for', () => {
    const write: WriteFn = () => {}
    expect(() => counter('c', { resolution: '1d', flush: '25d', write })).toThrow(
      /^c: flush is 25d, longer than 2147483647ms/,
    )
  })
})

describe('immediate delivery', () => {
  it('sends a write that was moved forward, from the window it landed in', async () => {
    const sent: number[][] = []
    const hits = counter('hits', {
      resolution: '1s',
      flush: '1m',
      write: (rows) => {
        sent.push(rows.map((row) => (row.bucket_ts as Date).getTime()))
      },
    })
    const driver = memory()
    const at = 1_788_616_980_000
    hits.bind({ driver, now: () => at, delivery: 'immediate' })

    // another process, its clock five seconds ahead, has written its window
    // and claimed up to it
    await driver.increment([
      { metric: 'hits', bucketTs: at + 5_000, resolutionMs: 1000, dimKey: '', delta: 1 },
    ])
    await driver.ack(await driver.claim('hits', at + 5_000))
    hits.add()
    await hits.drain()

    expect(sent).toEqual([[at + 5_000]])
  })

  it('counts failed immediate sends in attempt, as flushes do', async () => {
    const attempts: number[] = []
    let fail = true
    const hits = counter('hits', {
      resolution: '1s',
      flush: '1m',
      write: (_rows, context) => {
        attempts.push(context.attempt)
        if (fail) throw new Error('down')
      },
    })
    const at = 1_788_616_980_000
    hits.bind({ driver: memory(), now: () => at, delivery: 'immediate', onError: () => {} })

    hits.add()
    await hits.drain()
    hits.add()
    await hits.drain()
    fail = false
    hits.add()
    await hits.drain()
    hits.add()
    await hits.drain()
    expect(attempts).toEqual([1, 2, 3, 1])
  })
})

describe('a dim added at the end', () => {
  it('ships a series stored before the change with the new dim absent', async () => {
    const shared = memory()
    const at = 1_788_616_980_000
    const before = counter('orders', {
      dims: { route: str() },
      resolution: '1s',
      flush: '1m',
      write: discard,
    })
    before.bind({ driver: shared, now: () => at })
    before.add({ route: '/a' })
    await before.drain()

    const shipped: Record<string, unknown>[] = []
    const after = counter('orders', {
      dims: { route: str(), status: str().optional() },
      resolution: '1s',
      flush: '1m',
      write: (rows) => {
        shipped.push(...rows)
      },
    })
    after.bind({ driver: shared, now: () => at + 10_000 })

    // a dims filter reads the old key back before it builds the row
    const filtered = await after.snapshot({ dims: { route: '/a' } })
    expect(filtered.map(({ route, value }) => ({ route, value }))).toEqual([
      { route: '/a', value: 1 },
    ])
    expect('status' in (filtered[0] as object)).toBe(false)

    const report = await after.flush()
    expect(report.error).toBeUndefined()
    expect(shipped).toEqual([
      { id: rowId('orders', at, '/a'), bucket_ts: new Date(at), route: '/a', value: 1 },
    ])
  })
})

describe('dims added to a counter that had none', () => {
  const at = 1_788_616_980_000

  /** A series written with no dims, then read and shipped under `dims`. */
  async function after<D extends Record<string, FieldType>>(dims: D) {
    const shared = memory()
    const before = counter('orders', { resolution: '1s', flush: '1m', write: discard })
    before.bind({ driver: shared, now: () => at })
    before.add()
    await before.drain()

    const shipped: Record<string, unknown>[] = []
    const metric = counter('orders', {
      dims,
      resolution: '1s',
      flush: '1m',
      write: (rows) => {
        shipped.push(...rows)
      },
    })
    metric.bind({ driver: shared, now: () => at + 10_000 })
    const live = (await metric.snapshot()).map(({ bucket_open, bucket_elapsed_ms, ...row }) => row)
    expect((await metric.flush()).error).toBeUndefined()
    return { live, shipped }
  }

  const bare = { id: rowId('orders', at, ''), bucket_ts: new Date(at), value: 1 }

  it('leaves an int dim off the row rather than reading it as 0', async () => {
    const { live, shipped } = await after({ shard: int().optional() })
    expect(live).toEqual([bare])
    expect(shipped).toEqual([bare])
  })

  it('leaves a bool dim off the row rather than reading it as false', async () => {
    const { live, shipped } = await after({ canary: bool().optional() })
    expect(live).toEqual([bare])
    expect(shipped).toEqual([bare])
  })

  it('leaves a ts dim off the row rather than reading it as the epoch', async () => {
    const { live, shipped } = await after({ since: ts().optional() })
    expect(live).toEqual([bare])
    expect(shipped).toEqual([bare])
  })

  it('leaves every dim off the row when two are added', async () => {
    const { live, shipped } = await after({ route: str().optional(), shard: int().optional() })
    expect(live).toEqual([bare])
    expect(shipped).toEqual([bare])
  })

  it('reads a single str dim as the empty string, which the key cannot tell apart', async () => {
    const { live, shipped } = await after({ route: str().optional() })
    expect(live).toEqual([{ ...bare, route: '' }])
    expect(shipped).toEqual([{ ...bare, route: '' }])
  })
})

describe('row types', () => {
  it('make a defaulted dim required on a sink row and a live row, optional on a call', () => {
    const dims = { route: str().default('unknown'), user: str().optional() }
    type Row = CounterRow<typeof dims>
    expectTypeOf<Row['route']>().toEqualTypeOf<string>()
    expectTypeOf<Row['user']>().toEqualTypeOf<string | undefined>()
    const metric = counter('hits', { dims, resolution: '1s', flush: '5m', write: discard })
    expectTypeOf<Parameters<typeof metric.current>[0]>().toEqualTypeOf<
      { route?: string; user?: string } | undefined
    >()
    expectTypeOf<CounterLiveRow<typeof dims>['route']>().toEqualTypeOf<string>()
  })
})
