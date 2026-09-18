import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { createHouse, type House } from '../runtime/house.js'
import { int, json, str, ts } from '../schema/types.js'
import { counter } from './counter.js'
import { type Event, event } from './event.js'
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

const makeFields = () => ({
  dogName: str(),
  walkerId: str(),
  requestId: str(),
  routeMeters: int().optional(),
  weather: json<{ tempC: number; rain: boolean }>().optional(),
})
type Fields = ReturnType<typeof makeFields>

const WALK = { dogName: 'Willow', walkerId: 'u_42', requestId: 'req_1' } as const

let clock: number
let driver: Driver
const now = () => clock

function make(overrides: Partial<Parameters<typeof event<Fields>>[1]> = {}): Event<Fields> {
  return event('walk_started', {
    fields: makeFields(),
    ...overrides,
    write: overrides.write ?? discard,
  })
}

function bound(overrides: Partial<Parameters<typeof event<Fields>>[1]> = {}): Event<Fields> {
  const metric = make(overrides)
  metric.bind({ driver, now })
  return metric
}

beforeEach(() => {
  clock = 1_788_616_987_000
  driver = memory()
})

describe('declaration', () => {
  it('is inert — a declaration is not bound to anything', () => {
    const walks = event('walk_started', { write: discard, fields: makeFields() })
    expect(walks.isBound).toBe(false)
    // and writing before a house has bound it is loud, not silent
    expect(expectRejected(() => walks.record(WALK)).message).toMatch(/not bound to a house/)
  })

  it('refuses an empty name', () => {
    expect(expectRejected(() => event('  ', { write: discard, fields: {} })).message).toMatch(
      /non-empty/,
    )
  })

  it('accepts json(), which a dim may not', () => {
    // the whole reason events exist: a payload cannot be a series key, but it
    // is exactly what an event is for
    expect(() => event('e', { write: discard, fields: { payload: json() } })).not.toThrow()
  })

  it.each(['id', 'ts', '_ingested_at', '_sample_rate'])(
    'refuses a field named %s — MetricHouse owns that column',
    (reserved) => {
      expect(
        expectRejected(() => event('e', { write: discard, fields: { [reserved]: str() } })).message,
      ).toMatch(/reserved column/)
    },
  )

  it('refuses a timestamp field that is not declared', () => {
    expect(
      expectRejected(() =>
        event('e', { write: discard, fields: { a: str() }, timestamp: 'nope' as 'a' }),
      ).message,
    ).toMatch(/not a declared field/)
  })

  it('refuses a timestamp field that is not ts()', () => {
    expect(
      expectRejected(() => event('e', { write: discard, fields: { a: str() }, timestamp: 'a' }))
        .message,
    ).toMatch(/declares str\(\).*must be ts\(\)/)
  })

  it('refuses a sample rate outside [0, 1]', () => {
    expect(
      expectRejected(() => event('e', { write: discard, fields: {}, sample: 1.5 })).message,
    ).toMatch(/between 0 and 1/)
  })

  it('defaults to driver staging', () => {
    expect(make().stage).toBe('driver')
  })
})

