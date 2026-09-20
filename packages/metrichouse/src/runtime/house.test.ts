import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { counter } from '../metrics/counter.js'
import type { Row, WriteFn } from '../metrics/types.js'
import { oneOf, str } from '../schema/types.js'
import { createHouse } from './house.js'

/** A sink that keeps nothing — for declaration tests that never ship. */
const discard: WriteFn = () => {}

const WILLOW = { dogName: 'Willow', park: 'riverside', kind: 'solid' } as const
const REX = { dogName: 'Rex', park: 'central', kind: 'liquid' } as const

let clock: number
let driver: Driver
const now = () => clock

const makeCounter = (name = 'dog_poops', overrides = {}) =>
  counter(name, {
    write: discard,
    dims: { dogName: str(), park: str(), kind: oneOf(['solid', 'liquid']) },
    resolution: '1s',
    flush: '5m',
    ...overrides,
  })

beforeEach(() => {
  clock = 1_788_616_987_000 // exactly on a 1s boundary
  driver = memory()
})

describe('createHouse', () => {
  it('registers metrics from an array', () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops] })
    expect(house.metrics().map((m) => m.name)).toEqual(['dog_poops'])
    expect(house.get('dog_poops')).toBe(dogPoops)
  })

  it('registers metrics from an imported schema module, ignoring other exports', () => {
    const schema = { dogPoops: makeCounter(), SOME_CONSTANT: 42, helper: () => {} }
    const house = createHouse({ driver, schema })
    expect(house.metrics().map((m) => m.name)).toEqual(['dog_poops'])
  })

  it('binds what it registers', () => {
    const dogPoops = makeCounter()
    expect(dogPoops.isBound).toBe(false)
    createHouse({ driver, schema: [dogPoops] })
    expect(dogPoops.isBound).toBe(true)
  })

  it('opens no connections of its own — safe at module scope', () => {
    const spy: Driver = {
      capabilities: { durable: true, shared: true, atomicMerge: true },
      increment: vi.fn(),
      observe: vi.fn(),
      setLevel: vi.fn(),
      readLevels: vi.fn(),
      dropLevels: vi.fn(),
      append: vi.fn(),
      readBuckets: vi.fn(),
      readPending: vi.fn(),
      countPending: vi.fn(),
      claim: vi.fn(),
      claimRecords: vi.fn(),
      ack: vi.fn(),
      release: vi.fn(),
      recover: vi.fn(),
    }
    createHouse({ driver: spy, schema: [makeCounter()] })
    for (const method of [
      spy.increment,
      spy.observe,
      spy.append,
      spy.readBuckets,
      spy.readPending,
      spy.countPending,
      spy.claim,
      spy.claimRecords,
      spy.ack,
      spy.release,
      spy.recover,
    ]) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  it('refuses to bind a metric that already belongs to another house', () => {
    const dogPoops = makeCounter()
    createHouse({ driver, schema: [dogPoops] })
    expect(() => createHouse({ driver: memory(), schema: [dogPoops] })).toThrow(/already bound/)
  })

  it('refuses two metrics with the same name', () => {
    expect(() => createHouse({ driver, schema: [makeCounter(), makeCounter()] })).toThrow(
      /both named/,
    )
  })

  it('warns once when the driver cannot honour at-least-once', () => {
    const onWarn = vi.fn()
    createHouse({ driver: memory(), schema: [makeCounter()], onWarn })
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/best-effort/)
  })

  it('does not warn for a durable driver', () => {
    const onWarn = vi.fn()
    const durable: Driver = {
      ...memory(),
      capabilities: { durable: true, shared: true, atomicMerge: true },
    }
    createHouse({ driver: durable, schema: [makeCounter()], onWarn })
    expect(onWarn).not.toHaveBeenCalled()
  })
})

