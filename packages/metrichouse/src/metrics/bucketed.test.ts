import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { createHouse } from '../runtime/house.js'
import type { LiveRow } from '../runtime/live.js'
import { int, oneOf, str, ts } from '../schema/types.js'
import { counter } from './counter.js'
import { gauge } from './gauge.js'
import { level } from './level.js'
import { timer } from './timer.js'
import type { Row, WriteFn } from './types.js'

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
      {
        metric: 'dog_poops',
        bucketTs: 1_788_616_987_000,
        resolutionMs: 1000,
        dimKey: 'Rex|hilltop|\\0',
        value: 3,
      },
    ])
    await metric.drain()

    await expect(metric.snapshot({ complete: false, dims: { park: 'riverside' } })).rejects.toThrow(
      'dog_poops: expected a counter cell but the driver returned a gauge fold',
    )
  })

  it('fails on a key it cannot read with the error building that row gives', async () => {
    const metric = dogs()
    await driver.increment([
      {
        metric: 'dog_poops',
        bucketTs: 1_788_616_987_000,
        resolutionMs: 1000,
        dimKey: 'Rex|hilltop|\\0|x',
        delta: 1,
      },
    ])

    const rows = await metric.snapshot({ complete: false, dims: { park: 'hilltop' } })
    expect(rows.map(({ dogName, park, seen, value }) => ({ dogName, park, seen, value }))).toEqual([
      { dogName: 'Rex', park: 'hilltop', seen: undefined, value: 1 },
    ])
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

  /**
   * A one second counter under immediate delivery whose sink never answers
   * the immediate send numbered `hang`, and what reached the sink.
   */
  function hanging(hang: number) {
    const sent: [string, unknown][] = []
    const stuck: unknown[] = []
    let sends = 0
    const visits = counter('visits', {
      resolution: '1s',
      flush: '1s',
      write: (rows, context) => {
        if (context.source === 'immediate' && ++sends === hang) {
          stuck.push(rows[0]?.value)
          return new Promise(() => {})
        }
        for (const row of rows) sent.push([context.source, row.value])
      },
    })
    createHouse({ driver, schema: [visits], delivery: 'immediate', now })
    return { visits, sent, stuck }
  }

  it('does not wait for an immediate send aimed past the windows it claimed', async () => {
    const { visits, sent, stuck } = hanging(2)
    visits.add()
    await visits.drain()
    clock += 3_000
    // aimed at the open window, and its sink never answers
    visits.add()
    await vi.waitFor(() => expect(stuck).toEqual([1]))

    const report = await visits.flush()
    expect(report).toMatchObject({ rows: 1 })
    expect(sent).toEqual([
      ['immediate', 1],
      ['flush', 1],
    ])
  })

  it('stops waiting for a send aimed at a claimed window after one flush interval', async () => {
    const { visits, sent, stuck } = hanging(1)
    visits.add()
    await vi.waitFor(() => expect(stuck).toEqual([1]))
    clock += 3_000

    vi.useFakeTimers()
    try {
      let done = false
      const flushing = visits.flush().then((report) => {
        done = true
        return report
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await flushing).toMatchObject({ rows: 1 })
      expect(sent).toEqual([['flush', 1]])
    } finally {
      vi.useRealTimers()
    }
  })

  /** A one second counter that ships every second, and the values its sink received. */
  function perSecond(on: Driver = driver) {
    const shipped: number[] = []
    const metric = counter('dog_poops', {
      resolution: '1s',
      flush: '1s',
      write: (rows) => {
        for (const row of rows) shipped.push(row.value)
      },
    })
    metric.bind({ driver: on, now })
    return { metric, shipped }
  }

  it('ships the writes made after a flush on a clock two days ahead', async () => {
    const { metric, shipped } = perSecond()
    const start = clock
    metric.add(1)
    await metric.drain()
    clock = start + 2 * 86_400_000
    await metric.flush()
    expect(shipped).toEqual([1])

    // the clock is corrected, and the metric carries on as normal
    clock = start + 1000
    for (let i = 0; i < 60; i++) {
      metric.add(1)
      await metric.drain()
      clock += 1000
      await metric.flush()
    }

    // the first write, then every window since but the two still inside grace
    expect(shipped).toHaveLength(59)
    expect(shipped.reduce((sum, value) => sum + value, 0)).toBe(59)
  })

  it('ships in a final flush a write the watermark moved ahead of the clock', async () => {
    const { metric, shipped } = perSecond()
    metric.add(1)
    await metric.drain()
    clock += 3000
    await metric.flush()
    expect(shipped).toEqual([1])

    // an NTP correction steps the clock back four seconds
    clock -= 4000
    metric.add(5)
    await metric.drain()

    const report = await metric.flush({ final: true })
    expect(report.rows).toBe(1)
    expect(shipped).toEqual([1, 5])
  })

  it('ships in a final flush a window the clock stepped back behind', async () => {
    const { metric, shipped } = perSecond()
    clock += 5000
    metric.add(3)
    await metric.drain()
    clock -= 60_000

    const report = await metric.flush({ final: true })
    expect(report.rows).toBe(1)
    expect(shipped).toEqual([3])
  })

  it('leaves the window the clock is in out of a final flush', async () => {
    const { metric, shipped } = perSecond()
    metric.add(2)
    clock += 5000
    metric.add(3)
    await metric.drain()
    clock -= 5000

    await metric.flush({ final: true })
    expect(shipped).toEqual([3])
    expect((await metric.snapshot({ complete: false })).map((row) => row.value)).toEqual([2])
  })

  it('leaves windows ahead of the clock in storage that outlives the process', async () => {
    const durable: Driver = {
      ...driver,
      capabilities: { ...driver.capabilities, durable: true },
    }
    const { metric, shipped } = perSecond(durable)
    clock += 5000
    metric.add(3)
    await metric.drain()
    clock -= 60_000

    await metric.flush({ final: true })
    expect(shipped).toEqual([])
    expect((await metric.snapshot({ complete: false })).map((row) => row.value)).toEqual([3])
  })
})

describe('a stored key the current dims cannot read', () => {
  const at = 1_788_616_980_000
  const STORED = 'abc|\\0'

  /** One kind declared under `dims`, and the verb that kind writes one value with. */
  function declare(kind: string, dims: object, write: WriteFn) {
    const config = { dims, resolution: '1s', flush: '1m', write } as never
    const made = {
      counter: () => counter('m', config),
      gauge: () => gauge('m', config),
      level: () => level('m', config),
      timer: () => timer('m', config),
    }[kind as 'counter']()
    const metric = made as never as {
      bind(binding: object): void
      drain(): Promise<void>
      flush(): Promise<{ error?: unknown }>
      snapshot(options: object): Promise<Record<string, unknown>[]>
    }
    const put = (values: object) => {
      const verbs = made as never as Record<string, (...args: unknown[]) => void>
      if (kind === 'counter') verbs.add?.(values)
      else if (kind === 'timer') verbs.observe?.(1, values)
      else verbs.set?.(1, values)
    }
    return { metric, put }
  }

  it.each(['counter', 'gauge', 'level', 'timer'])(
    'reports it once and ships a %s series as stored beside the others',
    async (kind) => {
      const shared = memory()
      const before = declare(kind, { q: str(), r: str().optional() }, () => {})
      before.metric.bind({ driver: shared, now: () => at })
      before.put({ q: 'abc' })
      await before.metric.drain()

      const shipped: Row[] = []
      const errors: [unknown, unknown][] = []
      const after = declare(kind, { q: int(), r: str().optional() }, (rows) => {
        shipped.push(...rows)
      })
      after.metric.bind({
        driver: shared,
        now: () => at + 10_000,
        onError: (error: unknown, context: unknown) => errors.push([error, context]),
      })
      after.put({ q: 7 })
      await after.metric.drain()

      await after.metric.snapshot({ complete: false })
      const live = await after.metric.snapshot({ complete: false })
      expect(live.map(({ q }) => q).sort()).toEqual([7, 'abc'])

      const report = await after.metric.flush()
      expect(report.error).toBeUndefined()
      expect(shipped.map(({ id, q, r }) => ({ id, q, r }))).toEqual([
        { id: rowId('m', at, STORED), q: 'abc', r: undefined },
      ])
      expect(errors).toEqual([
        [
          new Error(
            'm: stored series key "abc|\\\\0" cannot be read under the current dims: dim "q" is ' +
              'declared as int(), but the stored value "abc" is not a safe integer. The stored ' +
              "series was written under an earlier declaration. It ships with the stored text as each unreadable dim's value",
          ),
          { metric: 'm' },
        ],
      ])
    },
  )

  it('ships it and does not fail the flush when no onError is set', async () => {
    const shared = memory()
    const before = declare('counter', { q: str() }, () => {})
    before.metric.bind({ driver: shared, now: () => at })
    before.put({ q: 'abc' })
    await before.metric.drain()

    const shipped: Row[] = []
    const after = declare('counter', { q: int() }, (rows) => {
      shipped.push(...rows)
    })
    after.metric.bind({ driver: shared, now: () => at + 10_000 })
    expect((await after.metric.flush()).error).toBeUndefined()
    expect(shipped.map(({ q }) => q)).toEqual(['abc'])
  })
})
