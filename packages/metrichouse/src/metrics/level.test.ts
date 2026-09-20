import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { int, str } from '../schema/types.js'
import { type Level, type LevelConfig, level, MAX_CARRY_BUCKETS } from './level.js'
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

/** A sink that records every batch it is handed. */
function collector() {
  const batches: { rows: Row[]; context: WriteContext }[] = []
  const write: WriteFn = (rows, context) => {
    batches.push({ rows: rows.map((row) => ({ ...row })), context })
  }
  return {
    write,
    batches,
    /** Every row across every batch, in the order they shipped. */
    get rows(): Row[] {
      return batches.flatMap((batch) => batch.rows)
    },
    /** `bucket_ts` (as an offset from the epoch) paired with `value`. */
    get shape(): [number, unknown][] {
      return this.rows.map((row) => [(row.bucket_ts as Date).getTime(), row.value])
    },
  }
}

type LevelDims = { queue: ReturnType<typeof str> }

const EMAIL = { queue: 'email' } as const
const EXPORT = { queue: 'export' } as const

/** On a 10s boundary. */
const BASE = 1_788_616_980_000

let clock: number
let driver: Driver
const now = () => clock

/** A whole number of resolutions past the start. Fixed, so moving the clock
 * to `at(5)` does not move what `at(0)` means. */
const at = (buckets: number) => BASE + buckets * 10_000

const make = (overrides: Partial<LevelConfig<LevelDims>> = {}) =>
  level('queue_depth', {
    dims: { queue: str() },
    resolution: '10s',
    flush: '10s',
    ...overrides,
    write: overrides.write ?? discard,
  })

function bound(overrides: Partial<LevelConfig<LevelDims>> = {}): Level<LevelDims> {
  const metric = make(overrides)
  metric.bind({ driver, now })
  return metric
}

beforeEach(() => {
  clock = BASE
  driver = memory()
})

describe('declaration', () => {
  it('exposes what it was declared with', () => {
    const metric = make()
    expect(metric.name).toBe('queue_depth')
    expect(metric.kind).toBe('level')
    expect(metric.storage).toBe('bucketed')
    expect(metric.resolutionMs).toBe(10_000)
    expect(metric.flushMs).toBe(10_000)
    expect(metric.graceMs).toBe(2000)
    expect(metric.holdForMs).toBeUndefined()
  })

  it('holds without expiry unless told otherwise', () => {
    expect(make({ holdFor: '1h' }).holdForMs).toBe(3_600_000)
  })

  it('rejects a holdFor shorter than one window', () => {
    expect(expectRejected(() => make({ holdFor: '1s' })).message).toMatch(/holdFor/)
  })

  it('rejects an empty name', () => {
    expect(expectRejected(() => level('', { resolution: '1s', write: discard })).message).toMatch(
      /non-empty/,
    )
  })

  it('takes fractions unless declared an integer', () => {
    expect(make().isFloat).toBe(true)
    expect(make({ value: int() }).isFloat).toBe(false)
  })

  it('is inert until a house binds it', () => {
    expect(expectRejected(() => make().set(1, EMAIL)).message).toMatch(/not bound/)
  })

  it('refuses a second house', () => {
    const metric = bound()
    expect(expectRejected(() => metric.bind({ driver, now })).message).toMatch(/already bound/)
  })

  it('describes the row a sink will receive', () => {
    expect(make().rowShape().columns).toEqual([
      { name: 'id', kind: 'str', optional: false },
      { name: 'bucket_ts', kind: 'ts', optional: false },
      { name: 'queue', kind: 'str', optional: false },
      { name: 'value', kind: 'float', optional: false },
    ])
  })
})

