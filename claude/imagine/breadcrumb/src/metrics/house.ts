/**
 * Serverless wiring. Every assumption the spec makes about a runtime is false
 * in this file.
 */
import { createHouse } from 'metrichouse'
import * as schema from './schema'
import { ch } from '../lib/clickhouse'

/**
 * FLAW B03 — `createHouse` assumes a connected client at module scope.
 *
 * initialPlan/08-house.md opens with:
 *
 *   const client = createClient({ url: process.env.REDIS_URL })
 *   await client.connect()
 *   export const house = createHouse({ driver: redis(client), schema })
 *
 * Three problems here:
 *
 *  1. Top-level `await` plus a TCP socket does not run on the edge runtime at
 *     all — Cloudflare Workers and Vercel Edge have no `net`. The only Redis
 *     available is HTTP (Upstash REST), and there is no HTTP driver.
 *  2. `createHouse` is "safe to call at module scope" because it opens no
 *     connections of its own — but the *caller* must, and module scope runs on
 *     every cold start. At Breadcrumb's traffic that is a few thousand Redis
 *     handshakes an hour that do nothing but exist.
 *  3. There is no `ping()`-on-first-use or lazy connect, so a cold start pays
 *     the handshake before the first `.add()` even if the request never emits
 *     a metric.
 *
 * Workaround: a hand-rolled HTTP driver over Upstash REST, and a module-level
 * singleton that is created lazily and reused across warm invocations.
 */
import { upstashDriver } from '../lib/upstash-driver'   // ~140 lines we should not own

let _house: ReturnType<typeof createHouse> | undefined

export function getHouse() {
  return (_house ??= createHouse({
    driver: upstashDriver({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    }),
    schema,
    namespace: 'breadcrumb',

    // FLAW B04 — the microtask coalescing window buys nothing here and costs
    // correctness. One request emits three or four writes; there is nothing to
    // coalesce, and deferring them to the end of the tick is precisely how they
    // get lost (see B01). Breadcrumb wants `writeMode: 'immediate'` and there
    // is no such option.

    write: async (rows, ctx) => ch.insert(ctx.metric, rows),

    onError: (err, ctx) => console.error(`[mh] ${err.code} ${ctx.metric}`, err.message),
  }))
}

// The #12 fix still pays off — two constants, declared once, never repeated.
export function bindRequest(site: string) {
  getHouse().bind({ site, env: process.env.VERCEL_ENV === 'production' ? 'production' : 'preview' })
}
