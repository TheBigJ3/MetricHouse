# level

A level records a quantity that stays where you put it. Every window from a
write onwards carries that value, including the windows nobody wrote to, so a
chart of it draws a line rather than a row of dots.

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

| | |
| --- | --- |
| Import | `import { level } from 'metrichouse/core'` |
| Answers | What is this value now, and what was it in between |
| Storage | One held value per series, carried into every closed window |
| Row | `{ id, bucket_ts, ...dims, value }` |
| Write with | [`set()`](#level-set), [`inc()`](#level-inc), [`dec()`](#level-dec) |
| Read with | [`current()`](#level-current), [`totals()`](#level-totals), [`snapshot()`](#level-snapshot) |
| Use it for | Queue depth, requests in flight, connections checked out, workers running |

Every series produces a row in every window, forever, whether or not anything
moved. [What it costs](#what-it-costs) puts a number on that.

## level()

```ts
level<D>(name: string, config: LevelConfig<D>): Level<D>
```

Declares a level. It is inert until a [house](/guide/the-house) binds it, and
writing to an unbound level throws.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | [The metric name](#name) |
| `config.dims` | shape | no | [Labels to break the value down by](#dims) |
| `config.resolution` | duration | yes | [How wide one window is](#resolution) |
| `config.flush` | duration | no | [The fastest this may ship](#flush) |
| `config.grace` | duration | no | [How long a late write may still land](#grace) |
| `config.holdFor` | duration | no | [How long a quiet series keeps reporting](#holdfor) |
| `config.value` | field type | no | [Whether fractions are allowed](#value) |
| `config.write` | function | yes | [Where the rows go](#write) |

### name

```ts
level('queue_depth', { ... })
```

A non empty string, unique inside a house.

### dims

```ts
dims?: Record<string, FieldType>      // default: none
```

The labels this quantity is broken down by. Each combination holds its own
value and produces its own row in every window.

```ts
dims: { queue: oneOf(['email', 'export', 'webhooks']) }
```

Dims cost more here than on any other type, because every series reports
forever. A dim whose values come and go wants [`holdFor`](#holdfor).
[dims](/reference/dims) covers the argument itself.

### resolution

```ts
resolution: DurationInput      // required
```

How wide one window is, and therefore how many rows a single series writes per
day. One series at `'1m'` is 1,440 rows a day. At `'1s'` it is 86,400.

[Buckets and time](/guide/buckets-and-time) covers the choice, and
[Durations](/reference/durations) the format.

### flush

```ts
flush?: DurationInput      // default: the house default
```

The fastest this level may ship. `resolution` has to divide it evenly.

Flushing does more for a level than for the other types: the carry happens
here, so a level that never flushes never fills in the windows between writes.
See [How carry works](#how-carry-works).

### grace

```ts
grace?: DurationInput      // default: '2s'
```

How long past a boundary a late write still lands in the window that just
closed. Identical to [the counter's](/primitives/counter#grace).

### holdFor

```ts
holdFor?: DurationInput      // default: forever
```

How long a series keeps reporting after its last write. Without it a series
holds its value for as long as the process runs, which is the point of a level
and the wrong answer for a series that can go away.

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

Past `holdFor` the series is forgotten and produces no more rows. Writing to it
again brings it back, starting from that write.

The clock runs from the window the last write landed in, so it rounds to whole
windows rather than to the millisecond. It has to be at least one `resolution`
long, and a shorter one throws at declaration, because it would drop a series
before the window it was written in had closed.

Without `holdFor`, a dim whose values come and go grows without bound: every
`worker` id that has ever appeared keeps writing a row every window. That is
the one way a level quietly becomes expensive.

### value

```ts
value?: FieldType<number, false>      // default: float()
```

Whether writes accept fractions. A level is fractional by default, which is the
opposite of a counter, because the quantities a level holds are often measured
rather than counted.

```ts
const inFlight = level('requests_in_flight', {
  value: int(),        // whole requests
  resolution: '10s',
  flush: '1m',
  write,
})
```

### write

```ts
write: (rows: LevelRow<D>[], context: WriteContext) => Promise<void> | void
```

Where the rows go. Required.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `rows` | `LevelRow<D>[]` | One row per series per window, with `value` as the series stood when the window closed |
| `context` | `WriteContext` | Which metric, which window, how many, and which attempt |

`context.total` for a level is where every series stood at the end of the
batch, rather than the sum of every row in it. A level that sat at 42 for five
windows would otherwise report 210, which is a number nothing corresponds to.
[Writing a sink](/guide/writing-a-sink) covers the rest of the contract.

## level.set()

```ts
set(value: number, dims: Dims): void
set(value: number): void      // no dims declared
```

Puts the series at this value. It stays there until something changes it.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `value` | `number` | yes | What the series is now |
| `dims` | the declared shape | once any dim is declared | [Which series to move](/reference/dims#the-dims-argument) |

```ts
queueDepth.set(42, { queue: 'email' })     // it is now 42
queueDepth.set(38, { queue: 'email' })     // it is now 38
```

A second write in the same window replaces the first. On a
[gauge](/primitives/gauge) the same two calls would be two observations that
fold together, and that difference is what separates the two types.

**Returns** nothing, and returns before storage has acknowledged anything.

**Throws immediately** on an unbound level, a value that is not finite, a
fraction on a level declared `value: int()`, or dims that are missing, unknown
or ill typed.

## level.inc()

```ts
inc(delta: number, dims: Dims): void
inc(dims: Dims): void
inc(delta: number): void      // no dims declared
inc(): void                   // no dims declared
```

Moves the series up by `delta`, or by 1. For quantities that are counted in and
out rather than measured.

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

## level.dec()

```ts
dec(delta: number, dims: Dims): void
dec(dims: Dims): void
dec(delta: number): void      // no dims declared
dec(): void                   // no dims declared
```

Moves the series down by `delta`, or by 1. The mirror of
[`inc()`](#level-inc), and nothing stops a series going negative, because a
pairing that runs one way more often than the other is worth seeing rather than
hiding.

## level.current()

```ts
current(dims: Dims): Promise<number | undefined>
current(): Promise<number | undefined>      // no dims declared
```

What one series is at right now.

```ts
await queueDepth.current({ queue: 'email' })
// 42, or undefined if nothing has ever written to it
```

**Returns** the held value, read from the series rather than from the open
window. The window you are in may well be empty, and the level is still 42.
That is the difference from [`gauge.current()`](/primitives/gauge#gauge-current).

`undefined` rather than `0` for a series nothing has written to. A zero claims
the queue exists and is empty, which is a different thing from not knowing yet.

## level.totals()

```ts
totals(): Promise<number | undefined>
```

Every series added together.

```ts
await queueDepth.totals()
// 61, the depth across every queue
```

**Returns** the sum of the held values, or `undefined` when no series has ever
been written to.

Adding is the merge a level can make honestly, because every held value is true
at the same moment. A [gauge](/primitives/gauge#gauge-totals) drops `last` from
its totals for the opposite reason.

## level.snapshot()

```ts
snapshot<O extends SnapshotOptions>(options?: O): Promise<LevelLiveRow<D, O>[]>
```

Every unflushed window, as rows.

```ts
await queueDepth.snapshot()
await queueDepth.snapshot({ dims: { queue: 'email' } })
await queueDepth.snapshot({ rollup: 'sum', groupBy: ['queue'] })
```

A rollup takes the latest value per series, then adds the series up, in that
order. Merging one series across windows gives the latest of them, because the
earlier values have been superseded. Merging several series inside one window
gives their sum, because all of them are true at once.

Every option is in [Snapshot options](/reference/snapshot-options).

## level.flush()

```ts
flush(options?: FlushOptions): Promise<MetricFlushReport>
```

Carries every series forward into the closed windows that have none, then ships
them. [How carry works](#how-carry-works) covers the first half, and
[Flush options](/reference/flush-options) the argument and the report.

## level.drain()

```ts
drain(): Promise<void>
```

Resolves once every write issued so far has reached the driver. Draining does
not carry or ship anything.

## level.rowShape()

```ts
rowShape(): RowShape
```

```ts
queueDepth.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'queue', 'value']
```

## Properties

| Property | Type | Value |
| --- | --- | --- |
| `name` | `string` | The name it was declared with |
| `kind` | `'level'` | |
| `storage` | `'bucketed'` | It holds one value per series and fills windows from it |
| `dims` | `Shape` | The declared dims |
| `resolutionMs` | `number` | `resolution`, parsed |
| `flushMs` | `number` | `flush`, parsed, including one taken from the house |
| `graceMs` | `number` | `grace`, parsed. `2000` by default |
| `holdForMs` | `number \| undefined` | `holdFor`, parsed. `undefined` when a series holds forever |
| `isFloat` | `boolean` | `true` unless `value: int()` was declared |
| `isBound` | `boolean` | `true` once a house has registered it |
| `write` | `WriteFn` | The function it was declared with |

## How carry works

Each flush does one thing before it claims anything. It walks every series
forward from the last window it carried, up to the newest closed window, and
writes the held value into each window that has none.

```
writes        42 .  .  .  38 .  .
stored        42 42 42 42 38 38 38
              ^           ^
              set()       set()
```

The walk goes forwards through what was actually written, rather than stamping
the current value across the whole gap. Set a queue to 42 at noon and to 38 at
three, and the windows in between hold 42. The queue changed at three, so it
did not change at noon.

A value somebody wrote always beats a carried one, whichever of the two lands
first. Two processes carrying the same window write the same number, so they
cannot disagree.

Three consequences worth knowing:

- **A series appears from its first write.** Nothing is backfilled before it, so
  a queue declared on Monday and first written on Friday has no Monday rows.
- **The carry happens at flush.** A level that never flushes never carries, so
  the windows appear when the metric ships rather than as the clock passes.
- **Coming back from downtime leaves a gap.** A process off for a day owes
  86,400 windows per series at `resolution: '1s'`, and writing them all would
  claim the queue was measured throughout a period when nothing was watching.
  Past `MAX_CARRY_BUCKETS`, which is 10,000, the older windows are skipped and
  the gap stays in the data.

## What it costs

A counter writes a row for a window something happened in. A level writes one
for every window, for every series, forever.

| Series | Resolution | Rows per year |
| --- | --- | --- |
| 1 | `'1m'` | 525,600 |
| 10 | `'1m'` | 5,256,000 |
| 10 | `'10s'` | 31,536,000 |
| 100 | `'1m'` | 52,560,000 |

Those numbers arrive whether or not anything moved. Two settings bring them
down: a wider [`resolution`](#resolution), and [`holdFor`](#holdfor) on a dim
whose values come and go.

<figure class="mh-figure">
  <img src="/diagrams/level-carry.svg" alt="A gauge leaves holes in windows with no observation. A level carries the last value into them." />
  <figcaption>The same three writes, stored two ways.</figcaption>
</figure>

Reach for a [gauge](/primitives/gauge) when you are sampling something, and for
a level when the gap between writes is the part you need filled.

## The row

```ts
{
  id: '...',
  bucket_ts: Date,
  queue: 'email',
  value: 42,
}
```

| Column | Meaning |
| --- | --- |
| `id` | Derived from the name, the window and the dim values |
| `bucket_ts` | The start of the window |
| one per dim | The label values for this series |
| `value` | What the series was at when the window closed |

Inside `write`, each row is a `LevelRow<D>`. See
[Rows are typed](/guide/writing-a-sink#rows-are-typed).

### Table schema

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

### Queries

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

## What a level does not do

**It does not aggregate inside a window.** A series written five times in one
minute stores the fifth value, and the other four are gone. For the minimum and
maximum inside each window, use a [gauge](/primitives/gauge), and writing to
both is reasonable.

**It does not know why it changed.** A level going from 42 to 38 does not say
whether four items were processed or four were cancelled. Pair it with a
[counter](/primitives/counter) when the reason matters.

## Patterns

### A job queue, reported by its worker

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
  // Written on change rather than on a timer: a level does not need a sample
  // per window, because the windows in between are filled in for it.
  for (const [name, queue] of Object.entries(queues)) {
    queue.on('change', () => {
      queueDepth.set(queue.size(), { queue: name, instance })
    })
  }
}
```

### Pausing intake on depth

The held value is readable before anything ships, so a level can drive a
decision.

```ts
export async function shouldPause(queue: string) {
  const depth = await queueDepth.current({ queue, instance })

  // Nothing has reported yet, so there is no backlog to react to.
  if (depth === undefined) return false

  return depth > 10_000
}
```

## Playground

A level buckets like a counter, so the same two settings decide the same
things. What changes is that every series produces a row in every window rather
than only in the windows it was written in.

<MhBucketExplorer metric="queue_depth" kind="level" resolution="1m" flush="1m" :series="6" />
