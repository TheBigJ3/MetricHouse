/**
 * Level. A quantity that persists between writes.
 *
 * The gauge answers "what values were observed in this window", and a window
 * nobody wrote to is absent. That is right for something you sample and wrong
 * for something that holds: a queue at 42 is still at 42 during the minute
 * nobody asked, and a chart of it should draw a line rather than a hole.
 *
 * So a level keeps one number per series in storage, beside the buckets and
 * outside every claim, and each flush carries that number into the closed
 * windows that have none. Everything downstream of the carry is the counter's
 * path exactly: the same bucket cells, the same claim, the same ack.
 *
 * **What it costs.** A counter writes a row for a window something happened
 * in. A level writes one for every window, for every series, forever. Ten
 * series at `resolution: '1m'` is 5.2 million rows a year whether or not
 * anything moved. Reach for a gauge when you are sampling, and for this when
 * the gap between writes is the thing you need filled.
 */

import type { Cell, Claim, LevelOp, LevelSeries } from '../drivers/types.js'
import { isLevelCell } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { metricFlush } from '../runtime/flush.js'
import {
  applySnapshot,
  type LiveRow,
  type LiveRowOf,
  liveColumns,
  type SnapshotOptions,
  snapshotRange,
} from '../runtime/live.js'
import {
  assertDimsLegal,
  dimKeyDecoder,
  dimKeyEncoder,
  isDecodableDimKey,
  isShorterDimKey,
} from '../schema/dims.js'
import type { FieldType, InferRow, InferShape, Shape, Simplify } from '../schema/types.js'
import { bucketRange, bucketStart } from '../time/buckets.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import { bucketedBinding, bucketedLifecycle, claimWatermark, seriesKey } from './bucketed.js'
import type {
  AnyMetric,
  ClaimOptions,
  DimsArgs,
  MetricBinding,
  Row,
  RowShape,
  WriteContext,
  WriteFn,
} from './types.js'
import {
  assertDeltaOrDims,
  assertMetricName,
  assertSink,
  assertWhole,
  describeValue,
  dimColumns,
  pendingWrites,
} from './types.js'

/**
 * The most windows one flush will carry a single series through.
 *
 * A guard against catching up on downtime, not a tuning knob. A process off
 * for a day comes back owing 86,400 windows per series at `resolution: '1s'`,
 * and writing them all would mean a flush that takes minutes and a chart
 * claiming the queue was measured the whole time it was not. Past the cap the
 * older windows are skipped, which leaves a gap, the truthful shape for a
 * stretch when nothing was running.
 */
export const MAX_CARRY_BUCKETS = 10_000

/** The row shape a level's `write()` receives. */
export type LevelRow<D extends Shape> = Simplify<
  { id: string; bucket_ts: Date } & InferRow<D> & { value: number }
>

/** One live row from a level, typed to its dims and to the options asked for. */
export type LevelLiveRow<
  D extends Shape,
  O extends SnapshotOptions = Record<never, never>,
> = LiveRowOf<D, { value: number }, O>

export interface LevelConfig<D extends Shape> {
  /** Omit entirely for a level with no dimensions. */
  readonly dims?: D
  readonly resolution: DurationInput
  /** Minimum shipping cadence. Omit it to take `defaults.flush` from the house. */
  readonly flush?: DurationInput
  /**
   * How long a window waits after it ends before a flush may claim it, so
   * writes stamped inside it have time to reach storage. Default `'2s'`.
   */
  readonly grace?: DurationInput
  /**
   * How long a series keeps reporting after its last write. Unbounded by
   * default, which is what "it holds until something changes it" means.
   *
   * The last window a series reports is the one `holdFor` after its last
   * write falls in, so a `holdFor` that is not a whole number of windows
   * rounds down to one that is.
   *
   * Set it when a series can go away: a worker that owned `worker: 'w-7'` and
   * then died leaves a queue depth that will otherwise be reported forever,
   * and a dashboard cannot tell a held value from a current one. Past this,
   * the series is forgotten and stops producing rows until something writes
   * to it again.
   *
   * Measured from the window the last write landed in, so it rounds to whole
   * windows rather than to the millisecond.
   */
  readonly holdFor?: DurationInput
  /** `float()` (default) or `int()`. Decides whether writes accept fractions. */
  readonly value?: FieldType<number, false>
  /**
   * Where this level's rows go. Required. See the counter for why.
   *
   * Receives {@link LevelRow}: one `value` column, which is what the series
   * was at when the window closed.
   */
  readonly write: WriteFn<LevelRow<D>>
}

