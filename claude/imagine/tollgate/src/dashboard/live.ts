/**
 * Live dashboard endpoints — the feature that motivated MetricHouse, built
 * against it for real.
 */
import { requests, tokens, latency, inFlight, costMicroUsd } from '../metrics/schema'
import { house } from '../metrics/house'
import { ch } from '../lib/clickhouse'

/**
 * FLAW 11 — the open bucket is always an undercount, and nothing says so.
 *
 * `requests` has resolution '10s'. A dashboard polling at an arbitrary moment
 * reads a bucket that is, on average, half full. Rendered as "requests in the
 * last 10s" it is wrong by ~50%; rendered as a rate it is wrong by however far
 * into the bucket the poll landed. The chart sawtooths — every series dips at
 * the start of each bucket and recovers, which reads as a real traffic
 * pattern and is not one.
 *
 * The row carries `bucket_ts` but no elapsed fraction and no "is this bucket
 * open" flag, so the caller cannot correct for it without recomputing the
 * boundary from the resolution — which means the dashboard has to know each
 * metric's resolution, defeating the point of declaring it once.
 *
 * Tollgate's workaround: drop the open bucket and show the last closed one.
 * This makes the live number up to 10 seconds stale — for a feature whose
 * entire purpose was to not be stale.
 */
export async function liveThroughput(tenantId: string) {
  const buckets = await requests.snapshot({ dims: { tenantId }, rollup: 'none' })

  const RESOLUTION_MS = 10_000                     // hardcoded; see above
  const openBucketTs = Math.floor(Date.now() / RESOLUTION_MS) * RESOLUTION_MS
  const closed = buckets.filter(b => +b.bucket_ts < openBucketTs)

  const latest = closed.at(-1)
  return {
    requestsPerSecond: latest ? latest.value / (RESOLUTION_MS / 1000) : 0,
    asOf: latest?.bucket_ts,
    staleByMs: latest ? Date.now() - +latest.bucket_ts : null,
  }
}

/**
 * FLAW 02 (cont.) — what the latency panel can and cannot show.
 */
export async function liveLatency(tenantId: string) {
  const live = await latency.snapshot({ dims: { tenantId }, rollup: 'sum' })
  const g = live[0]

  return {
    // available now, from the gauge
    min: g?.min,
    max: g?.max,
    avg: g ? g.sum / g.count : undefined,
    count: g?.count,

    // NOT available now. p95 requires the raw events, and staged events are
    // opaque to live read — `peek()` returns them but only for the local
    // instance's memory batch, and `latency` events are redis-staged, so
    // there is no in-flight percentile at all.
    p95: undefined,
    p99: undefined,

    // The only way to get p95 is the flushed table, which lags by `flush`.
    p95Historical: await ch.query(`
      SELECT quantile(0.95)(latencyMs) FROM request_completed
      WHERE tenantId = {tenantId:String} AND ts >= now() - INTERVAL 5 MINUTE
    `, { tenantId }),
  }
}

/**
 * FLAW 13 — no top-K, no ordering, no limit on live read.
 *
 * The dashboard's default view is "top 20 tenants by spend right now". With
 * 500 tenants x 12 models x 4 kinds, `costMicroUsd.snapshot()` deserializes
 * ~24k series out of Redis to display 20 rows. `snapshot` takes `limit`, but
 * a limit without an ordering is an arbitrary 20.
 */
export async function topSpenders(n = 20) {
  const all = await costMicroUsd.snapshot({ rollup: 'sum' })   // 24k rows over the wire

  const byTenant = new Map<string, number>()
  for (const r of all) {
    byTenant.set(r.tenantId, (byTenant.get(r.tenantId) ?? 0) + r.value)
  }

  return [...byTenant.entries()]
    .map(([tenantId, micros]) => ({ tenantId, usd: micros / 1e6 }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, n)
}

/**
 * FLAW 03 (cont.) — reading the concurrency workaround back out.
 *
 * Because `inFlight` is per-instance last-value, the live number is
 * "sum of each instance's last report in this bucket". If a pod has been
 * quiet for a bucket it contributes nothing, so the total dips whenever a
 * pod is idle — the carry-forward problem, now visible in the UI.
 */
export async function liveConcurrency() {
  const rows = await inFlight.snapshot({ rollup: 'none' })

  const latestPerInstance = new Map<string, number>()
  for (const r of rows.sort((a, b) => +a.bucket_ts - +b.bucket_ts)) {
    latestPerInstance.set(r.instanceId, r.last)
  }
  return [...latestPerInstance.values()].reduce((a, b) => a + b, 0)
}

/**
 * The one that works exactly as advertised.
 */
export async function health() {
  return house.health()
}
