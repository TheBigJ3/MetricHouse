/**
 * The ioredis driver.
 *
 * The bulk of this is `contract.ts`, shared with the memory driver — that is
 * the point of the file, and passing it unchanged is what "parity" means here.
 * What is left below is the part Redis is *allowed* to differ on, plus the two
 * things memory cannot do at all and so cannot be asked for in a shared suite:
 * a claim that outlives the process, and a bucket two processes share.
 *
 * Needs a server. `REDIS_URL`, or localhost:6379. Without one the whole file
 * reports as skipped rather than failing, because a contributor with no Redis
 * should still be able to run `pnpm test` and trust the result.
 */

import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { describeDriverContract } from './contract.js'
import { ioredis } from './ioredis.js'
import { isGaugeCell } from './types.js'

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

/** A connected client, or `undefined` when there is no server to talk to. */
async function probe(): Promise<Redis | undefined> {
  const client = new Redis(URL, {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    // without this a missing server is an infinite reconnect loop rather than
    // a failed probe, and the suite hangs instead of skipping
    retryStrategy: () => null,
  })

  try {
    await client.connect()
    await client.ping()
    return client
  } catch {
    client.disconnect()
    return undefined
  }
}

const client = await probe()

const M = 'dog_poops'
const G = 'dog_weight'
const WILLOW = 'Willow|riverside'

