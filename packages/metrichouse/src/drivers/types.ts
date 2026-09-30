/**
 * The driver contract. Storage for open buckets and staged records, and the
 * claim/ack handshake that makes at-least-once possible.
 *
 * **Deliberately small.** A method is only here once a driver or a primitive
 * needs it, because a method written ahead of that would enshrine a guess
 * about a shape nothing has exercised. `setLevel`, `readLevels` and
 * `dropLevels` are here because `level()` needed them.
 *
 * There are two storage models here, and the split is the whole shape of the
 * file:
 *
 * ```
 * aggregate  counter, gauge   bucket -> series -> folded cell   claim(metric, watermark)
 * staged     event            an append-only run of records     claimRecords(metric, limit)
 * ```
 *
 * A level is an aggregate with one extra piece of state. Its buckets claim and
 * settle like any other, and beside them the driver holds the value each
 * series is currently at, which no claim ever takes. That held value is what
 * lets a window nobody wrote to still ship a row.
 *
 * An aggregate claim takes a **watermark**, because whether a bucket may ship
 * is a question about time, namely whether it is still open, or still inside grace. A staged
 * claim takes a **limit**, because a record is complete the instant it is
 * appended and the only question left is how many to carry at once.
 *
 * The driver knows nothing about time in either case. It is handed a watermark
 * and claims everything strictly below it; deciding what "closed" means belongs
 * to `time/buckets.ts`, which is the only place that knows a metric's
 * resolution and grace.
 */

/** One counter increment, already bucketed and keyed. */
export interface IncrOp {
  readonly metric: string
  readonly bucketTs: number
  /**
   * How wide the metric's windows are. A write aimed below the claimed
   * watermark lands on the first window of this grid at or past it, so it
   * stays on the metric's own boundaries even when the watermark was set by
   * a claim on another grid. See {@link Driver.claim}.
   */
  readonly resolutionMs: number
  readonly dimKey: string
  readonly delta: number
  /**
   * The metric counts whole numbers. A total past `Number.MAX_SAFE_INTEGER`
   * is refused, because a double past it cannot hold every whole number and
   * the total would silently stop being exact.
   */
  readonly integer?: boolean
}

/** One gauge observation, already bucketed and keyed. */
export interface GaugeOp {
  readonly metric: string
  readonly bucketTs: number
  /** How wide the metric's windows are, as {@link IncrOp.resolutionMs} says. */
  readonly resolutionMs: number
  readonly dimKey: string
  readonly value: number
}

/**
 * One write to a level, already bucketed and keyed.
 *
 * `mode` is the whole of what separates the three:
 *
 * - `set` puts the series at `value`.
 * - `add` moves it by `value`, treating an untouched series as zero.
 * - `hold` writes `value` into `bucketTs` only if that window has no cell
 *   yet, and moves the pointer. This is the one a flush issues for windows
 *   nobody wrote to.
 *
 * A hold names its value rather than reading the held one because the window
 * it fills is in the past, and the series may have moved since. Filling the
 * three minutes before a write with the value that write introduced would
 * report a queue that changed earlier than it did.
 */
export interface LevelOp {
  readonly metric: string
  readonly bucketTs: number
  /** How wide the metric's windows are, as {@link IncrOp.resolutionMs} says. */
  readonly resolutionMs: number
  readonly dimKey: string
  readonly value: number
  readonly mode: 'set' | 'add' | 'hold'
  /** The level holds whole numbers, as {@link IncrOp.integer} says of a counter. */
  readonly integer?: boolean
}

/**
 * One series of a level, as the driver holds it between flushes.
 *
 * Outlives every claim, which is the point: a series written once and never
 * again keeps reporting, and the only way to know what to report is to have
 * kept the number somewhere an `ack` does not reach.
 */
export interface LevelSeries {
  readonly dimKey: string
  /** What the series is at right now. */
  readonly value: number
  /**
   * What the series was at in the window `heldThrough` names.
   *
   * The starting point for the next carry, and not always `value`: a write
   * that lands after the last carried window moves one and not the other,
   * and the windows in between belong to the older number.
   */
  readonly carried: number
  /**
   * The bucket the last `set` or `add` landed in.
   *
   * A bucket timestamp and not a wall clock reading, so the driver still has
   * no clock of its own: everything it stores about time was handed to it.
   * A `holdFor` expiry is measured from here.
   */
  readonly writtenAt: number
  /**
   * The newest bucket this series has been carried through.
   *
   * Moved only by a `hold`, never by a `set` or an `add`. A series that is
   * written at noon and again at three is still owed a row for every window
   * in between, and a pointer that jumped to the later write would skip them.
   */
  readonly heldThrough: number
}

