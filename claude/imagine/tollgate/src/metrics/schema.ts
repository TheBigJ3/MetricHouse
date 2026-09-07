/**
 * Tollgate metric schema.
 *
 * Written against MetricHouse as specified in initialPlan/. Every workaround
 * for a gap in that spec is marked `FLAW nn` and explained in FINDINGS.md.
 */
import {
  counter, gauge, event, log,
  str, int, float, oneOf, json,
  defineDefaults,
} from 'metrichouse'
import { ch } from '../lib/clickhouse'

const defaults = defineDefaults({
  resolution: '1s',
  flush: '30s',
  grace: '2s',
})

// FLAW 12 — no shared dims. `defineDefaults` merges resolution/flush/grace but
// not dims, so every metric below re-declares the same four provenance columns
// by hand. This is the cost of rejecting built-in provenance: it did not go
// away, it just moved into userland and has to stay in sync manually.
const provenance = {
  service: str(),
  environment: oneOf(['dev', 'staging', 'prod'] as const),
  region: str(),
  release: str(),
}

// ---------------------------------------------------------------------------
// Requests — the headline live number
// ---------------------------------------------------------------------------

// CARDINALITY, honestly counted (FLAW 05):
//   tenants(500) x models(12) x endpoints(6) x status(5) = 180_000 series
//   at resolution '1s' with flush '30s' that is 30 buckets x 180k = 5.4M rows
//   per flush. Coarsened to '10s' below, which costs the per-second fidelity
//   that motivated the whole project.
export const requests = counter('requests', {
  ...defaults,
  resolution: '10s',
  dims: {
    ...provenance,
    tenantId: str(),
    model: str(),          // FLAW 09 — want LowCardinality without a closed set
    endpoint: oneOf(['chat', 'embed', 'rerank', 'batch', 'files', 'models'] as const),
    status: oneOf(['ok', 'client_error', 'provider_error', 'timeout', 'refused'] as const),
  },
  write: async (rows) => ch.insert('requests', rows),
})

// ---------------------------------------------------------------------------
// Tokens — the billing input
// ---------------------------------------------------------------------------

export const tokens = counter('tokens', {
  ...defaults,
  resolution: '10s',
  flush: '1m',
  dims: {
    ...provenance,
    tenantId: str(),
    model: str(),
    kind: oneOf(['input', 'output', 'cached_read', 'cached_write'] as const),
  },
  write: async (rows) => ch.insert('tokens', rows),
})

// ---------------------------------------------------------------------------
// Cost — money
// ---------------------------------------------------------------------------

// FLAW 01 — no float counter. A single request can cost $0.00042; `counter`
// increments Int64. Storing micro-dollars and dividing by 1e6 in SQL. This is
// lossy below 1e-6 USD, silently truncating, and every reader of the table has
// to know the unit. Redis has HINCRBYFLOAT; this is a spec gap, not a limit.
export const costMicroUsd = counter('cost_micro_usd', {
  ...defaults,
  resolution: '60s',
  flush: '1m',
  dims: {
    ...provenance,
    tenantId: str(),
    model: str(),
    kind: oneOf(['input', 'output', 'cached_read', 'cached_write'] as const),
  },
  write: async (rows) => ch.insert('cost_micro_usd', rows),
})

// ---------------------------------------------------------------------------
// Latency — where dropping histograms actually bites
// ---------------------------------------------------------------------------

// The spec says: derive percentiles from events in SQL. That works for
// history. It does NOT work for the live dashboard, because live read only
// sees counters and gauges — staged events are opaque until they are flushed.
//
// FLAW 02 — no live percentiles. This gauge is the consolation prize: it gives
// the dashboard min/max/avg for the open window and nothing else. p95 for the
// current minute is unavailable at any price.
export const latency = gauge('latency_ms', {
  ...defaults,
  resolution: '10s',
  flush: '30s',
  aggregate: ['min', 'max', 'sum', 'count'],   // `last` is meaningless here
  dims: {
    ...provenance,
    tenantId: str(),
    model: str(),
    endpoint: oneOf(['chat', 'embed', 'rerank', 'batch', 'files', 'models'] as const),
  },
  write: async (rows) => ch.insert('latency_ms', rows),
})