if (!client) {
  describe('ioredis', () => {
    it.skip(`needs a Redis server — set REDIS_URL, or run one on 6379 (tried ${URL})`, () => {})
  })
} else {
  const live = client

  afterAll(async () => {
    await live.quit()
  })

  /**
   * A namespace nothing else is using.
   *
   * Every driver the contract builds gets its own, which is what lets a shared
   * server run the suite without tests seeing each other's keys — and what
   * lets two drivers in the *same* test deliberately share one.
   */
  let namespace = ''
  const fresh = () => `mhtest:${randomUUID()}`

  async function wipe(ns: string): Promise<void> {
    const keys = await live.keys(`${ns}:*`)
    if (keys.length > 0) await live.del(...keys)
  }

  describeDriverContract('ioredis', {
    make: () => {
      namespace = fresh()
      return ioredis(live, { namespace })
    },
    cleanup: () => wipe(namespace),
    capabilities: { durable: true, shared: true, atomicMerge: true },
  })

  describe('ioredis · key layout', () => {
    it('puts a counter where keyFor says it is, as a plain hash', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 2 }])

      expect(driver.keyFor(M, 1000)).toBe(`${ns}:b:${M}:1000`)
      // the promise the docs make: you can go and look at it in redis-cli
      expect(await live.hgetall(`${ns}:b:${M}:1000`)).toEqual({ [WILLOW]: '2' })

      await wipe(ns)
    })

    it('packs a gauge fold into one field as last|min|max|sum|count', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.observe([
        { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 5 },
        { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 9 },
      ])

      expect(await live.hget(`${ns}:b:${G}:1000`, WILLOW)).toBe('9|5|9|14|2')

      await wipe(ns)
    })

    it('registers every live bucket in the index, and drops it on claim', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 },
        { metric: M, bucketTs: 2000, dimKey: WILLOW, delta: 1 },
      ])

      expect(await live.zrange(`${ns}:idx:${M}`, '0', '-1')).toEqual(['1000', '2000'])
      await driver.claim(M, 2000)
      expect(await live.zrange(`${ns}:idx:${M}`, '0', '-1')).toEqual(['2000'])

      await wipe(ns)
    })

    it('leaves nothing behind once a claim is acked', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      await driver.append([{ metric: M, id: 'a', ts: 1000, fields: {} }])

      await driver.ack(await driver.claim(M, 2000))
      await driver.ack(await driver.claimRecords(M))

      // the sequence counter is the one key that legitimately survives
      const left = (await live.keys(`${ns}:*`)).filter((k) => k !== `${ns}:seq`)
      expect(left).toEqual([])

      await wipe(ns)
    })
  })

  describe('ioredis · scanSeries', () => {
    it('lists the distinct dim keys currently live', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 },
        { metric: M, bucketTs: 2000, dimKey: 'b', delta: 1 },
        // the same series in a second bucket is still one series
        { metric: M, bucketTs: 2000, dimKey: 'a', delta: 1 },
      ])

      expect(await driver.scanSeries(M)).toEqual(['a', 'b'])

      await wipe(ns)
    })

    it('stops counting a series once its bucket is claimed', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([{ metric: M, bucketTs: 1000, dimKey: 'a', delta: 1 }])
      await driver.claim(M, 2000)

      expect(await driver.scanSeries(M)).toEqual([])

      await wipe(ns)
    })
  })

  describe('ioredis · durable', () => {
    it('hands a claim to a driver that did not take it — the crash path', async () => {
      // the difference from memory in one test: its claim is a Map in the
      // process that took it, so a restart loses the window. Here the claim is
      // in Redis, and whoever comes back can still settle it.
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 4 }])
      const claim = await crashed.claim(M, 2000)

      const restarted = ioredis(live, { namespace: ns })
      await expect(restarted.ack(claim)).resolves.toBeUndefined()
      expect(await restarted.readBuckets({ metric: M })).toEqual([])

      await wipe(ns)
    })

    it('lets a restarted driver release a window the old one had claimed', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 4 }])
      const claim = await crashed.claim(M, 2000)

      const restarted = ioredis(live, { namespace: ns })
      await restarted.release(claim)
      expect(await restarted.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 4 },
      ])

      await wipe(ns)
    })

    it('keeps staged records across a restart', async () => {
      const ns = fresh()
      const before = ioredis(live, { namespace: ns })
      await before.append([{ metric: M, id: 'a', ts: 1000, fields: { dog: 'Willow' } }])

      const after = ioredis(live, { namespace: ns })
      expect(await after.readPending({ metric: M })).toEqual([
        { id: 'a', ts: 1000, fields: { dog: 'Willow' } },
      ])

      await wipe(ns)
    })
  })

  describe('ioredis · shared', () => {
    it('folds three instances into one bucket', async () => {
      // the reason this driver exists: no coordination, one series
      const ns = fresh()
      const instances = [0, 1, 2].map(() => ioredis(live, { namespace: ns }))
      await Promise.all(
        instances.map((driver) =>
          driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }]),
        ),
      )

      expect(await instances[0]?.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 3 },
      ])

      await wipe(ns)
    })

    it('loses no observation when instances fold the same gauge at once', async () => {
      // this is what `atomicMerge` claims, and what a client-side
      // read-modify-write would quietly get wrong
      const ns = fresh()
      const instances = Array.from({ length: 20 }, () => ioredis(live, { namespace: ns }))
      await Promise.all(
        instances.map((driver, i) =>
          driver.observe([{ metric: G, bucketTs: 1000, dimKey: WILLOW, value: i }]),
        ),
      )

      const row = (await instances[0]?.readBuckets({ metric: G }))?.[0]
      if (!row || !isGaugeCell(row.value)) throw new Error('expected a gauge cell')
      expect(row.value.count).toBe(20)
      expect(row.value.sum).toBe(190) // 0 + 1 + ... + 19
      expect(row.value.min).toBe(0)
      expect(row.value.max).toBe(19)

      await wipe(ns)
    })

    it('gives two instances distinct claim ids', async () => {
      const ns = fresh()
      const a = ioredis(live, { namespace: ns })
      const b = ioredis(live, { namespace: ns })
      await a.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])

      // both flushers run; only one can carry the window, and they must not
      // collide on the key their claim lives at
      const [first, second] = await Promise.all([a.claim(M, 2000), b.claim(M, 2000)])
      expect(first.id).not.toBe(second.id)
      expect(first.buckets.length + second.buckets.length).toBe(1)

      await wipe(ns)
    })
  })

  describe('ioredis · scripts', () => {
    it('reloads a script Redis has forgotten', async () => {
      // a Redis restart or a SCRIPT FLUSH invalidates every cached SHA at
      // once. The driver must notice and reload rather than fail the write.
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.observe([{ metric: G, bucketTs: 1000, dimKey: WILLOW, value: 5 }])

      await live.script('FLUSH')

      await expect(
        driver.observe([{ metric: G, bucketTs: 1000, dimKey: WILLOW, value: 7 }]),
      ).resolves.toBeUndefined()
      expect(await live.hget(`${ns}:b:${G}:1000`, WILLOW)).toBe('7|5|7|12|2')

      await wipe(ns)
    })
  })

  describe('ioredis · connection', () => {
    it('accepts a factory and does not call it until the first write', async () => {
      const ns = fresh()
      let calls = 0
      const driver = ioredis(
        () => {
          calls += 1
          return live
        },
        { namespace: ns },
      )

      // constructing a driver must not open a socket: a schema module gets
      // imported by build steps and tests that never write anything
      expect(calls).toBe(0)

      await driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      await driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      expect(calls).toBe(1)

      await wipe(ns)
    })
  })

  describe('ioredis · batching', () => {
    it('applies a batch larger than maxPipelineSize exactly once', async () => {
      // a split batch is still one logical write, and nothing reads between
      // the halves — but the halves must not overlap or drop
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns, maxPipelineSize: 7 })
      await driver.increment(
        Array.from({ length: 50 }, () => ({
          metric: M,
          bucketTs: 1000,
          dimKey: WILLOW,
          delta: 1,
        })),
      )

      expect(await driver.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 50 },
      ])

      await wipe(ns)
    })

    it('pages a bounded readPending past the page size', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns, maxPipelineSize: 4 })
      await driver.append(
        Array.from({ length: 30 }, (_, i) => ({
          metric: M,
          id: `r${i}`,
          ts: 1000 + i,
          fields: {},
        })),
      )

      const found = await driver.readPending({ metric: M, from: 1025 })
      expect(found.map((r) => r.id)).toEqual(['r25', 'r26', 'r27', 'r28', 'r29'])

      await wipe(ns)
    })
  })
}
