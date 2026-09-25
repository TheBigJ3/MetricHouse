import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import type { Driver } from '../drivers/types.js'
import { createHouse } from '../runtime/house.js'
import { int, str } from '../schema/types.js'
import { log } from './log.js'
import type { Row, WriteContext, WriteFn } from './types.js'

/** A sink that keeps nothing — for declaration tests that never ship. */
const discard: WriteFn = () => {}

function expectRejected(fn: () => unknown): Error {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught, 'expected the call to throw').toBeInstanceOf(Error)
  return caught as Error
}

const makeFields = () => ({
  requestId: str().optional(),
  userId: str().optional(),
  service: str(),
})
type Fields = ReturnType<typeof makeFields>

let clock: number
let driver: Driver
const now = () => clock

/** A log bound to a driver, staged locally so nothing needs a house. */
function bound(overrides: Partial<Parameters<typeof log<Fields>>[1]> = {}) {
  const metric = log('app_log', {
    fields: makeFields(),
    ...overrides,
    write: overrides.write ?? discard,
  })
  metric.bind({ driver, now })
  return metric
}

/** Stage, flush by hand, and return the rows the sink saw. */
async function shipped(metric: {
  claimBatch(n: number): Promise<unknown>
  materializeClaim(c: never): { rows: Row[] }
}): Promise<Row[]> {
  const claim = await metric.claimBatch(clock)
  return metric.materializeClaim(claim as never).rows
}

beforeEach(() => {
  clock = 1_788_616_987_000
  driver = memory()
})

