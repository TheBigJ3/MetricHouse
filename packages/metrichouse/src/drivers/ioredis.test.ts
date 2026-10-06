/**
 * The ioredis driver.
 *
 * The bulk of this is `contract.ts`, shared with the memory driver. That is
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
import { level } from '../metrics/level.js'
import { str } from '../schema/types.js'
import { describeDriverContract } from './contract.js'
import {
  decodeRecord,
  decodeRecordTagged,
  encodeRecord,
  encodeRecordTagged,
  type IoredisClient,
  ioredis,
} from './ioredis.js'
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
  return (
    key.startsWith(`${ns}:wm:`) ||
    key.startsWith(`${ns}:wmown:`) ||
    key.startsWith(`${ns}:eseq:`) ||
    // a writer's record of the writes it has applied, which expires a day
    // after its last write
    key.startsWith(`${ns}:w:`)
  )
}

const M = 'dog_poops'
const G = 'dog_weight'
const WILLOW = 'Willow|riverside'

// pure functions, so they run with or without a server
describe('ioredis · record encoding', () => {
  const op = (fields: Record<string, unknown>) => ({ metric: M, id: 'r1', ts: 1000, fields })

  it('writes the same bytes as the tagged encoding for every primitive a field can hold', () => {
    const edges = op({
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
      negZero: -0,
      marker: '__mh_date',
      tagText: '{"__mh_date":5}',
      nothing: null,
      missing: undefined,
      yes: true,
      text: 'riverside',
    })
    const expected =
      '{"id":"r1","ts":1000,"fields":{"nan":null,"inf":null,"negInf":null,"negZero":0,' +
      '"marker":"__mh_date","tagText":"{\\"__mh_date\\":5}","nothing":null,"yes":true,' +
      '"text":"riverside"}}'
    expect(encodeRecordTagged(edges)).toBe(expected)
    expect(encodeRecord(edges)).toBe(expected)
  })

  it('tags a value only the full encoding can write', () => {
    const cases = [
      op({ at: new Date(5000) }),
      op({ __mh_date: 5 }),
      op({ nested: { a: 1 } }),
      op({ list: [1, 2] }),
      op({ boxed: new Number(3) }),
      { metric: M, id: 'r1', ts: new Date(7) as unknown as number, fields: {} },
    ]
    for (const one of cases) expect(encodeRecord(one)).toBe(encodeRecordTagged(one))
    expect(encodeRecord(op({ at: new Date(5000) }))).toBe(
      '{"id":"r1","ts":1000,"fields":{"at":{"__mh_date":5000}}}',
    )
  })

  it('reads back what the tagged decoding reads, with and without the prefix', () => {
    const stored = [
      '0000000000000001|{"id":"r1","ts":1000,"fields":{"marker":"plain","n":0}}',
      '{"id":"r1","ts":1000,"fields":{"n":1}}',
      '0000000000000002|{"id":"r1","ts":1000,"fields":{"at":{"__mh_date":5000}}}',
      '0000000000000003|{"id":"r1","ts":1000,"fields":{"__mh___mh_date":5}}',
    ]
    for (const one of stored) expect(decodeRecord(one)).toEqual(decodeRecordTagged(one))
    expect(decodeRecord(stored[2] as string).fields.at).toEqual(new Date(5000))
    expect(decodeRecord(stored[3] as string).fields).toEqual({ __mh_date: 5 })
  })

  it('keeps a key a record stored before keys were escaped under the reserved prefix', () => {
    // written unescaped by a driver before 0.6.0, so the prefix appears once
    const stored = '{"id":"r1","ts":1000,"fields":{"__mh_x":1,"json":{"__mh_y":2}}}'
    const fields = { __mh_x: 1, json: { __mh_y: 2 } }
    expect(decodeRecordTagged(stored).fields).toEqual(fields)
    expect(decodeRecord(stored).fields).toEqual(fields)
  })
})

/**
 * A client that answers every script with `1` and every `HGET` with `'1'`,
 * and lists `buckets` windows in every index. Enough to drive the parts of
 * the driver that never look at what Redis stored, with no server at all.
 */
function stubClient(buckets = 0): IoredisClient {
  const client = {
    script: async () => 'sha',
    zrangebyscore: async () => Array.from({ length: buckets }, (_, i) => String(i * 1000)),
    pipeline() {
      let queued = 0
      const replies: unknown[] = []
      const pipeline = {
        evalsha() {
          queued += 1
          replies.push(1)
          return pipeline
        },
        hgetall() {
          queued += 1
          replies.push({ [WILLOW]: '1' })
          return pipeline
        },
        exec: async () => replies.slice(0, queued).map((reply) => [null, reply]),
      }
      return pipeline
    },
  }
  return client as unknown as IoredisClient
}

/**
 * A client whose round trips answer from `trips`, in order, one entry per
 * script, and which keeps the arguments each script was sent with. A round trip
 * past the end of `trips` answers every script with `1`.
 */
function scriptedClient(trips: [error: Error | null, result: unknown][][]) {
  const sent: (string | number)[][] = []
  const client = {
    script: async () => 'sha',
    pipeline() {
      let queued = 0
      const pipeline = {
        evalsha(_sha: string, _keys: number, ...rest: (string | number)[]) {
          queued += 1
          sent.push(rest)
          return pipeline
        },
        exec: async () =>
          trips.shift() ?? Array.from({ length: queued }, () => [null, 1] as [null, number]),
      }
      return pipeline
    },
  }
  return { client: client as unknown as IoredisClient, sent }
}

// no server needed: the replies are scripted
describe('ioredis · writes Redis never answered', () => {
  const op = { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 }
  /** The floor each write was sent with, the second to last argument. */
  const floors = (sent: (string | number)[][]) => sent.map((args) => args.at(-2))

  it('keeps a write that timed out below the floor until a later write is answered', async () => {
    const { client, sent } = scriptedClient([[[new Error('Command timed out'), null]]])
    const driver = ioredis(client)

    await expect(driver.increment([op])).rejects.toThrow('Command timed out')
    await driver.increment([op])
    await driver.increment([op])

    // the second write still protects the first one's record, since ioredis
    // may resend it. The third comes after an answer, so the first cannot
    expect(floors(sent)).toEqual([1, 1, 3])
  })

  it('forgets a write Redis refused with a reply of its own', async () => {
    const refused = Object.assign(new Error('ERR refused'), { name: 'ReplyError' })
    const { client, sent } = scriptedClient([[[refused, null]]])
    const driver = ioredis(client)

    await expect(driver.increment([op])).rejects.toThrow('ERR refused')
    await driver.increment([op])
    expect(floors(sent)).toEqual([1, 2])
  })

  it('keeps every write of a round trip whose pipeline was rejected whole', async () => {
    let calls = 0
    const { client, sent } = scriptedClient([])
    const pipelineOf = client.pipeline.bind(client)
    ;(client as { pipeline: () => unknown }).pipeline = () => {
      const pipeline = pipelineOf()
      calls += 1
      if (calls === 1)
        pipeline.exec = async () => Promise.reject(new Error('Connection is closed.'))
      return pipeline
    }
    const driver = ioredis(client)

    await expect(driver.increment([op, { ...op, bucketTs: 2000 }])).rejects.toThrow(
      'Connection is closed.',
    )
    await driver.increment([op])
    await driver.increment([op])
    expect(floors(sent)).toEqual([1, 1, 1, 4])
  })
})

