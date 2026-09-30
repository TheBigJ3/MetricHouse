import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { createHouse, type House } from '../runtime/house.js'
import { int, json, str, ts } from '../schema/types.js'
import { counter } from './counter.js'
import { type Event, type EventConfig, event } from './event.js'
import type { Row, WriteContext, WriteFn } from './types.js'

/** A sink that keeps nothing, for declaration tests that never ship. */
const discard: WriteFn = () => {}

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
  it('is inert, a declaration bound to nothing', () => {
    const walks = event('walk_started', { write: discard, fields: makeFields() })
    expect(walks.isBound).toBe(false)
    // and writing before a house has bound it is loud, not silent
    expect(() => walks.record(WALK)).toThrow(
      'walk_started: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
  })

  it('refuses an empty name', () => {
    expect(() => event('  ', { write: discard, fields: {} })).toThrow(
      'event: name must be a non-empty string',
    )
  })

  it('accepts json(), which a dim may not', () => {
    // the whole reason events exist: a payload cannot be a series key, but it
    // is exactly what an event is for
    expect(() => event('e', { write: discard, fields: { payload: json() } })).not.toThrow()
  })

  it.each(['id', 'ts', '_ingested_at', '_sample_rate'])(
    'refuses a field named %s, a column MetricHouse owns',
    (reserved) => {
      expect(() => event('e', { write: discard, fields: { [reserved]: str() } })).toThrow(
        `e: field "${reserved}" is a reserved column. MetricHouse writes ` +
          '[id, ts, _ingested_at, _sample_rate] on every row',
      )
    },
  )

  it('refuses a timestamp field that is not declared', () => {
    expect(() =>
      event('e', { write: discard, fields: { a: str() }, timestamp: 'nope' as never }),
    ).toThrow('e: timestamp names "nope", which is not a declared field')
  })

  it('refuses a timestamp naming a property every object inherits', () => {
    expect(() =>
      event('e', { write: discard, fields: { a: str() }, timestamp: 'toString' as never }),
    ).toThrow(new Error('e: timestamp names "toString", which is not a declared field'))
  })

  it('refuses a field named like a whole number, which would lose its place', () => {
    expect(() => event('e', { write: discard, fields: { a: str(), 7: str() } })).toThrow(
      'e: a field cannot be named "7", because JavaScript lists a key that reads as a whole number before every other key, and the order you declared would be lost. Give it a name such as "field_7"',
    )
  })

  it('refuses a stage it does not know', () => {
    expect(() =>
      event('e', { write: discard, fields: {}, stage: 'memory' as unknown as 'local' }),
    ).toThrow(new Error("e: stage must be 'driver' or 'local', got \"memory\""))
  })

  it('refuses a sample that is neither a rate nor a function', () => {
    expect(() =>
      event('e', { write: discard, fields: {}, sample: '0.5' as unknown as number }),
    ).toThrow(
      new Error('e: sample must be a rate between 0 and 1 or a function returning one, got "0.5"'),
    )
  })

  it.each(['bucket_open', 'bucket_elapsed_ms'])('refuses a field named %s', (field) => {
    expect(() => event('e', { write: discard, fields: { [field]: str() } })).toThrow(
      new Error(
        `e: a field cannot be named "${field}", because every row snapshot() returns carries a ` +
          'column of that name',
      ),
    )
  })

  it('refuses a flush cadence of zero', () => {
    expect(() => event('e', { write: discard, fields: {}, flush: '0s' })).toThrow(
      new Error('e: flush must be longer than zero, got "0s"'),
    )
  })

  it('refuses a batch age a timer cannot wait for', () => {
    expect(() =>
      event('e', { write: discard, fields: {}, stage: 'local', batch: { maxAge: '25d' } }),
    ).toThrow(
      'e: batch.maxAge is 25d, longer than 2147483647ms (just under 25 days), which is the longest a JavaScript timer can wait. A longer one fires every millisecond',
    )
  })

  it('refuses a timestamp field that is not ts()', () => {
    expect(() =>
      event('e', {
        write: discard,
        fields: { a: str() },
        // @ts-expect-error the types already refuse a field that is not ts()
        timestamp: 'a',
      }),
    ).toThrow('e: timestamp field "a" declares str(), and it must be ts()')
  })

  it('refuses a sample rate outside [0, 1]', () => {
    expect(() => event('e', { write: discard, fields: {}, sample: 1.5 })).toThrow(
      'e: sample must be a rate between 0 and 1, got 1.5',
    )
  })

  it('defaults to driver staging', () => {
    expect(make().stage).toBe('driver')
  })
})