export const timeToFirstToken = gauge('ttft_ms', {
  ...defaults,
  resolution: '10s',
  flush: '30s',
  aggregate: ['min', 'max', 'sum', 'count'],
  dims: { ...provenance, tenantId: str(), model: str() },
  write: async (rows) => ch.insert('ttft_ms', rows),
})

// ---------------------------------------------------------------------------
// In-flight concurrency — the one a gauge cannot express
// ---------------------------------------------------------------------------

// FLAW 03 — no up/down gauge, and no carry-forward.
//
// Concurrency is a level, not a rate. Two problems with the spec'd gauge:
//   1. there is no inc()/dec(); `set(value)` requires the caller to already
//      know the total, which means keeping the count somewhere else anyway
//   2. a bucket with no observations is absent, not "unchanged". A quiet
//      10s window renders as a hole in the chart, not as "still 14 in flight"
//
// Workaround: keep the true count in a module-local integer and `set()` it on
// every transition. This is correct only single-process — with N gateway pods
// each reports its own local view under an instanceId dim, and the dashboard
// has to sum the last value per instance per bucket, which is exactly the
// query a carry-forward gauge would have made unnecessary.
export const inFlight = gauge('in_flight', {
  ...defaults,
  resolution: '1s',
  flush: '30s',
  aggregate: ['last', 'max'],
  dims: {
    ...provenance,
    instanceId: str(),      // forced by the workaround above
    tenantId: str(),
    model: str(),
  },
  write: async (rows) => ch.insert('in_flight', rows),
})

// ---------------------------------------------------------------------------
// Queue depth — a gauge that actually fits
// ---------------------------------------------------------------------------

export const queueDepth = gauge('queue_depth', {
  ...defaults,
  resolution: '1s',
  flush: '30s',
  aggregate: ['last', 'min', 'max', 'sum', 'count'],
  dims: { ...provenance, instanceId: str(), providerPool: str() },
  write: async (rows) => ch.insert('queue_depth', rows),
})

// ---------------------------------------------------------------------------
// Request completion — the drill-down
// ---------------------------------------------------------------------------

// FLAW 04 — every fact below is written twice: once here for drill-down, once
// above as counters for aggregation. There is no way to declare "this event
// also increments these counters", so proxy.ts hand-maintains the fan-out and
// nothing enforces that the two agree. A tenant's event sum and counter sum
// can silently diverge after any edit to proxy.ts.
//
// FLAW 08 — no sampling. At 5k req/s this is 5k rows/s of staged events.
// Tollgate wants `sample: 0.05` for successes and 1.0 for errors; the spec has
// no knob, so proxy.ts does the coin flip by hand and the counters are the
// only unbiased source.
export const requestCompleted = event('request_completed', {
  fields: {
    ...provenance,
    requestId: str(),
    tenantId: str(),
    apiKeyId: str(),
    model: str(),
    endpoint: str(),
    status: str(),
    latencyMs: int(),
    ttftMs: int().optional(),
    inputTokens: int(),
    outputTokens: int(),
    cachedReadTokens: int(),
    costUsd: float(),           // float is fine here — events are not aggregated
    streamed: str(),
    providerRequestId: str().optional(),
    errorCode: str().optional(),
    routing: json<{ pool: string; attempt: number; fallbackFrom?: string }>().optional(),
  },
  stage: 'redis',               // billing evidence — must survive a crash
  flush: '30s',
  write: async (rows) => ch.insert('request_completed', rows),
})

// ---------------------------------------------------------------------------
// Provider attempts — high volume, loss-tolerant
// ---------------------------------------------------------------------------

export const providerAttempt = event('provider_attempt', {
  fields: {
    ...provenance,
    requestId: str(),
    provider: str(),
    model: str(),
    attempt: int(),
    outcome: str(),
    httpStatus: int().optional(),
    retryAfterMs: int().optional(),
  },
  stage: 'memory',              // cheap, and losing a deploy's worth is fine
  batch: { maxSize: 1000, maxAge: '5s' },
  write: async (rows) => ch.insert('provider_attempt', rows),
})

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const gatewayLog = log('gateway_log', {
  fields: {
    ...provenance,
    requestId: str().optional(),
    tenantId: str().optional(),
    provider: str().optional(),
  },
  levels: ['debug', 'info', 'warn', 'error'],
  minLevel: 'info',
  stage: 'memory',
  batch: { maxSize: 500, maxAge: '5s' },
  write: async (rows) => ch.insert('gateway_log', rows),
})
