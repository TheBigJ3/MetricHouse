import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { createHouse } from '../runtime/house.js'
import type { LiveRow } from '../runtime/live.js'
import { oneOf, str, ts } from '../schema/types.js'
import { counter } from './counter.js'
import { gauge } from './gauge.js'

let clock: number
let driver: Driver
const now = () => clock

beforeEach(() => {
  clock = 1_788_616_987_482
  driver = memory()
})

function dogs() {
  const metric = counter('dog_poops', {
    dims: { dogName: str(), park: str(), seen: ts().optional() },
    resolution: '1s',
    flush: '5m',
    write: () => {},
  })
  metric.bind({ driver, now })
  return metric
}

/** The rows an unfiltered snapshot holds that match `filter`, as a reader would pick them. */
function byHand(rows: readonly LiveRow[], filter: Record<string, unknown>): LiveRow[] {
  return rows.filter((row) =>
    Object.entries(filter).every(([key, wanted]) => {
      const actual = row[key]
      if (actual instanceof Date && wanted instanceof Date) {
        return actual.getTime() === wanted.getTime()
      }
      return actual === wanted
    }),
  )
}

describe('bucketedReader', () => {
  it('returns the rows of an unfiltered snapshot that match the dims filter', async () => {
    const metric = dogs()
    metric.add({ dogName: 'Willow', park: 'riverside' })
    metric.add(2, { dogName: 'Rex', park: 'riverside', seen: new Date(5000) })
    metric.add(3, { dogName: 'Willow', park: 'hilltop', seen: new Date(5000) })
    clock += 1000
    metric.add(4, { dogName: 'Willow', park: 'riverside' })
    await metric.drain()

    const every = await metric.snapshot({ complete: false })
    expect(every).toHaveLength(4)
    for (const filter of [
      { park: 'riverside' },
      { dogName: 'Willow', park: 'riverside' },
      { seen: new Date(5000) },
      { park: 'nowhere' },
    ]) {
      expect(await metric.snapshot({ complete: false, dims: filter })).toEqual(
        byHand(every, filter),
      )
    }
    expect(
      (await metric.snapshot({ complete: false, dims: { park: 'riverside' } })).map(
        (row) => row.value,
      ),
    ).toEqual([2, 1, 4])
  })

  it('returns the matching gauge rows with their folds', async () => {
    const weight = gauge('dog_weight', {
      dims: { dogName: str(), size: oneOf(['small', 'large']) },
      resolution: '1s',
      flush: '5m',
      write: () => {},
    })
    weight.bind({ driver, now })
    weight.set(12, { dogName: 'Willow', size: 'small' })
    weight.set(14, { dogName: 'Willow', size: 'small' })
    weight.set(40, { dogName: 'Rex', size: 'large' })
    await weight.drain()

    const every = await weight.snapshot({ complete: false })
    const small = await weight.snapshot({ complete: false, dims: { size: 'small' } })
    expect(small).toEqual(byHand(every, { size: 'small' }))
    expect(small).toHaveLength(1)
  })

  it('refuses a filter naming an undeclared dim with the error an unfiltered read gives', async () => {
    const metric = dogs()
    metric.add({ dogName: 'Willow', park: 'riverside' })
    await metric.drain()

    await expect(metric.snapshot({ complete: false, dims: { pakr: 'riverside' } })).rejects.toThrow(
      'dog_poops: dims names "pakr", which is not a declared dim. This metric has ' +
        '[dogName, park, seen]',
    )
  })

  it('fails on a cell of another kind even when the filter drops its row', async () => {
    const metric = dogs()
    metric.add({ dogName: 'Willow', park: 'riverside' })
    await driver.observe([
      { metric: 'dog_poops', bucketTs: 1_788_616_987_000, dimKey: 'Rex|hilltop|\\0', value: 3 },
    ])
    await metric.drain()

    await expect(metric.snapshot({ complete: false, dims: { park: 'riverside' } })).rejects.toThrow(
      'dog_poops: expected a counter cell but the driver returned a gauge fold',
    )
  })

  it('fails on a key it cannot read with the error building that row gives', async () => {
    const metric = dogs()
    await driver.increment([
      { metric: 'dog_poops', bucketTs: 1_788_616_987_000, dimKey: 'Rex|hilltop|\\0|x', delta: 1 },
    ])

    await expect(metric.snapshot({ complete: false, dims: { park: 'riverside' } })).rejects.toThrow(
      'decodeDimKey: expected at most 3 segments for [dogName, park, seen], got 4',
    )
  })
})

describe('bucketedLifecycle', () => {
  it('lets an immediate send already under way reach the sink before the flush row', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0
    const held: Driver = {
      ...driver,
      readBuckets: async (query) => {
        const rows = await driver.readBuckets(query)
        reads += 1
        // the first send has read its running total, and is slow to send it
        if (reads === 1) await gate
        return rows
      },
    }
    const sent: [string, unknown][] = []
    const visits = counter('visits', {
      resolution: '1s',
      flush: '5m',
      write: (rows, context) => {
        for (const row of rows) sent.push([context.source, row.value])
      },
    })
    createHouse({ driver: held, schema: [visits], delivery: 'immediate', now })

    visits.add()
    await vi.waitFor(() => expect(reads).toBe(1))
    visits.add()
    await vi.waitFor(() => expect(sent).toEqual([['immediate', 2]]))
    clock += 3_000
    const flushing = visits.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await flushing

    expect(sent).toEqual([
      ['immediate', 2],
      ['immediate', 1],
      ['flush', 2],
    ])
  })
})
