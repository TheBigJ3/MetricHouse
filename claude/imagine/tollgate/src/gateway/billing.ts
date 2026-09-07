/**
 * Monthly invoice generation — the "money" argument for at-least-once.
 */
import { ch } from '../lib/clickhouse'

/**
 * The dedupe story holds, with one caveat the spec does not mention.
 *
 * A duplicated flush produces two rows with identical `id`. ReplacingMergeTree
 * collapses them — eventually. Without FINAL, a SELECT can see both. Tollgate
 * bills monthly off this table, so it must use FINAL, and FINAL on a 12-month
 * partition set is expensive enough that invoicing runs on a replica.
 *
 * FLAW 14 — the generated DDL picks ReplacingMergeTree and sorts on the
 * natural key, which is right, but it has no opinion about the read side.
 * `initialPlan/16-ddl.md` shows `SELECT ... FINAL` in an example and moves on.
 * A gateway billing off these tables needs either an AggregatingMergeTree
 * projection or a scheduled OPTIMIZE, and the DDL generator is the only thing
 * that knows the natural key well enough to emit one.
 */
export async function invoice(tenantId: string, month: string) {
  const rows = await ch.query(`
    SELECT model, kind, sum(value) AS micros
    FROM cost_micro_usd FINAL
    WHERE tenantId = {tenantId:String}
      AND toYYYYMM(bucket_ts) = {month:String}
    GROUP BY model, kind
  `, { tenantId, month })

  return {
    tenantId,
    month,
    // FLAW 01 (cont.) — the unit leaks all the way to the invoice. Every
    // consumer of this table has to divide by 1e6 and know to do it.
    lines: rows.map(r => ({ model: r.model, kind: r.kind, usd: r.micros / 1e6 })),
    totalUsd: rows.reduce((a, r) => a + r.micros, 0) / 1e6,
  }
}

/**
 * Reconciliation: counters vs events.
 *
 * FLAW 04 (cont.) — this query exists only because the fan-out in proxy.ts is
 * unenforced. It compares the aggregated counter against the sampled event
 * stream, scaled by the sampling rate, and alerts when they diverge by more
 * than the sampling error. It is a test for a bug the schema could have made
 * impossible.
 */
export async function reconcile(tenantId: string, day: string) {
  return ch.query(`
    WITH
      counters AS (
        SELECT sum(value) AS n FROM tokens FINAL
        WHERE tenantId = {tenantId:String} AND toDate(bucket_ts) = {day:Date}
          AND kind = 'output'
      ),
      events AS (
        SELECT sum(outputTokens) / 0.05 AS n FROM request_completed
        WHERE tenantId = {tenantId:String} AND toDate(ts) = {day:Date}
          AND status = 'ok'
      )
    SELECT counters.n AS from_counters,
           events.n   AS from_events_scaled,
           abs(counters.n - events.n) / counters.n AS drift
    FROM counters, events
  `, { tenantId, day })
}
