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

Use `DO UPDATE` rather than `DO NOTHING`. A resent row can carry a larger value
than the first send if a late write landed in the meantime, and you want the
newer number.

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

### A process that dies mid flush

Between claiming a window and acknowledging it, the data sits in a holding area.

- With **`ioredis()`**, that holding area is a real Redis key, so the data is
  still there after the crash. It is not yet swept back into the live set
  automatically, which means that window stays staged and undelivered until you
  intervene. This is a known gap and is tracked in the repository.
- With **`memory()`**, the holding area is a map inside your process, so the
  window is gone.

### Data still on its way to the driver

`add()`, `set()` and `record()` return before storage has confirmed anything. A
process that exits at that instant loses what was still in flight.

```ts
await house.drain()   // resolves once every queued write has reached the driver
```

Call `drain()` before exiting, and on every request on a platform that freezes
your process when the response returns.

### The window that is still filling

`house.stop()` cannot ship the open window, because it has not ended. At most one
`resolution` of data is exposed to a shutdown.

Keep the resolution of anything important small, or turn on
[immediate delivery](/guide/delivery) so those values reach your database as they
happen.

### Writes that arrive very late

Grace holds a just finished window open a little longer. A write arriving after
grace has passed lands in a window that has already shipped. That window ships
again, with the same id and a larger value, so a table that keeps the newest row
per id ends up correct and one that adds duplicates does not.

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

- A driver write that failed after `add()`, `set()` or `record()` returned.
- A flush that failed on a scheduler tick, where nobody is holding the promise.
- A broken `derive` on an event, or a broken `record` pairing on a timer.

Without a handler these become unhandled promise rejections. That is noisy, and
deliberately better than a failure disappearing quietly.

`onWarn` receives startup warnings about your setup, and there are two of them:

```ts
onWarn: (message) => logger.warn({ message }, 'metrichouse')
```

- The driver cannot survive a restart, so the guarantee is best effort.
- Delivery is immediate, so your table has to keep the newest row per id.

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
- [ ] Something alerts on repeated flush failures.
- [ ] Your sink has a timeout.
- [ ] Your sink chunks very large batches.
