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
import { dimKeyDecoder, dimKeyReader } from '../schema/dims.js'
import type { Shape } from '../schema/types.js'
import { assertResolution, bucketStart, closedUpTo } from '../time/buckets.js'
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
import { reportError } from './types.js'

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

/** The stored key of each row a merging snapshot built, see {@link withSeries}. */
const storedSeries = new WeakMap<Row, string>()

/**
 * `row`, remembered as belonging to the series stored under `dimKey`, for
 * {@link seriesKey} to find when a snapshot merges it with others.
 */
export function withSeries(row: Row, dimKey: string): Row {
  storedSeries.set(row, dimKey)
  return row
}

/**
 * Does a snapshot with these options merge rows? Only then does
 * {@link seriesKey} run, so only then are rows given their stored key, which
 * costs a map entry per row.
 */
export function snapshotMerges(options: SnapshotOptions): boolean {
  return (
    (options.rollup !== undefined && options.rollup !== 'none') || options.groupBy !== undefined
  )
}

/**
 * Which series a materialized row belongs to, as one string a Map or a Set
 * can key on: its stored key, for a row a snapshot built.
 *
 * The stored key and not the dim values, because two series can read the
 * same under the current dims. A key stored under an earlier declaration
 * comes back with its values as stored, and one with a segment the current
 * dims have no dim for comes back without it, so its values can match those
 * of a series written since. A row with no stored key recorded falls back to
 * its dim values in declared order.
 */
export function seriesKey(dimNames: readonly string[], row: Row): string {
  return storedSeries.get(row) ?? JSON.stringify(dimNames.map((dim) => row[dim]))
}

/**
 * The decoder a kind reads its rows' dims with.
 *
 * A stored key the current declaration cannot read is reported to the house's
 * `onError` once and its row is built from the stored text, so one such series
 * never stops a flush or a snapshot. With no `onError` set it is not reported.
 */
export function storedKeyReader(
  dims: Shape,
  name: string,
  slot: { active(): MetricBinding },
): (key: string) => Record<string, unknown> {
  return dimKeyReader(dims, name, (error) => {
    const onError = slot.active().onError
    if (onError) reportError(onError, error, { metric: name })
  })
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
  /**
   * Resolve once every immediate send under way when it was called, and aimed
   * at a window at or before `newest`, has finished, however it ended, or
   * has run for one flush interval, whichever comes first. A send that has
   * run that long is given up on and never waited for again. Sends started
   * afterwards, and sends aimed past `newest`, are not waited for.
   */
  sendsSoFar(newest: number): Promise<void>
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
  if (ownFlushMs !== undefined) assertResolution(name, resolutionMs, ownFlushMs)

  const attempts = createAttempts()
  let binding: MetricBinding | undefined
  /**
   * Immediate sends that have not finished and have not been given up on,
   * each with the write before it, the window the write was aimed at, and
   * when the send started, by the host clock that timers run on.
   */
  const sends = new Map<Promise<void>, { readonly aimed: number; readonly started: number }>()

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
      if (ownFlushMs === undefined) assertResolution(name, resolutionMs, flushMs(next))
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
      const sent = write.then(() =>
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
      // the caller reports a failure, so this copy only has to settle
      const settled: Promise<void> = sent.then(
        () => {
          sends.delete(settled)
        },
        () => {
          sends.delete(settled)
        },
      )
      sends.set(settled, { aimed: bucketTs, started: Date.now() })
      return sent
    },

    async sendsSoFar(newest: number): Promise<void> {
      // a send reads the window it aimed at and the ones after it, so one
      // aimed past the newest claimed window cannot hold a claimed total
      //
      // each send is bounded by one flush interval from when it started, so a
      // sink that never answers an immediate send holds up the flushes of
      // that interval and no later one
      const limit = flushMs()
      const at = Date.now()
      const reading: Promise<void>[] = []
      let wait = 0
      for (const [send, { aimed, started }] of sends) {
        if (aimed > newest) continue
        // capped at the limit, in case the host clock stepped back
        const left = Math.min(started + limit - at, limit)
        if (left <= 0) {
          sends.delete(send)
          continue
        }
        reading.push(send)
        wait = Math.max(wait, left)
      }
      if (reading.length === 0) return

      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), wait)
      })
      try {
        const gaveUp = await Promise.race([Promise.all(reading).then(() => false), bound])
        // every send still waiting has run its full interval by now
        if (gaveUp) for (const send of reading) sends.delete(send)
      } finally {
        clearTimeout(timer)
      }
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
  /** Read late, like `driver`: every column a live row can have, for `orderBy`. */
  readonly columns?: () => readonly string[]
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
  /** True when `mergeValues` tells series apart with {@link seriesKey}. */
  readonly mergesBySeries?: boolean
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
  const {
    name,
    resolutionMs,
    dims,
    driver,
    now,
    materialize,
    mergeValues,
    assertCell,
    columns,
    mergesBySeries,
  } = options
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
  function built(
    live: readonly BucketRow[],
    filter: object | undefined,
    keyed: boolean,
  ): BucketedRow[] {
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
      const row = materialize(one.bucketTs, one.dimKey, one.value)
      out.push({ bucketTs: one.bucketTs, row: keyed ? withSeries(row, one.dimKey) : row })
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

      const keyed = mergesBySeries === true && snapshotMerges(snapshotOptions)
      return applySnapshot(built(live, snapshotOptions.dims, keyed), snapshotOptions, {
        metric: name,
        dims,
        resolutionMs,
        nowMs,
        mergeValues,
        ...(columns !== undefined && { columns: columns() }),
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
  /**
   * {@link BucketedBinding.sendsSoFar}, waited for between a claim and its
   * rows reaching the sink, with the newest window the claim took.
   *
   * An immediate send reads a running total and then calls the sink. One
   * that read before the claim and is still on its way would otherwise reach
   * the sink after the flush row, under the same id, and a table keeping the
   * newest row would keep its older total. Sends that start after the claim
   * cannot read the claimed window, so they are not waited for, and nor are
   * sends aimed past every window the claim took.
   */
  readonly sendsSoFar?: (newest: number) => Promise<void>
}

export function bucketedLifecycle(options: BucketedOptions): BatchLifecycle {
  const { name, resolutionMs, graceMs, driver, materialize, totalOf, sendsSoFar } = options

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
      const storage = driver()
      const upTo = claimWatermark(resolutionMs, nowMs, graceMs, claimOptions)
      // the last flush of a process whose storage dies with it also takes
      // the windows ahead of its clock: a write the watermark moved there, or
      // one made before the clock stepped back. Nothing else will ship them.
      // Storage that outlives the process keeps them for a later flush, and
      // leaves the open windows of other processes alone
      const claim =
        claimOptions.final && !storage.capabilities.durable
          ? await storage.claim(name, upTo, bucketStart(nowMs, resolutionMs) + resolutionMs)
          : await storage.claim(name, upTo)
      if (sendsSoFar !== undefined && claim.buckets.length > 0) {
        let newest = Number.NEGATIVE_INFINITY
        for (const bucket of claim.buckets) newest = Math.max(newest, bucket.bucketTs)
        await sendsSoFar(newest)
      }
      return claim
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