/**
 * One record to stage, already stamped and identified.
 *
 * The id is minted by the metric at `record()` time rather than here, so a
 * released batch keeps the ids it was first given and a retried write is
 * recognisable by content, the same property `rowId` gives an aggregate row.
 */
export interface AppendOp {
  readonly metric: string
  readonly id: string
  readonly ts: number
  readonly fields: Readonly<Record<string, unknown>>
}

/**
 * One record as the driver holds it.
 *
 * `fields` is **opaque**: the driver stores it and hands it back untouched. It
 * does not know which keys are declared, which are reserved, or how any of it
 * becomes a column. That is the metric's business, and keeping it out of
 * storage is what lets a driver serve a primitive it has never heard of.
 */
export interface StagedRecord {
  readonly id: string
  readonly ts: number
  readonly fields: Readonly<Record<string, unknown>>
}

/**
 * A gauge's folded state for one series in one bucket.
 *
 * These five merge across buckets; `avg` does not, which is why it is derived
 * at query time from `sum / count` and never stored.
 */
export interface GaugeCell {
  readonly last: number
  readonly min: number
  readonly max: number
  readonly sum: number
  readonly count: number
}

/**
 * A level's value for one series in one bucket.
 *
 * Boxed rather than stored as a bare number so storage can tell it apart from
 * a counter's scalar. The two look identical on the wire and merge by opposite
 * rules: two counter cells for one bucket add, two level cells do not, because
 * a level that read 42 twice still reads 42.
 */
export interface LevelCell {
  readonly level: number
}

/**
 * What a driver holds for one series in one bucket.
 *
 * A counter keeps a scalar, a gauge keeps a fold, a level keeps its held
 * value. The driver never interprets any of them. It stores what the metric
 * wrote and hands it back. Narrowing is the metric's job, because the metric
 * is the only thing that knows its own kind.
 */
export type Cell = number | GaugeCell | LevelCell

/** True when this cell came from a gauge. */
export function isGaugeCell(cell: Cell): cell is GaugeCell {
  return typeof cell === 'object' && 'count' in cell
}

/** True when this cell came from a level. */
export function isLevelCell(cell: Cell): cell is LevelCell {
  return typeof cell === 'object' && 'level' in cell
}

/**
 * A live read over unflushed buckets.
 *
 * `from`/`to` are a half-open range `[from, to)` in bucket timestamps. There
 * is no `complete` flag: excluding the open bucket is just `to =
 * bucketStart(now, resolution)`, and keeping resolution out of the driver is
 * what stops storage from needing to understand metric config.
 */
export interface BucketQuery {
  readonly metric: string
  readonly dimKey?: string
  readonly from?: number
  readonly to?: number
}

/** A {@link BucketQuery} over every series: the windows `[from, to)` of one metric. */
export type BucketRange = Pick<BucketQuery, 'metric' | 'from' | 'to'>

/** One series in one bucket. */
export interface BucketRow {
  readonly bucketTs: number
  readonly dimKey: string
  readonly value: Cell
}

/**
 * A live read over staged, unclaimed records.
 *
 * `from`/`to` bound the record timestamp, half-open `[from, to)`. `limit`
 * caps what comes back. `peek(n)` is this, and on a stream-backed driver it
 * is the difference between an `XRANGE COUNT n` and dragging the whole
 * backlog over the wire.
 */
export interface PendingQuery {
  readonly metric: string
  readonly from?: number
  readonly to?: number
  readonly limit?: number
}

/** One claimed bucket: every series in it, keyed by dim key. */
export interface ClaimedBucket {
  readonly bucketTs: number
  readonly values: ReadonlyMap<string, Cell>
}

/** What every claim carries, whatever it holds. */
interface ClaimBase {
  readonly id: string
  readonly metric: string
  readonly claimedAt: number
}

/** Aggregated data moved out of the live set: counter and gauge. */
export interface BucketClaim extends ClaimBase {
  readonly kind: 'buckets'
  /** Ascending by `bucketTs`, so rows ship in a deterministic order. */
  readonly buckets: readonly ClaimedBucket[]
}

/** Staged records moved out of the live set: event. */
export interface RecordClaim extends ClaimBase {
  readonly kind: 'records'
  /**
   * In append order, which is ascending by `ts` for every record that was
   * not backdated.
   */
  readonly records: readonly StagedRecord[]
}

