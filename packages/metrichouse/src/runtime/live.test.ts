import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { type Counter, counter } from '../metrics/counter.js'
import { type Event, event } from '../metrics/event.js'
import { type Gauge, gauge } from '../metrics/gauge.js'
import { type Log, log } from '../metrics/log.js'
import { timer } from '../metrics/timer.js'
import type { AnyMetric, WriteFn } from '../metrics/types.js'
import { encodeDimKey } from '../schema/dims.js'
import { oneOf, str } from '../schema/types.js'
import { createHouse } from './house.js'
import { liveness, snapshotRange } from './live.js'

/** A sink that keeps nothing — for declaration tests that never ship. */
const discard: WriteFn = () => {}

const DIMS = { park: str(), kind: oneOf(['solid', 'liquid'] as const) }
const RIVERSIDE = { park: 'riverside', kind: 'solid' } as const
const CENTRAL = { park: 'central', kind: 'liquid' } as const

let clock: number
let driver: Driver
const now = () => clock

beforeEach(() => {
  clock = 1_788_616_987_000 // exactly on a 1s boundary
  driver = memory()
})

// ---------------------------------------------------------------------------
// the pure half — no driver, no metric
// ---------------------------------------------------------------------------

describe('liveness', () => {
  it('marks a bucket open until its resolution has elapsed', () => {
    expect(liveness(1_000, 1_000, 1_400)).toEqual({ bucket_open: true, bucket_elapsed_ms: 400 })
    expect(liveness(1_000, 1_000, 2_000)).toEqual({ bucket_open: false, bucket_elapsed_ms: 1_000 })
  })

  it('caps elapsed at one resolution however long ago the bucket closed', () => {
    expect(liveness(1_000, 1_000, 900_000).bucket_elapsed_ms).toBe(1_000)
  })

  it('reads zero rather than negative when the clock steps backwards', () => {
    expect(liveness(5_000, 1_000, 4_000).bucket_elapsed_ms).toBe(0)
  })
})

describe('snapshotRange', () => {
  it('excludes the open bucket by default', () => {
    expect(snapshotRange({}, 1_000, 10_400)).toEqual({ to: 10_000 })
  })

  it('includes it when asked, with no upper bound at all', () => {
    expect(snapshotRange({ complete: false }, 1_000, 10_400)).toEqual({})
  })

  it('applies `to` and `complete` together — one does not waive the other', () => {
    expect(snapshotRange({ to: 50_000 }, 1_000, 10_400)).toEqual({ to: 10_000 })
    expect(snapshotRange({ to: 5_000 }, 1_000, 10_400)).toEqual({ to: 5_000 })
    expect(snapshotRange({ to: 5_000, complete: false }, 1_000, 10_400)).toEqual({ to: 5_000 })
  })

  it('takes Dates as well as milliseconds', () => {
    expect(snapshotRange({ from: new Date(3_000), complete: false }, 1_000, 10_400)).toEqual({
      from: 3_000,
    })
  })
})

// ---------------------------------------------------------------------------
// counter
// ---------------------------------------------------------------------------

