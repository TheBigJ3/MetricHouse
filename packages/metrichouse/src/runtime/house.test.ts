import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { counter } from '../metrics/counter.js'
import { event } from '../metrics/event.js'
import { timer } from '../metrics/timer.js'
import type { Row, WriteFn } from '../metrics/types.js'
import { oneOf, str } from '../schema/types.js'
import { createHouse } from './house.js'

/** A sink that keeps nothing, for declaration tests that never ship. */
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

  it('opens no connections of its own, so it is safe at module scope', () => {
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

  const audit = () =>
    event('order_audit', { fields: { orderId: str() }, durability: 'durable', write: discard })
  const DURABLE = { durable: true, shared: true, atomicMerge: true }

  it('warns when a durable event is bound to a driver that cannot survive a restart', () => {
    const onWarn = vi.fn()
    createHouse({ driver: memory(), schema: [audit()], onWarn })
    expect(onWarn.mock.calls[1]).toEqual([
      "order_audit: durability is 'durable', but the driver cannot survive a restart, so " +
        'record() resolves once the record is staged and a crash still loses it',
      { metric: 'order_audit' },
    ])
  })

  it('warns about a durable event registered after the house was created', () => {
    const onWarn = vi.fn()
    const house = createHouse({ driver: memory(), onWarn })
    house.register(audit())
    expect(onWarn).toHaveBeenCalledTimes(2)
    expect(onWarn.mock.calls[1]?.[1]).toEqual({ metric: 'order_audit' })
  })

  it('does not warn about a durable event on a durable driver', () => {
    const onWarn = vi.fn()
    createHouse({ driver: { ...memory(), capabilities: DURABLE }, schema: [audit()], onWarn })
    expect(onWarn).not.toHaveBeenCalled()
  })
})

describe('house config', () => {
  it('refuses a default flush cadence of zero', () => {
    expect(() => createHouse({ driver, defaults: { flush: '0s' } })).toThrow(
      'createHouse: defaults.flush must be longer than zero, got "0s"',
    )
  })

  it('refuses a default flush cadence a timer cannot wait for', () => {
    expect(() => createHouse({ driver, defaults: { flush: '25d' } })).toThrow(
      /^createHouse: defaults.flush is 25d, longer than 2147483647ms/,
    )
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
    expect(() => house.register(dogPoops)).not.toThrow()
    expect(house.metrics()).toEqual([dogPoops])
  })

  it('refuses a metric another house already holds', () => {
    const dogPoops = makeCounter()
    createHouse({ driver, schema: [dogPoops] })
    expect(() => createHouse({ driver, schema: [dogPoops] })).toThrow(/already bound/)
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
    expect(onError.mock.calls).toEqual([[new Error('down'), { metric: 'dog_poops' }]])
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

  it('waits for every metric when another metric has a failed write in flight', async () => {
    const inner = memory()
    const slow: Driver = {
      ...inner,
      increment: async (ops) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return inner.increment(ops)
      },
    }
    const pageViewed = event('page_viewed', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 1 },
      write: async () => {
        throw new Error('clickhouse is down')
      },
    })
    const requests = makeCounter('requests')
    // no onError, so the failed write is raised as an unhandled rejection
    const house = createHouse({ driver: slow, schema: [pageViewed, requests], now })

    const raised = await raisedDuring(async () => {
      requests.add(WILLOW)
      pageViewed.record({ path: '/' })
      await house.drain()
    })

    expect(raised).toEqual(['clickhouse is down'])
    expect(await inner.readBuckets({ metric: 'requests' })).toEqual([
      { bucketTs: 1_788_616_987_000, dimKey: 'Willow|riverside|solid', value: 1 },
    ])
  })
})

describe('slice one, the whole path', () => {
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

describe('registration is all or nothing', () => {
  it('leaves no metric bound when a later one fails, so a retry works', () => {
    const first = makeCounter('first')
    // no flush of its own and no house default, so binding it throws
    const broken = counter('broken', { resolution: '1s', write: discard })
    expect(() => createHouse({ driver, schema: [first, broken] })).toThrow(/no flush cadence/)
    expect(first.isBound).toBe(false)

    expect(() => createHouse({ driver, schema: [first], defaults: { flush: '1m' } })).not.toThrow()
  })

  it('leaves the metric that failed unbound too, so it can be registered again', () => {
    const broken = counter('broken', { resolution: '1s', write: discard })
    expect(() => createHouse({ driver, schema: [broken] })).toThrow(/no flush cadence/)
    expect(broken.isBound).toBe(false)

    createHouse({ driver, schema: [broken], defaults: { flush: '1m' } })
    expect(broken.isBound).toBe(true)
  })

  it('accepts a schema module that exports one metric under two names', () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: { dogPoops, alias: dogPoops } })
    expect(house.metrics()).toEqual([dogPoops])
  })
})

