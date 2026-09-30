import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ioredis } from '../drivers/ioredis.js'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { int, str } from '../schema/types.js'
import { type Level, type LevelConfig, level, MAX_CARRY_BUCKETS } from './level.js'
import type { Row, WriteContext, WriteFn } from './types.js'

/** A sink that keeps nothing, for declaration tests that never ship. */
const discard: WriteFn = () => {}

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
    expect(() => make({ holdFor: '1s' })).toThrow(
      'queue_depth: holdFor must be at least one resolution, because a shorter one would drop a series before the window it was written in had closed',
    )
  })

  it('rejects an empty name', () => {
    expect(() => level('', { resolution: '1s', write: discard })).toThrow(
      'level: name must be a non-empty string',
    )
  })

  it('takes fractions unless declared an integer', () => {
    expect(make().isFloat).toBe(true)
    expect(make({ value: int() }).isFloat).toBe(false)
  })

  it('is inert until a house binds it', () => {
    expect(() => make().set(1, EMAIL)).toThrow(
      'queue_depth: not bound to a house. Pass it to createHouse({ schema }) before writing',
    )
  })

  it('refuses a second house', () => {
    const metric = bound()
    expect(() => metric.bind({ driver, now })).toThrow(
      'queue_depth: already bound to a house, and a metric belongs to exactly one',
    )
  })

  it('stays unbound when a binding is refused', () => {
    const metric = level('odd', { resolution: '7s', write: discard })
    expect(() => metric.bind({ driver, now, defaults: { flushMs: 60_000 } })).toThrow(
      /does not divide/,
    )
    expect(metric.isBound).toBe(false)
  })

  it.each(['id', 'bucket_ts', 'value'])('refuses a dim named %s, a column it writes', (dim) => {
    expect(() =>
      level('by_col', { dims: { [dim]: str() }, resolution: '10s', write: discard }),
    ).toThrow(
      new Error(
        `by_col: dim "${dim}" is a reserved column. MetricHouse writes [id, bucket_ts, value] ` +
          'on every row',
      ),
    )
  })

  it('marks a dim with a default as a column every row carries', () => {
    const metric = level('l', {
      dims: { queue: str().default('email') },
      resolution: '10s',
      write: discard,
    })
    expect(metric.rowShape().columns[2]).toEqual({ name: 'queue', kind: 'str', optional: false })
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

  it('names the type of a value that is not a number', () => {
    const metric = bound()
    expect(() => metric.set('1' as never, EMAIL)).toThrow(
      'queue_depth: value must be a finite number, got "1"',
    )
  })

  it('names the kind of a cell it refuses', () => {
    const metric = bound()
    expect(() => metric.materialize(BASE, 'email', 7)).toThrow(
      'queue_depth: expected a level cell but the driver returned a counter cell',
    )
    expect(() =>
      metric.materialize(BASE, 'email', { last: 1, min: 1, max: 1, sum: 1, count: 1 } as never),
    ).toThrow('queue_depth: expected a level cell but the driver returned a gauge fold')
  })

  it('refuses a value that is not a finite number', async () => {
    const metric = bound()
    expect(() => metric.set(Number.NaN, EMAIL)).toThrow(
      'queue_depth: value must be a finite number, got NaN',
    )
    expect(() => metric.set(Number.POSITIVE_INFINITY, EMAIL)).toThrow(
      'queue_depth: value must be a finite number, got Infinity',
    )
  })

  it('refuses a fraction on an integer level', () => {
    const metric = bound({ value: int() })
    expect(() => metric.set(1.5, EMAIL)).toThrow(
      'queue_depth: declares an integer level, so 1.5 is not a legal value. Declare `value: float()` if fractions are intended',
    )
  })

  it('says a whole number past the safe range is too large, not a fraction', () => {
    const metric = bound({ value: int() })
    expect(() => metric.inc(2 ** 53, EMAIL)).toThrow(
      new Error(
        'queue_depth: 9007199254740992 is past 9007199254740991, the largest whole number a double holds exactly, so an integer level cannot take it',
      ),
    )
  })

  it('refuses an integer level that would pass the largest safe integer', async () => {
    const errors: unknown[] = []
    const metric = make({ value: int() })
    metric.bind({ driver, now, onError: (error) => errors.push(error) })
    metric.set(Number.MAX_SAFE_INTEGER, EMAIL)
    metric.inc(EMAIL)
    await metric.drain()

    expect(errors.map((error) => (error as Error).message)).toEqual([
      'memory driver: queue_depth level would be 9007199254740992, which is past ' +
        '9007199254740991, the largest whole number a double holds exactly, so the write ' +
        'was refused',
    ])
    expect(await metric.current(EMAIL)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('names the delta a dec was given when it refuses it', () => {
    const whole = bound({ value: int() })
    expect(() => whole.dec(1.5, EMAIL)).toThrow(
      'queue_depth: declares an integer level, so 1.5 is not a legal delta. Declare `value: float()` if fractions are intended',
    )
    expect(() => whole.dec(2 ** 53, EMAIL)).toThrow(
      'queue_depth: 9007199254740992 is past 9007199254740991, the largest whole number a double holds exactly, so an integer level cannot take it',
    )
    expect(() => bound().dec(Number.POSITIVE_INFINITY, EMAIL)).toThrow(
      'queue_depth: value must be a finite number, got Infinity',
    )
  })

  it('starts an inc from zero once the series has passed holdFor', async () => {
    const metric = bound({ holdFor: '30s' })
    metric.set(42, EMAIL)
    await metric.drain()

    // its last window was at(3), and no flush has dropped it yet
    clock = at(6)
    metric.inc(EMAIL)
    await metric.drain()

    expect(await metric.current(EMAIL)).toBe(1)
  })

  it('refuses a first argument to inc or dec that is neither a delta nor dims', () => {
    const inFlight = level('in_flight', { resolution: '10s', flush: '10s', write: discard })
    inFlight.bind({ driver, now })
    expect(() => inFlight.inc(5n as unknown as number)).toThrow(
      'in_flight: the first argument must be a number or a dims object, got bigint',
    )
    expect(() => inFlight.dec(true as unknown as number)).toThrow(
      'in_flight: the first argument must be a number or a dims object, got boolean',
    )
  })

  it('refuses an undeclared dim', () => {
    const metric = bound()
    expect(() => metric.set(1, { park: 'riverside' } as unknown as typeof EMAIL)).toThrow(
      new Error('queue_depth: unknown dim "park". The declared dims are [queue]'),
    )
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

  it('refuses an integer total across series a double cannot hold exactly', async () => {
    const metric = bound({ value: int() })
    metric.set(Number.MAX_SAFE_INTEGER, EMAIL)
    metric.set(2, EXPORT)
    await metric.drain()

    await expect(metric.totals()).rejects.toThrow(
      'queue_depth: the total across series would be 9007199254740993, which is past ' +
        '9007199254740991, the largest whole number a double holds exactly',
    )
    await expect(metric.snapshot({ complete: false, groupBy: [] })).rejects.toThrow(
      'queue_depth: a merged value would be 9007199254740993, which is past 9007199254740991',
    )
  })

  it('refuses an integer total across series below the negative safe range', async () => {
    const metric = bound({ value: int() })
    metric.set(-Number.MAX_SAFE_INTEGER, EMAIL)
    metric.set(-2, EXPORT)
    await metric.drain()

    await expect(metric.totals()).rejects.toThrow(
      'queue_depth: the total across series would be -9007199254740993, which is past ' +
        '9007199254740991, the largest whole number a double holds exactly',
    )
  })

  it('adds series past the safe range when the level is fractional', async () => {
    const metric = bound()
    metric.set(Number.MAX_SAFE_INTEGER, EMAIL)
    metric.set(2, EXPORT)
    await metric.drain()

    expect(await metric.totals()).toBe(Number.MAX_SAFE_INTEGER + 2)
  })

  it('refuses a total across fractional series past the largest number a metric can store', async () => {
    const metric = bound()
    metric.set(Number.MAX_VALUE, EMAIL)
    metric.set(Number.MAX_VALUE, EXPORT)
    await metric.drain()

    await expect(metric.totals()).rejects.toThrow(
      'queue_depth: the total across series would be Infinity, which is past the largest ' +
        'number a metric can store',
    )
    await expect(metric.snapshot({ complete: false, groupBy: [] })).rejects.toThrow(
      'queue_depth: a merged value would be Infinity, which is past the largest number a ' +
        'metric can store',
    )
  })

  it('adds integer series exactly when a running sum passes the safe range', async () => {
    // added as doubles, MAX_SAFE_INTEGER + 2 rounds, and taking 2 back off
    // lands on a different whole number that looks safe
    const metric = bound({ value: int() })
    metric.set(Number.MAX_SAFE_INTEGER, { queue: 'a' })
    metric.set(2, { queue: 'b' })
    metric.set(-2, { queue: 'c' })
    await metric.drain()

    expect(await metric.totals()).toBe(Number.MAX_SAFE_INTEGER)
    const rows = await metric.snapshot({ complete: false, groupBy: [] })
    expect(rows.map((row) => row.value)).toEqual([Number.MAX_SAFE_INTEGER])
  })

  it('adds stored fractions on an integer level when their total is whole', async () => {
    // a float level declared again as an integer one reads what it stored
    const float = bound()
    float.set(1.5, EMAIL)
    float.set(0.5, EXPORT)
    await float.drain()

    const metric = bound({ value: int() })
    expect(await metric.totals()).toBe(2)
    const rows = await metric.snapshot({ complete: false, groupBy: [] })
    expect(rows.map((row) => row.value)).toEqual([2])
  })

  it('refuses a total of stored fractions on an integer level that is not whole', async () => {
    const float = bound()
    float.set(1.5, EMAIL)
    float.set(1, EXPORT)
    await float.drain()

    const metric = bound({ value: int() })
    await expect(metric.totals()).rejects.toThrow(
      'queue_depth: the total across series would be 2.5, which is not a whole number. A ' +
        'stored value is a fraction, which happens when a float level is declared as an ' +
        'integer one',
    )
    await expect(metric.snapshot({ complete: false, groupBy: [] })).rejects.toThrow(
      'queue_depth: a merged value would be 2.5, which is not a whole number',
    )
  })

  it('refuses a total of stored fractions on an integer level past the safe range', async () => {
    // added as doubles, the two halves round the total up past the limit
    const float = bound()
    float.set(Number.MAX_SAFE_INTEGER, EMAIL)
    float.set(0.5, EXPORT)
    float.set(0.5, { queue: 'import' })
    await float.drain()

    const metric = bound({ value: int() })
    await expect(metric.totals()).rejects.toThrow(
      'queue_depth: the total across series would be 9007199254740992, which is past ' +
        '9007199254740991, the largest whole number a double holds exactly',
    )
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

    // window 0 shipped. Window 1 has closed and is still inside grace, so the
    // next flush will carry 42 into it, and the snapshot already shows that
    const rows = await metric.snapshot()
    expect(rows.map((row) => [row.bucket_ts.getTime(), row.value])).toEqual([[at(1), 42]])
    expect(await metric.current(EMAIL)).toBe(42)
  })

  it('shows every window the next flush will carry, with the ids they will ship under', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })
    metric.set(42, EMAIL)
    await metric.drain()

    // five windows have closed and outlived grace; only the first was written
    clock = at(5) + 3_000
    const live = await metric.snapshot()
    expect(live.map((row) => row.value)).toEqual([42, 42, 42, 42, 42])

    await metric.flush()
    expect(sink.rows.map((row) => row.id)).toEqual(live.map((row) => row.id))
  })

  it('shows the open window at the held value when complete is false', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(3) + 5_000
    const open = await metric.snapshot({ complete: false, from: at(3) })
    expect(open).toEqual([expect.objectContaining({ value: 42, bucket_open: true })])
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

  it('carries a series to its old expiry and not through the gap before a write revived it', async () => {
    // holdFor 30s on 10s windows: written at(0), last reported at(3). The
    // write at(6) finds it expired and not yet dropped. The same rows ship
    // whether a flush ran in between or not
    const shipped = async (flushBetween: boolean) => {
      driver = memory()
      clock = BASE
      const sink = collector()
      const metric = bound({ write: sink.write, holdFor: '30s' })
      metric.set(42, EMAIL)
      await metric.drain()
      if (flushBetween) {
        clock = at(2) + 3_000
        await metric.flush()
      }
      clock = at(6)
      metric.set(7, EMAIL)
      await metric.drain()
      clock = at(9) + 3_000
      await metric.flush()
      return sink.shape
    }

    const expected = [
      [at(0), 42],
      [at(1), 42],
      [at(2), 42],
      [at(3), 42],
      [at(6), 7],
      [at(7), 7],
      [at(8), 7],
    ]
    expect(await shipped(false)).toEqual(expected)
    expect(await shipped(true)).toEqual(expected)
  })

  it('ships every window between a write and an older one that reached storage after it', async () => {
    // a clock stepped back between the two writes, so the older reading
    // arrives second and begins the series
    const sink = collector()
    const metric = bound({ write: sink.write })
    clock = at(2)
    metric.set(5, EMAIL)
    await metric.drain()
    clock = at(0)
    metric.set(3, EMAIL)
    await metric.drain()

    clock = at(3) + 3_000
    await metric.flush()
    expect(sink.shape).toEqual([
      [at(0), 3],
      [at(1), 3],
      [at(2), 5],
    ])
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

describe('regressions', () => {
  it('carries the last value written in a window, not the first', async () => {
    // inc(5) dec(2) in the first window used to carry 5 into every empty
    // window after it
    const sink = collector()
    const metric = bound({ write: sink.write })
    metric.inc(5, EMAIL)
    metric.dec(2, EMAIL)
    await metric.drain()

    clock = at(4) + 3_000
    await metric.flush()
    expect(sink.shape).toEqual([
      [at(0), 3],
      [at(1), 3],
      [at(2), 3],
      [at(3), 3],
    ])
  })

  it('carries the last of several sets in one window', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })
    metric.set(5, EMAIL)
    metric.set(3, EMAIL)
    await metric.drain()

    clock = at(3) + 3_000
    await metric.flush()
    expect(sink.shape.map(([, value]) => value)).toEqual([3, 3, 3])
  })

  it('resumes at the newest value after a gap longer than the carry cap', async () => {
    // set 42 and ship it, set 38 in the next window, then stay away for
    // longer than MAX_CARRY_BUCKETS windows. The first carried window after
    // the gap is 38, the value the series actually changed to
    const sink = collector()
    const metric = bound({ write: sink.write })
    metric.set(42, EMAIL)
    await metric.drain()
    clock = at(1) + 3_000
    await metric.flush()

    metric.set(38, EMAIL)
    await metric.drain()

    clock = at(MAX_CARRY_BUCKETS + 50) + 3_000
    sink.batches.length = 0
    await metric.flush()

    const values = new Set(sink.rows.map((row) => row.value))
    expect(values).toEqual(new Set([38]))
    expect(await metric.current(EMAIL)).toBe(38)
  })

  it('keeps a series that is written while its expiry is being decided', async () => {
    // the drop is decided from a read, and a set can land between that read
    // and the drop. It must survive
    const metric = bound({ holdFor: '30s' })
    metric.set(1, EMAIL)
    await metric.drain()

    clock = at(10) + 3_000
    const readLevels = driver.readLevels.bind(driver)
    driver.readLevels = async (name: string) => {
      const series = await readLevels(name)
      metric.set(9, EMAIL)
      await metric.drain()
      return series
    }
    await metric.flush()
    driver.readLevels = readLevels

    expect(await metric.current(EMAIL)).toBe(9)
  })

  it('ships the same rows for a holdFor between two windows, however flushes are spaced', async () => {
    // holdFor 15s on 10s windows reports the written window and one more
    const everyWindow = collector()
    const spaced = bound({ write: everyWindow.write, holdFor: '15s' })
    spaced.set(7, EMAIL)
    await spaced.drain()
    for (let n = 1; n <= 5; n++) {
      clock = at(n) + 3_000
      await spaced.flush()
    }

    driver = memory()
    clock = BASE
    const once = collector()
    const single = bound({ write: once.write, holdFor: '15s' })
    single.set(7, EMAIL)
    await single.drain()
    clock = at(5) + 3_000
    await single.flush()

    expect(everyWindow.shape).toEqual([
      [at(0), 7],
      [at(1), 7],
    ])
    expect(once.shape).toEqual(everyWindow.shape)
  })

  it('ships windows still inside grace on a final flush', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })
    metric.set(4, EMAIL)
    await metric.drain()

    // window 1 has just closed, and grace would normally hold it back
    clock = at(2) + 500
    await metric.flush({ final: true })
    expect(sink.shape).toEqual([
      [at(0), 4],
      [at(1), 4],
    ])
  })
})

describe('round two', () => {
  it('shows the window a flush carries first when the gap passes the cap inside grace', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write })
    metric.set(42, EMAIL)
    await metric.drain()

    // far past the cap, half a second into a window, so the window before it
    // is still inside the 2s grace
    clock = at(MAX_CARRY_BUCKETS + 50) + 500
    const live = await metric.snapshot()
    await metric.flush()

    const shown = new Set(live.map((row) => row.id))
    expect(sink.rows.filter((row) => !shown.has(row.id as string))).toEqual([])
  })

  it('shows the window a flush carries first when complete is false past the cap', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write, grace: '0s' })
    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(MAX_CARRY_BUCKETS + 50) + 5_000
    const live = await metric.snapshot({ complete: false })
    await metric.flush()

    const shown = new Set(live.map((row) => row.id))
    expect(sink.rows.filter((row) => !shown.has(row.id as string))).toEqual([])
  })

  it('reports forever when holdFor runs past the largest safe timestamp', async () => {
    const sink = collector()
    const metric = bound({ write: sink.write, holdFor: Number.MAX_SAFE_INTEGER - 1 })
    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(2) + 3_000
    expect((await metric.flush()).error).toBeUndefined()
    expect(sink.shape).toEqual([
      [at(0), 42],
      [at(1), 42],
    ])
    expect(await metric.current(EMAIL)).toBe(42)
  })

  it('stops a snapshot at the open window when to reaches into the future', async () => {
    const metric = bound()
    metric.set(42, EMAIL)
    await metric.drain()

    clock = at(2) + 5_000
    const rows = await metric.snapshot({ complete: false, to: clock + 60_000 })
    expect(rows.map((row) => row.bucket_ts.getTime())).toEqual([at(0), at(1), at(2)])
  })

  it('leaves a series its dim type can no longer read out of totals()', async () => {
    const before = level('queue_depth', {
      dims: { queue: str() },
      resolution: '10s',
      flush: '10s',
      write: discard,
    })
    before.bind({ driver, now })
    before.set(5, { queue: 'email' })
    await before.drain()
    before.unbind()

    // the dim is now an int(), and the stored text "email" is not one
    const after = level('queue_depth', {
      dims: { queue: int() },
      resolution: '10s',
      flush: '10s',
      write: discard,
    })
    after.bind({ driver, now })
    after.set(3, { queue: 1 })
    await after.drain()
    clock = at(3)

    expect(await after.totals()).toBe(3)
  })

  it('ships the window an unreadable series was written in as stored and carries it no further', async () => {
    const before = level('queue_depth', {
      dims: { queue: str() },
      resolution: '10s',
      flush: '10s',
      write: discard,
    })
    before.bind({ driver, now })
    before.set(5, { queue: 'email' })
    await before.drain()
    before.unbind()

    const shipped: [number, unknown, unknown][] = []
    const after = level('queue_depth', {
      dims: { queue: int() },
      resolution: '10s',
      flush: '10s',
      write: (rows) => {
        for (const row of rows) shipped.push([row.bucket_ts.getTime(), row.queue, row.value])
      },
    })
    after.bind({ driver, now, onError: () => {} })
    after.set(3, { queue: 1 })
    await after.drain()
    clock = at(3)

    expect((await after.flush()).error).toBeUndefined()
    expect(shipped).toEqual([
      [at(0), 'email', 5],
      [at(0), 1, 3],
      [at(1), 1, 3],
    ])
  })

  it('forgets a series past holdFor in current() and totals() before any flush', async () => {
    const metric = bound({ holdFor: '20s' })
    metric.set(80, EMAIL)
    await metric.drain()

    clock = at(2) + 5_000
    expect(await metric.current(EMAIL)).toBe(80)
    clock = at(3) + 5_000
    expect(await metric.current(EMAIL)).toBeUndefined()
    expect(await metric.totals()).toBeUndefined()
  })
})

