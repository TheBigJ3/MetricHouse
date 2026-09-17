/**
 * The memory driver.
 *
 * Most of what this driver must do lives in `contract.ts` and is shared with
 * every other backend — see that file for why. What stays here is the part
 * memory is *allowed* to differ on: it is the only driver that caps series and
 * staged records, because it is the only one with no server to watch it.
 *
 * Spec: initialPlan/11-driver-memory.md
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

    expect(await capped.countPending(M)).toBe(0)
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

  it('does not leak capacity when a release merges two holders into one', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    const claim = await capped.claim(M, 2000)
    await capped.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
    await capped.release(claim)

    // one series, one holder — acking it must free the slot completely
    await capped.ack(await capped.claim(M, 2000))
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
