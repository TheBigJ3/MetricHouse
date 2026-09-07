import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from './memory.js'
import type { Driver } from './types.js'

const M = 'dog_poops'
const WILLOW = 'Willow|riverside'
const REX = 'Rex|central'

let driver: Driver
beforeEach(() => {
  driver = memory()
})

const incr = (bucketTs: number, dimKey: string, delta = 1) =>
  driver.increment([{ metric: M, bucketTs, dimKey, delta }])

describe('capabilities', () => {
  it('is honest about not being durable or shared', () => {
    // the house downgrades the guarantee to best-effort off the back of this
    expect(driver.capabilities.durable).toBe(false)
    expect(driver.capabilities.shared).toBe(false)
    expect(driver.capabilities.atomicMerge).toBe(true)
  })
})

describe('increment', () => {
  it('accumulates the same series within one bucket', async () => {
    await incr(1000, WILLOW)
    await incr(1000, WILLOW)
    await incr(1000, WILLOW, 5)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: WILLOW, value: 7 },
    ])
  })

  it('keeps series and buckets separate', async () => {
    await incr(1000, WILLOW)
    await incr(1000, REX, 3)
    await incr(2000, WILLOW)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: REX, value: 3 },
      { bucketTs: 1000, dimKey: WILLOW, value: 1 },
      { bucketTs: 2000, dimKey: WILLOW, value: 1 },
    ])
  })

  it('applies a whole batch in one call', async () => {
    await driver.increment([
      { metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 },
      { metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 2 },
      { metric: M, bucketTs: 1000, dimKey: REX, delta: 4 },
    ])
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: REX, value: 4 },
      { bucketTs: 1000, dimKey: WILLOW, value: 3 },
    ])
  })

  it('accepts negative deltas', async () => {
    await incr(1000, WILLOW, 5)
    await incr(1000, WILLOW, -2)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: WILLOW, value: 3 },
    ])
  })

  it('accepts fractional deltas — counters may declare float', async () => {
    await incr(1000, WILLOW, 0.5)
    await incr(1000, WILLOW, 0.25)
    expect((await driver.readBuckets({ metric: M }))[0]?.value).toBeCloseTo(0.75)
  })

  it('keeps metrics independent', async () => {
    await driver.increment([{ metric: 'a', bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
    await driver.increment([{ metric: 'b', bucketTs: 1000, dimKey: WILLOW, delta: 9 }])
    expect(await driver.readBuckets({ metric: 'a' })).toEqual([
      { bucketTs: 1000, dimKey: WILLOW, value: 1 },
    ])
  })

  it('does nothing on an empty batch', async () => {
    await driver.increment([])
    expect(await driver.readBuckets({ metric: M })).toEqual([])
  })
})

describe('readBuckets', () => {
  beforeEach(async () => {
    await incr(1000, WILLOW)
    await incr(2000, WILLOW, 2)
    await incr(3000, REX, 3)
  })

  it('returns [] for an unknown metric', async () => {
    expect(await driver.readBuckets({ metric: 'nope' })).toEqual([])
  })

  it('filters by dim key', async () => {
    expect(await driver.readBuckets({ metric: M, dimKey: REX })).toEqual([
      { bucketTs: 3000, dimKey: REX, value: 3 },
    ])
  })

  it('filters on a half-open range', async () => {
    const rows = await driver.readBuckets({ metric: M, from: 2000, to: 3000 })
    expect(rows.map((r) => r.bucketTs)).toEqual([2000])
  })

  it('excludes the open bucket when given a watermark as `to`', async () => {
    // this is all `complete: true` is — the caller supplies bucketStart(now)
    const rows = await driver.readBuckets({ metric: M, to: 3000 })
    expect(rows.map((r) => r.bucketTs)).toEqual([1000, 2000])
  })

  it('is ordered by bucket then dim key, not by insertion', async () => {
    await incr(1000, REX)
    const rows = await driver.readBuckets({ metric: M, from: 1000, to: 2000 })
    expect(rows.map((r) => r.dimKey)).toEqual([REX, WILLOW])
  })
})

describe('claim', () => {
  beforeEach(async () => {
    await incr(1000, WILLOW)
    await incr(2000, WILLOW, 2)
    await incr(3000, REX, 3)
  })

  it('takes everything strictly below the watermark', async () => {
    const claim = await driver.claim(M, 3000)
    expect(claim.buckets.map((b) => b.bucketTs)).toEqual([1000, 2000])
  })

  it('returns buckets ascending', async () => {
    await incr(500, WILLOW)
    const claim = await driver.claim(M, 3000)
    expect(claim.buckets.map((b) => b.bucketTs)).toEqual([500, 1000, 2000])
  })

  it('hides claimed buckets from live reads', async () => {
    await driver.claim(M, 3000)
    const rows = await driver.readBuckets({ metric: M })
    expect(rows.map((r) => r.bucketTs)).toEqual([3000])
  })

  it('hides claimed buckets from a second claim — two flushers cannot both ship them', async () => {
    const first = await driver.claim(M, 3000)
    const second = await driver.claim(M, 3000)
    expect(first.buckets).toHaveLength(2)
    expect(second.buckets).toHaveLength(0)
  })

  it('returns an empty claim rather than null when nothing qualifies', async () => {
    const claim = await driver.claim(M, 0)
    expect(claim.buckets).toEqual([])
    await expect(driver.ack(claim)).resolves.toBeUndefined()
  })

  it('gives each claim a distinct id', async () => {
    const a = await driver.claim(M, 3000)
    const b = await driver.claim(M, 3000)
    expect(a.id).not.toBe(b.id)
  })

  it('carries the values, keyed by dim key', async () => {
    const claim = await driver.claim(M, 3000)
    expect([...(claim.buckets[0]?.values ?? [])]).toEqual([[WILLOW, 1]])
  })
})

describe('ack', () => {
  it('discards the claimed data permanently', async () => {
    await incr(1000, WILLOW)
    const claim = await driver.claim(M, 2000)
    await driver.ack(claim)

    expect(await driver.readBuckets({ metric: M })).toEqual([])
    expect((await driver.claim(M, 2000)).buckets).toEqual([])
  })

  it('leaves unclaimed buckets alone', async () => {
    await incr(1000, WILLOW)
    await incr(3000, REX, 3)
    await driver.ack(await driver.claim(M, 2000))

    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 3000, dimKey: REX, value: 3 },
    ])
  })

  it('refuses to settle the same claim twice', async () => {
    await incr(1000, WILLOW)
    const claim = await driver.claim(M, 2000)
    await driver.ack(claim)
    await expect(driver.ack(claim)).rejects.toThrow(/not in flight/)
  })
})

