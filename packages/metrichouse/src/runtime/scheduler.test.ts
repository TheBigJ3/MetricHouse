import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { counter } from '../metrics/counter.js'
import { event } from '../metrics/event.js'
import type { WriteFn } from '../metrics/types.js'
import { str } from '../schema/types.js'
import { createHouse } from './house.js'
import { firstTickDelay } from './scheduler.js'

const A = { dogName: 'Willow' } as const

let clock: number
let driver: Driver
const now = () => clock

/** Past the bucket, past grace, so everything written so far is claimable. */
const settle = (): void => {
  clock += 1_000 + 2_000
}

const make = (name: string, write: WriteFn, flush = '1m') =>
  counter(name, { write, dims: { dogName: str() }, resolution: '1s', flush })

/**
 * Advance the fake timers *and* the metric clock together.
 *
 * They are two different clocks, since vitest drives `setInterval`, `now()` drives
 * bucket boundaries, and a tick that fires against a stale `now` would find
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

  it('is idempotent, so a second start does not double the cadence', async () => {
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

  it('routes a failing scheduled flush to onError, since there is no caller to throw at', async () => {
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

  it('raises a failing scheduled flush as an unhandled rejection with no onError', async () => {
    const metric = make('m', () => {
      throw new Error('sink down')
    })
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()
    settle()

    const raised: string[] = []
    const reject = vi.spyOn(Promise, 'reject').mockImplementation((reason?: unknown) => {
      raised.push((reason as Error).message)
      return Promise.resolve() as never
    })
    try {
      house.start()
      await tick(60_000)
    } finally {
      reject.mockRestore()
    }
    expect(raised).toEqual(['sink down'])
    await house.stop()
  })

  it('routes a failed recovery pass on a scheduled flush to onError', async () => {
    const errors: [string, { metric: string }][] = []
    const failing: Driver = {
      ...driver,
      recover: () => Promise.reject(new Error('recovery failed')),
    }
    const metric = make('m', vi.fn())
    const house = createHouse({
      driver: failing,
      schema: [metric],
      now,
      onError: (error, context) => errors.push([(error as Error).message, context]),
    })
    metric.add(A)
    await house.drain()
    settle()
    house.start()

    await tick(60_000)
    expect(errors).toEqual([['recovery failed', { metric: 'm' }]])
    await house.stop()
  })

  it('routes a failed ack on a scheduled flush to onError', async () => {
    const errors: [string, { metric: string }][] = []
    const lossy: Driver = {
      ...driver,
      ack: () => Promise.reject(new Error('claim was recovered')),
    }
    const metric = make('m', vi.fn())
    const house = createHouse({
      driver: lossy,
      schema: [metric],
      now,
      onError: (error, context) => errors.push([(error as Error).message, context]),
    })
    metric.add(A)
    await house.drain()
    settle()
    house.start()

    await tick(60_000)
    expect(errors).toEqual([['claim was recovered', { metric: 'm' }]])
    await house.stop()
  })
})

describe('house.stop()', () => {
  it('still makes the final flush when onError threw on a tick', async () => {
    let calls = 0
    const shipped: unknown[] = []
    const write: WriteFn = (rows) => {
      calls += 1
      if (calls === 1) throw new Error('sink timed out')
      shipped.push(...rows.map((row) => row.value))
    }
    const metric = make('m', write, '1m')
    const house = createHouse({
      driver,
      schema: [metric],
      now,
      // a logger that cannot serialise what it was handed
      onError: () => {
        throw new TypeError('Converting circular structure to JSON')
      },
    })
    metric.add(7, A)
    await house.drain()
    settle()

    const raised: string[] = []
    const reject = vi.spyOn(Promise, 'reject').mockImplementation((reason?: unknown) => {
      raised.push((reason as Error).message)
      return Promise.resolve() as never
    })
    try {
      house.start()
      await tick(60_000)
      expect((await house.stop()).ok).toBe(true)
    } finally {
      reject.mockRestore()
    }

    // the handler's own failure is raised, and the rows ship in the final flush
    expect(raised).toEqual(['Converting circular structure to JSON'])
    expect(shipped).toEqual([7])
  })

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
    metric.add(A) // deliberately not drained, since stop() owes us that
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

  it('waits for a tick still inside its sink, and ships what that tick put back', async () => {
    // the tick's sink fails after stop() has been called. Its rows go back to
    // the driver, and the final flush that follows is what ships them
    let calls = 0
    let failTick: (() => void) | undefined
    const shipped: unknown[] = []
    const write: WriteFn = async (rows) => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          failTick = resolve
        })
        throw new Error('sink timed out')
      }
      shipped.push(...rows.map((row) => row.value))
    }
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now, onError: () => {} })

    house.start()
    metric.add(7, A)
    await house.drain()
    await tick(60_000) // the tick claims the window and waits in the sink

    const stopped = house.stop()
    failTick?.()
    const report = await stopped

    expect(shipped).toEqual([7])
    expect(report.ok).toBe(true)
  })

  it('ships windows still inside grace, leaving only the open one', async () => {
    const write = vi.fn()
    const metric = counter('m', {
      write,
      dims: { dogName: str() },
      resolution: '1s',
      flush: '5m',
      grace: '5s',
    })
    const house = createHouse({ driver, schema: [metric], now })

    for (let n = 0; n < 5; n++) {
      metric.add(A)
      clock += 1_000
    }
    await house.drain()

    const report = await house.stop()
    expect(report.metrics.m).toMatchObject({ rows: 5 })
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

describe('firstTickDelay', () => {
  it('puts a name at a fixed point inside its interval', () => {
    expect(firstTickDelay('m', 60_000)).toBe(12_696)
    expect(firstTickDelay('http_requests', 60_000)).toBe(16)
    expect(firstTickDelay('lazy', 300_000)).toBe(161_615)
  })

  it('is zero for an interval of one millisecond', () => {
    expect(firstTickDelay('m', 1)).toBe(0)
  })
})

describe('first tick offsets', () => {
  it("fires a metric's first tick at its offset, then once per interval", async () => {
    const write = vi.fn()
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()
    settle()
    house.start()

    await tick(12_695)
    expect(write).not.toHaveBeenCalled()
    await tick(1)
    expect(write).toHaveBeenCalledTimes(1)

    metric.add(A)
    await house.drain()
    await tick(59_999)
    expect(write).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('spreads metrics on one cadence across the interval', async () => {
    const early = vi.fn()
    const late = vi.fn()
    const first = make('b', early, '1m')
    const second = make('a', late, '1m')
    const house = createHouse({ driver, schema: [first, second], now })
    first.add(A)
    second.add(A)
    await house.drain()
    settle()
    house.start()

    // 'b' fires at 35_077 and 'a' at 42_220
    await tick(35_077)
    expect(early).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()
    await tick(42_220 - 35_077)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('fires nothing once stopped before the first tick', async () => {
    const write = vi.fn()
    const metric = make('m', write, '1m')
    const house = createHouse({ driver, schema: [metric], now })
    house.start()
    await house.stop()

    metric.add(A)
    await house.drain()
    settle()
    await tick(120_000)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('two processes started seconds apart on a shared driver', () => {
  it('ships one full interval per insert, from whichever asks first', async () => {
    const inner = memory()
    const shared: Driver = {
      ...inner,
      capabilities: { ...inner.capabilities, shared: true, durable: true },
    }
    const inserts: { process: string; at: number; rows: number }[] = []
    const processOn = (name: string) => {
      const metric = make('m', (rows) => {
        inserts.push({ process: name, at: clock, rows: rows.length })
      })
      const house = createHouse({ driver: shared, schema: [metric], now })
      return { metric, house }
    }

    const one = processOn('one')
    const two = processOn('two')
    const started = clock
    one.house.start()
    await tick(3_000)
    two.house.start()

    // a write every second for ten minutes, alternating between the two
    for (let second = 3; second < 600; second++) {
      const proc = second % 2 === 0 ? one : two
      proc.metric.add(A)
      await proc.house.drain()
      await tick(1_000)
    }

    // one's ticks land at 12.696s, then every minute. two's land three
    // seconds after each of those, inside the interval, and are refused
    expect(inserts.map((i) => i.process)).toEqual(Array(10).fill('one'))
    expect(inserts.map((i) => i.at - started)).toEqual(
      Array.from({ length: 10 }, (_, n) => 13_000 + n * 60_000),
    )
    expect(inserts.slice(1).map((i) => i.rows)).toEqual(Array(9).fill(60))
  })
})
