/**
 * Temperature excursions — the regulated question.
 *
 * "For how many minutes was container X above -15C during voyage Y?"
 */
import { excursionMs, tempC, deviceLog } from '../metrics/schema'
import { ch } from '../lib/clickhouse'

interface Excursion { containerId: string; startedAt: number; threshold: 'above_max' | 'below_min' }

const open = new Map<string, Excursion>()

/**
 * FLAW C04 — time-in-state works, and the live half does not.
 *
 * Accumulating elapsed milliseconds into a counter when an excursion ends is
 * the correct shape, and it needs no new primitive. This is the design's
 * "chef" rule doing its job: duration is derivable from transitions, so
 * MetricHouse should not grow a `stopwatch()` and this file should own it.
 *
 * The gap is that an excursion in progress has contributed nothing. A
 * container that has been at -8C for three hours reads as zero excursion
 * minutes on every dashboard until it recovers — which is precisely when
 * someone needs to see it. The counter is correct and useless in real time.
 *
 * `level()` gets closer: inc on start, dec on end, giving "how many containers
 * are in excursion right now". That is a genuinely useful number and Coldchain
 * ships it. It is not the same as elapsed minutes, and elapsed minutes is what
 * the regulator asks for.
 *
 * Not obviously MetricHouse's problem. Recorded because two different projects
 * would each write this file, slightly differently, and get it slightly wrong.
 */
export function onReading(containerId: string, temp: number, at: number) {
  const key = containerId
  const breached = temp > -15 || temp < -25
  const current = open.get(key)

  if (breached && !current) {
    open.set(key, { containerId, startedAt: at, threshold: temp > -15 ? 'above_max' : 'below_min' })
    return
  }

  if (!breached && current) {
    const elapsed = at - current.startedAt

    // The #06 fix earning its place: the excursion is attributed to when it
    // started, not to when the recovery reading happened to arrive.
    excursionMs.add(elapsed, {
      containerId,
      threshold: current.threshold,
      severity: severityFor(elapsed),
    }, { at: current.startedAt })

    open.delete(key)

    deviceLog.warn('excursion closed', { containerId })
  }
}

/**
 * Excursions still open, for the dashboard the counter cannot serve.
 * Process-local, so this is wrong across N ingest workers — another thing
 * `level()` would fix if elapsed time were expressible as a level.
 */
export function openExcursions(now = Date.now()) {
  return [...open.values()].map(e => ({ ...e, elapsedMs: now - e.startedAt }))
}

function severityFor(ms: number) {
  if (ms > 4 * 3_600_000) return 'critical' as const
  if (ms > 3_600_000) return 'major' as const
  return 'minor' as const
}

/** The regulated report. Straightforward, because the data model is right. */
export async function voyageReport(containerId: string, from: string, to: string) {
  return ch.query(`
    SELECT threshold, severity,
           sum(value) / 60000 AS minutes,
           count()            AS episodes
    FROM excursion_ms FINAL
    WHERE containerId = {containerId:String}
      AND bucket_ts BETWEEN {from:DateTime} AND {to:DateTime}
    GROUP BY threshold, severity
  `, { containerId, from, to })
}
