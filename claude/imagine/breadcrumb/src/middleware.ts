/**
 * Edge middleware — the tightest constraint in the project.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { pageViews } from './metrics/schema'
import { drain } from './lib/analytics'

export const config = { matcher: ['/((?!_next|api).*)'] }

/**
 * FLAW B05 — importing the schema pulls the whole library into an edge bundle.
 *
 * `metrics/schema.ts` imports from `'metrichouse'`, which is one entry point
 * exporting the write path, the DDL generator, the schema differ, the migration
 * renderer, and every driver. Tree-shaking removes some of it; the driver
 * registry and the DDL type maps are reachable from the metric objects
 * themselves and survive.
 *
 * Edge middleware has a hard bundle ceiling and runs on every request to every
 * page. Shipping a SQL DDL generator into it is absurd, and there is no way to
 * avoid it — the package has one entry point.
 *
 * Needed: subpath exports. `metrichouse/core` for declare + write, with
 * `metrichouse/ddl`, `metrichouse/cli`, and each driver behind its own
 * specifier, so an edge bundle carries only what it calls.
 */

/**
 * FLAW B09 — no local buffer means Redis latency is request latency.
 *
 * "Straight to the driver, pipelined, no local buffer" assumes Redis is next to
 * the app. This middleware runs in 18 regions; Upstash global replication helps
 * reads but writes still cross an ocean. A page view in Sydney against a
 * primary in Virginia adds ~230 ms to a request whose entire budget is 300 ms.
 *
 * Tollgate never found this because it was single-region and Redis was a
 * sidecar. It is a direct consequence of a decision that was correct for that
 * shape and is wrong for this one.
 *
 * The interesting part is that the fix already exists: a regional house whose
 * `write()` posts to a central `house.ingest()` — the C03 federation path,
 * arriving from a completely different direction. What is missing is a
 * `region` concept so a house knows which Redis is local.
 */
export function middleware(req: NextRequest) {
  const variant = req.cookies.get('ab')?.value ?? 'control'

  pageViews.add({
    path: new URL(req.url).pathname,
    referrerHost: hostOf(req.headers.get('referer')),
    variant,
  })

  const res = NextResponse.next()

  // Middleware has no `waitUntil` in the stable Next.js API, so this write is
  // the least reliable in the codebase. It usually lands. "Usually" is the
  // finding.
  void drain()

  return res
}

function hostOf(referer: string | null) {
  try { return referer ? new URL(referer).host : undefined } catch { return undefined }
}