describe('release', () => {
  it('returns the data to the live set, unchanged', async () => {
    await incr(1000, WILLOW, 7)
    const claim = await driver.claim(M, 2000)
    expect(await driver.readBuckets({ metric: M })).toEqual([])

    await driver.release(claim)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: WILLOW, value: 7 },
    ])
  })

  it('makes the data claimable again — the retry path', async () => {
    await incr(1000, WILLOW, 7)
    const first = await driver.claim(M, 2000)
    await driver.release(first)

    const second = await driver.claim(M, 2000)
    expect([...(second.buckets[0]?.values ?? [])]).toEqual([[WILLOW, 7]])
  })

  it('merges a write that landed while the bucket was claimed', async () => {
    // a straggler or a backdated write can reach a claimed bucket. Overwriting
    // on release would silently drop it.
    await incr(1000, WILLOW, 5)
    const claim = await driver.claim(M, 2000)
    await incr(1000, WILLOW, 2)

    await driver.release(claim)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: WILLOW, value: 7 },
    ])
  })

  it('merges a new series that appeared while the bucket was claimed', async () => {
    await incr(1000, WILLOW, 5)
    const claim = await driver.claim(M, 2000)
    await incr(1000, REX, 3)

    await driver.release(claim)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: REX, value: 3 },
      { bucketTs: 1000, dimKey: WILLOW, value: 5 },
    ])
  })

  it('refuses to settle the same claim twice', async () => {
    await incr(1000, WILLOW)
    const claim = await driver.claim(M, 2000)
    await driver.release(claim)
    await expect(driver.release(claim)).rejects.toThrow(/not in flight/)
  })

  it('refuses to ack a claim that was already released', async () => {
    await incr(1000, WILLOW)
    const claim = await driver.claim(M, 2000)
    await driver.release(claim)
    await expect(driver.ack(claim)).rejects.toThrow(/not in flight/)
  })
})

describe('at-least-once', () => {
  it('loses nothing when the write fails and the flush retries', async () => {
    await incr(1000, WILLOW, 4)
    await incr(2000, REX, 6)

    const attempt = await driver.claim(M, 3000)
    await driver.release(attempt) // write() threw

    const retry = await driver.claim(M, 3000)
    expect(retry.buckets.map((b) => [b.bucketTs, [...b.values]])).toEqual([
      [1000, [[WILLOW, 4]]],
      [2000, [[REX, 6]]],
    ])

    await driver.ack(retry)
    expect(await driver.readBuckets({ metric: M })).toEqual([])
  })
})

