/**
 * The memory driver. Full parity with a shared driver, in plain Maps.
 *
 * Legitimate for a long-lived single process. Its `claim` is a read-and-hold
 * rather than a durable move, so `capabilities.durable` is `false` and the
 * guarantee is best-effort: a crash between claim and ack loses that window.
 *
 * It is the only driver that caps series, because nothing else is watching it.
 */

import {
  type AppendOp,
  type BucketClaim,
  type BucketQuery,
  type BucketRange,
  type BucketRow,
  type Cell,
  type Claim,
  type ClaimedBucket,
  type Driver,
  type GaugeOp,
  type IncrOp,
  isGaugeCell,
  isLevelCell,
  isRecordClaim,
  type LevelOp,
  type LevelSeries,
  NOTHING_RECOVERED,
  type PendingQuery,
  type RecordClaim,
  type RecoveryReport,
  type ShipTurn,
  type StagedRecord,
} from './types.js'

/**
 * Combine two cells for the same series and bucket.
 *
 * Used when a release finds the bucket was written again while it was claimed.
 * `newer` wins `last`, because it is the later observation; the other four
 * aggregates merge without caring about order.
 */
function mergeCells(older: Cell, newer: Cell): Cell {
  // a level does not accumulate: two cells for one window are the same
  // reading taken twice, and the later one is the one that is still true
  if (isLevelCell(older) && isLevelCell(newer)) return newer
  if (typeof older === 'number' && typeof newer === 'number') return older + newer
  if (!isGaugeCell(older) || !isGaugeCell(newer)) {
    throw new Error('memory driver: cannot merge cells of two different kinds')
  }

  return {
    last: newer.last,
    min: Math.min(older.min, newer.min),
    max: Math.max(older.max, newer.max),
    sum: older.sum + newer.sum,
    count: older.count + newer.count,
  }
}

/**
 * What one level `set` or `add` does to its series and its cells.
 *
 * The rule a shared driver has to follow as well, written once here in plain
 * code; the Redis driver's Lua mirrors it line for line.
 *
 * - `add` is a change, so it applies to every window from the one it lands
 *   in onwards: the landing cell, every later cell that already exists, the
 *   held value, and `carried` when the pointer is at or past the landing
 *   window. That is what keeps an `inc` and a `dec` from two processes right
 *   whichever order they arrive in.
 * - `set` is a reading. It becomes the landing cell. It becomes the held value
 *   and `carried` only if nothing newer has been written: a later window that
 *   already has a cell was written after this reading was taken.
 */
function planLevelWrite(
  op: LevelOp,
  bucketTs: number,
  held: LevelSeries | undefined,
  landingCell: number | undefined,
  later: readonly number[],
  valueBefore: () => number,
  cellAt: (bucketTs: number) => number,
): { cells: [number, number][]; series: LevelSeries } {
  const pointer = held?.heldThrough ?? bucketTs
  const writtenAt = Math.max(held?.writtenAt ?? bucketTs, bucketTs)

  if (op.mode === 'add') {
    const base = landingCell ?? (held === undefined ? 0 : valueBefore())
    const cells: [number, number][] = [[bucketTs, base + op.value]]
    for (const at of later) cells.push([at, cellAt(at) + op.value])
    const value = (held?.value ?? 0) + op.value
    return {
      cells,
      series: {
        dimKey: op.dimKey,
        value,
        carried:
          held === undefined ? value : bucketTs <= pointer ? held.carried + op.value : held.carried,
        writtenAt,
        heldThrough: pointer,
      },
    }
  }

  const superseded = later.length > 0
  const newerAtPointer = later.some((at) => at <= pointer)
  return {
    cells: [[bucketTs, op.value]],
    series: {
      dimKey: op.dimKey,
      value: held !== undefined && superseded ? held.value : op.value,
      carried:
        held === undefined
          ? op.value
          : bucketTs <= pointer && !newerAtPointer
            ? op.value
            : held.carried,
      writtenAt,
      heldThrough: pointer,
    },
  }
}

