import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { createHouse } from '../runtime/house.js'
import { float, int, oneOf, str } from '../schema/types.js'
import { counter } from './counter.js'
import { event } from './event.js'
import { timer } from './timer.js'
import type { Row, WriteContext, WriteFn } from './types.js'

/** A sink that keeps nothing, for declaration tests that never ship. */
const discard: WriteFn = () => {}

const makeDims = () => ({ route: str(), status: oneOf(['ok', 'error']) })
type Dims = ReturnType<typeof makeDims>

/** Wall clock, which decides the bucket. */
let clock: number
/** Monotonic clock, which decides the duration. */
let mono: number
let driver: Driver
const now = () => clock

function bound(overrides: Partial<Parameters<typeof timer<Dims>>[1]> = {}) {
  const metric = timer('latency', {
    dims: makeDims(),
    resolution: '10s',
    flush: '1m',
    ...overrides,
    write: overrides.write ?? discard,
  })
  metric.bind({ driver, now })
  return metric
}

beforeEach(() => {
  clock = 1_788_616_987_000
  mono = 5_000
  driver = memory()
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('declaration', () => {
  it('is inert, so starting before a house has bound it is loud', () => {
    const latency = timer('latency', {
      write: discard,
      dims: makeDims(),
      resolution: '10s',
      flush: '1m',
    })
    expect(latency.isBound).toBe(false)
    expect(() => latency.start()).toThrow(
      'latency: not bound to a house. Pass it to createHouse({ schema }) before timing',
    )
  })

  it('refuses an empty name', () => {
    expect(() => timer(' ', { write: discard, resolution: '1s', flush: '1s' })).toThrow(
      'timer: name must be a non-empty string',
    )
  })

  it('stays unbound when a binding is refused', () => {
    const odd = timer('odd', { resolution: '7s', write: discard })
    expect(() => odd.bind({ driver, now, defaults: { flushMs: 60_000 } })).toThrow(
      /does not divide/,
    )
    expect(odd.isBound).toBe(false)
    odd.bind({ driver, now, defaults: { flushMs: 7_000 } })
    expect(odd.isBound).toBe(true)
  })

  it('tells the sink every duration added up when sum is not a column', async () => {
    const totals: number[] = []
    const latency = bound({
      aggregate: ['min', 'max', 'count'],
      write: (_rows: Row[], context: WriteContext) => {
        totals.push(context.total)
      },
    })
    latency.observe(10, { route: '/a', status: 'ok' })
    latency.observe(30, { route: '/a', status: 'ok' })
    await latency.drain()
    clock += 60_000
    await latency.flush({ force: true })
    expect(totals).toEqual([40])
  })

  it('reports itself as a timer, not as the gauge it is built on', () => {
    expect(bound().kind).toBe('timer')
  })

  it('refuses a dim named duration_ms, even with no record event', () => {
    expect(() =>
      timer('t', { write: discard, dims: { duration_ms: str() }, resolution: '1s', flush: '1s' }),
    ).toThrow(
      't: dim "duration_ms" is reserved, because it is the field a timing carries onto a record event',
    )
  })

  it('refuses a record that names nothing, or the timer itself', () => {
    expect(() => timer('t', { write: discard, resolution: '1s', flush: '1s', record: '' })).toThrow(
      't: record must name an event',
    )
    expect(() =>
      timer('t', { write: discard, resolution: '1s', flush: '1s', record: 't' }),
    ).toThrow('t: record names the timer itself, and it must name an event')
  })

  it('ships min/max/sum/count by default, since last means nothing for a duration', () => {
    expect(bound().aggregate).toEqual(['min', 'max', 'sum', 'count'])
  })

  it('ships last when asked', () => {
    expect(bound({ aggregate: ['last', 'max'] }).aggregate).toEqual(['last', 'max'])
  })

  it('keeps every check the gauge makes', () => {
    expect(() => timer('t', { write: discard, resolution: '10s', flush: '15s' })).toThrow(
      /divide flush/,
    )
  })
})

describe('start / end', () => {
  it('records the elapsed time into the open bucket, and returns it', async () => {
    const latency = bound()
    const span = latency.start({ route: '/checkout' })
    mono += 42.5
    expect(span.end({ status: 'ok' })).toBe(42.5)
    await latency.drain()

    expect(await latency.current({ route: '/checkout', status: 'ok' })).toMatchObject({
      min: 42.5,
      max: 42.5,
      sum: 42.5,
      count: 1,
    })
  })

  it('reports elapsed() without ending, and freezes it once ended', () => {
    const span = bound().start({ route: '/a', status: 'ok' })
    mono += 10
    expect(span.elapsed()).toBe(10)
    mono += 5
    span.end()
    mono += 1_000
    expect(span.elapsed()).toBe(15)
  })

  it('takes at end() the dims start() did not know', async () => {
    const latency = bound()
    const span = latency.start({ route: '/checkout' })
    span.end({ status: 'error' })
    await latency.drain()

    expect(await latency.current({ route: '/checkout', status: 'error' })).toMatchObject({
      count: 1,
    })
  })

  it('lets a dim given at end() override one bound at start()', async () => {
    const latency = bound()
    latency.start({ route: '/guess', status: 'ok' }).end({ route: '/actual' })
    await latency.drain()

    expect(await latency.current({ route: '/actual', status: 'ok' })).toMatchObject({ count: 1 })
    expect(await latency.current({ route: '/guess', status: 'ok' })).toBeUndefined()
  })

  it('is idempotent, so a second end() records nothing and returns the first duration', async () => {
    // end() lives in catch and finally blocks, where a throw would replace the
    // error being handled
    const latency = bound()
    const span = latency.start({ route: '/a', status: 'ok' })
    mono += 7
    expect(span.end()).toBe(7)
    mono += 100
    expect(span.end()).toBe(7)
    await latency.drain()

    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ count: 1 })
  })

  it('throws when the merged dims are incomplete, and leaves the handle open', async () => {
    const latency = bound()
    const span = latency.start({ route: '/a' })
    mono += 3

    const untyped = span as unknown as { end(dims?: object): number }
    expect(() => untyped.end()).toThrow(new Error('latency: missing required dim "status"'))

    // nothing was recorded, so a corrected call still ends it
    mono += 2
    expect(span.end({ status: 'ok' })).toBe(5)
    await latency.drain()
    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ count: 1 })
  })

  it('rejects an undeclared dim at start(), before any time passes', () => {
    const latency = bound()
    expect(() => latency.start({ nope: 1 } as unknown as { route: string })).toThrow(
      new Error('latency: unknown dim "nope". The declared dims are [route, status]'),
    )
  })

  it('rejects an ill-typed dim at start()', () => {
    const latency = bound()
    expect(() => latency.start({ status: 'maybe' } as unknown as { route: string })).toThrow(
      'status: "maybe" is not one of ["ok", "error"]',
    )
  })

  it('rounds to the microsecond, since anything finer is jitter', () => {
    const span = bound().start({ route: '/a', status: 'ok' })
    mono += 1.234_567_89
    expect(span.end()).toBe(1.235)
  })

  it('times overlapping spans independently, since they need not nest', async () => {
    // the case a LIFO stack gets wrong: a ends before b, though b started last
    const latency = bound()
    const a = latency.start({ route: '/a', status: 'ok' })
    mono += 10
    const b = latency.start({ route: '/b', status: 'ok' })
    mono += 5
    expect(a.end()).toBe(15)
    mono += 20
    expect(b.end()).toBe(25)
  })

  it('lands in the bucket where the timing completed, not where it began', async () => {
    const latency = bound()
    const startedAt = clock
    const span = latency.start({ route: '/slow', status: 'ok' })

    clock += 10_000 // into the next 10s bucket
    mono += 10_000
    span.end()
    await latency.drain()

    expect(await latency.current({ route: '/slow', status: 'ok' })).toMatchObject({
      max: 10_000,
    })
    clock = startedAt
    expect(await latency.current({ route: '/slow', status: 'ok' })).toBeUndefined()
  })
})