describe('declaration', () => {
  it('is inert — a declaration is not bound to anything', () => {
    const appLog = log('app_log', { write: discard, fields: makeFields() })
    expect(appLog.isBound).toBe(false)
    expect(expectRejected(() => appLog.info('x', { service: 'api' })).message).toMatch(
      /not bound to a house/,
    )
  })

  it('refuses an empty name', () => {
    expect(expectRejected(() => log('  ', { write: discard })).message).toMatch(/non-empty/)
  })

  it('reports itself as a log, not as the event it is built on', () => {
    expect(bound().kind).toBe('log')
  })

  it('declares the four default levels', () => {
    expect(bound().levels).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('keeps everything when minLevel is omitted', () => {
    expect(bound().minLevel).toBe('debug')
  })

  it('refuses an empty level set', () => {
    expect(expectRejected(() => log('l', { write: discard, levels: [] })).message).toMatch(
      /at least one level/,
    )
  })

  it('refuses a duplicated level', () => {
    expect(
      expectRejected(() => log('l', { write: discard, levels: ['info', 'info'] })).message,
    ).toMatch(/declared twice/)
  })

  it.each(['drain', 'child', 'at', 'name', 'peek', 'toString', 'constructor', '__proto__'])(
    'refuses a level named %s, which would shadow the property of that name',
    (level) => {
      expect(
        expectRejected(() => log('l', { write: discard, levels: ['info', level] })).message,
      ).toMatch(/would shadow an existing property/)
    },
  )

  it('refuses a minLevel that is not a declared level', () => {
    expect(
      expectRejected(() =>
        log('l', { write: discard, levels: ['low', 'high'], minLevel: 'medium' as 'low' }),
      ).message,
    ).toMatch(/not one of the declared levels/)
  })

  it.each(['id', 'ts', 'level', 'message', 'error_stack', '_ingested_at', '_sample_rate'])(
    'refuses a field named %s — MetricHouse owns that column',
    (reserved) => {
      expect(
        expectRejected(() => log('l', { write: discard, fields: { [reserved]: str() } })).message,
      ).toMatch(/reserved column/)
    },
  )

  it('defaults to driver staging, like the event underneath', () => {
    expect(bound().stage).toBe('driver')
  })
})

describe('levels', () => {
  it('gives one method per declared level, and nothing else', () => {
    const appLog = bound()
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(typeof (appLog as unknown as Record<string, unknown>)[level]).toBe('function')
    }
    expect((appLog as unknown as Record<string, unknown>).trace).toBeUndefined()
  })

  it('names the methods after custom levels, replacing the defaults', () => {
    const audit = log('audit', { write: discard, levels: ['low', 'high'] })
    audit.bind({ driver, now })
    expect(typeof audit.high).toBe('function')
    expect((audit as unknown as Record<string, unknown>).info).toBeUndefined()
  })

  it('puts the level on the row', async () => {
    const appLog = bound()
    appLog.warn('slow query', { service: 'api' })
    await appLog.drain()

    const rows = await shipped(appLog)
    expect(rows[0]).toMatchObject({ level: 'warn', message: 'slow query', service: 'api' })
  })

  it('writes at a level chosen at runtime', async () => {
    const appLog = bound()
    const level: 'info' | 'error' = 'error'
    appLog.at(level, 'dynamic', { service: 'api' })
    await appLog.drain()

    expect((await shipped(appLog))[0]).toMatchObject({ level: 'error' })
  })

  it('refuses a dynamic level nobody declared', () => {
    const appLog = bound()
    expect(
      expectRejected(() => appLog.at('trace' as 'info', 'x', { service: 'api' })).message,
    ).toMatch(/not one of the declared levels/)
  })
})

describe('minLevel', () => {
  it('drops anything below it before the driver sees it', async () => {
    const appLog = bound({ minLevel: 'info' })
    appLog.debug('never shipped', { service: 'api' })
    await appLog.drain()
    expect(await appLog.pending()).toBe(0)
  })

  it('keeps the level it names, and everything above', async () => {
    const appLog = bound({ minLevel: 'info' })
    appLog.info('kept', { service: 'api' })
    appLog.warn('kept', { service: 'api' })
    appLog.error('kept', { service: 'api' })
    await appLog.drain()
    expect(await appLog.pending()).toBe(3)
  })

  it('orders by declaration, not alphabetically', async () => {
    // 'alpha' sorts before 'zulu' but is declared above it — severity is the
    // order you wrote, which is the only ordering that works for custom sets
    const audit = log('audit', { write: discard, levels: ['zulu', 'alpha'], minLevel: 'alpha' })
    audit.bind({ driver, now })
    audit.zulu('dropped')
    audit.alpha('kept')
    await audit.drain()
    expect(await audit.pending()).toBe(1)
  })

  it('does not even validate a dropped call', () => {
    // the point of minLevel is that a filtered log costs one array index, so
    // the fields are never touched — a debug line is free in production
    const appLog = bound({ minLevel: 'info' })
    expect(() => appLog.debug('x', undefined as unknown as { service: string })).not.toThrow()
  })

  it('still validates a kept call', () => {
    const appLog = bound({ minLevel: 'info' })
    expect(expectRejected(() => appLog.info('x', {} as { service: string })).message).toMatch(
      /missing required field "service"/,
    )
  })
})

describe('errors', () => {
  it('takes an Error, splitting it into message and error_stack', async () => {
    const appLog = bound()
    appLog.error(new Error('payment declined'), { service: 'api' })
    await appLog.drain()

    const row = (await shipped(appLog))[0] as Row
    expect(row.message).toBe('payment declined')
    expect(row.error_stack).toMatch(/^Error: payment declined\n\s+at /)
  })

  it('accepts an Error at any level, not only error()', async () => {
    const appLog = bound()
    appLog.warn(new Error('retrying'), { service: 'api' })
    await appLog.drain()
    expect((await shipped(appLog))[0]).toMatchObject({ level: 'warn', message: 'retrying' })
  })

  it('falls back to the header line when an Error carries no stack', async () => {
    const appLog = bound()
    const err = new TypeError('cross-realm')
    delete (err as { stack?: string }).stack
    appLog.error(err, { service: 'api' })
    await appLog.drain()

    expect((await shipped(appLog))[0]?.error_stack).toBe('TypeError: cross-realm')
  })

  it('leaves error_stack off a string message', async () => {
    const appLog = bound()
    appLog.info('plain', { service: 'api' })
    await appLog.drain()

    expect((await shipped(appLog))[0]).not.toHaveProperty('error_stack')
  })

  it('coerces a message that is neither string nor Error rather than throwing', async () => {
    // a logger that takes down a request because someone passed a number is
    // worse than a row reading "42"
    const appLog = bound()
    appLog.info(42 as unknown as string, { service: 'api' })
    await appLog.drain()

    expect((await shipped(appLog))[0]?.message).toBe('42')
  })
})

describe('child', () => {
  it('merges its bound fields into every call', async () => {
    const appLog = bound()
    const reqLog = appLog.child({ requestId: 'req_9f21', service: 'api' })
    reqLog.info('walk booked', { userId: 'u_42' })
    await appLog.drain()

    expect((await shipped(appLog))[0]).toMatchObject({
      requestId: 'req_9f21',
      service: 'api',
      userId: 'u_42',
    })
  })

  it('lets the call site win over a bound field', async () => {
    const appLog = bound()
    const reqLog = appLog.child({ service: 'api', userId: 'u_1' })
    reqLog.info('closer context wins', { userId: 'u_2' })
    await appLog.drain()

    expect((await shipped(appLog))[0]).toMatchObject({ userId: 'u_2' })
  })

  it('nests, keeping what the parent bound', async () => {
    const appLog = bound()
    const deeper = appLog.child({ service: 'api' }).child({ requestId: 'req_1' })
    deeper.info('nested')
    await appLog.drain()

    expect((await shipped(appLog))[0]).toMatchObject({ service: 'api', requestId: 'req_1' })
  })

  it('stages into the log that made it — a child is not a second metric', async () => {
    const appLog = bound()
    appLog.child({ service: 'api' }).info('one')
    appLog.info('two', { service: 'api' })
    await appLog.drain()

    expect(await appLog.pending()).toBe(2)
  })

  it('honours minLevel', async () => {
    const appLog = bound({ minLevel: 'warn' })
    const reqLog = appLog.child({ service: 'api' })
    reqLog.info('dropped')
    reqLog.error('kept')
    await appLog.drain()

    expect(await appLog.pending()).toBe(1)
  })

  it('writes at a dynamic level too', async () => {
    const appLog = bound()
    appLog.child({ service: 'api' }).at('warn', 'dynamic')
    await appLog.drain()

    expect((await shipped(appLog))[0]).toMatchObject({ level: 'warn', service: 'api' })
  })

  it('exposes what it bound, and the copy cannot be edited', () => {
    const reqLog = bound().child({ service: 'api' })
    expect(reqLog.bound).toEqual({ service: 'api' })
    expect(Object.isFrozen(reqLog.bound)).toBe(true)
  })

  it('carries the log name', () => {
    expect(bound().child({ service: 'api' }).name).toBe('app_log')
  })
})

describe('fields', () => {
  it('validates a declared field like any other', () => {
    const jobLog = log('job_log', { write: discard, fields: { attempt: int() } })
    jobLog.bind({ driver, now })
    expect(expectRejected(() => jobLog.info('x', { attempt: 1.5 })).message).toMatch(/safe integer/)
  })

  it('rejects a field the log never declared', () => {
    const jobLog = log('job_log', { write: discard, fields: { attempt: int() } })
    jobLog.bind({ driver, now })
    expect(
      expectRejected(() => jobLog.info('x', { nope: 1 } as unknown as { attempt: number })).message,
    ).toMatch(/unknown field "nope"/)
  })

  it('applies a field default', async () => {
    const jobLog = log('job_log', { write: discard, fields: { attempt: int().default(1) } })
    jobLog.bind({ driver, now })
    jobLog.info('x')
    await jobLog.drain()

    expect((await shipped(jobLog))[0]).toMatchObject({ attempt: 1 })
  })
})

describe('rows', () => {
  it('puts the reserved columns first, in a fixed order', () => {
    expect(
      bound()
        .rowShape()
        .columns.map((c) => c.name),
    ).toEqual([
      'id',
      'ts',
      'level',
      'message',
      'error_stack',
      'requestId',
      'userId',
      'service',
      '_ingested_at',
    ])
  })

  it('types level as the closed set it is', () => {
    const level = bound()
      .rowShape()
      .columns.find((c) => c.name === 'level')
    expect(level).toEqual({ name: 'level', kind: 'oneOf', optional: false })
  })

  it('stamps ts from the clock', async () => {
    const appLog = bound()
    appLog.info('x', { service: 'api' })
    await appLog.drain()

    expect((await shipped(appLog))[0]?.ts).toEqual(new Date(clock))
  })

  it('peeks without consuming', async () => {
    const appLog = bound()
    appLog.info('x', { service: 'api' })
    await appLog.drain()

    expect(await appLog.peek()).toHaveLength(1)
    expect(await appLog.pending()).toBe(1)
  })
})

describe('in a house', () => {
  it('is picked out of a schema module and flushed like anything else', async () => {
    const write = vi.fn<(rows: Row[], context: WriteContext) => Promise<void>>(async () => {})
    const appLog = log('app_log', { fields: makeFields(), minLevel: 'info', write })
    const house = createHouse({ driver, schema: { appLog }, now })

    expect(house.get('app_log')).toBe(appLog)

    const reqLog = appLog.child({ requestId: 'req_9f21', service: 'api' })
    reqLog.info('walk booked', { userId: 'u_42' })
    reqLog.error(new Error('payment declined'), { userId: 'u_42' })
    appLog.debug('never shipped', { service: 'api' })
    await house.drain()

    const report = await house.flush()
    expect(report.ok).toBe(true)
    expect(report.metrics.app_log).toMatchObject({ rows: 2 })

    const [rows, context] = write.mock.calls[0] as [Row[], WriteContext]
    expect(context).toMatchObject({ metric: 'app_log', kind: 'log', total: 2, source: 'flush' })
    expect(rows.map((r) => r.message)).toEqual(['walk booked', 'payment declined'])
  })

  it('ships a locally staged batch on its own, reporting itself as a log', async () => {
    const write = vi.fn<(rows: Row[], context: WriteContext) => Promise<void>>(async () => {})
    const appLog = log('app_log', {
      fields: makeFields(),
      stage: 'local',
      batch: { maxSize: 2 },
      write,
    })
    appLog.bind({ driver, now })

    appLog.info('one', { service: 'api' })
    appLog.info('two', { service: 'api' })
    await appLog.drain()

    expect(write).toHaveBeenCalledTimes(1)
    const [, context] = write.mock.calls[0] as [Row[], WriteContext]
    expect(context).toMatchObject({ kind: 'log', source: 'batch' })
  })
})

describe('level names that would hide a method', () => {
  it('refuses every property the logger already has', () => {
    const write: WriteFn = () => {}
    const built = log('app', { write })
    const reserved = Object.keys(built).filter(
      (key) => !['debug', 'info', 'warn', 'error'].includes(key),
    )
    for (const name of reserved) {
      expect(() => log('app', { write, levels: ['info', name] }), name).toThrow(/shadow/)
    }
  })
})

describe('child fields and errors from elsewhere', () => {
  it('keeps a bound value when the call passes undefined for it', async () => {
    const rows: Row[] = []
    const app = log('app', {
      fields: { requestId: str() },
      write: (batch) => {
        rows.push(...batch)
      },
    })
    const house = createHouse({ driver: memory(), schema: [app] })
    app.child({ requestId: 'r1' }).info('hi', { requestId: undefined } as never)
    await house.flush({ force: true })
    expect(rows[0]?.requestId).toBe('r1')
  })

  it('keeps the stack of an error made in another realm', async () => {
    const { runInNewContext } = await import('node:vm')
    const rows: Row[] = []
    const app = log('app', {
      write: (batch) => {
        rows.push(...batch)
      },
    })
    const house = createHouse({ driver: memory(), schema: [app] })
    app.error(runInNewContext('new Error("far away")') as Error)
    await house.flush({ force: true })
    expect(rows[0]?.message).toBe('far away')
    expect(String(rows[0]?.error_stack)).toMatch(/far away/)
  })
})