// no server needed: the replies are scripted
describe('ioredis · round trips of one call', () => {
  const op = (bucketTs: number) => ({
    metric: M,
    bucketTs,
    resolutionMs: 1000,
    dimKey: WILLOW,
    delta: 1,
  })
  /** The window each script was aimed at, after its four keys and the key prefix. */
  const windows = (sent: (string | number)[][]) => sent.map((args) => args[5])

  it('sends every round trip of a call before a call made after it', async () => {
    const { client, sent } = scriptedClient([])
    const driver = ioredis(client, { maxPipelineSize: 1 })

    await Promise.all([driver.increment([op(1000), op(2000)]), driver.increment([op(3000)])])
    expect(windows(sent)).toEqual([1000, 2000, 3000])
  })

  it('rejects with a refusal in an earlier round trip once every round trip is answered', async () => {
    const refused = Object.assign(new Error('ERR refused'), { name: 'ReplyError' })
    const { client, sent } = scriptedClient([[[refused, null]], [[null, 1]]])
    const driver = ioredis(client, { maxPipelineSize: 1 })

    await expect(driver.increment([op(1000), op(2000)])).rejects.toThrow('ERR refused')
    expect(windows(sent)).toEqual([1000, 2000])
  })

  it('resends what Redis forgot in every round trip of a call before a call made after', async () => {
    const forgot = Object.assign(new Error('NOSCRIPT No matching script. Please use EVAL.'), {
      name: 'ReplyError',
    })
    const { client, sent } = scriptedClient([[[forgot, null]], [[forgot, null]]])
    const driver = ioredis(client, { maxPipelineSize: 1 })
    // a call made the moment the first resend goes out
    let later: Promise<void> | undefined
    const pipelineOf = client.pipeline.bind(client)
    let execs = 0
    ;(client as { pipeline: () => unknown }).pipeline = () => {
      const pipeline = pipelineOf()
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = () => {
        execs += 1
        if (execs === 3) later = driver.increment([op(3000)])
        return exec()
      }
      return pipeline
    }

    await driver.increment([op(1000), op(2000)])
    await later
    expect(windows(sent)).toEqual([1000, 2000, 1000, 2000, 3000])
  })
})

// no server needed: the replies are scripted
describe('ioredis · scripts Redis forgot', () => {
  const op = (bucketTs: number) => ({
    metric: M,
    bucketTs,
    resolutionMs: 1000,
    dimKey: WILLOW,
    delta: 1,
  })
  /** The window each script was aimed at, after its four keys and the key prefix. */
  const windows = (sent: (string | number)[][]) => sent.map((args) => args[5])
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('resends what Redis forgot for two calls before a call made while the second waited', async () => {
    const forgot = Object.assign(new Error('NOSCRIPT No matching script. Please use EVAL.'), {
      name: 'ReplyError',
    })
    /** A reply held back until its `release` is called. */
    const held = () => {
      let release = (): void => {}
      const reply = new Promise<[Error, null][]>((resolve) => {
        release = () => resolve([[forgot, null]])
      })
      return { reply, release }
    }
    const refusals = [held(), held()]
    const { client, sent } = scriptedClient([])
    const pipelineOf = client.pipeline.bind(client)
    let execs = 0
    ;(client as { pipeline: () => unknown }).pipeline = () => {
      const pipeline = pipelineOf()
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = () => refusals[execs++]?.reply ?? exec()
      return pipeline
    }
    const driver = ioredis(client)

    const first = driver.increment([op(1000)])
    const second = driver.increment([op(2000)])
    await tick()
    refusals[0]?.release()
    await tick()
    // made after the first refusal came back, while the second is still out
    const third = driver.increment([op(3000)])
    await tick()
    refusals[1]?.release()
    await Promise.all([first, second, third])

    expect(windows(sent)).toEqual([1000, 2000, 1000, 2000, 3000])
  })
})

