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

import type { AppendOp, Claim, Driver, RecordClaim, StagedRecord } from '../drivers/types.js'
import { isRecordClaim } from '../drivers/types.js'
import { uuidv7 } from '../identity.js'
import { metricFlush } from '../runtime/flush.js'
import type { LiveFields, SnapshotOptions } from '../runtime/live.js'
import { shipClaim } from '../runtime/ship.js'
import { applyDimDefaults, validateDims } from '../schema/dims.js'
import type { FieldType, InferShape, Shape, Simplify } from '../schema/types.js'
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
  readonly timestamp?: 'auto' | (keyof F & string)
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
   */
  readonly derive?: Readonly<Record<string, DeriveFn<InferShape<F>>>>
  /**
   * Records one flush may carry. Unlimited by default — a claim takes the
   * whole backlog, the same way a counter's claim takes every closed bucket.
   * Set it when the backlog can outgrow what the sink will accept at once.
   */
  readonly claimLimit?: number
  /** Where this event's rows go. Required — see the counter for why. */
  readonly write: WriteFn
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
  readonly write: WriteFn
  readonly isBound: boolean

  bind(binding: MetricBinding): void

  /** Stage one event. Fire-and-forget: `drain()` is what confirms it landed. */
  record(fields: InferShape<F>, options?: { at?: Date | number }): void

  /** Stage many in one round trip. */
  recordMany(fields: readonly InferShape<F>[], options?: { at?: Date | number }): void

  /** How many records are staged and not yet shipped. */
  pending(): Promise<number>

  /** The first `n` staged records as rows, without consuming them. */
  peek(n?: number): Promise<Row[]>

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
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('event: name must be a non-empty string')
  }

  const fields = config.fields ?? ({} as F)

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

  let binding: MetricBinding | undefined
  const pendingWrites = new Set<Promise<void>>()

  /** Local staging only: records waiting, and claims taken from them. */
  const buffer: StagedRecord[] = []
  const localInFlight = new Map<string, RecordClaim>()
  let localSeq = 0
  let batchTimer: ReturnType<typeof setTimeout> | undefined

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

  function timestampFor(values: Record<string, unknown>, at: Date | number | undefined): number {
    // explicit `at` wins over the declared field, which wins over the clock
    if (at !== undefined) {
      const ms = at instanceof Date ? at.getTime() : at
      if (!Number.isFinite(ms)) {
        throw new Error(`${name}: at must be a Date or epoch milliseconds, got ${String(at)}`)
      }
      return Math.floor(ms)
    }
    if (timestampField !== undefined) {
      const declared = values[timestampField]
      // an optional ts field that was omitted falls back to the clock rather
      // than stamping the epoch
      if (declared instanceof Date) return declared.getTime()
    }
    return (activeBinding().now ?? Date.now)()
  }

  /**
   * Fan out to the counters this event feeds.
   *
   * Runs before sampling and never blocks staging: a broken `derive` must not
   * lose the evidence, so a throw is reported and the event is staged anyway.
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

        const produced = fn(values)
        const targets = Array.isArray(produced) ? produced : [produced as DeriveTarget]
        const add = (metric as unknown as { add: (n: number, dims?: unknown) => void }).add

        for (const one of targets) {
          add.call(metric, one.value ?? 1, one.dims ?? {})
        }
      } catch (error) {
        reportDetached(error)
      }
    }
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

  /** Build the record for one event, or `undefined` when sampling dropped it. */
  function stagedFrom(
    values: InferShape<F>,
    at: Date | number | undefined,
  ): StagedRecord | undefined {
    const checkedValues = checked(values)
    const ts = timestampFor(checkedValues, at)
    // defaults applied: derive and sample see exactly what the row will carry,
    // not what the call site happened to omit
    const complete = checkedValues as InferShape<F>

    // derive first, then sample — the counters stay exact whatever the event
    // table keeps
    runDerive(complete)

    const rate = sampleRate(complete)
    // `< rate` is exact at both ends: 0 never keeps, 1 always does
    if (rate < 1 && !(Math.random() < rate)) return undefined

    const ingestedAt = (activeBinding().now ?? Date.now)()

    return {
      // minted here, not at flush: a released batch keeps its ids, so a retry
      // is the same row rather than a new one
      id: uuidv7(ingestedAt),
      ts,
      fields: {
        ...checkedValues,
        // stamped at record(), which is what makes a backfilled row
        // distinguishable from a live one — and stable across a retry, which
        // stamping at flush would not be
        _ingested_at: ingestedAt,
        ...(samples && { _sample_rate: rate }),
      },
    }
  }

  function stageAll(records: StagedRecord[]): void {
    if (records.length === 0) return

    if (stage === 'local') {
      const wasEmpty = buffer.length === 0
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
      // the clock starts at the first record of a batch, so maxAge bounds how
      // long the *oldest* record waits rather than the newest
      if (wasEmpty && batchTimer === undefined) {
        batchTimer = setTimeout(() => {
          batchTimer = undefined
          shipLocal('batch')
        }, maxAgeMs)
        batchTimer.unref?.()
      }
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
    const outcome = await shipClaim(self, claim, config.write, {
      attempt: 1,
      source: 'immediate',
    })
    if (outcome.error !== undefined) throw outcome.error
  }

  /** Take the local buffer and push it at the sink, off the caller's stack. */
  function shipLocal(source: WriteContext['source']): void {
    if (batchTimer !== undefined) {
      clearTimeout(batchTimer)
      batchTimer = undefined
    }
    if (buffer.length === 0) return

    const claim = takeLocalClaim()

    track(
      (async (): Promise<void> => {
        const outcome = await shipClaim(self, claim, config.write, { attempt: 1, source })
        // a failed sink already released the records back into the buffer;
        // rethrow so the failure reaches onError rather than vanishing
        if (outcome.error !== undefined) throw outcome.error
      })(),
    )
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
    return at instanceof Date ? at.getTime() : at
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
      // a payload becomes a string column — the driver held it opaquely and
      // your table almost certainly wants text
      row[key] = type.kind === 'json' ? JSON.stringify(value) : value
    }

    row._ingested_at = new Date(record.fields._ingested_at as number)
    if (samples) row._sample_rate = record.fields._sample_rate

    return row
  }

  const self: Event<F, K> = {
    ...metricFlush({
      name,
      flushMs: effectiveFlushMs,
      sink: () => config.write,
      now: () => (activeBinding().now ?? Date.now)(),
      self: () => self,
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

    record(values: InferShape<F>, options?: { at?: Date | number }): void {
      activeBinding()
      const record = stagedFrom(values, options?.at)
      if (record) stageAll([record])
    },

    recordMany(many: readonly InferShape<F>[], options?: { at?: Date | number }): void {
      activeBinding()
      const records: StagedRecord[] = []
      for (const values of many) {
        const record = stagedFrom(values, options?.at)
        if (record) records.push(record)
      }
      stageAll(records)
    },

    async pending(): Promise<number> {
      if (stage === 'local') return buffer.length
      return activeDriver().countPending(name)
    },

    async snapshot(options: SnapshotOptions = {}): Promise<EventLiveRow<F>[]> {
      const from = options.from === undefined ? undefined : toMs(options.from)
      const to = options.to === undefined ? undefined : toMs(options.to)

      const records =
        stage === 'local'
          ? bounded(buffer, from, to, options.limit)
          : await activeDriver().readPending({
              metric: name,
              ...(from !== undefined && { from }),
              ...(to !== undefined && { to }),
              ...(options.limit !== undefined && { limit: options.limit }),
            })

      return records.map(
        (record) =>
          ({
            ...materialize(record),
            // complete on arrival, and with no window to be a fraction of
            bucket_open: false,
            bucket_elapsed_ms: 0,
          }) as unknown as EventLiveRow<F>,
      )
    },

    async peek(n?: number): Promise<Row[]> {
      const records =
        stage === 'local'
          ? buffer.slice(0, n ?? buffer.length)
          : await activeDriver().readPending({ metric: name, ...(n !== undefined && { limit: n }) })
      return records.map(materialize)
    },

    async claimBatch(): Promise<Claim> {
      if (stage === 'local') return takeLocalClaim()
      return activeDriver().claimRecords(name, config.claimLimit)
    },

    materializeClaim(claim: Claim): MaterializedBatch {
      assertRecords(claim)

      const rows = claim.records.map(materialize)
      const first = claim.records[0]?.ts ?? 0
      const last = claim.records.at(-1)?.ts ?? 0

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
        // to the front: these are older than anything recorded since
        buffer.unshift(...claim.records)
        return
      }
      await activeDriver().release(claim)
    },

    async drain(): Promise<void> {
      // a locally staged batch is only in this process's heap, so leaving it
      // there after drain() resolves is exactly the silent loss drain exists
      // to prevent
      //
      // Ships **once**, deliberately. A failed sink releases those records
      // back into the buffer, and re-shipping whatever is in the buffer would
      // spin against a sink that is down until the process dies.
      if (stage === 'local') shipLocal('batch')

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
