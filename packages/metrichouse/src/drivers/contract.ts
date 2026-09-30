/**
 * The driver contract, as an executable suite.
 *
 * Every driver is measured against the memory driver, because the memory
 * driver *is* the specification: it is the one implementation small enough to
 * read in a sitting, and its behaviour is what the rest of the library was
 * written against. A new backend is not "a driver" because it satisfies the
 * TypeScript interface. A stub of sixteen `async () => {}` methods does that.
 * It is a driver when it passes this file.
 *
 * ```
 * memory.test.ts   describeDriverContract('memory', ...)  + maxSeries, maxStaged
 * ioredis.test.ts  describeDriverContract('ioredis', ...) + key layout, durability
 * ```
 *
 * So the rule for adding a backend is mechanical: call this, watch it fail,
 * make it pass. Nothing here may reference a concrete driver, and anything a
 * driver is *allowed* to differ on, a series cap, a key layout, whether a
 * claim survives a restart, how long one has to be held before it counts as
 * abandoned, belongs in that driver's own test file rather than here.
 *
 * Not a test file itself: `vitest.config.ts` collects `src/**\/*.test.ts`, and
 * this exports a function instead of running one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Cell, Driver, DriverCapabilities, GaugeCell, Turn } from './types.js'
import { isGaugeCell, isLevelCell } from './types.js'

/** A counter metric, and two series inside it. */
const M = 'dog_poops'
/** A gauge metric. Separate from {@link M}: one metric holds one kind. */
const G = 'dog_weight'
/** A level metric. Separate again, for the same reason. */
const L = 'dogs_in_park'
const WILLOW = 'Willow|riverside'
const REX = 'Rex|central'

export interface DriverContractOptions {
  /**
   * A driver with no data in it.
   *
   * Called before every test. A shared driver must isolate here, with a fresh
   * namespace per call, or tests see each other's keys.
   */
  make(): Promise<Driver> | Driver

  /** Drop whatever `make` created. Only a driver with a server needs this. */
  cleanup?(driver: Driver): Promise<void> | void

  /** What this driver claims about itself, asserted rather than assumed. */
  capabilities: DriverCapabilities

  /**
   * Put a cell straight into a window, past the watermark, the way a driver
   * from before the watermark existed could have left one.
   *
   * Nothing written through the contract can land in a claimed window, so
   * this is the only way to hand `release` a window that already holds a
   * cell. A suite without it skips those tests.
   */
  plant?(
    driver: Driver,
    metric: string,
    bucketTs: number,
    dimKey: string,
    cell: Cell,
  ): Promise<void>

  /**
   * A second driver on the same storage that treats every claim as
   * abandoned, standing in for a process started after the one that claimed
   * has died. Only a durable driver has one: a claim that dies with its
   * process leaves nothing to recover. A suite without it skips those tests.
   */
  abandoned?(driver: Driver): Promise<Driver> | Driver
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

    const put = (bucketTs: number, dimKey: string, value: number) =>
      driver.setLevel([{ metric: L, bucketTs, dimKey, value, mode: 'set' }])

    const move = (bucketTs: number, dimKey: string, value: number) =>
      driver.setLevel([{ metric: L, bucketTs, dimKey, value, mode: 'add' }])

    const hold = (bucketTs: number, dimKey: string, value: number) =>
      driver.setLevel([{ metric: L, bucketTs, dimKey, value, mode: 'hold' }])