describe('flush keeps going when one metric fails', () => {
  it('reports a failed ack as noise beside a success, and ships the next metric', async () => {
    const shipped: string[] = []
    const first = makeCounter('first', { write: () => shipped.push('first') })
    const second = makeCounter('second', { write: () => shipped.push('second') })
    const house = createHouse({ driver, schema: [first, second], now })
    first.add(WILLOW)
    second.add(WILLOW)
    await house.drain()

    // another flusher settles the claim while the sink is writing, as a
    // recovery would
    const ack = driver.ack.bind(driver)
    driver.ack = async (claim) => {
      if (claim.metric === 'first') {
        await ack(claim)
        throw new Error('claim first#1 is not in flight. Was it already settled?')
      }
      return ack(claim)
    }

    clock += 5_000
    const report = await house.flush()
    expect(shipped).toEqual(['first', 'second'])
    expect(report.ok).toBe(true)
    expect(report.metrics.first?.ackError).toBeInstanceOf(Error)
    expect(report.metrics.second?.rows).toBe(1)
  })

  it('reports a driver that cannot claim instead of throwing', async () => {
    const first = makeCounter('first')
    const second = makeCounter('second')
    const house = createHouse({ driver, schema: [first, second], now })
    const claim = driver.claim.bind(driver)
    driver.claim = async (metric, upTo) => {
      if (metric === 'first') throw new Error('connection refused')
      return claim(metric, upTo)
    }

    const report = await house.flush({ force: true })
    expect(report.ok).toBe(false)
    expect(String(report.metrics.first?.error)).toMatch(/connection refused/)
    expect(report.metrics.second?.error).toBeUndefined()
  })
})

/**
 * Stand in for `Promise.reject` while `run` runs, so a failure raised on
 * purpose as an unhandled rejection is caught here instead of failing the run.
 */
async function raisedDuring(run: () => Promise<unknown>): Promise<string[]> {
  const raised: string[] = []
  const reject = vi.spyOn(Promise, 'reject').mockImplementation((reason?: unknown) => {
    raised.push((reason as Error).message)
    return Promise.resolve() as never
  })
  try {
    await run()
  } finally {
    reject.mockRestore()
  }
  return raised
}

