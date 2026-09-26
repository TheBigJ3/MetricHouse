/**
 * The kind-erased view of a metric, and the sink contract.
 *
 * `Counter<D>` is generic in its dims, so a house cannot hold a heterogeneous
 * list of them. {@link AnyMetric} is what the house and the flush engine
 * actually need, with no `add`, no dim generics, nothing that varies by kind.
 */

import type { Claim, Driver, RecoveryReport } from '../drivers/types.js'
import type { DeliveryMode, HouseDefaults } from '../runtime/delivery.js'
import type { FlushOptions, MetricFlushReport } from '../runtime/flush.js'
import type { LiveRow, SnapshotOptions } from '../runtime/live.js'
import { hasLoneSurrogate } from '../schema/dims.js'
import type { FieldType, InferShape, Shape, TypeKind } from '../schema/types.js'
import type { Counter } from './counter.js'
import type { Event } from './event.js'

/**
 * Every primitive, in declaration order. A single list rather than a bare
 * union so {@link isMetric} cannot drift out of sync with the type.
 */
export const METRIC_KINDS = ['counter', 'gauge', 'level', 'event', 'log', 'timer'] as const

export type MetricKind = (typeof METRIC_KINDS)[number]

/**
 * Which of the two storage models a metric's live data sits in.
 *
 * The distinction the whole library is built around, finally said out loud
 * rather than inferred. `'bucketed'` folds writes into a window (counter,
 * gauge, level, timer), and `'staged'` appends them to a run (event, log). Everything that
 * has to branch on it was otherwise branching on `kind` against a hardcoded
 * list, which is the drift {@link METRIC_KINDS} exists to prevent.
 */
export type StorageModel = 'bucketed' | 'staged'

/**
 * The dims argument, required only when the metric declares any.
 *
 * A dimensionless metric, such as online users or requests served, is one series.
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
 * its fields. Nothing else is common, because nothing else should be. The
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
   * record. The window is `[from, to)` either way.
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
   * What caused this call. `'flush'` is `metric.flush()`, whether a cron, a
   * scheduler tick or `house.flush()` asked for it; `'batch'` is a
   * locally staged event shipping itself on `batch.maxSize` or `maxAge`,
   * which happens without anyone calling flush.
   *
   * `'immediate'` is `delivery: 'immediate'`, and it is the one source whose
   * rows a sink must treat as **last-write-wins on `id`**. The other two send
   * a row once and resend it only as a byte-identical retry, so deduplicating
   * them either way is correct. An immediate bucketed row is a running total
   * that a later send supersedes, so folding those together, rather than keeping
   * the newest, double-counts.
   */
  readonly source: 'flush' | 'batch' | 'immediate'
}

/**
 * The one function you write. Throw to signal failure: the claim is released
 * and the same rows come back next flush with `attempt` incremented.
 *
 * `R` is the row the metric hands over. Each kind's config narrows it to its
 * own, so a counter's sink receives `CounterRow<D>` with every dim typed, the
 * same columns `snapshot()` returns without the liveness fields. `Row` is the
 * erased default, and a sink typed with it is accepted by every metric, which
 * is what keeps one shared helper usable across a schema.
 */