describe('time', () => {
  it('times a sync function and returns its value', async () => {
    const latency = bound()
    const value = latency.time({ route: '/a', status: 'ok' }, () => {
      mono += 8
      return 'result'
    })
    expect(value).toBe('result')
    await latency.drain()

    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ sum: 8 })
  })

  it('times an async function to when it settles, not to when it returned', async () => {
    const latency = bound()
    const pending = latency.time({ route: '/a', status: 'ok' }, async () => {
      await Promise.resolve()
      mono += 30
      return 'later'
    })

    expect(pending).toBeInstanceOf(Promise)
    expect(await pending).toBe('later')
    await latency.drain()
    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ sum: 30 })
  })

  it('records a sync throw, then rethrows the same error', async () => {
    const latency = bound()
    const boom = new Error('boom')
    let caught: unknown
    try {
      latency.time({ route: '/a', status: 'error' }, () => {
        mono += 4
        throw boom
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(boom)
    await latency.drain()
    expect(await latency.current({ route: '/a', status: 'error' })).toMatchObject({ sum: 4 })
  })

  it('records an async rejection, then rejects with the same error', async () => {
    // a request that times out is the latency most worth seeing
    const latency = bound()
    const boom = new Error('timeout')
    const pending = latency.time({ route: '/a', status: 'error' }, async () => {
      mono += 30_000
      throw boom
    })

    await expect(pending).rejects.toBe(boom)
    await latency.drain()
    expect(await latency.current({ route: '/a', status: 'error' })).toMatchObject({
      max: 30_000,
    })
  })

  it('refuses incomplete dims before the work runs, never after', () => {
    const latency = bound()
    const work = vi.fn(() => 1)
    const untyped = latency as unknown as { time(dims: object, fn: () => number): number }

    expect(() => untyped.time({ route: '/a' }, work)).toThrow(
      new Error('latency: missing required dim "status"'),
    )
    expect(work).not.toHaveBeenCalled()
  })

  it('refuses to run the work when unbound', () => {
    const latency = timer('t', { write: discard, resolution: '1s', flush: '1s' })
    const work = vi.fn(() => 1)
    expect(() => latency.time(work)).toThrow(
      't: not bound to a house. Pass it to createHouse({ schema }) before timing',
    )
    expect(work).not.toHaveBeenCalled()
  })

  it('refuses a non-function', () => {
    const latency = timer('t', { write: discard, resolution: '1s', flush: '1s' })
    latency.bind({ driver, now })
    expect(() => (latency.time as (x: unknown) => unknown)('nope')).toThrow(
      't: time() needs a function to time',
    )
  })

  it('needs no dims on a dimensionless timer', async () => {
    const job = timer('job', { write: discard, resolution: '1s', flush: '1s' })
    job.bind({ driver, now })
    job.time(() => {
      mono += 2
    })
    await job.drain()
    expect(await job.current()).toMatchObject({ sum: 2, count: 1 })
  })
})

describe('observe', () => {
  it('records a duration measured elsewhere', async () => {
    const latency = bound()
    latency.observe(12.5, { route: '/db', status: 'ok' })
    latency.observe(7.5, { route: '/db', status: 'ok' })
    await latency.drain()

    expect(await latency.current({ route: '/db', status: 'ok' })).toMatchObject({
      min: 7.5,
      max: 12.5,
      sum: 20,
      count: 2,
    })
  })

  it('names the type of a duration that is not a number', () => {
    const latency = bound()
    expect(() => latency.observe('5' as never, { route: '/a', status: 'ok' })).toThrow(
      'latency: a duration must be a finite, non-negative number, got "5"',
    )
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a duration of %s', (ms) => {
    const latency = bound()
    expect(() => latency.observe(ms, { route: '/a', status: 'ok' })).toThrow(
      `latency: a duration must be a finite, non-negative number, got ${ms}`,
    )
  })
})

describe('record', () => {
  function house(extra: Parameters<typeof createHouse>[0]['schema'] & object) {
    const errors: unknown[] = []
    const latency = timer('latency', {
      write: discard,
      dims: makeDims(),
      resolution: '10s',
      flush: '1m',
      record: 'latency_events',
    })
    const h = createHouse({
      driver,
      now,
      schema: [latency, ...(extra as never[])],
      onError: (error) => errors.push(error),
    })
    return { latency, house: h, errors }
  }

  const matchingEvent = () =>
    event('latency_events', { write: discard, fields: { ...makeDims(), duration_ms: float() } })

  it('reports a durable event that could not stage the timing to onError', async () => {
    const latency = timer('latency', {
      write: discard,
      dims: makeDims(),
      resolution: '10s',
      flush: '1m',
      record: 'latency_events',
    })
    const events = event('latency_events', {
      write: discard,
      fields: { ...makeDims(), duration_ms: float() },
      durability: 'durable',
    })
    const errors: unknown[] = []
    createHouse({
      driver: {
        ...memory(),
        append: async () => {
          throw new Error('redis down')
        },
      },
      now,
      schema: [latency, events],
      onError: (error) => errors.push(error),
    })

    latency.observe(5, { route: '/walks', status: 'ok' })
    await vi.waitFor(() =>
      expect(errors.map((error) => (error as Error).message)).toEqual([
        'latency_events: the driver did not confirm the record, which may still be staged ' +
          'and ship. redis down',
      ]),
    )
  })

  it('names a dim the event lacks even when the name is on every object', async () => {
    const latency = timer('latency', {
      write: discard,
      dims: { constructor: str() },
      resolution: '10s',
      flush: '1m',
      record: 'latency_events',
    })
    const events = event('latency_events', { write: discard, fields: { duration_ms: float() } })
    const errors: unknown[] = []
    createHouse({
      driver,
      now,
      schema: [latency, events],
      onError: (error) => errors.push(error),
    })

    latency.observe(5, { constructor: 'x' })
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'latency: record target "latency_events" does not declare [constructor], so spread ' +
        "the timer's dims into its fields",
    ])
  })

  it('records every timing to the event, with its dims and duration', async () => {
    const events = matchingEvent()
    const { latency, house: h, errors } = house([events])

    const span = latency.start({ route: '/checkout' })
    mono += 120.25
    span.end({ status: 'ok' })
    latency.observe(5, { route: '/health', status: 'ok' })
    await h.drain()

    expect(errors).toEqual([])
    expect(await events.peek()).toMatchObject([
      { route: '/checkout', status: 'ok', duration_ms: 120.25 },
      { route: '/health', status: 'ok', duration_ms: 5 },
    ])
  })

  it('stamps the event row when the timing completed', async () => {
    const events = matchingEvent()
    const { latency, house: h } = house([events])

    const span = latency.start({ route: '/a', status: 'ok' })
    clock += 4_000
    span.end()
    await h.drain()

    expect((await events.peek())[0]?.ts).toEqual(new Date(clock))
  })

  it('keeps the gauge exact when the event samples', async () => {
    // the same split derive makes: exact aggregate, sampled detail
    const events = event('latency_events', {
      write: discard,
      fields: { ...makeDims(), duration_ms: float() },
      sample: 0,
    })
    const { latency, house: h } = house([events])

    for (let i = 0; i < 3; i++) latency.observe(10, { route: '/a', status: 'ok' })
    await h.drain()

    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ count: 3 })
    expect(await events.pending()).toBe(0)
  })

  it('does not care which was registered first', async () => {
    const events = matchingEvent()
    const latency = timer('latency', {
      write: discard,
      dims: makeDims(),
      resolution: '10s',
      flush: '1m',
      record: 'latency_events',
    })
    const h = createHouse({ driver, now, schema: [events, latency] })

    latency.observe(1, { route: '/a', status: 'ok' })
    await h.drain()
    expect(await events.pending()).toBe(1)
  })

  describe('a broken pairing is reported, and the gauge still records', () => {
    async function expectReported(extra: unknown[], message: RegExp) {
      const { latency, house: h, errors } = house(extra as never)
      latency.observe(9, { route: '/a', status: 'ok' })
      await h.drain()

      expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ count: 1 })
      expect(errors).toHaveLength(1)
      expect((errors[0] as Error).message).toMatch(message)
    }

    it('when no metric has that name', async () => {
      await expectReported([], /no metric in this house declares/)
    })

    it('when the target is not an event', async () => {
      await expectReported(
        [counter('latency_events', { write: discard, resolution: '1s', flush: '1s' })],
        /is a counter/,
      )
    })

    it('when duration_ms is missing', async () => {
      await expectReported(
        [event('latency_events', { write: discard, fields: makeDims() })],
        /must declare duration_ms: float\(\)/,
      )
    })

    it('when duration_ms is an int, which would reject a fractional duration', async () => {
      await expectReported(
        [
          event('latency_events', {
            write: discard,
            fields: { ...makeDims(), duration_ms: int() },
          }),
        ],
        /must declare duration_ms: float\(\)/,
      )
    })

    it("when the event lacks one of the timer's dims", async () => {
      await expectReported(
        [
          event('latency_events', {
            write: discard,
            fields: { route: str(), duration_ms: float() },
          }),
        ],
        /does not declare \[status\]/,
      )
    })

    it('when the event requires a field a timing cannot supply', async () => {
      await expectReported(
        [
          event('latency_events', {
            write: discard,
            fields: { ...makeDims(), duration_ms: float(), userId: str() },
          }),
        ],
        /requires \[userId\]/,
      )
    })
  })
})

