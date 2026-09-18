import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { rowId } from '../identity.js'
import { counter } from '../metrics/counter.js'
import { type EventConfig, event } from '../metrics/event.js'
import { gauge } from '../metrics/gauge.js'
import { log } from '../metrics/log.js'
import { timer } from '../metrics/timer.js'
import type { Row, WriteContext, WriteFn } from '../metrics/types.js'
import { encodeDimKey } from '../schema/dims.js'
import { str } from '../schema/types.js'
import { resolveDelivery } from './delivery.js'
import { createHouse } from './house.js'

/** A sink that keeps nothing — for declaration tests that never ship. */
const _discard: WriteFn = () => {}

const DIMS = { park: str() }
const RIVERSIDE = { park: 'riverside' } as const

let clock: number
let driver: Driver
let sent: { rows: Row[]; context: WriteContext }[]
const now = () => clock
const write = async (rows: Row[], context: WriteContext): Promise<void> => {
  sent.push({ rows, context })
}

const durable = (over: Partial<Driver> = {}): Driver => ({ ...memory(), ...over })

beforeEach(() => {
  clock = 1_788_616_987_000 // exactly on a 1s boundary
  driver = memory()
  sent = []
})

describe('resolveDelivery', () => {
  const caps = (durable: boolean) => ({ durable, shared: false, atomicMerge: true })

  it('defaults to staged', () => {
    expect(resolveDelivery(undefined, caps(false))).toBe('staged')
  })

  it('takes an explicit mode whatever the driver says', () => {
    expect(resolveDelivery('immediate', caps(true))).toBe('immediate')
    expect(resolveDelivery('staged', caps(false))).toBe('staged')
  })

  it("resolves 'auto' from durability — nothing to gain by holding non-durable data", () => {
    expect(resolveDelivery('auto', caps(false))).toBe('immediate')
    expect(resolveDelivery('auto', caps(true))).toBe('staged')
  })
})

describe('house delivery resolution', () => {
  it('exposes the resolved mode, never auto', () => {
    const house = createHouse({ driver, delivery: 'auto' })
    expect(house.delivery).toBe('immediate') // memory() is not durable
  })

  it("leaves a durable driver staged under 'auto'", () => {
    const house = createHouse({
      driver: durable({ capabilities: { durable: true, shared: true, atomicMerge: true } }),
      delivery: 'auto',
    })
    expect(house.delivery).toBe('staged')
  })

  it('warns once about last-write-wins when immediate', () => {
    const onWarn = vi.fn()
    createHouse({ driver, delivery: 'immediate', onWarn })
    expect(onWarn.mock.calls.some(([message]) => /newest row per id/.test(message as string))).toBe(
      true,
    )
  })
})