export type WriteFn<R extends Row = Row> = (
  rows: R[],
  context: WriteContext,
) => Promise<void> | void

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
   * thrown from `.add()`, which has already returned, so it lands here.
   */
  readonly onError?: (error: unknown, context: { metric: string }) => void
  /**
   * True once the house has stopped, until it is started again.
   *
   * A locally staged event arms a timer to retry a failed send. After
   * `house.stop()` has returned, nothing should call a sink any more, so the
   * event arms none.
   */
  readonly stopped?: () => boolean
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
   * How this house delivers, already resolved, so a metric never sees `'auto'`.
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
 * the headline number mean different things per kind, a bucket range for a
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
 * The five batch methods are what keep the flush engine kind-agnostic. It runs
 * `recoverBatch -> claimBatch -> materializeClaim -> write -> ackBatch |
 * releaseBatch` and never learns whether the data underneath was a bucket of
 * folded cells or a run of staged records. Adding a primitive means
 * implementing these five, not editing the lifecycle.
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
  /**
   * Where this metric's rows go.
   *
   * Declared on the metric, not on the house: a metric is a complete unit,
   * what it measures, how often it ships, and where it ships to, and a house
   * is only somewhere to keep a set of them. A schema whose counters go to
   * ClickHouse and whose logs go to S3 needs no special case, because there
   * was never one sink to special-case.
   *
   * Declared with method syntax so each kind can narrow it to its own row, as
   * `snapshot` is narrowed. TypeScript checks the parameters of a function
   * typed property strictly, and a counter's sink accepts only counter rows, so
   * as a property it could never stand in for this one, which accepts any row.
   * A method is checked in both directions, and that is enough.
   */
  write(rows: Row[], context: WriteContext): Promise<void> | void
  bind(binding: MetricBinding): void
  /**
   * Forget the house this metric was bound to.
   *
   * For a house undoing a registration that failed partway, so the same
   * metrics can be registered again once the mistake is fixed. Not for
   * moving a live metric between houses: writes already on their way keep
   * the driver they started with.
   */
  unbind(): void
  drain(): Promise<void>

  /**
   * Ship everything closed to this metric's own sink, and settle the claim.
   *
   * The whole delivery unit, and callable with no house in sight. Honours the
   * metric's cadence. An early call reports `skipped` with `reason:
   * 'cadence'` rather than shipping, unless `force` says otherwise.
   *
   * Errors come back in the report rather than as a rejection: a flush that
   * fails has already released its claim, so the data is safe and the caller
   * is being told, not rescued.
   */
  flush(options?: FlushOptions): Promise<MetricFlushReport>

  /** The runtime column list a sink will receive, in order. */
  rowShape(): RowShape

  /**
   * Everything still in the driver for this metric, the open bucket, plus any
   * closed bucket not yet flushed and acked.
   *
   * On {@link AnyMetric} rather than on each kind because every reader of it,
   * `house.snapshot()`, a dashboard, the cost projection, the test helpers,
   * wants live rows without first learning what kind it is holding. The write
   * path got that abstraction on day one, in the five batch methods below; this
   * is the same idea for the read path.
   *
   * A staged kind answers with its unshipped records rather than with nothing:
   * a record is complete the instant it is appended, so it is never partial and
   * `complete: true` cannot exclude it. The options that only mean something to
   * an aggregate, `rollup`, `groupBy` and `orderBy`, are ignored there, so that
   * `house.snapshot(options)` stays callable across a mixed schema.
   */
  snapshot(options?: SnapshotOptions): Promise<LiveRow[]>

  /**
   * Put back anything a previous flusher claimed and then died holding.
   *
   * Runs before {@link AnyMetric.claimBatch}, because an abandoned claim is
   * data that has already left the live set: nothing downstream of the claim
   * can see it, so the repair has to happen upstream of one. What it puts back
   * is claimed and shipped by the very same flush.
   *
   * Nothing is shipped from here, only merged back. The reasoning, and the
   * question of when a claim counts as abandoned, belong to the driver.
   * {@link Driver.recover} is where both are written down.
   */
  recoverBatch(): Promise<RecoveryReport>

  /**
   * Move everything shippable out of the live set and hold it pending a write.
   *
   * The metric decides what "shippable" means, because it is the only thing
   * that knows its own resolution and grace. An aggregate kind turns `nowMs`
   * into a watermark, a staged kind takes what is there.
   */
  claimBatch(nowMs: number, options?: ClaimOptions): Promise<Claim>

  /** Turn a claim into rows, and the window and headline they represent. */
  materializeClaim(claim: Claim): MaterializedBatch

  /** The write landed, so discard the claimed data. */
  ackBatch(claim: Claim): Promise<void>

  /** The write failed, so return the claimed data to the live set. */
  releaseBatch(claim: Claim): Promise<void>
}

