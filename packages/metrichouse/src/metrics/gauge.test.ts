import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { json, str } from '../schema/types.js'
import { type Gauge, type GaugeAggregate, type GaugeConfig, gauge } from './gauge.js'
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
  return caught as Error
}

type GaugeDims = { bowlId: ReturnType<typeof str>; room: ReturnType<typeof str> }

const B1 = { bowlId: 'b1', room: 'kitchen' } as const

let clock: number
let driver: Driver
const now = () => clock

const make = (overrides: Partial<GaugeConfig<GaugeDims>> = {}) =>
  gauge('bowl_level', {
    dims: { bowlId: str(), room: str() },
    resolution: '10s',
    flush: '1m',
    ...overrides,
    write: overrides.write ?? discard,
  })

function bound(
  overrides = {},
): Gauge<{ bowlId: ReturnType<typeof str>; room: ReturnType<typeof str> }> {
  const metric = make(overrides)
  metric.bind({ driver, now })
  return metric
}

beforeEach(() => {
  clock = 1_788_616_980_000 // on a 10s boundary
  driver = memory()
})

describe('declaration', () => {
  it('exposes what it was declared with', () => {
    const metric = make()
    expect(metric.name).toBe('bowl_level')
    expect(metric.kind).toBe('gauge')
    expect(metric.resolutionMs).toBe(10_000)
    expect(metric.flushMs).toBe(60_000)
    expect(metric.graceMs).toBe(2000)
  })

  it('defaults to all five aggregates', () => {
    expect(make().aggregate).toEqual(['last', 'min', 'max', 'sum', 'count'])
  })

  it('accepts a subset', () => {
    expect(make({ aggregate: ['min', 'max'] }).aggregate).toEqual(['min', 'max'])
  })

  it('rejects an empty or unknown aggregate list', () => {
    expectRejected(() => make({ aggregate: [] }))
    expect(
      expectRejected(() => make({ aggregate: ['avg'] as unknown as GaugeAggregate[] })).message,
    ).toMatch(/avg/)
  })

  it('runs the same declare-time checks as a counter', () => {
    expectRejected(() => gauge('', { write: discard, resolution: '1s', flush: '1s' }))
    expectRejected(() => make({ resolution: '7s', flush: '1m' }))
    expectRejected(() =>
      gauge('g', { write: discard, dims: { p: json() }, resolution: '1s', flush: '1s' }),
    )
  })

  it('needs no dims', () => {
    const metric = gauge('temp', { write: discard, resolution: '1s', flush: '1s' })
    expect(metric.dims).toEqual({})
  })

  it('is inert until bound', () => {
    expect(expectRejected(() => make().set(1, B1)).message).toMatch(/bound/)
  })
})

describe('set and the fold', () => {
  it('folds observations into last, min, max, sum, count', async () => {
    const metric = bound()
    metric.set(0.82, B1)
    metric.set(0.79, B1)
    metric.set(0.91, B1)
    await metric.drain()

    expect(await metric.current(B1)).toEqual({
      last: 0.91,
      min: 0.79,
      max: 0.91,
      sum: 2.52,
      count: 3,
    })
  })

  it('records a single observation as all five', async () => {
    const metric = bound()
    metric.set(5, B1)
    await metric.drain()
    expect(await metric.current(B1)).toEqual({ last: 5, min: 5, max: 5, sum: 5, count: 1 })
  })

  it('keeps last as the most recent, not the largest', async () => {
    const metric = bound()
    metric.set(10, B1)
    metric.set(2, B1)
    await metric.drain()
    expect(await metric.current(B1)).toMatchObject({ last: 2, max: 10 })
  })

  it('handles negative values', async () => {
    const metric = bound()
    metric.set(-4, B1)
    metric.set(2, B1)
    await metric.drain()
    expect(await metric.current(B1)).toMatchObject({ min: -4, max: 2, sum: -2, count: 2 })
  })

  it('is absent, not zero, when nothing was observed', async () => {
    // a bucket with no observations is a hole on a chart, not a held value —
    // that is the whole difference from a level
    expect(await bound().current(B1)).toBeUndefined()
  })

  it('starts a fresh fold in the next bucket', async () => {
    const metric = bound()
    metric.set(9, B1)
    await metric.drain()
    clock += 10_000
    expect(await metric.current(B1)).toBeUndefined()
  })

  it('keeps series apart', async () => {
    const metric = bound()
    metric.set(1, B1)
    metric.set(100, { bowlId: 'b2', room: 'hall' })
    await metric.drain()
    expect(await metric.current(B1)).toMatchObject({ max: 1 })
  })

  it('rejects a non-finite observation', () => {
    const metric = bound()
    expectRejected(() => metric.set(Number.NaN, B1))
    expectRejected(() => metric.set(Number.POSITIVE_INFINITY, B1))
  })

  it('validates dims synchronously', () => {
    const metric = bound()
    expect(expectRejected(() => metric.set(1, { bowlId: 'b1' } as never)).message).toMatch(/room/)
  })

  it('works with no dims at all', async () => {
    const metric = gauge('temp', { write: discard, resolution: '1s', flush: '1s' })
    metric.bind({ driver, now })
    metric.set(20)
    metric.set(22)
    await metric.drain()
    expect(await metric.current()).toMatchObject({ last: 22, min: 20, max: 22, count: 2 })
  })
})