describe('counter.snapshot', () => {
  const makeCounter = () =>
    counter('dog_poops', { write: discard, dims: DIMS, resolution: '1s', flush: '5m', grace: '0s' })

  /** Three buckets: two closed, one open, with a second series in the middle. */
  const seed = async (
    dogPoops: ReturnType<typeof makeCounter>,
    house: { drain(): Promise<void> },
  ) => {
    dogPoops.add(2, RIVERSIDE)
    clock += 1_000
    dogPoops.add(3, RIVERSIDE)
    dogPoops.add(9, CENTRAL)
    clock += 1_000
    dogPoops.add(1, RIVERSIDE) // the open bucket
    await house.drain()
  }

  it('returns every closed unflushed bucket, and not the open one', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const rows = await dogPoops.snapshot()

    expect(rows).toHaveLength(3) // 2 buckets, 3 series-buckets
    expect(rows.every((row) => row.bucket_open === false)).toBe(true)
    expect(rows.every((row) => row.bucket_elapsed_ms === 1_000)).toBe(true)
  })

  it('includes the open bucket under complete: false, and says it is partial', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)
    clock += 400 // 40% into the open bucket

    const rows = await dogPoops.snapshot({ complete: false })
    const open = rows.filter((row) => row.bucket_open)

    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ value: 1, bucket_open: true, bucket_elapsed_ms: 400 })
  })

  it('carries the id and bucket_ts a sink would receive', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    const at = clock
    dogPoops.add(2, RIVERSIDE)
    clock += 1_000
    await house.drain()

    const [row] = await dogPoops.snapshot()
    expect(row).toMatchObject({
      id: rowId('dog_poops', at, encodeDimKey(DIMS, RIVERSIDE)),
      bucket_ts: new Date(at),
      park: 'riverside',
      kind: 'solid',
      value: 2,
    })
  })

  it('filters on a partial dim match', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const rows = await dogPoops.snapshot({ dims: { park: 'riverside' } })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.park === 'riverside')).toBe(true)
  })

  it('rejects a dim filter naming something undeclared', async () => {
    const dogPoops = makeCounter()
    createHouse({ driver, schema: [dogPoops], now })
    await expect(dogPoops.snapshot({ dims: { pakr: 'riverside' } })).rejects.toThrow(
      /not a declared dim/,
    )
  })

  it('restricts the bucket range', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    const first = clock
    await seed(dogPoops, house)

    const rows = await dogPoops.snapshot({ from: first + 1_000 })
    expect(rows).toHaveLength(2) // only the second bucket's two series
  })

  it('rolls buckets up per series, dropping the identity that no longer applies', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const rows = await dogPoops.snapshot({ rollup: 'sum' })

    expect(rows).toHaveLength(2) // one per series
    const riverside = rows.find((row) => row.park === 'riverside')
    expect(riverside).toMatchObject({ park: 'riverside', kind: 'solid', value: 5 })
    expect(riverside).not.toHaveProperty('bucket_ts')
    expect(riverside).not.toHaveProperty('id')
    // two closed buckets merged, so twice a resolution has elapsed
    expect(riverside?.bucket_elapsed_ms).toBe(2_000)
  })

  it('marks a rollup partial when any bucket in it is still open', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const closed = await dogPoops.snapshot({ rollup: 'sum', dims: { park: 'riverside' } })
    expect(closed[0]?.bucket_open).toBe(false)

    const withOpen = await dogPoops.snapshot({
      rollup: 'sum',
      complete: false,
      dims: { park: 'riverside' },
    })
    expect(withOpen[0]).toMatchObject({ value: 6, bucket_open: true })
  })

  it('collapses to the dims named by groupBy', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const rows = await dogPoops.snapshot({ groupBy: ['kind'], rollup: 'sum' })

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.kind === 'solid')).toMatchObject({ value: 5 })
    expect(rows.find((row) => row.kind === 'liquid')).toMatchObject({ value: 9 })
    expect(rows[0]).not.toHaveProperty('park')
  })

  it('keeps buckets while grouping dims when rollup is none', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const rows = await dogPoops.snapshot({ groupBy: ['park'] })
    expect(rows).toHaveLength(3) // riverside x2 buckets, central x1
    expect(rows.every((row) => 'bucket_ts' in row)).toBe(true)
  })

  it('rejects a groupBy naming something undeclared', async () => {
    const dogPoops = makeCounter()
    createHouse({ driver, schema: [dogPoops], now })
    await expect(dogPoops.snapshot({ groupBy: ['nope'] })).rejects.toThrow(/not a declared dim/)
  })

  it('sorts before limiting, so limit means top-K', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    const top = await dogPoops.snapshot({ rollup: 'sum', orderBy: 'value', limit: 1 })
    expect(top).toHaveLength(1)
    expect(top[0]).toMatchObject({ park: 'central', value: 9 })

    const bottom = await dogPoops.snapshot({
      rollup: 'sum',
      orderBy: 'value',
      direction: 'asc',
      limit: 1,
    })
    expect(bottom[0]).toMatchObject({ park: 'riverside', value: 5 })
  })

  it('rejects an orderBy that is not a column on the rows', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)
    await expect(dogPoops.snapshot({ orderBy: 'nope' })).rejects.toThrow(/not a column/)
  })

  it('cannot see data a flush has claimed', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], now })
    await seed(dogPoops, house)

    expect(await dogPoops.snapshot()).toHaveLength(3)
    await house.flush({ force: true })
    expect(await dogPoops.snapshot()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// gauge and timer
// ---------------------------------------------------------------------------

describe('gauge.snapshot', () => {
  it('merges folds the way the five aggregates merge', async () => {
    const latency = gauge('latency', {
      write: discard,
      dims: { park: str() },
      resolution: '1s',
      flush: '5m',
      grace: '0s',
    })
    const house = createHouse({ driver, schema: [latency], now })

    latency.set(10, { park: 'riverside' })
    latency.set(2, { park: 'riverside' })
    clock += 1_000
    latency.set(7, { park: 'riverside' })
    clock += 1_000
    await house.drain()

    const [merged] = await latency.snapshot({ rollup: 'sum' })
    expect(merged).toMatchObject({
      min: 2,
      max: 10,
      sum: 19,
      count: 3,
      // the latest observation in bucket order, which is the only honest answer
      last: 7,
    })
  })

  it('merges only the aggregates the gauge declares', async () => {
    const latency = gauge('latency', {
      write: discard,
      dims: { park: str() },
      resolution: '1s',
      flush: '5m',
      grace: '0s',
      aggregate: ['min', 'count'],
    })
    const house = createHouse({ driver, schema: [latency], now })

    latency.set(10, { park: 'riverside' })
    clock += 1_000
    latency.set(2, { park: 'riverside' })
    clock += 1_000
    await house.drain()

    const [merged] = await latency.snapshot({ rollup: 'sum' })
    expect(merged).toMatchObject({ min: 2, count: 2 })
    expect(merged).not.toHaveProperty('sum')
    expect(merged).not.toHaveProperty('max')
    expect(merged).not.toHaveProperty('last')
  })
})

describe('timer.snapshot', () => {
  it('reads through the gauge underneath it', async () => {
    const work = timer('work', {
      write: discard,
      dims: { park: str() },
      resolution: '1s',
      flush: '5m',
      grace: '0s',
    })
    const house = createHouse({ driver, schema: [work], now })

    work.observe(12.5, { park: 'riverside' })
    clock += 1_000
    await house.drain()

    const rows = await work.snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ count: 1, sum: 12.5, bucket_open: false })
    expect(work.storage).toBe('bucketed')
  })
})

