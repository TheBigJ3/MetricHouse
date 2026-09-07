/**
 * Per-tenant hourly quota.
 *
 * This is the file where MetricHouse does not work, and the reason is a
 * deliberate design decision rather than an oversight.
 */
import { createClient } from 'redis'
import { tokens } from '../metrics/schema'
import { ch } from '../lib/clickhouse'

/**
 * FLAW 10 — "delete on ack" makes MetricHouse unusable as a rate-limit source.
 *
 * A quota is "tokens consumed by this tenant in the last hour". MetricHouse
 * holds:
 *
 *   live read   →  only what is unflushed. `tokens` flushes every 1m, so this
 *                  is at most 60 seconds of data.
 *   ClickHouse  →  everything older, but it is a network round trip and, on
 *                  ReplacingMergeTree, requires FINAL to be exact.
 *
 * Neither is an hour. Stitching them means one live read plus one analytical
 * query on the hot path of every request, and the seam between them moves
 * every time a flush lands — a request arriving mid-flush can see a bucket in
 * neither source, or in both.
 *
 * What would fix it: the `retention` knob that was considered and dropped.
 * Keeping flushed buckets in Redis under a TTL would make the last hour a
 * single local read, which is exactly the shape a quota check needs.
 */
export async function checkQuotaViaMetricHouse(tenantId: string) {
  const live = await tokens.snapshot({ dims: { tenantId }, rollup: 'sum' })

  const historical = await ch.query(`
    SELECT sum(value) AS used FROM tokens FINAL
    WHERE tenantId = {tenantId:String}
      AND bucket_ts >= now() - INTERVAL 1 HOUR
  `, { tenantId })

  // Double-counts any bucket that flushed between these two calls, and misses
  // any bucket that was claimed-but-not-acked during the first one. For a
  // number that gates a customer's traffic, "approximately" is not a value.
  return sum(live) + historical.used
}

/**
 * What Tollgate actually ships: a second, parallel counter in raw Redis, with
 * its own key layout, its own TTL, and its own bug surface.
 *
 * This is the failure mode worth naming. The project set out to have one
 * metrics system and ended up with two, because the first one deletes its
 * data the moment it becomes durable.
 */
const redis = createClient({ url: process.env.REDIS_URL })

export async function checkQuota(tenantId: string, limit: number) {
  const hour = Math.floor(Date.now() / 3_600_000)
  const key = `quota:${tenantId}:${hour}`

  const used = Number(await redis.get(key) ?? 0)
  return { allowed: used < limit, used, limit }
}

export async function chargeQuota(tenantId: string, n: number) {
  const hour = Math.floor(Date.now() / 3_600_000)
  const key = `quota:${tenantId}:${hour}`

  await redis.incrBy(key, n)
  await redis.expire(key, 7200)
}

function sum(rows: Array<{ value: number }>) {
  return rows.reduce((a, r) => a + r.value, 0)
}
