import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { counter } from '../metrics/counter.js'
import type { Row, WriteContext } from '../metrics/types.js'
import { createHouse } from './house.js'
import { readOpenWindow } from './ship.js'

let clock: number
const now = () => clock

/** Exactly on a one second boundary. */
const T = 1_788_616_987_000

beforeEach(() => {
  clock = T
})

describe('shipOpenSeries', () => {
  it('sends every live window from the one a moved write aimed at, the landing one included', async () => {
    const sent: [WriteContext['source'], number, number][] = []
    const spans: [number, number][] = []
    let failFlush = false
    const visits = counter('visits', {
      resolution: '1s',
      flush: '5m',
      write: (rows: Row[], context) => {
        if (context.source === 'flush' && failFlush) throw new Error('clickhouse is down')
        spans.push([context.bucketFrom, context.bucketTo])
        for (const row of rows) {
          sent.push([context.source, (row.bucket_ts as Date).getTime(), row.value as number])
        }
      },
    })
    const house = createHouse({
      driver: memory(),
      schema: [visits],
      delivery: 'immediate',
      now,
      onError: () => {},
    })

    // the window at T ships and is gone
    visits.add()
    await house.drain()
    clock = T + 3_000
    await visits.flush()

    // the window at T + 1s is claimed, fails, and goes back live
    clock = T + 1_500
    visits.add()
    await house.drain()
    clock = T + 4_000
    failFlush = true
    await visits.flush({ force: true })
    failFlush = false

    // a write stamped inside the window that shipped lands at T + 2s, behind
    // the released one
    sent.length = 0
    spans.length = 0
    clock = T + 500
    visits.add()
    await house.drain()

    expect(sent).toEqual([
      ['immediate', T + 1_000, 1],
      ['immediate', T + 2_000, 1],
    ])
    expect(spans).toEqual([[T + 1_000, T + 3_000]])
  })

  it('sends the landing window of a write aimed at a released window', async () => {
    const sent: [number, number][] = []
    let failFlush = false
    const visits = counter('visits', {
      resolution: '1s',
      flush: '5m',
      write: (rows: Row[], context) => {
        if (context.source === 'flush' && failFlush) throw new Error('clickhouse is down')
        if (context.source !== 'immediate') return
        for (const row of rows) sent.push([(row.bucket_ts as Date).getTime(), row.value as number])
      },
    })
    const house = createHouse({
      driver: memory(),
      schema: [visits],
      delivery: 'immediate',
      now,
      onError: () => {},
    })

    // the window at T + 1s is claimed, fails, and goes back live behind the
    // watermark
    clock = T + 1_500
    visits.add()
    await house.drain()
    clock = T + 4_000
    failFlush = true
    await visits.flush()
    failFlush = false

    // aimed at the released window, and moved forward to T + 2s
    sent.length = 0
    clock = T + 1_500
    visits.add()
    await house.drain()

    expect(sent).toEqual([
      [T + 1_000, 1],
      [T + 2_000, 1],
    ])
  })
})

