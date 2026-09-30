/**
 * The memory driver.
 *
 * Most of what this driver must do lives in `contract.ts` and is shared with
 * every other backend. See that file for why. What stays here is the part
 * memory is *allowed* to differ on: it is the only driver that caps series and
 * staged records, because it is the only one with no server to watch it.
 */

import { describe, expect, it } from 'vitest'
import { describeDriverContract } from './contract.js'
import { memory } from './memory.js'
import type { ClaimedBucket } from './types.js'

describeDriverContract('memory', {
  make: () => memory(),
  capabilities: { durable: false, shared: false, atomicMerge: true },
  // this driver keeps no storage a test can reach, so the cell goes in the
  // one way that skips the watermark: carried by a claim being released
  plant: async (driver, metric, bucketTs, dimKey, cell) => {
    const carrier = await driver.claim(metric, Number.MIN_SAFE_INTEGER)
    ;(carrier.buckets as ClaimedBucket[]).push({ bucketTs, values: new Map([[dimKey, cell]]) })
    await driver.release(carrier)
  },
})

const M = 'dog_poops'

describe('memory · options', () => {
  it('refuses a cap that is not a positive whole number', () => {
    for (const bad of [Number.NaN, 0, -1, 2.5, Number.NEGATIVE_INFINITY]) {
      expect(() => memory({ maxSeries: bad })).toThrow(
        `memory driver: maxSeries must be a positive whole number or Number.POSITIVE_INFINITY, got ${bad}`,
      )
      expect(() => memory({ maxStaged: bad })).toThrow(
        `memory driver: maxStaged must be a positive whole number or Number.POSITIVE_INFINITY, got ${bad}`,
      )
    }
  })

  it('takes Number.POSITIVE_INFINITY as no cap', async () => {
    const open = memory({
      maxSeries: Number.POSITIVE_INFINITY,
      maxStaged: Number.POSITIVE_INFINITY,
    })
    await expect(
      open.increment([{ metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 }]),
    ).resolves.toBeUndefined()
  })
})

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

  it('counts in-flight records, since an unacked claim still occupies memory', async () => {
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
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'b', delta: 1 },
    ])

    await expect(
      capped.increment([{ metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'c', delta: 1 }]),
    ).rejects.toThrow(new RegExp(`${M}.*maxSeries`))
  })

  it('does not count the same series twice across buckets', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await expect(
      capped.increment([{ metric: M, bucketTs: 2000, resolutionMs: 1000, dimKey: 'a', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('caps each metric independently', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: 'a', bucketTs: 1000, resolutionMs: 1000, dimKey: 'x', delta: 1 },
    ])
    await expect(
      capped.increment([
        { metric: 'b', bucketTs: 1000, resolutionMs: 1000, dimKey: 'y', delta: 1 },
      ]),
    ).resolves.toBeUndefined()
  })

  it('frees capacity once a claim is acked', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await capped.ack(await capped.claim(M, 2000))

    await expect(
      capped.increment([{ metric: M, bucketTs: 3000, resolutionMs: 1000, dimKey: 'b', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('still counts data that is claimed but not yet acked', async () => {
    // it is held in memory either way, which is what the cap protects
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await capped.claim(M, 2000)

    await expect(
      capped.increment([{ metric: M, bucketTs: 3000, resolutionMs: 1000, dimKey: 'b', delta: 1 }]),
    ).rejects.toThrow(/maxSeries/)
  })

  it('does not leak capacity when a late write lands beside a released window', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    const claim = await capped.claim(M, 2000)
    // moved forward to 2000: the same series, in a second window
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await capped.release(claim)

    // one series in two windows, and acking both must free the slot completely
    await capped.ack(await capped.claim(M, 3000))
    await expect(
      capped.increment([{ metric: M, bucketTs: 3000, resolutionMs: 1000, dimKey: 'b', delta: 1 }]),
    ).resolves.toBeUndefined()
  })

  it('leaves no partial state behind when a write is refused', async () => {
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await expect(
      capped.increment([{ metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'b', delta: 1 }]),
    ).rejects.toThrow(
      new Error(
        `memory driver: ${M} exceeded maxSeries (1), which a dim with unbounded values will ` +
          'do. Put that value on an event instead',
      ),
    )

    expect(await capped.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: 'a', value: 1 },
    ])
  })

  it('leaves no empty window behind when a write to a new window is refused', async () => {
    // an empty window would still be claimed, and ship as a batch of no rows
    const capped = memory({ maxSeries: 1 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await expect(
      capped.increment([{ metric: M, bucketTs: 2000, resolutionMs: 1000, dimKey: 'b', delta: 1 }]),
    ).rejects.toThrow(/maxSeries/)

    const claim = await capped.claim(M, 3000)
    expect(claim.buckets.map((b) => [b.bucketTs, [...b.values.keys()]])).toEqual([[1000, ['a']]])
  })

  it('refuses a batch that would pass the cap without keeping any of it', async () => {
    const capped = memory({ maxSeries: 2 })
    await capped.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
    ])
    await expect(
      capped.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'b', delta: 1 },
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'c', delta: 1 },
      ]),
    ).rejects.toThrow(/maxSeries/)

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
        resolutionMs: 1000,
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

describe('memory · reads', () => {
  it('hands out copies of folds and level cells, so editing one changes nothing stored', async () => {
    const driver = memory()
    await driver.observe([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', value: 4.6 },
    ])
    await driver.setLevel([
      { metric: 'lvl', bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', value: 3, mode: 'set' },
    ])

    const [fold] = await driver.readBuckets({ metric: M })
    const [held] = await driver.readBuckets({ metric: 'lvl', dimKey: 'a' })
    Object.assign(fold?.value as object, { min: 5 })
    Object.assign(held?.value as object, { level: 9 })

    const claim = await driver.claim(M, 2000)
    expect(claim.buckets[0]?.values.get('a')).toEqual({
      last: 4.6,
      min: 4.6,
      max: 4.6,
      sum: 4.6,
      count: 1,
    })
    expect(await driver.readBuckets({ metric: 'lvl' })).toEqual([
      { bucketTs: 1000, dimKey: 'a', value: { level: 3 } },
    ])
  })
})
