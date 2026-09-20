# level

A level records a quantity that stays where you put it. Where a gauge asks
"what was it when we looked", a level asks "what is it now", and keeps
answering between the moments anybody looks.

```ts
import { level, oneOf } from 'metrichouse/core'

export const queueDepth = level('queue_depth', {
  dims: { queue: oneOf(['email', 'export', 'webhooks']) },
  resolution: '1m',
  flush: '1m',
  write: async (rows) => clickhouse.insert({ table: 'queue_depth', values: rows }),
})
```

```ts
queueDepth.set(42, { queue: 'email' })
```

Every minute from then on carries a row saying 42, until something sets it to
something else.

## Use it for

Queue depth, requests in flight, connections checked out of a pool, items
waiting in a buffer, workers currently running, a feature flag rollout
percentage. Anything that has a value between the times you write to it.

## Why this is not a gauge

A gauge stores what was observed in a window, so a window with no observations
is absent. On a chart that is a hole.

<figure class="mh-figure">
  <img src="/diagrams/level-carry.svg" alt="A gauge leaves holes in windows with no observation. A level carries the last value into them." />
  <figcaption>The same three writes, stored two ways.</figcaption>
</figure>

That is right for a value you sample and wrong for a value that persists. A
queue at 42 is still at 42 during the minute nobody asked about it, and a hole
in the chart reads like the queue stopped existing. A level fills those windows
in, which is the whole reason it is a separate type.

The cost is rows. A counter writes a row for a window something happened in. A
level writes a row for every window, for every series, whether or not anything
moved. Ten series at `resolution: '1m'` is 5.2 million rows a year from a system
that may be completely idle. Reach for a gauge when you are sampling something,
and for a level when the gap between writes is the part you need filled.

## Writing

```ts
queueDepth.set(42, { queue: 'email' })     // it is now 42
queueDepth.set(38, { queue: 'email' })     // it is now 38
```

`set()` replaces. Unlike a gauge, a second write in the same window is not a
second observation, it is the value changing.

For quantities that are counted in and out, `inc()` and `dec()` move the series
without your having to know where it was:

```ts
const inFlight = level('requests_in_flight', { resolution: '10s', flush: '1m', write })

app.use(async (c, next) => {
  inFlight.inc()
  try {
    await next()
  } finally {
    inFlight.dec()
  }
})
```

A series nothing has written to starts at zero when it is moved, so the first
`inc()` puts it at 1.

## Reading

```ts
// What one series is at right now.
await queueDepth.current({ queue: 'email' })
// 42, or undefined if nothing has ever written to it

// Every queue added up.
await queueDepth.totals()
// 61
```

`current()` reads the held value rather than the open window, which is the
difference that matters: the window you are in may well have nothing in it, and
the level is still 42.

It returns `undefined` rather than `0` for a series nothing has written to,
because a zero is a claim that the queue exists and is empty, and that is a
different thing from not knowing yet.

`totals()` adds every series up. That is the merge a level can make honestly,
and it is the opposite of the gauge's: a gauge drops `last` from its totals
because several series have no single latest observation, while a level's held
values are all true at the same moment, so adding them gives the total depth
across every queue.

```ts
await queueDepth.snapshot()
await queueDepth.snapshot({ dims: { queue: 'email' } })
await queueDepth.snapshot({ rollup: 'sum', groupBy: ['queue'] })
```

A rollup takes the latest value per series, then adds the series up, in that
order. Merging one series across windows is the latest of them, because the
earlier ones have been superseded. Merging several series within one window is
their sum, because all of them are true at once.

## How a window nobody wrote to gets a row

Each flush does one thing before it claims anything: it walks every series
forward from the last window it carried, up to the newest closed window, and
writes the held value into each one that is empty.

```
writes        42 .  .  .  38 .  .
stored        42 42 42 42 38 38 38
              ^           ^
              set()       set()
```

The walk goes forwards through what was actually written, rather than stamping
the current value across the whole gap. Set a queue to 42 at noon and to 38 at
three, and the windows in between hold 42. The queue changed at three, so it did
not change at noon.

A value somebody wrote always beats a carried one, whichever of the two lands
first. Two processes carrying the same window write the same number, so they
cannot disagree.

Three consequences worth knowing:

- **A series appears from its first write.** Nothing is backfilled before it, so
  a queue declared on Monday and first written on Friday has no Monday rows.
- **The carry happens at flush.** A level that never flushes never carries, so
  the windows appear when the metric ships rather than as the clock passes.