export interface Level<D extends Shape> extends AnyMetric {
  readonly name: string
  readonly kind: 'level'
  readonly dims: D
  readonly resolutionMs: number
  readonly flushMs: number
  readonly graceMs: number
  /** `undefined` when a series is held with no expiry. */
  readonly holdForMs: number | undefined
  readonly isFloat: boolean
  /** The sink this level was declared with. A method, as on the counter. */
  write(rows: LevelRow<D>[], context: WriteContext): Promise<void> | void
  readonly isBound: boolean

  bind(binding: MetricBinding): void

  /** Put the series at this value. It stays there until something changes it. */
  set(value: number, ...dims: DimsArgs<D>): void

  /**
   * Move the series by `delta`, or by 1.
   *
   * For the quantities that are counted in and out rather than measured:
   * requests in flight, connections checked out of a pool. A series nothing
   * has written to starts at zero.
   */
  inc(delta: number, ...dims: DimsArgs<D>): void
  inc(...dims: DimsArgs<D>): void

  /** Move the series down by `delta`, or by 1. The mirror of {@link Level.inc}. */
  dec(delta: number, ...dims: DimsArgs<D>): void
  dec(...dims: DimsArgs<D>): void

  /**
   * What one series is at right now.
   *
   * `undefined` when nothing has ever written to it. A zero would be a claim
   * that the queue exists and is empty, which is a different thing from not
   * knowing.
   *
   * Read from the held value rather than from the open bucket, because the
   * open window may well have nothing in it, which is the entire difference
   * between this and a gauge.
   */
  current(...dims: DimsArgs<D>): Promise<number | undefined>

  /**
   * Every series added up: total depth across all queues, total connections
   * across the pool.
   *
   * The merge a level can make honestly, and the opposite of the gauge's. A
   * gauge drops `last` from its totals because several series have no single
   * latest observation; for a level the held values are all current at once,
   * so adding them is exactly the answer. `undefined` when no series has ever
   * been written to.
   */
  totals(): Promise<number | undefined>

  /**
   * Every unflushed window, as typed rows: the ones written to, and the ones
   * the next flush will carry a held value into. With `complete: false`, the
   * open window too, at the value the series is at now.
   */
  snapshot<const O extends SnapshotOptions = Record<never, never>>(
    options?: O,
  ): Promise<LevelLiveRow<D, O>[]>

  drain(): Promise<void>
  rowShape(): RowShape

  /** Turn one stored cell into the row a sink receives. */
  materialize(bucketTs: number, dimKey: string, cell: Cell): Row
  /** This batch's headline number, what every series added up to at the end of it. */
  totalOf(rows: readonly Row[]): number
}

/**
 * Declare a level.
 *
 * @throws if the configuration is invalid, failing the same declare-time checks
 * `counter()` makes on name, dims and resolution, plus `holdFor`, which must
 * be at least one window or it would expire a series before it ever reported.
 */