describe('immediate delivery — bucketed kinds', () => {
  const makeCounter = (sink: WriteFn = write) =>
    counter('dog_poops', { write: sink, dims: DIMS, resolution: '1s', flush: '5m' })

  it('ships the open bucket without anyone calling flush()', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    dogPoops.add(RIVERSIDE)
    await house.drain()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.rows).toEqual([
      { id: expect.any(String), bucket_ts: new Date(clock), park: 'riverside', value: 1 },
    ])
    expect(sent[0]?.context.source).toBe('immediate')
  })

  it('sends the running total, never a delta', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    // drained between writes so each send is its own observable step — the
    // whole point is that send two says `2`, not `1` again
    dogPoops.add(RIVERSIDE)
    await house.drain()
    dogPoops.add(RIVERSIDE)
    await house.drain()
    dogPoops.add(5, RIVERSIDE)
    await house.drain()

    expect(sent.map((one) => one.rows[0]?.value)).toEqual([1, 2, 7])
  })

  it('never goes backwards when writes overlap', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    dogPoops.add(RIVERSIDE)
    dogPoops.add(RIVERSIDE)
    dogPoops.add(5, RIVERSIDE)
    await house.drain()

    // undrained writes settle in an order nobody promised, so the assertion is
    // the invariant rather than a sequence: every send reads a cumulative
    // total, so none can be smaller than the one before it, and the last is
    // the truth. A delta scheme would send 1, 1, 5 in some order and a store
    // keeping the newest would land on whichever arrived last.
    const values = sent.map((one) => one.rows[0]?.value as number)
    expect(values).toHaveLength(3)
    expect([...values].sort((a, b) => a - b)).toEqual(values)
    expect(values.at(-1)).toBe(7)
  })

  it('holds one stable id across every send', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    dogPoops.add(RIVERSIDE)
    await house.drain()
    dogPoops.add(RIVERSIDE)
    await house.drain()

    const ids = new Set(sent.map((one) => one.rows[0]?.id))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBe(rowId('dog_poops', clock, encodeDimKey(DIMS, RIVERSIDE)))
  })

  it('deletes nothing — the bucket stays live and readable', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    dogPoops.add(3, RIVERSIDE)
    await house.drain()

    expect(await dogPoops.current(RIVERSIDE)).toBe(3)
  })

  it('still needs flush() to retire the closed bucket, and it converges', async () => {
    const dogPoops = makeCounter()
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    dogPoops.add(4, RIVERSIDE)
    await house.drain()
    sent = []

    clock += 60_000 // past the bucket and its grace
    const report = await house.flush()

    expect(report.metrics.dog_poops?.rows).toBe(1)
    expect(sent).toHaveLength(1)
    // same id as every immediate send, carrying the complete fold — a store
    // keeping the newest row per id lands on the right number
    expect(sent[0]?.rows[0]).toMatchObject({
      id: rowId('dog_poops', clock - 60_000, encodeDimKey(DIMS, RIVERSIDE)),
      value: 4,
    })
    expect(sent[0]?.context.source).toBe('flush')
    // and now it is gone from the live set
    expect(await dogPoops.current(RIVERSIDE)).toBe(0)
  })

  it('only reads the series that changed', async () => {
    const dogPoops = makeCounter()
    const spy = vi.spyOn(driver, 'readBuckets')
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', now })

    dogPoops.add({ park: 'central' })
    await house.drain()

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ dimKey: encodeDimKey(DIMS, { park: 'central' }) }),
    )
    expect(sent[0]?.rows).toHaveLength(1)
  })

  it('folds a gauge before sending, so min and max are right', async () => {
    const latency = gauge('latency', { write, dims: DIMS, resolution: '1s', flush: '5m' })
    const house = createHouse({ driver, schema: [latency], delivery: 'immediate', now })

    latency.set(10, RIVERSIDE)
    latency.set(2, RIVERSIDE)
    await house.drain()

    expect(sent.at(-1)?.rows[0]).toMatchObject({ min: 2, max: 10, sum: 12, count: 2, last: 2 })
  })

  it('covers a timer through the gauge underneath it', async () => {
    const work = timer('work', { write, dims: DIMS, resolution: '1s', flush: '5m' })
    const house = createHouse({ driver, schema: [work], delivery: 'immediate', now })

    work.observe(12.5, RIVERSIDE)
    await house.drain()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.context.kind).toBe('timer')
    expect(sent[0]?.rows[0]).toMatchObject({ count: 1, sum: 12.5 })
  })

  it('leaves the data in place when the sink throws, and resends it next write', async () => {
    const onError = vi.fn()
    let failing = true
    const dogPoops = makeCounter(async (rows, context) => {
      if (failing) throw new Error('sink down')
      await write(rows, context)
    })
    const house = createHouse({ driver, schema: [dogPoops], delivery: 'immediate', onError, now })

    dogPoops.add(2, RIVERSIDE)
    await house.drain()
    expect(onError).toHaveBeenCalledOnce()
    // nothing was claimed, so nothing was lost
    expect(await dogPoops.current(RIVERSIDE)).toBe(2)

    failing = false
    dogPoops.add(3, RIVERSIDE)
    await house.drain()

    expect(sent.at(-1)?.rows[0]).toMatchObject({ value: 5 })
  })
})

