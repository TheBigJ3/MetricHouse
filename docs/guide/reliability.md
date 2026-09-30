# Reliability

This page says exactly what MetricHouse promises, what it does not, and what you
have to do to hold up your end.

## The promise

**A row is never lost because a write failed. A row may arrive twice.**

That is the trade, and it is deliberate. The alternative would be deleting data
before knowing the write succeeded, which turns every database hiccup into
permanent loss.

<figure class="mh-figure">
  <img src="/diagrams/claim-ack-release.svg" alt="Claim, write, then acknowledge and delete or release and retry." />
  <figcaption>Nothing is deleted until your function returns.</figcaption>
</figure>

When your `write` function throws:

1. Nothing is deleted.
2. The claimed data goes back into the live set, unchanged.
3. The next flush sends the same rows, with the same ids, and `attempt` goes up.
   [Writing a sink](/guide/writing-a-sink#retries-and-failure) says exactly how
   it is counted.

## Making a duplicate harmless

Every row carries an `id`. For counters, gauges and timers that id is derived
from the metric name, the time window and the dimension values, so the same
window shipped twice produces exactly the same id, with no stored state anywhere.

Your table decides what to do about that.

::: code-group

```sql [ClickHouse]
CREATE TABLE http_requests (
  id         String,
  bucket_ts  DateTime64(3),
  route      String,
  value      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, route);
```

```sql [Postgres]
CREATE TABLE http_requests (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  route      TEXT NOT NULL,
  value      BIGINT NOT NULL
);
```

```ts [the insert]
await sql`
  INSERT INTO http_requests ${sql(rows, 'id', 'bucket_ts', 'route', 'value')}
  ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value
`
```

:::

Use `DO UPDATE` rather than `DO NOTHING`. A retry resends a row with the value
it had the first time, so either handles that. Under
[immediate delivery](/guide/delivery) a row is also sent again as its window
fills, with a larger value each time, and `DO UPDATE` keeps the newest.

```ts
import { naturalKey } from 'metrichouse/core'

naturalKey(httpRequests.dims)   // ['bucket_ts', 'route', 'status']
```

That is the column list your table should treat as unique if you would rather key
on the natural columns than on `id`.

For **events and logs**, the id is a UUID version 7 minted when you call
`record()`. Two identical events are two different rows on purpose. Because the
id is minted at record time rather than flush time, a retried batch resends the
same rows rather than creating new ones.

## What is not protected

### A process that dies mid flush, on `memory()`

Between claiming a window and acknowledging it, the data sits in a holding area.
With `memory()` that holding area is a map inside your process, so a crash takes
it too. There is nothing left behind to find.

With `ioredis()` the holding area is a real Redis key, which outlives the process
that wrote it, and a later flush puts it back. See
[Recovering a crashed flush](#recovering-a-crashed-flush).

### Data still on its way to the driver

`add()`, `set()` and `record()` return before storage has confirmed anything. A
process that exits at that instant loses what was still in flight.

```ts
await house.drain()   // resolves once every write issued before it has reached the driver
```

Call `drain()` before exiting, and on every request on a platform that freezes
your process when the response returns. It waits for the writes issued before
the call, and not for those issued while it waits, so a busy server can await
it. Under [immediate delivery](/guide/delivery) it also waits for the send to
your `write` function that follows each of those writes.

A write the driver refuses after `record()` has returned goes to
[`onError`](#where-errors-go), and that record is lost. For records that must not
be lost that way, declare the event
[`durability: 'durable'`](/primitives/event#durability). Its `record()` returns
a promise that resolves only once the driver has the record, and rejects
otherwise, so the caller can fail the request instead of reporting success.

### The window that is still filling

`house.stop()` makes a final flush that takes every window that has ended,
including those still inside grace, since the process has already drained its
own writes. It waits for every flush still running first, so rows that a failed
sink put back during shutdown ship with the rest. The one it cannot ship is the
open window, because it has not ended. At most one `resolution` of data is
exposed to a shutdown.

On a shared, durable driver such as `ioredis()` the final flush takes the
metric's [turn](/guide/flushing#several-processes-on-one-driver) like any other
flush. When another process holds the turn, the final flush ships nothing for
that metric and reports `skipped: true`. Nothing is lost: the rows stay in Redis
and ship with whichever process takes the next turn. If no process takes one,
because every one has stopped, they wait until one runs again.

Keep the resolution of anything important small, or turn on
[immediate delivery](/guide/delivery) so those values reach your database as they
happen.

### Writes that arrive very late

Grace holds a just finished window back from the flush for a little longer. A
write that arrives after its window has been claimed anyway is moved forward
into the oldest window that has not shipped, and ships with that one. Nothing
is lost and no window ships twice with different values, so a table that keeps
one row per id stays correct. The write is counted a window late, which is the
price of that. [Buckets and time](/guide/buckets-and-time#a-write-that-misses-its-window)
has the details.

## Recovering a crashed flush

A claim moves data out of the live set. That is what stops two instances shipping
the same window, and it is also why a process that dies holding one leaves data
that no later flush can see: a flush claims from the live set, and the claimed
window is no longer in it.

With `ioredis()` that window is still in Redis under a key of its own. Every
flush that is going to claim first looks for claims that have been held too long,
merges them back into the live set, and then claims as usual. Usually that same
flush ships what it just repaired. Two cases leave part of it for later flushes:

- **A recovering process whose clock is behind** claims up to a watermark worked
  out from its own clock, and a repaired window at or past that watermark waits
  for a flush whose clock has passed it.
- **An event or a log with a [`claimLimit`](/primitives/event#claimlimit)**
  ships at most a hundred claims of that size per flush, and a repaired backlog
  larger than that ships over several flushes.

You do not turn this on. It is what `ioredis()` does.

```ts
const report = await house.flush()

// absent on an ordinary flush, so its presence is the news
if (report.metrics.http_requests?.recovered) {
  logger.warn('a flusher died holding a batch, and it has been put back')
}
```

```ts
interface RecoveryReport {
  claims: number             // abandoned claims put back
  buckets: number            // windows put back, across those claims
  records: number            // records put back, across those claims
  oldestClaimedAt?: number   // when the longest stranded one was taken
}
```

Something crashing between a claim and its acknowledgement is worth knowing
about, so report it rather than letting it heal quietly:

```ts
setInterval(async () => {
  const report = await house.flush()

  for (const [metric, result] of Object.entries(report.metrics)) {
    if (result.recovered) {
      const { claims, buckets, records, oldestClaimedAt } = result.recovered
      logger.warn(
        { metric, claims, buckets, records, strandedForMs: Date.now() - oldestClaimedAt! },
        'recovered a batch a dead flusher was holding',
      )
    }

    // the sweep failed. The flush below it still ran, so rows still shipped.
    if (result.recoveryError) {
      logger.error({ err: result.recoveryError, metric }, 'recovery pass failed')
    }
  }
}, 10_000)
```

### How long it waits

A claim held by a flusher that is still writing looks exactly like a claim held
by one that has died. The only thing separating them is how long it has been
held, so that is what the driver goes on.

```ts
ioredis(client, { recoverAfter: '5m' })    // the default
```

Set this above your sink's timeout. Set it lower and a slow write can have its
window taken back and shipped by another instance, which sends those rows twice
and then fails the original flush's acknowledgement. Neither of those loses
data, because both sends carry the same row ids, but it is noise you do not
need. The failed acknowledgement comes back on that flush's report as
`ackError`, next to the rows it did ship, and the rest of the house still
flushes. Set it higher and a window from a crashed flusher waits longer to ship.

Waiting is much the cheaper mistake, which is why the default is generous.

### Why it puts the window back rather than shipping it

A recovered window goes back into the live set. It is never sent straight to your
database, so it ships through the same flush, sink and acknowledgement as
everything else.

It comes back exactly as the crashed flusher claimed it. A write aimed at a
window some flush has claimed is moved forward to a window that has not shipped
([Buckets and time](/guide/buckets-and-time#a-write-that-misses-its-window)), so
nothing can land in the stranded window while it waits. The next flush sends the
same row, with the same id and the same value, that the crashed one may already
have sent, and a table that treats `id` as unique keeps one copy.

Records are put back at the head of the queue, behind any older records a failed
flush already put back, so they ship in the order they arrived.

### What it does not cover

- **`memory()` has nothing to recover.** Its claims live in the process that took
  them, so a crash leaves nothing behind. `recover()` on it always reports zero,
  and that is honest rather than unimplemented.
- **A metric removed from your schema stops being swept**, because nothing
  flushes it any more. Flush it once more before you delete it.
- **A locally staged event or log**, `stage: 'local'`, waits in your process
  rather than in the driver, so the same limit applies as for `memory()`.
- **A recovery that fails** is reported as `recoveryError` and does not stop the
  flush. The live data still ships, so one stuck claim never becomes a metric
  that stops delivering.

## Where errors go

Some failures cannot be thrown at a caller, because the caller has already moved
on. `add()` returned before storage answered. `record()` already decided to keep
the event. Those failures go to `onError`.

```ts
const house = createHouse({
  driver,
  schema,
  onError: (error, { metric }) => {
    logger.error({ err: error, metric }, 'metric failure')
  },
})
```

`onError` receives:

- A driver write that failed after `add()`, `set()` or `record()` returned. A
  durable event's `record()` has not returned by then, so its failure rejects
  the promise instead and does not come here.
- A flush that failed on a scheduler tick, where nobody is holding the promise.
  Its `releaseError`, `recoveryError` and `ackError` come here too.
- A send under [immediate delivery](/guide/delivery) whose `write` function
  threw, for any metric type.
- A locally staged event or log whose `write` function threw when it shipped
  itself on `batch.maxSize`, `batch.maxAge` or `drain()`.
- A broken `derive` on an event, or a broken `record` pairing on a timer.
- An `onWarn` that threw while the house registered a metric. The metric is
  registered anyway.

Without a handler these become unhandled promise rejections. That is noisy, and
deliberately better than a failure disappearing quietly. A handler that throws
is raised the same way, and neither case stops `drain()` or `stop()` from
waiting for the rest.

`onWarn` receives startup warnings about your setup, and there are three kinds:

```ts
onWarn: (message) => logger.warn({ message }, 'metrichouse')
```

- The driver cannot survive a restart, so the guarantee is best effort.
- Delivery is immediate, so your table has to keep the newest row per id.
- An event declared `durability: 'durable'` is bound to a driver that cannot
  survive a restart. This one comes once per such event, when the house
  registers it, with the event's name in `metric`.

## Failures you do get to handle

Errors that happen while your code is on the stack are thrown normally.

```ts
// Throws: 'unknown' is not a declared value
httpRequests.add({ route: '/x', method: 'GET', status: 'unknown' })

// Throws: this metric was never registered with a house
unboundCounter.add()

// Throws: '7s' does not divide '1m' evenly
counter('bad', { resolution: '7s', flush: '1m', write })
```

These are programming errors, and the earliest possible failure is the most
useful one.

The one deliberate exception is a log message. Any level accepts a value that is
not a string and turns it into one rather than throwing, because that call is
made from inside a `catch` block and a logger that takes down a request handler
is worse than a row that reads `"42"`.

## What to watch

### Backlog

If your database is unreachable, data accumulates in the driver. Nothing is lost,
but memory is not free.

```ts
// Events and logs report their backlog directly.
await signups.pending()       // 128 records staged, not yet shipped

// Redis reports how many series a metric is holding.
await driver.scanSeries('http_requests')
```

The `memory()` driver refuses writes past `maxSeries` or `maxStaged` and names
the metric in the error, which turns a slow memory leak into a loud failure.

### Repeated failures

```ts
let consecutiveFailures = 0

setInterval(async () => {
  const report = await house.flush()

  if (report.ok) {
    consecutiveFailures = 0
    return
  }

  consecutiveFailures += 1
  const failed = Object.entries(report.metrics)
    .filter(([, r]) => r.error)
    .map(([name]) => name)

  logger.error({ failed, consecutiveFailures }, 'flush failed, data retained')

  if (consecutiveFailures >= 10) {
    await pageOnCall('metric flush failing for 10 consecutive attempts')
  }
}, 10_000)
```

### The attempt counter

```ts
write: async (rows, context) => {
  if (context.attempt > 1) {
    logger.warn({ metric: context.metric, attempt: context.attempt }, 'retrying')
  }
  await db.insert(rows)
}
```

A rising `attempt` means the same rows have failed several times. After enough
tries, write them somewhere else and return normally so they stop being retried:

```ts
write: async (rows, context) => {
  if (context.attempt > 5) {
    await s3.put(`dead-letter/${context.metric}/${Date.now()}.json`, JSON.stringify(rows))
    return
  }
  await db.insert(rows)
}
```

## A checklist before going live

- [ ] Your table treats `id` as unique, or you upsert on the natural key.
- [ ] Your `write` function rethrows on failure rather than swallowing.
- [ ] `onError` is wired to your logger.
- [ ] `onWarn` is wired, and you have read what it says at startup.
- [ ] `house.stop()` runs on `SIGTERM`.
- [ ] `house.drain()` runs before a serverless response returns.
- [ ] Your dimensions have a small, known set of values.
- [ ] Events a caller must not lose are `durability: 'durable'`, and Redis runs
      with `appendonly yes`, `appendfsync always`, and a `maxmemory-policy`
      that cannot evict them.
- [ ] Something alerts on repeated flush failures.
- [ ] Your sink has a timeout, and `recoverAfter` is longer than it.
- [ ] Your sink chunks very large batches.
