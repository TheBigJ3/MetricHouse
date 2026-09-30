import { beforeEach, describe, expect, it } from 'vitest'
import { memory } from '../drivers/memory.js'
import { counter } from '../metrics/counter.js'
import type { Row, WriteContext } from '../metrics/types.js'
import { createHouse } from './house.js'

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
})
