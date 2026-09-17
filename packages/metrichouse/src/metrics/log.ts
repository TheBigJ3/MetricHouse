/**
 * Log — an event preset with three reserved fields: `ts`, `level`, `message`.
 *
 * A structured log *is* a discrete typed record, which is what an event
 * already is, so this file adds no storage model. What it adds is the part
 * that made people build a second pipeline instead: a level, a filter that
 * drops the noisy half before it costs anything, an `Error` overload that puts
 * the stack somewhere queryable, and a bound child logger. Underneath, a log
 * stages, batches, claims, flushes and dedupes exactly like an event, because
 * it is one.
 *
 * **Why a preset rather than a second primitive.** The alternative was a
 * logging library beside the metrics library, with its own transport, its own
 * flush cadence and its own crash semantics — and logs are the one signal that
 * matters most in the minute a process is dying. Sharing `stagedMetric` means
 * a log inherits the staging guarantees rather than reimplementing them badly.
 *
 * Spec: initialPlan/06-logs.md
 */

import type { Claim } from '../drivers/types.js'
import type { LiveFields, SnapshotOptions } from '../runtime/live.js'
import type { InferShape, MarkOptional, Shape, ShapeArgs, Simplify } from '../schema/types.js'
import { oneOf, str } from '../schema/types.js'
import type { DurationInput } from '../time/duration.js'
import {
  type Event,
  type EventBatchConfig,
  type EventLiveRow,
  type EventStage,
  stagedMetric,
} from './event.js'
import type {
  AnyMetric,
  MaterializedBatch,
  MetricBinding,
  Row,
  RowShape,
  WriteFn,
} from './types.js'

/** The levels a log declares when it does not say otherwise. */
export const DEFAULT_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type DefaultLogLevels = typeof DEFAULT_LOG_LEVELS

/**
 * Columns MetricHouse owns on every log row. A declared field may not take one.
 *
 * Longer than an event's list by the three the preset exists for, plus
 * `_sample_rate`: a log does not sample today, but it shares an event's column
 * namespace and reserving the name now is cheaper than a breaking change when
 * it does.
 */
export const RESERVED_LOG_COLUMNS = [
  'id',
  'ts',
  'level',
  'message',
  'error_stack',
  '_ingested_at',
  '_sample_rate',
] as const

/**
 * Names a level may not take, because a level becomes a method on the logger
 * and would otherwise shadow one of these.
 *
 * `log('x', { levels: ['debug', 'drain'] })` is a mistake worth catching at
 * declaration: the alternative is `logger.drain()` silently writing a record
 * instead of flushing. {@link shadows} also rules out everything on
 * `Object.prototype`, which this list does not repeat.
 */
const RESERVED_LEVEL_NAMES: readonly string[] = [
  'name',
  'kind',
  'fields',
  'levels',
  'minLevel',
  'stage',
  'dims',
  'resolutionMs',
  'flushMs',
  'graceMs',
  'write',
  'isBound',
  'at',
  'child',
  'bound',
  'pending',
  'peek',
  'rowShape',
  'bind',
  'drain',
  'claimBatch',
  'materializeClaim',
  'ackBatch',
  'releaseBatch',
]

/**
 * Would a method by this name collide with something already there?
 *
 * `'__proto__'` is the one that is not merely confusing: assigning it on an
 * object literal sets the prototype instead of a key, so the level method
 * would silently fail to exist rather than shadow anything.
 */
function shadows(level: string): boolean {
  return RESERVED_LEVEL_NAMES.includes(level) || level in {}
}

/**
 * The fields argument — omittable only when nothing in the shape is required,
 * so a log with no declared fields reads `log.info('started')` rather than
 * `log.info('started', {})`.
 */
export type LogFieldsArgs<F extends Shape> = ShapeArgs<F>

/**
 * One method per declared level.
 *
 * `levels: ['trace', 'info', 'fatal']` gives you `.trace()`, `.info()` and
 * `.fatal()` and nothing else — which is what "the type narrows to whatever
 * you list" has to mean if it means anything. A level you did not declare is
 * a compile error rather than a row with a level nobody queries.
 */
export type LogWriters<F extends Shape, L extends readonly string[]> = {
  readonly [K in L[number]]: (message: string | Error, ...fields: LogFieldsArgs<F>) => void
}

/**
 * A logger with some fields already filled in.
 *
 * Not a metric: it stages into the log that made it, shares its batch, and is
 * the reason `requestId` does not have to be threaded through every call in a
 * request. A required field satisfied by `child()` stops being required at the
 * call site, and may still be overridden there — see `MarkOptional`.
 */
export type ChildLog<F extends Shape, L extends readonly string[]> = LogWriters<F, L> & {
  readonly name: string
  /** The fields merged into every call this logger makes. */
  readonly bound: Readonly<Record<string, unknown>>

  at(level: L[number], message: string | Error, ...fields: LogFieldsArgs<F>): void

  child<const B extends Partial<InferShape<F>>>(fields: B): ChildLog<MarkOptional<F, keyof B>, L>
}

