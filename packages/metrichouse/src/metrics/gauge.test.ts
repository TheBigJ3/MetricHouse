import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { json, str } from '../schema/types.js'
import { type Gauge, type GaugeAggregate, type GaugeConfig, gauge } from './gauge.js'
import type { WriteFn } from './types.js'

/** A sink that keeps nothing, for declaration tests that never ship. */
const discard: WriteFn = () => {}

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
    expect(() => make({ aggregate: [] })).toThrow(
      'bowl_level: aggregate must name at least one of last, min, max, sum, count',
    )
    expect(() => make({ aggregate: ['avg'] as unknown as GaugeAggregate[] })).toThrow(
      'bowl_level: unknown aggregate "avg"',
    )
  })

  it('runs the same declare-time checks as a counter', () => {
    expect(() => gauge('', { write: discard, resolution: '1s', flush: '1s' })).toThrow(
      new Error('gauge: name must be a non-empty string'),
    )
    expect(() => make({ resolution: '7s', flush: '1m' })).toThrow(
      new Error(
        'assertResolution: resolution 7s does not divide flush 1m evenly, and a shipment would split a bucket',
      ),
    )
    expect(() =>
      gauge('g', { write: discard, dims: { p: json() }, resolution: '1s', flush: '1s' }),
    ).toThrow(
      new Error(
        'g: dim "p" declares json(), which cannot be encoded into a series key. Put it on an event instead',
      ),
    )
  })

  it('needs no dims', () => {
    const metric = gauge('temp', { write: discard, resolution: '1s', flush: '1s' })
    expect(metric.dims).toEqual({})
  })

  it('refuses an aggregate named twice', () => {
    expect(() => make({ aggregate: ['sum', 'max', 'sum'] })).toThrow(
      new Error(
        'bowl_level: aggregate names ["sum","max","sum"], and each one may appear once, because each becomes one column of the row',
      ),
    )
  })

  it('refuses a dim named after a column it writes', () => {
    expect(() =>
      gauge('by_min', { dims: { min: str() }, resolution: '10s', flush: '1m', write: discard }),
    ).toThrow(
      new Error(
        'by_min: dim "min" is a reserved column. MetricHouse writes [id, bucket_ts, last, min, max, sum, count] on every row',
      ),
    )
  })

  it('lets a dim take the name of an aggregate it does not ship', () => {
    const metric = gauge('by_min', {
      dims: { min: str() },
      aggregate: ['max'],
      resolution: '10s',
      flush: '1m',
      write: discard,
    })
    expect(metric.rowShape().columns.map((c) => c.name)).toEqual(['id', 'bucket_ts', 'min', 'max'])
  })

  it('stays unbound when a binding is refused', () => {
    const metric = gauge('odd', { resolution: '7s', write: discard })
    expect(() => metric.bind({ driver, now, defaults: { flushMs: 60_000 } })).toThrow(
      /does not divide/,
    )
    expect(metric.isBound).toBe(false)
  })

  it('is inert until bound', () => {
    expect(() => make().set(1, B1)).toThrow(
      'bowl_level: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
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
    // a bucket with no observations is a hole on a chart, not a held value,
    // and that is the whole difference from a level
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
    expect(() => metric.set(Number.NaN, B1)).toThrow(
      'bowl_level: an observation must be a finite number, got NaN',
    )
    expect(() => metric.set(Number.POSITIVE_INFINITY, B1)).toThrow(
      'bowl_level: an observation must be a finite number, got Infinity',
    )
  })

  it('validates dims synchronously', () => {
    const metric = bound()
    expect(() => metric.set(1, { bowlId: 'b1' } as never)).toThrow('missing required dim "room"')
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
    expect(() => make().materialize(1000, 'b1|kitchen', 7)).toThrow(
      'bowl_level: expected a gauge fold but the driver returned a counter cell',
    )
  })

  it('totals every observed value when sum is not a column', async () => {
    const totals: number[] = []
    const metric = bound({
      aggregate: ['min', 'max'],
      write: (_rows: unknown, context: { total: number }) => {
        totals.push(context.total)
      },
    })
    metric.set(5, B1)
    metric.set(7, B1)
    await metric.drain()
    clock += 60_000
    await metric.flush({ force: true })
    expect(totals).toEqual([12])
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

  it('marks a dim with a default as a column every row carries', () => {
    const metric = gauge('g', {
      dims: { room: str().default('kitchen') },
      aggregate: ['last'],
      resolution: '10s',
      flush: '1m',
      write: discard,
    })
    expect(metric.rowShape().columns[2]).toEqual({ name: 'room', kind: 'str', optional: false })
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
      dims: { host: str() },
      resolution: '1m',
      flush: '1m',
      write: () => {},
    })
    const clock = 1_788_616_980_000
    wide.bind({ driver: memory({ maxSeries: Number.POSITIVE_INFINITY }), now: () => clock })
    for (let i = 0; i < 200_000; i++) wide.set(i, { host: String(i) })
    await wide.drain()

    const totals = wide.totals
    expect(await totals()).toMatchObject({ min: 0, max: 199_999, count: 200_000 })
  })
})
