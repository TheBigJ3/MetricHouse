/**
 * The memory driver.
 *
 * Most of what this driver must do lives in `contract.ts` and is shared with
 * every other backend — see that file for why. What stays here is the part
 * memory is *allowed* to differ on: it is the only driver that caps series and
 * staged records, because it is the only one with no server to watch it.
 */

import { describe, expect, it } from 'vitest'
import { describeDriverContract } from './contract.js'
import { memory } from './memory.js'

describeDriverContract('memory', {
  make: () => memory(),
  capabilities: { durable: false, shared: false, atomicMerge: true },
})

const M = 'dog_poops'

describe('memory · maxStaged', () => {
  const one = (id: string) => ({ metric: M, id, ts: 1000, fields: {} })

  it('refuses an append past the cap', async () => {
    const capped = memory({ maxStaged: 2 })
    await capped.append([one('a'), one('b')])
    await expect(capped.append([one('c')])).rejects.toThrow(/maxStaged/)
  })

  it('refuses a whole batch rather than staging part of it', async () => {
    // a partial append would be re-sent whole on retry and duplicate the part
    // that landed
    const capped = memory({ maxStaged: 2 })
    await expect(capped.append([one('a'), one('b'), one('c')])).rejects.toThrow(/maxStaged/)
    expect(await capped.countPending(M)).toBe(0)
  })

  it('counts in-flight records — an unacked claim still occupies memory', async () => {
    const capped = memory({ maxStaged: 2 })
    await capped.append([one('a'), one('b')])
    await capped.claimRecords(M)

    expect(await capped.readPending({ metric: M })).toEqual([])
    await expect(capped.append([one('c')])).rejects.toThrow(/maxStaged/)
  })

  it('frees the budget on ack', async () => {
    const capped = memory({ maxStaged: 2 })
    await capped.append([one('a'), one('b')])
    await capped.ack(await capped.claimRecords(M))

    await expect(capped.append([one('c')])).resolves.toBeUndefined()
  })

  it('caps per metric, not globally', async () => {
    const capped = memory({ maxStaged: 1 })
    await capped.append([one('a')])
    await expect(
      capped.append([{ metric: 'other', id: 'b', ts: 1000, fields: {} }]),
    ).resolves.toBeUndefined()
  })
})

describe('memory · maxSeries', () => {
  it('refuses a new series past the cap, naming the metric', async () => {
    const capped = memory({ maxSeries: 2 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'b', delta: 1 }])

    await expect(
      capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'c', delta: 1 }]),
    ).rejects.toThrow(new RegExp(`${M}.*maxSeries`))
  })

  it('does not count the same series twice across buckets', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await expect(
      capped.increment([{ metric: M, bucketTs: 2000, dimKey: 'a', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('caps each metric independently', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: 'a', bucketTs: 1000, dimKey: 'x', delta: 1 }])
    await expect(
      capped.increment([{ metric: 'b', bucketTs: 1000, dimKey: 'y', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('frees capacity once a claim is acked', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await capped.ack(await capped.claim(M, 2000))

    await expect(
      capped.increment([{ metric: M, bucketTs: 3000, dimKey: 'b', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('still counts data that is claimed but not yet acked', async () => {
    // it is held in memory either way, which is what the cap protects
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await capped.claim(M, 2000)

    await expect(
      capped.increment([{ metric: M, bucketTs: 3000, dimKey: 'b', delta: 1 }]),
    ).rejects.toThrow(/maxSeries/)
  })

  it('does not leak capacity when a late write lands beside a released window', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    const claim = await capped.claim(M, 2000)
    // moved forward to 2000: the same series, in a second window
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await capped.release(claim)

    // one series in two windows, and acking both must free the slot completely
    await capped.ack(await capped.claim(M, 3000))
    await expect(
      capped.increment([{ metric: M, bucketTs: 3000, dimKey: 'b', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('leaves no partial state behind when a write is refused', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await expect(
      capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'b', delta: 1 }]),
    ).rejects.toThrow()

    expect(await capped.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: 'a', value: 1 },
    ])
  })
})

describe('memory · large batches', () => {
  it('puts back a released claim of 150,000 records', async () => {
    const big = memory({ maxStaged: Number.POSITIVE_INFINITY })
    await big.append(
      Array.from({ length: 150_000 }, (_, i) => ({ metric: M, id: `r${i}`, ts: i, fields: {} })),
    )
    const claim = await big.claimRecords(M)
    await big.release(claim)

    expect(await big.countPending(M)).toBe(150_000)
    const first = await big.readPending({ metric: M, limit: 2 })
    expect(first.map((r) => r.id)).toEqual(['r0', 'r1'])
  })

  it('reads one series without walking every series in the window', async () => {
    const wide = memory({ maxSeries: Number.POSITIVE_INFINITY })
    await wide.increment(
      Array.from({ length: 100_000 }, (_, i) => ({
        metric: M,
        bucketTs: 1000,
        dimKey: `s${i}`,
        delta: 1,
      })),
    )

    const started = performance.now()
    for (let i = 0; i < 1_000; i++) await wide.readBuckets({ metric: M, dimKey: 's5' })
    // a scan of 100,000 series a thousand times takes seconds; a lookup, a few ms
    expect(performance.now() - started).toBeLessThan(500)
    expect(await wide.readBuckets({ metric: M, dimKey: 's5' })).toEqual([
      { bucketTs: 1000, dimKey: 's5', value: 1 },
    ])
  })
})
