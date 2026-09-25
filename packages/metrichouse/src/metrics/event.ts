/**
 * Event — discrete typed records, never aggregated.
 *
 * The home for everything a counter had to throw away: `userId`, `requestId`,
 * a free-text note, a JSON payload. Two identical events are two rows, because
 * the point of an event is the detail, and detail does not merge.
 *
 * **The other storage model.** A counter folds writes into a bucket; an event
 * appends them to a run. That difference is the whole reason this file exists
 * rather than another `bucketedLifecycle` caller, and it is why the driver
 * grew `append`, `readPending`, `countPending` and `claimRecords` — a bucket's
 * worth of methods could not express "keep all of it, in order, exactly once".
 */

import type {
  AppendOp,
  Claim,
  Driver,
  RecordClaim,
  RecoveryReport,
  StagedRecord,
} from '../drivers/types.js'
import { isRecordClaim, NOTHING_RECOVERED } from '../drivers/types.js'
import { uuidv7 } from '../identity.js'
import { createAttempts, metricFlush } from '../runtime/flush.js'
import {
  assertLimit,
  type LiveFields,
  orderAndLimit,
  type SnapshotOptions,
} from '../runtime/live.js'
import { shipClaim } from '../runtime/ship.js'
import { applyDimDefaults, assertShapeNames, encodeDimKey, validateDims } from '../schema/dims.js'
import {
  type FieldType,
  type InferShape,
  isDate,
  jsonText,
  type Shape,
  type Simplify,
} from '../schema/types.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import type {
  AnyMetric,
  MaterializedBatch,
  MetricBinding,
  MetricKind,
  Row,
  RowColumn,
  RowShape,
  WriteContext,
  WriteFn,
} from './types.js'
import { assertMetricName, assertSink } from './types.js'

/**
 * Where records wait between `record()` and your `write()`.
 *
 * - `'driver'` — appended to the bound driver, claimed on flush. Durable and
 *   shared exactly as far as that driver is: on Redis this is an audit log
 *   that survives a crash, on the memory driver it is the same code path with
 *   `capabilities.durable: false`.
 * - `'local'` — held in an array inside this process and shipped on
 *   `batch.maxSize`, on `batch.maxAge`, on `flush()`, or on `drain()`. Costs
 *   nothing per event and loses everything on a crash. Use it for pageviews,
 *   not for money.
 *
 * **Named for what they are, not for a product.** The spec calls these
 * `'redis'` and `'memory'`, which stopped being true the moment a second
 * driver was on the roadmap and a *memory driver* existed to be confused with
 * memory staging — `stage: 'memory'` on the memory driver would have named two
 * unrelated things.
 */
export type EventStage = 'driver' | 'local'

export interface EventBatchConfig {
  /** Ship once this many records are buffered. Default `500`. */
  readonly maxSize?: number
  /** Ship this long after the first record in a batch. Default `'10s'`. */
  readonly maxAge?: DurationInput
}

/** One counter increment an event fans out to. `value` defaults to `1`. */
export interface DeriveTarget {
  readonly dims?: Record<string, unknown>
  readonly value?: number
}

/**
 * What one event writes to one counter.
 *
 * Returning an array is the normal case: `tokens` is two increments from one
 * event, input and output, and a single fact producing several rows is exactly
 * the hand-maintained fan-out this replaces.
 */
export type DeriveFn<F> = (fields: F) => DeriveTarget | readonly DeriveTarget[]

/** The names of the fields in `F` declared with `ts()`. */
export type TsFieldOf<F extends Shape> = {
  [K in keyof F]: F[K] extends FieldType<Date, boolean> ? K : never
}[keyof F] &
  string

/** Columns MetricHouse owns on every event row. A field may not take these. */
export const RESERVED_EVENT_COLUMNS = ['id', 'ts', '_ingested_at', '_sample_rate'] as const

/**
 * The row shape an event's `write()` receives.
 *
 * A `json()` field arrives **stringified** — the type cannot say so, because
 * `json<T>()` and `str()` are indistinguishable in the type system once
 * inferred, so this is documented rather than encoded.
 */
export type EventRow<F extends Shape> = Simplify<
  { id: string; ts: Date } & InferShape<F> & { _ingested_at: Date; _sample_rate?: number }
>