// ---------------------------------------------------------------------------
// staged kinds
// ---------------------------------------------------------------------------

describe('staged snapshot', () => {
  const makeEvent = (over = {}) =>
    event('signups', { write: discard, fields: { plan: str() }, ...over })

  it('returns unshipped records, never partial', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], now })

    signups.record({ plan: 'pro' })
    signups.record({ plan: 'free' })
    await house.drain()

    const rows = await signups.snapshot()
    expect(rows).toHaveLength(2)
    // a record is complete the instant it is appended, so `complete: true`
    // cannot exclude it
    expect(rows.every((row) => row.bucket_open === false)).toBe(true)
    expect(rows[0]).toMatchObject({ plan: 'pro' })
  })

  it('honours from, to and limit', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], now })

    const first = clock
    signups.record({ plan: 'pro' })
    clock += 5_000
    signups.record({ plan: 'free' })
    await house.drain()

    expect(await signups.snapshot({ from: first + 1 })).toHaveLength(1)
    expect(await signups.snapshot({ to: first + 1 })).toHaveLength(1)
    expect(await signups.snapshot({ limit: 1 })).toHaveLength(1)
  })

  it('reads a local buffer the same way it reads the driver', async () => {
    const signups = makeEvent({ stage: 'local', batch: { maxSize: 500 } })
    createHouse({ driver, schema: [signups], now })

    // deliberately not drained: `drain()` ships a local buffer, which is the
    // whole point of it, so there would be nothing left to read
    signups.record({ plan: 'pro' })

    expect(await signups.snapshot()).toHaveLength(1)
  })

  it('ignores aggregate-only options rather than rejecting them', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], now })
    signups.record({ plan: 'pro' })
    await house.drain()

    await expect(signups.snapshot({ rollup: 'sum', groupBy: ['nope'] })).resolves.toHaveLength(1)
  })

  it('sorts on orderBy before it applies limit', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], now })
    signups.recordMany([{ plan: 'free' }, { plan: 'pro' }, { plan: 'team' }])
    await house.drain()

    const top = await signups.snapshot({ orderBy: 'plan', direction: 'desc', limit: 2 })
    expect(top.map((row) => row.plan)).toEqual(['team', 'pro'])
    const bottom = await signups.snapshot({ orderBy: 'plan', direction: 'asc', limit: 1 })
    expect(bottom.map((row) => row.plan)).toEqual(['free'])
  })

  it('refuses an orderBy that names no column, as the aggregate kinds do', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], now })
    signups.record({ plan: 'pro' })
    await house.drain()

    await expect(signups.snapshot({ orderBy: 'nope' })).rejects.toThrow(/orderBy names "nope"/)
  })

  it('refuses a limit that is not a whole number of rows', async () => {
    const signups = makeEvent()
    createHouse({ driver, schema: [signups], now })
    await expect(signups.snapshot({ limit: -1 })).rejects.toThrow(/non-negative integer/)
    await expect(signups.snapshot({ limit: 1.5 })).rejects.toThrow(/non-negative integer/)
    await expect(signups.peek(-1)).rejects.toThrow(/non-negative integer/)
    await expect(signups.peek(0)).resolves.toEqual([])
  })

  it('carries a log through the event underneath it', async () => {
    const applog = log('app_log', { write: discard, fields: { requestId: str() } })
    const house = createHouse({ driver, schema: [applog], now })

    applog.info('started', { requestId: 'abc' })
    await house.drain()

    const rows = await applog.snapshot()
    expect(rows[0]).toMatchObject({ level: 'info', message: 'started', requestId: 'abc' })
    expect(applog.storage).toBe('staged')
  })
})