/**
 * Check a metric name at declaration.
 *
 * A name is part of every storage key a driver builds, so a colon in it could
 * make one metric's keys look like another's under a neighbouring namespace:
 * namespace `org` with metric `e:checkout` and namespace `org:e` with metric
 * `checkout` would both read and write `org:e:e:checkout`. Whitespace is
 * refused for the same reason it is refused in a table name: it is almost
 * always a typo, and it makes every key awkward to type into a shell.
 *
 * Half of a surrogate pair is refused because Redis stores a key as UTF-8,
 * which cannot hold one: two names that differ only there would share every
 * key. `__proto__` is refused because a flush report and a house snapshot are
 * keyed by metric name, and that key sets an object's prototype rather than
 * adding an entry.
 *
 * @throws naming the kind, so the message says which declaration is wrong
 */
export function assertMetricName(name: unknown, kind: MetricKind): asserts name is string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${kind}: name must be a non-empty string`)
  }
  if (/[\s:]/.test(name)) {
    throw new Error(
      `${kind}: name ${JSON.stringify(name)} may not contain a colon or whitespace, because ` +
        'a driver builds storage keys from it and both would make those keys ambiguous',
    )
  }
  if (hasLoneSurrogate(name)) {
    throw new Error(
      `${kind}: name ${JSON.stringify(name)} holds half of a surrogate pair, which a driver ` +
        'storing UTF-8 cannot keep apart from another name',
    )
  }
  if (name === '__proto__') {
    throw new Error(
      `${kind}: a metric cannot be named "__proto__", because reports are keyed by metric ` +
        "name and JavaScript treats that key as an object's prototype",
    )
  }
}

/**
 * Check that a metric was given somewhere to send its rows.
 *
 * Checked at declaration like everything else about the shape of a metric.
 * Left to the first flush, a missing sink shows up as "sink is not a function"
 * minutes later, on every flush, with the data piling up behind it.
 */
export function assertSink(write: unknown, name: string): void {
  if (typeof write !== 'function') {
    throw new Error(`${name}: write must be a function that stores the rows, got ${typeof write}`)
  }
}

/**
 * Refuse a first argument that is neither a delta nor a dims object.
 *
 * `add(delta)` and `add(dims)` share the first position, so anything that is
 * not a number is read as dims. On a metric with no dims TypeScript accepts a
 * bigint or a boolean there, and without this check `add(5n)` would count 1.
 */
export function assertDeltaOrDims(name: string, first: unknown): void {
  if (first === undefined || first === null || typeof first === 'number') return
  if (typeof first === 'object') {
    // a dims object is a plain one. A Date, an array or a boxed Number is an
    // object too, and TypeScript accepts each where a metric with no dims
    // takes its argument, but none of them is a set of labels
    const proto = Object.getPrototypeOf(first)
    if (proto === Object.prototype || proto === null) return
    const kind = Array.isArray(first) ? 'an array' : `a ${proto?.constructor?.name ?? 'object'}`
    throw new Error(
      `${name}: the first argument must be a number or a plain dims object, got ${kind}`,
    )
  }
  throw new Error(
    `${name}: the first argument must be a number or a dims object, got ${typeof first}` +
      (typeof first === 'bigint' ? '. Convert a bigint with Number() first' : ''),
  )
}

/**
 * Refuse a number an integer metric cannot take.
 *
 * Two different mistakes, told apart: a fraction, and a whole number past
 * `Number.MAX_SAFE_INTEGER`, which a double cannot hold exactly. `noun` says
 * what the number is to the caller, a delta or a value.
 */
export function assertWhole(name: string, kind: MetricKind, value: number, noun: string): void {
  if (Number.isSafeInteger(value)) return
  if (Number.isInteger(value)) {
    throw new Error(
      `${name}: ${value} is past ${Number.MAX_SAFE_INTEGER}, the largest whole number a ` +
        `double holds exactly, so an integer ${kind} cannot take it`,
    )
  }
  throw new Error(
    `${name}: declares an integer ${kind}, so ${value} is not a legal ${noun}. ` +
      'Declare `value: float()` if fractions are intended',
  )
}

/**
 * The row columns a set of dims becomes, in declared order.
 *
 * A dim with a default is never null, because the default fills every row
 * that leaves it out, so only a dim marked `.optional()` is an optional
 * column.
 */
export function dimColumns(dims: Shape): RowColumn[] {
  return Object.keys(dims).map((column) => {
    const type = dims[column] as FieldType
    return { name: column, kind: type.kind, optional: type.isOptional && !type.hasDefault }
  })
}

/**
 * True when `metric` is a counter, read from its `kind` alone.
 *
 * Only `counter()` builds a metric of that kind, so the kind is enough to
 * reach what a counter has beyond {@link AnyMetric}, such as `add`.
 */
export function isCounter(metric: AnyMetric): metric is Counter<Shape> {
  return metric.kind === 'counter'
}

/**
 * True when `metric` is an event, read from its `kind` alone. A log is built
 * on an event but has a kind of its own, so it is not one here.
 */
export function isEvent(metric: AnyMetric): metric is Event<Shape> {
  return metric.kind === 'event'
}

/**
 * Hand a failure that cannot be thrown at a caller to `onError`, or raise it
 * as an unhandled rejection when there is no handler.
 *
 * Never throws, so the promise it runs in never rejects. `drain()` waits on
 * those promises, and one that rejected would end the wait before the other
 * writes had landed and make `house.stop()` skip its final flush. A handler
 * that throws is raised the same way, rather than replacing the wait.
 */
export function reportError(
  onError: MetricBinding['onError'],
  error: unknown,
  context: { metric: string },
): void {
  let raised = error
  if (onError) {
    try {
      onError(error, context)
      return
    } catch (thrown) {
      raised = thrown
    }
  }
  void Promise.reject(raised)
}

/** Writes a metric has issued and the driver has not yet acknowledged. */
export interface PendingWrites {
  /**
   * Hold `work` until it settles. A failure goes to the handler `onError`
   * returns when it fails, and is never rethrown, so `drain()` waits for
   * every write rather than stopping at the first that failed.
   */
  track(work: Promise<void>, onError: () => MetricBinding['onError']): void
  /** Resolve once every write tracked so far, and any tracked meanwhile, has settled. */
  drain(): Promise<void>
}

/**
 * The writes one metric has in flight.
 *
 * A Set with self-removal rather than a growing array: a long-lived server
 * flushes on a schedule but may never call `drain()`, and an array would
 * retain every promise it ever created.
 */
export function pendingWrites(name: string): PendingWrites {
  const pending = new Set<Promise<void>>()

  return {
    track(work: Promise<void>, onError: () => MetricBinding['onError']): void {
      const settled = work
        .catch((error: unknown) => reportError(onError(), error, { metric: name }))
        .finally(() => {
          pending.delete(settled)
        })
      pending.add(settled)
    },

    async drain(): Promise<void> {
      // loops rather than awaiting once: a write issued while we were waiting
      // is still a write issued before drain() resolves
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    },
  }
}

/** The {@link AnyMetric} methods that ship a batch. */
export type BatchMethods = Pick<
  AnyMetric,
  'flush' | 'recoverBatch' | 'claimBatch' | 'materializeClaim' | 'ackBatch' | 'releaseBatch'
>

/**
 * Every batch method of `inner`, forwarded to it.
 *
 * For a kind built on another one, as a timer is built on a gauge and a log on
 * an event. The cadence, the retry count and the claims belong to the one
 * thing that actually holds the data, so the wrapper forwards rather than
 * keeping state of its own that could disagree with it. The flush engine talks
 * to the metric underneath and only learns from `kind` which wrapper it was.
 */
export function delegateBatch(inner: AnyMetric): BatchMethods {
  return {
    flush(options?: FlushOptions): Promise<MetricFlushReport> {
      return inner.flush(options)
    },

    recoverBatch(): Promise<RecoveryReport> {
      return inner.recoverBatch()
    },

    claimBatch(nowMs: number, options?: ClaimOptions): Promise<Claim> {
      return inner.claimBatch(nowMs, options)
    },

    materializeClaim(claim: Claim): MaterializedBatch {
      return inner.materializeClaim(claim)
    },

    ackBatch(claim: Claim): Promise<void> {
      return inner.ackBatch(claim)
    },

    releaseBatch(claim: Claim): Promise<void> {
      return inner.releaseBatch(claim)
    },
  }
}

/** What a flush tells a metric about the claim it is asking for. */
export interface ClaimOptions {
  /**
   * Take windows that have ended even if they are still inside grace. Set by
   * a `final` flush; a staged kind has no grace and ignores it.
   */
  readonly final?: boolean
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
