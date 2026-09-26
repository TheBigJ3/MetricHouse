/**
 * The batch lifecycle shared by every aggregate primitive.
 *
 * Counter, gauge and level differ in what a cell *is* and what a row looks
 * like, and in almost nothing else: all three bucket by resolution, claim on a
 * watermark, and hand the driver's claim/ack/release back untouched. That
 * common part lives here, so a kind supplies `materialize` and `totalOf` and
 * inherits the rest. A level is the one that adds anything on top, and what it
 * adds is a step before the claim rather than a change to one.
 */

import {
  type BucketRow,
  type Cell,
  type Claim,
  type Driver,
  isBucketClaim,
  type RecoveryReport,
} from '../drivers/types.js'
import { type Attempts, createAttempts } from '../runtime/flush.js'
import {
  applySnapshot,
  type BucketedRow,
  type LiveRow,
  type MergeValues,
  type SnapshotOptions,
  sameValue,
  snapshotRange,
  type TypedSnapshot,
} from '../runtime/live.js'
import { shipOpenSeries } from '../runtime/ship.js'
import { dimKeyDecoder } from '../schema/dims.js'
import type { Shape } from '../schema/types.js'
import { assertResolution, closedUpTo } from '../time/buckets.js'
import { type DurationInput, parseDuration, parseInterval } from '../time/duration.js'
import type {
  AnyMetric,
  ClaimOptions,
  MaterializedBatch,
  MetricBinding,
  MetricKind,
  Row,
  WriteFn,
} from './types.js'

/**
 * How long a window waits after it ends before a flush may claim it, when
 * neither the metric nor the house says otherwise.
 *
 * Shared by every bucketed kind so the number is written once: a counter and a
 * gauge disagreeing about it would ship the same window at different times.
 */
export const DEFAULT_GRACE_MS = 2_000

/**
 * The watermark a claim at `nowMs` takes everything strictly below: every
 * window that has ended and outlived grace. A final flush waives the grace,
 * see `FlushOptions.final`.
 */
export function claimWatermark(
  resolutionMs: number,
  nowMs: number,
  graceMs: () => number,
  options: ClaimOptions = {},
): number {
  return closedUpTo(resolutionMs, nowMs, options.final ? 0 : graceMs())
}

/**
 * Which series a materialized row belongs to: its dim values in declared
 * order, as one string a Map or a Set can key on.
 */
export function seriesKey(dimNames: readonly string[], row: Row): string {
  return JSON.stringify(dimNames.map((dim) => row[dim]))
}

/** What a bucketed kind declares that {@link bucketedBinding} resolves. */
export interface BucketedBindingOptions {
  readonly name: string
  /** Named in the error for a missing cadence, so it says what to declare it on. */
  readonly kind: MetricKind
  readonly resolution: DurationInput
  readonly flush?: DurationInput | undefined
  readonly grace?: DurationInput | undefined
  /** For `delivery: 'immediate'`, which ships the open series after each write. */
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly totalOf: (rows: readonly Row[]) => number
  /** The sink, erased: the open series path carries rows of every kind. */
  readonly sink: WriteFn
}

/** The house a bucketed kind is bound to, and everything read from it. */
export interface BucketedBinding {
  /** Parsed once, at declaration. The write path never parses a duration. */
  readonly resolutionMs: number
  /** One failure count for flushes and immediate sends alike. */
  readonly attempts: Attempts
  isBound(): boolean
  /** The binding, or a throw naming the metric when there is none. */
  active(): MetricBinding
  driver(): Driver
  /** The bound clock. */
  now(): number
  /**
   * The metric's own cadence, or the house's. Resolved on every read rather
   * than at bind, so nothing has to care which came first. `from` is the
   * binding to read the house's from, which `bind` passes before it keeps one.
   */
  flushMs(from?: MetricBinding): number
  graceMs(): number
  /**
   * Keep a house. Called by the house; a metric belongs to exactly one, and
   * binding twice throws rather than quietly redirecting writes.
   */
  bind(next: MetricBinding): void
  unbind(): void
  /**
   * Under `delivery: 'immediate'`, follow a write with a send of the whole
   * open bucket for its series. Otherwise the write as it is.
   */
  deliver(write: Promise<void>, bucketTs: number, dimKey: string): Promise<void>
}

/**
 * The binding half every bucketed kind shares: its durations, the house it is
 * bound to, the cadence and grace read from either, and immediate delivery.
 *
 * Parses and checks the durations when called, so a kind calls it where its
 * declaration is validated and a bad duration throws in the same order it
 * always did.
 *
 * @throws if a duration is invalid, or a declared `flush` is not a whole
 * multiple of `resolution`
 */