/**
 * One live row from an event: the row a sink would receive, plus the liveness
 * fields.
 *
 * No conditional on the options, unlike an aggregate kind: `rollup` and
 * `groupBy` have nothing to collapse here, so the shape never varies.
 */
export type EventLiveRow<F extends Shape> = Simplify<EventRow<F> & LiveFields>

export interface EventConfig<F extends Shape> {
  /** The payload schema. Unlike dims, `json()` is legal here. */
  readonly fields: F
  /** Default `'driver'`. See {@link EventStage}. */
  readonly stage?: EventStage
  /** Local staging only — ignored when `stage: 'driver'`. */
  readonly batch?: EventBatchConfig
  /**
   * Minimum shipping cadence for `flush()`. Takes `defaults.flush` from the
   * house when omitted, and `'30s'` when neither says.
   */
  readonly flush?: DurationInput
  /**
   * Where a record's `ts` comes from: `'auto'` (default) stamps it at
   * `record()`, or name a declared `ts()` field to take it from the payload.
   * `record(fields, { at })` overrides both.
   */
  readonly timestamp?: 'auto' | TsFieldOf<F>
  /**
   * Keep this fraction of events, `0` to `1`. A function is evaluated per
   * event, so an error can be kept at `1` while a success is sampled at
   * `0.05`. The effective rate lands in `_sample_rate` so a query can scale
   * back up.
   */
  readonly sample?: number | ((fields: InferShape<F>) => number)
  /**
   * Counters this event also writes, keyed by metric name.
   *
   * **Derive runs before sampling**, always: the counters stay exact and
   * unbiased while the event table holds a representative slice. That order is
   * the entire value of the feature and is not configurable.
   *
   * It runs after validation, though. A call that throws, because a field is
   * wrong or `sample` returned something that is not a rate, increments
   * nothing, and a `recordMany` with one bad record increments nothing for
   * any of them.
   *
   * The increment lands in the counter's open window, the one `now` falls in,
   * whatever `ts` the event carries. A counter has no way to be written in the
   * past.
   */
  readonly derive?: Readonly<Record<string, DeriveFn<InferShape<F>>>>
  /**
   * Records one flush may carry. Unlimited by default — a claim takes the
   * whole backlog, the same way a counter's claim takes every closed bucket.
   * Set it when the backlog can outgrow what the sink will accept at once.
   */
  readonly claimLimit?: number
  /**
   * Where this event's rows go. Required — see the counter for why.
   *
   * Receives {@link EventRow}, with every declared field typed.
   */
  readonly write: WriteFn<EventRow<F>>
}

/**
 * `K` is the kind this metric reports to a sink. It is a parameter, not the
 * constant `'event'`, because {@link stagedMetric} is also what backs `log()`
 * — a log is stored as an event and must still say `'log'` in a
 * {@link WriteContext}.
 */
export interface Event<F extends Shape, K extends MetricKind = 'event'> extends AnyMetric {
  readonly name: string
  readonly kind: K
  readonly fields: F
  readonly stage: EventStage
  readonly flushMs: number
  /** The sink this event was declared with. A method, as on the counter. */
  write(rows: EventRow<F>[], context: WriteContext): Promise<void> | void
  readonly isBound: boolean

  bind(binding: MetricBinding): void

  /** Stage one event. Fire-and-forget: `drain()` is what confirms it landed. */
  record(fields: InferShape<F>, options?: { at?: Date | number }): void

  /** Stage many in one round trip. */
  recordMany(fields: readonly InferShape<F>[], options?: { at?: Date | number }): void

  /**
   * How many records have not shipped yet: those waiting to be claimed, plus
   * those a flush has claimed and is still writing.
   */
  pending(): Promise<number>

  /**
   * The first `n` records waiting to be claimed, as rows, without consuming
   * them. Records a flush is writing right now are not among them.
   */
  peek(n?: number): Promise<EventRow<F>[]>

  /**
   * Unshipped records as live rows.
   *
   * `peek()` with the rest of the snapshot vocabulary, and the staged answer to
   * a question the aggregate kinds answer with buckets. Every row reads
   * `bucket_open: false`: a record is complete the instant it is appended, so
   * there is no partial window for `complete` to exclude and no elapsed
   * fraction to report.
   */
  snapshot(options?: SnapshotOptions): Promise<EventLiveRow<F>[]>

  drain(): Promise<void>
  rowShape(): RowShape
}

