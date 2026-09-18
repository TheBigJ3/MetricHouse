import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { createHouse } from '../runtime/house.js'
import { float, int, oneOf, str } from '../schema/types.js'
import { counter } from './counter.js'
import { event } from './event.js'
import { timer } from './timer.js'
import type { Row, WriteContext, WriteFn } from './types.js'

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

const makeDims = () => ({ route: str(), status: oneOf(['ok', 'error']) })
type Dims = ReturnType<typeof makeDims>

/** Wall clock — decides the bucket. */
let clock: number
/** Monotonic clock — decides the duration. */
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
  it('is inert — starting before a house has bound it is loud', () => {
    const latency = timer('latency', {
      write: discard,
      dims: makeDims(),
      resolution: '10s',
      flush: '1m',
    })
    expect(latency.isBound).toBe(false)
    expect(expectRejected(() => latency.start()).message).toMatch(/not bound to a house/)
  })

  it('refuses an empty name', () => {
    expect(
      expectRejected(() => timer(' ', { write: discard, resolution: '1s', flush: '1s' })).message,
    ).toMatch(/non-empty/)
  })

  it('reports itself as a timer, not as the gauge it is built on', () => {
    expect(bound().kind).toBe('timer')
  })

  it('refuses a dim named duration_ms, even with no record event', () => {
    expect(
      expectRejected(() =>
        timer('t', { write: discard, dims: { duration_ms: str() }, resolution: '1s', flush: '1s' }),
      ).message,
    ).toMatch(/reserved/)
  })

  it('refuses a record that names nothing, or the timer itself', () => {
    expect(
      expectRejected(() =>
        timer('t', { write: discard, resolution: '1s', flush: '1s', record: '' }),
      ).message,
    ).toMatch(/must name an event/)
    expect(
      expectRejected(() =>
        timer('t', { write: discard, resolution: '1s', flush: '1s', record: 't' }),
      ).message,
    ).toMatch(/names the timer itself/)
  })

  it('ships min/max/sum/count by default — last means nothing for a duration', () => {
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

  it('is idempotent — a second end() records nothing and returns the first duration', async () => {
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
    expect(expectRejected(() => untyped.end()).message).toMatch(/missing required dim "status"/)

    // nothing was recorded, so a corrected call still ends it
    mono += 2
    expect(span.end({ status: 'ok' })).toBe(5)
    await latency.drain()
    expect(await latency.current({ route: '/a', status: 'ok' })).toMatchObject({ count: 1 })
  })

  it('rejects an undeclared dim at start(), before any time passes', () => {
    const latency = bound()
    expect(
      expectRejected(() => latency.start({ nope: 1 } as unknown as { route: string })).message,
    ).toMatch(/unknown dim "nope"/)
  })

  it('rejects an ill-typed dim at start()', () => {
    const latency = bound()
    expect(
      expectRejected(() => latency.start({ status: 'maybe' } as unknown as { route: string }))
        .message,
    ).toMatch(/is not one of/)
  })

  it('rounds to the microsecond — anything finer is jitter', () => {
    const span = bound().start({ route: '/a', status: 'ok' })
    mono += 1.234_567_89
    expect(span.end()).toBe(1.235)
  })

  it('times overlapping spans independently — they need not nest', async () => {
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

    expect(expectRejected(() => untyped.time({ route: '/a' }, work)).message).toMatch(
      /missing required dim "status"/,
    )
    expect(work).not.toHaveBeenCalled()
  })

  it('refuses to run the work when unbound', () => {
    const latency = timer('t', { write: discard, resolution: '1s', flush: '1s' })
    const work = vi.fn(() => 1)
    expect(expectRejected(() => latency.time(work)).message).toMatch(/not bound/)
    expect(work).not.toHaveBeenCalled()
  })

  it('refuses a non-function', () => {
    const latency = timer('t', { write: discard, resolution: '1s', flush: '1s' })
    latency.bind({ driver, now })
    expect(expectRejected(() => (latency.time as (x: unknown) => unknown)('nope')).message).toMatch(
      /needs a function/,
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

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a duration of %s', (ms) => {
    const latency = bound()
    expect(
      expectRejected(() => latency.observe(ms, { route: '/a', status: 'ok' })).message,
    ).toMatch(/finite, non-negative/)
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
