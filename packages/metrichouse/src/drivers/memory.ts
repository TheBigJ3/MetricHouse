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
  isRecordClaim,
  type PendingQuery,
  type RecordClaim,
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
  if (!isGaugeCell(older) && !isGaugeCell(newer)) return older + newer
  if (!isGaugeCell(older) || !isGaugeCell(newer)) {
    throw new Error('memory driver: cannot merge a counter cell with a gauge cell')
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

  const inFlight = new Map<string, Claim>()
  let claimSeq = 0

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
        const bucket = cellSlot(op.metric, op.bucketTs, op.dimKey)
        const existing = bucket.get(op.dimKey)

        if (existing === undefined) {
          bucket.set(op.dimKey, op.delta)
          continue
        }
        if (isGaugeCell(existing)) {
          throw new Error(
            `memory driver: ${op.metric} holds gauge cells — increment is a counter op`,
          )
        }

        bucket.set(op.dimKey, existing + op.delta)
      }
    },

    async observe(ops: readonly GaugeOp[]): Promise<void> {
      for (const op of ops) {
        const bucket = cellSlot(op.metric, op.bucketTs, op.dimKey)
        const existing = bucket.get(op.dimKey)

        if (existing === undefined) {
          bucket.set(op.dimKey, {
            last: op.value,
            min: op.value,
            max: op.value,
            sum: op.value,
            count: 1,
          })
          continue
        }
        if (!isGaugeCell(existing)) {
          throw new Error(`memory driver: ${op.metric} holds counter cells — observe is a gauge op`)
        }

        // read-modify-write: min, max and last are not increments
        bucket.set(op.dimKey, {
          last: op.value,
          min: Math.min(existing.min, op.value),
          max: Math.max(existing.max, op.value),
          sum: existing.sum + op.value,
          count: existing.count + 1,
        })
      }
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
        stagedFor(op.metric).push({ id: op.id, ts: op.ts, fields: op.fields })
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
      return staged.get(metric)?.length ?? 0
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
        // to the front, not the back: these are older than anything appended
        // while they were in flight, and `claimRecords` ships oldest first
        stagedFor(claim.metric).unshift(...claim.records)
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
  }
}