describe('totals', () => {
  it('merges every series in the open bucket', async () => {
    const metric = bound()
    metric.set(1, B1)
    metric.set(5, B1)
    metric.set(3, { bowlId: 'b2', room: 'hall' })
    await metric.drain()

    expect(await metric.totals()).toEqual({ min: 1, max: 5, sum: 9, count: 3 })
  })

  it('omits last, which cannot merge across series', async () => {
    const metric = bound()
    metric.set(1, B1)
    metric.set(3, { bowlId: 'b2', room: 'hall' })
    await metric.drain()
    expect(await metric.totals()).not.toHaveProperty('last')
  })

  it('is undefined when nothing has been observed', async () => {
    expect(await bound().totals()).toBeUndefined()
  })

  it('gives an average that is derivable but never stored', async () => {
    const metric = bound()
    for (const value of [2, 4, 6, 8]) metric.set(value, B1)
    await metric.drain()

    const totals = await metric.totals()
    expect(totals && totals.sum / totals.count).toBe(5)
    expect(totals).not.toHaveProperty('avg')
  })
})

describe('materialize', () => {
  it('emits every declared aggregate as a column', () => {
    const row = make().materialize(1000, 'b1|kitchen', {
      last: 3,
      min: 1,
      max: 5,
      sum: 9,
      count: 4,
    })
    expect(row).toMatchObject({
      bucket_ts: new Date(1000),
      bowlId: 'b1',
      room: 'kitchen',
      last: 3,
      min: 1,
      max: 5,
      sum: 9,
      count: 4,
    })
    expect(row.id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('emits only the declared subset', () => {
    const row = make({ aggregate: ['min', 'max'] }).materialize(1000, 'b1|kitchen', {
      last: 3,
      min: 1,
      max: 5,
      sum: 9,
      count: 4,
    })
    expect(Object.keys(row).sort()).toEqual(['bowlId', 'bucket_ts', 'id', 'max', 'min', 'room'])
  })

  it('refuses a counter cell', () => {
    expect(expectRejected(() => make().materialize(1000, 'b1|kitchen', 7)).message).toMatch(
      /counter cell/,
    )
  })
})

describe('rowShape', () => {
  it('is id, bucket_ts, dims, then the declared aggregates', () => {
    expect(
      make()
        .rowShape()
        .columns.map((c) => c.name),
    ).toEqual(['id', 'bucket_ts', 'bowlId', 'room', 'last', 'min', 'max', 'sum', 'count'])
  })

  it('types count as an integer and the rest as floats', () => {
    const columns = make().rowShape().columns
    expect(columns.find((c) => c.name === 'count')?.kind).toBe('int')
    expect(columns.find((c) => c.name === 'sum')?.kind).toBe('float')
  })

  it('narrows with the aggregate subset', () => {
    expect(
      make({ aggregate: ['last'] })
        .rowShape()
        .columns.map((c) => c.name),
    ).toEqual(['id', 'bucket_ts', 'bowlId', 'room', 'last'])
  })
})

describe('mixing kinds is refused at the driver', () => {
  it('will not increment a metric holding gauge cells', async () => {
    const metric = bound()
    metric.set(1, B1)
    await metric.drain()

    await expect(
      driver.increment([{ metric: 'bowl_level', bucketTs: clock, dimKey: 'b1|kitchen', delta: 1 }]),
    ).rejects.toThrow(/gauge cells/)
  })

  it('will not observe a metric holding counter cells', async () => {
    await driver.increment([{ metric: 'c', bucketTs: clock, dimKey: '', delta: 1 }])
    await expect(
      driver.observe([{ metric: 'c', bucketTs: clock, dimKey: '', value: 1 }]),
    ).rejects.toThrow(/counter cells/)
  })
})

describe('totals at high cardinality', () => {
  it('merges two hundred thousand series without overflowing the stack', async () => {
    const wide = gauge('wide', {
      dims: { id: str() },
      resolution: '1m',
      flush: '1m',
      write: () => {},
    })
    const clock = 1_788_616_980_000
    wide.bind({ driver: memory({ maxSeries: Number.POSITIVE_INFINITY }), now: () => clock })
    for (let i = 0; i < 200_000; i++) wide.set(i, { id: String(i) })
    await wide.drain()

    const totals = wide.totals
    expect(await totals()).toMatchObject({ min: 0, max: 199_999, count: 200_000 })
  })
})