describe('record', () => {
  it('throws before a house has bound it, rather than dropping the write', () => {
    expect(expectRejected(() => make().record(WALK)).message).toMatch(/not bound to a house/)
  })

  it('stages one record', async () => {
    const walks = bound()
    walks.record(WALK)
    await walks.drain()
    expect(await walks.pending()).toBe(1)
  })

  it('does not aggregate — two identical events are two records', async () => {
    const walks = bound()
    walks.record(WALK)
    walks.record(WALK)
    await walks.drain()
    expect(await walks.pending()).toBe(2)
  })

  it('rejects an unknown field', () => {
    const walks = bound()
    expect(
      expectRejected(() => walks.record({ ...WALK, breed: 'corgi' } as never)).message,
    ).toMatch(/unknown field "breed"/)
  })

  it('rejects a missing required field', () => {
    const walks = bound()
    expect(expectRejected(() => walks.record({ dogName: 'Willow' } as never)).message).toMatch(
      /missing required field "walkerId"/,
    )
  })

  it('rejects an ill-typed field', () => {
    const walks = bound()
    expect(
      expectRejected(() => walks.record({ ...WALK, routeMeters: 'far' } as never)).message,
    ).toMatch(/routeMeters: expected a safe integer/)
  })

  it('stamps ts from the clock by default', async () => {
    const walks = bound()
    walks.record(WALK)
    await walks.drain()
    expect((await walks.peek())[0]?.ts).toEqual(new Date(clock))
  })

  it('takes ts from a declared field when asked', async () => {
    const occurred = new Date(clock - 60_000)
    const walks = event('walk_started', {
      write: discard,
      fields: { dogName: str(), occurredAt: ts() },
      timestamp: 'occurredAt',
    })
    walks.bind({ driver, now })
    walks.record({ dogName: 'Willow', occurredAt: occurred })
    await walks.drain()
    expect((await walks.peek())[0]?.ts).toEqual(occurred)
  })

  it('at: overrides both the clock and the declared field', async () => {
    const walks = bound()
    walks.record(WALK, { at: new Date(clock - 5000) })
    await walks.drain()
    expect((await walks.peek())[0]?.ts).toEqual(new Date(clock - 5000))
  })

  it('stamps _ingested_at from the clock even when ts is backdated', async () => {
    // An untrusted or backdated timestamp must stay distinguishable from
    // when MetricHouse actually saw the record
    const walks = bound()
    walks.record(WALK, { at: new Date(clock - 6 * 24 * 3600_000) })
    await walks.drain()

    const row = (await walks.peek())[0] as Row
    expect(row.ts).toEqual(new Date(clock - 6 * 24 * 3600_000))
    expect(row._ingested_at).toEqual(new Date(clock))
  })

  it('recordMany stages every record in one append', async () => {
    const walks = bound()
    const append = vi.spyOn(driver, 'append')
    walks.recordMany([WALK, { ...WALK, requestId: 'req_2' }, { ...WALK, requestId: 'req_3' }])
    await walks.drain()

    expect(await walks.pending()).toBe(3)
    expect(append).toHaveBeenCalledTimes(1)
  })
})