describe('current(dims) and the optional readLevel', () => {
  it('asks the driver for the one series rather than every series', async () => {
    const base = memory()
    driver = {
      ...base,
      readLevels: async () => {
        throw new Error('read every series')
      },
    }
    const metric = bound()
    metric.set(80, EMAIL)
    metric.set(5, EXPORT)
    await metric.drain()
    expect(await metric.current(EMAIL)).toBe(80)
    expect(await metric.current({ queue: 'nowhere' })).toBeUndefined()
  })

  it('answers the same through a driver without readLevel', async () => {
    /** What current(dims) reports for each queue at each moment of one story. */
    const story = async (plain: boolean) => {
      clock = BASE
      const { readLevel: _, ...required } = memory()
      driver = plain ? required : memory()
      const sink = collector()
      const metric = bound({ write: sink.write, holdFor: '30s' })
      const seen: (number | undefined)[] = []
      const look = async () => {
        seen.push(await metric.current(EMAIL), await metric.current(EXPORT))
      }

      metric.set(80, EMAIL)
      metric.inc(4, EXPORT)
      await metric.drain()
      await look()
      // carried through windows nobody wrote to, and across a flush
      clock = at(2) + 3_000
      await look()
      await metric.flush()
      await look()
      metric.dec(EXPORT)
      await metric.drain()
      await look()
      // past holdFor for EMAIL, which nothing has written since the start
      clock = at(4) + 3_000
      await look()
      await metric.flush()
      await look()
      return seen
    }
    const withRead = await story(false)
    expect(withRead).toEqual(await story(true))
    expect(withRead).toEqual([80, 4, 80, 4, 80, 4, 80, 3, undefined, 3, undefined, 3])
  })
})

