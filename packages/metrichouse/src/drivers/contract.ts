/**
 * The driver contract, as an executable suite.
 *
 * Every driver is measured against the memory driver, because the memory
 * driver *is* the specification: it is the one implementation small enough to
 * read in a sitting, and its behaviour is what the rest of the library was
 * written against. A new backend is not "a driver" because it satisfies the
 * TypeScript interface — a stub of twelve `async () => {}` methods does that.
 * It is a driver when it passes this file.
 *
 * ```
 * memory.test.ts   describeDriverContract('memory', ...)  + maxSeries, maxStaged
 * ioredis.test.ts  describeDriverContract('ioredis', ...) + key layout, durability
 * ```
 *
 * So the rule for adding a backend is mechanical: call this, watch it fail,
 * make it pass. Nothing here may reference a concrete driver, and anything a
 * driver is *allowed* to differ on — a series cap, a key layout, whether a
 * claim survives a restart — belongs in that driver's own test file rather
 * than here.
 *
 * Not a test file itself: `vitest.config.ts` collects `src/**\/*.test.ts`, and
 * this exports a function instead of running one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Driver, DriverCapabilities, GaugeCell } from './types.js'
import { isGaugeCell } from './types.js'

/** A counter metric, and two series inside it. */
const M = 'dog_poops'
/** A gauge metric. Separate from {@link M}: one metric holds one kind. */
const G = 'dog_weight'
const WILLOW = 'Willow|riverside'
const REX = 'Rex|central'

export interface DriverContractOptions {
  /**
   * A driver with no data in it.
   *
   * Called before every test. A shared driver must isolate here — a fresh
   * namespace per call — or tests see each other's keys.
   */
  make(): Promise<Driver> | Driver

  /** Drop whatever `make` created. Only a driver with a server needs this. */
  cleanup?(driver: Driver): Promise<void> | void

  /** What this driver claims about itself, asserted rather than assumed. */
  capabilities: DriverCapabilities
}