/**
 * A batch of data moved out of the live set and held pending a `write()`.
 *
 * Invisible to {@link Driver.readBuckets}, to {@link Driver.readPending}, and
 * to a second claim. That invisibility is what stops two flushers from
 * shipping the same window.
 */
export type Claim = BucketClaim | RecordClaim

export function isRecordClaim(claim: Claim): claim is RecordClaim {
  return claim.kind === 'records'
}

export function isBucketClaim(claim: Claim): claim is BucketClaim {
  return claim.kind === 'buckets'
}

/** True when a claim carries nothing, so the flush has no reason to call a sink. */
export function isEmptyClaim(claim: Claim): boolean {
  return isRecordClaim(claim) ? claim.records.length === 0 : claim.buckets.length === 0
}

/**
 * What a recovery pass put back into the live set.
 *
 * Counted rather than swallowed: a non-zero `claims` means a flusher died
 * between taking a batch and settling it. The data is safe again by the time
 * this is returned, but the crash that stranded it is worth hearing about, so
 * it rides back on the flush report instead of quietly self-healing.
 */
export interface RecoveryReport {
  /** Abandoned claims returned to the live set. */
  readonly claims: number
  /** Buckets put back, summed across those claims. `0` for a staged metric. */
  readonly buckets: number
  /** Records put back, summed across those claims. `0` for a bucketed metric. */
  readonly records: number
  /**
   * When the oldest claim recovered was taken, so a caller can say how long
   * the data sat stranded. Absent when nothing was recovered.
   */
  readonly oldestClaimedAt?: number
}

/**
 * A pass that found nothing, the overwhelmingly common case.
 *
 * Frozen and shared rather than rebuilt per call: a flush asks every metric
 * every time, and almost every answer is this one.
 */
export const NOTHING_RECOVERED: RecoveryReport = Object.freeze({
  claims: 0,
  buckets: 0,
  records: 0,
})

/**
 * One turn to ship, as a driver records it.
 *
 * The token is what tells two turns apart. Two processes can take a turn in
 * the same millisecond, a forced flush beside a scheduled one, and a turn
 * named by its time alone would let the first give back the second.
 */
export interface Turn {
  /** When it was taken, by the clock of the flush that took it. */
  readonly at: number
  /** Unique to this turn. */
  readonly token: string
}

/**
 * What {@link Driver.takeTurn} answers.
 *
 * Granted, it carries the turn it recorded and the one that turn replaced, so
 * a flush that ships nothing can put the old one back with
 * {@link Driver.returnTurn}. Refused, it carries when the turn in the way was
 * taken, so the flush can say how long to wait.
 */
export type ShipTurn =
  | { readonly granted: true; readonly turn: Turn; readonly previous: Turn | undefined }
  | { readonly granted: false; readonly lastTakenAt: number }

/**
 * What a driver can honestly promise. The house reads this to decide whether
 * at-least-once is available, and warns once at boot when it is not.
 */
export interface DriverCapabilities {
  /** Survives a process restart. False for memory: `claim` is read-and-hold. */
  readonly durable: boolean
  /** Visible to other processes, so N instances share one set of buckets. */
  readonly shared: boolean
  /** Concurrent increments to one series merge without a read-modify-write. */
  readonly atomicMerge: boolean
}

/**
 * Storage for open buckets and staged records.
 *
 * ```
 * claim  -> data moves out of the live set
 * write  -> your sink runs
 *   ok   -> ack     -> deleted
 *   fail -> release -> claimable again next flush
 * ```
 *
 * Nothing is deleted before `write()` resolves. That is the entire
 * at-least-once guarantee, and it is why a duplicate is possible and a loss is
 * not.
 */
export interface Driver {
  readonly capabilities: DriverCapabilities

  /** Apply increments. Batched: one round trip per call, not per op. */
  increment(ops: readonly IncrOp[]): Promise<void>

  /**
   * Fold observations into `last / min / max / sum / count`.
   *
   * Unlike `increment`, this is a read-modify-write: `min`, `max` and `last`
   * are not increments. A shared driver has to make it atomic, with a Lua script
   * on Redis, or concurrent writers lose observations.
   */
  observe(ops: readonly GaugeOp[]): Promise<void>

  /**
   * Apply level writes, and carry held values into windows that have none.
   *
   * Two things move per op, and they move together or not at all: the series'
   * held value, and the cell in the bucket named by the op. A driver that
   * wrote one without the other would either report a level it no longer
   * holds or hold one it never reported.
   *
   * A `hold` for a series the driver has never seen does nothing. There is no
   * value to carry, and inventing a zero would put a line on a chart for a
   * queue that has never existed.
   */
  setLevel(ops: readonly LevelOp[]): Promise<void>

