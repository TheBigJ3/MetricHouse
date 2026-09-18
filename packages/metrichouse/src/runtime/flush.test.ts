import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import type { Counter } from '../metrics/counter.js'
import { counter } from '../metrics/counter.js'
import { event } from '../metrics/event.js'
import { gauge } from '../metrics/gauge.js'
import type { Row, WriteContext, WriteFn } from '../metrics/types.js'
import { type Shape, str } from '../schema/types.js'
import { createHouse, type House } from './house.js'

/** A sink that keeps nothing — for declaration tests that never ship. */
const discard: WriteFn = () => {}

const A = { dogName: 'Willow' } as const

let clock: number
let driver: Driver
const now = () => clock

/** Past the bucket, past grace — everything written so far is claimable. */
const settle = () => {
  clock += 1000 + 2000
}

const make = (name: string, overrides = {}): Counter<{ dogName: Shape[string] }> =>
  counter(name, {
    write: discard,
    dims: { dogName: str() },
    resolution: '1s',
    flush: '5m',
    ...overrides,
  })

beforeEach(() => {
  clock = 1_788_616_987_000
  driver = memory()
})

describe('cadence', () => {
  let metric: ReturnType<typeof make>
  let house: House
  let write: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    write = vi.fn()
    metric = make('m', { write })
    house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()
    settle()
  })

  it('ships on the first call — a fresh house does not sit on data', async () => {
    const report = await house.flush()
    expect(report.metrics.m?.skipped).toBe(false)
    expect(report.metrics.m?.rows).toBe(1)
  })

  it('skips a metric whose cadence has not elapsed', async () => {
    await house.flush()
    metric.add(A)
    await house.drain()
    settle()

    const report = await house.flush()
    expect(report.metrics.m).toMatchObject({ skipped: true, reason: 'cadence' })
    expect(report.metrics.m?.nextEligibleInMs).toBeGreaterThan(0)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('an empty flush does not consume the cadence', async () => {
    // regression: with resolution '1m' the first flushes find the only bucket
    // still open. If those empty calls advanced lastFlush, the data would then
    // wait a full flush interval after it finally closed.
    const coarse = vi.fn()
    const slow = make('slow', { write: coarse, resolution: '1m', flush: '10m' })
    const own = createHouse({ driver: memory(), schema: [slow], now })
    slow.add(A)
    await own.drain()

    // three flushes while the minute-long bucket is still open
    for (const _ of [0, 1, 2]) {
      expect((await own.flush()).metrics.slow).toMatchObject({ rows: 0, skipped: false })
    }
    expect(coarse).not.toHaveBeenCalled()

    // the bucket closes and grace expires — it must ship now, not in 10 minutes
    clock += 60_000 + 2000
    expect((await own.flush()).metrics.slow).toMatchObject({ rows: 1, skipped: false })
    expect(coarse).toHaveBeenCalledTimes(1)

    // and only now does the cadence engage
    slow.add(A)
    await own.drain()
    clock += 60_000 + 2000
    expect((await own.flush()).metrics.slow).toMatchObject({ skipped: true, reason: 'cadence' })
  })

  it('ships again once the cadence has elapsed', async () => {
    await house.flush()
    metric.add(A)
    await house.drain()
    clock += 5 * 60_000

    const report = await house.flush()
    expect(report.metrics.m?.skipped).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('force ignores the cadence', async () => {
    await house.flush()
    metric.add(A)
    await house.drain()
    settle()

    const report = await house.flush({ force: true })
    expect(report.metrics.m?.skipped).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not advance the cadence when the write failed', async () => {
    const failing = vi.fn(() => {
      throw new Error('nope')
    })
    const other = make('other', { write: failing })
    const second = createHouse({ driver: memory(), schema: [other], now })
    other.add(A)
    await second.drain()
    settle()

    expect((await second.flush()).ok).toBe(false)
    // still eligible: lastFlush never moved, so no cadence skip
    const retry = await second.flush()
    expect(retry.metrics.other?.skipped).toBe(false)
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

describe('only', () => {
  it('restricts the flush to the named metrics', async () => {
    const a = make('a', { write: vi.fn() })
    const b = make('b', { write: vi.fn() })
    const house = createHouse({ driver, schema: [a, b], now })
    a.add(A)
    b.add(A)
    await house.drain()
    settle()

    const report = await house.flush({ only: ['a'] })
    expect(report.metrics.a?.skipped).toBe(false)
    expect(report.metrics.b).toMatchObject({ skipped: true, reason: 'not-selected' })
  })
})

describe('the watermark', () => {
  it('never ships the open bucket', async () => {
    const write = vi.fn()
    const metric = make('m', { write })
    const house = createHouse({ driver, schema: [metric], now })

    metric.add(A)
    await house.drain()

    // no time has passed: the bucket is open and inside grace
    const report = await house.flush()
    expect(report.metrics.m?.rows).toBe(0)
    expect(write).not.toHaveBeenCalled()

    // the data is untouched, still live
    expect(await metric.current(A)).toBe(1)
  })

  it('holds a closed bucket back until grace expires', async () => {
    const write = vi.fn()
    const metric = make('m', { write, grace: '2s' })
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()

    clock += 1000 // bucket ended, grace has not
    expect((await house.flush()).metrics.m?.rows).toBe(0)

    clock += 2000 // grace expired
    expect((await house.flush({ force: true })).metrics.m?.rows).toBe(1)
  })

  it('reports an empty flush as a success', async () => {
    const house = createHouse({ driver, schema: [make('m', { write: vi.fn() })], now })
    const report = await house.flush()
    expect(report.ok).toBe(true)
    expect(report.metrics.m).toMatchObject({ buckets: 0, rows: 0, skipped: false })
  })
})

describe('the sink', () => {
  it('ships to the sink the metric declared, and to no other', async () => {
    const own = vi.fn()
    const other = vi.fn()
    const metric = make('m', { write: own })
    const house = createHouse({ driver, schema: [metric, make('n', { write: other })], now })
    metric.add(A)
    await house.drain()
    settle()

    await house.flush()
    expect(own).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })

  it('describes the batch it is handing over', async () => {
    let seen: WriteContext | undefined
    const metric = make('m', {
      write: ((_rows: Row[], context: WriteContext) => {
        seen = context
      }) satisfies WriteFn,
    })
    const house = createHouse({ driver, schema: [metric], now })

    metric.add(A)
    clock += 1000
    metric.add(A)
    await house.drain()
    settle()

    await house.flush()
    expect(seen).toEqual({
      metric: 'm',
      kind: 'counter',
      bucketFrom: 1_788_616_987_000,
      bucketTo: 1_788_616_989_000,
      total: 2,
      attempt: 1,
      source: 'flush',
    })
  })

  it('carries the metric total, so a sink can ignore the dim breakdown', async () => {
    let seen: WriteContext | undefined
    let shipped: Row[] = []
    const metric = counter('walks', {
      dims: { breed: str() },
      resolution: '1s',
      flush: '5m',
      write: (rows: Row[], context: WriteContext) => {
        shipped = rows
        seen = context
      },
    })
    const house = createHouse({ driver, schema: [metric], now })

    metric.add({ breed: 'corgi' })
    metric.add({ breed: 'corgi' })
    metric.add(3, { breed: 'lab' })
    await house.drain()
    settle()

    await house.flush()
    // the breakdown is there for whoever wants it...
    expect(shipped.map((r) => [r.breed, r.value]).sort()).toEqual([
      ['corgi', 2],
      ['lab', 3],
    ])
    // ...and the headline number is there for whoever does not
    expect(seen?.total).toBe(5)
  })
})

describe('failure and retry', () => {
  it('releases the claim so the data survives', async () => {
    const metric = make('m', {
      write: () => {
        throw new Error('clickhouse is down')
      },
    })
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(4, A)
    await house.drain()
    settle()

    const report = await house.flush()
    expect(report.ok).toBe(false)
    expect(report.metrics.m?.error).toBeInstanceOf(Error)

    // released, not deleted — it is claimable again
    const rows = await driver.readBuckets({ metric: 'm' })
    expect(rows).toEqual([{ bucketTs: 1_788_616_987_000, dimKey: 'Willow', value: 4 }])
  })

  it('increments attempt on the retry, and resets it after a success', async () => {
    const seen: number[] = []
    let failures = 2
    const metric = make('m', {
      write: (_rows: Row[], context: WriteContext) => {
        seen.push(context.attempt)
        if (failures-- > 0) throw new Error('still down')
      },
    })
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()
    settle()

    await house.flush()
    await house.flush()
    await house.flush()
    expect(seen).toEqual([1, 2, 3])

    metric.add(A)
    await house.drain()
    clock += 5 * 60_000
    await house.flush()
    expect(seen.at(-1)).toBe(1)
  })

  it('does not stop other metrics from shipping', async () => {
    const good = vi.fn()
    const a = make('a', {
      write: () => {
        throw new Error('nope')
      },
    })
    const b = make('b', { write: good })
    const house = createHouse({ driver, schema: [a, b], now })
    a.add(A)
    b.add(A)
    await house.drain()
    settle()

    const report = await house.flush()
    expect(report.ok).toBe(false)
    expect(report.metrics.a?.error).toBeDefined()
    expect(report.metrics.b?.error).toBeUndefined()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('propagates a rejected promise from the sink', async () => {
    const metric = make('m', { write: () => Promise.reject(new Error('async failure')) })
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()
    settle()

    expect((await house.flush()).ok).toBe(false)
    expect(await driver.readBuckets({ metric: 'm' })).toHaveLength(1)
  })
})

describe('the report', () => {
  it('carries a duration', async () => {
    const house = createHouse({ driver, schema: [make('m', { write: vi.fn() })], now })
    expect((await house.flush()).durationMs).toBe(0) // the clock is frozen
  })

  it('throwIfFailed is a no-op on success', async () => {
    const house = createHouse({ driver, schema: [make('m', { write: vi.fn() })], now })
    const report = await house.flush()
    expect(() => report.throwIfFailed()).not.toThrow()
  })

  it('throwIfFailed names the metrics that failed', async () => {
    const metric = make('m', {
      write: () => {
        throw new Error('nope')
      },
    })
    const house = createHouse({ driver, schema: [metric], now })
    metric.add(A)
    await house.drain()
    settle()

    const report = await house.flush()
    expect(() => report.throwIfFailed()).toThrow(/m/)
  })
})

describe('gauge', () => {
  it('ships folded aggregates and a total of every observation', async () => {
    let shipped: Row[] = []
    let seen: WriteContext | undefined
    const bowl = gauge('bowl_level', {
      dims: { bowlId: str() },
      resolution: '1s',
      flush: '5m',
      write: (rows: Row[], context: WriteContext) => {
        shipped = rows
        seen = context
      },
    })
    const house = createHouse({ driver, schema: [bowl], now })

    bowl.set(0.82, { bowlId: 'b1' })
    bowl.set(0.79, { bowlId: 'b1' })
    bowl.set(0.91, { bowlId: 'b1' })
    bowl.set(0.5, { bowlId: 'b2' })
    await house.drain()
    settle()

    await house.flush()

    expect(shipped).toHaveLength(2)
    expect(shipped.find((r) => r.bowlId === 'b1')).toMatchObject({
      last: 0.91,
      min: 0.79,
      max: 0.91,
      count: 3,
    })
    // sum of every observed value across both series
    expect(seen?.total).toBeCloseTo(3.02)
    expect(seen?.kind).toBe('gauge')
  })

  it('survives a failed write with its fold intact', async () => {
    let failNext = true
    const bowl = gauge('bowl_level', {
      resolution: '1s',
      flush: '5m',
      write: () => {
        if (failNext) {
          failNext = false
          throw new Error('down')
        }
      },
    })
    const house = createHouse({ driver, schema: [bowl], now })

    bowl.set(2)
    bowl.set(6)
    await house.drain()
    settle()

    expect((await house.flush()).ok).toBe(false)
    // released — the fold is unchanged, not re-folded or doubled
    const rows = await driver.readBuckets({ metric: 'bowl_level' })
    expect(rows[0]?.value).toEqual({ last: 6, min: 2, max: 6, sum: 8, count: 2 })
  })

  it('merges a fold with observations that landed while it was claimed', async () => {
    const bowl = gauge('bowl_level', { resolution: '1s', flush: '5m', write: () => {} })
    createHouse({ driver, schema: [bowl], now })

    bowl.set(4)
    await bowl.drain()

    const claim = await driver.claim('bowl_level', clock + 1)
    bowl.set(1) // lands in the bucket while it is claimed
    await bowl.drain()
    await driver.release(claim)

    // min from the claim, last from the newer write, count from both
    expect((await driver.readBuckets({ metric: 'bowl_level' }))[0]?.value).toEqual({
      last: 1,
      min: 1,
      max: 4,
      sum: 5,
      count: 2,
    })
  })
})

describe('mixed kinds', () => {
  it('ships counters, gauges and events from one flush', async () => {
    // the point of the kind-agnostic lifecycle: the flush engine runs the same
    // four calls against three different storage models
    const counterWrite = vi.fn()
    const gaugeWrite = vi.fn()
    const eventWrite = vi.fn()

    const walks = make('walks', { write: counterWrite })
    const bowl = gauge('bowl_level', {
      dims: { dogName: str() },
      resolution: '1s',
      flush: '5m',
      write: gaugeWrite,
    })
    const started = event('walk_started', {
      fields: { dogName: str(), requestId: str() },
      write: eventWrite,
    })

    const house = createHouse({ driver, schema: [walks, bowl, started], now })

    walks.add(A)
    bowl.set(0.6, A)
    started.record({ dogName: 'Willow', requestId: 'req_1' })
    await house.drain()
    settle()

    const report = await house.flush()
    expect(report.ok).toBe(true)
    expect(report.metrics.walks).toMatchObject({ rows: 1, buckets: 1 })
    expect(report.metrics.bowl_level).toMatchObject({ rows: 1, buckets: 1 })
    // an event has no buckets to report, and inventing one would be a lie
    expect(report.metrics.walk_started).toMatchObject({ rows: 1, buckets: 0 })

    for (const write of [counterWrite, gaugeWrite, eventWrite]) {
      expect(write).toHaveBeenCalledTimes(1)
    }
  })

  it('an event ships without waiting out a bucket, a counter does not', async () => {
    const counterWrite = vi.fn()
    const eventWrite = vi.fn()

    const walks = make('walks', { write: counterWrite })
    const started = event('walk_started', { fields: { a: str() }, write: eventWrite })
    const house = createHouse({ driver, schema: [walks, started], now })

    walks.add(A)
    started.record({ a: 'x' })
    await house.drain()

    // no settle(): the counter's bucket is still open, the record is not
    const report = await house.flush()
    expect(report.metrics.walks).toMatchObject({ rows: 0 })
    expect(report.metrics.walk_started).toMatchObject({ rows: 1 })
  })

  it('one failing metric does not stop the others', async () => {
    const good = vi.fn()
    const bad = vi.fn().mockRejectedValue(new Error('sink down'))

    const ok = make('ok', { write: good })
    const broken = event('broken', { fields: { a: str() }, write: bad })
    const house = createHouse({ driver, schema: [ok, broken], now })

    ok.add(A)
    broken.record({ a: 'x' })
    await house.drain()
    settle()

    const report = await house.flush()
    expect(report.ok).toBe(false)
    expect(report.metrics.ok).toMatchObject({ rows: 1 })
    expect(report.metrics.ok?.error).toBeUndefined()
    expect(report.metrics.broken?.error).toBeInstanceOf(Error)
    expect(() => report.throwIfFailed()).toThrow(/broken/)
  })
})

// ---------------------------------------------------------------------------
// the metric as the unit — no house in sight
// ---------------------------------------------------------------------------

describe('metric.flush()', () => {
  it('ships to its own sink with no house involved in the flush', async () => {
    const write = vi.fn()
    const metric = make('m', { write })
    metric.bind({ driver, now })

    metric.add(A)
    await metric.drain()
    settle()

    const report = await metric.flush()
    expect(report).toMatchObject({ rows: 1, buckets: 1, skipped: false })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[1]).toMatchObject({ metric: 'm', source: 'flush' })
  })

  it('honours its own cadence, and says how long until it will not', async () => {
    const write = vi.fn()
    const metric = make('m', { write, flush: '5m' })
    metric.bind({ driver, now })

    metric.add(A)
    await metric.drain()
    settle()
    await metric.flush() // the one that actually ships

    metric.add(A)
    await metric.drain()
    settle()

    const report = await metric.flush()
    expect(report).toMatchObject({ skipped: true, reason: 'cadence', rows: 0 })
    expect(report.nextEligibleInMs).toBe(300_000 - 3_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('ships anyway under force', async () => {
    const write = vi.fn()
    const metric = make('m', { write })
    metric.bind({ driver, now })

    metric.add(A)
    await metric.drain()
    settle()
    await metric.flush()

    metric.add(A)
    await metric.drain()
    settle()

    expect((await metric.flush({ force: true })).rows).toBe(1)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('counts its own attempts across a failing sink, without a house to hold them', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('sink down')).mockResolvedValue(undefined)
    const metric = make('m', { write })
    metric.bind({ driver, now })

    metric.add(A)
    await metric.drain()
    settle()

    const failed = await metric.flush()
    expect(failed.error).toBeInstanceOf(Error)
    expect(write.mock.calls[0]?.[1]).toMatchObject({ attempt: 1 })

    // released, so the same rows come back — as a second attempt
    const retried = await metric.flush()
    expect(retried.rows).toBe(1)
    expect(write.mock.calls[1]?.[1]).toMatchObject({ attempt: 2 })
  })

  it('refuses to flush before it is bound', async () => {
    await expect(make('m').flush()).rejects.toThrow(/not bound to a house/)
  })

  it("keeps its cadence state to itself — one metric flushing does not spend another's", async () => {
    const a = vi.fn()
    const b = vi.fn()
    const first = make('a', { write: a })
    const second = make('b', { write: b })
    const house = createHouse({ driver, schema: [first, second], now })

    first.add(A)
    second.add(A)
    await house.drain()
    settle()

    await first.flush()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()

    await second.flush()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
