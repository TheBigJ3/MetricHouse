/**
 * The kind-erased view of a metric, and the sink contract.
 *
 * `Counter<D>` is generic in its dims, so a house cannot hold a heterogeneous
 * list of them. {@link AnyMetric} is what the house and the flush engine
 * actually need — no `add`, no dim generics, nothing that varies by kind.
 *
 * Spec: initialPlan/08-house.md, 13-sink.md
 */

import type { Claim, Driver } from '../drivers/types.js'
import type { DeliveryMode, HouseDefaults } from '../runtime/delivery.js'
import type { LiveRow, SnapshotOptions } from '../runtime/live.js'
import type { InferShape, Shape, TypeKind } from '../schema/types.js'

/**
 * Every primitive, in declaration order. A single list rather than a bare
 * union so {@link isMetric} cannot drift out of sync with the type.
 */
export const METRIC_KINDS = ['counter', 'gauge', 'event', 'log', 'timer'] as const

export type MetricKind = (typeof METRIC_KINDS)[number]

/**
 * Which of the two storage models a metric's live data sits in.
 *
 * The distinction the whole library is built around, finally said out loud
 * rather than inferred. `'bucketed'` folds writes into a window — counter,
 * gauge, timer; `'staged'` appends them to a run — event, log. Everything that
 * has to branch on it was otherwise branching on `kind` against a hardcoded
 * list, which is the drift {@link METRIC_KINDS} exists to prevent.
 */
export type StorageModel = 'bucketed' | 'staged'

/**
 * The dims argument, required only when the metric declares any.
 *
 * A dimensionless metric — online users, requests served — is one series.
 * Forcing `dims: {}` on it, and `{}` at every call site, pushes people toward
 * declaring a dim they do not need; a `userId` dim turns a scalar into one
 * series per user.
 */
export type DimsArgs<D extends Shape> = [keyof D] extends [never]
  ? [dims?: InferShape<D>]
  : [dims: InferShape<D>]

/** One column of the row a sink receives. */
export interface RowColumn {
  readonly name: string
  readonly kind: TypeKind
  readonly optional: boolean
}

/** The runtime description of a row. */
export interface RowShape {
  readonly columns: readonly RowColumn[]
}

/**
 * One materialized row, as a sink receives it.
 *
 * `id` is the only column every kind shares. An aggregate row is stamped
 * `bucket_ts` and carries its dims; an event row is stamped `ts` and carries
 * its fields. Nothing else is common, because nothing else should be — the
 * shape is the metric's to decide, and {@link RowShape} is how it says so.
 */
export type Row = { id: string } & Record<string, unknown>

/** What a sink is told about the batch it is being handed. */
export interface WriteContext {
  readonly metric: string
  readonly kind: MetricKind
  /** Oldest bucket in the batch, or oldest record timestamp. */
  readonly bucketFrom: number
  /**
   * One resolution past the newest bucket, or one millisecond past the newest
   * record — the window is `[from, to)` either way.
   */
  readonly bucketTo: number
  /**
   * This batch's headline number, defined per kind: every increment for a
   * counter, every observed value for a gauge or a timer, every row for an
   * event or a log.
   *
   * A metric tracks one thing, and its dims are extra information collected
   * alongside. A sink that only wants the headline can write this and ignore
   * the per-series rows entirely; one that wants the breakdown has it in
   * `rows`.
   */
  readonly total: number
  /** `1` on the first try, higher after a previous release. */
  readonly attempt: number
  /**
   * What caused this call. `'flush'` is `house.flush()`; `'batch'` is a
   * locally staged event shipping itself on `batch.maxSize` or `maxAge`,
   * which happens without anyone calling flush.
   *
   * `'immediate'` is `delivery: 'immediate'`, and it is the one source whose
   * rows a sink must treat as **last-write-wins on `id`**. The other two send
   * a row once and resend it only as a byte-identical retry, so deduplicating
   * them either way is correct. An immediate bucketed row is a running total
   * that a later send supersedes — folding those together, rather than keeping
   * the newest, double-counts.
   */
  readonly source: 'flush' | 'batch' | 'immediate'
}

/**
 * The one function you write. Throw to signal failure: the claim is released
 * and the same rows come back next flush with `attempt` incremented.
 */
export type WriteFn = (rows: Row[], context: WriteContext) => Promise<void> | void