describe('shipOpenSeries and where a write landed', () => {
  /** A memory driver that counts how often it is asked where a write landed. */
  function counting(): { driver: Driver; asked: number[] } {
    const inner = memory()
    const asked: number[] = []
    const driver: Driver = {
      ...inner,
      landing: async (metric, bucketTs, resolutionMs) => {
        asked.push(bucketTs)
        return (await inner.landing?.(metric, bucketTs, resolutionMs)) as number
      },
    }
    return { driver, asked }
  }

  function visitsSending(sent: [number, number][]) {
    return counter('visits', {
      resolution: '1s',
      flush: '5m',
      write: (rows: Row[], context) => {
        if (context.source !== 'immediate') return
        for (const row of rows) sent.push([(row.bucket_ts as Date).getTime(), row.value as number])
      },
    })
  }

  it('does not ask the driver when no claim of this process reaches the aimed window', async () => {
    const { driver, asked } = counting()
    const sent: [number, number][] = []
    const visits = visitsSending(sent)
    const house = createHouse({ driver, schema: [visits], delivery: 'immediate', now })

    visits.add()
    await house.drain()
    visits.add()
    await house.drain()

    expect(sent).toEqual([
      [T, 1],
      [T, 2],
    ])
    expect(asked).toEqual([])
  })

  it('asks the driver when the aimed window reads back empty, and sends where the write landed', async () => {
    const { driver, asked } = counting()
    const sent: [number, number][] = []
    const visits = visitsSending(sent)
    const house = createHouse({ driver, schema: [visits], delivery: 'immediate', now })

    // another process writes the window at T and claims it, so this process
    // has claimed nothing
    await driver.increment([
      { metric: 'visits', bucketTs: T, resolutionMs: 1000, dimKey: '', delta: 1 },
    ])
    await driver.ack(await driver.claim('visits', T + 1_000))
    visits.add()
    await house.drain()

    expect(sent).toEqual([[T + 1_000, 1]])
    expect(asked).toEqual([T])
  })

  it('asks the driver once this process has claimed at or past the aimed window', async () => {
    const { driver, asked } = counting()
    const sent: [number, number][] = []
    const visits = visitsSending(sent)
    const house = createHouse({ driver, schema: [visits], delivery: 'immediate', now })

    visits.add()
    await house.drain()
    clock = T + 3_000
    await visits.flush()
    sent.length = 0
    clock = T + 500
    visits.add()
    await house.drain()

    expect(sent).toEqual([[T + 1_000, 1]])
    expect(asked).toEqual([T])
  })
})

describe('readOpenWindow', () => {
  let driver: Driver

  beforeEach(() => {
    driver = memory()
  })

  /** A counter at 1s whose window at 1000 has shipped, with a write moved past it. */
  async function moved(): Promise<void> {
    await driver.increment([
      { metric: 'visits', bucketTs: 5000, resolutionMs: 1000, dimKey: 'Willow', delta: 1 },
    ])
    await driver.ack(await driver.claim('visits', 6000))
    await driver.increment([
      { metric: 'visits', bucketTs: 1000, resolutionMs: 1000, dimKey: 'Willow', delta: 4 },
    ])
  }

  it('reads the window a write moved past the watermark landed in', async () => {
    await moved()
    const read = (bucketTs: number) =>
      driver.readBuckets({ metric: 'visits', from: bucketTs, to: bucketTs + 1000 })

    expect(await readOpenWindow(driver, 'visits', 1000, 1000, read)).toEqual([
      { bucketTs: 6000, dimKey: 'Willow', value: 4 },
    ])
  })

  it('reads the aimed window once when no write was moved', async () => {
    await driver.increment([
      { metric: 'visits', bucketTs: 1000, resolutionMs: 1000, dimKey: 'Willow', delta: 2 },
    ])
    const asked: number[] = []
    const read = (bucketTs: number) => {
      asked.push(bucketTs)
      return driver.readBuckets({ metric: 'visits', from: bucketTs, to: bucketTs + 1000 })
    }

    expect(await readOpenWindow(driver, 'visits', 1000, 1000, read)).toEqual([
      { bucketTs: 1000, dimKey: 'Willow', value: 2 },
    ])
    expect(asked).toEqual([1000])
  })

  it('asks for the aimed window and the landing window at once', async () => {
    await moved()
    const order: string[] = []
    const slow: Driver = {
      ...driver,
      landing: async (metric, bucketTs, resolutionMs) => {
        order.push('landing asked')
        const at = await driver.landing?.(metric, bucketTs, resolutionMs)
        order.push('landing answered')
        return at as number
      },
    }
    const read = async (bucketTs: number) => {
      order.push(`read ${bucketTs}`)
      return driver.readBuckets({ metric: 'visits', from: bucketTs, to: bucketTs + 1000 })
    }

    await readOpenWindow(slow, 'visits', 1000, 1000, read)
    expect(order).toEqual(['landing asked', 'read 1000', 'landing answered', 'read 6000'])
  })

  it('reads the aimed window on a driver without landing', async () => {
    const { landing: _, ...plain } = driver
    await moved()
    const read = (bucketTs: number) =>
      plain.readBuckets({ metric: 'visits', from: bucketTs, to: bucketTs + 1000 })

    expect(await readOpenWindow(plain, 'visits', 1000, 1000, read)).toEqual([])
  })
})
