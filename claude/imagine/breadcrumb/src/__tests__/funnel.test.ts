/**
 * Asserting that a metric fired.
 *
 * FLAW B07 — this works, and it is nobody's idea of a good time.
 *
 * The memory driver has `.dump()`, so the state is reachable and no test-only
 * fake is strictly required. But a test wants to ask "did signup step 2 record
 * once for the treatment variant", and what it gets back is a bucket map keyed
 * by an encoded dim string. Every project writes the helper below, differently.
 *
 * `metric.snapshot()` is closer and works against the memory driver, but it is
 * async, returns unflushed buckets rather than a count, and still needs the
 * dim-matching logic.
 *
 * Recorded because this is the second project to want it (Tollgate's
 * reconcile() is the same wish in a different shape), and because the fix is
 * small: `metric.testValue(dims)` returning a plain number, exported from a
 * `metrichouse/testing` subpath so it never reaches production bundles.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHouse, memory } from 'metrichouse'
import * as schema from '../metrics/schema'
import { funnel } from '../metrics/schema'
import { completeSignup } from '../lib/signup'

let driver: ReturnType<typeof memory>
let house: ReturnType<typeof createHouse>

beforeEach(() => {
  driver = memory()
  house = createHouse({ driver, schema, write: async () => {} })
  house.bind({ site: 'test', env: 'preview' })
})

/** The helper every project reinvents. */
async function valueOf(metric: any, dims: Record<string, string>) {
  const rows = await metric.snapshot({ dims, rollup: 'sum', complete: false })
  return rows.reduce((a: number, r: any) => a + r.value, 0)
}

describe('signup funnel', () => {
  it('records each step once', async () => {
    await completeSignup({ variant: 'treatment' })

    expect(await valueOf(funnel, { flow: 'signup', step: 'started', variant: 'treatment' })).toBe(1)
    expect(await valueOf(funnel, { flow: 'signup', step: 'verified', variant: 'treatment' })).toBe(1)
    expect(await valueOf(funnel, { flow: 'signup', step: 'completed', variant: 'treatment' })).toBe(1)
  })

  it('does not record completion when verification fails', async () => {
    await completeSignup({ variant: 'control', verifyFails: true }).catch(() => {})

    expect(await valueOf(funnel, { flow: 'signup', step: 'completed', variant: 'control' })).toBe(0)
  })
})

/**
 * What this would like to be:
 *
 *   expect(funnel).toHaveRecorded({ flow: 'signup', step: 'completed' }, 1)
 */
