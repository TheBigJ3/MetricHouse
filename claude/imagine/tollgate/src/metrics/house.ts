/**
 * House wiring for Tollgate.
 */
import { createHouse, redis } from 'metrichouse'
import { createClient } from 'redis'
import * as schema from './schema'
import { ch } from '../lib/clickhouse'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

// FLAW 12 (cont.) — these four values are constant for the lifetime of the
// process and belong on every single row, but there is nowhere to put them
// once. Each call site in proxy.ts has to spread `PROVENANCE` into every
// `.add()`. Forgetting it is a type error, which is something, but it is
// four extra properties on every metric call in the codebase.
export const PROVENANCE = {
  service: 'tollgate',
  environment: (process.env.NODE_ENV ?? 'dev') as 'dev' | 'staging' | 'prod',
  region: process.env.FLY_REGION ?? 'iad',
  release: process.env.GIT_SHA ?? 'dev',
} as const

export const INSTANCE_ID = process.env.HOSTNAME ?? `local-${process.pid}`

export const house = createHouse({
  driver: redis(client, {
    namespace: 'tollgate',
    claimTtl: '60s',
    maxPipelineSize: 2000,
  }),
  schema,
  namespace: 'tollgate',

  // No global `write` — every metric has its own table and its own insert.

  strict: process.env.NODE_ENV !== 'production',

  onError: (err, ctx) => {
    console.error(`[metrichouse] ${err.code} ${ctx.metric}`, err.message)
  },
  onWarn: (warn, ctx) => {
    console.warn(`[metrichouse] ${warn.code} ${ctx.metric}`, warn.message)
  },
  onFlush: (report) => {
    if (!report.ok) console.error('[metrichouse] flush degraded', report.metrics)
  },
})

// FLAW 07 — Tollgate runs on Fly with 6 pods and no separate worker tier, so
// something in the request process has to drive the flush. The collector wants
// its own process; a setInterval here means every pod ticks and the Redis lock
// decides. That is fine, but it means `flush()` runs on the same event loop as
// the proxy, and a 5.4M-row flush blocks request handling. There is no
// `concurrency`-equivalent knob for row batching inside a single metric's
// write, and no way to say "yield between buckets".
setInterval(() => {
  void house.flush().catch(() => { /* onError already fired */ })
}, 10_000)

process.on('SIGTERM', async () => {
  await house.flush({ force: true, includeOpen: true })
  await house.close()
})