describe('house.stop()', () => {
  it('makes the final flush when another metric has a failed write in flight', async () => {
    const shipped: Row[] = []
    const pageViewed = event('page_viewed', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 1 },
      write: async () => {
        throw new Error('clickhouse is down')
      },
    })
    const requests = makeCounter('requests', {
      write: (rows: Row[]) => {
        shipped.push(...rows)
      },
    })
    const house = createHouse({ driver, schema: [pageViewed, requests], now })
    requests.add(WILLOW)
    await house.drain()
    clock += 1_000

    const raised = await raisedDuring(async () => {
      pageViewed.record({ path: '/' })
      expect((await house.stop()).metrics.requests?.rows).toBe(1)
    })

    expect(raised).toEqual(['clickhouse is down', 'clickhouse is down'])
    expect(shipped.map((row) => row.value)).toEqual([1])
  })

  it('waits for a house flush still inside its sink, and ships what it put back', async () => {
    const sink = hangingSink(1)
    const signups = event('signups', { fields: { plan: str() }, write: sink.write })
    const house = createHouse({ driver, schema: [signups], now })
    signups.record({ plan: 'pro' })
    await house.drain()

    const cron = house.flush()
    await vi.waitFor(() => expect(sink.waiting).toHaveLength(1))
    signups.record({ plan: 'team' })
    const stopping = watch(house.stop())
    await macrotask()
    expect(stopping.settled).toBe(false)

    sink.waiting[0]?.(new Error('sink timed out'))
    expect((await cron).metrics.signups?.error).toEqual(new Error('sink timed out'))
    const report = await stopping.promise

    expect(sink.shipped.map((row) => row.plan)).toEqual(['pro', 'team'])
    expect(report.metrics.signups).toMatchObject({ rows: 2 })
    expect(await signups.pending()).toBe(0)
  })

  it('waits for a direct metric.flush() still inside its sink', async () => {
    const sink = hangingSink(1)
    const requests = makeCounter('requests', { write: sink.write })
    const house = createHouse({ driver, schema: [requests], now })
    requests.add(3, WILLOW)
    await house.drain()
    clock += 3_000

    const direct = requests.flush()
    await vi.waitFor(() => expect(sink.waiting).toHaveLength(1))
    const stopping = house.stop()
    await macrotask()
    sink.waiting[0]?.(new Error('sink timed out'))
    expect((await direct).error).toEqual(new Error('sink timed out'))
    const report = await stopping

    expect(sink.shipped).toEqual([
      {
        id: rowId('requests', 1_788_616_987_000, 'Willow|riverside|solid'),
        bucket_ts: new Date(1_788_616_987_000),
        ...WILLOW,
        value: 3,
      },
    ])
    expect(report.metrics.requests).toMatchObject({ rows: 1 })
    expect(await requests.snapshot({ complete: false })).toEqual([])
  })

  it('waits for a flush started while it is already waiting', async () => {
    const sink = hangingSink(2)
    const signups = event('signups', { fields: { plan: str() }, write: sink.write })
    const house = createHouse({ driver, schema: [signups], now })
    signups.record({ plan: 'pro' })
    await house.drain()

    const first = signups.flush()
    await vi.waitFor(() => expect(sink.waiting).toHaveLength(1))
    const stopping = watch(house.stop())
    await macrotask()

    signups.record({ plan: 'team' })
    await signups.drain()
    const second = signups.flush()
    await vi.waitFor(() => expect(sink.waiting).toHaveLength(2))
    sink.waiting[0]?.(new Error('sink timed out'))
    await first
    await macrotask()
    expect(stopping.settled).toBe(false)

    sink.waiting[1]?.(new Error('sink timed out'))
    await second
    const report = await stopping.promise

    expect(sink.shipped.map((row) => row.plan)).toEqual(['pro', 'team'])
    expect(report.metrics.signups).toMatchObject({ rows: 2 })
    expect(await signups.pending()).toBe(0)
  })

  it('waits for a house flush that reaches its next metric after the one it was in', async () => {
    const first = hangingSink(1)
    const second = hangingSink(1)
    const logins = makeCounter('logins', { write: first.write })
    const requests = makeCounter('requests', { write: second.write })
    const house = createHouse({ driver, schema: [logins, requests], now })
    logins.add(2, WILLOW)
    requests.add(5, WILLOW)
    await house.drain()
    clock += 3_000

    const cron = house.flush()
    await vi.waitFor(() => expect(first.waiting).toHaveLength(1))
    const stopping = watch(house.stop())
    await macrotask()
    first.waiting[0]?.(new Error('sink timed out'))
    // the cron moves on to requests while stop() is still waiting
    await vi.waitFor(() => expect(second.waiting).toHaveLength(1))
    await macrotask()
    expect(stopping.settled).toBe(false)

    second.waiting[0]?.(new Error('sink timed out'))
    expect((await cron).metrics.requests?.error).toEqual(new Error('sink timed out'))
    const report = await stopping.promise

    expect(second.shipped).toEqual([
      {
        id: rowId('requests', 1_788_616_987_000, 'Willow|riverside|solid'),
        bucket_ts: new Date(1_788_616_987_000),
        ...WILLOW,
        value: 5,
      },
    ])
    expect(first.shipped.map((row) => row.value)).toEqual([2])
    expect(report.metrics).toMatchObject({ logins: { rows: 1 }, requests: { rows: 1 } })
    expect(await requests.snapshot({ complete: false })).toEqual([])
    expect(await logins.snapshot({ complete: false })).toEqual([])
  })

  it('waits for a house flush started while it is already waiting for another', async () => {
    const first = hangingSink(1)
    const second = hangingSink(1)
    const logins = makeCounter('logins', { write: first.write })
    const requests = makeCounter('requests', { write: second.write })
    const house = createHouse({ driver, schema: [logins, requests], now })
    logins.add(2, WILLOW)
    requests.add(5, WILLOW)
    await house.drain()
    clock += 3_000

    const cron = house.flush({ only: ['logins'] })
    await vi.waitFor(() => expect(first.waiting).toHaveLength(1))
    const stopping = watch(house.stop())
    await macrotask()
    // finds logins already claimed by the first, and goes on to requests
    const handler = house.flush()
    await vi.waitFor(() => expect(second.waiting).toHaveLength(1))
    first.waiting[0]?.(new Error('sink timed out'))
    await cron
    await macrotask()
    expect(stopping.settled).toBe(false)

    second.waiting[0]?.(new Error('sink timed out'))
    expect((await handler).metrics.requests?.error).toEqual(new Error('sink timed out'))
    const report = await stopping.promise

    expect(second.shipped.map((row) => row.value)).toEqual([5])
    expect(first.shipped.map((row) => row.value)).toEqual([2])
    expect(report.metrics).toMatchObject({ logins: { rows: 1 }, requests: { rows: 1 } })
    expect(await requests.snapshot({ complete: false })).toEqual([])
  })

  it('waits for a timer flush, which runs on the gauge underneath it', async () => {
    const sink = hangingSink(1)
    const latency = timer('latency', { resolution: '1s', flush: '5m', write: sink.write })
    const house = createHouse({ driver, schema: [latency], now })
    latency.observe(12)
    await house.drain()
    clock += 3_000

    const direct = latency.flush()
    await vi.waitFor(() => expect(sink.waiting).toHaveLength(1))
    const stopping = house.stop()
    await macrotask()
    sink.waiting[0]?.(new Error('sink timed out'))
    await direct
    const report = await stopping

    expect(sink.shipped).toEqual([
      {
        id: rowId('latency', 1_788_616_987_000, ''),
        bucket_ts: new Date(1_788_616_987_000),
        min: 12,
        max: 12,
        sum: 12,
        count: 1,
      },
    ])
    expect(report.metrics.latency).toMatchObject({ rows: 1 })
  })

  it('waits for a flush that starts while it drains writes', async () => {
    const gated = gatedIncrements(driver)
    const sink = hangingSink(1)
    const logins = makeCounter('logins', { write: sink.write })
    const requests = makeCounter('requests')
    const house = createHouse({ driver: gated.driver, schema: [logins, requests], now })
    logins.add(2, WILLOW)
    await house.drain()
    clock += 3_000

    gated.close()
    requests.add(5, WILLOW)
    const stopping = watch(house.stop())
    await macrotask()
    const direct = logins.flush({ force: true })
    await vi.waitFor(() => expect(sink.waiting).toHaveLength(1))
    gated.open()
    await macrotask()
    expect(stopping.settled).toBe(false)

    sink.waiting[0]?.(new Error('sink timed out'))
    expect((await direct).error).toEqual(new Error('sink timed out'))
    const report = await stopping.promise

    expect(sink.shipped).toEqual([
      {
        id: rowId('logins', 1_788_616_987_000, 'Willow|riverside|solid'),
        bucket_ts: new Date(1_788_616_987_000),
        ...WILLOW,
        value: 2,
      },
    ])
    expect(report.metrics.logins).toMatchObject({ rows: 1 })
    expect(await logins.snapshot({ complete: false })).toEqual([])
  })

  it('answers a second call while it runs with the same final flush', async () => {
    const gated = gatedIncrements(driver)
    const shipped: Row[] = []
    const resume: (() => void)[] = []
    const requests = makeCounter('requests', {
      write: (rows: Row[]) => {
        shipped.push(...rows)
        return new Promise<void>((resolve) => {
          resume.push(resolve)
        })
      },
    })
    const house = createHouse({ driver: gated.driver, schema: [requests], now })
    requests.add(3, WILLOW)
    await house.drain()
    clock += 3_000

    // a write still in flight holds the first call in its drain
    gated.close()
    requests.add(1, REX)
    const first = watch(house.stop())
    await macrotask()
    const second = watch(house.stop())
    gated.open()
    await vi.waitFor(() => expect(resume).toHaveLength(1))
    await macrotask()
    expect(second.settled).toBe(false)

    resume[0]?.()
    const report = await first.promise
    expect(await second.promise).toBe(report)
    expect(shipped).toEqual([
      {
        id: rowId('requests', 1_788_616_987_000, 'Willow|riverside|solid'),
        bucket_ts: new Date(1_788_616_987_000),
        ...WILLOW,
        value: 3,
      },
    ])
    expect(report.metrics.requests).toMatchObject({ rows: 1 })
  })

  it('clears the timers a start() set while an earlier call was still running', async () => {
    vi.useFakeTimers()
    try {
      const sink = hangingSink(1)
      const requests = makeCounter('requests', { write: sink.write })
      const sources: string[] = []
      const views = event('views', {
        fields: { path: str() },
        stage: 'local',
        batch: { maxAge: '10s' },
        write: (_rows, context) => {
          sources.push(context.source)
          throw new Error('down')
        },
      })
      const house = createHouse({ driver, schema: [requests, views], now, onError: () => {} })
      requests.add(3, WILLOW)
      views.record({ path: '/' })
      await house.drain()
      clock += 3_000

      const direct = requests.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(sink.waiting).toHaveLength(1)
      const first = watch(house.stop())
      await vi.advanceTimersByTimeAsync(0)
      house.start()
      const second = watch(house.stop())
      expect(house.running).toBe(false)

      sink.waiting[0]?.(new Error('sink timed out'))
      await direct
      const firstReport = await first.promise
      const secondReport = await second.promise
      expect(house.running).toBe(false)
      expect(firstReport.metrics.requests).toMatchObject({ rows: 1 })
      expect(secondReport.metrics.requests).toMatchObject({ rows: 0 })

      // neither the scheduler nor a local retry calls a sink once both returned
      requests.add(1, REX)
      await house.drain()
      clock += 600_000
      const atStop = sources.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(sink.shipped.map((row) => row.value)).toEqual([3])
      expect(sources.slice(atStop)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes a final flush of its own when called again after it returned', async () => {
    const shipped: Row[] = []
    const requests = makeCounter('requests', {
      write: (rows: Row[]) => {
        shipped.push(...rows)
      },
    })
    const house = createHouse({ driver, schema: [requests], now })
    const first = await house.stop()
    requests.add(3, WILLOW)
    clock += 3_000
    const second = await house.stop()

    expect(second).not.toBe(first)
    expect(second.metrics.requests).toMatchObject({ rows: 1 })
    expect(shipped.map((row) => row.value)).toEqual([3])
  })

  it('leaves a rejecting house flush nobody awaits an unhandled rejection', async () => {
    const house = createHouse({ driver, schema: [makeCounter('requests')], now })
    const raised = await unhandledDuring(() => {
      void house.flush({ only: ['logouts'], strict: true })
    })
    expect(raised).toEqual([
      'house.flush: only names "logouts", which is not a registered metric. ' +
        'The registered metrics are [requests]',
    ])
  })

  it('raises nothing unhandled for a rejecting house flush its caller awaits', async () => {
    const house = createHouse({ driver, schema: [makeCounter('requests')], now })
    const raised = await unhandledDuring(async () => {
      await expect(house.flush({ only: ['logouts'], strict: true })).rejects.toThrow(
        'house.flush: only names "logouts"',
      )
    })
    expect(raised).toEqual([])
  })
})

