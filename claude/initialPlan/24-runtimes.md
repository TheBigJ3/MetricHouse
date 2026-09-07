# Runtimes

MetricHouse writes go straight to the driver and never block the caller, which is correct on a server and dangerous in a runtime that can stop existing between two statements. This file is the contract for where the library runs, and it is the only part of the spec that has broken under every new deployment shape.

> Added after [Breadcrumb](../imagine/breadcrumb/FINDINGS.md) — flaws B01–B06. A serverless isolate freezes the instant a response is returned, discarding any write still in the coalescing window, with no error and no way to detect it from inside.

## Main functions

**Draining**
- `house.drain(): Promise<void>` — resolves when every queued write has reached the driver; hand it to `waitUntil()`
- `house.drain({ timeout })` — reject rather than hang if the driver is unreachable
- `metric.drain()` — one metric, for a hot path that wants to await only what it wrote

**Declaring the runtime**
- `createHouse({ runtime })` — `'server'` (default) | `'serverless'` | `'edge'`; detected from `process.env.VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `Deno.env`, and the Cloudflare Workers global when omitted
- `createHouse({ writeMode })` — `'microtask'` (default) coalesces over an event-loop tick; `'immediate'` issues each write as it is made, trading latency for the coalescing window

**Bounded flush**
- `house.flush({ deadline })` — claim only what can plausibly ship before this timestamp; see [12-flush.md](12-flush.md)

## What `runtime` changes

Declaring `'serverless'` or `'edge'` is not a hint, it is a set of refusals:

| | `'server'` | `'serverless'` / `'edge'` |
| --- | --- | --- |
| `writeMode` default | `'microtask'` | `'immediate'` |
| `stage: 'memory'` on an event | allowed | **rejected at declare time** |
| memory driver | allowed | **rejected**, unless the house is explicitly marked ephemeral |
| `setInterval`-driven collector | supported | unsupported, and says so |
| `close()` on `SIGTERM` | expected | never runs; `drain()` is the only guarantee |

The refusals matter more than the defaults. `stage: 'memory'` in a serverless
function type-checks, reads as the sensible performance choice, and silently
discards every event — batches drain at `maxSize`, at `maxAge`, or on `close()`,
and none of the three ever happens. A declare-time error is the difference
between a footgun and a config.

## Platform matrix

| Platform | Drain hook | TCP Redis | Notes |
| --- | --- | --- | --- |
| Vercel Functions (Node) | `waitUntil` | yes | `maxDuration` caps flush; use `deadline` |
| Vercel Edge / Middleware | partial | **no** | middleware has no stable `waitUntil`; least reliable context |
| Cloudflare Workers | `ctx.waitUntil` | **no** | use [`httpRedis()`](10-driver-redis.md) |
| AWS Lambda | none — await before returning | yes | `drain()` before the handler resolves |
| Deno Deploy | none | **no** | await `drain()` |
| Long-lived Node | not needed | yes | `close()` on `SIGTERM` covers it |

"No TCP Redis" means the only backend available is HTTP — see `httpRedis()`.

## In use

```ts
// metrics/house.ts
import { createHouse, httpRedis } from 'metrichouse/core'
import * as schema from './schema'

let _house: House | undefined

export function getHouse() {
  return (_house ??= createHouse({
    runtime: 'serverless',          // detected anyway; explicit is better
    driver: httpRedis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    }),
    schema,
    write: async (rows, ctx) => ch.insert(ctx.metric, rows),
  }))
}
```

```ts
// app/api/signup/route.ts
import { after } from 'next/server'
import { getHouse } from '@/metrics/house'
import { funnel } from '@/metrics/schema'

export async function POST(req: Request) {
  funnel.add({ flow: 'signup', step: 'completed', variant })

  after(getHouse().drain())          // the write is now guaranteed
  return Response.json({ ok: true })
}
```

```ts
// Lambda — no waitUntil, so await it
export const handler = async (event) => {
  funnel.add({ flow: 'signup', step: 'completed', variant })
  const res = buildResponse(event)
  await getHouse().drain({ timeout: 500 })
  return res
}
```

Declaring a lossy configuration now fails loudly instead of quietly:

```ts
event('track', { stage: 'memory', /* … */ })
// throws at declare time:
//   STAGE_UNSAFE — track: stage 'memory' cannot be drained under runtime
//   'serverless'. Memory batches ship at maxSize, maxAge, or close(), none of
//   which occur before an isolate is discarded. Use stage: 'redis'.
```