describe('append', () => {
  const rec = (id: string, ts: number, fields: Record<string, unknown> = {}) => ({
    metric: M,
    id,
    ts,
    fields,
  })

  it('stages records verbatim, in append order', async () => {
    await driver.append([rec('a', 1000, { dog: 'Willow' }), rec('b', 2000, { dog: 'Rex' })])
    expect(await driver.readPending({ metric: M })).toEqual([
      { id: 'a', ts: 1000, fields: { dog: 'Willow' } },
      { id: 'b', ts: 2000, fields: { dog: 'Rex' } },
    ])
  })

  it('does not aggregate — two identical records are two records', async () => {
    // the entire difference from `increment`, which would have folded these
    await driver.append([rec('a', 1000, { dog: 'Willow' }), rec('b', 1000, { dog: 'Willow' })])
    expect(await driver.countPending(M)).toBe(2)
  })

  it('treats fields as opaque — it never reads inside them', async () => {
    const weird = { nested: { deep: [1, 2] }, _ingested_at: 7, fn: 'not a function' }
    await driver.append([rec('a', 1000, weird)])
    expect((await driver.readPending({ metric: M }))[0]?.fields).toEqual(weird)
  })

  it('keeps metrics separate', async () => {
    await driver.append([rec('a', 1000), { metric: 'other', id: 'b', ts: 1000, fields: {} }])
    expect(await driver.countPending(M)).toBe(1)
    expect(await driver.countPending('other')).toBe(1)
  })

  it('counts nothing for a metric that has never been written', async () => {
    expect(await driver.countPending('unseen')).toBe(0)
    expect(await driver.readPending({ metric: 'unseen' })).toEqual([])
  })
})

describe('readPending', () => {
  const seed = () =>
    driver.append([
      { metric: M, id: 'a', ts: 1000, fields: {} },
      { metric: M, id: 'b', ts: 2000, fields: {} },
      { metric: M, id: 'c', ts: 3000, fields: {} },
    ])

  it('bounds by a half-open ts range', async () => {
    await seed()
    const found = await driver.readPending({ metric: M, from: 2000, to: 3000 })
    expect(found.map((r) => r.id)).toEqual(['b'])
  })

  it('honours a limit without scanning the rest', async () => {
    await seed()
    expect((await driver.readPending({ metric: M, limit: 2 })).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('does not consume', async () => {
    await seed()
    await driver.readPending({ metric: M })
    expect(await driver.countPending(M)).toBe(3)
  })
})

describe('claimRecords', () => {
  const seed = (n: number) =>
    driver.append(
      Array.from({ length: n }, (_, i) => ({ metric: M, id: `r${i}`, ts: 1000 + i, fields: {} })),
    )

  it('takes everything staged when no limit is given', async () => {
    await seed(3)
    const claim = await driver.claimRecords(M)
    expect(claim.kind).toBe('records')
    expect(claim.records.map((r) => r.id)).toEqual(['r0', 'r1', 'r2'])
  })

  it('hides claimed records from readPending and from a second claim', async () => {
    await seed(2)
    await driver.claimRecords(M)

    expect(await driver.readPending({ metric: M })).toEqual([])
    expect((await driver.claimRecords(M)).records).toEqual([])
  })

  it('takes the oldest first, up to the limit', async () => {
    await seed(5)
    const claim = await driver.claimRecords(M, 2)
    expect(claim.records.map((r) => r.id)).toEqual(['r0', 'r1'])
    // the rest stay visible, so a backlog drains across flushes
    expect(await driver.countPending(M)).toBe(3)
  })

  it('ack discards the claim for good', async () => {
    await seed(2)
    const claim = await driver.claimRecords(M)
    await driver.ack(claim)

    expect(await driver.countPending(M)).toBe(0)
    await expect(driver.ack(claim)).rejects.toThrow(/not in flight/)
  })

  it('release returns records ahead of anything appended since', async () => {
    // they are older than the new arrivals, and a claim ships oldest first —
    // putting them at the back would ship out of order
    await seed(2)
    const claim = await driver.claimRecords(M)
    await driver.append([{ metric: M, id: 'later', ts: 9000, fields: {} }])
    await driver.release(claim)

    expect((await driver.readPending({ metric: M })).map((r) => r.id)).toEqual([
      'r0',
      'r1',
      'later',
    ])
  })

  it('release keeps the records byte-identical, ids included', async () => {
    await seed(1)
    const before = await driver.readPending({ metric: M })
    const claim = await driver.claimRecords(M)
    await driver.release(claim)

    expect(await driver.readPending({ metric: M })).toEqual(before)
  })

  it('refuses to settle a claim twice', async () => {
    await seed(1)
    const claim = await driver.claimRecords(M)
    await driver.release(claim)
    await expect(driver.release(claim)).rejects.toThrow(/not in flight/)
  })

  it('does not disturb bucketed data for the same metric name', async () => {
    // the two storage models share a namespace and must not see each other
    await incr(1000, WILLOW)
    await seed(1)

    const records = await driver.claimRecords(M)
    expect(records.records).toHaveLength(1)
    expect(await driver.readBuckets({ metric: M })).toEqual([
      { bucketTs: 1000, dimKey: WILLOW, value: 1 },
    ])
  })
})

describe('maxStaged', () => {
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

describe('maxSeries', () => {
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
