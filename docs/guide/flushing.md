# Flushing

Flushing is how data leaves MetricHouse and reaches your `write` function.
Nothing flushes on its own. Something has to ask.

## What a flush does

<figure class="mh-figure">
  <img src="/diagrams/claim-ack-release.svg" alt="Data is claimed, handed to your write function, then either acknowledged and deleted or released back." />
  <figcaption>In this order, every time.</figcaption>
</figure>

1. **Check the cadence.** If this metric shipped recently, stop and report that
   it was skipped.
2. **Recover.** Put back anything a previous flusher claimed and then died
   holding, so this flush can ship it. Almost always there is nothing to do, and
   on `memory()` there is never anything to do.
3. **Claim.** Move everything eligible out of the live set. It is now invisible
   to live reads and to any other flush.
4. **Write.** Turn the claim into rows and call your function.
5. **Settle.** If your function returned, delete the claimed data. If it threw,
   put it back unchanged.

Recovery comes before the claim on purpose. A claim that was abandoned is already
out of the live set, so claiming can never find it however long you wait. See
[Recovering a crashed flush](/guide/reliability#recovering-a-crashed-flush).

## Three ways to ask

### One metric

```ts
const report = await httpRequests.flush()
// { buckets: 6, rows: 42, skipped: false }
```

A metric is a complete unit. It knows its own cadence, its own write function and
its own retry state, so this needs no house.

### Every metric in a house

```ts
const report = await house.flush()
report.throwIfFailed()
```

This is a loop over `metric.flush()`. Each metric still honours its own cadence.

### On a timer

```ts
house.start()
```

One timer per metric, at that metric's own cadence. For a server that stays
running.

## The report

Both `metric.flush()` and `house.flush()` tell you what happened rather than
throwing.

```ts
interface MetricFlushReport {
  buckets: number             // time windows in this batch
  rows: number                // rows handed to your write function
  skipped: boolean
  reason?: 'cadence' | 'not-selected'
  nextEligibleInMs?: number   // when the cadence will allow the next attempt
  error?: unknown             // set if your write function threw, or the claim failed
  ackError?: unknown          // set if the rows shipped and settling the claim failed
  recovered?: RecoveryReport  // set if a dead flusher's batch was put back
  recoveryError?: unknown     // set if that repair failed. The flush still ran
}
```

```ts
interface FlushReport {
  ok: boolean                 // false if any metric failed
  durationMs: number
  metrics: Record<string, MetricFlushReport>
  throwIfFailed(): void
}
```

A failure is reported rather than thrown because by the time your function has
thrown, the claim has already been released. The data is safe. You are being
told, not rescued.

`recovered` and `recoveryError` are about a different thing, and neither changes
`ok`. `error` means your sink failed and this batch is going to be retried.
`recovered` means an *earlier* flush died holding a batch and this one put it
back. `recoveryError` means that repair failed, which delays the stranded batch
and nothing else, so the flush underneath it still claims and still ships.

```ts
const report = await house.flush()

for (const [name, result] of Object.entries(report.metrics)) {
  if (result.error) {
    logger.error({ err: result.error, metric: name }, 'flush failed, will retry')
  }
}
```

## Cadence is a floor

The `flush` setting is the fastest a metric is allowed to ship. Asking more often
is harmless.

```ts
setInterval(() => house.flush(), 10_000)
```

With `flush: '5m'` that is 30 calls that report `skipped: true` and one that
ships. Each skipped call is a clock comparison and nothing else.

Ignore the cadence when you need to:

```ts
await httpRequests.flush({ force: true })    // ship everything closed, now
await house.flush({ force: true })
```

Use `force` on shutdown, in tests, and in an admin endpoint. Do not use it on
your normal schedule, since the cadence is what keeps write volume predictable.

::: tip An empty flush does not use up the cadence
If a flush finds nothing to ship, the cadence clock is not advanced. Otherwise an
early empty call would block the next real one for a full interval, which is
worst on metrics with coarse resolutions.
:::

The cadence is measured from the last flush that shipped rows. Before the first
one there is nothing to measure from, so the first flush always goes ahead,
whatever the clock reads. If the clock steps backwards, say an NTP correction of
an hour, the next flush goes ahead too, instead of waiting for the clock to catch
back up.

## Only finished windows ship

A flush takes buckets that have ended and outlived their grace period. The bucket
that is still filling stays where it is.

```ts
requests.add({ route: '/checkout' })
await requests.flush()
// { buckets: 0, rows: 0, skipped: false }   the minute has not ended yet
```

This is not a bug. Shipping a window before it finishes sends a partial value,
and a later send under the same row id would either overwrite it or duplicate it,
depending on your table. If you want that behaviour deliberately, that is
[immediate delivery](/guide/delivery).

Events and logs are different. A record is complete the moment you write it, so
there is no partial state to protect and a flush takes the whole backlog.

## Using the scheduler

```ts
house.start()
```

What it does:

- Creates one interval per metric, at that metric's `flushMs`.
- Skips a tick if the previous one for that metric has not finished, so a slow
  database does not stack writes on top of each other.
- Sends failures to `onError`, since a scheduled flush has no caller to return a
  report to.
- Unreferences its timers, so metrics never keep your process alive.
- Picks up metrics registered after it started.

```ts
house.running     // true
house.start()     // calling again does nothing
```

### Stopping cleanly

```ts
await house.stop()
```

Clears the timers, waits for any flush a timer already started, drains writes
still on their way to the driver, then makes a
[final flush](/reference/flush-options#final): past every cadence, and past
grace, so every window that has ended ships. It returns the report from that
final flush.

Waiting for a running flush matters. If its `write` function fails after
`stop()` was called, the rows go back to the driver, and the final flush is what
ships them.

```ts
process.on('SIGTERM', async () => {
  server.close()
  const report = await house.stop()
  if (!report.ok) logger.error({ report }, 'data left unflushed at shutdown')
  process.exit(0)
})
```

## Flushing without a long running process

On serverless and edge platforms, timers inside a frozen process never fire. Pump
it from outside.

::: code-group

```ts [Vercel cron]
// app/api/cron/flush/route.ts
import { house } from '@/metrics/house'

export async function GET() {
  const report = await house.flush()
  return Response.json({ ok: report.ok, metrics: report.metrics })
}
```

```ts [Cloudflare Workers]
export default {
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(house.flush())
  },
  async fetch(request, _env, ctx) {
    const response = await handle(request)
    ctx.waitUntil(house.drain())    // make sure writes reached the driver
    return response
  },
}
```

```ts [AWS Lambda]
export const handler = async (event) => {
  const response = await handle(event)
  await house.drain()               // before the runtime freezes
  return response
}

// A separate scheduled function, on an EventBridge rule
export const flushHandler = async () => {
  const report = await house.flush()
  if (!report.ok) throw new Error('flush failed')
}
```

:::

Two separate things are happening here, and both are needed:

- **`drain()`** on every request makes sure the writes you just made reached the
  driver before the process freezes.
- **`flush()`** on a schedule moves finished windows out of the driver and into
  your database.

With the memory driver on serverless, `drain()` is not enough, because the data
is inside an isolate that may never run again. Use a shared driver such as
`ioredis()`, or turn on immediate delivery. See
[Deployment targets](/guide/production).

## In production

A worker loop that flushes and reports its own health:

```ts
import { house } from './metrics/house.js'
import { logger } from './logger.js'

let consecutiveFailures = 0

async function pump() {
  try {
    const report = await house.flush()

    if (report.ok) {
      consecutiveFailures = 0
    } else {
      consecutiveFailures += 1
      const failed = Object.entries(report.metrics)
        .filter(([, r]) => r.error)
        .map(([name]) => name)

      logger.error({ failed, consecutiveFailures }, 'flush failed, data retained')

      if (consecutiveFailures >= 10) {
        await pageOnCall('metric flush failing for 10 consecutive attempts')
      }
    }
  } catch (error) {
    // the driver itself failed, not your write function
    logger.error({ err: error }, 'flush could not run')
  }
}

setInterval(pump, 10_000)
```

Nothing is lost while your database is down. Data stays in the driver and ships
when it recovers. What you do need to watch is the driver filling up, which is
what `event.pending()` and the memory driver's limits are for. See
[Reliability](/guide/reliability).