export interface LogConfig<F extends Shape, L extends readonly string[]> {
  /** Extra declared fields, alongside the reserved three. */
  readonly fields?: F
  /**
   * The closed set of levels, **in ascending severity** — the order is what
   * `minLevel` compares on, so it is a declaration, not a formality.
   *
   * Default `['debug', 'info', 'warn', 'error']`.
   */
  readonly levels?: L
  /**
   * Drop anything below this before it reaches the driver.
   *
   * Dropped means dropped: no record is staged, no field is validated and
   * nothing is queued, so a `debug` call under `minLevel: 'info'` costs one
   * array index. Defaults to the lowest declared level, which keeps
   * everything.
   */
  readonly minLevel?: L[number]
  /** Default `'driver'`. See {@link EventStage}. */
  readonly stage?: EventStage
  /** Local staging only — ignored when `stage: 'driver'`. */
  readonly batch?: EventBatchConfig
  /** Minimum shipping cadence for `flush()`. Default `'30s'`. */
  readonly flush?: DurationInput
  /** Records one flush may carry. Unlimited by default. */
  readonly claimLimit?: number
  /** This log's sink. Falls back to the house's `write` when omitted. */
  readonly write?: WriteFn
}

/**
 * One live row from a log: the reserved three, your declared fields, and the
 * liveness fields.
 *
 * `level` is typed to the levels this log declares, so a snapshot narrows the
 * same way a call site does.
 */
export type LogLiveRow<F extends Shape, L extends readonly string[]> = Simplify<
  {
    id: string
    ts: Date
    level: L[number]
    message: string
    error_stack?: string
  } & InferShape<F> & { _ingested_at: Date } & LiveFields
>

/**
 * `snapshot` is omitted from {@link AnyMetric} and redeclared below rather than
 * simply added. A `Log` is an intersection, not an interface, so two signatures
 * for one name merge into an **overload set** instead of the more specific one
 * overriding the broader — and the erased `LiveRow[]` would win by being first,
 * which is how the typed row silently became `unknown` per key once. The other
 * four kinds use `interface … extends AnyMetric` and narrow it normally.
 */
export type Log<F extends Shape, L extends readonly string[]> = Omit<AnyMetric, 'snapshot'> &
  LogWriters<F, L> & {
    readonly name: string
    readonly kind: 'log'
    /** The fields you declared. The reserved three are not among them. */
    readonly fields: F
    readonly levels: L
    readonly minLevel: L[number]
    readonly stage: EventStage
    readonly flushMs: number
    readonly write: WriteFn | undefined
    readonly isBound: boolean

    bind(binding: MetricBinding): void

    /**
     * Write at a level chosen at runtime — a level parsed from an upstream
     * payload, or carried in a variable.
     *
     * @throws if `level` is not one of the declared levels. A log line with a
     * level nothing queries is worse than a loud failure at the one call site
     * that could have a typo.
     */
    at(level: L[number], message: string | Error, ...fields: LogFieldsArgs<F>): void

    /** A logger that merges `fields` into every call. */
    child<const B extends Partial<InferShape<F>>>(fields: B): ChildLog<MarkOptional<F, keyof B>, L>

    /** How many records are staged and not yet shipped. */
    pending(): Promise<number>

    /** The first `n` staged records as rows, without consuming them. */
    peek(n?: number): Promise<Row[]>

    /** Unshipped log lines as typed rows. Never partial — see the event. */
    snapshot(options?: SnapshotOptions): Promise<LogLiveRow<F, L>[]>

    drain(): Promise<void>

    /** The typed row your `write()` will receive. */
    rowShape(): RowShape
  }

/**
 * Split a message into the two columns it can fill.
 *
 * Coerces rather than throws, deliberately and against the grain of the rest
 * of this package: a logger that takes down a request because someone passed
 * a number is worse than a row reading `"42"`. Everything else here still
 * throws — this is the one call people make from inside a `catch`.
 */
function splitMessage(message: string | Error): { message: string; error_stack?: string } {
  if (message instanceof Error) {
    return {
      message: message.message,
      // a rethrown or cross-realm error can arrive without one; the header
      // line is still worth more than an empty column
      error_stack: message.stack ?? `${message.name}: ${message.message}`,
    }
  }
  if (typeof message === 'string') return { message }
  return { message: String(message) }
}

/**
 * Declare a log.
 *
 * @throws if the configuration is invalid — an empty name, an empty or
 * duplicated level set, a `minLevel` that is not a declared level, a level
 * that would shadow a method, or a field taking a reserved column name.
 */
export function log<
  F extends Shape = Record<string, never>,
  const L extends readonly string[] = DefaultLogLevels,
