/**
 * Fleet dashboard. Mostly a validation that the Tollgate fixes hold.
 */
import { tempC, doorsOpen, reporting, excursionMs } from '../metrics/schema'
import { house } from '../metrics/house'
import { openExcursions } from '../compliance/excursions'

/**
 * The #11 fix, working. `complete` defaults true, so this is the last closed
 * bucket and there is no sawtooth. Nothing had to know the resolution.
 */
export async function fleetTemps(fleet: string) {
  return tempC.snapshot({
    dims: { fleet },
    groupBy: ['region'],
    rollup: 'sum',
  })
}

/**
 * The #13 fix, working. 100,000 series, 20 rows over the wire.
 */
export async function worstContainers(fleet: string, n = 20) {
  return tempC.snapshot({
    dims: { fleet, sensor: 'return' },
    orderBy: 'max',
    direction: 'desc',
    limit: n,
  })
}

/**
 * The #03 addition, working, and doing it across every ingest worker with no
 * instanceId dim and no local Map — which was the entire complaint in Tollgate.
 */
export async function doorsOpenNow(fleet: string) {
  return doorsOpen.current({ fleet })
}

/**
 * `distinct()`, doing the job it was added for.
 */
export async function reportingNow(fleet: string) {
  const seen = await reporting.count({ dims: { fleet } })
  return { reporting: seen, expected: 100_000, silent: 100_000 - seen }
}

/**
 * FLAW C08 — the live view for excursions has to come from process memory,
 * because a counter of completed durations cannot show one in progress.
 * Correct only on a single worker; see compliance/excursions.ts.
 */
export async function excursionsInProgress() {
  return openExcursions()
}

/**
 * FLAW C09 — `metrichouse inspect` and `house.health()` report flush lag but
 * not *ingest* lag, which for this workload is the number that matters. A
 * fleet where 4,000 containers last reported 40 minutes ago is broken; every
 * MetricHouse-level health signal says it is fine, because the writes it did
 * receive were handled promptly.
 */
export async function health() {
  const mh = await house.health()
  const ingest = await ingestLagFromClickHouse()   // hand-written, unavoidable
  return { ...mh, ingest }
}

declare function ingestLagFromClickHouse(): Promise<{ p50Ms: number; stale: number }>
