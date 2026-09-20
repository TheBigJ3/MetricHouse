# gauge

A gauge records values you sample. Every observation in a window folds into
five numbers, so a thousand readings a minute cost the same as one.

```ts
import { gauge, oneOf } from 'metrichouse/core'

export const onlineUsers = gauge('online_users', {
  dims: { region: oneOf(['us-east', 'eu-west', 'ap-south']) },
  resolution: '1m',
  flush: '1m',
  write: async (rows) => clickhouse.insert({ table: 'online_users', values: rows }),
})
```

```ts
onlineUsers.set(1_284, { region: 'us-east' })
```

| | |
| --- | --- |
| Import | `import { gauge } from 'metrichouse/core'` |
| Answers | What was this value when we looked |
| Storage | Folded into `last`, `min`, `max`, `sum` and `count` per window per series |
| Row | `{ id, bucket_ts, ...dims, last, min, max, sum, count }` |
| Write with | [`set()`](#gauge-set) |
| Read with | [`current()`](#gauge-current), [`totals()`](#gauge-totals), [`snapshot()`](#gauge-snapshot) |
| Use it for | Users online, cache hit ratio, temperature, disk usage, memory in use |

A window nobody wrote to is absent, which on a chart is a gap. For a value that
holds between the moments you look, such as queue depth, use
[`level`](/primitives/level) instead.

## gauge()

```ts
gauge<D>(name: string, config: GaugeConfig<D>): Gauge<D>
```

Declares a gauge. It is inert until a [house](/guide/the-house) binds it, and
writing to an unbound gauge throws.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | [The metric name](#name) |
| `config.dims` | shape | no | [Labels to break the value down by](#dims) |
| `config.resolution` | duration | yes | [How wide one window is](#resolution) |
| `config.flush` | duration | no | [The fastest this may ship](#flush) |
| `config.grace` | duration | no | [How long a late observation may still land](#grace) |
| `config.aggregate` | array | no | [Which of the five columns reach your sink](#aggregate) |
| `config.write` | function | yes | [Where the rows go](#write) |

There is a third parameter, `kind`, which lets another metric type present
itself as a gauge underneath. [`timer`](/primitives/timer) is the one that uses
it, and it is listed under [Extension points](/reference/#extension-points).

### name

```ts
gauge('online_users', { ... })
```

A non empty string, unique inside a house. It names the metric in every row id,
in reports and in your table.

### dims

```ts
dims?: Record<string, FieldType>      // default: none
```

The labels this value is broken down by. Each combination is folded separately,
so `us-east` and `eu-west` keep their own minimum and maximum.

```ts
dims: { region: oneOf(['us-east', 'eu-west', 'ap-south']) }
```

Leave it out for a gauge that is one series.

```ts
const heapUsedMb = gauge('heap_used_mb', { resolution: '10s', flush: '1m', write })
heapUsedMb.set(process.memoryUsage().heapUsed / 1024 / 1024)
```

[dims](/reference/dims) covers the whole argument.

### resolution

```ts
resolution: DurationInput      // required
```

How wide one window is, and therefore how many observations fold together. A
`1m` window sampled every ten seconds folds six readings, which is enough for
`min` and `max` to mean something.

Pick a resolution that holds several observations. One reading per window makes
`min`, `max` and `last` the same number.
[Buckets and time](/guide/buckets-and-time) covers the choice, and
[Durations](/reference/durations) the format.

### flush

```ts
flush?: DurationInput      // default: the house default
```

The fastest this gauge may ship. `resolution` has to divide it evenly, and a
gauge with no cadence anywhere throws when the house registers it. Identical to
[the counter's](/primitives/counter#flush).

### grace

```ts
grace?: DurationInput      // default: '2s'
```

How long past a boundary a late observation still lands in the window that just
closed. Identical to [the counter's](/primitives/counter#grace).

### aggregate

```ts
aggregate?: readonly ('last' | 'min' | 'max' | 'sum' | 'count')[]   // default: all five
```

Which columns reach your sink. Ask for fewer when you know what you will query.

```ts
const cacheHitRatio = gauge('cache_hit_ratio', {
  aggregate: ['sum', 'count'],     // enough to compute an average
  resolution: '1m',
  flush: '1m',
  write,
})
```

All five are folded whatever you ask for. The saving is columns written rather
than work done, so widening this later needs no migration of anything already
in flight.

```ts
import { GAUGE_AGGREGATES } from 'metrichouse/core'
// ['last', 'min', 'max', 'sum', 'count']
```

An empty array throws, and so does a name that is not one of the five.

### write

```ts
write: (rows: GaugeRow<D>[], context: WriteContext) => Promise<void> | void
```

Where the rows go. Required.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `rows` | `GaugeRow<D>[]` | Dims typed as declared, each aggregate typed `number \| undefined` |
| `context` | `WriteContext` | Which metric, which window, how many, and which attempt |

The aggregates are optional in the type because `aggregate` decides at run time
which of them a row carries. [Writing a sink](/guide/writing-a-sink) covers the
contract in full.

## gauge.set()

```ts
set(value: number, dims: Dims): void
set(value: number): void      // no dims declared
```

Records one observation into the window that is open now.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `value` | `number` | yes | The reading |
| `dims` | the declared shape | once any dim is declared | [Which series this reading belongs to](/reference/dims#the-dims-argument) |

```ts
onlineUsers.set(1_284, { region: 'us-east' })
onlineUsers.set(1_301, { region: 'us-east' })
onlineUsers.set(1_297, { region: 'us-east' })

// The window now holds:
// { last: 1297, min: 1284, max: 1301, sum: 3882, count: 3 }
```

A second call in the same window adds an observation rather than replacing the
first. For a value that replaces, see [`level.set()`](/primitives/level#level-set).

**Returns** nothing, and returns before storage has acknowledged anything.
[`drain()`](#gauge-drain) is what confirms a write landed.

**Throws immediately** on an unbound gauge, a value that is not finite, or dims
that are missing, unknown or ill typed. A failure on the way to storage goes to
the house's `onError` handler.

## gauge.current()

```ts
current(dims: Dims): Promise<GaugeCell | undefined>
current(): Promise<GaugeCell | undefined>      // no dims declared
```

The open window's fold for one series.

```ts
await onlineUsers.current({ region: 'us-east' })
// { last: 1297, min: 1284, max: 1301, sum: 3882, count: 3 }
```

**Returns** the five numbers, or `undefined` when nothing has been observed in
this window. A zeroed object would claim a `min` of 0 for a gauge nobody wrote
to, and a chart should show a gap there.

Unlike a counter, the dims argument is required as soon as the gauge declares
any. Use [`totals()`](#gauge-totals) for every series at once.

## gauge.totals()

```ts
totals(): Promise<GaugeTotals | undefined>
```

Every series in the open window, merged.

```ts
await onlineUsers.totals()
// { min: 612, max: 1301, sum: 7284, count: 6 }
```

**Returns** `min`, `max`, `sum` and `count`, or `undefined` when nothing has
been observed anywhere.

There is no `last`. Several series have no single latest observation, and
picking one would be the same mistake as storing an average.

## gauge.snapshot()

```ts
snapshot<O extends SnapshotOptions>(options?: O): Promise<GaugeLiveRow<D, O>[]>
```

Every unflushed window of folds, as rows.

```ts
await onlineUsers.snapshot()
await onlineUsers.snapshot({ dims: { region: 'us-east' } })
await onlineUsers.snapshot({ rollup: 'sum', groupBy: ['region'] })
```

A rollup merges folds the way the five aggregates merge: `sum` and `count` add,
`min` and `max` take the extreme, and `last` takes the latest window. Every
option is in [Snapshot options](/reference/snapshot-options).

## gauge.flush()

```ts
flush(options?: FlushOptions): Promise<MetricFlushReport>
```

Ships every closed window to this gauge's own `write` function.
[Flush options](/reference/flush-options) covers the argument and the report.

## gauge.drain()

```ts
drain(): Promise<void>
```

Resolves once every `set()` issued so far has reached the driver.

## gauge.rowShape()

```ts
rowShape(): RowShape
```

The columns your sink will receive, in order, with only the aggregates you
asked for.

```ts
onlineUsers.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'region', 'last', 'min', 'max', 'sum', 'count']

cacheHitRatio.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'sum', 'count']
```

## Properties

| Property | Type | Value |
| --- | --- | --- |
| `name` | `string` | The name it was declared with |
| `kind` | `'gauge'` | |
| `storage` | `'bucketed'` | It folds writes into windows |
| `dims` | `Shape` | The declared dims |
| `resolutionMs` | `number` | `resolution`, parsed |
| `flushMs` | `number` | `flush`, parsed, including one taken from the house |
| `graceMs` | `number` | `grace`, parsed. `2000` by default |
| `aggregate` | `readonly GaugeAggregate[]` | The columns this gauge writes |
| `isBound` | `boolean` | `true` once a house has registered it |
| `write` | `WriteFn` | The function it was declared with |

## The row

```ts
{
  id: '...',
  bucket_ts: Date,
  region: 'us-east',
  last: 1297,
  min: 1284,
  max: 1301,
  sum: 3882,
  count: 3,
}
```

<figure class="mh-figure">
  <img src="/diagrams/gauge-fold.svg" alt="Four observed values fold into last, min, max, sum and count." />
  <figcaption>Four observations, five stored numbers, no average.</figcaption>
</figure>

| Column | Meaning |
| --- | --- |
| `id` | Derived from the name, the window and the dim values |
| `bucket_ts` | The start of the window |
| one per dim | The label values for this series |
| `last` | The most recent value observed in this window |
| `min` | The smallest |
| `max` | The largest |
| `sum` | Every value added together |
| `count` | How many observations there were |

Inside `write`, each row is a `GaugeRow<D>`. See
[Rows are typed](/guide/writing-a-sink#rows-are-typed).

### Why there is no average

These five merge across windows. An average does not.

One minute averaging 10 and the next averaging 20 do not make 15 across both,
unless both held the same number of observations. Storing an average would
produce wrong numbers the moment anyone grouped by hour.

`sum` and `count` merge, and `sum / count` gives the exact average whenever you
ask for it.

```sql
SELECT
  toStartOfHour(bucket_ts) AS hour,
  region,
  sum(sum) / sum(count) AS avg_online,
  min(min)              AS lowest,
  max(max)              AS highest
FROM online_users
GROUP BY hour, region;
```

That is the whole reason the five are what they are. It is also why a rollup
merges the way it does in [`snapshot()`](#gauge-snapshot).

### Table schema

::: code-group

```sql [ClickHouse]
CREATE TABLE online_users (
  id         String,
  bucket_ts  DateTime64(3),
  region     LowCardinality(String),
  last       Float64,
  min        Float64,
  max        Float64,
  sum        Float64,
  count      Int64
)
ENGINE = ReplacingMergeTree
ORDER BY (bucket_ts, region);
```

```sql [Postgres]
CREATE TABLE online_users (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  region     TEXT NOT NULL,
  last       DOUBLE PRECISION NOT NULL,
  min        DOUBLE PRECISION NOT NULL,
  max        DOUBLE PRECISION NOT NULL,
  sum        DOUBLE PRECISION NOT NULL,
  count      BIGINT NOT NULL
);
```

:::

## A gauge against a level

Both hold a number per series. They differ in what a window with no write
means.

| | `gauge` | [`level`](/primitives/level) |
| --- | --- | --- |
| A second write in one window | another observation | the value changing |
| A window nobody wrote to | absent, a gap on the chart | a row carrying the last value |
| Stores | `last`, `min`, `max`, `sum`, `count` | one `value` |
| `current()` | the fold, or `undefined` | the held value, or `undefined` |
| Rows per day | one per window something happened in | one per window, per series, always |
| Reach for it when | you are sampling and want the spread | the gap between writes is what you need filled |

```ts
const queueDepth = level('queue_depth', { resolution: '1m', flush: '1m', write })

queueDepth.set(42)   // every minute reports 42 until this changes
```

Writing to both is reasonable when you want the held line and the spread inside
each window.

## Patterns

### Sampling system health on a timer

```ts
// metrics/schema.ts
import { gauge, oneOf, str } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

export const systemHealth = gauge('system_health', {
  dims: {
    metric: oneOf(['heap_used_mb', 'rss_mb', 'event_loop_lag_ms', 'db_pool_in_use']),
    instance: str(),
  },

  // One row per minute per measurement, which is plenty for capacity work.
  resolution: '1m',
  flush: '1m',

  write: toClickHouse('system_health'),
})
```

```ts
// metrics/sampler.ts
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { systemHealth } from './schema.js'
import { pool } from '../db.js'

const instance = process.env.HOSTNAME ?? 'local'
const loopDelay = monitorEventLoopDelay({ resolution: 10 })
loopDelay.enable()

export function startSampling() {
  // Every ten seconds gives six observations per minute, so min and max are
  // meaningful and no window is ever empty.
  const handle = setInterval(() => {
    const memory = process.memoryUsage()

    systemHealth.set(memory.heapUsed / 1024 / 1024, { metric: 'heap_used_mb', instance })
    systemHealth.set(memory.rss / 1024 / 1024, { metric: 'rss_mb', instance })
    systemHealth.set(loopDelay.mean / 1e6, { metric: 'event_loop_lag_ms', instance })
    systemHealth.set(pool.numUsed(), { metric: 'db_pool_in_use', instance })

    loopDelay.reset()
  }, 10_000)

  // Sampling should never be the reason the process stays alive.
  handle.unref()

  return () => clearInterval(handle)
}
```

```sql
-- The worst event loop lag per instance, per hour.
SELECT
  toStartOfHour(bucket_ts) AS hour,
  instance,
  max(max)              AS worst_lag_ms,
  sum(sum) / sum(count) AS avg_lag_ms
FROM system_health
WHERE metric = 'event_loop_lag_ms'
  AND bucket_ts >= now() - INTERVAL 1 DAY
GROUP BY hour, instance
ORDER BY worst_lag_ms DESC;
```

### Shedding load on a live reading

The fold is readable before it ships, so a gauge can drive a decision.

```ts
export async function shouldShedLoad() {
  const lag = await systemHealth.current({ metric: 'event_loop_lag_ms', instance })

  // No observation yet in this window, so no reason to act.
  if (!lag) return false

  return lag.max > 250
}
```

## Playground

### The fold

Drag the observations. Everything below them is what MetricHouse keeps, and the
average line is the one number it refuses to store.

<MhFoldExplorer metric="online_users" kind="gauge" :start="[640, 1301, 980, 1266]" :max="2000" />

Turn `sum` or `count` off and the average becomes unrecoverable, which is the
argument for keeping both.

### The windows

A gauge buckets exactly like a counter, so the same two settings decide the
same things. Each row carries five columns rather than one.

<MhBucketExplorer metric="online_users" kind="gauge" resolution="1m" flush="1m" :series="8" />