  /**
   * Every series a level currently holds, ascending by dim key.
   *
   * Unaffected by claims: this is the state beside the buckets, not in them.
   * A flush reads it to work out which windows each series still owes a row
   * for, and a live read uses it to answer what a series is at right now.
   */
  readLevels(metric: string): Promise<LevelSeries[]>

  /**
   * The one series a level holds under `dimKey`, or `undefined` when it holds
   * none. The same series {@link readLevels} would list for that key.
   *
   * Optional. `level.current(dims)` uses it to ask about one series without
   * fetching every series the level holds, and falls back to `readLevels`
   * when a driver leaves it out.
   */
  readLevel?(metric: string, dimKey: string): Promise<LevelSeries | undefined>

  /**
   * Forget these series entirely, with their held value, timestamp and pointer.
   *
   * What a `holdFor` expiry calls. Their already-shipped buckets are
   * untouched; what goes is the reason to keep emitting new ones.
   *
   * With `writtenBefore`, a series is only dropped if its `writtenAt` is still
   * below it, checked at the moment of the drop. A flush decides a series has
   * expired from a read taken a little earlier, and a `set` can land between
   * that read and this call. Checking again here is what stops the drop from
   * erasing the write.
   */
  dropLevels(metric: string, dimKeys: readonly string[], writtenBefore?: number): Promise<void>

  /**
   * Stage records verbatim.
   *
   * The one write path that does not aggregate: two identical records are two
   * rows, because the whole reason an event exists is to hold the
   * high-cardinality detail a counter had to throw away.
   */
  append(ops: readonly AppendOp[]): Promise<void>

  /** Unflushed buckets only. Claimed buckets are not visible here. */
  readBuckets(query: BucketQuery): Promise<BucketRow[]>

  /**
   * Every counter cell in the range added up, when that sum is exact.
   *
   * Exact means the same number whatever order the cells are added in, which
   * holds when every cell is a whole number, the positive cells add up to less
   * than 2^53 and the negative cells to more than -2^53. Every partial sum then
   * lies between the two, where a double holds each whole number. Anything
   * else answers `undefined`: a fraction, a gauge or level cell, or a sum past
   * either limit.
   *
   * Optional. `counter.current()` on an integer counter uses it to total the
   * open window without fetching every series in it, and reads the cells with
   * {@link readBuckets} when a driver leaves it out or answers `undefined`.
   */
  sumBuckets?(query: BucketRange): Promise<number | undefined>

  /**
   * Staged, unclaimed records only, in append order. That is ascending by
   * `ts` except for a record appended with a `ts` older than one before it,
   * which keeps its place in the line.
   */
  readPending(query: PendingQuery): Promise<StagedRecord[]>

  /**
   * How many records have not shipped: staged, plus claimed and not yet
   * settled.
   *
   * Separate from `readPending` because it is a different call on a real
   * driver, `XLEN` against an `XRANGE`, and counting by reading a million
   * staged rows over the wire is not a thing to make easy.
   */
  countPending(metric: string): Promise<number>

  /**
   * Move every bucket **strictly below** `upToBucketTs` into a claim, and
   * with `aheadFrom`, every bucket at or past `aheadFrom` too.
   *
   * `aheadFrom` is for a final flush on storage that does not outlive the
   * process. The windows ahead of the flusher's clock would die with it, so
   * it takes them as well and leaves only the window its clock is in. A
   * bound below `upToBucketTs` counts as `upToBucketTs`.
   *
   * Also raises the metric's **watermark**, and from then on every write
   * aimed below it (`increment`, `observe`, and a level `set` or `add`) lands
   * on the first window of its own resolution at or past the watermark
   * instead. A window below the watermark has already been claimed, and a
   * write that reaches it late, from a slow request or a clock that runs
   * behind, would otherwise start a second copy of a window that already
   * shipped. That copy would carry the same row id and only the late part of
   * the value, and a sink keeping the newest row per id would throw away the
   * rest. Moving the write forward keeps every total exact, at the cost of
   * counting it one window later than it happened.
   *
   * The watermark rises to `upToBucketTs`, or to one past the newest window
   * any live bucket held when the claim began if that is lower, or to one
   * past the newest window the claim took if that is higher. It never falls.
   * The newest live window is the limit because every window past it was
   * empty: nothing in it shipped, so a write that arrives for it later is
   * its first copy and keeps its own window. That is what stops a claim on a
   * clock far ahead from moving every write for days into one window. A
   * claim that finds no live bucket leaves the watermark where it was.
   *
   * A level `hold` aimed below the watermark writes no cell and still moves
   * the series' pointer, for the same reason.
   *
   * @throws when `upToBucketTs` is not a finite number, before anything is
   * claimed. A watermark of NaN would compare false against every window and
   * stop every later write from moving forward.
   */
  claim(metric: string, upToBucketTs: number, aheadFrom?: number): Promise<BucketClaim>

