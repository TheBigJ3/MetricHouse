/**
 * The request path. Every metric write in Tollgate happens here or in the
 * stream handler below.
 */
import {
  requests, tokens, costMicroUsd, latency, timeToFirstToken,
  inFlight, requestCompleted, providerAttempt, gatewayLog,
} from '../metrics/schema'
import { PROVENANCE, INSTANCE_ID } from '../metrics/house'
import { priceFor } from './pricing'
import type { GatewayRequest, ProviderResult } from './types'

// FLAW 03 (cont.) — the workaround for having no up/down gauge. MetricHouse
// cannot hold a level, so Tollgate holds it and reports it. Keyed by
// tenant+model because that is the dim set on the gauge; the map is unbounded
// in exactly the way the metric's cardinality is, and nothing cleans it up.
const inFlightByKey = new Map<string, number>()

function bumpInFlight(tenantId: string, model: string, delta: 1 | -1) {
  const key = `${tenantId}|${model}`
  const next = (inFlightByKey.get(key) ?? 0) + delta
  if (next <= 0) inFlightByKey.delete(key)
  else inFlightByKey.set(key, next)

  inFlight.set(Math.max(next, 0), {
    ...PROVENANCE, instanceId: INSTANCE_ID, tenantId, model,
  })
}

export async function handle(req: GatewayRequest): Promise<Response> {
  const startedAt = Date.now()
  bumpInFlight(req.tenantId, req.model, 1)

  try {
    const result = await callProvider(req)
    record(req, result, startedAt)
    return result.response
  } finally {
    bumpInFlight(req.tenantId, req.model, -1)
  }
}

// ---------------------------------------------------------------------------

function record(req: GatewayRequest, result: ProviderResult, startedAt: number) {
  const latencyMs = Date.now() - startedAt
  const base = { ...PROVENANCE, tenantId: req.tenantId, model: req.model }

  // FLAW 04 (cont.) — the fan-out. Six writes describing one fact, kept in
  // agreement by hand. Adding a token kind means editing this function and
  // three declarations in schema.ts and hoping nobody misses one.

  requests.add({ ...base, endpoint: req.endpoint, status: result.status })

  tokens.add(result.usage.input,       { ...base, kind: 'input' })
  tokens.add(result.usage.output,      { ...base, kind: 'output' })
  tokens.add(result.usage.cachedRead,  { ...base, kind: 'cached_read' })
  tokens.add(result.usage.cachedWrite, { ...base, kind: 'cached_write' })

  // FLAW 01 (cont.) — micro-dollars. priceFor() returns a float USD amount;
  // rounding here is the only place the truncation is visible, and it is
  // per-request, so the error accumulates in the tenant's favour or against
  // them depending on the rounding mode. For a billing number that is not a
  // detail, it is the whole argument.
  for (const kind of ['input', 'output', 'cached_read', 'cached_write'] as const) {
    const usd = priceFor(req.model, kind, result.usage)
    if (usd > 0) costMicroUsd.add(Math.round(usd * 1e6), { ...base, kind })
  }

  latency.set(latencyMs, { ...base, endpoint: req.endpoint })
  if (result.ttftMs != null) timeToFirstToken.set(result.ttftMs, base)

  // FLAW 08 (cont.) — hand-rolled sampling, because the spec has none. Errors
  // are always kept, successes are sampled at 5%. Nothing in the row says it
  // was sampled, so every query over this table has to know the rate out of
  // band and multiply. A `sample` config would put the rate on the row.
  const keep = result.status !== 'ok' || Math.random() < 0.05
  if (keep) {
    requestCompleted.record({
      ...PROVENANCE,
      requestId: req.id,
      tenantId: req.tenantId,
      apiKeyId: req.apiKeyId,
      model: req.model,
      endpoint: req.endpoint,
      status: result.status,
      latencyMs,
      ttftMs: result.ttftMs,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cachedReadTokens: result.usage.cachedRead,
      costUsd: result.costUsd,
      streamed: String(req.stream),
      providerRequestId: result.providerRequestId,
      errorCode: result.errorCode,
      routing: result.routing,
    })
  }

  if (result.status !== 'ok') {
    gatewayLog.error(`request failed: ${result.errorCode}`, {
      ...PROVENANCE, requestId: req.id, tenantId: req.tenantId,
      provider: result.provider,
    })
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * FLAW 06 — no backdating. A streamed chat completion runs for 40 seconds. The
 * tokens were produced across that whole window, and every one of them lands
 * in whatever bucket happens to be open when the stream *finishes*. On a
 * 10-second resolution that is four empty buckets and one spike, for every
 * long request. The per-second fidelity the design protects so carefully is
 * destroyed at the call site by the absence of an `at:` parameter.
 *
 * The obvious workaround — emit per-chunk — is worse: it multiplies the write
 * volume by the token count and still cannot attribute a chunk to the instant
 * it was produced if the event loop is behind.
 */
export async function handleStream(req: GatewayRequest) {
  const startedAt = Date.now()
  bumpInFlight(req.tenantId, req.model, 1)

  let firstTokenAt: number | undefined
  let outputTokens = 0

  try {
    for await (const chunk of streamFromProvider(req)) {
      firstTokenAt ??= Date.now()
      outputTokens += chunk.tokens

      // What Tollgate wants and cannot write:
      //
      //   tokens.add(chunk.tokens, { ...base, kind: 'output' }, { at: chunk.emittedAt })
      //
      // What it must write instead: nothing here, and one lump at the end.
    }
  } finally {
    bumpInFlight(req.tenantId, req.model, -1)
  }

  const base = { ...PROVENANCE, tenantId: req.tenantId, model: req.model }
  tokens.add(outputTokens, { ...base, kind: 'output' })      // all in one bucket
  latency.set(Date.now() - startedAt, { ...base, endpoint: req.endpoint })
  if (firstTokenAt) timeToFirstToken.set(firstTokenAt - startedAt, base)
}

// ---------------------------------------------------------------------------

async function callProvider(req: GatewayRequest): Promise<ProviderResult> {
  let attempt = 0
  for (const provider of poolFor(req.model)) {
    attempt++
    const outcome = await tryProvider(provider, req)

    providerAttempt.record({
      ...PROVENANCE,
      requestId: req.id, provider, model: req.model, attempt,
      outcome: outcome.kind,
      httpStatus: outcome.httpStatus,
      retryAfterMs: outcome.retryAfterMs,
    })

    if (outcome.kind === 'ok') return outcome.result
  }
  throw new Error('all providers exhausted')
}

declare function tryProvider(provider: string, req: GatewayRequest): Promise<any>
declare function streamFromProvider(req: GatewayRequest): AsyncIterable<{ tokens: number; emittedAt: number }>
declare function poolFor(model: string): string[]
