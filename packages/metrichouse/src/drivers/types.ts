/**
 * The driver contract — storage for open buckets and staged records, and the
 * claim/ack handshake that makes at-least-once possible.
 *
 * **Deliberately small.** The spec lists seventeen methods, covering
 * primitives and drivers that do not exist yet. Writing them now would enshrine
 * guesses about shapes nothing has exercised. Each one gets added when a second
 * driver or a second primitive actually forces it.
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
 * is a question about time — it is still open, or still inside grace. A staged
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
  readonly dimKey: string
  readonly delta: number
}

/** One gauge observation, already bucketed and keyed. */
export interface GaugeOp {
  readonly metric: string
  readonly bucketTs: number
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
 * - `hold` ignores `value` and carries whatever the series already holds into
 *   `bucketTs`, leaving an existing cell alone. This is the one a flush issues
 *   for windows nobody wrote to.
 */
export interface LevelOp {
  readonly metric: string
  readonly bucketTs: number
  readonly dimKey: string
  readonly value: number
  readonly mode: 'set' | 'add' | 'hold'
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
 * recognisable by content — the same property `rowId` gives an aggregate row.
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
 * becomes a column — that is the metric's business, and keeping it out of
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
 * value. The driver never interprets any of them — it stores what the metric
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
 * caps what comes back — `peek(n)` is this, and on a stream-backed driver it
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
  /** Ascending by `ts`, then by append order within a millisecond. */
  readonly records: readonly StagedRecord[]
}

/**
 * A batch of data moved out of the live set and held pending a `write()`.
 *
 * Invisible to {@link Driver.readBuckets}, to {@link Driver.readPending}, and
 * to a second claim — that invisibility is what stops two flushers from
 * shipping the same window.
 */
export type Claim = BucketClaim | RecordClaim

export function isRecordClaim(claim: Claim): claim is RecordClaim {
  return claim.kind === 'records'
}

export function isBucketClaim(claim: Claim): claim is BucketClaim {
  return claim.kind === 'buckets'
}

/** True when a claim carries nothing — the flush has no reason to call a sink. */
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
 * A pass that found nothing — the overwhelmingly common case.
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
   * are not increments. A shared driver has to make it atomic — a Lua script
   * on Redis — or concurrent writers lose observations.
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
   * Forget these series entirely — held value, timestamp and pointer.
   *
   * What a `holdFor` expiry calls. Their already-shipped buckets are
   * untouched; what goes is the reason to keep emitting new ones.
   */
  dropLevels(metric: string, dimKeys: readonly string[]): Promise<void>

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

  /** Staged, unclaimed records only, ascending by `ts`. */
  readPending(query: PendingQuery): Promise<StagedRecord[]>

  /**
   * How many records are staged and unclaimed.
   *
   * Separate from `readPending` because it is a different call on a real
   * driver — `XLEN` against an `XRANGE` — and counting by reading a million
   * staged rows over the wire is not a thing to make easy.
   */
  countPending(metric: string): Promise<number>

  /** Move every bucket **strictly below** `upToBucketTs` into a claim. */
  claim(metric: string, upToBucketTs: number): Promise<BucketClaim>

  /**
   * Move staged records into a claim, oldest first, at most `limit` of them.
   *
   * No watermark: a record is complete when it is appended, so there is no
   * equivalent of an open bucket to hold back. `limit` is what bounds a flush
   * that would otherwise carry a backlog larger than the sink can take.
   */
  claimRecords(metric: string, limit?: number): Promise<RecordClaim>

  /** The write succeeded — discard the claimed data. */
  ack(claim: Claim): Promise<void>

  /** The write failed — return the claimed data to the live set. */
  release(claim: Claim): Promise<void>

  /**
   * Return claims abandoned by a dead flusher to the live set.
   *
   * The gap `claim` opens and `ack` closes. A claim moves data **out** of the
   * live set, so a process that dies in between leaves a batch that is neither
   * shipped nor claimable — `claim` only ever reads the live set, and the
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
}