describe('identity', () => {
  it('mints a distinct uuidv7 per record', async () => {
    const walks = bound()
    walks.recordMany([WALK, WALK, WALK])
    await walks.drain()

    const ids = (await walks.peek()).map((row) => row.id)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })

  it('keeps ids stable across a release and retry', async () => {
    // at-least-once only helps if the resend is recognisable, and an event id
    // is not derivable from content the way an aggregate row id is
    const walks = bound()
    walks.record(WALK)
    await walks.drain()
    const before = (await walks.peek())[0]?.id

    const claim = await walks.claimBatch(clock)
    await walks.releaseBatch(claim)

    expect((await walks.peek())[0]?.id).toBe(before)
  })

  it('sorts ascending within a millisecond', async () => {
    const walks = bound()
    walks.recordMany([WALK, WALK, WALK, WALK])
    await walks.drain()

    const ids = (await walks.peek()).map((row) => row.id as string)
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('materialized rows', () => {
  it('stringifies a json() field — the column your table wants is text', async () => {
    const walks = bound()
    walks.record({ ...WALK, weather: { tempC: 14, rain: true } })
    await walks.drain()

    expect((await walks.peek())[0]?.weather).toBe('{"tempC":14,"rain":true}')
  })

  it('omits an absent optional field rather than writing null', async () => {
    const walks = bound()
    walks.record(WALK)
    await walks.drain()

    expect(await walks.peek()).toEqual([
      expect.not.objectContaining({ routeMeters: expect.anything() }),
    ])
  })

  it('describes its columns, with json as text', () => {
    expect(make().rowShape().columns).toEqual([
      { name: 'id', kind: 'str', optional: false },
      { name: 'ts', kind: 'ts', optional: false },
      { name: 'dogName', kind: 'str', optional: false },
      { name: 'walkerId', kind: 'str', optional: false },
      { name: 'requestId', kind: 'str', optional: false },
      { name: 'routeMeters', kind: 'int', optional: true },
      { name: 'weather', kind: 'str', optional: true },
      { name: '_ingested_at', kind: 'ts', optional: false },
    ])
  })

  it('adds _sample_rate to the shape only when sampling is declared', () => {
    const names = (metric: Event<Fields>) => metric.rowShape().columns.map((c) => c.name)
    expect(names(make())).not.toContain('_sample_rate')
    expect(names(make({ sample: 0.5 }))).toContain('_sample_rate')
  })
})

describe('sampling', () => {
  it('keeps everything at a rate of 1 and drops everything at 0', async () => {
    const kept = bound({ sample: 1 })
    const dropped = event('dropped', { write: discard, fields: makeFields(), sample: 0 })
    dropped.bind({ driver, now })

    kept.recordMany([WALK, WALK, WALK])
    dropped.recordMany([WALK, WALK, WALK])
    await Promise.all([kept.drain(), dropped.drain()])

    expect(await kept.pending()).toBe(3)
    expect(await dropped.pending()).toBe(0)
  })

  it('writes the effective rate on every surviving row', async () => {
    const walks = bound({ sample: 1 })
    walks.record(WALK)
    await walks.drain()
    expect((await walks.peek())[0]?._sample_rate).toBe(1)
  })

  it('evaluates a per-event rate, so errors can be kept and successes sampled', async () => {
    const walks = event('walk_started', {
      write: discard,
      fields: { dogName: str(), status: str() },
      sample: (fields) => (fields.status === 'ok' ? 0 : 1),
    })
    walks.bind({ driver, now })

    walks.recordMany([
      { dogName: 'Willow', status: 'ok' },
      { dogName: 'Rex', status: 'error' },
      { dogName: 'Ada', status: 'ok' },
    ])
    await walks.drain()

    expect((await walks.peek()).map((row) => row.dogName)).toEqual(['Rex'])
  })

  it('refuses a rate a sample function returns outside [0, 1]', () => {
    const walks = event('e', { write: discard, fields: { a: str() }, sample: () => 7 })
    walks.bind({ driver, now })
    expect(expectRejected(() => walks.record({ a: 'x' })).message).toMatch(/not a rate in \[0, 1\]/)
  })
})

describe('derive', () => {
  let house: House
  let requests: ReturnType<typeof counter<{ tenantId: ReturnType<typeof str> }>>
  let walks: Event<{ tenantId: ReturnType<typeof str>; tokens: ReturnType<typeof int> }>

  beforeEach(() => {
    requests = counter('requests', {
      dims: { tenantId: str() },
      resolution: '1s',
      flush: '5m',
      write: vi.fn(),
    })
    walks = event('request_completed', {
      fields: { tenantId: str(), tokens: int() },
      derive: {
        requests: (e) => [{ dims: { tenantId: e.tenantId }, value: 1 }],
      },
      write: vi.fn(),
    })
    house = createHouse({ driver, schema: [requests, walks], now })
  })

  it('increments the named counter', async () => {
    walks.record({ tenantId: 't1', tokens: 40 })
    await house.drain()
    expect(await requests.current({ tenantId: 't1' })).toBe(1)
  })

  it('accepts a bare object as well as an array', async () => {
    const single = event('single', {
      fields: { tenantId: str() },
      derive: { requests: (e) => ({ dims: { tenantId: e.tenantId } }) },
      write: vi.fn(),
    })
    house.register(single)

    single.record({ tenantId: 't1' })
    await house.drain()
    expect(await requests.current({ tenantId: 't1' })).toBe(1)
  })

  it('fans one event out to several increments', async () => {
    const tokens = counter('tokens', {
      dims: { tenantId: str(), kind: str() },
      resolution: '1s',
      flush: '5m',
      write: vi.fn(),
    })
    const fanned = event('fanned', {
      fields: { tenantId: str(), input: int(), output: int() },
      derive: {
        tokens: (e) => [
          { dims: { tenantId: e.tenantId, kind: 'input' }, value: e.input },
          { dims: { tenantId: e.tenantId, kind: 'output' }, value: e.output },
        ],
      },
      write: vi.fn(),
    })
    house.register(tokens, fanned)

    fanned.record({ tenantId: 't1', input: 100, output: 25 })
    await house.drain()

    expect(await tokens.current({ tenantId: 't1', kind: 'input' })).toBe(100)
    expect(await tokens.current({ tenantId: 't1', kind: 'output' })).toBe(25)
  })

  it('runs before sampling — counters stay exact while the table is a slice', async () => {
    const exact = counter('exact', {
      dims: { tenantId: str() },
      resolution: '1s',
      flush: '5m',
      write: vi.fn(),
    })
    const sampled = event('sampled', {
      fields: { tenantId: str() },
      derive: { exact: (e) => ({ dims: { tenantId: e.tenantId } }) },
      sample: 0,
      write: vi.fn(),
    })
    house.register(exact, sampled)

    sampled.recordMany([{ tenantId: 't1' }, { tenantId: 't1' }, { tenantId: 't1' }])
    await house.drain()

    // every event counted, no event staged
    expect(await exact.current({ tenantId: 't1' })).toBe(3)
    expect(await sampled.pending()).toBe(0)
  })

  it('still stages the event when derive throws — a broken fan-out loses no evidence', async () => {
    const onError = vi.fn()
    const target = counter('requests', {
      dims: { tenantId: str() },
      resolution: '1s',
      flush: '5m',
      write: vi.fn(),
    })
    const broken = event('broken', {
      fields: { tenantId: str() },
      derive: {
        requests: () => {
          throw new Error('derive exploded')
        },
      },
      write: vi.fn(),
    })
    const own = createHouse({ driver: memory(), schema: [target, broken], now, onError })

    broken.record({ tenantId: 't1' })
    await own.drain()

    expect(await broken.pending()).toBe(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'derive exploded' }), {
      metric: 'broken',
    })
  })

  it('reports a derive target no house declares, and still stages', async () => {
    const onError = vi.fn()
    const orphan = event('orphan', {
      fields: { a: str() },
      derive: { nonexistent: () => ({ dims: {} }) },
      write: vi.fn(),
    })
    const own = createHouse({ driver, schema: [orphan], now, onError })

    orphan.record({ a: 'x' })
    await own.drain()

    expect(await orphan.pending()).toBe(1)
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/which no metric in this house declares/),
    })
  })

  it('refuses a derive target that is not a counter', async () => {
    const onError = vi.fn()
    const target = event('target', { fields: { a: str() }, write: vi.fn() })
    const bad = event('bad', {
      fields: { a: str() },
      derive: { target: () => ({ dims: {} }) },
      write: vi.fn(),
    })
    const own = createHouse({ driver, schema: [target, bad], now, onError })

    bad.record({ a: 'x' })
    await own.drain()

    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/is a event, and derive can only increment a counter/),
    })
  })

  it('resolves lazily, so a target may be registered after the event', async () => {
    const late = counter('late', {
      dims: { a: str() },
      resolution: '1s',
      flush: '5m',
      write: vi.fn(),
    })
    const first = event('first', {
      fields: { a: str() },
      derive: { late: (e) => ({ dims: { a: e.a } }) },
      write: vi.fn(),
    })
    const own = createHouse({ driver, schema: [first], now })
    own.register(late)

    first.record({ a: 'x' })
    await own.drain()
    expect(await late.current({ a: 'x' })).toBe(1)
  })
})