/** One record's worth of `record()`, decided and not yet applied. */
interface Prepared<F extends Shape> {
  /** The fields with defaults filled, as `derive` sees them. */
  readonly values: InferShape<F>
  /** What to stage, or `undefined` when sampling dropped it. */
  readonly record: StagedRecord | undefined
}

/** A short rendering of a value for an error message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') return 'an object'
  return String(value)
}

const DEFAULT_MAX_SIZE = 500
const DEFAULT_FLUSH_MS = 30_000

/**
 * Declare an event.
 *
 * @throws if the configuration is invalid — an undeclared or non-`ts()`
 * `timestamp` field, a field taking a reserved column name, a `sample` rate
 * outside `[0, 1]`, or an empty name.
 */
export function event<F extends Shape>(name: string, config: EventConfig<F>): Event<F> {
  return stagedMetric(name, config, 'event')
}

/**
 * The staged lifecycle, for a primitive that appends records rather than
 * folding them into buckets.
 *
 * The counterpart to `bucketedLifecycle` on the aggregate side, and factored
 * out for the same reason: `log()` is an event with three reserved fields and
 * a level filter in front of `record()`, and reimplementing staging, batching,
 * claiming and sampling to get that would have been four hundred lines of
 * duplicate to keep in step forever.
 *
 * `kind` is the only thing a caller varies. Everything else about a log — the
 * composed field shape, the level methods, `child()` — is built on top of the
 * event this returns, not inside it.
 *
 * @throws see {@link event}.
 */