// no server needed: these never read what a script stored
describe('ioredis · options and connection', () => {
  it('refuses a maxPipelineSize that is not a positive integer', () => {
    for (const bad of [Number.NaN, 0, -1, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() => ioredis(stubClient(), { maxPipelineSize: bad })).toThrow(
        `ioredis driver: maxPipelineSize must be a positive integer, got ${String(bad)}`,
      )
    }
  })

  it('refuses a namespace with a colon or whitespace in it', () => {
    for (const bad of ['org:idx', 'org idx', '']) {
      expect(() => ioredis(stubClient(), { namespace: bad })).toThrow(
        `ioredis driver: namespace ${JSON.stringify(bad)} must be non-empty with no colon or ` +
          'whitespace, because the driver builds every key by joining it to the rest with colons',
      )
    }
  })

  it('refuses a namespace holding half of a surrogate pair', () => {
    for (const bad of ['mh\uD800', 'mh\uDC00x']) {
      expect(() => ioredis(stubClient(), { namespace: bad })).toThrow(
        `ioredis driver: namespace ${JSON.stringify(bad)} holds half of a surrogate pair, ` +
          'which Redis would store as the same replacement character for every such namespace',
      )
    }
  })

  it('reads a pipeline with more replies than a call can take as arguments', async () => {
    const driver = ioredis(stubClient(300_000), { maxPipelineSize: 300_000 })
    const rows = await driver.readBuckets({ metric: M })
    expect(rows).toHaveLength(300_000)
    expect(rows.at(-1)).toEqual({ bucketTs: 299_999_000, dimKey: WILLOW, value: 1 })
  })

  it('runs a script batch with more replies than a call can take as arguments', async () => {
    const driver = ioredis(stubClient(), { maxPipelineSize: 300_000 })
    await expect(
      driver.increment(
        Array.from({ length: 300_000 }, (_, i) => ({
          metric: M,
          bucketTs: i * 1000,
          resolutionMs: 1000,
          dimKey: WILLOW,
          delta: 1,
        })),
      ),
    ).resolves.toBeUndefined()
  })

  it('quits a client it made once when close() is called twice together', async () => {
    let quits = 0
    const made = {
      ...(stubClient() as object),
      quit: async () => {
        quits += 1
      },
    } as unknown as IoredisClient
    const driver = ioredis(() => made)
    await driver.increment([
      { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
    ])

    await Promise.all([driver.close(), driver.close()])
    expect(quits).toBe(1)
  })

  it('asks a factory that failed again on the next call, once for callers that raced it', async () => {
    let calls = 0
    const driver = ioredis(
      async () => {
        calls += 1
        if (calls === 1) throw new Error('secret not ready')
        return stubClient()
      },
      { namespace: 'stub' },
    )
    const op = { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 }

    const raced = await Promise.allSettled([driver.increment([op]), driver.increment([op])])
    expect(raced.map((one) => (one.status === 'rejected' ? String(one.reason) : 'ok'))).toEqual([
      'Error: secret not ready',
      'Error: secret not ready',
    ])
    expect(calls).toBe(1)

    await driver.increment([op])
    await driver.increment([op])
    expect(calls).toBe(2)
  })
})

if (!client) {
  describe('ioredis', () => {
    it.skip(`needs a Redis server. Set REDIS_URL, or run one on 6379 (tried ${URL})`, () => {})
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
   * server run the suite without tests seeing each other's keys, and what
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
    plant: async (_driver, metric, bucketTs, dimKey, cell) => {
      const raw =
        typeof cell === 'number'
          ? String(cell)
          : isGaugeCell(cell)
            ? [cell.last, cell.min, cell.max, cell.sum, cell.count].join('|')
            : `@${cell.level}`
      await live.hset(`${namespace}:b:${metric}:${bucketTs}`, dimKey, raw)
      await live.zadd(`${namespace}:idx:${metric}`, bucketTs, String(bucketTs))
    },
    abandoned: () => ioredis(live, { namespace, recoverAfter: 0 }),
  })

  describe('ioredis · key layout', () => {
    it('puts a counter where keyFor says it is, as a plain hash', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 2 },
      ])

      expect(driver.keyFor(M, 1000)).toBe(`${ns}:b:${M}:1000`)
      // the promise the docs make: you can go and look at it in redis-cli
      expect(await live.hgetall(`${ns}:b:${M}:1000`)).toEqual({ [WILLOW]: '2' })

      await wipe(ns)
    })

    it('packs a gauge fold into one field as last|min|max|sum|count', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.observe([
        { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 5 },
        { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 9 },
      ])

      expect(await live.hget(`${ns}:b:${G}:1000`, WILLOW)).toBe('9|5|9|14|2')

      await wipe(ns)
    })

    it('registers every live bucket in the index, and drops it on claim', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
        { metric: M, bucketTs: 2000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])

      expect(await live.zrange(`${ns}:idx:${M}`, '0', '-1')).toEqual(['1000', '2000'])
      await driver.claim(M, 2000)
      expect(await live.zrange(`${ns}:idx:${M}`, '0', '-1')).toEqual(['2000'])

      await wipe(ns)
    })

    it('keeps a turn as the bare time 0.7.0 reads, with its token in a key beside it', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })

      const first = await driver.takeTurn?.(M, 5000, 1000)
      if (!first?.granted) throw new Error('expected the turn to be granted')
      expect(await live.get(`${ns}:turn:${M}`)).toBe('5000')
      expect(await live.get(`${ns}:turntok:${M}`)).toBe(first.turn.token)

      const second = await driver.takeTurn?.(M, 6000, 1000)
      if (!second?.granted) throw new Error('expected the turn to be granted')
      expect(await live.get(`${ns}:turn:${M}`)).toBe('6000')
      expect(await live.get(`${ns}:turntok:${M}`)).toBe(second.turn.token)

      await wipe(ns)
    })

    it('leaves nothing behind once a claim is acked', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
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

  describe('ioredis · level storage shared with 0.7', () => {
    const LV = 'dogs_in_park'
    const one = (bucketTs: number, value: number, mode: 'set' | 'add' | 'hold') =>
      ({ metric: LV, bucketTs, resolutionMs: 1000, dimKey: WILLOW, value, mode }) as const

    /** A level cell's number as 0.7.0's scripts read it: `tonumber` of all but the `@`. */
    const luaReads = async (key: string, field: string) =>
      live.eval(
        "return tostring(tonumber(string.sub(redis.call('HGET', KEYS[1], ARGV[1]), 2)))",
        1,
        key,
        field,
      )

    it('reads the four field state and bare cells 0.7 stored', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      // `value|carried|writtenAt|heldThrough`. The newest write is at or
      // before the pointer unless it is past it, and then the pointer is the
      // latest the write carried can be
      await live.hset(`${ns}:lvl:${LV}`, WILLOW, '7|5|3000|1000', 'Rex', '4|4|1000|2000')
      await live.hset(`${ns}:b:${LV}:1000`, WILLOW, '@5')
      await live.zadd(`${ns}:idx:${LV}`, 1000, '1000')

      expect(await driver.readLevels(LV)).toEqual([
        {
          dimKey: 'Rex',
          value: 4,
          carried: 4,
          writtenAt: 1000,
          heldThrough: 2000,
          carriedFrom: 1000,
        },
        {
          dimKey: WILLOW,
          value: 7,
          carried: 5,
          writtenAt: 3000,
          heldThrough: 1000,
          carriedFrom: 1000,
        },
      ])
      expect(await driver.readBuckets({ metric: LV })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: { level: 5 } },
      ])

      await wipe(ns)
    })

    it('keeps the state in four fields, and carriedFrom beside it only when they cannot say it', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const state = () => live.hget(`${ns}:lvl:${LV}`, WILLOW)
      const from = () => live.hget(`${ns}:lvlfrom:${LV}`, WILLOW)

      await driver.setLevel([one(1000, 5, 'set')])
      await driver.setLevel([one(2000, 5, 'hold')])
      expect([await state(), await from()]).toEqual(['5|5|1000|2000', null])

      // written past the pointer, and the write carried comes from is older
      // than the pointer: the four fields cannot say which window that was
      await driver.setLevel([one(4000, 7, 'set')])
      expect([await state(), await from()]).toEqual(['7|5|4000|2000', '1000|2000|5'])
      expect((await driver.readLevels(LV))[0]?.carriedFrom).toBe(1000)

      await driver.setLevel([one(3000, 5, 'hold')])
      expect([await state(), await from()]).toEqual(['7|5|4000|3000', '1000|3000|5'])

      // the carry reaches the write, and the four fields say it again
      await driver.setLevel([one(4000, 5, 'hold')])
      expect([await state(), await from()]).toEqual(['7|7|4000|4000', null])
      expect((await driver.readLevels(LV))[0]?.carriedFrom).toBe(4000)

      await wipe(ns)
    })

    it('marks carried and moved cells with a space 0.7 reads past', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.setLevel([one(1000, 5, 'set')])
      await driver.setLevel([one(2000, 5, 'hold')])
      await driver.setLevel([{ ...one(3000, 1, 'set'), dimKey: 'Rex' }])
      await driver.ack(await driver.claim(LV, 3000))
      await driver.setLevel([one(1000, 8, 'set')])

      expect(await live.hget(`${ns}:b:${LV}:3000`, WILLOW)).toBe('@8 ')
      // the claim took 2000 and holds the carried cell as it was stored
      await driver.setLevel([one(4000, 8, 'hold')])
      expect(await live.hget(`${ns}:b:${LV}:4000`, WILLOW)).toBe('@ 8')
      expect(await luaReads(`${ns}:b:${LV}:3000`, WILLOW)).toBe('8')
      expect(await luaReads(`${ns}:b:${LV}:4000`, WILLOW)).toBe('8')
      // and 0.7.0's decodeCell, `Number` of all but the `@`
      expect(Number('@8 '.slice(1))).toBe(8)
      expect(Number('@ 8'.slice(1))).toBe(8)
      expect(await driver.readBuckets({ metric: LV, dimKey: WILLOW })).toEqual([
        { bucketTs: 3000, dimKey: WILLOW, value: { level: 8, moved: true } },
        { bucketTs: 4000, dimKey: WILLOW, value: { level: 8, carried: true } },
      ])

      await wipe(ns)
    })

    it('ignores a carriedFrom beside a series that 0.7 has since carried on', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      // stored against a pointer of 2000, and a 0.7 hold has moved it to 3000
      await live.hset(`${ns}:lvl:${LV}`, WILLOW, '7|5|4000|3000')
      await live.hset(`${ns}:lvlfrom:${LV}`, WILLOW, '1000|2000|5')

      expect((await driver.readLevels(LV))[0]?.carriedFrom).toBe(3000)
      expect((await driver.readLevel?.(LV, WILLOW))?.carriedFrom).toBe(3000)

      await wipe(ns)
    })

    it('reads the five field state and @c cells an unreleased build stored, and rewrites them', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.hset(`${ns}:lvl:${LV}`, WILLOW, '5|5|1000|2000|1000')
      await live.hset(`${ns}:b:${LV}:2000`, WILLOW, '@c5')
      await live.zadd(`${ns}:idx:${LV}`, 2000, '2000')

      expect((await driver.readLevels(LV))[0]?.carriedFrom).toBe(1000)
      expect(await driver.readBuckets({ metric: LV })).toEqual([
        { bucketTs: 2000, dimKey: WILLOW, value: { level: 5, carried: true } },
      ])

      await driver.setLevel([one(4000, 7, 'set')])
      expect(await live.hget(`${ns}:lvl:${LV}`, WILLOW)).toBe('7|5|4000|2000')
      expect(await live.hget(`${ns}:lvlfrom:${LV}`, WILLOW)).toBe('1000|2000|5')

      await wipe(ns)
    })

    it('forgets the carriedFrom beside a series it drops', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.setLevel([one(1000, 5, 'set')])
      await driver.setLevel([one(2000, 5, 'hold')])
      await driver.setLevel([one(4000, 7, 'set')])

      await driver.dropLevels(LV, [WILLOW])
      expect(await live.exists(`${ns}:lvl:${LV}`, `${ns}:lvlfrom:${LV}`)).toBe(0)

      await wipe(ns)
    })

    it('rewrites a five field series in four on a flush that carries nothing', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const base = 1_788_616_980_000
      let clock = base
      const metric = level(LV, {
        dims: { dog: str() },
        resolution: '10s',
        flush: '10s',
        write: () => {},
      })
      metric.bind({ driver, now: () => clock })
      metric.set(5, { dog: 'Willow' })
      await metric.drain()
      const [field] = await live.hkeys(`${ns}:lvl:${LV}`)
      if (field === undefined) throw new Error('expected the set to store a series')
      // what a build between 0.7.0 and this one stored, carriedFrom fifth
      await live.hset(`${ns}:lvl:${LV}`, field, `5|5|${base}|${base}|${base}`)

      // the window has closed, and the series has no window left to carry
      clock = base + 12_000
      await metric.flush()

      expect(await live.hget(`${ns}:lvl:${LV}`, field)).toBe(`5|5|${base}|${base}`)
      expect(await live.exists(`${ns}:lvlfrom:${LV}`)).toBe(0)

      await wipe(ns)
    })

    it('keeps carriedFrom beside a five field series it rewrites when four fields cannot say it', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.hset(`${ns}:lvl:${LV}`, WILLOW, '7|5|4000|2000|1000')

      expect((await driver.readLevels(LV))[0]?.carriedFrom).toBe(1000)
      expect(await live.hget(`${ns}:lvl:${LV}`, WILLOW)).toBe('7|5|4000|2000')
      expect(await live.hget(`${ns}:lvlfrom:${LV}`, WILLOW)).toBe('1000|2000|5')

      await wipe(ns)
    })

    it('leaves a series alone that another process rewrote between the read and the rewrite', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.hset(`${ns}:lvl:${LV}`, WILLOW, '5|5|1000|2000|1000')
      // the read sees five fields, and a 0.7 set lands before the rewrite
      const hgetall = live.hgetall.bind(live)
      const racing = Object.assign(Object.create(live), {
        hgetall: async (key: string) => {
          const read = await hgetall(key)
          if (key === `${ns}:lvl:${LV}`) await live.hset(key, WILLOW, '9|5|3000|2000')
          return read
        },
      })
      await ioredis(racing, { namespace: ns }).readLevels(LV)

      expect(await live.hget(`${ns}:lvl:${LV}`, WILLOW)).toBe('9|5|3000|2000')
      expect(await driver.readLevels(LV)).toHaveLength(1)

      await wipe(ns)
    })

    it('marks an @c cell the way 0.7 reads it when a claim takes it', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.hset(`${ns}:b:${LV}:2000`, WILLOW, '@c5', 'Rex', '@4')
      await live.zadd(`${ns}:idx:${LV}`, 2000, '2000')

      const claim = await driver.claim(LV, 3000)

      expect(await live.hgetall(`${ns}:inflight:${claim.id}`)).toEqual({
        [`2000:${WILLOW}`]: '@ 5',
        '2000:Rex': '@4',
      })
      expect(claim.kind === 'buckets' && claim.buckets).toEqual([
        {
          bucketTs: 2000,
          values: new Map([
            [WILLOW, { level: 5, carried: true }],
            ['Rex', { level: 4 }],
          ]),
        },
      ])

      await wipe(ns)
    })

    it('marks an @c cell the way 0.7 reads it when it puts a claim back', async () => {
      const ns = fresh()
      // a claim a build between 0.7.0 and this one took and then died holding
      const id = `${LV}#1`
      await live.hset(`${ns}:inflight:${id}`, `2000:${WILLOW}`, '@c5')
      await live.zadd(`${ns}:claims:${LV}`, 0, id)

      const report = await ioredis(live, { namespace: ns, recoverAfter: 0 }).recover(LV)

      expect(report.buckets).toBe(1)
      expect(await live.hgetall(`${ns}:b:${LV}:2000`)).toEqual({ [WILLOW]: '@ 5' })

      await wipe(ns)
    })
  })

  describe('ioredis · watermark shared with 0.7', () => {
    /**
     * A counter increment the way 0.7.0's scripts land it: a write aimed below
     * the stored watermark moves to the watermark's own value.
     */
    const incrementAs070 = (ns: string, bucketTs: number, delta: number) =>
      live.eval(
        `local target = ARGV[2]
local wm = redis.call('GET', KEYS[2])
if wm ~= false and tonumber(ARGV[2]) < tonumber(wm) then target = wm end
redis.call('HINCRBYFLOAT', ARGV[1] .. target, ARGV[3], ARGV[4])
redis.call('ZADD', KEYS[1], target, target)
return target`,
        2,
        `${ns}:idx:${M}`,
        `${ns}:wm:${M}`,
        `${ns}:b:${M}:`,
        bucketTs,
        WILLOW,
        delta,
      )

    /**
     * A claim the way 0.7.0's script takes one, then acked: the watermark
     * rises to upTo when that is higher, and every window below upTo goes.
     */
    const claimAs070 = (ns: string, upTo: number, metric: string = M) =>
      live.eval(
        `local wm = redis.call('GET', KEYS[1])
if wm == false or tonumber(ARGV[1]) > tonumber(wm) then redis.call('SET', KEYS[1], ARGV[1]) end
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[1])) do
  redis.call('DEL', ARGV[2] .. id)
  redis.call('ZREM', KEYS[2], id)
end`,
        2,
        `${ns}:wm:${metric}`,
        `${ns}:idx:${metric}`,
        upTo,
        `${ns}:b:${metric}:`,
      )

    it('keeps the watermark 0.7 reads on the grid after a claim that finds live windows', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])

      await driver.ack(await driver.claim(M, 5000))

      expect(await live.get(`${ns}:wm:${M}`)).toBe('5000')
      expect(await live.hget(`${ns}:wmown:${M}`, 'watermark')).toBe('1001|5000')
      // this version still lands a late write on the first window past the
      // newest one that held data, and leaves the empty ones after it alone
      expect(await driver.landing?.(M, 1000, 1000)).toBe(2000)
      expect(await driver.landing?.(M, 3000, 1000)).toBe(3000)

      await wipe(ns)
    })

    it('lands a late 0.7 write on a window of the grid', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      await driver.ack(await driver.claim(M, 5000))

      expect(await incrementAs070(ns, 1000, 2)).toBe('5000')
      expect(await driver.readBuckets({ metric: M })).toEqual([
        { bucketTs: 5000, dimKey: WILLOW, value: 2 },
      ])

      await wipe(ns)
    })

    it('raises the watermark 0.7 reads on a claim that finds nothing, and its own not at all', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })

      await driver.ack(await driver.claim(M, 5000))

      expect(await live.get(`${ns}:wm:${M}`)).toBe('5000')
      expect(await live.hget(`${ns}:wmown:${M}`, 'watermark')).toBe('|5000')
      expect(await driver.landing?.(M, 1000, 1000)).toBe(1000)

      await wipe(ns)
    })

    it('lands by a watermark a 0.7 claim raised past its own', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      await driver.ack(await driver.claim(M, 5000))

      await claimAs070(ns, 9000)
      await driver.increment([
        { metric: M, bucketTs: 3000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])

      expect(await driver.readBuckets({ metric: M })).toEqual([
        { bucketTs: 9000, dimKey: WILLOW, value: 1 },
      ])
      // and the next claim of this version keeps it
      await driver.ack(await driver.claim(M, 9000))
      expect(await live.hget(`${ns}:wmown:${M}`, 'watermark')).toBe('9000|9000')

      await wipe(ns)
    })

    it('moves a write past a window it started in the gap once a 0.7 claim has taken it', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const at = (bucketTs: number) =>
        driver.increment([{ metric: M, bucketTs, resolutionMs: 1000, dimKey: WILLOW, delta: 1 }])
      await at(1000)
      await driver.ack(await driver.claim(M, 5000))

      // 3000 was empty at the claim, so the write keeps it, and it is recorded
      await at(3000)
      expect(await live.hget(`${ns}:wmown:${M}`, '3000')).toBe('1')
      // a 0.7 claim at the same boundary takes it and leaves mh:wm as it was
      await claimAs070(ns, 5000)
      expect(await live.get(`${ns}:wm:${M}`)).toBe('5000')

      expect(await driver.landing?.(M, 3000, 1000)).toBe(4000)
      await at(3000)
      // 2000 was never started, so a write there is still its first copy
      await at(2000)
      expect(await driver.readBuckets({ metric: M })).toEqual([
        { bucketTs: 2000, dimKey: WILLOW, value: 1 },
        { bucketTs: 4000, dimKey: WILLOW, value: 1 },
      ])

      await wipe(ns)
    })

    it('carries no cell into a window of the gap a 0.7 claim has taken', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const LV = 'dogs_in_park'
      const op = (bucketTs: number, mode: 'set' | 'hold') =>
        ({ metric: LV, bucketTs, resolutionMs: 1000, dimKey: WILLOW, value: 5, mode }) as const
      await driver.setLevel([op(1000, 'set')])
      await driver.ack(await driver.claim(LV, 5000))
      await driver.setLevel([op(3000, 'set')])
      await driver.setLevel([op(2000, 'hold')])
      expect(await live.hget(`${ns}:wmown:${LV}`, '2000')).toBe('1')

      await claimAs070(ns, 5000, LV)
      await driver.setLevel([op(2000, 'hold'), op(3000, 'hold')])

      expect(await driver.readBuckets({ metric: LV })).toEqual([])
      expect((await driver.readLevels(LV))[0]?.heldThrough).toBe(3000)

      await wipe(ns)
    })

    it('forgets the windows recorded in the gap once its own watermark passes them', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const at = (bucketTs: number) =>
        driver.increment([{ metric: M, bucketTs, resolutionMs: 1000, dimKey: WILLOW, delta: 1 }])
      await at(1000)
      await driver.ack(await driver.claim(M, 5000))
      await at(3000)

      await driver.ack(await driver.claim(M, 5000))

      expect(await live.hgetall(`${ns}:wmown:${M}`)).toEqual({ watermark: '3001|5000' })

      await wipe(ns)
    })

    it('reads a watermark a build between 0.7.0 and this one stored off the grid', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.set(`${ns}:wm:${M}`, '1001')

      expect(await driver.landing?.(M, 1000, 1000)).toBe(2000)
      await driver.claim(M, 5000)
      expect(await live.get(`${ns}:wm:${M}`)).toBe('5000')
      expect(await live.hget(`${ns}:wmown:${M}`, 'watermark')).toBe('1001|5000')

      await wipe(ns)
    })
  })

  describe('ioredis · one series read', () => {
    it('fails on a bound Redis refuses with the words the plain command uses', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      for (const bound of [{ from: Number.NaN }, { to: Number.NaN }]) {
        await expect(driver.readBuckets({ metric: M, ...bound })).rejects.toThrow(
          'ERR min or max is not a float',
        )
        await expect(driver.readBuckets({ metric: M, dimKey: WILLOW, ...bound })).rejects.toThrow(
          'ERR min or max is not a float',
        )
      }
      await wipe(ns)
    })

    it('fails on a window key of the wrong type as a plain HGET does', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.zadd(`${ns}:idx:${M}`, 1000, '1000')
      await live.set(`${ns}:b:${M}:1000`, 'not a hash')
      await expect(driver.readBuckets({ metric: M, dimKey: WILLOW })).rejects.toThrow(
        'WRONGTYPE Operation against a key holding the wrong kind of value',
      )
      await wipe(ns)
    })

    it('leaves a sum of a window key of the wrong type to the cell read', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.zadd(`${ns}:idx:${M}`, 1000, '1000')
      await live.set(`${ns}:b:${M}:1000`, 'not a hash')
      expect(await driver.sumBuckets?.({ metric: M })).toBeUndefined()
      await wipe(ns)
    })
  })

  describe('ioredis · scanSeries', () => {
    it('lists the distinct dim keys currently live', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
        { metric: M, bucketTs: 2000, resolutionMs: 1000, dimKey: 'b', delta: 1 },
        // the same series in a second bucket is still one series
        { metric: M, bucketTs: 2000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
      ])

      expect(await driver.scanSeries(M)).toEqual(['a', 'b'])

      await wipe(ns)
    })

    it('stops counting a series once its bucket is claimed', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
      ])
      await driver.claim(M, 2000)

      expect(await driver.scanSeries(M)).toEqual([])

      await wipe(ns)
    })
  })

  describe('ioredis · durable', () => {
    it('hands a claim to a driver that did not take it, the crash path', async () => {
      // the difference from memory in one test: its claim is a Map in the
      // process that took it, so a restart loses the window. Here the claim is
      // in Redis, and whoever comes back can still settle it.
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 4 },
      ])
      const claim = await crashed.claim(M, 2000)

      const restarted = ioredis(live, { namespace: ns })
      await expect(restarted.ack(claim)).resolves.toBeUndefined()
      expect(await restarted.readBuckets({ metric: M })).toEqual([])

      await wipe(ns)
    })

    it('lets a restarted driver release a window the old one had claimed', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 4 },
      ])
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
    it('keeps a claim registered when its release meets a cell of another kind', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', delta: 1 },
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: 'b', delta: 2 },
      ])
      const claim = await driver.claim(M, 2000)
      // a gauge fold an older driver left in the claimed window
      await live.hset(`${ns}:b:${M}:1000`, 'a', '1|1|1|1|1')
      await live.zadd(`${ns}:idx:${M}`, 1000, '1000')

      await expect(driver.release(claim)).rejects.toThrow(/different kinds/)
      // still named, so a retried release or a recovery pass can finish it
      expect(await live.zrange(`${ns}:claims:${M}`, '0', '-1')).toEqual([claim.id])
      // the cell that clashed is still in the claim, whatever was restored before it
      expect(await live.hget(`${ns}:inflight:${claim.id}`, '1000:a')).toBe('1')
      await wipe(ns)
    })

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
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 4 },
      ])
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
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 5 },
      ])
      await crashed.claim(M, 2000)

      const survivor = sweeper(ns)
      await survivor.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 2 },
      ])
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
        { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 5 },
        { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 2 },
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
      // an empty claim moves nothing, so there is no in-flight key at all,
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
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      const claim = await driver.claim(M, 2000)

      expect((await driver.recover(M)).claims).toBe(0)
      // untouched, so the flush still writing it can settle it normally
      await expect(driver.ack(claim)).resolves.toBeUndefined()

      await wipe(ns)
    })

    it('reports when the oldest recovered claim was taken', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      const before = Date.now()
      const first = await crashed.claim(M, 2000)
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
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
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      const claim = await crashed.claim(M, 2000)

      await sweeper(ns).recover(M)
      await expect(crashed.ack(claim)).rejects.toThrow(/not in flight/)

      await wipe(ns)
    })

    it('lets only one of two racing sweepers take a claim', async () => {
      const ns = fresh()
      const crashed = ioredis(live, { namespace: ns })
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 6 },
      ])
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
      await crashed.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      await crashed.claim(M, 2000)

      const survivor = sweeper(ns)
      await survivor.recover(M)
      await survivor.ack(await survivor.claim(M, 2000))

      const left = (await live.keys(`${ns}:*`)).filter((k) => !survives(ns, k))
      expect(left).toEqual([])

      await wipe(ns)
    })

    it('recovers and acks claims taken under ids from the old Redis counter', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      // two claims an earlier version left in flight, one stranded and one
      // still owned by a process that is about to ack it
      await live.hset(`${ns}:inflight:${M}#7`, `1000:${WILLOW}`, '4')
      await live.zadd(`${ns}:claims:${M}`, 1, `${M}#7`)
      await live.hset(`${ns}:inflight:${M}#8`, `1000:${WILLOW}`, '5')
      await live.zadd(`${ns}:claims:${M}`, Date.now() + 60_000, `${M}#8`)

      expect(await driver.recover(M)).toEqual({
        claims: 1,
        buckets: 1,
        records: 0,
        oldestClaimedAt: 1,
      })
      expect(await driver.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 4 },
      ])
      await driver.ack({ kind: 'buckets', id: `${M}#8`, metric: M, claimedAt: 1, buckets: [] })
      expect(await live.zrange(`${ns}:claims:${M}`, '0', '-1')).toEqual([])
      expect(await live.exists(`${ns}:inflight:${M}#8`)).toBe(0)

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
          driver.increment([
            { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
          ]),
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
          driver.observe([
            { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: i },
          ]),
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
      await a.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])

      // both flushers run; only one can carry the window, and they must not
      // collide on the key their claim lives at
      const [first, second] = await Promise.all([a.claim(M, 2000), b.claim(M, 2000)])
      expect(first.id).not.toBe(second.id)
      expect(first.buckets.length + second.buckets.length).toBe(1)

      await wipe(ns)
    })

    it('gives a claim an id no earlier claim had after Redis loses recent writes', async () => {
      const ns = fresh()
      const one = ioredis(live, { namespace: ns })
      await one.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      const first = await one.claim(M, 2000)
      // what a restart that lost its last second of writes can leave behind:
      // every counter Redis kept rolled back, and the claim still in flight
      for (const key of await live.keys(`${ns}:seq*`)) await live.del(key)

      const other = ioredis(live, { namespace: ns })
      await other.increment([
        { metric: M, bucketTs: 2000, resolutionMs: 1000, dimKey: WILLOW, delta: 2 },
      ])
      const second = await other.claim(M, 3000)
      expect(second.id).not.toBe(first.id)

      // settling one leaves the other in flight for its owner
      await other.ack(second)
      await expect(one.ack(first)).resolves.toBeUndefined()

      await wipe(ns)
    })
  })

  describe('ioredis · scripts', () => {
    it('reloads a script Redis has forgotten', async () => {
      // a Redis restart or a SCRIPT FLUSH invalidates every cached SHA at
      // once. The driver must notice and reload rather than fail the write.
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.observe([
        { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 5 },
      ])

      await live.script('FLUSH')

      await expect(
        driver.observe([
          { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 7 },
        ]),
      ).resolves.toBeUndefined()
      expect(await live.hget(`${ns}:b:${G}:1000`, WILLOW)).toBe('7|5|7|12|2')

      await wipe(ns)
    })

    it('keeps the last level set of a burst Redis forgot its scripts during', async () => {
      // one set per turn of the event loop, so refusals come back while later
      // sets are still being made. Whether a set lands between two of them
      // depends on timing, so the burst runs several times
      const finals: number[] = []
      for (let round = 0; round < 15; round++) {
        const ns = fresh()
        const driver = ioredis(live, { namespace: ns })
        const set = (value: number) =>
          driver.setLevel([
            { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value, mode: 'set' },
          ])
        await set(0)

        const writes: Promise<void>[] = []
        for (let value = 1; value <= 200; value++) {
          if (value === 190) void live.script('FLUSH')
          writes.push(set(value))
          await new Promise((resolve) => setImmediate(resolve))
        }
        await Promise.all(writes)
        for (const series of await driver.readLevels(M)) finals.push(series.value)

        await wipe(ns)
      }
      expect(finals).toEqual(Array.from({ length: 15 }, () => 200))
    })

    it('lands a write ahead of a claim made while Redis was refusing the write', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const at = (bucketTs: number) => ({
        metric: M,
        bucketTs,
        resolutionMs: 1000,
        dimKey: WILLOW,
        delta: 1,
      })
      await driver.increment([at(1000)])
      await live.script('FLUSH')
      // a claim of another metric, the first call after the flush, so the
      // claim script is the one Redis is asked for first
      await driver.claim('other', 0)

      // the write is refused, and the claim made before that refusal comes
      // back must not run ahead of the write's resend
      const write = driver.increment([at(2000)])
      const claim = driver.claim(M, 10_000)
      await write
      const { buckets } = await claim

      expect(buckets.map(({ bucketTs, values }) => [bucketTs, Object.fromEntries(values)])).toEqual(
        [
          [1000, { [WILLOW]: 1 }],
          [2000, { [WILLOW]: 1 }],
        ],
      )

      await wipe(ns)
    })

    it('reads a write made before the read while Redis was refusing the write', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const at = (bucketTs: number) => ({
        metric: M,
        bucketTs,
        resolutionMs: 1000,
        dimKey: WILLOW,
        delta: 1,
      })
      await driver.increment([at(1000)])
      await live.script('FLUSH')

      const write = driver.increment([at(2000)])
      const read = driver.readBuckets({ metric: M })
      await write

      expect(await read).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 1 },
        { bucketTs: 2000, dimKey: WILLOW, value: 1 },
      ])

      await wipe(ns)
    })

    it('loads every script once, together, for the calls that first need one', async () => {
      const ns = fresh()
      const loads: unknown[] = []
      const counting = new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'script') return Reflect.get(target, prop, receiver)
          return (...args: [string, ...unknown[]]) => {
            if (args[0] === 'LOAD') loads.push(args[1])
            return target.script(...(args as Parameters<typeof target.script>))
          }
        },
      })
      const driver = ioredis(counting, { namespace: ns })
      // two calls on two scripts at once, both waiting on the one load
      await Promise.all([
        driver.setLevel([
          { metric: M, bucketTs: 0, resolutionMs: 1000, dimKey: WILLOW, value: 1, mode: 'set' },
        ]),
        driver.increment([
          { metric: G, bucketTs: 0, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
        ]),
      ])
      expect(loads).toHaveLength(20)
      expect(new Set(loads).size).toBe(20)
      loads.length = 0

      // a first carry sends one hold script per window, and the set is loaded
      await driver.setLevel(
        Array.from({ length: 20 }, (_, i) => ({
          metric: M,
          bucketTs: (i + 1) * 1000,
          resolutionMs: 1000,
          dimKey: WILLOW,
          value: 1,
          mode: 'hold' as const,
        })),
      )
      expect(loads).toEqual([])
      expect((await driver.readLevels(M))[0]?.heldThrough).toBe(20_000)

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

      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      expect(calls).toBe(1)

      await wipe(ns)
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
      // the halves, but the halves must not overlap or drop
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns, maxPipelineSize: 7 })
      await driver.increment(
        Array.from({ length: 50 }, () => ({
          metric: M,
          bucketTs: 1000,
          resolutionMs: 1000,
          dimKey: WILLOW,
          delta: 1,
        })),
      )

      expect(await driver.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 50 },
      ])

      await wipe(ns)
    })

    it('applies a write once when Redis receives it twice', async () => {
      // what ioredis does after a reconnect: a command whose reply was lost
      // is sent again, although it may already have run
      const ns = fresh()
      const twice = new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'pipeline') return Reflect.get(target, prop, receiver)
          return () => {
            const pipeline = target.pipeline()
            const evalsha = pipeline.evalsha.bind(pipeline)
            pipeline.evalsha = ((...args: Parameters<typeof evalsha>) => {
              evalsha(...args)
              return evalsha(...args)
            }) as typeof pipeline.evalsha
            return pipeline
          }
        },
      })
      const driver = ioredis(twice, { namespace: ns })

      await driver.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 5 },
      ])
      await driver.observe([
        { metric: G, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value: 3 },
      ])
      await driver.setLevel([
        {
          metric: 'lvl',
          bucketTs: 1000,
          resolutionMs: 1000,
          dimKey: WILLOW,
          value: 2,
          mode: 'add',
        },
      ])
      await driver.append([{ metric: 'ev', id: 'a', ts: 1000, fields: {} }])

      expect((await driver.readBuckets({ metric: M }))[0]?.value).toBe(5)
      expect((await driver.readBuckets({ metric: G }))[0]?.value).toMatchObject({ count: 1 })
      expect((await driver.readLevels('lvl'))[0]?.value).toBe(2)
      expect(await driver.countPending('ev')).toBe(1)

      await wipe(ns)
    })

    /**
     * A client on which every script runs twice and only the second reply
     * comes back: a command whose reply was lost, resent after a reconnect.
     */
    const lostReply = () =>
      new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'pipeline') return Reflect.get(target, prop, receiver)
          return () => {
            const pipeline = target.pipeline()
            const evalsha = pipeline.evalsha.bind(pipeline)
            const exec = pipeline.exec.bind(pipeline)
            pipeline.evalsha = ((...args: Parameters<typeof evalsha>) => {
              evalsha(...args)
              return evalsha(...args)
            }) as typeof pipeline.evalsha
            pipeline.exec = (async () => {
              const results = await exec()
              return results?.filter((_, i) => i % 2 === 1) ?? null
            }) as typeof pipeline.exec
            return pipeline
          }
        },
      })

    it('acks a claim whose reply was lost and resent', async () => {
      const ns = fresh()
      const plain = ioredis(live, { namespace: ns })
      await plain.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      const claim = await plain.claim(M, 2000)

      await expect(ioredis(lostReply(), { namespace: ns }).ack(claim)).resolves.toBeUndefined()
      expect(await plain.readBuckets({ metric: M })).toEqual([])
      await wipe(ns)
    })

    it('releases a claim whose reply was lost and resent, once', async () => {
      const ns = fresh()
      const plain = ioredis(live, { namespace: ns })
      await plain.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      const claim = await plain.claim(M, 2000)

      await expect(ioredis(lostReply(), { namespace: ns }).release(claim)).resolves.toBeUndefined()
      expect(await plain.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 1 },
      ])
      await wipe(ns)
    })

    it('reports what a recovery put back when its reply was lost and resent', async () => {
      const ns = fresh()
      const plain = ioredis(live, { namespace: ns })
      await plain.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      await plain.claim(M, 2000)

      const resent = ioredis(lostReply(), { namespace: ns, recoverAfter: 0 })
      expect(await resent.recover(M)).toMatchObject({ claims: 1, buckets: 1, records: 0 })
      expect(await plain.readBuckets({ metric: M })).toEqual([
        { bucketTs: 1000, dimKey: WILLOW, value: 1 },
      ])
      await wipe(ns)
    })

    it('grants a turn whose reply was lost and resent', async () => {
      const ns = fresh()
      const resent = ioredis(lostReply(), { namespace: ns })

      const answer = await resent.takeTurn?.(M, 5000, 1000)
      if (!answer?.granted) throw new Error('expected the turn to be granted')
      expect(answer.previous).toBeUndefined()
      expect(await live.get(`${ns}:turn:${M}`)).toBe('5000')
      expect(await live.get(`${ns}:turntok:${M}`)).toBe(answer.turn.token)
      await wipe(ns)
    })

    it('reads a turn 0.7.0 recorded as the time alone, and gives it back the same way', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.set(`${ns}:turn:${M}`, '5000')

      expect(await driver.takeTurn?.(M, 5500, 1000)).toEqual({ granted: false, lastTakenAt: 5000 })
      const answer = await driver.takeTurn?.(M, 6000, 1000)
      if (!answer?.granted) throw new Error('expected the turn to be granted')
      expect(answer.previous).toEqual({ at: 5000, token: '' })

      await driver.returnTurn?.(M, answer.turn, answer.previous)
      // what 0.7.0's own script parses: the time and nothing after it
      expect(await live.get(`${ns}:turn:${M}`)).toBe('5000')
      expect(await live.exists(`${ns}:turntok:${M}`)).toBe(0)
      expect(await driver.takeTurn?.(M, 5500, 1000)).toEqual({ granted: false, lastTakenAt: 5000 })
      await wipe(ns)
    })

    it('rewrites a turn stored as at|token into the time and a token key', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.set(`${ns}:turn:${M}`, '5000|abc')

      expect(await driver.takeTurn?.(M, 5500, 1000)).toEqual({ granted: false, lastTakenAt: 5000 })
      expect(await live.get(`${ns}:turn:${M}`)).toBe('5000')
      expect(await live.get(`${ns}:turntok:${M}`)).toBe('abc')

      const answer = await driver.takeTurn?.(M, 6000, 1000)
      if (!answer?.granted) throw new Error('expected the turn to be granted')
      expect(answer.previous).toEqual({ at: 5000, token: 'abc' })
      await driver.returnTurn?.(M, answer.turn, answer.previous)
      expect(await live.get(`${ns}:turn:${M}`)).toBe('5000')
      expect(await live.get(`${ns}:turntok:${M}`)).toBe('abc')
      await wipe(ns)
    })

    it('gives back a turn still stored as at|token', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.set(`${ns}:turn:${M}`, '5000|abc')

      await driver.returnTurn?.(M, { at: 5000, token: 'abc' }, { at: 4000, token: '' })
      expect(await live.get(`${ns}:turn:${M}`)).toBe('4000')
      expect(await live.exists(`${ns}:turntok:${M}`)).toBe(0)
      await wipe(ns)
    })

    it('claims at most limit records when the claim was resent', async () => {
      const ns = fresh()
      const plain = ioredis(live, { namespace: ns })
      await plain.append(
        ['a', 'b', 'c', 'd'].map((id) => ({ metric: M, id, ts: 1000, fields: {} })),
      )

      const claim = await ioredis(lostReply(), { namespace: ns }).claimRecords(M, 2)
      expect(claim.records.map((r) => r.id)).toEqual(['a', 'b'])
      expect((await plain.readPending({ metric: M })).map((r) => r.id)).toEqual(['c', 'd'])
      await wipe(ns)
    })

    it('refuses a resent level batch again rather than applying its first half', async () => {
      const ns = fresh()
      const twice = new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'pipeline') return Reflect.get(target, prop, receiver)
          return () => {
            const pipeline = target.pipeline()
            const evalsha = pipeline.evalsha.bind(pipeline)
            pipeline.evalsha = ((...args: Parameters<typeof evalsha>) => {
              evalsha(...args)
              return evalsha(...args)
            }) as typeof pipeline.evalsha
            return pipeline
          }
        },
      })
      const driver = ioredis(twice, { namespace: ns })
      await expect(
        driver.setLevel([
          { metric: 'lvl', bucketTs: 1000, resolutionMs: 1000, dimKey: 'a', value: 5, mode: 'add' },
          {
            metric: 'lvl',
            bucketTs: 1000,
            resolutionMs: 1000,
            dimKey: 'b',
            value: Number.MAX_VALUE,
            mode: 'add',
          },
          {
            metric: 'lvl',
            bucketTs: 1000,
            resolutionMs: 1000,
            dimKey: 'b',
            value: Number.MAX_VALUE,
            mode: 'add',
          },
        ]),
      ).rejects.toThrow(/largest number/)
      expect(await driver.readLevels('lvl')).toEqual([])
      await wipe(ns)
    })

    /**
     * A reader whose client runs `between` once, right after the first
     * script reply it gets: another process acting between two pages.
     */
    const pausing = (between: () => Promise<unknown>) => {
      let fired = false
      const once = async () => {
        if (fired) return
        fired = true
        await between()
      }
      return new Proxy(live, {
        get(target, prop, receiver) {
          // a page is read either as a script or as a plain LRANGE
          if (prop === 'lrange') {
            return async (...args: Parameters<typeof target.lrange>) => {
              const page = await target.lrange(...args)
              await once()
              return page
            }
          }
          if (prop !== 'pipeline') return Reflect.get(target, prop, receiver)
          return () => {
            const pipeline = target.pipeline()
            const exec = pipeline.exec.bind(pipeline)
            pipeline.exec = (async () => {
              const results = await exec()
              await once()
              return results
            }) as typeof pipeline.exec
            return pipeline
          }
        },
      })
    }

    it('reads every staged record when a claim lands between pages', async () => {
      const ns = fresh()
      const other = ioredis(live, { namespace: ns })
      await other.append(
        ['a', 'b', 'c', 'd'].map((id, i) => ({ metric: 'ev', id, ts: 1000 + i, fields: {} })),
      )
      const reader = ioredis(
        pausing(() => other.claimRecords('ev', 2)),
        { namespace: ns, maxPipelineSize: 2 },
      )
      const read = await reader.readPending({ metric: 'ev', from: 0 })
      // a and b were read before the claim took them, and c and d stayed staged
      expect(read.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
      await wipe(ns)
    })

    it('reads no record twice when a release lands between pages', async () => {
      const ns = fresh()
      const other = ioredis(live, { namespace: ns })
      await other.append(
        ['a', 'b', 'c', 'd'].map((id, i) => ({ metric: 'ev', id, ts: 1000 + i, fields: {} })),
      )
      const claim = await other.claimRecords('ev', 2)
      const reader = ioredis(
        pausing(() => other.release(claim)),
        { namespace: ns, maxPipelineSize: 2 },
      )
      const read = await reader.readPending({ metric: 'ev', from: 0 })
      expect(read.map((r) => r.id)).toEqual(['c', 'd'])
      await wipe(ns)
    })

    it('keeps the sets of one writer in order while a script is still loading', async () => {
      // the first call has to load its script, and the calls behind it must
      // not overtake it once the script is cached
      const ns = fresh()
      let loads = 0
      const slowLoad = new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'script') return Reflect.get(target, prop, receiver)
          return async (...args: unknown[]) => {
            loads += 1
            if (loads === 1) await new Promise((resolve) => setTimeout(resolve, 50))
            return (target.script as (...a: unknown[]) => Promise<unknown>)(...args)
          }
        },
      })
      const driver = ioredis(slowLoad, { namespace: ns })
      const set = (value: number) =>
        driver.setLevel([
          { metric: 'lvl', bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, value, mode: 'set' },
        ])

      const first = set(1)
      await new Promise((resolve) => setTimeout(resolve, 10))
      await Promise.all([first, set(2), set(3)])

      expect((await driver.readLevels('lvl'))[0]?.value).toBe(3)
      await wipe(ns)
    })

    it('ages a claim by Redis time, whatever the recovering host believes', async () => {
      const ns = fresh()
      const claimer = ioredis(live, { namespace: ns })
      await claimer.increment([
        { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
      ])
      await claimer.claim(M, 2000)

      // a host whose clock runs two minutes fast
      const now = Date.now
      Date.now = () => now() + 120_000
      try {
        const fast = ioredis(live, { namespace: ns, recoverAfter: '5s' })
        expect(await fast.recover(M)).toMatchObject({ claims: 0 })
      } finally {
        Date.now = now
      }

      await wipe(ns)
    })

    it('takes a burst of 150,000 writes without waiting on each other', {
      timeout: 120_000,
    }, async () => {
      // every write is issued before any reply comes back, as in a batch
      // import. The floor of waiting writes used to be a scan of all of them
      // on every send, quadratic, and past 125,000 it overflowed the stack
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      const writes: Promise<void>[] = []
      for (let i = 0; i < 150_000; i++) {
        writes.push(
          driver.increment([
            { metric: M, bucketTs: 1000, resolutionMs: 1000, dimKey: WILLOW, delta: 1 },
          ]),
        )
      }
      await Promise.all(writes)

      expect((await driver.readBuckets({ metric: M }))[0]?.value).toBe(150_000)
      await wipe(ns)
    })

    it('appends 150,000 records in one call', { timeout: 60_000 }, async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await driver.append(
        Array.from({ length: 150_000 }, (_, i) => ({ metric: M, id: `r${i}`, ts: i, fields: {} })),
      )
      expect(await driver.countPending(M)).toBe(150_000)
      await wipe(ns)
    })

    it('carries many series through a gap in one script per window', async () => {
      const ns = fresh()
      let scripts = 0
      const counting = new Proxy(live, {
        get(target, prop, receiver) {
          if (prop !== 'pipeline') return Reflect.get(target, prop, receiver)
          return () => {
            const pipeline = target.pipeline()
            const evalsha = pipeline.evalsha.bind(pipeline)
            pipeline.evalsha = ((...args: Parameters<typeof evalsha>) => {
              scripts += 1
              return evalsha(...args)
            }) as typeof pipeline.evalsha
            return pipeline
          }
        },
      })
      const driver = ioredis(counting, { namespace: ns })
      for (let s = 0; s < 50; s++) {
        await driver.setLevel([
          { metric: M, bucketTs: 0, resolutionMs: 1000, dimKey: `s${s}`, value: s, mode: 'set' },
        ])
      }
      scripts = 0

      // what a level flush sends after sorting by window: 50 series, 5 windows
      const holds = []
      for (let w = 1; w <= 5; w++) {
        for (let s = 0; s < 50; s++) {
          holds.push({
            metric: M,
            bucketTs: w * 1000,
            resolutionMs: 1000,
            dimKey: `s${s}`,
            value: s,
            mode: 'hold' as const,
          })
        }
      }
      await driver.setLevel(holds)
      expect(scripts).toBe(5)
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
      await driver.setLevel([
        { metric: M, bucketTs: 0, resolutionMs: 1000, dimKey: WILLOW, value: 1, mode: 'set' },
      ])
      sizes.length = 0

      await driver.setLevel(
        Array.from({ length: 45 }, (_, i) => ({
          metric: M,
          bucketTs: (i + 1) * 1000,
          resolutionMs: 1000,
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

    it('puts a record staged before sequence stamps back ahead of stamped ones', async () => {
      const ns = fresh()
      const driver = ioredis(live, { namespace: ns })
      await live.rpush(`${ns}:e:${M}`, JSON.stringify({ id: 'old', ts: 1000, fields: {} }))
      await driver.append([{ metric: M, id: 'new', ts: 2000, fields: {} }])

      await driver.release(await driver.claimRecords(M))
      expect((await driver.readPending({ metric: M })).map((r) => r.id)).toEqual(['old', 'new'])

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