describe('peek and pending', () => {
  it('peek does not consume', async () => {
    const walks = bound()
    walks.recordMany([WALK, WALK])
    await walks.drain()

    await walks.peek()
    expect(await walks.pending()).toBe(2)
  })

  it('peek honours a limit', async () => {
    const walks = bound()
    walks.recordMany([WALK, WALK, WALK, WALK])
    await walks.drain()

    expect(await walks.peek(2)).toHaveLength(2)
  })

  it('pending excludes what a claim has taken', async () => {
    const walks = bound()
    walks.recordMany([WALK, WALK])
    await walks.drain()

    const claim = await walks.claimBatch(clock)
    expect(await walks.pending()).toBe(0)

    await walks.releaseBatch(claim)
    expect(await walks.pending()).toBe(2)
  })
})

describe('flush', () => {
  let write: ReturnType<typeof vi.fn<WriteFn>>
  let walks: Event<Fields>
  let house: House

  beforeEach(() => {
    write = vi.fn<WriteFn>()
    walks = make({ write })
    house = createHouse({ driver, schema: [walks], now })
  })

  it('ships staged records with no waiting for a bucket to close', async () => {
    // the whole difference from a counter: there is no open bucket to hold a
    // record back, so it is shippable the instant it is recorded
    walks.record(WALK)
    await house.drain()

    const report = await house.flush()
    expect(report.metrics.walk_started).toMatchObject({ rows: 1, buckets: 0, skipped: false })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('tells the sink how many events, not how much value', async () => {
    walks.recordMany([WALK, WALK, WALK])
    await house.drain()
    await house.flush()

    const [, context] = write.mock.calls[0] as [Row[], WriteContext]
    expect(context).toMatchObject({ kind: 'event', total: 3, attempt: 1, source: 'flush' })
  })

  it('spans the window from the oldest to one ms past the newest record', async () => {
    walks.record(WALK, { at: 1000 })
    walks.record(WALK, { at: 5000 })
    await house.drain()
    await house.flush()

    const [, context] = write.mock.calls[0] as [Row[], WriteContext]
    expect(context.bucketFrom).toBe(1000)
    expect(context.bucketTo).toBe(5001)
  })

  it('deletes nothing until the sink resolves', async () => {
    write.mockRejectedValueOnce(new Error('clickhouse is down'))
    walks.record(WALK)
    await house.drain()

    const failed = await house.flush()
    expect(failed.ok).toBe(false)
    expect(await walks.pending()).toBe(1)

    // and the retry carries the same record, with attempt incremented
    const ok = await house.flush({ force: true })
    expect(ok.ok).toBe(true)
    const [, retry] = write.mock.calls[1] as [Row[], WriteContext]
    expect(retry.attempt).toBe(2)
    expect(await walks.pending()).toBe(0)
  })

  it('never calls the sink for an empty backlog', async () => {
    await house.flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('carries at most claimLimit records per flush', async () => {
    const capped = make({ write, claimLimit: 2 })
    const own = createHouse({ driver: memory(), schema: [capped], now })
    capped.recordMany([WALK, WALK, WALK, WALK, WALK])
    await own.drain()

    expect((await own.flush()).metrics.walk_started?.rows).toBe(2)
    expect(await capped.pending()).toBe(3)
  })
})

describe('local staging', () => {
  let write: ReturnType<typeof vi.fn<WriteFn>>

  beforeEach(() => {
    write = vi.fn<WriteFn>()
  })

  const local = (overrides: Partial<Parameters<typeof event<Fields>>[1]> = {}): Event<Fields> =>
    make({ stage: 'local', write, ...overrides })

  it('never reaches the driver', async () => {
    const append = vi.spyOn(driver, 'append')
    const walks = local()
    walks.bind({ driver, now })

    walks.record(WALK)
    expect(append).not.toHaveBeenCalled()
    expect(await walks.pending()).toBe(1)
  })

  it('ships itself at maxSize, without anyone calling flush', async () => {
    const walks = local({ batch: { maxSize: 3 } })
    createHouse({ driver, schema: [walks], now })

    walks.recordMany([WALK, WALK])
    expect(write).not.toHaveBeenCalled()

    walks.record(WALK)
    await walks.drain()

    expect(write).toHaveBeenCalledTimes(1)
    const [rows, context] = write.mock.calls[0] as [Row[], WriteContext]
    expect(rows).toHaveLength(3)
    expect(context.source).toBe('batch')
  })

  it('ships at maxAge when maxSize is never reached', async () => {
    vi.useFakeTimers()
    try {
      const walks = local({ batch: { maxSize: 1000, maxAge: '5s' } })
      createHouse({ driver, schema: [walks], now })

      walks.record(WALK)
      expect(write).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drain ships the buffer — leaving it in the heap is the loss drain prevents', async () => {
    const walks = local({ batch: { maxSize: 1000 } })
    const house = createHouse({ driver, schema: [walks], now })

    walks.record(WALK)
    expect(write).not.toHaveBeenCalled()

    await house.drain()
    expect(write).toHaveBeenCalledTimes(1)
    expect(await walks.pending()).toBe(0)
  })

  it('flush ships the buffer too', async () => {
    const walks = local({ batch: { maxSize: 1000 } })
    const house = createHouse({ driver, schema: [walks], now })

    walks.record(WALK)
    const report = await house.flush()

    expect(report.metrics.walk_started?.rows).toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('puts records back when the sink throws', async () => {
    write.mockRejectedValue(new Error('sink down'))
    const onError = vi.fn()
    const walks = local({ batch: { maxSize: 2 } })
    createHouse({ driver, schema: [walks], now, onError })

    walks.recordMany([WALK, WALK])
    await walks.drain().catch(() => undefined)

    expect(onError).toHaveBeenCalled()
    expect(await walks.pending()).toBe(2)
  })

  it('ships a local batch to the sink the metric declared', async () => {
    const walks = make({ stage: 'local', batch: { maxSize: 1 }, write })
    createHouse({ driver, schema: [walks], now })

    walks.record(WALK)
    await walks.drain()
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('claim safety', () => {
  it('refuses a bucket claim — that would silently drop every record', async () => {
    const walks = bound()
    const bucketClaim = await driver.claim('walk_started', clock)
    expect(() => walks.materializeClaim(bucketClaim)).toThrow(/expected staged records/)
  })

  it('refuses to settle a local claim twice', async () => {
    const walks = make({ stage: 'local', write: vi.fn() })
    walks.bind({ driver, now })
    walks.record(WALK)

    const claim = await walks.claimBatch(clock)
    await walks.ackBatch(claim)
    await expect(walks.ackBatch(claim)).rejects.toThrow(/not in flight/)
  })
})