describe('in a house', () => {
  it('flushes gauge rows, reporting itself as a timer', async () => {
    const write = vi.fn<(rows: Row[], context: WriteContext) => Promise<void>>(async () => {})
    const latency = timer('latency', {
      dims: makeDims(),
      resolution: '10s',
      flush: '1m',
      write,
    })
    const h = createHouse({ driver, now, schema: { latency } })

    latency.observe(100, { route: '/a', status: 'ok' })
    latency.observe(300, { route: '/a', status: 'ok' })
    latency.observe(50, { route: '/b', status: 'error' })
    await h.drain()

    clock += 60_000
    const report = await h.flush()
    expect(report.ok).toBe(true)

    const [rows, context] = write.mock.calls[0] as [Row[], WriteContext]
    expect(context).toMatchObject({ metric: 'latency', kind: 'timer', total: 450 })
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.route === '/a')).toMatchObject({
      min: 100,
      max: 300,
      sum: 400,
      count: 2,
    })
    expect(rows[0]).not.toHaveProperty('last')
  })

  it('describes its row as a gauge row, without last', () => {
    expect(
      bound()
        .rowShape()
        .columns.map((column) => column.name),
    ).toEqual(['id', 'bucket_ts', 'route', 'status', 'min', 'max', 'sum', 'count'])
  })
})