describe('writing', () => {
  it('puts a series at a value and keeps it there', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    await metric.drain()

    expect(await metric.current(EMAIL)).toBe(42)
  })

  it('replaces rather than accumulates', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    metric.set(7, EMAIL)
    await metric.drain()

    expect(await metric.current(EMAIL)).toBe(7)
  })

  it('moves a series up and down', async () => {
    const metric = bound()
    metric.inc(EMAIL)
    metric.inc(4, EMAIL)
    metric.dec(EMAIL)
    metric.dec(2, EMAIL)
    await metric.drain()

    expect(await metric.current(EMAIL)).toBe(2)
  })

  it('starts an untouched series at zero when moved', async () => {
    const metric = bound()
    metric.dec(3, EMAIL)
    await metric.drain()

    expect(await metric.current(EMAIL)).toBe(-3)
  })

  it('keeps series apart', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    metric.set(7, EXPORT)
    await metric.drain()

    expect(await metric.current(EMAIL)).toBe(42)
    expect(await metric.current(EXPORT)).toBe(7)
  })

  it('refuses a value that is not a finite number', async () => {
    const metric = bound()
    expect(expectRejected(() => metric.set(Number.NaN, EMAIL)).message).toMatch(/finite/)
    expect(expectRejected(() => metric.set(Number.POSITIVE_INFINITY, EMAIL)).message).toMatch(
      /finite/,
    )
  })

  it('refuses a fraction on an integer level', () => {
    const metric = bound({ value: int() })
    expect(expectRejected(() => metric.set(1.5, EMAIL)).message).toMatch(/integer level/)
  })

  it('refuses an undeclared dim', () => {
    const metric = bound()
    expect(
      expectRejected(() => metric.set(1, { park: 'riverside' } as unknown as typeof EMAIL)).message,
    ).toMatch(/park/)
  })
})

describe('reading', () => {
  it('is undefined for a series nothing has written to', async () => {
    const metric = bound()
    expect(await metric.current(EMAIL)).toBeUndefined()
    expect(await metric.totals()).toBeUndefined()
  })

  it('adds every series up', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    metric.set(8, EXPORT)
    await metric.drain()

    expect(await metric.totals()).toBe(50)
  })

  it('answers from the held value, not from the open window', async () => {
    // the whole difference from a gauge: nothing was written this window
    const metric = bound()
    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(5)
    expect(await metric.current(EMAIL)).toBe(42)
  })

  it('reports the held value after the buckets have shipped', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(2)
    await metric.flush()

    expect(await metric.snapshot()).toEqual([])
    expect(await metric.current(EMAIL)).toBe(42)
  })
})

describe('carrying', () => {
  it('fills every window between a write and the flush', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()

    // four windows have closed since the write, and only the first holds a
    // value anybody wrote
    clock = at(5)
    await metric.flush()

    expect(sink.shape).toEqual([
      [at(0), 42],
      [at(1), 42],
      [at(2), 42],
      [at(3), 42],
    ])
  })

  it('does not reship a window it has already carried', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(3)
    await metric.flush()
    clock = at(5)
    await metric.flush()

    expect(sink.shape).toEqual([
      [at(0), 42],
      [at(1), 42],
      [at(2), 42],
      [at(3), 42],
    ])
  })

  it('keeps carrying across a gap between two writes', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()

    // written again four windows later, with no flush in between: the
    // windows either side of the gap are still owed a row
    clock = at(4)
    metric.set(7, EMAIL)
    await metric.drain()

    clock = at(6)
    await metric.flush()

    expect(sink.shape).toEqual([
      [at(0), 42],
      [at(1), 42],
      [at(2), 42],
      [at(3), 42],
      [at(4), 7],
    ])
  })

  it('lets a written value beat a carried one in the same window', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()
    clock = at(1)
    metric.set(7, EMAIL)
    await metric.drain()

    clock = at(3)
    await metric.flush()

    // grace holds the newest closed window back, so at(2) is not shipped yet
    expect(sink.shape).toEqual([
      [at(0), 42],
      [at(1), 7],
    ])
  })

  it('carries every series independently', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()
    clock = at(2)
    metric.set(7, EXPORT)
    await metric.drain()

    clock = at(4)
    await metric.flush()

    const shipped = sink.rows
      .map(
        (row) =>
          `${row.queue}@${((row.bucket_ts as Date).getTime() - at(0)) / 10_000}=${row.value}`,
      )
      .sort()

    // email was written once and carried through; export only exists from
    // the window it was first written in
    expect(shipped).toEqual(['email@0=42', 'email@1=42', 'email@2=42', 'export@2=7'])
  })

  it('carries nothing for a series that has never been written to', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    clock = at(5)
    await metric.flush()

    expect(sink.rows).toEqual([])
  })

  it('never carries into the open window', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(3)
    await metric.flush()

    // the window at(3) is still open, so it is nobody's to ship yet
    expect(sink.shape.map(([bucket]) => bucket)).not.toContain(at(3))
  })

  it('leaves a gap rather than backfilling a long outage', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()

    // back after far longer than the cap allows
    clock = at(MAX_CARRY_BUCKETS + 50)
    await metric.flush()

    const buckets = sink.shape.map(([bucket]) => bucket)

    // the window that was actually written is still live and ships, and
    // after it the carry picks up at the cap rather than at the write
    expect(buckets).toHaveLength(MAX_CARRY_BUCKETS + 1)
    expect(buckets[0]).toBe(at(0))
    expect(buckets[1]).toBe(at(49))
    expect(buckets.at(-1)).toBe(at(MAX_CARRY_BUCKETS + 48))
  })

  it('stops carrying once holdFor has passed', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write, holdFor: '30s' })

    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(8)
    await metric.flush()

    // written at(0), held for three more windows, then dropped
    expect(sink.shape).toEqual([
      [at(0), 42],
      [at(1), 42],
      [at(2), 42],
      [at(3), 42],
    ])
    expect(await metric.current(EMAIL)).toBeUndefined()
  })

  it('starts holding again when a dropped series is written to', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write, holdFor: '30s' })

    metric.set(42, EMAIL)
    await metric.drain()
    clock = at(8)
    await metric.flush()

    metric.set(7, EMAIL)
    await metric.drain()
    clock = at(10)
    await metric.flush()

    expect(sink.shape.slice(-1)).toEqual([[at(8), 7]])
  })
})