describe('record', () => {
  it('throws before a house has bound it, rather than dropping the write', () => {
    expect(() => make().record(WALK)).toThrow(
      'walk_started: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
  })

  it('stages one record', async () => {
    const walks = bound()
    walks.record(WALK)
    await walks.drain()
    expect(await walks.pending()).toBe(1)
  })

  it('does not aggregate, so two identical events are two records', async () => {
    const walks = bound()
    walks.record(WALK)
    walks.record(WALK)
    await walks.drain()
    expect(await walks.pending()).toBe(2)
  })

  it('rejects an unknown field', () => {
    const walks = bound()
    expect(() => walks.record({ ...WALK, breed: 'corgi' } as never)).toThrow(
      'unknown field "breed". The declared fields are [dogName, walkerId, requestId, routeMeters, weather]',
    )
  })

  it('rejects a missing required field', () => {
    const walks = bound()
    expect(() => walks.record({ dogName: 'Willow' } as never)).toThrow(
      'missing required field "walkerId"',
    )
  })

  it('rejects an ill-typed field', () => {
    const walks = bound()
    expect(() => walks.record({ ...WALK, routeMeters: 'far' } as never)).toThrow(
      'routeMeters: expected a safe integer, got "far"',
    )
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
  it('stringifies a json() field, since the column your table wants is text', async () => {
    const walks = bound()
    walks.record({ ...WALK, weather: { tempC: 14, rain: true } })
    await walks.drain()

    expect((await walks.peek())[0]?.weather).toBe('{"tempC":14,"rain":true}')
  })

  it('omits an absent optional field named after an inherited property', async () => {
    const notes = event('notes', {
      fields: { body: str(), constructor: str().optional(), toString: json().optional() },
      write: discard,
    })
    notes.bind({ driver, now })
    // cast: TypeScript reads the inherited `constructor` off the literal too
    notes.record({ body: 'hello' } as never)
    await notes.drain()

    const [row] = await notes.peek()
    expect(Object.keys(row ?? {})).toEqual(['id', 'ts', 'body', '_ingested_at'])
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

  it('describes a field with a default as a column every row carries', () => {
    const walks = event('walks', { fields: { env: str().default('prod') }, write: discard })
    expect(walks.rowShape().columns[2]).toEqual({ name: 'env', kind: 'str', optional: false })
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
    expect(() => walks.record({ a: 'x' })).toThrow(
      'e: sample returned 7, which is not a rate in [0, 1]',
    )
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

  it('runs before sampling, so counters stay exact while the table is a slice', async () => {
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

  it('still stages the event when derive throws, so a broken fan-out loses no evidence', async () => {
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

  it('says a whole derived value past the safe range is too large, not a fraction', async () => {
    const onError = vi.fn()
    const steps = counter('steps', { resolution: '1s', flush: '5m', write: vi.fn() })
    const walked = event('walked', {
      fields: { n: int() },
      derive: { steps: () => ({ value: 2 ** 53 }) },
      write: vi.fn(),
    })
    const own = createHouse({ driver, schema: [steps, walked], now, onError })

    walked.record({ n: 1 })
    await own.drain()

    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      'walked: derive for "steps": 9007199254740992 is past 9007199254740991, the largest ' +
        'whole number a double holds exactly, and steps counts in whole numbers',
    ])
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

  it('pending still counts what a claim has taken, until it is settled', async () => {
    // records a flush is writing have not shipped. A sink that hangs should
    // show up as a backlog, not as zero
    const walks = bound()
    walks.recordMany([WALK, WALK])
    await walks.drain()

    const claim = await walks.claimBatch(clock)
    expect(await walks.pending()).toBe(2)
    expect(await walks.peek()).toEqual([])

    await walks.ackBatch(claim)
    expect(await walks.pending()).toBe(0)
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
    expect(write.mock.calls.map(([rows]) => rows)).toMatchObject([[WALK]])
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

  it('drain ships the buffer, since leaving it in the heap is the loss drain prevents', async () => {
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

    expect(onError.mock.calls).toEqual([[new Error('sink down'), { metric: 'walk_started' }]])
    expect(await walks.pending()).toBe(2)
  })

  it('ships a local batch to the sink the metric declared', async () => {
    const walks = make({ stage: 'local', batch: { maxSize: 1 }, write })
    createHouse({ driver, schema: [walks], now })

    walks.record(WALK)
    await walks.drain()
    expect(write.mock.calls.map(([rows]) => rows)).toMatchObject([[WALK]])
  })
})

describe('claim safety', () => {
  it('refuses a bucket claim, which would silently drop every record', async () => {
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

describe('what record() guarantees', () => {
  const BASE_MS = 1_788_616_980_000
  let driver: Driver
  let clock: number

  beforeEach(() => {
    driver = memory()
    clock = BASE_MS
  })

  function checkout(write: WriteFn = discard) {
    const sold = counter('tickets_sold', {
      dims: { tier: str() },
      resolution: '1m',
      flush: '1m',
      write: discard,
    })
    const order = event('checkout', {
      fields: { tier: str(), qty: int(), order: json().optional() },
      derive: { tickets_sold: (fields) => ({ value: fields.qty, dims: { tier: fields.tier } }) },
      write,
    })
    const house = createHouse({ driver, schema: [sold, order], now: () => clock })
    return { sold, order, house }
  }

  it('rejects a json value JSON cannot hold, at the call', () => {
    const { order } = checkout()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    expect(() => order.record({ tier: 'vip', qty: 1, order: { big: 1n } })).toThrow(/json\(\)/)
    expect(() => order.record({ tier: 'vip', qty: 1, order: cycle })).toThrow(/json\(\)/)
    expect(() => order.record({ tier: 'vip', qty: 1, order: () => 1 })).toThrow(/json\(\)/)
  })

  it('ships the other records in a batch when one call was rejected', async () => {
    const shipped: Row[] = []
    const { order, house } = checkout((rows) => {
      shipped.push(...rows)
    })
    order.record({ tier: 'vip', qty: 1, order: { ok: true } })
    // the reason after the colon is the engine's own wording, so only ours is asserted
    expect(() => order.record({ tier: 'vip', qty: 1, order: { big: 1n } })).toThrow(
      'order: json() needs a value JSON can hold, and this one failed:',
    )
    order.record({ tier: 'vip', qty: 2 })
    await house.drain()

    const report = await house.flush({ force: true })
    expect(report.ok).toBe(true)
    expect(shipped.map((row) => row.qty)).toEqual([1, 2])
  })

  it('increments nothing when the call throws', async () => {
    const { sold, order, house } = checkout()
    expect(() => order.record({ tier: 'vip', qty: 'four' as unknown as number })).toThrow(
      'qty: expected a safe integer, got "four"',
    )
    expect(() =>
      order.recordMany([
        { tier: 'vip', qty: 1 },
        { tier: 'vip', qty: 2 },
        { tier: 'vip', qty: -0.5 },
      ]),
    ).toThrow('qty: expected a safe integer, got -0.5')
    await house.drain()

    expect(await sold.current()).toBe(0)
    expect(await order.pending()).toBe(0)
  })

  it('increments nothing when sample returns something that is not a rate', async () => {
    const sold = counter('sold', { resolution: '1m', flush: '1m', write: discard })
    const order = event('order', {
      fields: { qty: int() },
      sample: () => 2,
      derive: { sold: (fields) => ({ value: fields.qty }) },
      write: discard,
    })
    const house = createHouse({ driver, schema: [sold, order], now: () => clock })

    expect(() => order.record({ qty: 5 })).toThrow(/not a rate/)
    await house.drain()
    expect(await sold.current()).toBe(0)
  })

  it('applies all of a derive result or none of it', async () => {
    const errors: unknown[] = []
    const sold = counter('sold', {
      dims: { tier: str() },
      resolution: '1m',
      flush: '1m',
      write: discard,
    })
    const order = event('order', {
      fields: { qty: int() },
      derive: {
        sold: () => [
          { value: 1, dims: { tier: 'a' } },
          { value: 1, dims: { tier: 'b' } },
          { value: 1, dims: { nope: 'c' } },
        ],
      },
      write: discard,
    })
    const house = createHouse({
      driver,
      schema: [sold, order],
      now: () => clock,
      onError: (error) => errors.push(error),
    })

    order.record({ qty: 1 })
    await house.drain()
    expect(await sold.current()).toBe(0)
    expect(String(errors[0])).toMatch(/derive for "sold".*unknown dim "nope"/)
    // the event is still staged: a broken derive never loses the evidence
    expect(await order.pending()).toBe(1)
  })

  it('names a derive that returned nothing, or a value that is not a number', async () => {
    const errors: unknown[] = []
    const sold = counter('sold', { resolution: '1m', flush: '1m', write: discard })
    const empty = event('empty', {
      fields: {},
      derive: { sold: () => undefined as never },
      write: discard,
    })
    const text = event('text', {
      fields: {},
      derive: { sold: () => ({ value: '5' as unknown as number }) },
      write: discard,
    })
    createHouse({
      driver,
      schema: [sold, empty, text],
      now: () => clock,
      onError: (error) => errors.push(error),
    })

    empty.record({})
    text.record({})
    expect(String(errors[0])).toMatch(/must return \{ value\?, dims\? \}/)
    expect(String(errors[1])).toMatch(/value must be a finite number, got "5"/)
  })

  it('ships what was recorded, even if the caller changes the object afterwards', async () => {
    const shipped: Row[] = []
    const { order, house } = checkout((rows) => {
      shipped.push(...rows)
    })
    const payload = { status: 'paid' }
    order.record({ tier: 'vip', qty: 1, order: payload })
    payload.status = 'refunded'
    await house.drain()
    await house.flush({ force: true })

    expect(shipped[0]?.order).toBe('{"status":"paid"}')
  })

  it('ships a payload shaped like a driver marker unchanged', async () => {
    const shipped: Row[] = []
    const { order, house } = checkout((rows) => {
      shipped.push(...rows)
    })
    order.record({ tier: 'vip', qty: 1, order: { __mh_date: 5 } })
    await house.drain()
    await house.flush({ force: true })

    expect(shipped[0]?.order).toBe('{"__mh_date":5}')
  })

  it('gives a batch window that covers a backfilled record', async () => {
    const contexts: WriteContext[] = []
    const { order, house } = checkout((_rows, context) => {
      contexts.push(context)
    })
    order.record({ tier: 'vip', qty: 1 })
    order.record({ tier: 'vip', qty: 1 }, { at: BASE_MS - 60_000 })
    await house.drain()
    await house.flush({ force: true })

    expect(contexts[0]?.bucketFrom).toBe(BASE_MS - 60_000)
    expect(contexts[0]?.bucketTo).toBe(BASE_MS + 1)
  })
})

describe('local staging after a failure', () => {
  it('counts attempts up on batch sends, and back to 1 after a success', async () => {
    const attempts: number[] = []
    let fail = true
    const pageViews = event('page_view', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 1 },
      write: (_rows, context) => {
        attempts.push(context.attempt)
        if (fail) throw new Error('down')
      },
    })
    const house = createHouse({ driver: memory(), schema: [pageViews], onError: () => {} })

    pageViews.record({ path: '/' })
    await house.drain()
    pageViews.record({ path: '/a' })
    await house.drain()
    fail = false
    pageViews.record({ path: '/b' })
    await house.drain()
    pageViews.record({ path: '/c' })
    await house.drain()

    // drain() ships the buffer too, so the first record is followed by a
    // second try. A record within maxAge of a failure waits for the next
    // drain() rather than shipping itself, and every try counts
    expect(attempts).toEqual([1, 2, 3, 4, 1])
  })

  it('retries maxAge after a failed send, without a new record or a flush', async () => {
    vi.useFakeTimers()
    try {
      const sent: number[] = []
      let fail = true
      const pageViews = event('page_view', {
        fields: { path: str() },
        stage: 'local',
        batch: { maxAge: '200ms' },
        write: (rows) => {
          if (fail) throw new Error('down')
          sent.push(rows.length)
        },
      })
      createHouse({ driver: memory(), schema: [pageViews], onError: () => {} })

      pageViews.recordMany([{ path: '/' }, { path: '/a' }])
      await vi.advanceTimersByTimeAsync(250)
      expect(sent).toEqual([])

      fail = false
      await vi.advanceTimersByTimeAsync(250)
      expect(sent).toEqual([2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts back two failed batches in the order they were recorded', async () => {
    const release: (() => void)[] = []
    const seen: string[][] = []
    let fail = true
    const pageViews = event('page_view', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 2 },
      write: async (rows) => {
        if (!fail) {
          seen.push(rows.map((row) => row.path as string))
          return
        }
        await new Promise<void>((resolve) => release.push(resolve))
        throw new Error('down')
      },
    })
    const house = createHouse({ driver: memory(), schema: [pageViews], onError: () => {} })

    pageViews.recordMany([{ path: '1' }, { path: '2' }])
    pageViews.recordMany([{ path: '3' }, { path: '4' }])
    // the older batch fails first, then the newer one
    release.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    release.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    fail = false
    await house.flush({ force: true })
    expect(seen.flat()).toEqual(['1', '2', '3', '4'])
  })
})

describe('local staging after house.stop()', () => {
  it('calls the sink no more once stop() has returned', async () => {
    vi.useFakeTimers()
    try {
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
      const house = createHouse({ driver: memory(), schema: [views], onError: () => {} })
      views.record({ path: '/' })

      await house.stop()
      const atStop = [...sources]
      await vi.advanceTimersByTimeAsync(60_000)

      expect({ atStop, after: sources.slice(atStop.length) }).toEqual({
        atStop: ['batch', 'flush'],
        after: [],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries on its timer again once the house is started again', async () => {
    vi.useFakeTimers()
    try {
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
      const house = createHouse({ driver: memory(), schema: [views], onError: () => {} })
      await house.stop()
      house.start()
      views.record({ path: '/' })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(sources).toEqual(['batch'])
      await house.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('claimLimit at drain, stop and maxAge', () => {
  it('ships every local record on drain, in batches of claimLimit', async () => {
    const sent: number[] = []
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      claimLimit: 3,
      write: (rows) => {
        sent.push(rows.length)
      },
    })
    createHouse({ driver: memory(), schema: [views] })
    views.recordMany(Array.from({ length: 7 }, (_, i) => ({ path: `/${i}` })))
    await views.drain()
    expect(sent).toEqual([3, 3, 1])
  })

  it('ships a whole driver-staged backlog on stop()', async () => {
    const shipped: Row[] = []
    const views = event('views', {
      fields: { path: str() },
      claimLimit: 2,
      write: (rows) => {
        shipped.push(...rows)
      },
    })
    const house = createHouse({ driver: memory(), schema: [views] })
    views.recordMany(Array.from({ length: 7 }, (_, i) => ({ path: `/${i}` })))

    const report = await house.stop()
    expect(shipped).toHaveLength(7)
    expect(report.metrics.views?.rows).toBe(7)
  })

  it('does not loop on a sink that fails at once', async () => {
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      claimLimit: 2,
      write: () => {
        throw new Error('down')
      },
    })
    createHouse({ driver: memory(), schema: [views], onError: () => {} })
    views.recordMany(Array.from({ length: 5 }, (_, i) => ({ path: `/${i}` })))
    await views.drain()
    expect(await views.pending()).toBe(5)
  })

  it('offers every record once on drain when the sink throws rather than rejects', async () => {
    const sent: string[][] = []
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      claimLimit: 2,
      write: (rows) => {
        sent.push(rows.map((row) => row.path))
        throw new Error('down')
      },
    })
    createHouse({ driver: memory(), schema: [views], onError: () => {} })
    views.recordMany(Array.from({ length: 5 }, (_, i) => ({ path: `/${i}` })))
    await views.drain()
    expect(sent).toEqual([['/0', '/1'], ['/2', '/3'], ['/4']])
    expect((await views.peek()).map((row) => row.path)).toEqual(['/0', '/1', '/2', '/3', '/4'])
  })

  it('starts the age clock for what a full batch left behind', async () => {
    vi.useFakeTimers()
    try {
      const sent: number[] = []
      const views = event('views', {
        fields: { path: str() },
        stage: 'local',
        claimLimit: 2,
        batch: { maxSize: 2, maxAge: '100ms' },
        write: (rows) => {
          sent.push(rows.length)
        },
      })
      createHouse({ driver: memory(), schema: [views] })
      views.recordMany([{ path: '/a' }, { path: '/b' }, { path: '/c' }])
      await vi.advanceTimersByTimeAsync(150)
      expect(sent).toEqual([2, 1])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('values record() now refuses or cleans up', () => {
  it('refuses an at past the range a Date can hold', () => {
    const e = event('e', { fields: {}, write: discard })
    createHouse({ driver: memory(), schema: [e] })
    expect(() => e.record({}, { at: 8.64e15 + 1 })).toThrow(/at must be/)
  })

  it('stores a negative zero field as zero', async () => {
    const rows: Row[] = []
    const e = event('e', {
      fields: { delta: int() },
      write: (batch) => {
        rows.push(...batch)
      },
    })
    const house = createHouse({ driver: memory(), schema: [e] })
    e.record({ delta: -0 })
    await house.flush({ force: true })
    expect(Object.is(rows[0]?.delta, 0)).toBe(true)
  })

  it('refuses a field named __proto__', () => {
    expect(() =>
      event('e', {
        fields: { ['__proto__']: str() } as unknown as Record<string, never>,
        write: discard,
      }),
    ).toThrow(/__proto__/)
  })
})

describe('large local batches', () => {
  it('stages and derives a recordMany of 150,000 records', async () => {
    const sold = counter('sold', { resolution: '1h', flush: '1h', write: discard })
    const views = event('views', {
      fields: { n: int() },
      stage: 'local',
      batch: { maxSize: 1_000_000 },
      derive: { sold: () => ({}) },
      write: discard,
    })
    const house = createHouse({ driver: memory(), schema: [sold, views] })
    views.recordMany(Array.from({ length: 150_000 }, (_, n) => ({ n })))
    await sold.drain()

    expect(await views.pending()).toBe(150_000)
    expect(await sold.current()).toBe(150_000)
    await house.stop().catch(() => undefined)
  })

  it('keeps 150,000 local records when the sink fails', async () => {
    const views = event('views', {
      fields: { n: int() },
      stage: 'local',
      batch: { maxSize: 1_000_000 },
      write: () => {
        throw new Error('down')
      },
    })
    createHouse({ driver: memory(), schema: [views], onError: () => {} })
    views.recordMany(Array.from({ length: 150_000 }, (_, n) => ({ n })))

    const report = await views.flush({ force: true })
    expect(report.error).toBeInstanceOf(Error)
    expect(await views.pending()).toBe(150_000)
  })
})

describe('durability', () => {
  const DURABLE = { durable: true, shared: true, atomicMerge: true }

  /** A durable driver whose append can be made to fail or wait. */
  function durableDriver(overrides: Partial<Driver> = {}): { driver: Driver; calls: string[] } {
    const base = memory()
    const calls: string[] = []
    const driver: Driver = {
      ...base,
      capabilities: DURABLE,
      append: async (ops) => {
        calls.push(`append ${ops.length}`)
        await (overrides.append ?? base.append)(ops)
      },
    }
    return { driver, calls }
  }

  function audit(driver: Driver, write: WriteFn = discard, delivery?: 'immediate') {
    const errors: unknown[] = []
    const orders = counter('orders', { dims: { plan: str() }, resolution: '1m', write: discard })
    const log = event('order_audit', {
      fields: { orderId: str(), plan: str() },
      durability: 'durable',
      derive: { orders: (fields) => ({ dims: { plan: fields.plan } }) },
      write,
    })
    const house = createHouse({
      driver,
      schema: [orders, log],
      now,
      defaults: { flush: '1m' },
      ...(delivery && { delivery }),
      onError: (error) => errors.push(error),
    })
    return { log, orders, house, errors }
  }

  const ORDER = { orderId: 'o_1', plan: 'pro' }

  const declare = (config: Partial<EventConfig<Fields, 'durable'>>) =>
    event('walk_started', { fields: makeFields(), write: discard, ...config })

  it('refuses a value that is neither relaxed nor durable', () => {
    expect(() => declare({ durability: 'always' as unknown as 'durable' })).toThrow(
      `walk_started: durability must be 'relaxed' or 'durable', got "always"`,
    )
  })

  it('refuses a null durability rather than reading it as relaxed', () => {
    expect(() => declare({ durability: null as unknown as 'durable' })).toThrow(
      `walk_started: durability must be 'relaxed' or 'durable', got null`,
    )
  })

  it('names a relaxed and a durable event with one Event type', () => {
    const relaxed = make()
    const durable = declare({ durability: 'durable' })
    // a compile error, not a runtime one, when Event<F> defaults to relaxed
    const both: Event<Fields>[] = [relaxed, durable]
    expect(both.map((one) => one.durability)).toEqual(['relaxed', 'durable'])
  })

  it('refuses durable with local staging', () => {
    expect(() => declare({ durability: 'durable', stage: 'local' })).toThrow(
      "walk_started: durability 'durable' needs stage 'driver', because a record staged in " +
        'this process dies with it',
    )
  })

  it('refuses durable with sampling, even at a rate of one', () => {
    expect(() => declare({ durability: 'durable', sample: 1 })).toThrow(
      "walk_started: durability 'durable' cannot sample, because a record sampling drops is " +
        'lost on purpose',
    )
  })

  it('reports relaxed by default, and a relaxed record() returns nothing', () => {
    const walks = bound()
    expect(walks.durability).toBe('relaxed')
    expect(walks.record(WALK)).toBeUndefined()
  })

  it('resolves once the driver has staged the record, without drain()', async () => {
    const { driver, calls } = durableDriver()
    const { log, orders } = audit(driver)

    await log.record(ORDER)
    expect(calls).toEqual(['append 1'])
    expect((await log.peek()).map((row) => row.orderId)).toEqual(['o_1'])
    expect(await orders.current({ plan: 'pro' })).toBe(1)
  })

  it('rejects rather than throws a record that fails validation, and stages nothing', async () => {
    const { driver, calls } = durableDriver()
    const { log, orders } = audit(driver)

    const result = log.record({ orderId: 'o_1' } as typeof ORDER)
    await expect(result).rejects.toThrow('missing required field "plan"')
    expect(calls).toEqual([])
    expect(await log.pending()).toBe(0)
    expect(await orders.current({ plan: 'pro' })).toBe(0)
  })

  it('rejects on an unbound event', async () => {
    const log = event('order_audit', {
      fields: { orderId: str() },
      durability: 'durable',
      write: discard,
    })
    await expect(log.record({ orderId: 'o_1' })).rejects.toThrow(
      'order_audit: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
  })

  it('rejects with the driver error when the append fails, and derives nothing', async () => {
    const { driver } = durableDriver({
      append: async () => {
        throw new Error('redis down')
      },
    })
    const { log, orders, errors } = audit(driver)

    await expect(log.record(ORDER)).rejects.toThrow(
      'order_audit: the driver did not confirm the record, which may still be staged and ship. ' +
        'redis down',
    )
    expect(await orders.current({ plan: 'pro' })).toBe(0)
    // the caller holds the failure, so onError is not told twice
    expect(errors).toEqual([])
  })

  it('leaves a record nobody awaits to surface as an unhandled rejection', async () => {
    const { driver } = durableDriver({
      append: async () => {
        throw new Error('redis down')
      },
    })
    const { log, house, errors } = audit(driver)

    // vitest's own listener would fail the run, so it steps aside for this one
    const theirs = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    const unhandled: unknown[] = []
    const mine = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', mine)
    try {
      log.record(ORDER)
      await house.drain()
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', mine)
      for (const listener of theirs) process.on('unhandledRejection', listener)
    }

    expect(unhandled.map((reason) => (reason as Error).message)).toEqual([
      'order_audit: the driver did not confirm the record, which may still be staged and ' +
        'ship. redis down',
    ])
    expect(errors).toEqual([])
  })

  it('derives only once the driver has answered the append', async () => {
    let answer = () => {}
    const { driver } = durableDriver({
      append: (ops) =>
        new Promise<void>((resolve) => {
          answer = () => resolve(memory().append(ops))
        }),
    })
    const { log, orders } = audit(driver)

    const recorded = log.record(ORDER)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await orders.current({ plan: 'pro' })).toBe(0)

    answer()
    await recorded
    expect(await orders.current({ plan: 'pro' })).toBe(1)
  })

  it('stages a recordMany in one append, and stages none of it when one record is bad', async () => {
    const { driver, calls } = durableDriver()
    const { log } = audit(driver)

    await log.recordMany([ORDER, { orderId: 'o_2', plan: 'team' }])
    await expect(
      log.recordMany([{ orderId: 'o_3', plan: 'pro' }, { orderId: 'o_4' } as typeof ORDER]),
    ).rejects.toThrow('missing required field "plan"')

    expect(calls).toEqual(['append 2'])
    expect((await log.peek()).map((row) => row.orderId)).toEqual(['o_1', 'o_2'])
  })

  it('resolves an empty recordMany without touching the driver', async () => {
    const { driver, calls } = durableDriver()
    const { log } = audit(driver)
    await expect(log.recordMany([])).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('makes drain() wait for a durable record, and resolve even when that record failed', async () => {
    let fail = (_: Error) => {}
    const { driver, calls } = durableDriver({
      append: () =>
        new Promise<void>((_, reject) => {
          fail = reject
        }),
    })
    const { log, house } = audit(driver)

    const recorded = log.record(ORDER).catch((error: Error) => error.message)
    let drained = false
    const draining = house.drain().then(() => {
      drained = true
    })
    await vi.waitFor(() => expect(calls).toEqual(['append 1']))
    expect(drained).toBe(false)

    fail(new Error('redis down'))
    await draining
    expect(await recorded).toBe(
      'order_audit: the driver did not confirm the record, which may still be staged and ship. ' +
        'redis down',
    )
  })

  it('ships at once under immediate delivery', async () => {
    const shipped: Row[] = []
    const { driver } = durableDriver()
    const { log, house } = audit(
      driver,
      (rows) => {
        shipped.push(...rows)
      },
      'immediate',
    )

    await log.record(ORDER)
    await house.drain()
    expect(shipped.map((row) => row.orderId)).toEqual(['o_1'])
    expect(await log.pending()).toBe(0)
  })
})

describe('house.drain() after a durable record that derives', () => {
  it('waits for the derived counter write as well as the append', async () => {
    const base = memory()
    const calls: string[] = []
    const slow: Driver = {
      ...base,
      capabilities: { durable: true, shared: true, atomicMerge: true },
      append: async (ops) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await base.append(ops)
        calls.push('append')
      },
      increment: async (ops) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await base.increment(ops)
        calls.push('increment')
      },
    }
    const orders = counter('orders', {
      dims: { plan: str() },
      resolution: '1m',
      flush: '1m',
      write: discard,
    })
    const audit = event('order_audit', {
      fields: { plan: str() },
      durability: 'durable',
      derive: { orders: (fields) => ({ dims: { plan: fields.plan } }) },
      write: discard,
    })
    const house = createHouse({ driver: slow, schema: [orders, audit], now })

    const recorded = audit.record({ plan: 'pro' })
    await house.drain()
    expect(calls).toEqual(['append', 'increment'])
    await recorded
  })
})

describe('derive sees the record as it was stored', () => {
  it('counts what a durable record stored, not what the caller changed before the reply', async () => {
    let answer = () => {}
    const base = memory()
    const held: Driver = {
      ...base,
      capabilities: { durable: true, shared: true, atomicMerge: true },
      append: (ops) =>
        new Promise<void>((resolve) => {
          answer = () => resolve(base.append(ops))
        }),
    }
    const orders = counter('orders', {
      dims: { plan: str() },
      resolution: '1m',
      flush: '1m',
      write: discard,
    })
    const audit = event('order_audit', {
      fields: { order: json<{ plan: string }>() },
      durability: 'durable',
      derive: { orders: (fields) => ({ dims: { plan: fields.order.plan } }) },
      write: discard,
    })
    createHouse({ driver: held, schema: [orders, audit], now })

    const order = { plan: 'pro' }
    const recorded = audit.record({ order })
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.plan = 'team'
    answer()
    await recorded
    await orders.drain()

    expect([await orders.current({ plan: 'pro' }), await orders.current({ plan: 'team' })]).toEqual(
      [1, 0],
    )
    expect((await audit.peek())[0]?.order).toBe('{"plan":"pro"}')
  })

  it('gives each derive function its own copy, so one cannot change what the next sees', () => {
    const seen: unknown[] = []
    const first = counter('first', { resolution: '1m', flush: '1m', write: discard })
    const second = counter('second', { resolution: '1m', flush: '1m', write: discard })
    const checkout = event('checkout', {
      fields: { cart: json<{ items: string[] }>(), at: ts() },
      derive: {
        first: (fields) => {
          fields.cart.items.push('mutated')
          fields.at.setTime(0)
          return {}
        },
        second: (fields) => {
          seen.push(fields.cart.items, fields.at.getTime())
          return {}
        },
      },
      write: discard,
    })
    createHouse({ driver, schema: [first, second, checkout], now })

    checkout.record({ cart: { items: ['tee'] }, at: new Date(clock) })
    expect(seen).toEqual([['tee'], clock])
  })
})

describe('ackError on sends that are not a flush', () => {
  it('reports a failed ack after an immediate send of driver staged records', async () => {
    const failure = new Error('claim was taken back')
    const errors: unknown[] = []
    const acking: Driver = { ...driver, ack: () => Promise.reject(failure) }
    const views = event('views', { fields: { path: str() }, write: discard })
    const house = createHouse({
      driver: acking,
      schema: [views],
      now,
      delivery: 'immediate',
      onError: (error) => errors.push(error),
    })

    views.record({ path: '/' })
    await house.drain()
    expect(errors).toEqual([failure])
  })

  it('reports a failed ack after a local batch send', async () => {
    const failure = new Error('ack failed')
    const errors: unknown[] = []
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 1 },
      write: discard,
    })
    const house = createHouse({
      driver,
      schema: [views],
      now,
      onError: (error) => errors.push(error),
    })
    vi.spyOn(views, 'ackBatch').mockRejectedValue(failure)

    views.record({ path: '/' })
    await house.drain()
    expect(errors).toEqual([failure])
  })
})

describe('sending after a failed send', () => {
  function failing(stage: 'local' | 'driver', batch?: { maxSize?: number; maxAge?: string }) {
    const sent: string[][] = []
    const errors: unknown[] = []
    let fail = true
    const views = event('views', {
      fields: { path: str() },
      stage,
      ...(batch && { batch }),
      flush: '30s',
      write: (rows) => {
        sent.push(rows.map((row) => row.path))
        if (fail) throw new Error('down')
      },
    })
    const house = createHouse({
      driver,
      schema: [views],
      now,
      delivery: batch ? 'staged' : 'immediate',
      onError: (error) => errors.push(error),
    })
    return {
      views,
      house,
      sent,
      errors,
      recover: () => {
        fail = false
      },
    }
  }

  it('holds locally staged records back from immediate sends until maxAge has passed', async () => {
    const { views, sent, errors } = failing('local')
    for (const path of ['/1', '/2', '/3', '/4']) views.record({ path })
    expect(sent).toEqual([['/1']])

    clock += 9_999
    views.record({ path: '/5' })
    expect(sent).toEqual([['/1']])

    clock += 1
    views.record({ path: '/6' })
    expect(sent).toEqual([['/1'], ['/1', '/2', '/3', '/4', '/5', '/6']])
    // one report per send, rather than one per record
    await vi.waitFor(() => expect(errors).toHaveLength(2))
  })

  it('holds a full local batch back until maxAge has passed', async () => {
    const { views, sent, errors, house } = failing('local', { maxSize: 1, maxAge: '10s' })
    for (const path of ['/1', '/2', '/3', '/4', '/5']) views.record({ path })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(sent).toEqual([['/1']])

    clock += 9_999
    views.record({ path: '/6' })
    expect(sent).toEqual([['/1']])

    clock += 1
    views.record({ path: '/7' })
    expect(sent.at(-1)).toEqual(['/1', '/2', '/3', '/4', '/5', '/6', '/7'])
    await house.drain()
  })

  it('holds driver staged records back from immediate sends until flush has passed', async () => {
    const { views, house, sent, errors, recover } = failing('driver')
    for (const path of ['/1', '/2', '/3']) {
      views.record({ path })
      await house.drain()
    }
    expect(sent).toEqual([['/1']])
    expect(errors).toHaveLength(1)

    recover()
    clock += 30_000
    views.record({ path: '/4' })
    await house.drain()
    expect(sent).toEqual([['/1'], ['/1', '/2', '/3', '/4']])
    expect(await views.pending()).toBe(0)
  })
})

describe('the local staging cap', () => {
  it('refuses records past batch.maxStaged and reports it, keeping what it holds', async () => {
    const errors: unknown[] = []
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 3, maxStaged: 3 },
      write: discard,
    })
    createHouse({ driver, schema: [views], now, onError: (error) => errors.push(error) })

    views.recordMany([{ path: '/1' }, { path: '/2' }])
    views.recordMany([{ path: '/3' }, { path: '/4' }])

    expect(errors.map((error) => (error as Error).message)).toEqual([
      'views: staging 2 more records would pass batch.maxStaged (3), with 2 already held in ' +
        'this process. Locally staged records only leave when a send succeeds, so this is a ' +
        'backlog that nothing is shipping',
    ])
    expect((await views.peek()).map((row) => row.path)).toEqual(['/1', '/2'])
  })

  it('counts records a send is still writing', async () => {
    const errors: unknown[] = []
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      batch: { maxSize: 2, maxStaged: 2 },
      write: () => new Promise<void>(() => {}),
    })
    createHouse({ driver, schema: [views], now, onError: (error) => errors.push(error) })

    views.recordMany([{ path: '/1' }, { path: '/2' }])
    views.record({ path: '/3' })
    expect(errors).toHaveLength(1)
    expect(await views.pending()).toBe(2)
  })

  it('defaults to 100,000 records', () => {
    const errors: unknown[] = []
    const views = event('views', { fields: { n: int() }, stage: 'local', write: discard })
    createHouse({ driver, schema: [views], now, onError: (error) => errors.push(error) })

    views.recordMany(Array.from({ length: 100_000 }, (_, n) => ({ n })))
    expect(errors).toEqual([])
    views.record({ n: 0 })
    expect((errors[0] as Error).message).toMatch(
      /^views: staging 1 more record would pass batch\.maxStaged \(100000\)/,
    )
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses a maxStaged of %s', (maxStaged) => {
    expect(() =>
      event('views', { fields: {}, stage: 'local', batch: { maxStaged }, write: discard }),
    ).toThrow(`views: batch.maxStaged must be a positive integer, got ${maxStaged}`)
  })

  it('refuses a maxStaged below maxSize, which no batch could ever fill', () => {
    expect(() =>
      event('views', {
        fields: {},
        stage: 'local',
        batch: { maxSize: 10, maxStaged: 9 },
        write: discard,
      }),
    ).toThrow('views: batch.maxStaged (9) must be at least batch.maxSize (10)')
  })
})

describe('stage: null', () => {
  it('is refused rather than read as driver', () => {
    expect(() =>
      event('e', { write: discard, fields: {}, stage: null as unknown as 'local' }),
    ).toThrow(new Error("e: stage must be 'driver' or 'local', got null"))
  })
})

describe('records staged under an earlier declaration', () => {
  /** Stage `records` into `views` on the shared driver, declared with `fields`. */
  async function stagedBefore(
    fields: Record<string, ReturnType<typeof str>>,
    records: Record<string, unknown>[],
  ): Promise<void> {
    const old = event('views', { fields, write: discard })
    createHouse({ driver, schema: [old], now })
    old.recordMany(records as never)
    await old.drain()
  }

  it('ships records a driver staged event left behind once it is staged locally', async () => {
    await stagedBefore({ path: str() }, [{ path: '/old1' }, { path: '/old2' }])
    const shipped: string[] = []
    const views = event('views', {
      fields: { path: str() },
      stage: 'local',
      write: (rows) => {
        shipped.push(...rows.map((row) => row.path))
      },
    })
    const house = createHouse({ driver, schema: [views], now })
    views.record({ path: '/new' })

    expect(await views.pending()).toBe(3)
    await house.flush({ force: true })
    expect(shipped).toEqual(['/old1', '/old2'])
    await house.stop()
    expect(shipped).toEqual(['/old1', '/old2', '/new'])
    expect(await driver.countPending('views')).toBe(0)
  })

  it('gives a record staged before sample was declared a _sample_rate of 1', async () => {
    await stagedBefore({ path: str() }, [{ path: '/' }])
    const views = event('views', { fields: { path: str() }, sample: 0.5, write: discard })
    createHouse({ driver, schema: [views], now })

    expect((await views.peek())[0]?._sample_rate).toBe(1)
  })

  it('fills a default declared after the record was staged', async () => {
    await stagedBefore({ path: str() }, [{ path: '/' }])
    const views = event('views', {
      fields: { path: str(), env: str().default('prod') },
      write: discard,
    })
    createHouse({ driver, schema: [views], now })

    expect((await views.peek())[0]?.env).toBe('prod')
  })

  it('refuses a stored value the field no longer accepts, naming the field', async () => {
    await stagedBefore({ n: str() }, [{ n: 'abc' }])
    const [staged] = await driver.readPending({ metric: 'views' })
    const views = event('views', { fields: { n: int() }, write: discard })
    createHouse({ driver, schema: [views], now })

    await expect(views.peek()).rejects.toThrow(
      new Error(
        `views: staged record ${staged?.id} holds a value field "n" no longer accepts. ` +
          'n: expected a safe integer, got "abc"',
      ),
    )
  })

  it('refuses a record missing a field that is now required, naming the field', async () => {
    await stagedBefore({ path: str() }, [{ path: '/' }])
    const [staged] = await driver.readPending({ metric: 'views' })
    const views = event('views', { fields: { path: str(), user: str() }, write: discard })
    createHouse({ driver, schema: [views], now })

    await expect(views.peek()).rejects.toThrow(
      new Error(
        `views: staged record ${staged?.id} has no value for field "user", which is now ` +
          'required and has no default',
      ),
    )
  })

  it('ships text stored under str() as JSON text once the field is json()', async () => {
    await stagedBefore({ note: str() }, [{ note: 'hello' }])
    const views = event('views', { fields: { note: json() }, write: discard })
    createHouse({ driver, schema: [views], now })

    expect((await views.peek())[0]?.note).toBe('"hello"')
  })
})

describe('immediate sends with a claimLimit', () => {
  it('keeps claiming while a claim comes back full', async () => {
    const sent: number[] = []
    const views = event('views', {
      fields: { path: str() },
      claimLimit: 2,
      write: (rows) => {
        sent.push(rows.length)
      },
    })
    const house = createHouse({ driver, schema: [views], now, delivery: 'immediate' })

    views.recordMany(Array.from({ length: 5 }, (_, i) => ({ path: `/${i}` })))
    await house.drain()
    expect(sent).toEqual([2, 2, 1])
    expect(await views.pending()).toBe(0)
  })

  it('stops claiming once a send fails', async () => {
    const sent: number[] = []
    const views = event('views', {
      fields: { path: str() },
      claimLimit: 2,
      write: (rows) => {
        sent.push(rows.length)
        throw new Error('down')
      },
    })
    const house = createHouse({
      driver,
      schema: [views],
      now,
      delivery: 'immediate',
      onError: () => {},
    })

    views.recordMany(Array.from({ length: 5 }, (_, i) => ({ path: `/${i}` })))
    await house.drain()
    expect(sent).toEqual([2])
    expect(await views.pending()).toBe(5)
  })
})

describe('ts() fields of locally staged records', () => {
  it('hands out a copy, so changing a row changes nothing that ships', async () => {
    const readings = event('readings', {
      fields: { at: ts() },
      stage: 'local',
      write: discard,
    })
    createHouse({ driver, schema: [readings], now })
    readings.record({ at: new Date(1_000) })

    const [row] = await readings.peek()
    row?.at.setTime(0)
    expect((await readings.peek())[0]?.at.getTime()).toBe(1_000)
  })
})