export function bucketedBinding(options: BucketedBindingOptions): BucketedBinding {
  const { name, kind, materialize, totalOf, sink } = options

  // parsed once, here. The write path does integer math and never sees a
  // duration string
  const resolutionMs = parseDuration(options.resolution)
  const ownFlushMs =
    options.flush === undefined ? undefined : parseInterval(options.flush, `${name}: flush`)
  const ownGraceMs = options.grace === undefined ? undefined : parseDuration(options.grace)
  // eager when the metric declares its own cadence: a bad pair is a
  // programming error and should surface when the schema file is read, not at
  // the first flush
  if (ownFlushMs !== undefined) assertResolution(resolutionMs, ownFlushMs)

  const attempts = createAttempts()
  let binding: MetricBinding | undefined

  function active(): MetricBinding {
    if (!binding) {
      throw new Error(
        `${name}: not bound to a house. Pass it to createHouse({ schema }) before writing`,
      )
    }
    return binding
  }

  function flushMs(from: MetricBinding | undefined = binding): number {
    const ms = ownFlushMs ?? from?.defaults?.flushMs
    if (ms === undefined) {
      throw new Error(
        `${name}: no flush cadence. Declare flush on the ${kind}, or defaults.flush on the house`,
      )
    }
    return ms
  }

  return {
    resolutionMs,
    attempts,

    isBound(): boolean {
      return binding !== undefined
    },

    active,

    driver(): Driver {
      return active().driver
    },

    now(): number {
      return (active().now ?? Date.now)()
    },

    flushMs,

    graceMs(): number {
      return ownGraceMs ?? binding?.defaults?.graceMs ?? DEFAULT_GRACE_MS
    },

    bind(next: MetricBinding): void {
      if (binding) {
        throw new Error(`${name}: already bound to a house, and a metric belongs to exactly one`)
      }
      // the half of validation that could not run at declare time: a cadence
      // taken from the house is only knowable now, and createHouse is still
      // early enough to be a boot failure rather than a surprise at flush.
      // Checked before the binding is kept, so a refusal leaves the metric
      // free to be registered again once the mistake is fixed
      if (ownFlushMs === undefined) assertResolution(resolutionMs, flushMs(next))
      binding = next
    },

    unbind(): void {
      binding = undefined
    },

    // chained onto the driver write rather than racing it: the fold has to
    // include the write that triggered the send, or the sink is told a value
    // that is already stale by one
    deliver(write: Promise<void>, bucketTs: number, dimKey: string): Promise<void> {
      if (binding?.delivery !== 'immediate') return write
      return write.then(() =>
        shipOpenSeries({
          metric: name,
          kind,
          resolutionMs,
          driver: active().driver,
          bucketTs,
          dimKey,
          materialize,
          totalOf,
          sink,
          attempts,
        }),
      )
    },
  }
}

/**
 * The read half, for a kind whose live data is buckets.
 *
 * Generic in the dims and in the value columns the kind adds, so a counter's
 * snapshot returns rows with `park: string` and `value: number` rather than
 * `unknown` per key. The erased {@link AnyMetric.snapshot} stays as it is.
 * This narrows it, which is legal precisely because a typed row is still a
 * {@link LiveRow}.
 */
export type BucketedReader<D extends Shape, V> = TypedSnapshot<D, V>

export interface BucketedReaderOptions {
  readonly name: string
  readonly resolutionMs: number
  /** Declared dims, for validating a `dims` filter and a `groupBy`. */
  readonly dims: Shape
  /** Read late, not captured: a metric is declared before it is bound. */
  readonly driver: () => Driver
  readonly now: () => number
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly mergeValues: MergeValues
}

/**
 * What the built in kinds pass on top of {@link BucketedReaderOptions}.
 *
 * `assertCell` throws what `materialize` throws for a cell of the wrong kind.
 * With it, a snapshot filtered by `dims` checks the cells of rows the filter
 * drops rather than building them, and still fails on the same cell with the
 * same error. Without it every row is built, as before.
 */
interface BucketedReaderInternals extends BucketedReaderOptions {
  readonly assertCell?: (cell: Cell) => void
}

/**
 * Live read for a bucketed kind.
 *
 * The sibling of {@link bucketedLifecycle}: that one is the write path's shared
 * half, this one is the read path's. Both exist so a third aggregate kind
 * supplies what is actually different about it, how a cell becomes a row, and
 * how two of them merge, and inherits everything else.
 *
 * The clock is read once per call and passed down, so every row in one snapshot
 * agrees about which bucket is open. Reading it per row would let a snapshot
 * that straddles a boundary report two different answers about the same window.
 */