/**
 * `base` with its increments held back while the gate is closed, so a test
 * can keep a write in flight for as long as it needs.
 */
function gatedIncrements(base: Driver) {
  let gate: Promise<void> = Promise.resolve()
  let release: () => void = () => {}
  const gatedDriver: Driver = {
    ...base,
    increment: async (ops) => {
      await gate
      return base.increment(ops)
    },
  }
  return {
    driver: gatedDriver,
    close(): void {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    open(): void {
      release()
    },
  }
}

/**
 * The messages of every unhandled rejection raised during `run` and the
 * macrotask after it. The runner's own listeners are set aside meanwhile, so
 * one raised on purpose does not fail the run.
 */
async function unhandledDuring(run: () => unknown): Promise<string[]> {
  const raised: string[] = []
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const listen = (reason: unknown): void => {
    raised.push(reason instanceof Error ? reason.message : String(reason))
  }
  process.on('unhandledRejection', listen)
  try {
    await run()
    await macrotask()
  } finally {
    process.off('unhandledRejection', listen)
    for (const listener of saved) process.on('unhandledRejection', listener)
  }
  return raised
}

/**
 * A sink whose first `hang` calls wait until they are failed by hand, and
 * which keeps the rows of every call after those.
 */
function hangingSink(hang: number) {
  const shipped: Row[] = []
  const waiting: ((error: Error) => void)[] = []
  const write = (rows: Row[]): Promise<void> | undefined => {
    if (waiting.length < hang) {
      return new Promise<void>((_, reject) => {
        waiting.push(reject)
      })
    }
    shipped.push(...rows)
    return undefined
  }
  return { shipped, waiting, write }
}

/** Let every pending promise callback run, and one timer turn pass. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A promise, and whether it has settled yet. */
function watch<T>(promise: Promise<T>): { promise: Promise<T>; readonly settled: boolean } {
  let settled = false
  const done = (): void => {
    settled = true
  }
  promise.then(done, done)
  return {
    promise,
    get settled() {
      return settled
    },
  }
}