describe('end() with a dim it leaves undefined', () => {
  it('keeps the value start() bound', async () => {
    const rows: Row[] = []
    const t = timer('op', {
      dims: { route: str(), status: int() },
      resolution: '1s',
      flush: '1m',
      write: (batch) => {
        rows.push(...batch)
      },
    })
    let at = 1_788_616_987_000
    createHouse({ driver: memory(), schema: [t], now: () => at })

    const handle = t.start({ route: '/a', status: 200 })
    expect(() => handle.end({ status: undefined } as never)).not.toThrow()
    await t.drain()
    at += 5_000
    await t.flush()
    expect(rows[0]).toMatchObject({ route: '/a', status: 200 })
  })
})

describe('observe() precision', () => {
  it('rounds away digits below a microsecond, as end() does', async () => {
    const rows: Row[] = []
    const t = timer('op', {
      resolution: '1s',
      flush: '1m',
      write: (batch) => {
        rows.push(...batch)
      },
    })
    let at = 1_788_616_987_000
    createHouse({ driver: memory(), schema: [t], now: () => at })
    t.observe(1.23456789)
    at += 5_000
    await t.flush()
    expect(rows[0]?.sum).toBe(1.235)
  })

  it('returns a Promise of what fn resolved to, settled once the timing is recorded', async () => {
    const latency = bound()
    const work = Promise.resolve([1, 2, 3])
    const returned = latency.time({ route: '/a', status: 'ok' }, () => work)
    expect(returned).not.toBe(work)
    expect(await returned).toEqual([1, 2, 3])
    await latency.drain()
    expect((await latency.current({ route: '/a', status: 'ok' }))?.count).toBe(1)
  })

  it('subscribes to a thenable that is not a Promise exactly once', async () => {
    // the shape of a query builder, which runs its query each time `then` is called
    const latency = bound()
    let runs = 0
    const query = {
      where: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a thenable is the point
      then(resolve: (rows: number[]) => void) {
        runs += 1
        resolve([1, 2, 3])
      },
    }
    const returned = latency.time({ route: '/a', status: 'ok' }, () => query)
    expect(returned).toBeInstanceOf(Promise)
    expect(await returned).toEqual([1, 2, 3])
    expect(runs).toBe(1)
  })

  it('types a thenable that is not a Promise as a Promise of its result', () => {
    const latency = bound()
    const query = {
      where: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a thenable is the point
      then(resolve: (rows: number[]) => void) {
        resolve([1, 2, 3])
      },
    }
    const returned = latency.time({ route: '/a', status: 'ok' }, () => query)
    const typed: Promise<number[]> = returned
    void typed
    // @ts-expect-error the builder is not what comes back, so neither are its methods
    expect(returned.where).toBeUndefined()
  })

  it('records a finite duration too large to scale to microseconds', async () => {
    const latency = bound()
    latency.observe(1e306, { route: '/a', status: 'ok' })
    await latency.drain()
    expect((await latency.current({ route: '/a', status: 'ok' }))?.max).toBe(1e306)
  })
})