export interface MemoryDriverOptions {
  /**
   * Distinct dim keys held per metric, live or in flight, before writes are
   * refused. Defaults to 100_000. Set `Number.POSITIVE_INFINITY` to disable.
   *
   * This exists because an unbounded `userId` dim in a single process is an
   * out-of-memory crash with no warning. The cap turns it into a loud error
   * naming the metric.
   */
  readonly maxSeries?: number

  /**
   * Records held staged or in flight per metric before `append` is refused.
   * Defaults to 100_000. Set `Number.POSITIVE_INFINITY` to disable.
   *
   * The same argument as {@link MemoryDriverOptions.maxSeries}, for the other
   * storage model: an event backlog that nothing drains is an out-of-memory
   * crash, and a loud error naming the metric is a better failure. It is a
   * *backlog* cap, not a rate limit. A metric that flushes keeps almost
   * nothing here.
   */
  readonly maxStaged?: number
}

const DEFAULT_MAX_SERIES = 100_000
const DEFAULT_MAX_STAGED = 100_000

/**
 * Make `target` hold exactly `items`, in place.
 *
 * A loop rather than `splice(0, n, ...items)` or `push(...items)`, which pass
 * every item as a function argument and overflow the stack for a large one.
 */
function replaceContents<T>(target: T[], items: readonly T[]): void {
  target.length = 0
  for (const item of items) target.push(item)
}

/**
 * `-0` stored as `0`.
 *
 * Redis receives every number as text, and `String(-0)` is `"0"`, so a shared
 * driver can never hand back a negative zero. This one stores what Redis
 * would, so the two agree to the bit.
 */
function plainZero(value: number): number {
  return value === 0 ? 0 : value
}

/**
 * Refuse a whole number a double cannot hold exactly, for a metric that only
 * counts whole numbers.
 */
function assertSafe(value: number, metric: string, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `memory driver: ${metric} ${what} would be ${value}, which is past ` +
        `${Number.MAX_SAFE_INTEGER}, the largest whole number a double holds exactly, so the ` +
        'write was refused',
    )
  }
}

/**
 * Refuse a stored number that has left the range a double can hold.
 *
 * A counter at 1e308 that takes another 1e308 would otherwise read back as
 * Infinity here and as something else entirely from Redis. Refusing the
 * write is the one answer both drivers can give the same way.
 */
function assertFinite(value: number, metric: string, what: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      `memory driver: ${metric} ${what} would be ${value}, which is past the largest number ` +
        'a metric can store, so the write was refused',
    )
  }
}

/**
 * A cell a read can hand out.
 *
 * A gauge fold and a level cell are objects, and handing out the stored one
 * lets a caller who edits what `gauge.current()` returned change the row a
 * later flush ships. Redis hands back a fresh object on every read, and this
 * does the same.
 */
function copied(cell: Cell): Cell {
  return typeof cell === 'number' ? cell : { ...cell }
}

/** The value `map` holds under `key`, made and stored first if it holds none. */
function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    map.set(key, value)
  }
  return value
}