/**
 * A Redis client for the tests a level runs on both drivers, or `undefined`
 * when no server answers. Those tests then run on `memory()` alone.
 */
async function probeRedis(): Promise<Redis | undefined> {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  try {
    await client.connect()
    await client.ping()
    return client
  } catch {
    client.disconnect()
    return undefined
  }
}

const redis = await probeRedis()
afterAll(async () => {
  await redis?.quit()
})

/** Each driver the level runs on, and how to clear what a test left in it. */
const drivers: { name: string; make: () => { driver: Driver; wipe: () => Promise<void> } }[] = [
  { name: 'memory', make: () => ({ driver: memory(), wipe: async () => {} }) },
  ...(redis
    ? [
        {
          name: 'ioredis',
          make: () => {
            const namespace = `mhtest_${randomUUID()}`
            return {
              driver: ioredis(redis, { namespace }),
              wipe: async () => {
                const keys = await redis.keys(`${namespace}:*`)
                if (keys.length > 0) await redis.del(...keys)
              },
            }
          },
        },
      ]
    : []),
]

for (const { name: driverName, make: makeDriver } of drivers) {
  describe(`a dim added at the end, on ${driverName}`, () => {
    it('ships the windows an older series wrote and carries only the series written now', async () => {
      const { driver: shared, wipe } = makeDriver()
      try {
        const before = level('queue_depth', {
          dims: { queue: str() },
          resolution: '10s',
          flush: '10s',
          write: discard,
        })
        before.bind({ driver: shared, now })
        before.set(5, EMAIL)
        await before.drain()

        const sink = collector()
        const after = level('queue_depth', {
          dims: { queue: str(), region: str().optional() },
          resolution: '10s',
          flush: '10s',
          write: sink.write,
        })
        after.bind({ driver: shared, now })
        clock = at(1)
        after.set(3, { queue: 'email', region: 'eu' })
        await after.drain()

        // four windows have closed and outlived grace. The older series wrote
        // only the first, and the new one wrote the second
        clock = at(5) + 3_000
        const expected = [
          {
            id: rowId('queue_depth', at(0), 'email'),
            bucket_ts: new Date(at(0)),
            queue: 'email',
            value: 5,
          },
          ...[1, 2, 3, 4].map((n) => ({
            id: rowId('queue_depth', at(n), 'email|eu'),
            bucket_ts: new Date(at(n)),
            queue: 'email',
            region: 'eu',
            value: 3,
          })),
        ]

        const live = await after.snapshot()
        expect(live.map(({ bucket_open, bucket_elapsed_ms, ...row }) => row)).toEqual(expected)
        expect(await after.current({ queue: 'email', region: 'eu' })).toBe(3)
        expect(await after.current({ queue: 'email' })).toBeUndefined()
        expect(await after.totals()).toBe(3)

        expect((await after.flush()).error).toBeUndefined()
        expect(sink.rows).toEqual(expected)
      } finally {
        await wipe()
      }
    })
  })
}

describe('a change of resolution', () => {
  it('carries a late set that landed on the first window of the coarser grid', async () => {
    // on a five minute boundary
    const base = 1_788_616_800_000
    const minute = 60_000
    const before = level('queue_depth', {
      dims: { queue: str() },
      resolution: '1m',
      flush: '1m',
      write: discard,
    })
    before.bind({ driver, now })
    clock = base + 7 * minute + 10_000
    before.set(4, EMAIL)
    clock = base + 8 * minute + 1000
    before.set(4, EMAIL)
    await before.drain()
    clock = base + 8 * minute + 3000
    await before.flush()

    const sink = collector()
    const after = level('queue_depth', {
      dims: { queue: str() },
      resolution: '5m',
      flush: '5m',
      write: sink.write,
    })
    after.bind({ driver, now })
    clock = base + 8 * minute + 10_000
    after.set(9, EMAIL)
    await after.drain()

    clock = base + 20 * minute + 3000
    await after.flush()
    expect(sink.shape.map(([ts, value]) => [ts - base, value])).toEqual([
      [8 * minute, 4],
      [10 * minute, 9],
      [15 * minute, 9],
    ])
  })
})
