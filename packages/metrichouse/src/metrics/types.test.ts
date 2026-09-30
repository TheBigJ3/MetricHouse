import { describe, expect, it } from 'vitest'
import { pendingWrites } from './types.js'

/** A promise and the functions that settle it, for deciding when a write lands. */
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('pendingWrites', () => {
  it('reports a rejected write once, with its error, and stops waiting on it', async () => {
    const writes = pendingWrites('orders')
    const reported: [unknown, { metric: string }][] = []
    const failure = new Error('driver down')

    const write = deferred()
    writes.track(write.promise, () => (error, context) => {
      reported.push([error, context])
    })
    write.reject(failure)

    // resolves only once the write has left the set: a write still in it
    // would keep drain looping
    await writes.drain()
    expect(reported).toEqual([[failure, { metric: 'orders' }]])
    expect(reported[0]?.[0]).toBe(failure)

    await writes.drain()
    expect(reported).toHaveLength(1)
  })

  it('reads the handler when the write fails, not when it is tracked', async () => {
    const writes = pendingWrites('orders')
    const reported: unknown[] = []
    let handler: ((error: unknown) => void) | undefined

    const write = deferred()
    writes.track(write.promise, () => handler)
    handler = (error) => reported.push(error)
    write.reject('refused')

    await writes.drain()
    expect(reported).toEqual(['refused'])
  })

  it('waits for a write that has not landed', async () => {
    const writes = pendingWrites('orders')
    const write = deferred()
    writes.track(write.promise, () => undefined)

    let drained = false
    const draining = writes.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(drained).toBe(false)

    write.resolve()
    await draining
    expect(drained).toBe(true)
  })

  it('does not wait for a write tracked after drain was called', async () => {
    const writes = pendingWrites('orders')
    const first = deferred()
    const second = deferred()
    writes.track(first.promise, () => undefined)

    const draining = writes.drain()
    writes.track(second.promise, () => undefined)
    first.resolve()
    await draining

    let settled = false
    const settling = writes.settle().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    second.resolve()
    await settling
  })

  it('settles only once a write tracked while it was already waiting has landed', async () => {
    const writes = pendingWrites('orders')
    const first = deferred()
    const second = deferred()
    writes.track(first.promise, () => undefined)

    let drained = false
    const draining = writes.settle().then(() => {
      drained = true
    })
    writes.track(second.promise, () => undefined)
    first.resolve()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(drained).toBe(false)

    second.resolve()
    await draining
    expect(drained).toBe(true)
  })
})