export function memory(options: MemoryDriverOptions = {}): Driver {
  const maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES
  const maxStaged = options.maxStaged ?? DEFAULT_MAX_STAGED

  /** metric -> bucketTs -> dimKey -> cell */
  const live = new Map<string, Map<number, Map<string, Cell>>>()

  /**
   * metric -> dimKey -> how many buckets hold it, live or in flight.
   *
   * Refcounted rather than recomputed: a flush acks once per window, and
   * rebuilding the set would be O(buckets x series) each time.
   */
  const holders = new Map<string, Map<string, number>>()

  /**
   * metric -> staged records, oldest first.
   *
   * A plain array rather than the bucket tree: events are never aggregated, so
   * there is nothing to key them by and nothing to merge. Append order is the
   * only order that exists, and preserving it is what makes a claim
   * reproducible.
   */
  const staged = new Map<string, StagedRecord[]>()

  /**
   * metric -> dimKey -> the value that series holds, and how far it has been
   * carried.
   *
   * Beside the bucket tree rather than in it, because a claim must never take
   * it: the whole reason a level can report a window nobody wrote to is that
   * this survives the flush that shipped the last one.
   */
  const levels = new Map<string, Map<string, LevelSeries>>()

  const inFlight = new Map<string, Claim>()
  let claimSeq = 0

  /**
   * metric -> the highest watermark any claim has used.
   *
   * Every window below it has been claimed at least once, so a write that
   * arrives for one of them now is late. It is moved to this window, the
   * oldest that has not shipped, rather than starting a second copy of a
   * window that already went. See {@link Driver.claim}.
   */
  const claimedUpTo = new Map<string, number>()

  /** metric -> when its last turn to ship was taken. See {@link Driver.takeTurn}. */
  const turns = new Map<string, number>()

  /** Where a write aimed at `bucketTs` actually lands. */
  function landing(metric: string, bucketTs: number): number {
    const floor = claimedUpTo.get(metric)
    return floor !== undefined && bucketTs < floor ? floor : bucketTs
  }

  /**
   * metric -> the order each staged record was appended in.
   *
   * What `release` merges by, so records put back after a failed write return
   * to the place they were taken from even when an older claim was released
   * first. A WeakMap keyed by the record, because the record itself is the
   * shape every driver stores and a counter on it would change that shape.
   */
  const appendOrder = new WeakMap<StagedRecord, number>()
  let appendSeq = 0

  /** metric -> records held in a claim but not yet settled. */
  const stagedInFlight = new Map<string, number>()

  function stagedFor(metric: string): StagedRecord[] {
    return getOrCreate(staged, metric, () => [])
  }

  function levelsFor(metric: string): Map<string, LevelSeries> {
    return getOrCreate(levels, metric, () => new Map())
  }

  /** The error every path that would add a series past `maxSeries` throws. */
  function seriesLimitError(metric: string): Error {
    return new Error(
      `memory driver: ${metric} exceeded maxSeries (${maxSeries}), which a dim with ` +
        'unbounded values will do. Put that value on an event instead',
    )
  }

  function nextClaimId(metric: string): string {
    claimSeq += 1
    return `${metric}#${claimSeq}`
  }

  /** Register a new claim as in flight, and hand it back. */
  function hold<C extends Claim>(claim: C): C {
    inFlight.set(claim.id, claim)
    return claim
  }

  /**
   * Take a claim out of the in-flight set, the first step of an ack or a
   * release.
   *
   * @throws if the claim is not in flight, because it was settled already
   */
  function settle(claim: Claim): void {
    if (!inFlight.delete(claim.id)) {
      throw new Error(`memory driver: claim ${claim.id} is not in flight. Was it already settled?`)
    }
  }

  /** Staged plus in-flight, because a claim that is never acked still occupies memory. */
  function stagedHeld(metric: string): number {
    return (staged.get(metric)?.length ?? 0) + (stagedInFlight.get(metric) ?? 0)
  }

  function addStagedInFlight(metric: string, delta: number): void {
    const next = (stagedInFlight.get(metric) ?? 0) + delta
    if (next <= 0) stagedInFlight.delete(metric)
    else stagedInFlight.set(metric, next)
  }

  function addHolder(metric: string, dimKey: string): void {
    const byKey = getOrCreate(holders, metric, () => new Map<string, number>())

    const count = byKey.get(dimKey)
    if (count === undefined) {
      if (byKey.size >= maxSeries) throw seriesLimitError(metric)
      byKey.set(dimKey, 1)
      return
    }

    byKey.set(dimKey, count + 1)
  }

  function removeHolder(metric: string, dimKey: string): void {
    const byKey = holders.get(metric)
    if (!byKey) return

    const count = byKey.get(dimKey)
    if (count === undefined) return

    if (count <= 1) {
      byKey.delete(dimKey)
      if (byKey.size === 0) holders.delete(metric)
      return
    }

    byKey.set(dimKey, count - 1)
  }

  function bucketsFor(metric: string): Map<number, Map<string, Cell>> {
    return getOrCreate(live, metric, () => new Map())
  }

  /**
   * metric -> the newest window a live bucket has ever been created for.
   *
   * Only ever raised, so it is at or past every live bucket, and a level
   * write landing at or past it knows no later window exists without looking
   * at each one. Every place that puts a bucket into {@link live} goes through
   * {@link addBucket} to keep that true.
   */
  const newestBucket = new Map<string, number>()

  /** Put a bucket into a metric's live set, and remember how new it is. */
  function addBucket(
    metric: string,
    byBucket: Map<number, Map<string, Cell>>,
    bucketTs: number,
    bucket: Map<string, Cell>,
  ): void {
    byBucket.set(bucketTs, bucket)
    const newest = newestBucket.get(metric)
    if (newest === undefined || bucketTs > newest) newestBucket.set(metric, bucketTs)
  }

  /** Get or create the bucket a write lands in, capping series on a new key. */
  function cellSlot(metric: string, bucketTs: number, dimKey: string): Map<string, Cell> {
    const byBucket = bucketsFor(metric)
    const existing = byBucket.get(bucketTs)
    // may throw on the cap, so it runs before the bucket is created. An empty
    // bucket left behind by a refused write would still be claimed, and ship
    // as a window with no rows in it
    if (!existing?.has(dimKey)) addHolder(metric, dimKey)
    if (existing) return existing

    const bucket = new Map<string, Cell>()
    addBucket(metric, byBucket, bucketTs, bucket)
    return bucket
  }

  /**
   * Store a level cell, and record how to take it back out.
   *
   * `setLevel` changes nothing when it refuses an op, and an op late in a
   * batch reads what the ops before it wrote, so it cannot all be checked
   * first. It writes as it goes instead, and a refusal undoes the writes.
   */
  function putLevelCell(
    metric: string,
    at: number,
    dimKey: string,
    level: number,
    undo: (() => void)[],
  ): void {
    const byBucket = bucketsFor(metric)
    const hadBucket = byBucket.has(at)
    const previous = byBucket.get(at)?.get(dimKey)
    cellSlot(metric, at, dimKey).set(dimKey, { level: plainZero(level) })
    undo.push(() => {
      const bucket = byBucket.get(at)
      if (!bucket) return
      if (previous !== undefined) {
        bucket.set(dimKey, previous)
        return
      }
      bucket.delete(dimKey)
      removeHolder(metric, dimKey)
      if (!hadBucket && bucket.size === 0) byBucket.delete(at)
    })
  }

  /** Store a level series, and record how to put the old one back. */
  function putLevelSeries(
    series: Map<string, LevelSeries>,
    next: LevelSeries,
    undo: (() => void)[],
  ): void {
    const previous = series.get(next.dimKey)
    series.set(next.dimKey, next)
    undo.push(() => {
      if (previous === undefined) series.delete(next.dimKey)
      else series.set(next.dimKey, previous)
    })
  }

  /**
   * Refuse a batch that would take a metric past `maxSeries`, before any of
   * it is stored.
   *
   * `addHolder` checks one key at a time, so a batch refused on its tenth new
   * series would otherwise keep the first nine.
   */
  function assertRoomFor(ops: readonly { metric: string; dimKey: string }[]) {
    const fresh = new Map<string, Set<string>>()
    for (const op of ops) {
      if (holders.get(op.metric)?.has(op.dimKey)) continue
      getOrCreate(fresh, op.metric, () => new Set()).add(op.dimKey)
    }
    for (const [metric, keys] of fresh) {
      if ((holders.get(metric)?.size ?? 0) + keys.size > maxSeries) {
        throw seriesLimitError(metric)
      }
    }
  }

  /**
   * Work out every cell a batch of increments or observations ends with, then
   * store them.
   *
   * The whole batch is worked out and checked before any of it lands, so a
   * refusal halfway through changes nothing. `fold` gets the cell as the batch
   * has left it so far, which is what keeps two ops for one series in one call
   * in order.
   */
  function applyCells<Op extends { metric: string; bucketTs: number; dimKey: string }>(
    ops: readonly Op[],
    fold: (op: Op, existing: Cell | undefined) => Cell,
  ): void {
    const planned = new Map<
      string,
      { metric: string; bucketTs: number; dimKey: string; cell: Cell }
    >()
    for (const op of ops) {
      const bucketTs = landing(op.metric, op.bucketTs)
      const slot = `${op.metric}\u0000${bucketTs}\u0000${op.dimKey}`
      const existing = planned.get(slot)?.cell ?? live.get(op.metric)?.get(bucketTs)?.get(op.dimKey)
      planned.set(slot, {
        metric: op.metric,
        bucketTs,
        dimKey: op.dimKey,
        cell: fold(op, existing),
      })
    }
    assertRoomFor([...planned.values()])
    for (const { metric, bucketTs, dimKey, cell } of planned.values()) {
      cellSlot(metric, bucketTs, dimKey).set(dimKey, cell)
    }
  }

  /** One level op, its writes recorded in `undo`. See {@link Driver.setLevel}. */
  function applyLevel(op: LevelOp, undo: (() => void)[]): void {
    const series = levelsFor(op.metric)
    const held = series.get(op.dimKey)

    if (op.mode === 'hold') {
      // a series storage has never seen has nothing to carry, and a hold
      // must not be what brings one into existence
      if (!held) return

      // the value the window ends at: the one carried into it, or the one a
      // write already put there
      let carried = plainZero(op.value)

      // a window some claim has already taken is not filled again: that
      // would ship it a second time. The pointer still moves past it
      const claimed = landing(op.metric, op.bucketTs) !== op.bucketTs
      if (!claimed) {
        const written = bucketsFor(op.metric).get(op.bucketTs)?.get(op.dimKey)
        // a written value always beats a carried one, so a window that
        // already has a cell keeps it, and so does `carried`. The hold's
        // value was read before that write landed
        if (written === undefined) putLevelCell(op.metric, op.bucketTs, op.dimKey, carried, undo)
        else if (isLevelCell(written)) carried = written.level
      }

      // `carried` belongs to the pointer's window. A hold for an older
      // window, from a flusher whose clock runs behind, arrives after the
      // pointer has passed it and must not drag `carried` back with it. Nor
      // may a hold for the pointer's own window that arrives again once a
      // claim has taken it: the cell that would say what it ended at is gone,
      // and `carried` already holds that value
      if (op.bucketTs > held.heldThrough || (op.bucketTs === held.heldThrough && !claimed)) {
        putLevelSeries(series, { ...held, carried, heldThrough: op.bucketTs }, undo)
      }
      return
    }

    if (!held && series.size >= maxSeries) throw seriesLimitError(op.metric)

    const bucketTs = landing(op.metric, op.bucketTs)
    const byBucket = bucketsFor(op.metric)
    const cellAt = (at: number): number | undefined => {
      const cell = byBucket.get(at)?.get(op.dimKey)
      if (cell === undefined) return undefined
      if (!isLevelCell(cell)) {
        throw new Error(
          `memory driver: ${op.metric} holds ${isGaugeCell(cell) ? 'gauge' : 'counter'} ` +
            'cells, and set is a level op',
        )
      }
      return cell.level
    }

    // windows after this one that already hold a value for the series. Two
    // processes writing across a boundary can land the later window first,
    // and the rule below keeps both windows right whichever arrives second.
    // A write at or past the newest bucket, which is nearly every write,
    // has none, and skips a scan that grows with every unflushed window
    const newest = newestBucket.get(op.metric)
    const later =
      newest === undefined || bucketTs >= newest
        ? []
        : [...byBucket.keys()]
            .filter((at) => at > bucketTs && cellAt(at) !== undefined)
            .sort((a, b) => a - b)

    const plan = planLevelWrite(
      op,
      bucketTs,
      held,
      cellAt(bucketTs),
      later,
      () => {
        // the value in effect just before this window: the newest cell
        // between the pointer and here, or what the pointer carried
        let before: number | undefined
        let newest = Number.NEGATIVE_INFINITY
        for (const at of byBucket.keys()) {
          const level = at < bucketTs && at > (held?.heldThrough ?? -1) ? cellAt(at) : undefined
          if (level !== undefined && at > newest) {
            newest = at
            before = level
          }
        }
        return before ?? held?.carried ?? 0
      },
      (at) => cellAt(at) as number,
    )

    for (const [, level] of plan.cells) assertFinite(level, op.metric, 'level')
    assertFinite(plan.series.value, op.metric, 'level')
    if (op.integer) {
      for (const [, level] of plan.cells) assertSafe(level, op.metric, 'level')
      assertSafe(plan.series.value, op.metric, 'level')
    }

    // the bucket first, because `cellSlot` is the other thing that can
    // refuse on the cap, and a held value written before it would name a
    // window that holds nothing
    for (const [at, level] of plan.cells) putLevelCell(op.metric, at, op.dimKey, level, undo)
    putLevelSeries(
      series,
      {
        ...plan.series,
        value: plainZero(plan.series.value),
        carried: plainZero(plan.series.carried),
      },
      undo,
    )
  }

  return {
    capabilities: {
      durable: false,
      shared: false,
      atomicMerge: true,
    },

    async increment(ops: readonly IncrOp[]): Promise<void> {
      applyCells(ops, (op, existing) => {
        if (existing !== undefined && typeof existing !== 'number') {
          throw new Error(
            `memory driver: ${op.metric} holds ${isGaugeCell(existing) ? 'gauge' : 'level'} ` +
              'cells, and increment is a counter op',
          )
        }
        const next = (existing ?? 0) + op.delta
        assertFinite(next, op.metric, 'total')
        if (op.integer) assertSafe(next, op.metric, 'total')
        return plainZero(next)
      })
    },

    async observe(ops: readonly GaugeOp[]): Promise<void> {
      applyCells(ops, (op, existing) => {
        const value = plainZero(op.value)
        if (existing === undefined) {
          assertFinite(value, op.metric, 'sum')
          return { last: value, min: value, max: value, sum: value, count: 1 }
        }
        if (!isGaugeCell(existing)) {
          throw new Error(
            `memory driver: ${op.metric} holds ${isLevelCell(existing) ? 'level' : 'counter'} ` +
              'cells, and observe is a gauge op',
          )
        }

        // read, modify, write: min, max and last are not increments
        const sum = existing.sum + value
        assertFinite(sum, op.metric, 'sum')
        return {
          last: value,
          min: plainZero(Math.min(existing.min, value)),
          max: plainZero(Math.max(existing.max, value)),
          sum: plainZero(sum),
          count: existing.count + 1,
        }
      })
    },

    async setLevel(ops: readonly LevelOp[]): Promise<void> {
      // a refused op takes the whole call back with it, so a batch is
      // applied entirely or not at all
      const undo: (() => void)[] = []
      try {
        for (const op of ops) applyLevel(op, undo)
      } catch (error) {
        for (const step of undo.reverse()) step()
        throw error
      }
    },

    async readLevels(metric: string): Promise<LevelSeries[]> {
      const series = levels.get(metric)
      if (!series) return []
      return [...series.values()].sort((a, b) => (a.dimKey < b.dimKey ? -1 : 1))
    },

    async readLevel(metric: string, dimKey: string): Promise<LevelSeries | undefined> {
      return levels.get(metric)?.get(dimKey)
    },

    async dropLevels(
      metric: string,
      dimKeys: readonly string[],
      writtenBefore?: number,
    ): Promise<void> {
      const series = levels.get(metric)
      if (!series) return

      for (const dimKey of dimKeys) {
        const held = series.get(dimKey)
        // a series written since the caller decided to drop it is kept
        if (held && writtenBefore !== undefined && held.writtenAt >= writtenBefore) continue
        series.delete(dimKey)
      }
      if (series.size === 0) levels.delete(metric)
    },

    async append(ops: readonly AppendOp[]): Promise<void> {
      // counted before anything is written, so a refused batch stages none of
      // itself. A half-appended batch would be re-sent whole on retry and
      // duplicate the part that landed
      const wanted = new Map<string, number>()
      for (const op of ops) {
        wanted.set(op.metric, (wanted.get(op.metric) ?? 0) + 1)
      }
      for (const [metric, count] of wanted) {
        if (stagedHeld(metric) + count > maxStaged) {
          throw new Error(
            `memory driver: ${metric} exceeded maxStaged (${maxStaged}). Staged events ` +
              'are only drained by flush(), so this is a backlog that nothing is shipping',
          )
        }
      }

      for (const op of ops) {
        const record: StagedRecord = { id: op.id, ts: op.ts, fields: op.fields }
        appendSeq += 1
        appendOrder.set(record, appendSeq)
        stagedFor(op.metric).push(record)
      }
    },

    async readBuckets(query: BucketQuery): Promise<BucketRow[]> {
      const byBucket = live.get(query.metric)
      if (!byBucket) return []

      const rows: BucketRow[] = []
      for (const [bucketTs, bucket] of byBucket) {
        if (query.from !== undefined && bucketTs < query.from) continue
        if (query.to !== undefined && bucketTs >= query.to) continue

        // one series is a lookup, not a scan: `current(dims)` and every
        // immediate send ask for exactly one, and walking every series in the
        // window made them slower the more series it held
        if (query.dimKey !== undefined) {
          const value = bucket.get(query.dimKey)
          if (value !== undefined)
            rows.push({ bucketTs, dimKey: query.dimKey, value: copied(value) })
          continue
        }
        for (const [dimKey, value] of bucket) rows.push({ bucketTs, dimKey, value: copied(value) })
      }

      // deterministic order, so callers and tests never depend on Map insertion
      rows.sort((a, b) => a.bucketTs - b.bucketTs || (a.dimKey < b.dimKey ? -1 : 1))
      return rows
    },

    async sumBuckets(query: BucketRange): Promise<number | undefined> {
      // the same rule the Redis driver keeps, so the two answer alike: only a
      // sum no order of adding could change
      let positive = 0
      let negative = 0
      for (const [bucketTs, bucket] of live.get(query.metric) ?? []) {
        if (query.from !== undefined && bucketTs < query.from) continue
        if (query.to !== undefined && bucketTs >= query.to) continue
        for (const cell of bucket.values()) {
          if (typeof cell !== 'number' || !Number.isInteger(cell)) return undefined
          if (cell >= 0) positive += cell
          else negative += cell
          if (positive > Number.MAX_SAFE_INTEGER || negative < -Number.MAX_SAFE_INTEGER) {
            return undefined
          }
        }
      }
      return positive + negative
    },

    async readPending(query: PendingQuery): Promise<StagedRecord[]> {
      const records = staged.get(query.metric)
      if (!records) return []
      if (query.limit !== undefined && query.limit <= 0) return []

      const matched: StagedRecord[] = []
      for (const record of records) {
        if (query.from !== undefined && record.ts < query.from) continue
        if (query.to !== undefined && record.ts >= query.to) continue
        matched.push(record)
        // append order is already ts order for anything not backdated, and the
        // caller asked for the first n, so stop rather than scan the backlog
        if (query.limit !== undefined && matched.length >= query.limit) break
      }
      return matched
    },

    async countPending(metric: string): Promise<number> {
      // claimed and not yet settled still counts: those records have not
      // shipped, and a sink that hangs should not make a backlog read zero
      return stagedHeld(metric)
    },

    async claim(metric: string, upToBucketTs: number): Promise<BucketClaim> {
      const byBucket = live.get(metric)
      const claimed: ClaimedBucket[] = []

      if (byBucket) {
        const timestamps = [...byBucket.keys()]
          .filter((bucketTs) => bucketTs < upToBucketTs)
          .sort((a, b) => a - b)

        for (const bucketTs of timestamps) {
          const bucket = byBucket.get(bucketTs)
          if (!bucket) continue
          // moved out of live: invisible to readBuckets and to a second claim.
          // Holder counts are untouched, because the data is still held in memory.
          byBucket.delete(bucketTs)
          claimed.push({ bucketTs, values: bucket })
        }
      }

      // raised even by a claim that found nothing: the watermark is the promise
      // that every window below it has been claimed once, whatever was in it
      claimedUpTo.set(metric, Math.max(claimedUpTo.get(metric) ?? upToBucketTs, upToBucketTs))

      return hold<BucketClaim>({
        kind: 'buckets',
        id: nextClaimId(metric),
        metric,
        claimedAt: Date.now(),
        buckets: claimed,
      })
    },

    async claimRecords(metric: string, limit?: number): Promise<RecordClaim> {
      const records = stagedFor(metric)

      // oldest first, and only as many as asked for: the rest stay staged and
      // visible, so a backlog drains across flushes instead of arriving as one
      // batch the sink cannot take
      const taken = limit === undefined ? records.splice(0) : records.splice(0, Math.max(0, limit))
      addStagedInFlight(metric, taken.length)

      return hold<RecordClaim>({
        kind: 'records',
        id: nextClaimId(metric),
        metric,
        claimedAt: Date.now(),
        records: taken,
      })
    },

    async ack(claim: Claim): Promise<void> {
      settle(claim)

      if (isRecordClaim(claim)) {
        addStagedInFlight(claim.metric, -claim.records.length)
        return
      }

      for (const bucket of claim.buckets) {
        for (const dimKey of bucket.values.keys()) {
          removeHolder(claim.metric, dimKey)
        }
      }
    },

    async release(claim: Claim): Promise<void> {
      settle(claim)

      if (isRecordClaim(claim)) {
        addStagedInFlight(claim.metric, -claim.records.length)
        // back where they were taken from. They are older than anything
        // appended while they were in flight, but a claim released before
        // this one may already be back at the front, and it is older still
        const records = stagedFor(claim.metric)
        const merged = [...claim.records, ...records].sort(
          (a, b) => (appendOrder.get(a) ?? 0) - (appendOrder.get(b) ?? 0),
        )
        // copied back one by one: `splice(0, n, ...merged)` passes every
        // record as an argument and overflows the stack past about 125,000
        // of them, after the claim has already been settled
        replaceContents(records, merged)
        return
      }

      const byBucket = bucketsFor(claim.metric)

      for (const claimedBucket of claim.buckets) {
        const existing = byBucket.get(claimedBucket.bucketTs)

        if (!existing) {
          addBucket(claim.metric, byBucket, claimedBucket.bucketTs, new Map(claimedBucket.values))
          continue
        }

        // a write can land in a bucket while it is claimed, backdated or a
        // straggler. Merge rather than overwrite, or that increment is lost.
        for (const [dimKey, value] of claimedBucket.values) {
          const current = existing.get(dimKey)
          if (current === undefined) {
            existing.set(dimKey, value)
            continue
          }
          // two holders collapse into one
          removeHolder(claim.metric, dimKey)
          existing.set(dimKey, mergeCells(value, current))
        }
      }
    },

    async recover(): Promise<RecoveryReport> {
      // Nothing to find, and not because the sweep is unimplemented: this
      // driver's claims live in `inFlight`, a Map in the process that took
      // them. A process that dies takes the Map with it, so there is never an
      // abandoned claim left behind to return. The window is simply gone.
      // That is the whole of what `durable: false` costs, said once more here
      // so it cannot be mistaken for an oversight.
      return NOTHING_RECOVERED
    },

    async takeTurn(metric: string, now: number, gapMs: number): Promise<ShipTurn> {
      const last = turns.get(metric)
      if (last !== undefined && Math.abs(now - last) < gapMs) {
        return { granted: false, lastTakenAt: last }
      }
      turns.set(metric, now)
      return { granted: true, previous: last }
    },

    async returnTurn(metric: string, at: number, previous: number | undefined): Promise<void> {
      if (turns.get(metric) !== at) return
      if (previous === undefined) turns.delete(metric)
      else turns.set(metric, previous)
    },
  }
}
