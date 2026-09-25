import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { float, int, json, oneOf, str } from '../schema/types.js'
import { type Counter, type CounterRow, counter } from './counter.js'
import type { WriteFn } from './types.js'

/** A sink that keeps nothing — for declaration tests that never ship. */
const discard: WriteFn = () => {}

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
    expectRejected(() => make({ resolution: '7s', flush: '1m' }))
  })

  it('rejects a json() dim — a payload cannot be a series key', () => {
    const err = expectRejected(() =>
      counter('dog_poops', {
        write: discard,
        dims: { payload: json() },
        resolution: '1s',
        flush: '5m',
      }),
    )
    expect(err.message).toMatch(/payload/)
  })

  it('rejects an empty name', () => {
    expectRejected(() =>
      counter('', { write: discard, dims: makeDims(), resolution: '1s', flush: '5m' }),
    )
    expectRejected(() =>
      counter('   ', { write: discard, dims: makeDims(), resolution: '1s', flush: '5m' }),
    )
  })

  it('rejects a malformed duration', () => {
    expectRejected(() => make({ resolution: '1.5s' }))
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
})

describe('inert until bound', () => {
  it('starts unbound', () => {
    expect(make().isBound).toBe(false)
  })

  it('throws on add rather than dropping the write', () => {
    const err = expectRejected(() => make().add(WILLOW))
    expect(err.message).toMatch(/dog_poops/)
    expect(err.message).toMatch(/bound|register|house/i)
  })

  it('throws on current', async () => {
    await expect(make().current(WILLOW)).rejects.toThrow(/bound|register|house/i)
  })

  it('is bound after bind', () => {
    expect(bound().isBound).toBe(true)
  })

  it('refuses a second binding — a metric belongs to one house', () => {
    const metric = bound()
    expectRejected(() => metric.bind({ driver: memory(), now }))
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
    clock += 517 // .999 — the last millisecond of the same second
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

describe('add — validation is synchronous', () => {
  it('rejects a missing required dim', () => {
    const metric = bound()
    // a programming error: it surfaces at the call site, not in onError
    expect(
      expectRejected(() => metric.add({ dogName: 'W', kind: 'solid' } as never)).message,
    ).toMatch(/park/)
  })

  it('rejects an unknown dim', () => {
    const metric = bound()
    expect(
      expectRejected(() => metric.add({ ...WILLOW, breed: 'corgi' } as never)).message,
    ).toMatch(/breed/)
  })

  it('rejects a value outside a oneOf set', () => {
    const metric = bound()
    expect(expectRejected(() => metric.add({ ...WILLOW, kind: 'gas' } as never)).message).toMatch(
      /kind/,
    )
  })

  it('rejects a fractional delta on an integer counter', () => {
    const metric = bound()
    expectRejected(() => metric.add(1.5, WILLOW))
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
    expectRejected(() => metric.add(Number.NaN, WILLOW))
    expectRejected(() => metric.add(Number.POSITIVE_INFINITY, WILLOW))
  })

  it('writes nothing when validation fails', async () => {
    const metric = bound()
    expectRejected(() => metric.add({ dogName: 'W' } as never))
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

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[1]).toEqual({ metric: 'dog_poops' })
  })

  it('does not reject drain — a failed write is reported, not thrown at the flusher', async () => {
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
})

describe('current() with no dims is the metric total', () => {
  it('sums every series — the counter tracks one thing', async () => {
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
})

/**
 * Type-level assertions — checked by `pnpm typecheck`, not by vitest. A green
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

// Never called — declared solely so `tsc` checks these call sites. A
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

    // another process has already claimed up to five seconds ahead
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