  /**
   * The window a write aimed at `bucketTs` would land in now: `bucketTs`
   * itself, or the first window of `resolutionMs` at or past the watermark
   * when `bucketTs` is below it. See {@link claim}.
   *
   * Optional. `current()` reads the window this names, so a write the
   * watermark moved ahead of the clock still counts in the open total. A
   * driver that leaves it out is read at `bucketTs`.
   */
  landing?(metric: string, bucketTs: number, resolutionMs: number): Promise<number>

  /**
   * Move staged records into a claim, oldest first, at most `limit` of them.
   *
   * No watermark: a record is complete when it is appended, so there is no
   * equivalent of an open bucket to hold back. `limit` is what bounds a flush
   * that would otherwise carry a backlog larger than the sink can take.
   */
  claimRecords(metric: string, limit?: number): Promise<RecordClaim>

  /** The write succeeded, so discard the claimed data. */
  ack(claim: Claim): Promise<void>

  /** The write failed, so return the claimed data to the live set. */
  release(claim: Claim): Promise<void>

  /**
   * Return claims abandoned by a dead flusher to the live set.
   *
   * The gap `claim` opens and `ack` closes. A claim moves data **out** of the
   * live set, so a process that dies in between leaves a batch that is neither
   * shipped nor claimable. `claim` only ever reads the live set, and the
   * abandoned batch is no longer in it. Durable storage is what keeps that
   * batch in existence; this is the pass that makes it reachable again.
   *
   * Put back, never shipped from here. An aggregate row is identified by its
   * metric, window and dims, so an abandoned half and a live half carry the
   * *same* row id: shipping them as two batches would let a sink upserting on
   * that id keep one and discard the other. Merging them back into one live
   * bucket is what makes the next flush send one complete row.
   *
   * **A driver decides for itself when a claim is abandoned rather than merely
   * slow**, because only the driver knows how long it has held one. It must err
   * long. Recovering a claim whose owner is alive ships those rows twice and
   * fails that owner's `ack`, and waiting costs nothing by comparison.
   *
   * `durable: false` means claims die with the process, so there is nothing
   * left to recover and {@link NOTHING_RECOVERED} is the honest answer.
   */
  recover(metric: string): Promise<RecoveryReport>

  /**
   * Take this metric's turn to ship, on behalf of every process sharing the
   * driver, and record `now` as the time it was taken, with a token no other
   * turn has.
   *
   * A metric's `flush` setting bounds how often it ships. Each process keeps
   * that clock for itself, and with only that, N processes sharing a driver
   * ship up to N times an interval between them: the claim stops two of them
   * shipping the same rows, but not each of them shipping a few. The turn is
   * the one clock they share.
   *
   * Granted when no turn has been taken, or when the last one is `gapMs` or
   * more away from `now` in either direction. A turn taken slightly in the
   * future is another host whose clock runs ahead, and it holds this one back
   * like any other. One more than `gapMs` ahead is a clock that has stepped
   * backwards, and holding back until it caught up would stall the metric
   * for as long as the step was. A `gapMs` of `0` is always granted, and
   * still records the turn.
   *
   * Check and record are one atomic step, so of two processes asking at the
   * same moment one is granted and the other refused.
   *
   * Optional, and a driver that has it has {@link returnTurn} too. Without
   * them each process keeps the cadence for itself.
   */
  takeTurn?(metric: string, now: number, gapMs: number): Promise<ShipTurn>

  /**
   * Give back a turn that shipped nothing, putting `previous` in its place,
   * or clearing it when `previous` is `undefined`.
   *
   * Only while the recorded turn is still `turn`, token included. A later
   * turn belongs to a flush that is still running, and putting an older one
   * over it would let a third process ship beside it. That holds for a later
   * turn taken in the same millisecond too, which only the token tells apart.
   */
  returnTurn?(metric: string, turn: Turn, previous: Turn | undefined): Promise<void>
}
