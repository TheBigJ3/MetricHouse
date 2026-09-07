/**
 * The wrapper every route handler uses.
 *
 * It exists entirely because of FLAW B01, which is the blocking finding of this
 * project.
 */
import { getHouse } from '../metrics/house'

/**
 * FLAW B01 — `.add()` is fire-and-forget, and serverless freezes the isolate.
 *
 * initialPlan says writes go "straight to the driver, pipelined" over an
 * event-loop tick, and that `.add()` never throws on the hot path. Both are
 * good decisions for a server. In a serverless function they combine into
 * silent data loss:
 *
 *   export async function POST(req) {
 *     signup.add({ variant })          // queued in the pipeline
 *     return Response.json({ ok: 1 })  // isolate FREEZES here
 *   }                                  // the pipeline never flushes
 *
 * The runtime suspends the isolate the instant the response is returned. Any
 * write still sitting in the coalescing window is discarded, with no error, no
 * warning, and no way to detect it from inside — `onError` never fires because
 * nothing failed, the process simply stopped existing.
 *
 * This is not an edge case. It is every request on Vercel, Cloudflare, Lambda,
 * Deno Deploy, and Netlify — which is where most of the dashboards this library
 * was written for actually run.
 *
 * What is needed: `house.drain(): Promise<void>` resolving when every queued
 * write has reached the driver, so it can be handed to `waitUntil()`. The
 * driver already knows when its pipeline settles; nothing exposes it.
 *
 * The workaround below is a guess. `setTimeout(0)` is not a contract, and on a
 * slow Redis round trip it returns before the write lands.
 */
export async function drain(): Promise<void> {
  // await getHouse().drain()          <-- does not exist
  await new Promise((r) => setTimeout(r, 0))   // hope the pipeline flushed
}

/**
 * Every handler must remember to call this. Forgetting it loses data silently,
 * which makes it exactly the kind of thing that should not be the caller's job.
 */
export function withAnalytics<T>(
  ctx: { waitUntil(p: Promise<unknown>): void },
  fn: () => Promise<T>,
): Promise<T> {
  return fn().finally(() => ctx.waitUntil(drain()))
}
