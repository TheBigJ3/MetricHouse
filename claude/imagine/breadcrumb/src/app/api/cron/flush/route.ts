/**
 * Who calls flush(). A Vercel Cron hits this once a minute.
 *
 * The explicit-flush decision is the single best thing in the spec for this
 * environment — no timer would have survived a runtime with no processes. But
 * the endpoint has a hard ceiling and the flush does not know about it.
 */
import { getHouse } from '../../../../metrics/house'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * FLAW B06 — flush is all-or-nothing against a wall-clock ceiling.
 *
 * `flush()` claims every eligible bucket, ships it, and acks. If the function
 * is killed at 60 seconds mid-write, the claim is left in flight and recovered
 * later via `claimTtl` — the durability design holds, nothing is lost. Good.
 *
 * What is missing is a way to *finish*. A backlog that takes 90 seconds to ship
 * will never complete: every invocation claims the whole thing, runs out of
 * time, releases, and the next one repeats it. The system livelocks while
 * reporting healthy, because each individual flush "failed" cleanly.
 *
 * `rowBatch` limits how much goes to the sink per call but does not bound the
 * claim, so it does not help.
 *
 * Needed: `flush({ deadline })` — claim only what can plausibly ship in the
 * remaining time, ack what shipped, and report `{ complete: false, remaining }`
 * so the next invocation continues rather than restarting.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 })
  }

  const started = Date.now()
  const house = getHouse()

  const report = await house.flush({
    rowBatch: 25_000,
    yieldBetweenBatches: true,
    // deadline: started + 50_000,   <-- does not exist
    signal: AbortSignal.timeout(50_000),
  })

  // Aborting mid-flush releases the claim, so the next cron re-claims the same
  // backlog and hits the same wall. Breadcrumb caps ingest instead, which is
  // the wrong lever.
  return Response.json({
    ok: report.ok,
    ms: Date.now() - started,
    metrics: report.metrics,
  })
}
