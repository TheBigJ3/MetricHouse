import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { counter } from '../metrics/counter.js'
import { event } from '../metrics/event.js'
import type { WriteFn } from '../metrics/types.js'
import { str } from '../schema/types.js'
import { createHouse } from './house.js'

const A = { dogName: 'Willow' } as const

let clock: number
let driver: Driver
const now = () => clock

/** Past the bucket, past grace — everything written so far is claimable. */
const settle = (): void => {
  clock += 1_000 + 2_000
}

const make = (name: string, write: WriteFn, flush = '1m') =>
  counter(name, { write, dims: { dogName: str() }, resolution: '1s', flush })

/**
 * Advance the fake timers *and* the metric clock together.
 *
 * They are two different clocks — vitest drives `setInterval`, `now()` drives
 * bucket boundaries — and a tick that fires against a stale `now` would find
 * nothing closed and report a false negative.
 */
async function tick(ms: number): Promise<void> {
  clock += ms
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_788_616_987_000
  driver = memory()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('house.start()', () => {
  it('ships on the metric cadence with nobody calling flush', async () => {
    const write = vi.fn()
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now })

    metric.add(A)
    await house.drain()
    settle()

    expect(write).not.toHaveBeenCalled() // nothing ticks until asked
    house.start()
    expect(house.running).toBe(true)

    await tick(60_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('gives each metric its own interval rather than one shared pump', async () => {
    const fast = vi.fn()
    const slow = vi.fn()
    const quick = make('quick', fast, '1m')
    const lazy = make('lazy', slow, '5m')
    const house = createHouse({ driver, schema: [quick, lazy], now })

    quick.add(A)
    lazy.add(A)
    await house.drain()
    settle()
    house.start()

    await tick(60_000)
    expect(fast).toHaveBeenCalledTimes(1)
    expect(slow).not.toHaveBeenCalled()

    // the slow one keeps accumulating and goes at its own boundary
    await tick(240_000)
    expect(slow).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second start does not double the cadence', async () => {
    const write = vi.fn()
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now })

    metric.add(A)
    await house.drain()
    settle()

    house.start()
    house.start()

    await tick(60_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('schedules a metric registered after it started', async () => {
    const write = vi.fn()
    const house = createHouse({ driver, now })
    house.start()

    const late = make('late', write, '1m')
    house.register(late)
    late.add(A)
    await house.drain()
    settle()

    await tick(60_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('skips a tick while the previous one is still writing', async () => {
    let release: (() => void) | undefined
    const write = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now })

    metric.add(A)
    await house.drain()
    settle()
    house.start()

    await tick(60_000)
    expect(write).toHaveBeenCalledTimes(1)

    // second boundary arrives while the first write is still in flight
    await tick(60_000)
    expect(write).toHaveBeenCalledTimes(1)

    release?.()
  })

  it('routes a failing scheduled flush to onError — there is no caller to throw at', async () => {
    const onError = vi.fn()
    const write = vi.fn().mockRejectedValue(new Error('sink down'))
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now, onError })

    metric.add(A)
    await house.drain()
    settle()
    house.start()

    await tick(60_000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sink down' }), {
      metric: 'm',
    })
  })
})

describe('house.stop()', () => {
  it('stops ticking and forces out what is closed', async () => {
    const write = vi.fn()
    const metric = make('m', write, '5m')
    const house = createHouse({ driver, schema: [metric], now })

    house.start()
    metric.add(A)
    settle()

    // well inside the 5m cadence, so an ordinary tick would not have shipped
    const report = await house.stop()
    expect(house.running).toBe(false)
    expect(report.metrics.m).toMatchObject({ rows: 1, skipped: false })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('drains writes still on their way to the driver before claiming', async () => {
    const write = vi.fn()
    const metric = make('m', write, '5m')
    const house = createHouse({ driver, schema: [metric], now })

    house.start()
    metric.add(A) // deliberately not drained — stop() owes us that
    settle()

    await house.stop()
    expect(write.mock.calls[0]?.[0]).toHaveLength(1)
  })

  it('cannot ship the open bucket, and does not pretend to', async () => {
    const write = vi.fn()
    const metric = make('m', write, '5m')
    const house = createHouse({ driver, schema: [metric], now })

    house.start()
    metric.add(A)
    await house.drain()
    // no settle: the bucket is still open

    const report = await house.stop()
    expect(report.metrics.m).toMatchObject({ rows: 0 })
    expect(write).not.toHaveBeenCalled()
    expect(await metric.current(A)).toBe(1) // still live, still countable
  })

  it('fires no further ticks once stopped', async () => {
    const write = vi.fn()
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now })

    house.start()
    await house.stop()

    metric.add(A)
    await house.drain()
    settle()

    await tick(300_000)
    expect(write).not.toHaveBeenCalled()
  })

  it('schedules a staged kind too', async () => {
    const write = vi.fn()
    const signups = event('signups', { write, fields: { plan: str() }, flush: '1m' })
    const house = createHouse({ driver, schema: [signups], now })

    house.start()
    signups.record({ plan: 'pro' })
    await house.drain()

    await tick(60_000)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
