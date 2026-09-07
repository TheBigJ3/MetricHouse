/**
 * Browser-origin events. The client posts a batch; this validates and records.
 */
import { track } from '../../../metrics/schema'
import { bindRequest, getHouse } from '../../../metrics/house'
import { drain } from '../../../lib/analytics'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const body = await req.json()
  bindRequest(body.site)

  for (const e of body.events.slice(0, 100)) {
    // The client's timestamp is a claim, not a fact — exactly Coldchain's C02,
    // arriving from a browser instead of a reefer controller. `_ingested_at` is
    // stamped by the driver, so the audit question is answerable without
    // Breadcrumb inventing a column name for it. This fix held.
    track.record({
      sessionId: e.sessionId,
      anonymousId: e.anonymousId,
      userId: e.userId,
      name: e.name,
      path: e.path,
      variant: e.variant,
      referrer: e.referrer,
      clientTs: e.ts,
    })
  }

  // FLAW B01 (cont.) — without this the batch is lost. Node runtime on Vercel
  // gives us `waitUntil` via the response; edge does not always.
  await drain()

  return Response.json({ accepted: body.events.length })
}