export function describeDriverContract(name: string, options: DriverContractOptions): void {
  describe(`${name} · driver contract`, () => {
    let driver: Driver

    beforeEach(async () => {
      driver = await options.make()
    })

    afterEach(async () => {
      await options.cleanup?.(driver)
    })

    const incr = (bucketTs: number, dimKey: string, delta = 1) =>
      driver.increment([{ metric: M, bucketTs, dimKey, delta }])

    const obs = (bucketTs: number, dimKey: string, value: number) =>
      driver.observe([{ metric: G, bucketTs, dimKey, value }])

    /** The one cell at a bucket and series, narrowed to a gauge fold. */
    const gaugeAt = async (bucketTs: number, dimKey: string): Promise<GaugeCell> => {
      const rows = await driver.readBuckets({ metric: G, dimKey })
      const row = rows.find((r) => r.bucketTs === bucketTs)
      if (!row) throw new Error(`no cell at ${bucketTs}/${dimKey}`)
      if (!isGaugeCell(row.value)) throw new Error(`expected a gauge cell, got ${row.value}`)
      return row.value
    }

    const rec = (id: string, ts: number, fields: Record<string, unknown> = {}) => ({
      metric: M,
      id,
      ts,
      fields,
    })

    describe('capabilities', () => {
      it('reports what this driver actually promises', () => {
        expect(driver.capabilities).toEqual(options.capabilities)
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

      it('survives a dim key holding the separator and a backslash', async () => {
        // dim values are escaped, not sanitised, so a key reaches storage with
        // `|` and `\` still in it. A driver that packs keys into a composite
        // field has to survive that.
        const nasty = 'a\\|b|c\\\\'
        await driver.increment([{ metric: M, bucketTs: 1000, dimKey: nasty, delta: 2 }])
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 1000, dimKey: nasty, value: 2 },
        ])
      })
    })

    describe('observe', () => {
      it('folds one observation into last, min, max, sum and count', async () => {
        await obs(1000, WILLOW, 7)
        expect(await gaugeAt(1000, WILLOW)).toEqual({
          last: 7,
          min: 7,
          max: 7,
          sum: 7,
          count: 1,
        })
      })

      it('folds repeated observations, newest winning `last`', async () => {
        await obs(1000, WILLOW, 5)
        await obs(1000, WILLOW, 9)
        await obs(1000, WILLOW, 1)
        expect(await gaugeAt(1000, WILLOW)).toEqual({
          last: 1,
          min: 1,
          max: 9,
          sum: 15,
          count: 3,
        })
      })

      it('folds a whole batch in order', async () => {
        await driver.observe([
          { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 4 },
          { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 8 },
        ])
        expect(await gaugeAt(1000, WILLOW)).toEqual({
          last: 8,
          min: 4,
          max: 8,
          sum: 12,
          count: 2,
        })
      })

      it('keeps series and buckets separate', async () => {
        await obs(1000, WILLOW, 5)
        await obs(1000, REX, 50)
        await obs(2000, WILLOW, 6)

        expect((await gaugeAt(1000, REX)).sum).toBe(50)
        expect((await gaugeAt(2000, WILLOW)).count).toBe(1)
      })

      it('handles negative and fractional observations', async () => {
        await obs(1000, WILLOW, -2.5)
        await obs(1000, WILLOW, 1.25)

        const cell = await gaugeAt(1000, WILLOW)
        expect(cell.min).toBeCloseTo(-2.5)
        expect(cell.max).toBeCloseTo(1.25)
        expect(cell.sum).toBeCloseTo(-1.25)
      })

      it('keeps full float precision through a fold', async () => {
        // a driver that round-trips the fold through a string has to do it at
        // full f64 width, or sums drift a little on every observation
        await obs(1000, WILLOW, 0.1)
        await obs(1000, WILLOW, 0.2)
        expect((await gaugeAt(1000, WILLOW)).sum).toBe(0.30000000000000004)
      })

      it('does nothing on an empty batch', async () => {
        await driver.observe([])
        expect(await driver.readBuckets({ metric: G })).toEqual([])
      })

      it('refuses to observe into a series holding counter cells', async () => {
        await driver.increment([{ metric: G, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
        await expect(obs(1000, WILLOW, 5)).rejects.toThrow()
      })

      it('refuses to increment a series holding gauge cells', async () => {
        await obs(1000, WILLOW, 5)
        await expect(
          driver.increment([{ metric: G, bucketTs: 1000, dimKey: WILLOW, delta: 1 }]),
        ).rejects.toThrow()
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

      it('carries a gauge fold intact', async () => {
        await obs(1000, WILLOW, 4)
        await obs(1000, WILLOW, 10)

        const claim = await driver.claim(G, 2000)
        expect([...(claim.buckets[0]?.values ?? [])]).toEqual([
          [WILLOW, { last: 10, min: 4, max: 10, sum: 14, count: 2 }],
        ])
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
        // a straggler or a backdated write can reach a claimed bucket.
        // Overwriting on release would silently drop it.
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

      it('merges a gauge fold that kept folding while it was claimed', async () => {
        // the claimed fold is the older half; `last` belongs to whatever landed
        // after it, and the other four aggregates merge without caring
        await obs(1000, WILLOW, 5)
        await obs(1000, WILLOW, 2)
        const claim = await driver.claim(G, 2000)
        await obs(1000, WILLOW, 9)

        await driver.release(claim)
        expect(await gaugeAt(1000, WILLOW)).toEqual({
          last: 9,
          min: 2,
          max: 9,
          sum: 16,
          count: 3,
        })
      })

      it('restores a gauge fold into a bucket nothing touched', async () => {
        await obs(1000, WILLOW, 5)
        await obs(1000, WILLOW, 11)
        const claim = await driver.claim(G, 2000)

        await driver.release(claim)
        expect(await gaugeAt(1000, WILLOW)).toEqual({
          last: 11,
          min: 5,
          max: 11,
          sum: 16,
          count: 2,
        })
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

      it('round-trips a Date in fields', async () => {
        // a declared `ts()` field reaches storage as a real Date, and the
        // metric puts it straight into the row. A driver that serialises has to
        // bring back a Date, not the string JSON would have made of it.
        const at = new Date('2026-09-17T12:00:00.000Z')
        await driver.append([rec('a', 1000, { at, note: 'not a date' })])

        const back = (await driver.readPending({ metric: M }))[0]
        expect(back?.fields.at).toBeInstanceOf(Date)
        expect(back?.fields.at).toEqual(at)
        expect(back?.fields.note).toBe('not a date')
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

      it('does nothing on an empty batch', async () => {
        await driver.append([])
        expect(await driver.countPending(M)).toBe(0)
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
        expect((await driver.readPending({ metric: M, limit: 2 })).map((r) => r.id)).toEqual([
          'a',
          'b',
        ])
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
          Array.from({ length: n }, (_, i) => ({
            metric: M,
            id: `r${i}`,
            ts: 1000 + i,
            fields: {},
          })),
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

      it('returns an empty claim rather than null when nothing is staged', async () => {
        const claim = await driver.claimRecords(M)
        expect(claim.records).toEqual([])
        await expect(driver.ack(claim)).resolves.toBeUndefined()
      })
    })
  })
}