    /** The one cell at a bucket and series, narrowed to a level. */
    const levelAt = async (bucketTs: number, dimKey: string): Promise<number | undefined> => {
      const rows = await driver.readBuckets({ metric: L, dimKey })
      const row = rows.find((r) => r.bucketTs === bucketTs)
      if (!row) return undefined
      if (!isLevelCell(row.value)) throw new Error(`expected a level cell, got ${row.value}`)
      return row.value.level
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

      it('accepts fractional deltas, since counters may declare float', async () => {
        await incr(1000, WILLOW, 0.5)
        await incr(1000, WILLOW, 0.25)
        expect((await driver.readBuckets({ metric: M }))[0]?.value).toBeCloseTo(0.75)
      })

      it('keeps every bit of a fractional total, as a double sum would', async () => {
        // three adds of 7.77e-9 in plain doubles, which is what memory holds
        for (let i = 0; i < 3; i++) await incr(1000, WILLOW, 7.77e-9)
        await incr(1000, REX, 1e-310)

        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 1000, dimKey: REX, value: 1e-310 },
          { bucketTs: 1000, dimKey: WILLOW, value: 7.77e-9 + 7.77e-9 + 7.77e-9 },
        ])
      })

      it('refuses a total past the largest number a double holds', async () => {
        await incr(1000, WILLOW, Number.MAX_VALUE)
        await expect(incr(1000, WILLOW, Number.MAX_VALUE)).rejects.toThrow(/largest number/)
        expect((await driver.readBuckets({ metric: M }))[0]?.value).toBe(Number.MAX_VALUE)
      })

      it('refuses a first increment that is not a finite number', async () => {
        await expect(incr(1000, WILLOW, Number.POSITIVE_INFINITY)).rejects.toThrow(/largest number/)
        await expect(incr(1000, WILLOW, Number.NaN)).rejects.toThrow(/largest number/)
        expect(await driver.readBuckets({ metric: M })).toEqual([])
      })

      it('changes nothing when one increment in a batch is refused', async () => {
        await expect(
          driver.increment([
            { metric: M, bucketTs: 1000, dimKey: REX, delta: 1 },
            { metric: M, bucketTs: 1000, dimKey: WILLOW, delta: Number.MAX_VALUE },
            { metric: M, bucketTs: 1000, dimKey: WILLOW, delta: Number.MAX_VALUE },
          ]),
        ).rejects.toThrow(/largest number/)
        expect(await driver.readBuckets({ metric: M })).toEqual([])
      })

      it('names the metric it refused in a batch spanning two metrics', async () => {
        await expect(
          driver.increment([
            { metric: 'first', bucketTs: 1000, dimKey: WILLOW, delta: 1 },
            { metric: 'second', bucketTs: 1000, dimKey: WILLOW, delta: Number.POSITIVE_INFINITY },
          ]),
        ).rejects.toThrow(/driver: second /)
      })

      it('refuses an integer total past the largest safe integer', async () => {
        const whole = (delta: number) =>
          driver.increment([{ metric: M, bucketTs: 1000, dimKey: WILLOW, delta, integer: true }])
        await whole(Number.MAX_SAFE_INTEGER)
        await expect(whole(1)).rejects.toThrow(/largest whole number/)
        expect((await driver.readBuckets({ metric: M }))[0]?.value).toBe(Number.MAX_SAFE_INTEGER)
      })

      it('says a stored fraction is not a whole number, rather than past the limit', async () => {
        await incr(1000, WILLOW, 2.5)
        await expect(
          driver.increment([
            { metric: M, bucketTs: 1000, dimKey: WILLOW, delta: 1, integer: true },
          ]),
        ).rejects.toThrow(/not (be )?a whole number/)
        expect((await driver.readBuckets({ metric: M }))[0]?.value).toBe(2.5)
      })

      it('lets a total without the integer flag pass the largest safe integer', async () => {
        await incr(1000, WILLOW, Number.MAX_SAFE_INTEGER)
        await incr(1000, WILLOW, 2)
        expect((await driver.readBuckets({ metric: M }))[0]?.value).toBe(2 ** 53 + 1)
      })

      it('stores a negative zero as zero', async () => {
        await incr(1000, WILLOW, -0)
        expect(Object.is((await driver.readBuckets({ metric: M }))[0]?.value, 0)).toBe(true)
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

      it('refuses a sum past the largest number a double holds', async () => {
        await obs(1000, WILLOW, Number.MAX_VALUE)
        await expect(obs(1000, WILLOW, Number.MAX_VALUE)).rejects.toThrow(/largest number/)
        expect((await gaugeAt(1000, WILLOW)).count).toBe(1)
      })

      it('refuses a first observation that is not a finite number', async () => {
        await expect(obs(1000, WILLOW, Number.POSITIVE_INFINITY)).rejects.toThrow(/largest number/)
        expect(await driver.readBuckets({ metric: G })).toEqual([])
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

    describe('setLevel', () => {
      it('puts a series at a value and records it in that bucket', async () => {
        await put(1000, WILLOW, 42)

        expect(await levelAt(1000, WILLOW)).toBe(42)
        expect(await driver.readLevels(L)).toEqual([
          { dimKey: WILLOW, value: 42, carried: 42, writtenAt: 1000, heldThrough: 1000 },
        ])
      })

      it('replaces rather than accumulates within one bucket', async () => {
        await put(1000, WILLOW, 42)
        await put(1000, WILLOW, 7)

        expect(await levelAt(1000, WILLOW)).toBe(7)
      })

      it('carries the last write in the pointer window, not the first', async () => {
        // the window the pointer names ends at the newest value, and the
        // empty windows after it repeat that one
        await put(1000, WILLOW, 5)
        await put(1000, WILLOW, 3)
        expect((await driver.readLevels(L))[0]?.carried).toBe(3)

        await move(1000, WILLOW, 4)
        expect((await driver.readLevels(L))[0]?.carried).toBe(7)
      })

      it('applies an add that arrives late to the windows after it', async () => {
        // two processes moving one series across a boundary: the later
        // window's add lands first. Every window must still end right
        await put(1000, WILLOW, 10)
        await move(3000, WILLOW, 1)
        await move(2000, WILLOW, 1)

        expect(await levelAt(2000, WILLOW)).toBe(11)
        expect(await levelAt(3000, WILLOW)).toBe(12)
        expect((await driver.readLevels(L))[0]).toMatchObject({ value: 12, carried: 10 })
      })

      it('applies a late add to carried when the pointer has passed its window', async () => {
        await put(1000, WILLOW, 10)
        await hold(2000, WILLOW, 10)
        await move(3000, WILLOW, 5)
        await move(2000, WILLOW, 1)

        expect(await levelAt(2000, WILLOW)).toBe(11)
        expect(await levelAt(3000, WILLOW)).toBe(16)
        expect((await driver.readLevels(L))[0]).toMatchObject({ value: 16, carried: 11 })
      })

      it('lets a late set fill its own window without replacing a newer value', async () => {
        await put(1000, WILLOW, 5)
        await put(3000, WILLOW, 9)
        await put(2000, WILLOW, 7)

        expect(await levelAt(2000, WILLOW)).toBe(7)
        expect((await driver.readLevels(L))[0]).toMatchObject({ value: 9, carried: 5 })
      })

      it('changes no later window for a late add when only another series wrote one', async () => {
        // the later window exists, so the add has to look inside it, and
        // finds nothing of its own series there to move
        await put(1000, WILLOW, 5)
        await put(3000, REX, 1)
        await move(2000, WILLOW, 2)

        expect(await levelAt(1000, WILLOW)).toBe(5)
        expect(await levelAt(2000, WILLOW)).toBe(7)
        expect(await levelAt(3000, WILLOW)).toBeUndefined()
        expect(await levelAt(3000, REX)).toBe(1)
        expect((await driver.readLevels(L)).sort((a, b) => (a.dimKey < b.dimKey ? -1 : 1))).toEqual(
          [
            { dimKey: REX, value: 1, carried: 1, writtenAt: 3000, heldThrough: 3000 },
            { dimKey: WILLOW, value: 7, carried: 5, writtenAt: 2000, heldThrough: 1000 },
          ],
        )
      })

      it('stores a level of negative zero as zero, carried included', async () => {
        await put(1000, WILLOW, -0)
        const [one] = await driver.readLevels(L)
        expect(Object.is(one?.value, 0) && Object.is(one?.carried, 0)).toBe(true)
      })

      it('ignores a hold for a window older than the pointer', async () => {
        // a flusher whose clock runs behind carries late, after a newer one
        await put(1000, WILLOW, 5)
        await hold(3000, WILLOW, 7)
        await hold(2000, WILLOW, 5)

        expect((await driver.readLevels(L))[0]).toMatchObject({ carried: 7, heldThrough: 3000 })
      })

      it('keeps the carried value when a write lands past the pointer', async () => {
        // the windows between the pointer and the new write still belong to
        // the older number
        await put(1000, WILLOW, 42)
        await put(5000, WILLOW, 7)
        expect((await driver.readLevels(L))[0]?.carried).toBe(42)
      })

      it('refuses an add that would pass the largest number a double holds', async () => {
        await put(1000, WILLOW, Number.MAX_VALUE)
        await expect(move(1000, WILLOW, Number.MAX_VALUE)).rejects.toThrow(/largest number/)
        expect(await levelAt(1000, WILLOW)).toBe(Number.MAX_VALUE)
      })

      it('refuses an integer level past the largest safe integer', async () => {
        const whole = (value: number, mode: 'set' | 'add') =>
          driver.setLevel([
            { metric: L, bucketTs: 1000, dimKey: WILLOW, value, mode, integer: true },
          ])
        await whole(Number.MAX_SAFE_INTEGER, 'set')
        await expect(whole(1, 'add')).rejects.toThrow(/largest whole number/)
        expect(await levelAt(1000, WILLOW)).toBe(Number.MAX_SAFE_INTEGER)
      })

      it('moves a series by a delta, treating an untouched one as zero', async () => {
        await move(1000, WILLOW, 3)
        await move(1000, WILLOW, 4)
        await move(1000, WILLOW, -2)

        expect(await levelAt(1000, WILLOW)).toBe(5)
      })

      it('carries a value into a bucket on a hold', async () => {
        await put(1000, WILLOW, 42)
        await hold(2000, WILLOW, 42)

        expect(await levelAt(2000, WILLOW)).toBe(42)
      })

      it('carries the value it was given, not the one the series is at', async () => {
        // the window being filled is in the past, and the series has moved
        await put(1000, WILLOW, 42)
        await put(5000, WILLOW, 7)
        await hold(2000, WILLOW, 42)

        expect(await levelAt(2000, WILLOW)).toBe(42)
        expect((await driver.readLevels(L))[0]?.value).toBe(7)
        expect((await driver.readLevels(L))[0]?.carried).toBe(42)
      })

      it('leaves a bucket that already holds a value alone', async () => {
        // a written value beats a carried one, whichever lands second
        await put(1000, WILLOW, 42)
        await put(2000, WILLOW, 7)
        await hold(2000, WILLOW, 42)

        expect(await levelAt(2000, WILLOW)).toBe(7)
      })

      it('carries the written value when a hold finds its window already written', async () => {
        // the flush read the series at 42, then a late set of 7 landed in
        // the window before the flush's hold for it arrived. The windows
        // after this one must repeat 7, the value the window ended at
        await put(1000, WILLOW, 42)
        await put(2000, WILLOW, 7)
        await hold(2000, WILLOW, 42)

        expect(await driver.readLevels(L)).toEqual([
          { dimKey: WILLOW, value: 7, carried: 7, writtenAt: 2000, heldThrough: 2000 },
        ])
      })

      it('carries the window when a hold arrives a second time after a set', async () => {
        // a hold resent after a reconnect, with a set in between
        await put(1000, WILLOW, 42)
        await hold(2000, WILLOW, 42)
        await put(2000, WILLOW, 7)
        await hold(2000, WILLOW, 42)

        expect(await levelAt(2000, WILLOW)).toBe(7)
        expect((await driver.readLevels(L))[0]).toMatchObject({ value: 7, carried: 7 })
      })

      it('keeps carried when a hold for the pointer window arrives again after a claim', async () => {
        // the claim took the cell that says what the window ended at, and a
        // second flusher, or a resend, repeats the older hold
        await put(1000, WILLOW, 5)
        await hold(2000, WILLOW, 5)
        await put(2000, WILLOW, 9)
        await driver.claim(L, 3000)
        await hold(2000, WILLOW, 5)

        expect(await driver.readLevels(L)).toEqual([
          { dimKey: WILLOW, value: 9, carried: 9, writtenAt: 2000, heldThrough: 2000 },
        ])
      })

      it('changes nothing when one level write in a batch is refused', async () => {
        await expect(
          driver.setLevel([
            { metric: L, bucketTs: 1000, dimKey: REX, value: 5, mode: 'add' },
            { metric: L, bucketTs: 1000, dimKey: WILLOW, value: Number.MAX_VALUE, mode: 'add' },
            { metric: L, bucketTs: 1000, dimKey: WILLOW, value: Number.MAX_VALUE, mode: 'add' },
          ]),
        ).rejects.toThrow(/largest number/)
        expect(await driver.readBuckets({ metric: L })).toEqual([])
        expect(await driver.readLevels(L)).toEqual([])
      })

      it('finds the value in effect before a fifteen digit window', async () => {
        // more significant digits than Lua prints a number with
        const P = 100_000_000_000_003
        await put(P - 1, WILLOW, 10)
        const claim = await driver.claim(L, P + 1)
        // below the watermark: no cell, and the pointer moves to P
        await hold(P, WILLOW, 20)
        await driver.release(claim)
        // the cell at P - 1 is live again, before the pointer, so the add
        // starts from what the pointer carried
        await move(P + 2, WILLOW, 1)

        expect(await levelAt(P + 2, WILLOW)).toBe(21)
      })

      it('holds nothing for a series it has never seen', async () => {
        await hold(1000, WILLOW, 42)

        expect(await levelAt(1000, WILLOW)).toBeUndefined()
        expect(await driver.readLevels(L)).toEqual([])
      })

      it('moves the pointer on a hold and never on a write', async () => {
        await put(1000, WILLOW, 42)
        await put(5000, WILLOW, 7)

        // the windows between the two writes are still owed a row
        expect((await driver.readLevels(L))[0]?.heldThrough).toBe(1000)

        await hold(2000, WILLOW, 42)
        expect((await driver.readLevels(L))[0]?.heldThrough).toBe(2000)
      })

      it('keeps the newest write time', async () => {
        await put(1000, WILLOW, 42)
        await put(5000, WILLOW, 7)

        expect((await driver.readLevels(L))[0]?.writtenAt).toBe(5000)
      })

      it('keeps series apart', async () => {
        await put(1000, WILLOW, 42)
        await put(1000, REX, 7)

        expect(await driver.readLevels(L)).toEqual([
          { dimKey: REX, value: 7, carried: 7, writtenAt: 1000, heldThrough: 1000 },
          { dimKey: WILLOW, value: 42, carried: 42, writtenAt: 1000, heldThrough: 1000 },
        ])
      })

      it('handles negative and fractional values', async () => {
        await put(1000, WILLOW, -2.5)
        await move(1000, WILLOW, 1.25)

        expect(await levelAt(1000, WILLOW)).toBeCloseTo(-1.25)
      })

      it('keeps full float precision', async () => {
        await put(1000, WILLOW, 0.1)
        await move(1000, WILLOW, 0.2)

        expect(await levelAt(1000, WILLOW)).toBe(0.30000000000000004)
      })

      it('does nothing on an empty batch', async () => {
        await driver.setLevel([])
        expect(await driver.readBuckets({ metric: L })).toEqual([])
      })

      it('refuses to set a series holding cells of another kind', async () => {
        await driver.increment([{ metric: L, bucketTs: 1000, dimKey: WILLOW, delta: 1 }])
        await expect(put(1000, WILLOW, 5)).rejects.toThrow()
      })

      it('refuses to increment or observe a series holding level cells', async () => {
        await put(1000, WILLOW, 5)

        await expect(
          driver.increment([{ metric: L, bucketTs: 1000, dimKey: WILLOW, delta: 1 }]),
        ).rejects.toThrow()
        await expect(
          driver.observe([{ metric: L, bucketTs: 1000, dimKey: WILLOW, value: 1 }]),
        ).rejects.toThrow()
      })
    })

    describe('readLevels', () => {
      it('is empty for a metric nothing has written', async () => {
        expect(await driver.readLevels(L)).toEqual([])
      })

      it('sees a write issued before it and not yet awaited', async () => {
        await put(1000, REX, 1)
        const write = put(1000, WILLOW, 2)
        const levels = await driver.readLevels(L)
        await write
        expect(levels.map((one) => [one.dimKey, one.value])).toEqual([
          [REX, 1],
          [WILLOW, 2],
        ])
      })

      it('outlives the claim that shipped the buckets', async () => {
        // the whole reason a level can report a window nobody wrote to
        await put(1000, WILLOW, 42)

        const claim = await driver.claim(L, 2000)
        await driver.ack(claim)

        expect(await driver.readBuckets({ metric: L })).toEqual([])
        expect(await driver.readLevels(L)).toEqual([
          { dimKey: WILLOW, value: 42, carried: 42, writtenAt: 1000, heldThrough: 1000 },
        ])
      })

      it('hands out copies, so editing one changes nothing stored', async () => {
        await put(1000, WILLOW, 42)
        const [read] = await driver.readLevels(L)
        Object.assign(read as object, { value: 9, heldThrough: 9000 })

        expect(await driver.readLevels(L)).toEqual([
          { dimKey: WILLOW, value: 42, carried: 42, writtenAt: 1000, heldThrough: 1000 },
        ])
      })
    })

    describe('dropLevels', () => {
      it('forgets a series entirely', async () => {
        await put(1000, WILLOW, 42)
        await put(1000, REX, 7)

        await driver.dropLevels(L, [WILLOW])

        expect(await driver.readLevels(L)).toEqual([
          { dimKey: REX, value: 7, carried: 7, writtenAt: 1000, heldThrough: 1000 },
        ])
      })

      it('leaves buckets the series already filled', async () => {
        await put(1000, WILLOW, 42)
        await driver.dropLevels(L, [WILLOW])

        expect(await levelAt(1000, WILLOW)).toBe(42)
      })

      it('holds nothing for a dropped series', async () => {
        await put(1000, WILLOW, 42)
        await driver.dropLevels(L, [WILLOW])
        await hold(2000, WILLOW, 42)

        expect(await levelAt(2000, WILLOW)).toBeUndefined()
      })

      it('ignores a series it does not hold, and an empty list', async () => {
        await driver.dropLevels(L, [WILLOW])
        await driver.dropLevels(L, [])
        expect(await driver.readLevels(L)).toEqual([])
      })

      it('keeps a series written since the cutoff', async () => {
        // the flush decided WILLOW expired from an older read. The write that
        // landed after that read must survive the drop
        await put(1000, WILLOW, 42)
        await put(1000, REX, 7)
        await put(9000, WILLOW, 9)

        await driver.dropLevels(L, [WILLOW, REX], 5000)

        expect((await driver.readLevels(L)).map((one) => one.dimKey)).toEqual([WILLOW])
        expect((await driver.readLevels(L))[0]?.value).toBe(9)
      })
    })

    describe('writes below the claimed watermark', () => {
      it('moves a counter increment forward to the watermark', async () => {
        await incr(1000, WILLOW, 5)
        await driver.ack(await driver.claim(M, 3000))

        await incr(1000, WILLOW, 2)
        await incr(2000, WILLOW, 1)
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 3000, dimKey: WILLOW, value: 3 },
        ])
      })

      it('moves a gauge observation forward to the watermark', async () => {
        await obs(1000, WILLOW, 5)
        await driver.ack(await driver.claim(G, 2000))

        await obs(1000, WILLOW, 9)
        expect(await gaugeAt(2000, WILLOW)).toEqual({ last: 9, min: 9, max: 9, sum: 9, count: 1 })
      })

      it('folds a batch in order when its observations move to one window', async () => {
        // aimed at two windows, both below the watermark, so all three land
        // at 5000 and the last one written has to win `last`
        await driver.ack(await driver.claim(G, 5000))
        await driver.observe([
          { metric: G, bucketTs: 2000, dimKey: WILLOW, value: 1 },
          { metric: G, bucketTs: 1000, dimKey: WILLOW, value: 2 },
          { metric: G, bucketTs: 2000, dimKey: WILLOW, value: 3 },
        ])
        expect(await gaugeAt(5000, WILLOW)).toEqual({ last: 3, min: 1, max: 3, sum: 6, count: 3 })
      })

      it('moves a level write forward, and carries it from there', async () => {
        await put(1000, WILLOW, 5)
        await driver.ack(await driver.claim(L, 2000))

        await put(1000, WILLOW, 8)
        expect(await levelAt(2000, WILLOW)).toBe(8)
        expect((await driver.readLevels(L))[0]).toMatchObject({ value: 8, writtenAt: 2000 })
      })

      it('lets a hold move the pointer without refilling a claimed window', async () => {
        await put(1000, WILLOW, 5)
        await driver.ack(await driver.claim(L, 3000))

        await hold(2000, WILLOW, 5)
        expect(await levelAt(2000, WILLOW)).toBeUndefined()
        expect((await driver.readLevels(L))[0]?.heldThrough).toBe(2000)
      })

      it('raises the watermark even for a claim that found nothing', async () => {
        await driver.ack(await driver.claim(M, 5000))
        await incr(1000, WILLOW)
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 5000, dimKey: WILLOW, value: 1 },
        ])
      })

      it('never lowers the watermark', async () => {
        await driver.ack(await driver.claim(M, 5000))
        await driver.ack(await driver.claim(M, 2000))
        await incr(3000, WILLOW)
        expect((await driver.readBuckets({ metric: M }))[0]?.bucketTs).toBe(5000)
      })

      it('keeps metrics apart', async () => {
        await driver.ack(await driver.claim(M, 5000))
        await obs(1000, WILLOW, 1)
        expect((await driver.readBuckets({ metric: G }))[0]?.bucketTs).toBe(1000)
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
        // this is all `complete: true` is. The caller supplies bucketStart(now)
        const rows = await driver.readBuckets({ metric: M, to: 3000 })
        expect(rows.map((r) => r.bucketTs)).toEqual([1000, 2000])
      })

      it('is ordered by bucket then dim key, not by insertion', async () => {
        await incr(1000, REX)
        const rows = await driver.readBuckets({ metric: M, from: 1000, to: 2000 })
        expect(rows.map((r) => r.dimKey)).toEqual([REX, WILLOW])
      })

      it('sees a write issued before it and not yet awaited', async () => {
        const write = incr(4000, WILLOW, 5)
        const rows = await driver.readBuckets({ metric: M, from: 4000 })
        await write
        expect(rows).toEqual([{ bucketTs: 4000, dimKey: WILLOW, value: 5 }])
      })

      it('reads one series across every window that holds it, oldest first', async () => {
        await incr(5000, WILLOW, 4)
        expect(await driver.readBuckets({ metric: M, dimKey: WILLOW })).toEqual([
          { bucketTs: 1000, dimKey: WILLOW, value: 1 },
          { bucketTs: 2000, dimKey: WILLOW, value: 2 },
          { bucketTs: 5000, dimKey: WILLOW, value: 4 },
        ])
      })

      it('reads one series on a half-open range', async () => {
        const rows = await driver.readBuckets({ metric: M, dimKey: WILLOW, from: 2000, to: 5000 })
        expect(rows).toEqual([{ bucketTs: 2000, dimKey: WILLOW, value: 2 }])
      })

      it('returns [] for a series no window holds', async () => {
        expect(await driver.readBuckets({ metric: M, dimKey: 'Nobody|home' })).toEqual([])
        expect(await driver.readBuckets({ metric: 'nope', dimKey: WILLOW })).toEqual([])
      })

      it('sees a write to one series issued before it and not yet awaited', async () => {
        const write = incr(4000, REX, 5)
        const rows = await driver.readBuckets({ metric: M, dimKey: REX, from: 4000 })
        await write
        expect(rows).toEqual([{ bucketTs: 4000, dimKey: REX, value: 5 }])
      })
    })

    // optional methods: a driver may leave them out, and the metrics fall back
    // to the required ones. A driver that has one is held to these
    describe('readLevel', () => {
      it('is undefined for a metric or a series nothing has written', async () => {
        if (!driver.readLevel) return
        await put(1000, WILLOW, 42)
        expect(await driver.readLevel('nope', WILLOW)).toBeUndefined()
        expect(await driver.readLevel(L, REX)).toBeUndefined()
      })

      it('is the series readLevels lists under that key', async () => {
        if (!driver.readLevel) return
        await put(1000, WILLOW, 42)
        await put(1000, REX, 7)
        await move(2000, WILLOW, 3)
        await hold(3000, REX, 7)
        const every = await driver.readLevels(L)
        expect(await driver.readLevel(L, WILLOW)).toEqual(
          every.find((one) => one.dimKey === WILLOW),
        )
        expect(await driver.readLevel(L, REX)).toEqual({
          dimKey: REX,
          value: 7,
          carried: 7,
          writtenAt: 1000,
          heldThrough: 3000,
        })
      })

      it('is undefined once the series is dropped', async () => {
        if (!driver.readLevel) return
        await put(1000, WILLOW, 42)
        await driver.dropLevels(L, [WILLOW])
        expect(await driver.readLevel(L, WILLOW)).toBeUndefined()
      })

      it('hands out a copy, so editing it changes nothing stored', async () => {
        if (!driver.readLevel) return
        await put(1000, WILLOW, 42)
        Object.assign((await driver.readLevel(L, WILLOW)) as object, { value: 9 })

        expect(await driver.readLevel(L, WILLOW)).toEqual({
          dimKey: WILLOW,
          value: 42,
          carried: 42,
          writtenAt: 1000,
          heldThrough: 1000,
        })
      })

      it('sees a write issued before it and not yet awaited', async () => {
        if (!driver.readLevel) return
        const write = put(1000, WILLOW, 2)
        const one = await driver.readLevel(L, WILLOW)
        await write
        expect(one?.value).toBe(2)
      })
    })

    describe('sumBuckets', () => {
      const MAX = Number.MAX_SAFE_INTEGER

      it('is 0 for a metric or a range that holds nothing', async () => {
        if (!driver.sumBuckets) return
        await incr(1000, WILLOW, 3)
        expect(await driver.sumBuckets({ metric: 'nope' })).toBe(0)
        expect(await driver.sumBuckets({ metric: M, from: 2000 })).toBe(0)
      })

      it('adds every series in every window of a half-open range', async () => {
        if (!driver.sumBuckets) return
        await incr(1000, WILLOW, 3)
        await incr(1000, REX, -1)
        await incr(2000, WILLOW, 10)
        await incr(3000, REX, 100)
        expect(await driver.sumBuckets({ metric: M })).toBe(112)
        expect(await driver.sumBuckets({ metric: M, from: 1000, to: 3000 })).toBe(12)
        expect(await driver.sumBuckets({ metric: M, from: 2000, to: 2001 })).toBe(10)
      })

      it('answers up to the largest safe integer on either side', async () => {
        if (!driver.sumBuckets) return
        await incr(1000, WILLOW, MAX - 1)
        await incr(1000, REX, 1)
        await incr(2000, WILLOW, -MAX)
        expect(await driver.sumBuckets({ metric: M, to: 2000 })).toBe(MAX)
        expect(await driver.sumBuckets({ metric: M })).toBe(0)
      })

      it('is undefined when the positive cells pass the largest safe integer', async () => {
        if (!driver.sumBuckets) return
        // 2^53 - 1, then 2, then -(2^53 - 1): the true sum is 2, and adding
        // them in the order a reader lists them gives 1
        await incr(1000, WILLOW, MAX)
        await incr(1000, REX, 2)
        await incr(2000, WILLOW, -MAX)
        expect(await driver.sumBuckets({ metric: M })).toBeUndefined()
      })

      it('is undefined when the negative cells pass the largest safe integer', async () => {
        if (!driver.sumBuckets) return
        await incr(1000, WILLOW, -MAX)
        await incr(1000, REX, -1)
        expect(await driver.sumBuckets({ metric: M })).toBeUndefined()
      })

      it('is undefined when a cell is not a whole number', async () => {
        if (!driver.sumBuckets) return
        await incr(1000, WILLOW, 3)
        await incr(1000, REX, 0.5)
        expect(await driver.sumBuckets({ metric: M })).toBeUndefined()
      })

      it('is undefined for gauge and level cells', async () => {
        if (!driver.sumBuckets) return
        await obs(1000, WILLOW, 3)
        await put(1000, WILLOW, 3)
        expect(await driver.sumBuckets({ metric: G })).toBeUndefined()
        expect(await driver.sumBuckets({ metric: L })).toBeUndefined()
      })

      it('sees a write issued before it and not yet awaited', async () => {
        if (!driver.sumBuckets) return
        await incr(1000, WILLOW, 3)
        const write = incr(1000, REX, 4)
        const total = await driver.sumBuckets({ metric: M })
        await write
        expect(total).toBe(7)
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

      it('hides claimed buckets from a second claim, so two flushers cannot both ship them', async () => {
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

      it('refuses a watermark that is not a finite number, and keeps the one it had', async () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          await expect(driver.claim(M, bad)).rejects.toThrow(
            `${M} cannot be claimed up to ${bad}, which is not a finite number`,
          )
        }

        expect((await driver.claim(M, 3000)).buckets.map((b) => b.bucketTs)).toEqual([1000, 2000])
        // a late write still moves forward to the watermark, so it was kept
        await incr(1000, WILLOW, 5)
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 3000, dimKey: REX, value: 3 },
          { bucketTs: 3000, dimKey: WILLOW, value: 5 },
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

      it('makes the data claimable again, the retry path', async () => {
        await incr(1000, WILLOW, 7)
        const first = await driver.claim(M, 2000)
        await driver.release(first)

        const second = await driver.claim(M, 2000)
        expect([...(second.buckets[0]?.values ?? [])]).toEqual([[WILLOW, 7]])
      })

      it('keeps a released window apart from a late write that moved forward', async () => {
        // the late write went to the watermark while the window was claimed,
        // so putting the window back merges nothing into it: a retry ships
        // exactly what the first attempt did
        await incr(1000, WILLOW, 5)
        const claim = await driver.claim(M, 2000)
        await incr(1000, WILLOW, 2)

        await driver.release(claim)
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 1000, dimKey: WILLOW, value: 5 },
          { bucketTs: 2000, dimKey: WILLOW, value: 2 },
        ])
      })

      it('keeps a released gauge fold apart from observations that moved forward', async () => {
        await obs(1000, WILLOW, 5)
        await obs(1000, WILLOW, 2)
        const claim = await driver.claim(G, 2000)
        await obs(1000, WILLOW, 9)

        await driver.release(claim)
        expect(await gaugeAt(1000, WILLOW)).toEqual({ last: 2, min: 2, max: 5, sum: 7, count: 2 })
        expect(await gaugeAt(2000, WILLOW)).toEqual({ last: 9, min: 9, max: 9, sum: 9, count: 1 })
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

      it('adds a released counter cell to one already in its window', async () => {
        if (!options.plant) return
        await incr(1000, WILLOW, 5)
        const claim = await driver.claim(M, 2000)
        await options.plant(driver, M, 1000, WILLOW, 2)

        await driver.release(claim)
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 1000, dimKey: WILLOW, value: 7 },
        ])
      })

      it('folds a released gauge cell into one already in its window, which keeps last', async () => {
        if (!options.plant) return
        await obs(1000, WILLOW, 5)
        await obs(1000, WILLOW, 3)
        const claim = await driver.claim(G, 2000)
        await options.plant(driver, G, 1000, WILLOW, { last: 9, min: 9, max: 9, sum: 9, count: 1 })

        await driver.release(claim)
        expect(await gaugeAt(1000, WILLOW)).toEqual({ last: 9, min: 3, max: 9, sum: 17, count: 3 })
      })

      it('keeps the level cell already in its window over the released one', async () => {
        if (!options.plant) return
        await put(1000, WILLOW, 4)
        const claim = await driver.claim(L, 2000)
        await options.plant(driver, L, 1000, WILLOW, { level: 7 })

        await driver.release(claim)
        expect(await levelAt(1000, WILLOW)).toBe(7)
      })

      it('keeps the claim in flight when a cell of another kind stops the release', async () => {
        if (!options.plant) return
        await incr(1000, 'a', 1)
        await incr(1000, 'b', 2)
        const claim = await driver.claim(M, 2000)
        await options.plant(driver, M, 1000, 'a', { last: 1, min: 1, max: 1, sum: 1, count: 1 })

        await expect(driver.release(claim)).rejects.toThrow(
          /cannot merge cells of two different kinds/,
        )
        // refused for the same reason again, rather than as a claim that is gone
        await expect(driver.release(claim)).rejects.toThrow(
          /cannot merge cells of two different kinds/,
        )
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

    describe('recover', () => {
      it('reports nothing when no claim has been abandoned', async () => {
        await incr(1000, WILLOW)
        expect(await driver.recover(M)).toEqual({ claims: 0, buckets: 0, records: 0 })
      })

      it('reports nothing for a metric that has never been written', async () => {
        expect(await driver.recover('unseen')).toEqual({ claims: 0, buckets: 0, records: 0 })
      })

      it('leaves the live set untouched', async () => {
        await incr(1000, WILLOW, 3)
        await driver.recover(M)
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 1000, dimKey: WILLOW, value: 3 },
        ])
      })

      it('does not take back a claim that was only just made', async () => {
        // the safety property every driver shares, whatever each one decides
        // "abandoned" means. A flush that is still writing owns its batch, and
        // taking it back underneath one ships those rows twice and then fails
        // that flush's ack. Erring long is the whole of the rule.
        await incr(1000, WILLOW, 5)
        const claim = await driver.claim(M, 2000)

        expect((await driver.recover(M)).claims).toBe(0)
        expect(await driver.readBuckets({ metric: M })).toEqual([])
        // still in flight, and still its owner's to settle
        await expect(driver.ack(claim)).resolves.toBeUndefined()
      })

      it('does not take back a record claim that was only just made', async () => {
        await driver.append([rec('a', 1000)])
        const claim = await driver.claimRecords(M)

        expect((await driver.recover(M)).claims).toBe(0)
        expect(await driver.readPending({ metric: M })).toEqual([])
        await expect(driver.ack(claim)).resolves.toBeUndefined()
      })

      it('puts back a window whose flusher died holding it', async () => {
        if (!options.abandoned) return
        await incr(1000, WILLOW, 4)
        const claim = await driver.claim(M, 2000)

        const sweeper = await options.abandoned(driver)
        expect(await sweeper.recover(M)).toEqual({
          claims: 1,
          buckets: 1,
          records: 0,
          oldestClaimedAt: claim.claimedAt,
        })
        expect(await driver.readBuckets({ metric: M })).toEqual([
          { bucketTs: 1000, dimKey: WILLOW, value: 4 },
        ])
        await expect(driver.ack(claim)).rejects.toThrow(/not in flight/)
      })

      it('puts back records whose flusher died holding them, ahead of later ones', async () => {
        if (!options.abandoned) return
        await driver.append([rec('a', 1000), rec('b', 2000)])
        const claim = await driver.claimRecords(M)
        await driver.append([rec('c', 3000)])

        const sweeper = await options.abandoned(driver)
        expect(await sweeper.recover(M)).toEqual({
          claims: 1,
          buckets: 0,
          records: 2,
          oldestClaimedAt: claim.claimedAt,
        })
        expect((await driver.readPending({ metric: M })).map((r) => r.id)).toEqual(['a', 'b', 'c'])
      })
    })

    describe('takeTurn', () => {
      // optional, so a driver that keeps no turns passes without checking
      const take = (now: number, gapMs = 1000, metric = M) => driver.takeTurn?.(metric, now, gapMs)
      /** A turn taken at `now`, which the test expects to be granted. */
      const granted = async (now: number, gapMs = 1000) => {
        const answer = await take(now, gapMs)
        if (!answer?.granted) throw new Error(`expected a turn at ${now} to be granted`)
        return answer
      }
      const anyToken = (at: number) => ({ at, token: expect.any(String) })

      it('grants the first turn, with none before it', async () => {
        if (!driver.takeTurn) return
        expect(await take(5000)).toEqual({
          granted: true,
          turn: anyToken(5000),
          previous: undefined,
        })
      })

      it('refuses a turn inside the gap, and says when the last one was taken', async () => {
        if (!driver.takeTurn) return
        await take(5000)
        expect(await take(5999)).toEqual({ granted: false, lastTakenAt: 5000 })
      })

      it('grants a turn exactly the gap after the last, and hands back the one it replaced', async () => {
        if (!driver.takeTurn) return
        const first = await granted(5000)
        expect(await take(6000)).toEqual({
          granted: true,
          turn: anyToken(6000),
          previous: first.turn,
        })
        expect(await take(6999)).toEqual({ granted: false, lastTakenAt: 6000 })
      })

      it('refuses a turn taken by a clock running less than the gap ahead', async () => {
        if (!driver.takeTurn) return
        await take(5000)
        expect(await take(4001)).toEqual({ granted: false, lastTakenAt: 5000 })
      })

      it('grants a turn from a clock that stepped back the gap or more', async () => {
        if (!driver.takeTurn) return
        const first = await granted(5000)
        expect(await take(4000)).toEqual({
          granted: true,
          turn: anyToken(4000),
          previous: first.turn,
        })
      })

      it('always grants a gap of zero, and still records the turn', async () => {
        if (!driver.takeTurn) return
        const first = await granted(5000)
        expect(await take(5000, 0)).toEqual({
          granted: true,
          turn: anyToken(5000),
          previous: first.turn,
        })
        expect(await take(5500)).toEqual({ granted: false, lastTakenAt: 5000 })
      })

      it('gives each turn a token of its own, two in one millisecond included', async () => {
        if (!driver.takeTurn) return
        const first = await granted(5000)
        const second = await granted(5000, 0)
        expect(second.turn.token).not.toBe(first.turn.token)
      })

      it('keeps a turn per metric', async () => {
        if (!driver.takeTurn) return
        await take(5000)
        expect(await take(5000, 1000, G)).toEqual({
          granted: true,
          turn: anyToken(5000),
          previous: undefined,
        })
      })

      it('grants one of two turns asked for at the same moment', async () => {
        if (!driver.takeTurn) return
        const answers = await Promise.all([take(5000), take(5000)])
        expect(answers.filter((a) => a?.granted)).toHaveLength(1)
      })
    })

    describe('returnTurn', () => {
      const take = (now: number, gapMs = 1000) => driver.takeTurn?.(M, now, gapMs)
      const granted = async (now: number, gapMs = 1000) => {
        const answer = await take(now, gapMs)
        if (!answer?.granted) throw new Error(`expected a turn at ${now} to be granted`)
        return answer
      }
      /** Give back a granted turn, putting back the one it replaced. */
      const giveBack = (answer: { turn: Turn; previous: Turn | undefined }) =>
        driver.returnTurn?.(M, answer.turn, answer.previous)

      it('puts the previous turn back', async () => {
        if (!driver.takeTurn) return
        await take(5000)
        await giveBack(await granted(6000))
        expect(await take(5500)).toEqual({ granted: false, lastTakenAt: 5000 })
      })

      it('clears the turn when there was none before it', async () => {
        if (!driver.takeTurn) return
        await giveBack(await granted(5000))
        expect(await take(5001)).toEqual({
          granted: true,
          turn: { at: 5001, token: expect.any(String) },
          previous: undefined,
        })
      })

      it('leaves a later turn alone', async () => {
        if (!driver.takeTurn) return
        const first = await granted(5000)
        await take(6000)
        await giveBack(first)
        expect(await take(6500)).toEqual({ granted: false, lastTakenAt: 6000 })
      })

      it('leaves a later turn taken in the same millisecond alone', async () => {
        if (!driver.takeTurn) return
        const first = await granted(5000)
        const forced = await granted(5000, 0)
        await giveBack(first)
        expect(await take(5500)).toEqual({ granted: false, lastTakenAt: 5000 })

        // the forced turn is still the one recorded, so it can be given back
        await giveBack(forced)
        await giveBack(first)
        expect(await take(5001)).toMatchObject({ granted: true, previous: undefined })
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

      it('does not aggregate, so two identical records are two records', async () => {
        // the entire difference from `increment`, which would have folded these
        await driver.append([rec('a', 1000, { dog: 'Willow' }), rec('b', 1000, { dog: 'Willow' })])
        expect(await driver.countPending(M)).toBe(2)
      })

      it('treats fields as opaque and never reads inside them', async () => {
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

      it('hands back an invalid Date in fields as an invalid Date', async () => {
        await driver.append([rec('a', 1000, { when: new Date(Number.NaN) })])
        const when = (await driver.readPending({ metric: M }))[0]?.fields.when
        expect(when).toBeInstanceOf(Date)
        expect(Number.isNaN((when as Date).getTime())).toBe(true)
      })

      it('hands back a field shaped like its own date marker untouched', async () => {
        // a driver that tags dates inside JSON must not read a caller's own
        // object of the same shape as one
        const fields = {
          payload: { __mh_date: 5 },
          nested: [{ __mh_x: 'y', plain: 1 }],
          at: new Date(7),
        }
        await driver.append([rec('a', 1000, fields)])
        expect((await driver.readPending({ metric: M }))[0]?.fields).toEqual(fields)
      })

      it('keeps what it stored when the caller edits the fields it passed', async () => {
        const fields: Record<string, unknown> = { dog: 'Willow', tags: ['good'] }
        await driver.append([rec('a', 1000, fields)])
        fields.dog = 'Rex'
        ;(fields.tags as string[]).push('bad')

        expect(await driver.readPending({ metric: M })).toEqual([
          { id: 'a', ts: 1000, fields: { dog: 'Willow', tags: ['good'] } },
        ])
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

      it('stops at the limit inside a ts range', async () => {
        await seed()
        const found = await driver.readPending({ metric: M, from: 2000, limit: 1 })
        expect(found.map((r) => r.id)).toEqual(['b'])
      })

      it('hands records back in append order, a backdated one included', async () => {
        await driver.append([rec('late', 3000), rec('early', 1000)])
        const ids = async (query: { from?: number; limit?: number }) =>
          (await driver.readPending({ metric: M, ...query })).map((r) => r.id)

        expect(await ids({})).toEqual(['late', 'early'])
        expect(await ids({ limit: 1 })).toEqual(['late'])
        expect(await ids({ from: 0 })).toEqual(['late', 'early'])
      })

      it('hands out copies, so editing one changes nothing stored', async () => {
        await driver.append([rec('a', 1000, { dog: 'Willow', tags: ['good'] })])
        const [read] = await driver.readPending({ metric: M })
        if (!read) throw new Error('expected one staged record')
        Object.assign(read, { id: 'b' })
        Object.assign(read.fields, { dog: 'Rex' })
        ;(read.fields.tags as string[]).push('bad')

        expect(await driver.readPending({ metric: M })).toEqual([
          { id: 'a', ts: 1000, fields: { dog: 'Willow', tags: ['good'] } },
        ])
      })

      it('does not consume', async () => {
        await seed()
        await driver.readPending({ metric: M })
        expect(await driver.countPending(M)).toBe(3)
      })

      it('sees an append issued before it and not yet awaited', async () => {
        await seed()
        const write = driver.append([rec('d', 4000)])
        const pending = await driver.readPending({ metric: M })
        await write
        expect(pending.map((one) => one.id)).toEqual(['a', 'b', 'c', 'd'])
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
        expect((await driver.readPending({ metric: M })).map((r) => r.id)).toEqual([
          'r2',
          'r3',
          'r4',
        ])
      })

      it('counts claimed records as pending until the claim is settled', async () => {
        // a sink that hangs holds its records in a claim, and they have not
        // shipped. A backlog that read zero then would hide the hang
        await seed(5)
        const claim = await driver.claimRecords(M, 2)
        expect(await driver.countPending(M)).toBe(5)

        await driver.ack(claim)
        expect(await driver.countPending(M)).toBe(3)
      })

      it('puts back two released claims in the order they were taken', async () => {
        // the older claim released first lands at the front; the newer one
        // released after it must go in behind it, not ahead
        await seed(4)
        const older = await driver.claimRecords(M, 2)
        const newer = await driver.claimRecords(M, 2)
        await driver.append([{ metric: M, id: 'later', ts: 9000, fields: {} }])

        await driver.release(older)
        await driver.release(newer)
        expect((await driver.readPending({ metric: M })).map((r) => r.id)).toEqual([
          'r0',
          'r1',
          'r2',
          'r3',
          'later',
        ])
      })

      it('merges a release with interleaved records an earlier release put back', async () => {
        await driver.append([rec('r1', 1), rec('r2', 2), rec('r3', 3)])
        const a = await driver.claimRecords(M, 1)
        const b = await driver.claimRecords(M, 1)
        await driver.release(a)
        const c = await driver.claimRecords(M, 2)
        await driver.release(b)
        await driver.release(c)

        expect((await driver.readPending({ metric: M })).map((r) => r.id)).toEqual([
          'r1',
          'r2',
          'r3',
        ])
      })

      it('puts a release behind a large earlier release in order', async () => {
        const n = 10_002
        await driver.append(Array.from({ length: n }, (_, i) => rec(`r${i + 1}`, i + 1)))
        const a = await driver.claimRecords(M, n - 1)
        const b = await driver.claimRecords(M, 1)
        await driver.release(a)
        await driver.release(b)

        const ids = (await driver.readPending({ metric: M })).map((r) => r.id)
        expect(ids.slice(-3)).toEqual(['r10000', 'r10001', 'r10002'])
      })

      it('reads nothing for a limit of zero', async () => {
        await seed(2)
        expect(await driver.readPending({ metric: M, limit: 0 })).toEqual([])
      })

      it('claims nothing for a limit of zero or below, and all of a backlog under the limit', async () => {
        await seed(3)
        expect((await driver.claimRecords(M, 0)).records).toEqual([])
        expect((await driver.claimRecords(M, -1)).records).toEqual([])
        expect((await driver.claimRecords(M, 10)).records.map((r) => r.id)).toEqual([
          'r0',
          'r1',
          'r2',
        ])
      })

      it('takes a backdated record in append order', async () => {
        await driver.append([rec('late', 3000), rec('early', 1000)])
        expect((await driver.claimRecords(M, 1)).records.map((r) => r.id)).toEqual(['late'])
      })

      it('ack discards the claim for good', async () => {
        await seed(2)
        const claim = await driver.claimRecords(M)
        await driver.ack(claim)

        expect(await driver.countPending(M)).toBe(0)
        await expect(driver.ack(claim)).rejects.toThrow(/not in flight/)
      })

      it('release returns records ahead of anything appended since', async () => {
        // they are older than the new arrivals, and a claim ships oldest first,
        // so putting them at the back would ship out of order
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
