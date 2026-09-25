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

/** The per-namespace counters a driver keeps between claims, by design. */
function survives(ns: string, key: string): boolean {
  return key === `${ns}:seq` || key.startsWith(`${ns}:wm:`) || key.startsWith(`${ns}:eseq:`)
}

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
  const fresh = () => `mhtest_${randomUUID()}`

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

      // three small counters legitimately survive: the claim sequence, the
      // record sequence, and the watermark that sends late writes forward
      const left = (await live.keys(`${ns}:*`)).filter((k) => !survives(ns, k))
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

  describe('ioredis · recover', () => {
    /**
     * A driver that treats every claim as abandoned.
     *
     * `recoverAfter: 0` is the whole of what a test needs from the clock: the
     * cutoff is the only thing separating a dead flusher from a slow one, and
     * setting it to zero makes a claim taken a moment ago stand in for one
     * taken by a process that never came back.
     */
    const sweeper = (ns: string) => ioredis(live, { namespace: ns, recoverAfter: 0 })

    it('puts back a window the flusher died holding, and the next claim gets it', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 4 }])
      await crashed.claim(M, 2000)
      // the crash: nothing acks, nothing releases, the process is gone

      // a claim alone can never find it again, because claim reads the index
      // and the claim took that bucket out of it
      const restarted = sweeper(ns)
      const probe = await restarted.claim(M, 2000)
      expect(probe.buckets).toEqual([])
      // settled, so the probe is not itself an abandoned claim for the sweep
      // below to find
      await restarted.ack(probe)

      expect(await restarted.recover(M)).toEqual({
        claims: 1,
        buckets: 1,
        records: 0,
        oldestClaimedAt: expect.any(Number),
      })

      const retry = await restarted.claim(M, 2000)
      expect([...(retry.buckets[0]?.values ?? [])]).toEqual([[WILLOW, 4]])

      await wipe(ns)
    })

    it('puts the stranded window back exactly as it was claimed', async () => {
      // a write aimed at the stranded window moved forward to the watermark,
      // so the window comes back with the value the crashed flusher took, and
      // shipping it again gives a sink the same row it may already have
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 5 }])
      await crashed.claim(M, 2000)

      const survivor = sweeper(ns)
      await survivor.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 2 }])
      await survivor.recover(M)

      expect(await survivor.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 5 },
        { bucketTs: 2000, dimKey: WILLOW, value: 2 },
      ])

      await wipe(ns)
    })

    it('merges a stranded window with a cell written before late writes moved', async () => {
      // data written by a version that let late writes into a claimed window
      // is still merged, not overwritten
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.observe([
        { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 5 },
        { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 2 },
      ])
      await crashed.claim(G, 2000)
      await live.hset(crashed.keyFor(G, 1000), WILLOW, '9|9|9|9|1')
      await live.zadd(`${ns}:idx:${G}`, 1000, '1000')

      const survivor = sweeper(ns)
      await survivor.recover(G)

      const row = (await survivor.readBuckets({ metric: G }))[0]
      expect(row?.value).toEqual({ last: 9, min: 2, max: 9, sum: 16, count: 3 })

      await wipe(ns)
    })

    it('puts stranded records back at the front, in their original order', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.append([
        { metric: M, id: 'r0', ts: 1000, fields: {} },
        { metric: M, id: 'r1', ts: 1001, fields: {} },
      ])
      await crashed.claimRecords(M)

      const survivor = sweeper(ns)
      await survivor.append([{ metric: M, id: 'later', ts: 9000, fields: {} }])

      expect(await survivor.recover(M)).toMatchObject({ claims: 1, buckets: 0, records: 2 })
      expect((await survivor.readPending({ metric: M })).map((r) => r.id)).toEqual([
        'r0',
        'r1',
        'later',
      ])

      await wipe(ns)
    })

    it('settles an empty claim rather than leaving it registered for ever', async () => {
      // an empty claim moves nothing, so there is no in-flight key at all —
      // only a registration, which still has to be cleared or it is swept on
      // every flush from now on
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.claim(M, 2000)

      const survivor = sweeper(ns)
      expect(await survivor.recover(M)).toMatchObject({ claims: 1, buckets: 0, records: 0 })
      expect((await survivor.recover(M)).claims).toBe(0)

      await wipe(ns)
    })

    it('leaves a claim younger than recoverAfter alone', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns, recoverAfter: '5m' })
      await driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      const claim = await driver.claim(M, 2000)

      expect((await driver.recover(M)).claims).toBe(0)
      // untouched, so the flush still writing it can settle it normally
      await expect(driver.ack(claim)).resolves.toBeUndefined()

      await wipe(ns)
    })

    it('reports when the oldest recovered claim was taken', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      const before = Date.now()
      const first = await crashed.claim(M, 2000)
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      await crashed.claim(M, 2000)

      const report = await sweeper(ns).recover(M)
      expect(report.claims).toBe(2)
      expect(report.oldestClaimedAt).toBe(first.claimedAt)
      expect(report.oldestClaimedAt).toBeGreaterThanOrEqual(before)

      await wipe(ns)
    })

    it('refuses the original owner an ack once the claim has been recovered', async () => {
      // the interlock, from the other side: if the dead process turns out to
      // be alive after all, it is told rather than allowed to delete a window
      // that is now back in the live set
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      const claim = await crashed.claim(M, 2000)

      await sweeper(ns).recover(M)
      await expect(crashed.ack(claim)).rejects.toThrow(/not in flight/)

      await wipe(ns)
    })

    it('lets only one of two racing sweepers take a claim', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 6 }])
      await crashed.claim(M, 2000)

      const [a, b] = await Promise.all([sweeper(ns).recover(M), sweeper(ns).recover(M)])
      expect(a.claims + b.claims).toBe(1)
      // restored once, not twice: two sweepers must not double the count
      expect(await crashed.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 6 },
      ])

      await wipe(ns)
    })

    it('leaves nothing behind once the recovered window has been acked', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
      await crashed.claim(M, 2000)

      const survivor = sweeper(ns)
      await survivor.recover(M)
      await survivor.ack(await survivor.claim(M, 2000))

      const left = (await live.keys(`${ns}:*`)).filter((k) => !survives(ns, k))
      expect(left).toEqual([])

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

    it('refuses a namespace with a colon or whitespace in it', () => {
      expect(() => ioredis(live, { namespace: 'org:idx' })).toThrow(/no colon or whitespace/)
      expect(() => ioredis(live, { namespace: 'org idx' })).toThrow(/no colon or whitespace/)
      expect(() => ioredis(live, { namespace: '' })).toThrow(/no colon or whitespace/)
    })

    it('closes a client it made from a factory', async () => {
      const own = new Redis(URL, { lazyConnect: true })
      const driver = ioredis(() => own, { namespace: fresh() })
      await driver.countPending(M)

      const ended = new Promise<void>((resolve) => own.once('end', () => resolve()))
      await driver.close()
      await ended
      expect(own.status).toBe('end')
    })

    it('leaves a client it was handed alone', async () => {
      const driver = ioredis(live, { namespace: fresh() })
      await driver.countPending(M)

      await driver.close()
      expect(await live.ping()).toBe('PONG')
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

    it('splits scripts into round trips of maxPipelineSize', async () => {
      // a level carry sends one script per window. Counting the scripts in
      // each pipeline is the only way to see the split from outside
      const ns = fresh()
      const sizes: number[] = []
      const counting = new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'pipeline') return Reflect.get(target, prop, receiver)
          return () => {
            const pipeline = target.pipeline()
            const exec = pipeline.exec.bind(pipeline)
            pipeline.exec = (async () => {
              sizes.push(pipeline.length)
              return exec()
            }) as typeof pipeline.exec
            return pipeline
          }
        },
      })
      const driver = ioredis(counting, { namespace: ns, maxPipelineSize: 10 })
      await driver.setLevel([{ metric: M, bucketTs: 0, dimKey: WILLOW, value: 1, mode: 'set' }])
      sizes.length = 0

      await driver.setLevel(
        Array.from({ length: 45 }, (_, i) => ({
          metric: M,
          bucketTs: (i + 1) * 1000,
          dimKey: WILLOW,
          value: 1,
          mode: 'hold' as const,
        })),
      )

      expect(sizes).toEqual([10, 10, 10, 10, 5])
      expect((await driver.readLevels(M))[0]?.heldThrough).toBe(45_000)

      await wipe(ns)
    })

    it('reads a record staged before records carried a sequence stamp', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.rpush(`${ns}:e:${M}`, JSON.stringify({ id: 'old', ts: 1000, fields: { a: 1 } }))
      await driver.append([{ metric: M, id: 'new', ts: 2000, fields: { a: 2 } }])

      expect(await driver.readPending({ metric: M })).toEqual([
        { id: 'old', ts: 1000, fields: { a: 1 } },
        { id: 'new', ts: 2000, fields: { a: 2 } },
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
