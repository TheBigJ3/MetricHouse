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
 * What a driver holds for one series in one bucket.
 *
 * A counter keeps a scalar; a gauge keeps a fold. The driver never interprets
 * either — it stores what the metric wrote and hands it back. Narrowing is the
 * metric's job, because the metric is the only thing that knows its own kind.
 */
export type Cell = number | GaugeCell

/** True when this cell came from a gauge rather than a counter. */
export function isGaugeCell(cell: Cell): cell is GaugeCell {
  return typeof cell === 'object'
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
}