export function stagedMetric<F extends Shape, K extends MetricKind>(
  name: string,
  config: EventConfig<F>,
  kind: K,
): Event<F, K> {
  assertMetricName(name, kind)
  assertSink(config.write, name)

  const fields = config.fields ?? ({} as F)
  assertShapeNames(fields, name, 'field')

  for (const key of Object.keys(fields)) {
    if ((RESERVED_EVENT_COLUMNS as readonly string[]).includes(key)) {
      throw new Error(
        `${name}: field ${JSON.stringify(key)} is a reserved column — ` +
          `MetricHouse owns [${RESERVED_EVENT_COLUMNS.join(', ')}] on every event row`,
      )
    }
  }

  const stage: EventStage = config.stage ?? 'driver'
  const ownFlushMs = config.flush === undefined ? undefined : parseDuration(config.flush)
  const maxSize = config.batch?.maxSize ?? DEFAULT_MAX_SIZE
  const maxAgeMs = parseDuration(config.batch?.maxAge ?? '10s')

  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new Error(`${name}: batch.maxSize must be a positive integer, got ${maxSize}`)
  }
  if (config.claimLimit !== undefined) {
    if (!Number.isSafeInteger(config.claimLimit) || config.claimLimit <= 0) {
      throw new Error(`${name}: claimLimit must be a positive integer, got ${config.claimLimit}`)
    }
  }

  const timestampField =
    config.timestamp && config.timestamp !== 'auto' ? config.timestamp : undefined
  if (timestampField !== undefined) {
    const declared = fields[timestampField]
    if (!declared) {
      throw new Error(
        `${name}: timestamp names ${JSON.stringify(timestampField)}, which is not a declared field`,
      )
    }
    if (declared.kind !== 'ts') {
      throw new Error(
        `${name}: timestamp field ${JSON.stringify(timestampField)} declares ${declared.kind}() — ` +
          'it must be ts()',
      )
    }
  }

  if (typeof config.sample === 'number') {
    if (!Number.isFinite(config.sample) || config.sample < 0 || config.sample > 1) {
      throw new Error(`${name}: sample must be a rate between 0 and 1, got ${config.sample}`)
    }
  }

  const derive = config.derive ?? {}
  const samples = config.sample !== undefined

  // erased for the engine, which carries rows of every kind. See the counter
  const sink = config.write as WriteFn

  let binding: MetricBinding | undefined
  const pendingWrites = new Set<Promise<void>>()

  /** Local staging only: records waiting, and claims taken from them. */
  const buffer: StagedRecord[] = []
  const localInFlight = new Map<string, RecordClaim>()
  let localSeq = 0
  let batchTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Local staging only: the order each record was staged in.
   *
   * Kept beside the buffer rather than on the record, so the record stays the
   * shape every driver stores. A released claim is merged back by this, which
   * keeps the buffer in arrival order when two claims fail one after the
   * other.
   */
  const stagedOrder = new WeakMap<StagedRecord, number>()
  let stagedCount = 0

  /** One failure count for flush, batch and immediate sends alike. */
  const attempts = createAttempts()

  /**
   * The event's own cadence, the house's, or the fallback.
   *
   * Unlike a bucketed kind this cannot fail: there is no resolution for a
   * cadence to divide, so a default is always safe.
   */
  function effectiveFlushMs(): number {
    return ownFlushMs ?? binding?.defaults?.flushMs ?? DEFAULT_FLUSH_MS
  }

  /** Does this house ship without waiting for anyone to call `flush()`? */
  function isImmediate(): boolean {
    return binding?.delivery === 'immediate'
  }

  function activeBinding(): MetricBinding {
    if (!binding) {
      throw new Error(
        `${name}: not bound to a house — pass it to createHouse({ schema }) before writing`,
      )
    }
    return binding
  }

  function activeDriver(): Driver {
    return activeBinding().driver
  }

  /**
   * Report a failure that must not reach the caller.
   *
   * `record()` has already decided to stage the event by the time these fire,
   * and throwing here would drop it — which is precisely what a broken
   * `derive` must not do. With no handler it becomes an unhandled rejection:
   * noisy, and better than a failure disappearing in silence.
   */
  function reportDetached(error: unknown): void {
    const onError = binding?.onError
    if (onError) {
      onError(error, { metric: name })
      return
    }
    void Promise.reject(error)
  }

  function track(work: Promise<void>): void {
    const settled = work
      .catch((error: unknown) => {
        const onError = binding?.onError
        if (!onError) throw error
        onError(error, { metric: name })
      })
      .finally(() => {
        pendingWrites.delete(settled)
      })
    pendingWrites.add(settled)
  }

  /** Fill defaults, reject unknown or ill-typed fields. Throws at the caller. */
  function checked(values: InferShape<F>): Record<string, unknown> {
    const filled = applyDimDefaults(fields, values as Record<string, unknown>)
    validateDims(fields, filled, 'field')
    return filled
  }

  /**
   * The fields as they will be stored: a copy the caller cannot reach.
   *
   * A `json()` value becomes its JSON text here, at `record()`, for three
   * reasons. A value JSON cannot hold, a BigInt or a cycle, throws at the
   * caller instead of failing a whole batch at flush. The caller changing the
   * object afterwards cannot change what ships. And every driver stores the
   * same thing, so a payload that happens to look like one of Redis's own
   * markers comes back exactly as it went in. A `ts()` value is copied for the
   * second reason.
   */
  function stored(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      const type = fields[key]
      if (type?.kind === 'json') out[key] = jsonText(value, key)
      else if (isDate(value)) out[key] = new Date(value.getTime())
      // -0 as 0, which is what JSON, and so the Redis driver, makes of it
      else if (value === 0) out[key] = 0
      else out[key] = value
    }
    return out
  }

  function timestampFor(values: Record<string, unknown>, at: Date | number | undefined): number {
    // explicit `at` wins over the declared field, which wins over the clock
    if (at !== undefined) {
      const ms = isDate(at) ? at.getTime() : at
      // the range a Date can hold, ±8.64e15, and not merely a finite number:
      // anything past it ships as an Invalid Date
      if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
        throw new Error(`${name}: at must be a Date or epoch milliseconds, got ${String(at)}`)
      }
      return Math.floor(ms)
    }
    if (timestampField !== undefined) {
      const declared = values[timestampField]
      // an optional ts field that was omitted falls back to the clock rather
      // than stamping the epoch
      if (isDate(declared)) return declared.getTime()
    }
    // whole milliseconds, like every other timestamp a row carries
    return Math.floor((activeBinding().now ?? Date.now)())
  }

  /**
   * Fan out to the counters this event feeds.
   *
   * Never blocks staging: a broken `derive` must not lose the evidence, so a
   * throw is reported and the event is staged anyway.
   *
   * Each target is all or nothing. Every increment a function returns is
   * checked against the counter before any of them is applied, so a function
   * returning three targets where the third names an unknown dim moves no
   * counter at all, rather than two of them.
   */
  function runDerive(values: InferShape<F>): void {
    for (const [target, fn] of Object.entries(derive)) {
      try {
        const metric = activeBinding().resolve?.(target)
        if (!metric) {
          throw new Error(
            `${name}: derive names ${JSON.stringify(target)}, which no metric in this house ` +
              'declares — register it alongside the event',
          )
        }
        if (metric.kind !== 'counter') {
          throw new Error(
            `${name}: derive target ${JSON.stringify(target)} is a ${metric.kind}, and derive ` +
              'can only increment a counter',
          )
        }

        const increments = plannedIncrements(target, metric, fn(values))
        const add = (metric as unknown as { add: (n: number, dims?: unknown) => void }).add
        for (const one of increments) add.call(metric, one.value, one.dims)
      } catch (error) {
        reportDetached(error)
      }
    }
  }

  /**
   * What one derive function asked for, checked in full before any of it runs.
   *
   * @throws naming the event and the target, so a report says which derive
   * returned what
   */
  function plannedIncrements(
    target: string,
    metric: AnyMetric,
    produced: unknown,
  ): { value: number; dims: Record<string, unknown> }[] {
    const label = `${name}: derive for ${JSON.stringify(target)}`
    const list = Array.isArray(produced) ? produced : [produced]
    const isFloat = (metric as unknown as { isFloat?: boolean }).isFloat === true

    return list.map((one: unknown) => {
      if (typeof one !== 'object' || one === null || Array.isArray(one)) {
        throw new Error(
          `${label} must return { value?, dims? } or an array of them, got ${describeValue(one)}`,
        )
      }
      const { value = 1, dims: targetDims = {} } = one as DeriveTarget
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}: value must be a finite number, got ${describeValue(value)}`)
      }
      if (!isFloat && !Number.isSafeInteger(value)) {
        throw new Error(
          `${label}: ${value} is not a whole number, and ${target} counts in whole numbers`,
        )
      }
      if (typeof targetDims !== 'object' || targetDims === null || Array.isArray(targetDims)) {
        throw new Error(`${label}: dims must be an object, got ${describeValue(targetDims)}`)
      }
      // throws exactly as `add()` would, but before anything has been added
      try {
        encodeDimKey(metric.dims, targetDims as Record<string, unknown>)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${label}: ${reason}`)
      }
      return { value, dims: targetDims as Record<string, unknown> }
    })
  }

  /** The keep/drop decision, and the rate that goes on the row. */
  function sampleRate(values: InferShape<F>): number {
    if (config.sample === undefined) return 1
    const rate = typeof config.sample === 'number' ? config.sample : config.sample(values)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error(`${name}: sample returned ${String(rate)}, which is not a rate in [0, 1]`)
    }
    return rate
  }

  /**
   * Everything `record()` decides before it changes anything.
   *
   * Validation, the timestamp, the sampling decision and the stored copy all
   * happen here, and all of them can throw. Nothing here writes: `derive` and
   * staging wait until every record in the call has made it through, so a
   * call that throws leaves no trace anywhere.
   */
  function prepare(values: InferShape<F>, at: Date | number | undefined): Prepared<F> {
    const checkedValues = checked(values)
    const ts = timestampFor(checkedValues, at)
    // defaults applied: derive and sample see exactly what the row will carry,
    // not what the call site happened to omit
    const complete = checkedValues as InferShape<F>

    const rate = sampleRate(complete)
    const fieldsToStore = stored(checkedValues)

    // `< rate` is exact at both ends: 0 never keeps, 1 always does
    if (rate < 1 && !(Math.random() < rate)) return { values: complete, record: undefined }

    const ingestedAt = Math.floor((activeBinding().now ?? Date.now)())

    return {
      values: complete,
      record: {
        // minted here, not at flush: a released batch keeps its ids, so a retry
        // is the same row rather than a new one
        id: uuidv7(ingestedAt),
        ts,
        fields: {
          ...fieldsToStore,
          // stamped at record(), which is what makes a backfilled row
          // distinguishable from a live one — and stable across a retry, which
          // stamping at flush would not be
          _ingested_at: ingestedAt,
          ...(samples && { _sample_rate: rate }),
        },
      },
    }
  }

  /**
   * The half of `record()` that changes things: derive, then stage.
   *
   * Derive runs for every prepared record, sampled out or not, which is what
   * keeps the counters exact.
   */
  function commit(prepared: readonly Prepared<F>[]): void {
    const records: StagedRecord[] = []
    for (const one of prepared) {
      runDerive(one.values)
      if (one.record) records.push(one.record)
    }
    stageAll(records)
  }

  function stageAll(records: StagedRecord[]): void {
    if (records.length === 0) return

    if (stage === 'local') {
      for (const record of records) {
        stagedCount += 1
        stagedOrder.set(record, stagedCount)
      }
      buffer.push(...records)

      // immediate delivery is `maxSize: 1` without saying so — the batch
      // settings still describe the shape of a send, they just stop being what
      // decides when one happens
      if (isImmediate()) {
        shipLocal('immediate')
        return
      }
      if (buffer.length >= maxSize) {
        shipLocal('batch')
        return
      }
      armBatchTimer()
      return
    }

    const ops: AppendOp[] = records.map((record) => ({ metric: name, ...record }))
    const append = activeDriver().append(ops)

    // `stage` says *where* a record waits; delivery says *when* it leaves. A
    // driver-staged event under immediate delivery still round-trips through
    // the driver — it just does not wait for a flush to claim it back.
    track(isImmediate() ? append.then(shipStaged) : append)
  }

  /**
   * Claim and ship whatever is staged, right now.
   *
   * Exactly what `flush()` does for this metric, minus the cadence
   * check — a staged record is complete the instant it is appended, so unlike
   * a bucketed kind there is no partial state to protect and the ordinary
   * claim/ack path is correct. Immediate delivery therefore *replaces* flush
   * here rather than running alongside it.
   */
  async function shipStaged(): Promise<void> {
    const claim = await activeDriver().claimRecords(name, config.claimLimit)
    const outcome = await shipClaim(self, claim, sink, { attempts, source: 'immediate' })
    if (outcome.error !== undefined) throw outcome.error
  }

  /**
   * Start the `maxAge` clock, unless it is already running.
   *
   * Called when records are staged and when a failed send puts records back.
   * The clock starts at the first record of a batch, so `maxAge` bounds how
   * long the oldest record waits rather than the newest. After a failure it
   * starts again, so records that went back are retried `maxAge` later
   * instead of waiting for the next record or the next `flush()`.
   */
  function armBatchTimer(): void {
    if (batchTimer !== undefined || buffer.length === 0) return
    batchTimer = setTimeout(() => {
      batchTimer = undefined
      // everything, because every record waiting has now waited `maxAge`
      shipLocal('batch', true)
    }, maxAgeMs)
    batchTimer.unref?.()
  }

  /** Take the local buffer and push it at the sink, off the caller's stack. */
  /**
   * Ship from the local buffer, in batches of at most `claimLimit`.
   *
   * `everything` is for `maxAge` and `drain()`: every record already waiting
   * goes, however many batches that takes. A full buffer on `maxSize` ships
   * batches while the buffer is still full and leaves the rest to the age
   * clock, which starts again for them. Immediate delivery always ships
   * everything. Each record is sent once per call, so a sink that is down
   * puts its records back and they wait for the next trigger rather than
   * being retried in a loop.
   */
  function shipLocal(source: WriteContext['source'], everything = false): void {
    if (batchTimer !== undefined) {
      clearTimeout(batchTimer)
      batchTimer = undefined
    }
    // counted from what was waiting when this call began. A sink that fails
    // at once puts its records straight back, and a loop that waited for an
    // empty buffer would send them again for ever
    let unsent = buffer.length
    while (unsent > 0 && buffer.length > 0) {
      unsent -= shipLocalBatch(source)
      if (!everything && !isImmediate() && buffer.length < maxSize) break
    }
    armBatchTimer()
  }

  /** One claim from the local buffer, sent off the caller's stack. Returns its size. */
  function shipLocalBatch(source: WriteContext['source']): number {
    const claim = takeLocalClaim()

    track(
      (async (): Promise<void> => {
        const outcome = await shipClaim(self, claim, sink, { attempts, source })
        // a failed sink already released the records back into the buffer;
        // rethrow so the failure reaches onError rather than vanishing
        if (outcome.error !== undefined) throw outcome.error
      })(),
    )
    return claim.records.length
  }

  /** Move the local buffer into a claim. The local answer to `claimRecords`. */
  function takeLocalClaim(): RecordClaim {
    const taken =
      config.claimLimit === undefined ? buffer.splice(0) : buffer.splice(0, config.claimLimit)

    localSeq += 1
    const claim: RecordClaim = {
      kind: 'records',
      id: `${name}#local#${localSeq}`,
      metric: name,
      claimedAt: (binding?.now ?? Date.now)(),
      records: taken,
    }
    localInFlight.set(claim.id, claim)
    return claim
  }

  function assertRecords(claim: Claim): asserts claim is RecordClaim {
    if (!isRecordClaim(claim)) {
      throw new Error(`${name}: expected staged records but the driver returned a bucket claim`)
    }
  }

  function toMs(at: number | Date): number {
    return isDate(at) ? at.getTime() : at
  }

  /**
   * The local-buffer answer to `readPending`'s query.
   *
   * Half-open `[from, to)`, matching the driver, so a staged snapshot reads the
   * same whichever side of `stage` it lands on.
   */
  function bounded(
    records: readonly StagedRecord[],
    from: number | undefined,
    to: number | undefined,
    limit: number | undefined,
  ): StagedRecord[] {
    const within = records.filter(
      (record) => (from === undefined || record.ts >= from) && (to === undefined || record.ts < to),
    )
    return limit === undefined ? within : within.slice(0, limit)
  }

  /** Turn one staged record into the row a sink receives. */
  function materialize(record: StagedRecord): Row {
    const row: Row = { id: record.id, ts: new Date(record.ts) }

    for (const [key, type] of Object.entries(fields)) {
      const value = record.fields[key]
      if (value === undefined) continue
      // a payload is a string column, and `record()` already turned it into
      // one. A record staged by an older version still holds the value
      // itself, so that one is turned into text here
      row[key] = type.kind === 'json' && typeof value !== 'string' ? JSON.stringify(value) : value
    }

    row._ingested_at = new Date(record.fields._ingested_at as number)
    if (samples) row._sample_rate = record.fields._sample_rate

    return row
  }

  const self: Event<F, K> = {
    ...metricFlush({
      name,
      flushMs: effectiveFlushMs,
      sink: () => sink,
      now: () => (activeBinding().now ?? Date.now)(),
      self: () => self,
      attempts,
    }),

    name,
    kind,
    storage: 'staged',
    fields,
    stage,
    // an event has fields, not dims: they are unkeyed, `json()` is legal among
    // them, and no series is built from them
    dims: {},
    // nor does it bucket — a record is its own instant, and 1ms is the finest
    // grain the rest of the system can express
    resolutionMs: 1,

    get flushMs(): number {
      return effectiveFlushMs()
    },

    graceMs: 0,
    write: config.write,

    get isBound(): boolean {
      return binding !== undefined
    },

    bind(next: MetricBinding): void {
      if (binding) {
        throw new Error(`${name}: already bound to a house — a metric belongs to exactly one`)
      }
      binding = next
    },

    unbind(): void {
      binding = undefined
    },

    record(values: InferShape<F>, options?: { at?: Date | number }): void {
      activeBinding()
      commit([prepare(values, options?.at)])
    },

    recordMany(many: readonly InferShape<F>[], options?: { at?: Date | number }): void {
      activeBinding()
      // every record is prepared before any of them is committed, so one bad
      // record in the list throws with nothing derived and nothing staged
      commit(many.map((values) => prepare(values, options?.at)))
    },

    async pending(): Promise<number> {
      if (stage === 'local') {
        let inFlight = 0
        for (const claim of localInFlight.values()) inFlight += claim.records.length
        return buffer.length + inFlight
      }
      return activeDriver().countPending(name)
    },

    async snapshot(options: SnapshotOptions = {}): Promise<EventLiveRow<F>[]> {
      const from = options.from === undefined ? undefined : toMs(options.from)
      const to = options.to === undefined ? undefined : toMs(options.to)
      if (options.limit !== undefined) assertLimit(options.limit, name)

      // with an order to sort by, every record has to be read before the top
      // ones are known. Without one, the limit is only "the first n", which
      // the driver can answer without reading the rest
      const readLimit = options.orderBy === undefined ? options.limit : undefined

      const records =
        stage === 'local'
          ? bounded(buffer, from, to, readLimit)
          : await activeDriver().readPending({
              metric: name,
              ...(from !== undefined && { from }),
              ...(to !== undefined && { to }),
              ...(readLimit !== undefined && { limit: readLimit }),
            })

      const rows = records.map(
        (record) =>
          ({
            ...materialize(record),
            // complete on arrival, and with no window to be a fraction of
            bucket_open: false,
            bucket_elapsed_ms: 0,
          }) as unknown as EventLiveRow<F>,
      )

      return orderAndLimit(
        rows as unknown as Record<string, unknown>[],
        options,
        name,
      ) as unknown as EventLiveRow<F>[]
    },

    async peek(n?: number): Promise<EventRow<F>[]> {
      if (n !== undefined) assertLimit(n, name, 'peek(n)')
      if (n === 0) return []
      const records =
        stage === 'local'
          ? buffer.slice(0, n ?? buffer.length)
          : await activeDriver().readPending({ metric: name, ...(n !== undefined && { limit: n }) })
      return records.map(materialize) as unknown as EventRow<F>[]
    },

    async recoverBatch(): Promise<RecoveryReport> {
      // a locally staged batch is claimed out of `buffer` into `localInFlight`,
      // both of which are this process's heap. A crash takes them with it, so
      // there is nothing left behind to put back — the same trade `stage:
      // 'local'` already makes everywhere else
      if (stage === 'local') return NOTHING_RECOVERED
      return activeDriver().recover(name)
    },

    async claimBatch(): Promise<Claim> {
      if (stage === 'local') return takeLocalClaim()
      return activeDriver().claimRecords(name, config.claimLimit)
    },

    materializeClaim(claim: Claim): MaterializedBatch {
      assertRecords(claim)

      const rows = claim.records.map(materialize)
      // the earliest and latest timestamps, not the first and last records: a
      // backfilled record carries an older `ts` than the ones staged before it
      let first = Number.POSITIVE_INFINITY
      let last = Number.NEGATIVE_INFINITY
      for (const record of claim.records) {
        if (record.ts < first) first = record.ts
        if (record.ts > last) last = record.ts
      }
      if (claim.records.length === 0) {
        first = 0
        last = 0
      }

      return {
        rows,
        bucketFrom: first,
        // one millisecond past the newest record, so the window stays
        // half-open like every other kind's
        bucketTo: last + 1,
        // an event's headline is how many happened — there is no value to sum
        total: rows.length,
        // records are not bucketed, and reporting 1 would invent a window
        buckets: 0,
      }
    },

    async ackBatch(claim: Claim): Promise<void> {
      assertRecords(claim)
      if (stage === 'local') {
        if (!localInFlight.delete(claim.id)) {
          throw new Error(`${name}: claim ${claim.id} is not in flight — already settled?`)
        }
        return
      }
      await activeDriver().ack(claim)
    },

    async releaseBatch(claim: Claim): Promise<void> {
      assertRecords(claim)
      if (stage === 'local') {
        if (!localInFlight.delete(claim.id)) {
          throw new Error(`${name}: claim ${claim.id} is not in flight — already settled?`)
        }
        // back in the order they were staged. These are older than anything
        // recorded since, but a claim that failed before this one may already
        // be back at the front, and its records are older still
        const merged = [...claim.records, ...buffer].sort(
          (a, b) => (stagedOrder.get(a) ?? 0) - (stagedOrder.get(b) ?? 0),
        )
        buffer.splice(0, buffer.length, ...merged)
        armBatchTimer()
        return
      }
      await activeDriver().release(claim)
    },

    async drain(): Promise<void> {
      // a locally staged batch is only in this process's heap, so leaving it
      // there after drain() resolves is exactly the silent loss drain exists
      // to prevent
      //
      // Ships each record **once**, deliberately, in as many batches as
      // `claimLimit` needs. A failed sink releases its records back into the
      // buffer, and re-shipping whatever is in the buffer would spin against a
      // sink that is down until the process dies.
      if (stage === 'local') shipLocal('batch', true)

      while (pendingWrites.size > 0) {
        await Promise.all([...pendingWrites])
      }
    },

    rowShape(): RowShape {
      const columns: RowColumn[] = [
        { name: 'id', kind: 'str', optional: false },
        { name: 'ts', kind: 'ts', optional: false },
        ...Object.keys(fields).map((column) => {
          const type = fields[column] as FieldType
          // json arrives stringified, so the column it wants is text
          return {
            name: column,
            kind: type.kind === 'json' ? ('str' as const) : type.kind,
            optional: type.isOptional,
          }
        }),
        { name: '_ingested_at', kind: 'ts', optional: false },
      ]
      if (samples) columns.push({ name: '_sample_rate', kind: 'float', optional: false })
      return { columns }
    },
  }

  return self
}