>(name: string, config: LogConfig<F, L> = {}): Log<F, L> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('log: name must be a non-empty string')
  }

  const levels = (config.levels ?? DEFAULT_LOG_LEVELS) as unknown as L
  const fields = config.fields ?? ({} as F)

  if (levels.length === 0) {
    throw new Error(`${name}: levels must declare at least one level`)
  }
  const seen = new Set<string>()
  for (const level of levels) {
    if (typeof level !== 'string' || level.trim() === '') {
      throw new Error(`${name}: every level must be a non-empty string`)
    }
    if (seen.has(level)) {
      throw new Error(`${name}: level ${JSON.stringify(level)} is declared twice`)
    }
    if (shadows(level)) {
      throw new Error(
        `${name}: level ${JSON.stringify(level)} would shadow an existing property on the ` +
          'logger — pick another',
      )
    }
    seen.add(level)
  }

  for (const key of Object.keys(fields)) {
    if ((RESERVED_LOG_COLUMNS as readonly string[]).includes(key)) {
      throw new Error(
        `${name}: field ${JSON.stringify(key)} is a reserved column — ` +
          `MetricHouse owns [${RESERVED_LOG_COLUMNS.join(', ')}] on every log row`,
      )
    }
  }

  const minLevel = (config.minLevel ?? levels[0]) as L[number]
  const minIndex = levels.indexOf(minLevel)
  if (minIndex === -1) {
    throw new Error(
      `${name}: minLevel ${JSON.stringify(minLevel)} is not one of the declared levels ` +
        `[${levels.join(', ')}]`,
    )
  }

  // reserved first, declared fields after: the row reads
  // `id, ts, level, message, error_stack, …yours, _ingested_at`, and column
  // order is part of the shape a table is created from
  const composed: Shape = {
    level: oneOf(levels as unknown as readonly string[]),
    message: str(),
    error_stack: str().optional(),
    ...fields,
  }

  const inner: Event<Shape, 'log'> = stagedMetric<Shape, 'log'>(
    name,
    {
      fields: composed,
      ...(config.stage !== undefined && { stage: config.stage }),
      ...(config.batch !== undefined && { batch: config.batch }),
      ...(config.flush !== undefined && { flush: config.flush }),
      ...(config.claimLimit !== undefined && { claimLimit: config.claimLimit }),
      ...(config.write !== undefined && { write: config.write }),
    },
    'log',
  )

  /**
   * The whole write path. One index comparison decides whether anything
   * happens at all, which is what makes a filtered-out `debug` free.
   */
  function emit(
    level: string,
    message: string | Error,
    values: Record<string, unknown> | undefined,
    bound: Record<string, unknown>,
  ): void {
    const index = levels.indexOf(level)
    if (index === -1) {
      throw new Error(
        `${name}: ${JSON.stringify(level)} is not one of the declared levels ` +
          `[${levels.join(', ')}]`,
      )
    }
    if (index < minIndex) return

    // the call site wins over the child's bound fields: the nearer the
    // context, the more specific it is
    inner.record({ ...bound, ...values, level, ...splitMessage(message) })
  }

  /** The level methods, for the log itself and for every child of it. */
  function writers(bound: Record<string, unknown>): Record<string, unknown> {
    const methods: Record<string, unknown> = {}
    for (const level of levels) {
      methods[level] = (message: string | Error, values?: Record<string, unknown>): void => {
        emit(level, message, values, bound)
      }
    }
    return methods
  }

  function makeChild(bound: Record<string, unknown>): ChildLog<Shape, L> {
    return {
      ...writers(bound),
      name,
      bound: Object.freeze({ ...bound }),

      at(level: string, message: string | Error, values?: Record<string, unknown>): void {
        emit(level, message, values, bound)
      },

      // merged, not replaced: a child of a child keeps the request id its
      // parent bound and adds to it
      child(fields: Record<string, unknown>) {
        return makeChild({ ...bound, ...fields })
      },
    } as unknown as ChildLog<Shape, L>
  }

  const self = {
    ...writers({}),

    name,
    kind: 'log' as const,
    storage: 'staged' as const,
    fields,
    levels,
    minLevel,
    stage: inner.stage,
    // a log is not bucketed and has no dims, for the same reasons an event
    // is not and has none
    dims: {},
    resolutionMs: inner.resolutionMs,

    // read through: the event resolves its cadence against its binding
    get flushMs(): number {
      return inner.flushMs
    },

    graceMs: inner.graceMs,
    write: inner.write,

    get isBound(): boolean {
      return inner.isBound
    },

    bind(binding: MetricBinding): void {
      inner.bind(binding)
    },

    at(level: string, message: string | Error, values?: Record<string, unknown>): void {
      emit(level, message, values, {})
    },

    child(fields: Record<string, unknown>) {
      return makeChild(fields)
    },

    pending(): Promise<number> {
      return inner.pending()
    },

    peek(n?: number): Promise<Row[]> {
      return inner.peek(n)
    },

    snapshot(options?: SnapshotOptions): Promise<EventLiveRow<Shape>[]> {
      return inner.snapshot(options)
    },

    drain(): Promise<void> {
      return inner.drain()
    },

    rowShape(): RowShape {
      return inner.rowShape()
    },

    // the staged lifecycle, untouched — the flush engine talks to the event
    // underneath and never learns a log was involved
    claimBatch(nowMs: number): Promise<Claim> {
      return inner.claimBatch(nowMs)
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

  return self as unknown as Log<F, L>
}