export function bucketedReader<D extends Shape, V>(
  options: BucketedReaderInternals,
): BucketedReader<D, V> {
  const { name, resolutionMs, dims, driver, now, materialize, mergeValues, assertCell } = options
  const decodeKey = dimKeyDecoder(dims)

  /**
   * Build the rows a `dims` filter keeps, and only those.
   *
   * Building a row hashes its id, which costs several times what reading its
   * dims back from the key does, and a filter over a metric with many series
   * keeps few of them. A kept row still goes through `applySnapshot`, which
   * checks the filter's names and matches it again, so the answer and every
   * error are what building every row gave. Rows are visited in order, and a
   * row whose key cannot be read is built anyway, so the first bad row throws
   * exactly what it threw before.
   */
  function built(live: readonly BucketRow[], filter: object | undefined): BucketedRow[] {
    const wanted = filter !== undefined && filter !== null ? Object.entries(filter) : undefined
    const out: BucketedRow[] = []
    for (const one of live) {
      if (wanted !== undefined && assertCell !== undefined) {
        let values: Record<string, unknown> | undefined
        try {
          values = decodeKey(one.dimKey)
        } catch {
          // left to `materialize` below, which throws what it always threw
        }
        if (
          values !== undefined &&
          !wanted.every(([key, value]) => sameValue(values[key], value))
        ) {
          assertCell(one.value)
          continue
        }
      }
      out.push({ bucketTs: one.bucketTs, row: materialize(one.bucketTs, one.dimKey, one.value) })
    }
    return out
  }

  // the one cast: `applySnapshot` works in erased rows because filtering and
  // merging are the same work whatever the columns are called, and the kind
  // supplies the type that says what they are. Casting here rather than at each
  // of the three call sites keeps it to one place that can be checked.
  const reader = {
    async snapshot(snapshotOptions: SnapshotOptions = {}): Promise<LiveRow[]> {
      const nowMs = now()
      const range = snapshotRange(snapshotOptions, resolutionMs, nowMs, name)

      const live = await driver().readBuckets({ metric: name, ...range })

      return applySnapshot(built(live, snapshotOptions.dims), snapshotOptions, {
        metric: name,
        dims,
        resolutionMs,
        nowMs,
        mergeValues,
      })
    },
  }

  return reader as unknown as BucketedReader<D, V>
}

/** The five {@link AnyMetric} methods that move a batch. */
export type BatchLifecycle = Pick<
  AnyMetric,
  'recoverBatch' | 'claimBatch' | 'materializeClaim' | 'ackBatch' | 'releaseBatch'
>

export interface BucketedOptions {
  readonly name: string
  readonly resolutionMs: number
  /**
   * Read late, not captured: grace may come from the house, and a metric is
   * declared before it is bound.
   */
  readonly graceMs: () => number
  /** Read late, not captured: a metric is declared before it is bound. */
  readonly driver: () => Driver
  readonly materialize: (bucketTs: number, dimKey: string, cell: Cell) => Row
  readonly totalOf: (rows: readonly Row[]) => number
}

export function bucketedLifecycle(options: BucketedOptions): BatchLifecycle {
  const { name, resolutionMs, graceMs, driver, materialize, totalOf } = options

  /**
   * A bucketed metric can only ever be handed back the claim it asked for. A
   * record claim here means a driver returned the wrong storage model, which
   * would otherwise surface as rows silently missing from a flush.
   */
  function assertBuckets(claim: Claim): asserts claim is Extract<Claim, { kind: 'buckets' }> {
    if (!isBucketClaim(claim)) {
      throw new Error(`${name}: expected a bucket claim but the driver returned staged records`)
    }
  }

  return {
    async recoverBatch(): Promise<RecoveryReport> {
      return driver().recover(name)
    },

    async claimBatch(nowMs: number, claimOptions: ClaimOptions = {}): Promise<Claim> {
      return driver().claim(name, claimWatermark(resolutionMs, nowMs, graceMs, claimOptions))
    },

    materializeClaim(claim: Claim): MaterializedBatch {
      assertBuckets(claim)

      const rows: Row[] = []
      for (const bucket of claim.buckets) {
        for (const [dimKey, cell] of bucket.values) {
          rows.push(materialize(bucket.bucketTs, dimKey, cell))
        }
      }

      const first = claim.buckets[0]?.bucketTs ?? 0
      const last = claim.buckets.at(-1)?.bucketTs ?? 0

      return {
        rows,
        bucketFrom: first,
        // one resolution past the newest bucket, because the window is half-open
        bucketTo: last + resolutionMs,
        total: totalOf(rows),
        buckets: claim.buckets.length,
      }
    },

    async ackBatch(claim: Claim): Promise<void> {
      await driver().ack(claim)
    },

    async releaseBatch(claim: Claim): Promise<void> {
      await driver().release(claim)
    },
  }
}