describe('the batch a sink receives', () => {
  it('reports where every series stood at the end of it', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    metric.set(8, EXPORT)
    await metric.drain()

    clock = at(3)
    await metric.flush()

    // 50 across the newest window, not 150 summed over all three
    expect(sink.batches[0]?.context.total).toBe(50)
    expect(sink.batches[0]?.context.kind).toBe('level')
  })

  it('carries the declared dims onto every row', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })

    metric.set(42, EMAIL)
    await metric.drain()
    clock = at(2)
    await metric.flush()

    expect(sink.rows[0]).toMatchObject({ queue: 'email', value: 42 })
    expect(sink.rows[0]?.id).toEqual(expect.any(String))
  })

  it('releases the claim when the sink throws, and reships next time', async () => {
    let attempts = 0
    const sink = collector()
    const metric = bound({
      write: (rows, context) => {
        attempts += 1
        if (attempts === 1) throw new Error('sink is down')
        sink.write(rows, context)
      },
    })

    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(2)
    const failed = await metric.flush()
    expect(failed.error).toBeInstanceOf(Error)

    await metric.flush({ force: true })
    expect(sink.shape).toEqual([[at(0), 42]])
  })
})

describe('snapshot', () => {
  it('returns a row per window per series', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    metric.set(8, EXPORT)
    await metric.drain()
    clock = at(1)

    const rows = await metric.snapshot()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.value).sort((a, b) => a - b)).toEqual([8, 42])
  })

  it('takes the latest when rolling several windows into one', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    await metric.drain()
    clock = at(1)
    metric.set(7, EMAIL)
    await metric.drain()
    clock = at(2)

    const rows = await metric.snapshot({ rollup: 'sum' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe(7)
  })

  it('adds series up when a groupBy drops the dim that told them apart', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    metric.set(8, EXPORT)
    await metric.drain()
    clock = at(1)

    const rows = await metric.snapshot({ groupBy: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value: 50 })
  })

  it('takes the latest per series, then adds, when it does both', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    metric.set(8, EXPORT)
    await metric.drain()

    clock = at(1)
    metric.set(1, EMAIL)
    await metric.drain()
    clock = at(2)

    const rows = await metric.snapshot({ rollup: 'sum', groupBy: [] })
    expect(rows).toHaveLength(1)
    // email's latest is 1, export never moved off 8
    expect(rows[0]).toMatchObject({ value: 9 })
  })
})

describe('a level with no dims', () => {
  const plain = () => {
    const metric = level('in_flight', { resolution: '10s', flush: '10s', write: discard })
    metric.bind({ driver, now })
    return metric
  }

  it('takes a bare value', async () => {
    const metric = plain()
    metric.set(3)
    await metric.drain()
    expect(await metric.current()).toBe(3)
  })

  it('reads a bare delta as a delta and not as dims', async () => {
    const metric = plain()
    metric.inc(5)
    metric.inc()
    metric.dec(2)
    await metric.drain()
    expect(await metric.current()).toBe(4)
  })
})
