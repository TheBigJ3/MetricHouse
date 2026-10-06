import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { type Gauge, type GaugeRow, gauge } from '../metrics/gauge.js'
import { level } from '../metrics/level.js'
import { COLLECT } from '../metrics/types.js'
import { oneOf } from '../schema/types.js'
import type { CollectScope } from './collect.js'
import { createHouse } from './house.js'

/** The start of a minute, so every window below starts on a round number. */
const START = 1_788_616_980_000
const MINUTE = 60_000

const noop = () => {}

beforeEach(() => {
  // Date.now is faked too, so a timer fires with the clock reading exactly
  // the moment it was armed for, and the house reads that same clock
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  vi.useRealTimers()
})

type Collect<M> = (metric: M) => void | Promise<void>

/** A gauge on one minute windows, and every row its sink received. */
function queueGauge(
  collect: Collect<Gauge<Record<never, never>>>,
  options: { name?: string; collectLead?: string; collectScope?: CollectScope } = {},
) {
  const rows: GaugeRow<Record<never, never>>[] = []
  const metric = gauge(options.name ?? 'q', {
    resolution: '1m',
    flush: '1m',
    collect,
    ...(options.collectLead !== undefined && { collectLead: options.collectLead }),
    ...(options.collectScope !== undefined && { collectScope: options.collectScope }),
    write: (batch) => {
      rows.push(...batch)
    },
  })
  return { metric, rows }
}

/** `[bucket_ts, last, count]` per row, the part of a gauge row these tests are about. */
const folds = (rows: readonly GaugeRow<Record<never, never>>[]) =>
  rows
    .map((row) => [row.bucket_ts.getTime(), row.last, row.count])
    .sort((a, b) => (a[0] as number) - (b[0] as number))

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = noop
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** `memory()` claiming to be visible to other processes, as two houses on one Redis are. */
function sharedMemory(): Driver {
  const inner = memory()
  return { ...inner, capabilities: { ...inner.capabilities, shared: true, durable: true } }
}

describe('collect options', () => {
  const declare = (config: Record<string, unknown>) => () =>
    gauge('q', { resolution: '1m', flush: '1m', write: noop, ...config })

  it('refuses a collect that is not a function', () => {
    expect(declare({ collect: 'yes' })).toThrow('q: collect must be a function, got string')
  })

  it('refuses a lead of zero', () => {
    expect(declare({ collect: noop, collectLead: '0s' })).toThrow(
      'q: collectLead must be longer than zero, got "0s"',
    )
  })

  it('refuses a lead as long as the resolution', () => {
    expect(declare({ collect: noop, collectLead: '1m' })).toThrow(
      'q: collectLead is 1m, and it must be shorter than the resolution, 1m, so that collect ' +
        'runs inside the window it writes to',
    )
  })

  it('accepts a lead one millisecond shorter than the resolution', () => {
    const metric = gauge('q', {
      resolution: '1m',
      flush: '1m',
      collect: noop,
      collectLead: 59_999,
      write: noop,
    })
    expect(metric[COLLECT]?.leadMs).toBe(59_999)
  })

  it('names the setting when the lead is not a duration', () => {
    expect(declare({ collect: noop, collectLead: '1.5s' })).toThrow(
      'q: collectLead: parseDuration: "1.5s"',
    )
  })

  it('refuses an unknown scope', () => {
    expect(declare({ collect: noop, collectScope: 'cluster' })).toThrow(
      `q: collectScope must be 'fleet' or 'process', got "cluster"`,
    )
  })

  it('refuses a lead or a scope given without collect', () => {
    expect(declare({ collectLead: '5s' })).toThrow(
      'q: collectLead is set, but collect is not, so nothing would run',
    )
    expect(declare({ collectScope: 'process' })).toThrow(
      'q: collectScope is set, but collect is not, so nothing would run',
    )
  })

  it('defaults the lead to one second, or a tenth of a shorter resolution', () => {
    const leadFor = (resolution: string) =>
      gauge('q', { resolution, flush: '1m', collect: noop, write: noop })[COLLECT]?.leadMs
    expect(leadFor('1m')).toBe(1_000)
    expect(leadFor('10s')).toBe(1_000)
    expect(leadFor('5s')).toBe(500)
  })

  it("defaults the scope to 'fleet'", () => {
    expect(queueGauge(noop).metric[COLLECT]?.scope).toBe('fleet')
  })

  it('checks a level the same way', () => {
    expect(() =>
      level('q', { resolution: '1m', flush: '1m', collect: noop, collectLead: '2m', write: noop }),
    ).toThrow(
      'q: collectLead is 2m, and it must be shorter than the resolution, 1m, so that collect ' +
        'runs inside the window it writes to',
    )
  })

  it('leaves a metric declared without collect with no collector', () => {
    expect(gauge('q', { resolution: '1m', flush: '1m', write: noop })[COLLECT]).toBeUndefined()
  })
})