// ---------------------------------------------------------------------------
// house
// ---------------------------------------------------------------------------

describe('house.snapshot', () => {
  const build = () => {
    const dogPoops = counter('dog_poops', {
      write: discard,
      dims: DIMS,
      resolution: '1s',
      flush: '5m',
      grace: '0s',
    })
    const signups = event('signups', { write: discard, fields: { plan: str() } })
    const house = createHouse({ driver, schema: [dogPoops, signups], now })
    return { dogPoops, signups, house }
  }

  it('reports every metric, keyed by name', async () => {
    const { dogPoops, signups, house } = build()
    dogPoops.add(2, RIVERSIDE)
    signups.record({ plan: 'pro' })
    clock += 1_000
    await house.drain()

    const snapshot = await house.snapshot()
    expect(Object.keys(snapshot).sort()).toEqual(['dog_poops', 'signups'])
    expect(snapshot.dog_poops).toHaveLength(1)
    expect(snapshot.signups).toHaveLength(1)
  })

  it('restricts to the metrics named by only', async () => {
    const { dogPoops, signups, house } = build()
    dogPoops.add(2, RIVERSIDE)
    signups.record({ plan: 'pro' })
    clock += 1_000
    await house.drain()

    expect(Object.keys(await house.snapshot({ only: ['signups'] }))).toEqual(['signups'])
  })

  it('takes one set of options across a mixed schema', async () => {
    const { dogPoops, signups, house } = build()
    dogPoops.add(2, RIVERSIDE)
    signups.record({ plan: 'pro' })
    clock += 1_000
    await house.drain()

    const snapshot = await house.snapshot({ rollup: 'sum' })
    expect(snapshot.dog_poops?.[0]).toMatchObject({ value: 2 })
    expect(snapshot.signups).toHaveLength(1)
  })
})

describe('house.current', () => {
  it('reports the open bucket, and only bucketed kinds', async () => {
    const dogPoops = counter('dog_poops', {
      write: discard,
      dims: DIMS,
      resolution: '1s',
      flush: '5m',
      grace: '0s',
    })
    const signups = event('signups', { write: discard, fields: { plan: str() } })
    const house = createHouse({ driver, schema: [dogPoops, signups], now })

    dogPoops.add(2, RIVERSIDE) // a closed bucket, once the clock moves
    clock += 1_000
    dogPoops.add(5, RIVERSIDE) // the open one
    signups.record({ plan: 'pro' })
    await house.drain()

    const current = await house.current()

    // an event has no open bucket, so it is absent rather than empty
    expect(Object.keys(current)).toEqual(['dog_poops'])
    expect(current.dog_poops).toHaveLength(1)
    expect(current.dog_poops?.[0]).toMatchObject({ value: 5, bucket_open: true })
  })

  it('reads each metric against its own resolution', async () => {
    const fast = counter('fast', { write: discard, resolution: '1s', flush: '5m', grace: '0s' })
    const slow = counter('slow', { write: discard, resolution: '1m', flush: '5m', grace: '0s' })
    const house = createHouse({ driver, schema: [fast, slow], now })

    fast.add(1)
    slow.add(1)
    clock += 1_000 // closes `fast`'s bucket, leaves `slow`'s open
    fast.add(7)
    await house.drain()

    const current = await house.current()
    expect(current.fast?.[0]).toMatchObject({ value: 7 })
    expect(current.slow?.[0]).toMatchObject({ value: 1 })
  })
})

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------
// Never called — declared solely so `tsc` checks these call sites. The runtime
// behaviour above says the rows are right; this says the types describing them
// are, which is the half a passing test cannot see. Rows are read by iterating
// rather than indexing, so none of it needs a non-null assertion.

type Dims = { park: ReturnType<typeof str>; kind: ReturnType<typeof oneOf<['solid', 'liquid']>> }

