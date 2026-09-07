/**
 * Bulk upload. A container surfaces after six days at sea and posts its
 * backlog in one request.
 *
 * This is the file where the Tollgate #06 fix meets a workload it was not
 * designed for, and loses.
 */
import { reading, tempC } from '../metrics/schema'
import { house } from '../metrics/house'
import { normalizeClock } from './clock'
import { ch } from '../lib/clickhouse'
import type { DeviceBatch } from './types'

const SIX_DAYS_OF_10S_READINGS = 51_840

/**
 * FLAW C01 — `at:` cannot express backfill, and the failure is silent-ish.
 *
 * initialPlan/07-buckets.md defines four outcomes for a backdated write. The
 * relevant one:
 *
 *   | in a bucket already claimed or flushed
 *   |   -> written to the oldest open bucket, LATE_WRITE warn with the drift
 *
 * That rule is correct for a 40-second stream. For a six-day backlog it is a
 * catastrophe: 51,840 readings spanning six days all collapse into the oldest
 * open bucket, producing one enormous spike at the moment the ship docked and
 * six days of nothing. The data is not lost — it is worse than lost, it is
 * confidently wrong, and it emits 51,840 warnings on the way.
 *
 * `allowLate: 'reject'` is not better. It drops the regulated measurement that
 * the entire product exists to retain.
 *
 * The distinction the spec is missing: **late** and **historical** are not the
 * same thing. A late write is a straggler that belongs in a bucket that has
 * nearly closed. A historical write is data about a period that is finished,
 * already flushed, and never coming back — and it should not go through
 * buckets at all. It should be materialized into rows and handed to the sink
 * directly, with deterministic ids, so it lands in ClickHouse exactly as if it
 * had been flushed on time.
 *
 * What Coldchain wants:
 *
 *   await house.backfill(reading, rows)          // straight to the sink
 *   await house.backfill(tempC, aggregatedRows)  // pre-bucketed, pre-folded
 *
 * What Coldchain does instead: bypass MetricHouse entirely, below.
 */
export async function ingestBacklog(batch: DeviceBatch) {
  const now = Date.now()
  const readings = batch.readings.map(r => normalizeClock(r, batch.receivedAt))

  const [live, historical] = partition(readings, r => now - r.ts < 10_000)

  // The recent tail can go through MetricHouse normally.
  for (const r of live) {
    reading.record(toFields(r, batch), { at: r.ts })
  }

  // FLAW C01 (cont.) — everything older is hand-materialized. This code
  // duplicates, badly, three things MetricHouse already knows how to do:
  // bucket alignment, gauge folding, and deterministic row ids. It will drift
  // from the real implementation the first time either side changes.
  await ch.insert('reading', historical.map(r => ({
    id: fakeDeterministicId(batch.containerId, r.ts, r.sensor),   // not the real hash
    ts: new Date(r.ts),
    ...toFields(r, batch),
  })))

  await ch.insert('temp_c', foldIntoBuckets(historical, 60_000, batch))

  // And the derived counters that `reading.derive` would have written are
  // simply absent for the backfilled range, so `temp_c` and `reading` now
  // disagree for six days out of every voyage.
}

// ---------------------------------------------------------------------------

/**
 * FLAW C03 — no way to hand pre-materialized rows back to a house.
 *
 * Everything above would be unnecessary if a house could accept rows in the
 * shape its own flush produces. That same gap blocks edge federation — see
 * edge/gateway.ts, where a ship-side MetricHouse has perfectly good rows and
 * no way to give them to the cloud one.
 */
export async function ingestFromEdge(metricName: string, rows: unknown[]) {
  // await house.ingest(metricName, rows)   <-- does not exist
  await ch.insert(metricName, rows as any[])   // so the edge writes to the DB itself
}

// ---------------------------------------------------------------------------

function foldIntoBuckets(readings: any[], resolutionMs: number, batch: DeviceBatch) {
  const acc = new Map<string, { sum: number; count: number; min: number; max: number; last: number }>()
  for (const r of readings) {
    const bucket = Math.floor(r.ts / resolutionMs) * resolutionMs
    const key = `${bucket}|${batch.containerId}|${r.sensor}`
    const a = acc.get(key) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity, last: 0 }
    a.sum += r.tempC; a.count++
    a.min = Math.min(a.min, r.tempC); a.max = Math.max(a.max, r.tempC); a.last = r.tempC
    acc.set(key, a)
  }
  return [...acc.entries()].map(([key, a]) => {
    const [bucket, containerId, sensor] = key.split('|')
    return {
      id: fakeDeterministicId(containerId, +bucket, sensor),
      bucket_ts: new Date(+bucket),
      fleet: batch.fleet, region: batch.region, firmware: batch.firmware,
      containerId, sensor, ...a,
    }
  })
}

function fakeDeterministicId(containerId: string, ts: number, sensor: string) {
  return `${containerId}:${ts}:${sensor}`   // not MetricHouse's hash. that is the bug.
}

function partition<T>(xs: T[], p: (x: T) => boolean): [T[], T[]] {
  const a: T[] = [], b: T[] = []
  for (const x of xs) (p(x) ? a : b).push(x)
  return [a, b]
}

declare function toFields(r: any, batch: DeviceBatch): any