describe('collect on house.start()', () => {
  it('runs one lead before each window ends', async () => {
    const at: number[] = []
    const { metric } = queueGauge(() => {
      at.push(Date.now())
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(3 * MINUTE)

    expect(at).toEqual([START + 59_000, START + 119_000, START + 179_000])
    await house.stop()
  })

  it('runs collectLead before each window ends', async () => {
    const at: number[] = []
    const { metric } = queueGauge(
      () => {
        at.push(Date.now())
      },
      { collectLead: '5s' },
    )
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(2 * MINUTE)

    expect(at).toEqual([START + 55_000, START + 115_000])
    await house.stop()
  })

  it('first runs in the next window when started inside the lead', async () => {
    const at: number[] = []
    const { metric } = queueGauge(() => {
      at.push(Date.now())
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    vi.setSystemTime(START + 59_500)
    house.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    expect(at).toEqual([START + 119_000])
    await house.stop()
  })

  it('counts to the next window when asked at the moment one is due', () => {
    const { metric } = queueGauge(noop)
    createHouse({ driver: memory(), schema: [metric] })

    expect(metric[COLLECT]?.delay()).toBe(59_000)
    vi.setSystemTime(START + 59_000)
    expect(metric[COLLECT]?.delay()).toBe(MINUTE)
  })

  it("lands a gauge's writes in the window that is closing", async () => {
    let reading = 0
    const { metric, rows } = queueGauge((self) => {
      reading += 1
      self.set(reading)
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    await house.stop()

    // the fourth reading, taken by stop(), is in the window still open,
    // which a stopping process cannot ship
    expect(folds(rows)).toEqual([
      [START, 1, 1],
      [START + MINUTE, 2, 1],
      [START + 2 * MINUTE, 3, 1],
    ])
  })

  it("lands a level's writes in the window that is closing", async () => {
    const depths = [42, 38, 7]
    const rows: { bucket_ts: Date; queue: string; value: number }[] = []
    const metric = level('queue_depth', {
      dims: { queue: oneOf(['email']) },
      resolution: '1m',
      flush: '1m',
      collect: (self) => {
        self.set(depths.shift() as number, { queue: 'email' })
      },
      write: (batch) => {
        rows.push(...batch)
      },
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    await house.stop()

    expect(rows.map((row) => [row.bucket_ts.getTime(), row.queue, row.value])).toEqual([
      [START, 'email', 42],
      [START + MINUTE, 'email', 38],
    ])
  })

  it('skips a collect still running rather than stacking a second', async () => {
    let calls = 0
    let current = gate()
    const metric = gauge('q', {
      resolution: '1s',
      flush: '1m',
      collect: () => {
        calls += 1
        return current.promise
      },
      write: noop,
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    // due at 0.9s, 1.9s and 2.9s. The first is still running for the other two
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls).toBe(1)

    current.open()
    current = gate()
    current.open()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(2)
    await house.stop()
  })

  it('leaves collect to its timer when a flush runs', async () => {
    let calls = 0
    const { metric } = queueGauge(() => {
      calls += 1
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await metric.flush()
    await house.flush()
    expect(calls).toBe(0)

    await vi.advanceTimersByTimeAsync(49_000)
    expect(calls).toBe(1)
    await house.stop()
  })

  it('clears its timers on stop()', async () => {
    let calls = 0
    const { metric } = queueGauge(() => {
      calls += 1
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await house.stop()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    // the one collect stop() makes itself, and none after it
    expect(calls).toBe(1)
  })

  it('arms timers that do not keep the process alive', async () => {
    const { metric } = queueGauge(noop)
    const house = createHouse({ driver: memory(), schema: [metric] })
    const armed = vi.spyOn(globalThis, 'setTimeout')

    house.start()
    await vi.advanceTimersByTimeAsync(59_000)

    // the first flush tick, the first collect, and the collect armed after it
    const refs = armed.mock.results.map((result) =>
      (result.value as { hasRef(): boolean }).hasRef(),
    )
    expect(refs).toEqual([false, false, false])
    armed.mockRestore()
    await house.stop()
  })
})

describe('collect on flush() without start()', () => {
  it('collects before the flush, once per window', async () => {
    let reading = 0
    const { metric, rows } = queueGauge((self) => {
      reading += 1
      self.set(reading)
    })
    createHouse({ driver: memory(), schema: [metric] })

    vi.setSystemTime(START + 10_000)
    await metric.flush()
    await metric.flush()
    await metric.flush()
    expect(reading).toBe(1)

    vi.setSystemTime(START + 70_000)
    const report = await metric.flush()

    expect(reading).toBe(2)
    expect(report).toEqual({ buckets: 1, rows: 1, skipped: false })
    expect(folds(rows)).toEqual([[START, 1, 1]])
  })

  it('collects for every metric a house flush visits', async () => {
    const order: string[] = []
    const a = queueGauge(
      () => {
        order.push('a')
      },
      { name: 'a' },
    )
    const b = level('b', {
      resolution: '1m',
      flush: '1m',
      collect: () => {
        order.push('b')
      },
      write: noop,
    })
    const house = createHouse({ driver: memory(), schema: [a.metric, b] })

    await house.flush()
    await house.flush()

    expect(order).toEqual(['a', 'b'])
  })

  it('collects again at once when the clock steps back a window', async () => {
    let calls = 0
    const { metric } = queueGauge(() => {
      calls += 1
    })
    createHouse({ driver: memory(), schema: [metric] })

    vi.setSystemTime(START + 70_000)
    await metric.flush()
    vi.setSystemTime(START + 10_000)
    await metric.flush()

    expect(calls).toBe(2)
  })

  it('leaves collect to house.stop() on a final flush', async () => {
    let calls = 0
    const { metric } = queueGauge(() => {
      calls += 1
    })
    createHouse({ driver: memory(), schema: [metric] })

    await metric.flush({ final: true })

    expect(calls).toBe(0)
  })

  it('does not collect on an unbound metric, whose flush throws', async () => {
    let calls = 0
    const { metric } = queueGauge(() => {
      calls += 1
    })

    await expect(metric.flush()).rejects.toThrow(
      'q: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
    expect(calls).toBe(0)
  })
})

describe('collect on house.stop()', () => {
  it('collects once more before the final flush, and drains what it wrote', async () => {
    const events: string[] = []
    const rows: GaugeRow<Record<never, never>>[] = []
    const metric = gauge('q', {
      resolution: '1m',
      flush: '1m',
      collect: (self) => {
        events.push('collect')
        self.set(9)
      },
      write: (batch) => {
        events.push('write')
        rows.push(...batch)
      },
    })
    const house = createHouse({ driver: memory(), schema: [metric] })
    // a window that has closed by the time stop() runs, for the final flush
    metric.set(5)
    await house.drain()
    vi.setSystemTime(START + 70_000)

    await house.stop()

    expect(events).toEqual(['collect', 'write'])
    expect(folds(rows)).toEqual([[START, 5, 1]])
    expect(await metric.current()).toEqual({ last: 9, min: 9, max: 9, sum: 9, count: 1 })
  })

  it('does not collect a window twice when stop() comes inside the lead', async () => {
    let calls = 0
    const { metric } = queueGauge(() => {
      calls += 1
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(59_500)
    await house.stop()

    expect(calls).toBe(1)
  })

  it('waits for a collect still running, and drains what it writes', async () => {
    const { promise, open } = gate()
    const { metric } = queueGauge(async (self) => {
      await promise
      self.set(3)
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(59_000)
    let stopped = false
    const stopping = house.stop().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)

    open()
    await stopping
    expect(await metric.current()).toEqual({ last: 3, min: 3, max: 3, sum: 3, count: 1 })
  })
})

describe('drain() with collect', () => {
  it('waits for a collect still running and the writes it makes', async () => {
    const { promise, open } = gate()
    const { metric } = queueGauge(async (self) => {
      await promise
      self.set(7)
    })
    const house = createHouse({ driver: memory(), schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(59_000)
    let drained = false
    const draining = house.drain().then(() => {
      drained = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)

    open()
    await draining
    expect(await metric.current()).toEqual({ last: 7, min: 7, max: 7, sum: 7, count: 1 })
    await house.stop()
  })
})

describe('collect failures', () => {
  it('routes a collect that throws to onError, and the flush still ships', async () => {
    const errors: [string, { metric: string }][] = []
    const { metric, rows } = queueGauge(() => {
      throw new Error('redis down')
    })
    createHouse({
      driver: memory(),
      schema: [metric],
      onError: (error, context) => errors.push([(error as Error).message, context]),
    })
    metric.set(5)
    await metric.drain()

    vi.setSystemTime(START + 70_000)
    const report = await metric.flush()

    expect(errors).toEqual([['redis down', { metric: 'q' }]])
    expect(report).toEqual({ buckets: 1, rows: 1, skipped: false })
    expect(folds(rows)).toEqual([[START, 5, 1]])
  })

  it('routes a collect that rejects on a timer to onError', async () => {
    const errors: string[] = []
    const { metric } = queueGauge(async () => {
      throw new Error('redis down')
    })
    const house = createHouse({
      driver: memory(),
      schema: [metric],
      onError: (error) => errors.push((error as Error).message),
    })

    house.start()
    await vi.advanceTimersByTimeAsync(2 * MINUTE)

    expect(errors).toEqual(['redis down', 'redis down'])
    await house.stop()
  })

  it('raises a collect that fails as an unhandled rejection with no onError', async () => {
    const { metric } = queueGauge(() => {
      throw new Error('redis down')
    })
    createHouse({ driver: memory(), schema: [metric] })

    const raised: string[] = []
    const reject = vi.spyOn(Promise, 'reject').mockImplementation((reason?: unknown) => {
      raised.push((reason as Error).message)
      return Promise.resolve() as never
    })
    try {
      await metric.flush()
    } finally {
      reject.mockRestore()
    }

    expect(raised).toEqual(['redis down'])
  })

  it('routes a collect turn the driver could not take to onError, and skips the collect', async () => {
    let calls = 0
    const errors: string[] = []
    const inner = sharedMemory()
    const driver: Driver = {
      ...inner,
      takeTurn: (metric, now, gapMs) =>
        metric.endsWith(':collect')
          ? Promise.reject(new Error('turn failed'))
          : (inner.takeTurn?.(metric, now, gapMs) as never),
    }
    const { metric } = queueGauge(() => {
      calls += 1
    })
    createHouse({
      driver,
      schema: [metric],
      onError: (error) => errors.push((error as Error).message),
    })

    await metric.flush()

    expect(errors).toEqual(['turn failed'])
    expect(calls).toBe(0)
  })
})

describe('collectScope', () => {
  /** Two processes sharing one driver, each with its own copy of the same gauge. */
  async function fleet(scope: CollectScope) {
    const driver = sharedMemory()
    const calls = { one: 0, two: 0 }
    const processOn = (name: 'one' | 'two') => {
      const made = queueGauge(
        (self) => {
          calls[name] += 1
          self.set(1)
        },
        { collectScope: scope },
      )
      return { ...made, house: createHouse({ driver, schema: [made.metric] }) }
    }
    const one = processOn('one')
    const two = processOn('two')

    one.house.start()
    two.house.start()
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    await one.house.stop()
    await two.house.stop()
    // the last process ships what the turn left behind
    await one.house.flush({ final: true, force: true })

    return { calls, rows: folds([...one.rows, ...two.rows]) }
  }

  it("runs once per window across a fleet sharing a driver, with 'fleet'", async () => {
    const { calls, rows } = await fleet('fleet')

    // three windows on the timer, and the open one on stop()
    expect(calls).toEqual({ one: 4, two: 0 })
    expect(rows).toEqual([
      [START, 1, 1],
      [START + MINUTE, 1, 1],
      [START + 2 * MINUTE, 1, 1],
    ])
  })

  it("runs every window in every process, with 'process'", async () => {
    const { calls, rows } = await fleet('process')

    expect(calls).toEqual({ one: 4, two: 4 })
    expect(rows).toEqual([
      [START, 1, 2],
      [START + MINUTE, 1, 2],
      [START + 2 * MINUTE, 1, 2],
    ])
  })

  it('takes its turn under the metric name and a colon, stamped with the window', async () => {
    const driver = sharedMemory()
    const turns: [string, number, number][] = []
    const watched: Driver = {
      ...driver,
      takeTurn: (metric, now, gapMs) => {
        turns.push([metric, now, gapMs])
        return driver.takeTurn?.(metric, now, gapMs) as never
      },
    }
    const { metric } = queueGauge(noop)
    createHouse({ driver: watched, schema: [metric] })

    vi.setSystemTime(START + 10_000)
    await metric.flush()
    vi.setSystemTime(START + 70_000)
    await metric.flush()

    expect(turns.filter(([key]) => key !== 'q')).toEqual([
      ['q:collect', START, MINUTE],
      ['q:collect', START + MINUTE, MINUTE],
    ])
  })

  it('takes no turn on a driver that is not shared', async () => {
    let calls = 0
    const driver = memory()
    const takeTurn = vi.spyOn(driver, 'takeTurn')
    const { metric } = queueGauge(() => {
      calls += 1
    })
    const house = createHouse({ driver, schema: [metric] })

    house.start()
    await vi.advanceTimersByTimeAsync(2 * MINUTE)

    expect(calls).toBe(2)
    expect(takeTurn).not.toHaveBeenCalled()
    await house.stop()
  })
})
