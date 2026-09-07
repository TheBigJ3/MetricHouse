import { counter, distinct, event, str, int, float, oneOf, defineDefaults } from 'metrichouse'
import { ch } from '../lib/clickhouse'

const defaults = defineDefaults({
  resolution: '60s',
  flush: '5m',
  dims: {
    site: str(),
    env: oneOf(['preview', 'production'] as const),
  },
})

/** Funnel stages as dim values on one counter — the 23-patterns.md recipe. */
export const funnel = counter('funnel', {
  ...defaults,
  dims: {
    ...defaults.dims,
    flow: str().lowCardinality(),
    step: str().lowCardinality(),
    variant: str().lowCardinality(),
  },
  write: async (rows) => ch.insert('funnel', rows),
})

export const pageViews = counter('page_views', {
  ...defaults,
  dims: { ...defaults.dims, path: str(), referrerHost: str().optional(), variant: str().lowCardinality() },
  write: async (rows) => ch.insert('page_views', rows),
})

export const revenue = counter('revenue', {
  ...defaults,
  value: float(),
  dims: { ...defaults.dims, plan: str().lowCardinality(), variant: str().lowCardinality() },
  write: async (rows) => ch.insert('revenue', rows),
})

/** Uniques per variant — not derivable from any counter. */
export const activeSessions = distinct('active_sessions', {
  ...defaults,
  of: str(),
  resolution: '5m',
  flush: '5m',
  dims: { ...defaults.dims, variant: str().lowCardinality() },
  write: async (rows) => ch.insert('active_sessions', rows),
})

// FLAW B02 — `stage: 'memory'` is set here and does nothing. Batches drain at
// maxSize/maxAge or on close(); in a serverless isolate none of the three
// happens before the isolate is discarded. It type-checks, it looks right, and
// it silently drops every event.
//
// Breadcrumb ships `stage: 'redis'`, which is correct and costs a network
// round trip per event. The problem is that nothing told us — the wrong config
// is the ergonomic default and fails invisibly.
export const track = event('track', {
  fields: {
    ...defaults.dims,
    sessionId: str(),
    anonymousId: str(),
    userId: str().optional(),
    name: str(),
    path: str(),
    variant: str(),
    referrer: str().optional(),
    // `_ingested_at` is stamped by the driver — the C02 fix, and the only way
    // to tell a client-claimed timestamp from a trusted one.
    clientTs: int(),
  },
  derive: {
    funnel: (e) => [{ dims: { flow: 'signup', step: e.name, variant: e.variant }, value: 1 }],
    active_sessions: (e) => [{ dims: { variant: e.variant }, value: e.sessionId }],
  },
  sample: 1.0,
  stage: 'redis',       // 'memory' would silently lose everything — see above
  flush: '1m',
  write: async (rows) => ch.insert('track', rows),
})