describe('dims a timer shares with the event it records to', () => {
  it.each(['ts', '_ingested_at', '_sample_rate'])(
    'refuses a dim named %s, even with no record event',
    (reserved) => {
      expect(() =>
        timer('t', { write: discard, dims: { [reserved]: str() }, resolution: '1s', flush: '1s' }),
      ).toThrow(
        `t: dim "${reserved}" is reserved, because a record event writes a column of that name ` +
          'on every row',
      )
    },
  )
})

describe('dims the caller still holds', () => {
  it('copies what start() bound, so changing the object afterwards moves nothing', async () => {
    const latency = bound()
    const dims: { route: string; status: 'ok' | 'error' } = { route: '/a', status: 'ok' }
    const span = latency.start(dims)
    dims.route = '/b'
    mono += 5
    span.end()
    await latency.drain()

    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ sum: 5 })
    expect(await latency.current({ route: '/b', status: 'ok' })).toBeUndefined()
  })

  it('copies what time() was given, so the work changing it moves nothing', async () => {
    const latency = bound()
    const dims: { route: string; status: 'ok' | 'error' } = { route: '/a', status: 'ok' }
    latency.time(dims, () => {
      dims.status = 'error'
      mono += 3
    })
    await latency.drain()

    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ sum: 3 })
  })

  it('keeps a dim a Partial may not hold required at end()', () => {
    const latency = bound()
    const maybe: Partial<{ route: string; status: 'ok' | 'error' }> = { route: '/a' }
    const span = latency.start(maybe)
    // @ts-expect-error status may still be missing, so end() has to pass it
    expect(() => span.end()).toThrow('missing required dim "status"')
    expect(span.end({ route: '/a', status: 'ok' })).toBe(0)
  })
})

describe('time() with a Promise', () => {
  it('leaves a rejection nobody awaits to surface as an unhandled rejection', async () => {
    const latency = bound()
    const boom = new Error('timeout')

    const theirs = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    const unhandled: unknown[] = []
    const mine = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', mine)
    try {
      latency.time({ route: '/a', status: 'error' }, async () => {
        throw boom
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', mine)
      for (const listener of theirs) process.on('unhandledRejection', listener)
    }

    expect(unhandled).toEqual([boom])
    await latency.drain()
    expect((await latency.current({ route: '/a', status: 'error' }))?.count).toBe(1)
  })
})