export function level<D extends Shape = Record<never, never>>(
  name: string,
  config: LevelConfig<D>,
): Level<D> {
  assertMetricName(name, 'level')
  assertSink(config.write, name)

  const dims = (config.dims ?? {}) as D
  assertDimsLegal(dims, name, ['id', 'bucket_ts', 'value'])

  // erased for the engine, which carries rows of every kind. See the counter
  const sink = config.write as WriteFn

  const slot = bucketedBinding({
    name,
    kind: 'level',
    resolution: config.resolution,
    flush: config.flush,
    grace: config.grace,
    materialize,
    totalOf,
    sink,
  })
  const { resolutionMs } = slot

  const holdForMs = config.holdFor === undefined ? undefined : parseDuration(config.holdFor)
  if (holdForMs !== undefined && holdForMs < resolutionMs) {
    throw new Error(
      `${name}: holdFor must be at least one resolution, because a shorter one would drop a series ` +
        'before the window it was written in had closed',
    )
  }

  const isFloat = config.value?.kind !== 'int'

  const writes = pendingWrites(name)

  /** The driver stores whatever a metric wrote; a level only writes level cells. */
  function asLevel(cell: Cell): number {
    if (!isLevelCell(cell)) {
      throw new Error(
        `${name}: expected a level cell but the driver returned a ` +
          `${typeof cell === 'number' ? 'counter cell' : 'gauge fold'}`,
      )
    }
    return cell.level
  }

  // built once, here: every write encodes a key and every row a flush or a
  // snapshot builds decodes one, against a declaration that never changes
  const encodeKey = dimKeyEncoder(dims, name)
  const decodeKey = dimKeyDecoder(dims)

  function keyFor(values: InferShape<D> | undefined): string {
    return encodeKey((values ?? {}) as Record<string, unknown>)
  }

  /** The one write path. `set`, `inc` and `dec` all land here. */
  function write(mode: 'set' | 'add', amount: number, values: InferShape<D> | undefined): void {
    const active = slot.active()

    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error(`${name}: value must be a finite number, got ${describeValue(amount)}`)
    }
    if (!isFloat) assertWhole(name, 'level', amount, mode === 'set' ? 'value' : 'delta')

    // validated before the clock is read, so a rejected write never
    // half-commits and never depends on when it was rejected
    const dimKey = keyFor(values)
    const bucketTs = bucketStart((active.now ?? Date.now)(), resolutionMs)

    const op: LevelOp = {
      metric: name,
      bucketTs,
      dimKey,
      value: amount,
      mode,
      ...(!isFloat && { integer: true }),
    }
    writes.track(slot.deliver(active.driver.setLevel([op]), bucketTs, dimKey), () => active.onError)
  }

  function materialize(bucketTs: number, dimKey: string, cell: Cell): Row {
    return {
      id: rowId(name, bucketTs, dimKey),
      bucket_ts: new Date(bucketTs),
      ...decodeKey(dimKey),
      value: asLevel(cell),
    }
  }

  /**
   * Where every series stood when the batch ended.
   *
   * Not the sum of every row: a level that sat at 42 for five windows would
   * report 210, which is a number nothing in the world corresponds to. The
   * newest window in the batch is the one that is still true, so the headline
   * is what its series added up to.
   */
  function totalOf(rows: readonly Row[]): number {
    let newest = Number.NEGATIVE_INFINITY
    for (const row of rows) {
      const at = (row.bucket_ts as Date).getTime()
      if (at > newest) newest = at
    }

    return rows.reduce(
      (sum, row) =>
        (row.bucket_ts as Date).getTime() === newest ? sum + (row.value as number) : sum,
      0,
    )
  }

  /**
   * Latest per series, then added up.
   *
   * Both halves of that are needed, and they are the two things a merge over
   * these rows can be asked for. Merging one series across windows is the
   * latest of them, because the earlier ones have been superseded. Merging
   * several series within one window is their sum, because they are all
   * current at once. A merge that does both does them in that order.
   *
   * Rows arrive in ascending bucket order, which is what makes "latest"
   * answerable here at all.
   */
  function mergeValues(rows: readonly Row[]): Record<string, unknown> {
    const dimNames = Object.keys(dims)
    const latest = new Map<string, number>()

    for (const row of rows) {
      const key = seriesKey(dimNames, row)
      latest.set(key, row.value as number)
    }

    let total = 0
    for (const value of latest.values()) total += value
    return { value: exactSum(total, 'a merged value') }
  }

  /**
   * A sum across series, refused for an integer level when a double cannot
   * hold it exactly. The counter's rule: each series stays below
   * `Number.MAX_SAFE_INTEGER` on its own, but several added together can pass
   * it and come back as a different whole number with nothing to say so.
   */
  function exactSum(total: number, what: string): number {
    if (!isFloat && !Number.isSafeInteger(total)) {
      throw new Error(
        `${name}: ${what} would be ${total}, which is past ${Number.MAX_SAFE_INTEGER}, the ` +
          'largest whole number a double holds exactly',
      )
    }
    return total
  }

  /**
   * The window after the last one a series reports, or `undefined` when it
   * reports forever.
   *
   * The last window is the one `holdFor` after the last write falls in. Every
   * caller asks this one function, which is what makes the rows a series
   * ships the same however the flushes that carry it are spaced.
   */
  function holdUntil(one: LevelSeries): number | undefined {
    if (holdForMs === undefined) return undefined
    const last = one.writtenAt + holdForMs
    // a hold that ends past the largest safe timestamp never ends in practice,
    // and `bucketStart` cannot place a window there
    if (last > Number.MAX_SAFE_INTEGER) return undefined
    return bucketStart(last, resolutionMs) + resolutionMs
  }

  /**
   * True when a held series belongs to the declaration as it is now.
   *
   * A series stored before a dim was added at the end has a key with fewer
   * values than the dims declared, and the metric never writes to that key
   * again. Carrying it would ship it in every later window beside the series
   * that replaced it, and add it into every total, for as long as it is held.
   * So it ships the windows it was written in and nothing after them. Its
   * stored data is left alone. The flush, a snapshot, `current()` and
   * `totals()` all ask this one function, so they agree about it.
   */
  function carries(one: LevelSeries): boolean {
    return !isShorterDimKey(dims, one.dimKey) && isDecodableDimKey(dims, one.dimKey)
  }

  /**
   * Every series still reporting in the open window.
   *
   * A series past its `holdFor` is only removed from storage by the next
   * flush, so a read between the two filters it out itself. That keeps
   * `current()` and `totals()` in step with `snapshot()`, which already stops
   * a series at its last window.
   */
  async function heldNow(): Promise<LevelSeries[]> {
    return reporting(await slot.driver().readLevels(name))
  }

  /** The series in `series` that {@link heldNow} would keep, read against the clock now. */
  function reporting(series: readonly LevelSeries[]): LevelSeries[] {
    const carried = series.filter(carries)
    if (holdForMs === undefined) return carried
    const open = bucketStart(slot.now(), resolutionMs)
    return carried.filter((one) => open < (holdUntil(one) ?? Number.POSITIVE_INFINITY))
  }

  /**
   * The one series under `dimKey` still reporting in the open window.
   *
   * A driver that can read one series is asked for just that one, rather than
   * for every series the level holds. The same filters apply either way.
   */
  async function heldNowAt(dimKey: string): Promise<LevelSeries | undefined> {
    const driver = slot.driver()
    if (driver.readLevel === undefined) {
      return (await heldNow()).find((one) => one.dimKey === dimKey)
    }
    const one = await driver.readLevel(name, dimKey)
    return one === undefined ? undefined : reporting([one])[0]
  }

  /**
   * What each window from a series' pointer up to `until` holds.
   *
   * It walks forwards rather than stamping one number across the gap, because
   * a series can have been written several times since the last flush and
   * each window belongs to whatever the value was *then*. Set to 42 at noon
   * and to 7 at three, and the windows in between are 42, not 7, because a queue
   * that changed at three did not change at noon.
   *
   * The walk is capped at {@link MAX_CARRY_BUCKETS} windows back from
   * `capAt`, which is `until` unless the caller says otherwise. A live read
   * walks further than a flush, into the windows still inside grace, and caps
   * from where the flush would so the two start at the same window. The
   * windows the cap skips still decide where the walk starts:
   * the value it begins from is the newest write among them, or `carried`
   * when there is none, so a series that changed during a long gap resumes
   * at the value it changed to.
   *
   * `written` holds the cells already in storage for this series, by bucket.
   */
  function walkCarry(
    one: LevelSeries,
    written: ReadonlyMap<number, number> | undefined,
    until: number,
    capAt: number = until,
  ): { bucketTs: number; value: number; observed: boolean }[] {
    const start = one.heldThrough + resolutionMs
    const from = Math.max(start, capAt - MAX_CARRY_BUCKETS * resolutionMs)

    // the value in effect at `heldThrough`, moved on by anything written in
    // the windows the cap stepped over
    let value = one.carried
    if (written && from > start) {
      let newest = Number.NEGATIVE_INFINITY
      for (const [bucketTs, observed] of written) {
        if (bucketTs >= start && bucketTs < from && bucketTs > newest) {
          newest = bucketTs
          value = observed
        }
      }
    }

    const windows: { bucketTs: number; value: number; observed: boolean }[] = []
    for (const bucketTs of bucketRange(from, until, resolutionMs)) {
      const observed = written?.get(bucketTs)
      if (observed !== undefined) value = observed
      windows.push({ bucketTs, value, observed: observed !== undefined })
    }
    return windows
  }

  /** Level cells by series, then by bucket. */
  function byDimKey(rows: readonly { bucketTs: number; dimKey: string; value: Cell }[]) {
    const written = new Map<string, Map<number, number>>()
    for (const row of rows) {
      let byBucket = written.get(row.dimKey)
      if (!byBucket) {
        byBucket = new Map()
        written.set(row.dimKey, byBucket)
      }
      byBucket.set(row.bucketTs, asLevel(row.value))
    }
    return written
  }

  /**
   * Carry every series through the windows it owes a row for, then claim as
   * any bucketed kind does.
   *
   * The whole of what makes a level a level, and the only method here that is
   * not the counter's.
   *
   * The carry runs before the claim because the windows it writes have to be
   * in the live set for the claim to take them. That order is also what makes
   * a crash between the two harmless: the carry is durable, so the next flush
   * claims it.
   */
  async function carryAndClaim(at: number, claimOptions: ClaimOptions): Promise<Claim> {
    const driver = slot.driver()
    const watermark = claimWatermark(resolutionMs, at, slot.graceMs, claimOptions)
    const claim = () => lifecycle.claimBatch(at, claimOptions)

    const series = await driver.readLevels(name)
    if (series.length === 0) return claim()

    const expired: string[] = []
    const carrying: { series: LevelSeries; until: number }[] = []
    let earliest = Number.POSITIVE_INFINITY

    for (const one of series) {
      // an expiring series is carried to its last window and no further
      const until = Math.min(watermark, holdUntil(one) ?? watermark)
      if (carries(one) && one.heldThrough + resolutionMs < until) {
        carrying.push({ series: one, until })
        earliest = Math.min(earliest, one.heldThrough + resolutionMs)
      }

      // a series past its hold stops reporting. Dropped rather than left
      // alone, so it costs nothing to keep, and it comes back the moment
      // something writes to it again
      if (holdForMs !== undefined && one.writtenAt + holdForMs < watermark) {
        expired.push(one.dimKey)
      }
    }

    // only a series whose last write is still this old is dropped. The read
    // above is already a moment stale, and a `set` that landed since then is
    // what keeps its series alive
    const dropExpired = () =>
      expired.length > 0 && holdForMs !== undefined
        ? driver.dropLevels(name, expired, watermark - holdForMs)
        : Promise.resolve()

    if (carrying.length === 0) {
      await dropExpired()
      return claim()
    }

    // what has actually been written inside the range being carried, from
    // each pointer rather than from where a capped walk begins: a write in a
    // skipped window still decides the value the walk starts with
    const written = byDimKey(
      await driver.readBuckets({ metric: name, from: earliest, to: watermark }),
    )

    const ops: LevelOp[] = []
    for (const { series: one, until } of carrying) {
      for (const window of walkCarry(one, written.get(one.dimKey), until)) {
        // sent for a written window too, and written only if that window is
        // empty. It is what moves the pointer, and skipping it would leave
        // the next flush starting from the wrong place
        ops.push({
          metric: name,
          bucketTs: window.bucketTs,
          dimKey: one.dimKey,
          value: window.value,
          mode: 'hold',
        })
      }
    }

    // window by window rather than series by series. A driver batches
    // neighbouring ops for one window into one call, so a thousand series
    // carried through ten windows is ten calls instead of ten thousand. Each
    // series still reaches its windows in order, because the sort is stable
    ops.sort((a, b) => a.bucketTs - b.bucketTs)

    // the carry first, so a series being dropped still ships the windows it
    // owed up to the moment it expired
    if (ops.length > 0) await driver.setLevel(ops)
    await dropExpired()

    return claim()
  }

  /**
   * Every unflushed window, including the ones the next flush will carry.
   *
   * A window nobody wrote to has no cell in storage until a flush carries
   * into it, so reading storage alone would show a level that sat at 42 for
   * five minutes as one row. This fills those windows the way the flush will,
   * so a live read and the rows that later ship agree. The open window is
   * filled too, with the value the series is at now, when `complete: false`
   * asks for it.
   */
  async function snapshotWithCarry(options: SnapshotOptions = {}): Promise<LiveRow[]> {
    const driver = slot.driver()
    const now = slot.now()
    const range = snapshotRange(options, resolutionMs, now, name)
    // the newest window that can hold anything: the open one, unless the
    // range or `complete` stops short of it. A `to` in the future does not
    // reach further, because a window that has not started has no value yet
    const openEnd = bucketStart(now, resolutionMs) + resolutionMs
    const upper = Math.min(range.to ?? openEnd, openEnd)
    // where the next flush will carry up to, which is where its cap counts
    // back from
    const flushUpTo = claimWatermark(resolutionMs, now, slot.graceMs)

    const [series, stored] = await Promise.all([
      driver.readLevels(name),
      driver.readBuckets({ metric: name, ...(range.to !== undefined && { to: range.to }) }),
    ])
    const written = byDimKey(stored)

    const rows = stored.map((row) => ({
      bucketTs: row.bucketTs,
      dimKey: row.dimKey,
      cell: row.value,
    }))
    for (const one of series) {
      if (!carries(one)) continue
      const until = Math.min(upper, holdUntil(one) ?? upper)
      const capAt = Math.min(until, flushUpTo)
      for (const window of walkCarry(one, written.get(one.dimKey), until, capAt)) {
        if (!window.observed) {
          rows.push({
            bucketTs: window.bucketTs,
            dimKey: one.dimKey,
            cell: { level: window.value },
          })
        }
      }
    }

    const from = range.from
    return applySnapshot(
      rows
        .filter((row) => from === undefined || row.bucketTs >= from)
        .sort((a, b) => a.bucketTs - b.bucketTs || (a.dimKey < b.dimKey ? -1 : 1))
        .map((row) => ({
          bucketTs: row.bucketTs,
          row: materialize(row.bucketTs, row.dimKey, row.cell),
        })),
      options,
      {
        metric: name,
        dims,
        resolutionMs,
        nowMs: now,
        mergeValues,
        columns: liveColumns(self.rowShape()),
      },
    )
  }

  // named, so the flush mixin can reach the finished metric. See the counter
  const lifecycle = bucketedLifecycle({
    name,
    resolutionMs,
    graceMs: slot.graceMs,
    driver: slot.driver,
    materialize,
    totalOf,
  })

  const self: Level<D> = {
    ...lifecycle,

    ...metricFlush({
      name,
      flushMs: slot.flushMs,
      sink: () => sink,
      now: slot.now,
      self: () => self,
      attempts: slot.attempts,
      sharedDriver: slot.driver,
    }),

    name,
    kind: 'level',
    storage: 'bucketed',
    dims,
    resolutionMs,

    get flushMs(): number {
      return slot.flushMs()
    },

    get graceMs(): number {
      return slot.graceMs()
    },

    holdForMs,
    isFloat,
    write: config.write,

    get isBound(): boolean {
      return slot.isBound()
    },

    bind: slot.bind,
    unbind: slot.unbind,

    claimBatch(at: number, claimOptions: ClaimOptions = {}) {
      return carryAndClaim(at, claimOptions)
    },

    // replaces the plain bucket read spread in above, so live rows include the
    // windows a flush would carry
    snapshot: snapshotWithCarry as Level<D>['snapshot'],

    set(value: number, ...args: DimsArgs<D>): void {
      write('set', value, args[0])
    },

    // the numeric overload trick the counter uses, for the same reason:
    // `InferShape<{}>` accepts a number, so `.inc(5)` on a dimensionless
    // level would otherwise bind 5 as the dims argument
    inc(first?: number | InferShape<D>, second?: InferShape<D>): void {
      assertDeltaOrDims(name, first)
      const delta = typeof first === 'number' ? first : 1
      write('add', delta, (typeof first === 'number' ? second : first) as InferShape<D>)
    },

    dec(first?: number | InferShape<D>, second?: InferShape<D>): void {
      assertDeltaOrDims(name, first)
      const delta = typeof first === 'number' ? first : 1
      write('add', -delta, (typeof first === 'number' ? second : first) as InferShape<D>)
    },

    async current(...args: DimsArgs<D>): Promise<number | undefined> {
      return (await heldNowAt(keyFor(args[0])))?.value
    },

    async totals(): Promise<number | undefined> {
      const series = await heldNow()
      if (series.length === 0) return undefined
      return exactSum(
        series.reduce((sum, one) => sum + one.value, 0),
        'the total across series',
      )
    },

    drain(): Promise<void> {
      return writes.drain()
    },

    materialize,
    totalOf,

    rowShape(): RowShape {
      return {
        columns: [
          { name: 'id', kind: 'str', optional: false },
          { name: 'bucket_ts', kind: 'ts', optional: false },
          ...dimColumns(dims),
          { name: 'value', kind: isFloat ? 'float' : 'int', optional: false },
        ],
      }
    },
  }

  return self
}
