/**
 * The memory driver — full parity with a shared driver, in plain Maps.
 *
 * Legitimate for a long-lived single process. Its `claim` is a read-and-hold
 * rather than a durable move, so `capabilities.durable` is `false` and the
 * guarantee is best-effort: a crash between claim and ack loses that window.
 *
 * It is the only driver that caps series, because nothing else is watching it.
 * A shared driver defers to the static projection in `metrichouse cost`.
 */

import {
  type AppendOp,
  type BucketClaim,
  type BucketQuery,
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
   * *backlog* cap, not a rate limit — a metric that flushes keeps almost
   * nothing here.
   */
  readonly maxStaged?: number
}

const DEFAULT_MAX_SERIES = 100_000
const DEFAULT_MAX_STAGED = 100_000

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
    let records = staged.get(metric)
    if (!records) {
      records = []
      staged.set(metric, records)
    }
    return records
  }

  function levelsFor(metric: string): Map<string, LevelSeries> {
    let series = levels.get(metric)
    if (!series) {
      series = new Map()
      levels.set(metric, series)
    }
    return series
  }

  /** Staged plus in-flight — a claim that is never acked still occupies memory. */
  function stagedHeld(metric: string): number {
    return (staged.get(metric)?.length ?? 0) + (stagedInFlight.get(metric) ?? 0)
  }

  function addStagedInFlight(metric: string, delta: number): void {
    const next = (stagedInFlight.get(metric) ?? 0) + delta
    if (next <= 0) stagedInFlight.delete(metric)
    else stagedInFlight.set(metric, next)
  }

  function addHolder(metric: string, dimKey: string): void {
    let byKey = holders.get(metric)
    if (!byKey) {
      byKey = new Map()
      holders.set(metric, byKey)
    }

    const count = byKey.get(dimKey)
    if (count === undefined) {
      if (byKey.size >= maxSeries) {
        throw new Error(
          `memory driver: ${metric} exceeded maxSeries (${maxSeries}) — ` +
            'a dim with unbounded values will do this; put it on an event instead',
        )
      }
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
    let byBucket = live.get(metric)
    if (!byBucket) {
      byBucket = new Map()
      live.set(metric, byBucket)
    }
    return byBucket
  }

  /** Get or create the bucket a write lands in, capping series on a new key. */
  function cellSlot(metric: string, bucketTs: number, dimKey: string): Map<string, Cell> {
    const byBucket = bucketsFor(metric)
    let bucket = byBucket.get(bucketTs)
    if (!bucket) {
      bucket = new Map()
      byBucket.set(bucketTs, bucket)
    }
    // may throw on the cap — before mutating, so a refused write leaves no
    // partial state behind
    if (!bucket.has(dimKey)) addHolder(metric, dimKey)
    return bucket
  }

  return {
    capabilities: {
      durable: false,
      shared: false,
      atomicMerge: true,
    },

    async increment(ops: readonly IncrOp[]): Promise<void> {
      for (const op of ops) {
        const bucket = cellSlot(op.metric, landing(op.metric, op.bucketTs), op.dimKey)
        const existing = bucket.get(op.dimKey)

        if (existing === undefined) {
          bucket.set(op.dimKey, plainZero(op.delta))
          continue
        }
        if (typeof existing !== 'number') {
          throw new Error(
            `memory driver: ${op.metric} holds ${isGaugeCell(existing) ? 'gauge' : 'level'} ` +
              'cells — increment is a counter op',
          )
        }

        const next = existing + op.delta
        assertFinite(next, op.metric, 'total')
        bucket.set(op.dimKey, plainZero(next))
      }
    },

    async observe(ops: readonly GaugeOp[]): Promise<void> {
      for (const op of ops) {
        const bucket = cellSlot(op.metric, landing(op.metric, op.bucketTs), op.dimKey)
        const existing = bucket.get(op.dimKey)
        const value = plainZero(op.value)

        if (existing === undefined) {
          bucket.set(op.dimKey, { last: value, min: value, max: value, sum: value, count: 1 })
          continue
        }
        if (!isGaugeCell(existing)) {
          throw new Error(
            `memory driver: ${op.metric} holds ${isLevelCell(existing) ? 'level' : 'counter'} ` +
              'cells — observe is a gauge op',
          )
        }

        // read-modify-write: min, max and last are not increments
        const sum = existing.sum + value
        assertFinite(sum, op.metric, 'sum')
        bucket.set(op.dimKey, {
          last: value,
          min: plainZero(Math.min(existing.min, value)),
          max: plainZero(Math.max(existing.max, value)),
          sum: plainZero(sum),
          count: existing.count + 1,
        })
      }
    },

    async setLevel(ops: readonly LevelOp[]): Promise<void> {
      for (const op of ops) {
        const series = levelsFor(op.metric)
        const held = series.get(op.dimKey)

        if (op.mode === 'hold') {
          // a series storage has never seen has nothing to carry, and a hold
          // must not be what brings one into existence
          if (!held) continue

          // a window some claim has already taken is not filled again: that
          // would ship it a second time. The pointer still moves past it
          if (landing(op.metric, op.bucketTs) === op.bucketTs) {
            const bucket = cellSlot(op.metric, op.bucketTs, op.dimKey)
            // a written value always beats a carried one, so a window that
            // already has a cell keeps it
            if (!bucket.has(op.dimKey)) bucket.set(op.dimKey, { level: plainZero(op.value) })
          }

          series.set(op.dimKey, {
            ...held,
            carried: op.value,
            heldThrough: Math.max(held.heldThrough, op.bucketTs),
          })
          continue
        }

        if (!held && series.size >= maxSeries) {
          throw new Error(
            `memory driver: ${op.metric} exceeded maxSeries (${maxSeries}) — ` +
              'a dim with unbounded values will do this; put it on an event instead',
          )
        }

        const value = plainZero(op.mode === 'add' ? (held?.value ?? 0) + op.value : op.value)
        assertFinite(value, op.metric, 'level')
        const bucketTs = landing(op.metric, op.bucketTs)

        // the bucket first, because `cellSlot` is the other thing that can
        // refuse on the cap, and a held value written before it would name a
        // window that holds nothing
        const bucket = cellSlot(op.metric, bucketTs, op.dimKey)
        const occupant = bucket.get(op.dimKey)
        if (occupant !== undefined && !isLevelCell(occupant)) {
          throw new Error(
            `memory driver: ${op.metric} holds ${isGaugeCell(occupant) ? 'gauge' : 'counter'} ` +
              'cells — set is a level op',
          )
        }
        bucket.set(op.dimKey, { level: value })

        series.set(op.dimKey, {
          dimKey: op.dimKey,
          value,
          // `carried` is what the series was at in the window `heldThrough`
          // names. A first write lands in that window, and so does a second
          // write to the same one, so both replace it: the window ends at the
          // newest value, not the first. A write to a later window leaves it
          // alone, because the windows in between still belong to the older
          // number
          carried: held === undefined || bucketTs <= held.heldThrough ? value : held.carried,
          writtenAt: Math.max(held?.writtenAt ?? bucketTs, bucketTs),
          // a write never moves the pointer. The windows between this write
          // and the last one are still owed a row, and only a `hold` may say
          // they have had one
          heldThrough: held?.heldThrough ?? bucketTs,
        })
      }
    },

    async readLevels(metric: string): Promise<LevelSeries[]> {
      const series = levels.get(metric)
      if (!series) return []
      return [...series.values()].sort((a, b) => (a.dimKey < b.dimKey ? -1 : 1))
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
      // itself — a half-appended batch would be re-sent whole on retry and
      // duplicate the part that landed
      const wanted = new Map<string, number>()
      for (const op of ops) {
        wanted.set(op.metric, (wanted.get(op.metric) ?? 0) + 1)
      }
      for (const [metric, count] of wanted) {
        if (stagedHeld(metric) + count > maxStaged) {
          throw new Error(
            `memory driver: ${metric} exceeded maxStaged (${maxStaged}) — ` +
              'staged events are only drained by flush(), so this is a backlog that ' +
              'nothing is shipping',
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

        for (const [dimKey, value] of bucket) {
          if (query.dimKey !== undefined && dimKey !== query.dimKey) continue
          rows.push({ bucketTs, dimKey, value })
        }
      }

      // deterministic order, so callers and tests never depend on Map insertion
      rows.sort((a, b) => a.bucketTs - b.bucketTs || (a.dimKey < b.dimKey ? -1 : 1))
      return rows
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
        // caller asked for the first n — stop rather than scan the backlog
        if (query.limit !== undefined && matched.length >= query.limit) break
      }
      return matched
    },

    async countPending(metric: string): Promise<number> {
      // claimed and not yet settled still counts: those records have not
      // shipped, and a sink that hangs should not make a backlog read zero
      return (staged.get(metric)?.length ?? 0) + (stagedInFlight.get(metric) ?? 0)
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
          // Holder counts are untouched — the data is still held in memory.
          byBucket.delete(bucketTs)
          claimed.push({ bucketTs, values: bucket })
        }
      }

      // raised even by a claim that found nothing: the watermark is the promise
      // that every window below it has been claimed once, whatever was in it
      claimedUpTo.set(metric, Math.max(claimedUpTo.get(metric) ?? upToBucketTs, upToBucketTs))

      claimSeq += 1
      const claim: BucketClaim = {
        kind: 'buckets',
        id: `${metric}#${claimSeq}`,
        metric,
        claimedAt: Date.now(),
        buckets: claimed,
      }

      inFlight.set(claim.id, claim)
      return claim
    },

    async claimRecords(metric: string, limit?: number): Promise<RecordClaim> {
      const records = stagedFor(metric)

      // oldest first, and only as many as asked for: the rest stay staged and
      // visible, so a backlog drains across flushes instead of arriving as one
      // batch the sink cannot take
      const taken = limit === undefined ? records.splice(0) : records.splice(0, Math.max(0, limit))
      addStagedInFlight(metric, taken.length)

      claimSeq += 1
      const claim: RecordClaim = {
        kind: 'records',
        id: `${metric}#${claimSeq}`,
        metric,
        claimedAt: Date.now(),
        records: taken,
      }

      inFlight.set(claim.id, claim)
      return claim
    },

    async ack(claim: Claim): Promise<void> {
      if (!inFlight.delete(claim.id)) {
        throw new Error(`memory driver: claim ${claim.id} is not in flight — already settled?`)
      }

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
      if (!inFlight.delete(claim.id)) {
        throw new Error(`memory driver: claim ${claim.id} is not in flight — already settled?`)
      }

      if (isRecordClaim(claim)) {
        addStagedInFlight(claim.metric, -claim.records.length)
        // back where they were taken from. They are older than anything
        // appended while they were in flight, but a claim released before
        // this one may already be back at the front, and it is older still
        const records = stagedFor(claim.metric)
        const merged = [...claim.records, ...records].sort(
          (a, b) => (appendOrder.get(a) ?? 0) - (appendOrder.get(b) ?? 0),
        )
        records.splice(0, records.length, ...merged)
        return
      }

      const byBucket = bucketsFor(claim.metric)

      for (const claimedBucket of claim.buckets) {
        const existing = byBucket.get(claimedBucket.bucketTs)

        if (!existing) {
          byBucket.set(claimedBucket.bucketTs, new Map(claimedBucket.values))
          continue
        }

        // a write can land in a bucket while it is claimed — backdated, or a
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
      // abandoned claim left behind to return — the window is simply gone.
      // That is the whole of what `durable: false` costs, said once more here
      // so it cannot be mistaken for an oversight.
      return NOTHING_RECOVERED
    },
  }
}