/** What a house supplies when it registers a metric. */
export interface MetricBinding {
  readonly driver: Driver
  /**
   * Clock, injectable so bucket boundaries are testable without global fake
   * timers. Defaults to `Date.now`.
   */
  readonly now?: () => number
  /**
   * Where transport failures go. A rejected `driver.increment` cannot be
   * thrown from `.add()`, which has already returned — so it lands here.
   */
  readonly onError?: (error: unknown, context: { metric: string }) => void
  /**
   * The house's fallback sink, for a metric that ships without waiting for
   * `flush()` — a locally staged event reaching `batch.maxSize` is the only
   * one so far.
   */
  readonly write?: WriteFn
  /**
   * Look up a sibling metric by name.
   *
   * `event({ derive })` names the counters an event also writes, and names are
   * all it can name: a schema module would otherwise have to be ordered so
   * every derive target is declared first, and a cycle between two files would
   * be unresolvable. Resolution is lazy, at the first `record()`, so
   * registration order does not matter.
   */
  readonly resolve?: (name: string) => AnyMetric | undefined
  /**
   * How this house delivers, already resolved — a metric never sees `'auto'`.
   *
   * Absent means `'staged'`, so a metric bound by something that predates
   * delivery behaves exactly as it always did.
   */
  readonly delivery?: DeliveryMode
  /** Cadence and grace for a metric that declares neither. */
  readonly defaults?: HouseDefaults
}

/**
 * What one claim becomes: the rows a sink receives, and what it is told about
 * them.
 *
 * Produced by the metric rather than the flush engine, because the window and
 * the headline number mean different things per kind — a bucket range for a
 * counter, the span of record timestamps for an event.
 */
export interface MaterializedBatch {
  readonly rows: Row[]
  /** Oldest bucket, or oldest record timestamp. */
  readonly bucketFrom: number
  /** One resolution past the newest bucket, or one ms past the newest record. */
  readonly bucketTo: number
  /** See {@link WriteContext.total}. */
  readonly total: number
  /** Buckets in the claim; `0` for a kind that does not bucket. */
  readonly buckets: number
}

/**
 * Everything the house and the flush engine need, with dim types erased.
 *
 * The four batch methods are what keep the flush engine kind-agnostic. It runs
 * `claimBatch -> materializeClaim -> write -> ackBatch | releaseBatch` and
 * never learns whether the data underneath was a bucket of folded cells or a
 * run of staged records. Adding a primitive means implementing these four, not
 * editing the lifecycle.
 */
export interface AnyMetric {
  readonly name: string
  readonly kind: MetricKind
  /** Which storage model holds this metric's live data. */
  readonly storage: StorageModel
  readonly dims: Shape
  readonly resolutionMs: number
  readonly flushMs: number
  readonly graceMs: number
  readonly isBound: boolean
  /** This metric's own sink, if it declared one. Falls back to the house's. */
  readonly write: WriteFn | undefined
  bind(binding: MetricBinding): void
  drain(): Promise<void>

  /** The runtime column list a sink will receive, in order. */
  rowShape(): RowShape

  /**
   * Everything still in the driver for this metric — the open bucket, plus any
   * closed bucket not yet flushed and acked.
   *
   * On {@link AnyMetric} rather than on each kind because every reader of it —
   * `house.snapshot()`, a dashboard, the cost projection, the test helpers —
   * wants live rows without first learning what kind it is holding. The write
   * path got that abstraction on day one, in the four batch methods below; this
   * is the same idea for the read path.
   *
   * A staged kind answers with its unshipped records rather than with nothing:
   * a record is complete the instant it is appended, so it is never partial and
   * `complete: true` cannot exclude it. The options that only mean something to
   * an aggregate — `rollup`, `groupBy`, `orderBy` — are ignored there, so that
   * `house.snapshot(options)` stays callable across a mixed schema.
   */
  snapshot(options?: SnapshotOptions): Promise<LiveRow[]>

  /**
   * Move everything shippable out of the live set and hold it pending a write.
   *
   * The metric decides what "shippable" means, because it is the only thing
   * that knows its own resolution and grace — an aggregate kind turns `nowMs`
   * into a watermark, a staged kind takes what is there.
   */
  claimBatch(nowMs: number): Promise<Claim>

  /** Turn a claim into rows, and the window and headline they represent. */
  materializeClaim(claim: Claim): MaterializedBatch

  /** The write landed — discard the claimed data. */
  ackBatch(claim: Claim): Promise<void>

  /** The write failed — return the claimed data to the live set. */
  releaseBatch(claim: Claim): Promise<void>
}

/** Structural check, used to pick metrics out of an imported schema module. */
export function isMetric(value: unknown): value is AnyMetric {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnyMetric>
  return (
    typeof candidate.name === 'string' &&
    (METRIC_KINDS as readonly string[]).includes(candidate.kind as string) &&
    typeof candidate.bind === 'function' &&
    typeof candidate.claimBatch === 'function' &&
    typeof candidate.resolutionMs === 'number'
  )
}