describe('immediate delivery — staged kinds', () => {
  const makeEvent = (over: Partial<EventConfig<{ plan: ReturnType<typeof str> }>> = {}) =>
    event('signups', { fields: { plan: str() }, ...over, write: over.write ?? write })

  it('ships a driver-staged event on record, with no flush()', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], delivery: 'immediate', now })

    signups.record({ plan: 'pro' })
    await house.drain()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.rows[0]).toMatchObject({ plan: 'pro' })
    expect(sent[0]?.context.source).toBe('immediate')
    // unlike a bucket, a staged record leaves the driver
    expect(await signups.pending()).toBe(0)
  })

  it('ships a locally staged event without waiting for batch.maxSize', async () => {
    const signups = makeEvent({ stage: 'local', batch: { maxSize: 500 } })
    const house = createHouse({ driver, schema: [signups], delivery: 'immediate', now })

    signups.record({ plan: 'pro' })
    await house.drain()

    expect(sent).toHaveLength(1)
    expect(await signups.pending()).toBe(0)
  })

  it('keeps stage independent of delivery — where is not when', async () => {
    const signups = makeEvent()
    createHouse({ driver, schema: [signups], delivery: 'immediate', now })
    expect(signups.stage).toBe('driver')
  })

  it('carries a log through the event underneath it', async () => {
    const applog = log('app_log', { write, fields: { requestId: str() } })
    const house = createHouse({ driver, schema: [applog], delivery: 'immediate', now })

    applog.info('started', { requestId: 'abc' })
    await house.drain()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.context.kind).toBe('log')
    expect(sent[0]?.rows[0]).toMatchObject({ level: 'info', message: 'started', requestId: 'abc' })
  })

  it('leaves flush() with nothing to do', async () => {
    const signups = makeEvent()
    const house = createHouse({ driver, schema: [signups], delivery: 'immediate', now })

    signups.record({ plan: 'pro' })
    await house.drain()
    sent = []

    const report = await house.flush({ force: true })
    expect(report.metrics.signups?.rows).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('releases records back when the sink throws', async () => {
    const onError = vi.fn()
    const signups = makeEvent({
      write: () => {
        throw new Error('sink down')
      },
    })
    const house = createHouse({ driver, schema: [signups], delivery: 'immediate', onError, now })

    signups.record({ plan: 'pro' })
    await house.drain()

    expect(onError).toHaveBeenCalledOnce()
    expect(await signups.pending()).toBe(1)
  })
})

describe('house defaults', () => {
  it('fills a cadence the metric omits', () => {
    const dogPoops = counter('dog_poops', { write, dims: DIMS, resolution: '1s' })
    createHouse({ driver, schema: [dogPoops], defaults: { flush: '2m' } })
    expect(dogPoops.flushMs).toBe(120_000)
  })

  it('never overrides one the metric declares', () => {
    const dogPoops = counter('dog_poops', { write, dims: DIMS, resolution: '1s', flush: '5m' })
    createHouse({ driver, schema: [dogPoops], defaults: { flush: '2m' } })
    expect(dogPoops.flushMs).toBe(300_000)
  })

  it('fills grace, and still falls back to the shared default', () => {
    const withHouse = counter('a', { write, dims: DIMS, resolution: '1s', flush: '1m' })
    const bare = counter('b', { write, dims: DIMS, resolution: '1s', flush: '1m' })

    createHouse({ driver, schema: [withHouse], defaults: { grace: '9s' } })
    createHouse({ driver, schema: [bare] })

    expect(withHouse.graceMs).toBe(9_000)
    expect(bare.graceMs).toBe(2_000)
  })

  it('applies grace to the claim watermark, not just the field', async () => {
    const dogPoops = counter('dog_poops', { write, dims: DIMS, resolution: '1s' })
    const house = createHouse({
      driver,
      schema: [dogPoops],
      defaults: { flush: '1s', grace: '30s' },
      now,
    })

    dogPoops.add(RIVERSIDE)
    await house.drain()

    clock += 5_000 // bucket closed, but well inside a 30s grace
    expect((await house.flush()).metrics.dog_poops?.rows).toBe(0)

    clock += 30_000
    expect((await house.flush()).metrics.dog_poops?.rows).toBe(1)
  })

  it('reaches an event and a timer too', () => {
    const signups = event('signups', { write, fields: { plan: str() } })
    const work = timer('work', { write, dims: DIMS, resolution: '1s' })
    createHouse({ driver, schema: [signups, work], defaults: { flush: '4m' } })

    expect(signups.flushMs).toBe(240_000)
    expect(work.flushMs).toBe(240_000)
  })

  it('throws at bind when nobody supplies a cadence', () => {
    const dogPoops = counter('dog_poops', { write, dims: DIMS, resolution: '1s' })
    expect(() => createHouse({ driver, schema: [dogPoops] })).toThrow(/no flush cadence/)
  })

  it('checks resolution against a cadence that came from the house', () => {
    const dogPoops = counter('dog_poops', { write, dims: DIMS, resolution: '7s' })
    expect(() => createHouse({ driver, schema: [dogPoops], defaults: { flush: '10s' } })).toThrow(
      /does not divide/,
    )
  })

  it('still checks a declared cadence eagerly, at declare time', () => {
    expect(() =>
      counter('dog_poops', { write, dims: DIMS, resolution: '7s', flush: '10s' }),
    ).toThrow(/does not divide/)
  })
})