- **Coming back from downtime leaves a gap.** A process off for a day owes
  86,400 windows per series at `resolution: '1s'`, and writing them would claim
  the queue was measured throughout a period when nothing was watching. Past
  `MAX_CARRY_BUCKETS`, which is 10,000, the older windows are skipped and the
  gap stays in the data.

## When a series should stop

A level holds forever by default, which is the point of it. That becomes wrong
when a series can go away.

```ts
export const workerQueue = level('worker_queue', {
  dims: { worker: str() },
  resolution: '1m',
  flush: '1m',

  // A worker that dies stops reporting after five idle minutes, instead of
  // leaving its last queue depth on the chart forever.
  holdFor: '5m',

  write: toClickHouse('worker_queue'),
})
```

Past `holdFor` the series is forgotten and stops producing rows. Writing to it
again brings it back, starting from that write. The clock runs from the window
the last write landed in, so it rounds to whole windows rather than to the
millisecond, and it has to be at least one `resolution` long.

Without `holdFor` a dim whose values come and go will grow forever: every
`worker` id that has ever appeared keeps producing a row every window. That is
the one way a level can quietly become expensive.

## The rows you receive

```ts
{
  id: '...',
  bucket_ts: Date,
  queue: 'email',
  value: 42,
}
```

One `value` column, which is what the series was at when the window closed.
Inside `write`, each row is a `LevelRow` and `queue` is one of the three values
you listed. See [Rows are typed](../guide/writing-a-sink.md#rows-are-typed).

::: code-group

```sql [ClickHouse]
CREATE TABLE queue_depth (
  id         String,
  bucket_ts  DateTime64(3),
  queue      LowCardinality(String),
  value      Float64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, queue);
```

```sql [Postgres]
CREATE TABLE queue_depth (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  queue      TEXT NOT NULL,
  value      DOUBLE PRECISION NOT NULL
);
```

:::

The headline number a sink is handed in `context.total` is where every series
stood at the end of the batch, not the sum of every row in it. A level that sat
at 42 for five windows would otherwise report 210, which is a number nothing
corresponds to.

## Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the value down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late write may still land |
| `holdFor` | duration | forever | How long a series keeps reporting after its last write |
| `value` | field type | `float()` | `int()` refuses fractions |
| `write` | function | required | Where the rows go |

## Tune it

A level buckets exactly like a counter, so the same two settings decide the same
things. The difference is that every series produces a row in every window
rather than only in the windows it was written in.

<MhBucketExplorer metric="queue_depth" kind="level" resolution="1m" flush="1m" :series="6" />

## In production

A job queue, sampled by the worker that owns it.

```ts
// metrics/schema.ts
import { level, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const queueDepth = level('queue_depth', {
  dims: {
    queue: oneOf(['email', 'export', 'webhooks']),
    instance: str(),
  },

  // One row per minute per queue per instance. Coarse enough to stay cheap,
  // fine enough to show a backlog building before anyone complains.
  resolution: '1m',
  flush: '1m',

  // An instance that stops reporting for ten minutes has gone away, and its
  // last depth should go with it rather than sit on the chart.
  holdFor: '10m',

  write: toClickHouse('queue_depth'),
})
```

```ts
// queue/report.ts
import { queueDepth } from '../metrics/schema.js'
import { queues } from './queues.js'

const instance = process.env.HOSTNAME ?? 'local'

export function startReporting() {
  // Written on change rather than on a timer: a level does not need a
  // sample per window, because the windows in between are filled in for it.
  for (const [name, queue] of Object.entries(queues)) {
    queue.on('change', () => {
      queueDepth.set(queue.size(), { queue: name, instance })
    })
  }
}
```

```sql
-- The deepest each queue got per hour, and where it sat on average.
SELECT
  toStartOfHour(bucket_ts) AS hour,
  queue,
  max(value) AS deepest,
  avg(value) AS typical
FROM queue_depth
WHERE bucket_ts >= now() - INTERVAL 1 DAY
GROUP BY hour, queue
ORDER BY deepest DESC;
```

### Shedding load on depth

Because the held value is readable before anything ships, a level can drive a
decision.

```ts
export async function shouldPause(queue: string) {
  const depth = await queueDepth.current({ queue, instance })

  // Nothing has reported yet, so there is no backlog to react to.
  if (depth === undefined) return false

  return depth > 10_000
}
```

## What a level does not do

**It does not aggregate within a window.** A series written five times in one
minute stores the fifth value, and the other four are gone. If you want the
minimum and maximum inside each window, that is a [`gauge`](/primitives/gauge),
and writing to both is a reasonable thing to do.

**It does not know why it changed.** A level going from 42 to 38 does not say
whether four items were processed or four were cancelled. Pair it with a
[`counter`](/primitives/counter) when the reason matters.
