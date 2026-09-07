/**
 * Ship-side gateway.
 *
 * One box per vessel, aggregating ~200 containers over a local mesh, with
 * satellite uplink measured in kilobytes per hour. It runs a MetricHouse of
 * its own on the memory driver and syncs when there is bandwidth.
 */
import { createHouse, memory } from 'metrichouse'
import * as schema from '../metrics/schema'
import { doorsOpen } from '../metrics/schema'

export const edgeHouse = createHouse({
  driver: memory({ maxSeries: 5_000, maxBuckets: 20_000 }),
  schema,
  strict: false,

  // FLAW C03 — the sink is the only way out, and it hands you rows in a shape
  // no MetricHouse can accept back. So the edge either re-implements the wire
  // format or writes to the cloud database directly, from a ship, over
  // satellite, with credentials on a box in a container yard.
  //
  // What this wants to be:
  //   write: async (rows, ctx) => uplink.post('/ingest', { metric: ctx.metric, rows })
  //   ...and on the other end: await house.ingest(ctx.metric, rows)
  //
  // The rows are already correct — deterministic ids, folded aggregates, right
  // shape for the table. A retried uplink converges, which is the #14 identity
  // design working perfectly across a network boundary it was never designed
  // for. The only missing piece is an entry point.
  write: async (rows, ctx) => uplink.post('/ingest', { metric: ctx.metric, rows }),
})

edgeHouse.bind({
  fleet: process.env.FLEET_ID!,
  region: 'at-sea',
  firmware: process.env.GATEWAY_FW!,
})

/**
 * FLAW C07 — a level's running total is process-local on the memory driver,
 * so every gateway reboot resets `doors_open` to zero for 200 containers.
 *
 * initialPlan/20-level.md says this plainly, which is good. But a gateway on a
 * ship reboots on brownouts, and there is no `restoreTotals()` to seed the
 * levels from the last known state. The single-process production use case the
 * memory driver was blessed for is exactly the one where this hurts.
 */
export async function onBoot() {
  const last = await loadPersistedLevels()
  for (const [containerId, n] of Object.entries(last)) {
    doorsOpen.set(n, { containerId })   // manual restore, hand-persisted
  }
}

/**
 * Flushing is bandwidth-shaped, not time-shaped. The explicit-flush decision
 * pays off here more than anywhere: no timer would have got this right.
 */
export async function syncWhenPossible() {
  if (!(await uplink.available())) return

  const budgetBytes = await uplink.budget()
  await edgeHouse.flush({
    force: true,
    rowBatch: Math.floor(budgetBytes / 180),   // the #07 fix, used for a reason
    yieldBetweenBatches: true,
    signal: uplink.abortSignal(),
  })
}

declare const uplink: {
  post(path: string, body: unknown): Promise<void>
  available(): Promise<boolean>
  budget(): Promise<number>
  abortSignal(): AbortSignal
}
declare function loadPersistedLevels(): Promise<Record<string, number>>