async function _snapshotRowTypes(metric: Counter<Dims>): Promise<void> {
  for (const row of await metric.snapshot()) {
    // the point of the exercise: dims come back typed, not `unknown`
    const _park: string = row.park
    const _kind: 'solid' | 'liquid' = row.kind
    const _value: number = row.value
    const _open: boolean = row.bucket_open
    const _elapsed: number = row.bucket_elapsed_ms
    // an unrolled row is still one bucket's row, so it keeps its identity
    const _id: string = row.id
    const _ts: Date = row.bucket_ts
    void [_park, _kind, _value, _open, _elapsed, _id, _ts]

    // @ts-expect-error breed was never declared
    void row.breed
    // @ts-expect-error a park is a string, not a number
    const _wrong: number = row.park
    void _wrong
  }
}

async function _rollupRowTypes(metric: Counter<Dims>): Promise<void> {
  for (const row of await metric.snapshot({ rollup: 'sum' })) {
    const _value: number = row.value
    const _park: string = row.park
    void [_value, _park]

    // @ts-expect-error a rolled-up row is no longer one bucket's row
    void row.id
    // @ts-expect-error nor does it belong to one bucket
    void row.bucket_ts
  }
}

async function _groupByRowTypes(metric: Counter<Dims>): Promise<void> {
  for (const row of await metric.snapshot({ groupBy: ['kind'], rollup: 'sum' })) {
    const _kind: 'solid' | 'liquid' = row.kind
    void _kind

    // @ts-expect-error park was grouped away
    void row.park
  }
}

async function _gaugeRowTypes(metric: Gauge<{ park: ReturnType<typeof str> }>): Promise<void> {
  for (const row of await metric.snapshot()) {
    const _park: string = row.park
    // Partial, because which aggregates reach a row is a runtime setting
    const _min: number | undefined = row.min
    void [_park, _min]

    // @ts-expect-error avg is never stored — it is sum / count at query time
    void row.avg
  }
}

async function _stagedRowTypes(
  metric: Event<{ plan: ReturnType<typeof str> }>,
  logger: Log<{ requestId: ReturnType<typeof str> }, ['debug', 'info']>,
): Promise<void> {
  for (const record of await metric.snapshot()) {
    const _plan: string = record.plan
    const _ts: Date = record.ts
    // never partial: a record is complete the instant it is appended
    const _open: boolean = record.bucket_open
    void [_plan, _ts, _open]

    // @ts-expect-error a record has no bucket to be a fraction of
    void record.bucket_ts
  }

  for (const line of await logger.snapshot()) {
    const _level: 'debug' | 'info' = line.level
    const _message: string = line.message
    const _requestId: string = line.requestId
    void [_level, _message, _requestId]

    // @ts-expect-error 'fatal' is not one of this log's declared levels
    const _bad: 'fatal' = line.level
    void _bad
  }
}

/** The erased surface stays erased — that is what makes a mixed house work. */
async function _erasedStaysErased(metric: AnyMetric): Promise<void> {
  for (const row of await metric.snapshot()) {
    const _open: boolean = row.bucket_open
    void _open

    // @ts-expect-error an erased row cannot promise a column it never heard of
    const _park: string = row.park
    void _park
  }
}

void [
  _snapshotRowTypes,
  _rollupRowTypes,
  _groupByRowTypes,
  _gaugeRowTypes,
  _stagedRowTypes,
  _erasedStaysErased,
]

describe('merging series inside one window', () => {
  it('counts a window once in bucket_elapsed_ms, however many series it holds', async () => {
    const hits = counter('hits', { dims: DIMS, resolution: '10s', flush: '1m', write: discard })
    createHouse({ driver, schema: [hits], now })
    hits.add(RIVERSIDE)
    hits.add(CENTRAL)
    hits.add({ park: 'north', kind: 'solid' })
    await hits.drain()

    // five seconds into the window the three writes landed in
    clock = Math.floor(clock / 10_000) * 10_000 + 5_000
    const rows = await hits.snapshot({ complete: false, groupBy: ['kind'] })
    const solid = rows.find((row) => row.kind === 'solid')
    // two series merged into one window: still five seconds, not ten
    expect(solid).toMatchObject({ value: 2, bucket_elapsed_ms: 5_000 })
  })

  it('leaves last off a gauge row that merged several series in its newest window', async () => {
    const temp = gauge('temp', { dims: DIMS, resolution: '10s', flush: '1m', write: discard })
    createHouse({ driver, schema: [temp], now })
    temp.set(30, RIVERSIDE)
    temp.set(10, CENTRAL)
    await temp.drain()

    const [merged] = await temp.snapshot({ complete: false, groupBy: [] })
    expect(merged).not.toHaveProperty('last')
    expect(merged).toMatchObject({ min: 10, max: 30, count: 2 })

    const [one] = await temp.snapshot({ complete: false, groupBy: ['park'], dims: RIVERSIDE })
    expect(one?.last).toBe(30)
  })
})