describe('register', () => {
  it('binds metrics declared after boot', async () => {
    const house = createHouse({ driver, now })
    const dogPoops = makeCounter()
    house.register(dogPoops)

    dogPoops.add(WILLOW)
    await house.drain()
    expect(await dogPoops.current(WILLOW)).toBe(1)
  })

  it('is idempotent for the same metric object', () => {
    const house = createHouse({ driver })
    const dogPoops = makeCounter()
    house.register(dogPoops)
    expect(() => house.register(dogPoops)).toThrow(/already bound/)
  })
})

describe('clock and error propagation', () => {
  it('passes its clock down to metrics', async () => {
    const dogPoops = makeCounter()
    createHouse({ driver, schema: [dogPoops], now })

    dogPoops.add(WILLOW)
    await dogPoops.drain()
    clock += 1000
    // a new bucket, because the house's clock moved
    expect(await dogPoops.current(WILLOW)).toBe(0)
  })

  it('passes onError down, so a failed write is reported not swallowed', async () => {
    const onError = vi.fn()
    const failing: Driver = { ...memory(), increment: () => Promise.reject(new Error('down')) }
    const dogPoops = makeCounter()
    createHouse({ driver: failing, schema: [dogPoops], now, onError })

    dogPoops.add(WILLOW)
    await dogPoops.drain()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('drain', () => {
  it('waits for every metric', async () => {
    const a = makeCounter('a')
    const b = makeCounter('b')
    const house = createHouse({ driver, schema: [a, b], now })

    for (let i = 0; i < 20; i++) {
      a.add(WILLOW)
      b.add(REX)
    }
    await house.drain()

    expect(await a.current(WILLOW)).toBe(20)
    expect(await b.current(REX)).toBe(20)
  })

  it('resolves when nothing is pending', async () => {
    await expect(createHouse({ driver, schema: [makeCounter()] }).drain()).resolves.toBeUndefined()
  })
})

describe('slice one — the whole path', () => {
  it('takes add() through flush() to rows with stable ids', async () => {
    const shipped: Row[] = []
    const write: WriteFn = (rows) => {
      shipped.push(...rows)
    }

    const dogPoops = makeCounter('dog_poops', { write })
    const house = createHouse({ driver, schema: [dogPoops], now })

    // three writes across two buckets
    dogPoops.add(WILLOW)
    dogPoops.add(WILLOW)
    clock += 1000
    dogPoops.add(3, REX)
    await house.drain()

    // move past the second bucket plus grace, so both are claimable
    clock += 1000 + 2000

    const report = await house.flush()
    expect(report.ok).toBe(true)
    expect(report.metrics.dog_poops).toMatchObject({ buckets: 2, rows: 2, skipped: false })

    expect(shipped).toHaveLength(2)
    expect(shipped[0]).toEqual({
      id: rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside|solid'),
      bucket_ts: new Date(1_788_616_987_000),
      dogName: 'Willow',
      park: 'riverside',
      kind: 'solid',
      value: 2,
    })
    expect(shipped[1]).toMatchObject({ dogName: 'Rex', value: 3 })

    // acked: the buckets are gone
    expect(await driver.readBuckets({ metric: 'dog_poops' })).toEqual([])
  })

  it('produces identical ids when the same window ships twice', async () => {
    // the flush crashed after write() and before ack, so it all comes again
    const batches: Row[][] = []
    let failNext = true
    const write: WriteFn = (rows) => {
      batches.push(rows)
      if (failNext) {
        failNext = false
        throw new Error('write landed, then the process died before ack')
      }
    }

    const dogPoops = makeCounter('dog_poops', { write })
    const house = createHouse({ driver, schema: [dogPoops], now })

    dogPoops.add(2, WILLOW)
    await house.drain()
    clock += 1000 + 2000

    const first = await house.flush()
    expect(first.ok).toBe(false)

    const second = await house.flush({ force: true })
    expect(second.ok).toBe(true)

    expect(batches).toHaveLength(2)
    expect(batches[0]?.map((r) => r.id)).toEqual(batches[1]?.map((r) => r.id))
    expect(batches[0]).toEqual(batches[1])
  })
})
