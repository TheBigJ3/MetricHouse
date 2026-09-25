# Snapshot options

`snapshot()` returns what a metric is still holding, as rows. The options
object filters those rows, collapses them, sorts them and cuts them, in that
order.

```ts
await httpRequests.snapshot({
  dims: { route: '/checkout' },
  from: Date.now() - 300_000,
  complete: true,
  rollup: 'sum',
  groupBy: ['route'],
  orderBy: 'value',
  direction: 'desc',
  limit: 10,
})
```

## Where they are accepted

| Callable | Accepts | Notes |
| --- | --- | --- |
| [`counter.snapshot()`](/primitives/counter#counter-snapshot) | all of them | |
| [`gauge.snapshot()`](/primitives/gauge#gauge-snapshot) | all of them | a rollup merges folds |
| [`level.snapshot()`](/primitives/level#level-snapshot) | all of them | a rollup takes the latest value per series, and carried windows are included |
| [`timer.snapshot()`](/primitives/timer#timer-snapshot) | all of them | same merge as a gauge |
| [`event.snapshot()`](/primitives/event#event-snapshot) | `from`, `to`, `orderBy`, `direction`, `limit` | the rest are ignored |
| [`log.snapshot()`](/primitives/log#log-snapshot) | the same as an event | |
| [`house.snapshot()`](/guide/the-house#snapshot) | all of them, plus `only` | applied to every registered metric |

The options an event ignores rather than rejects are the ones that only mean
something to a window: `dims`, `complete`, `rollup` and `groupBy`. One options
object can then be handed to a mixed schema without checking what each metric
is.

## The options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| [`dims`](#dims) | partial declared values | none | Keep rows matching these labels |
| [`from`](#from) | `number` or `Date` | none | Lower bound on `bucket_ts`, inclusive |
| [`to`](#to) | `number` or `Date` | none | Upper bound on `bucket_ts`, exclusive |
| [`complete`](#complete) | `boolean` | `true` | Exclude the window still filling |
| [`rollup`](#rollup) | `'none'` or `'sum'` | `'none'` | Merge every window of a series into one row |
| [`groupBy`](#groupby) | array of dim names | every dim | Keep these labels and merge the rest away |
| [`orderBy`](#orderby) | column name | none | Sort on this column |
| [`direction`](#direction) | `'asc'` or `'desc'` | `'desc'` | Sort direction |
| [`limit`](#limit) | `number` | none | Take this many, after sorting |
| [`only`](#only) | array of metric names | every metric | House calls only |

### dims

A partial match on the declared [dims](/reference/dims). Any subset works, in
any order.

```ts
await httpRequests.snapshot({ dims: { route: '/checkout' } })
await httpRequests.snapshot({ dims: { route: '/checkout', status: '5xx' } })
```

Values are compared for equality against the materialised row. A `ts()` dim
matches any `Date` for the same instant, since the row holds a fresh `Date`
rather than the one you passed.

Naming a dim the metric does not declare throws. A typo would otherwise match
nothing and render as an empty chart, which reads like an outage.

```
http_requests: dims names "pakr", which is not a declared dim — this metric
has [route, status]
```

### from

Lower bound on `bucket_ts`, inclusive. A `number` is epoch milliseconds, and a
`Date` works too.

```ts
await httpRequests.snapshot({ from: Date.now() - 600_000 })
```

The bound applies to the start of a window, so a window that began before
`from` is left out even when part of it falls inside the range. Round `from`
down to a boundary when you want the window containing it.

### to

Upper bound on `bucket_ts`, exclusive.

```ts
await httpRequests.snapshot({ from: start, to: end })
```

`to` and `complete` are both upper bounds and both apply. Asking for a `to` in
the future does not waive `complete`.

### complete

Leaves out the window that is still accepting writes. Defaults to `true`.

<figure class="mh-figure">
  <img src="/diagrams/open-vs-closed-bucket.svg" alt="Four finished buckets with values, and one still filling at 40 percent." />
  <figcaption>A live read returns the finished windows unless you ask for the open one.</figcaption>
</figure>

Poll a ten second counter at an arbitrary moment and the current window is on
average half full. On a chart that makes every series dip at the right hand
edge, and as a rate it produces a sawtooth that looks like real traffic.

Ask for the open window when you want it, and scale it with the two liveness
columns every row carries.

```ts
const rows = await httpRequests.snapshot({ complete: false })

for (const row of rows) {
  if (row.bucket_open) {
    const fraction = row.bucket_elapsed_ms / httpRequests.resolutionMs
    console.log('projected', row.value / fraction)
  }
}
```

| Column | Meaning |
| --- | --- |
| `bucket_open` | Is this window still accepting writes |
| `bucket_elapsed_ms` | How many milliseconds of the window have passed |

### rollup

`'none'`, the default, keeps one row per window per series, which is the shape
a chart wants. `'sum'` merges every window of a series into one row.

```ts
await httpRequests.snapshot({ rollup: 'sum' })
```

Each metric type merges the way its own numbers merge.

| Type | How a rollup merges |
| --- | --- |
| counter | values are added |
| gauge, timer | `sum` and `count` add, `min` and `max` take the extreme, `last` takes the latest window when one series holds it |
| level | the latest value per series, then series added together |
| event, log | ignored, because records are never merged |

A rollup drops `id` and `bucket_ts`. Neither survives the merge, because there
is no longer one window for them to name.

### groupBy

Keeps the dims you name and merges the rest away. Windows survive, so this is
the option for "per route, over time".

```ts
await httpRequests.snapshot({ groupBy: ['route'] })
await httpRequests.snapshot({ rollup: 'sum', groupBy: ['route'] })
```

`bucket_ts` survives a `groupBy`. `id` survives only on a row where the
grouping merged nothing, which is a fact about the data rather than about the
options, so the type reports it as optional.

A merged row covers each of its windows once. Three series merged inside one
ten second window that is five seconds old report `bucket_elapsed_ms: 5000`,
not 15000, so the projection above still works on a grouped row.

A gauge or timer row that merged several series inside its newest window has no
`last`. A fold does not record which series was observed most recently, so there
is no honest answer, and `totals()` leaves `last` out for the same reason. A
group whose newest window holds a single series keeps it.

Naming a dim the metric does not declare throws, exactly as `dims` does.
`groupBy: []` keeps no dims at all and merges every series, one row per window.

### orderBy

Sorts on one column of the finished rows, before `limit` applies. Numbers and
dates compare by value, and everything else compares as a string.

```ts
await httpRequests.snapshot({ orderBy: 'bucket_ts', direction: 'asc' })
await httpRequests.snapshot({ orderBy: 'value', limit: 10 })
```

The column has to exist on the rows the other options produced, so a rollup
that dropped `bucket_ts` cannot then sort on it. A column some rows have and
others do not, such as a gauge's `last` after a `groupBy`, is fine: the rows
without it go last whichever `direction` you ask for, so a top ten is ten rows
that have the value being ranked.

```
http_requests: orderBy names "bucket_ts", which is not a column on these rows
— they have [route, status, value, bucket_open, bucket_elapsed_ms]
```

### direction

`'desc'` by default, which is what makes an unqualified top ten the top rather
than the bottom. Pass `'asc'` for a chart in time order.

### limit

Takes this many rows after sorting, so `orderBy` plus `limit` is a top K.
Without `orderBy` it takes whatever order the rows arrived in.

```ts
await httpRequests.snapshot({ orderBy: 'value', direction: 'desc', limit: 10 })
```

A negative or fractional limit throws.

### only

House calls only. Restricts the snapshot to the named metrics.

```ts
await house.snapshot({ only: ['http_requests', 'app_log'] })
```

## The order things happen in

```
read -> match dims -> sort by window -> collapse -> stamp liveness -> orderBy -> limit
```

Two consequences follow from that order:

- **`limit` is a top K.** Sorting happens first, so the ten rows you get back
  are the ten largest rather than the first ten found.
- **`orderBy` sees the collapsed rows.** A column that a rollup merged away is
  no longer there to sort on.

## How the type changes with the options

Rows are typed to the metric that produced them, and the row type follows the
options you passed.

```ts
const rows = await httpRequests.snapshot()
rows[0].route      // string
rows[0].status     // '2xx' | '3xx' | '4xx' | '5xx'
rows[0].value      // number
rows[0].bucket_ts  // Date

const rolled = await httpRequests.snapshot({ rollup: 'sum' })
rolled[0].bucket_ts
//        ^^^^^^^^^ Type error: this row has no bucket_ts

const byRoute = await httpRequests.snapshot({ groupBy: ['route'] })
byRoute[0].status
//         ^^^^^^ Type error: groupBy merged this column away
```

Pass the options inline for this to work. An object built in a variable and
typed as `SnapshotOptions` first has nothing left for the type to read, and you
get the unrolled shape.

```ts
const options: SnapshotOptions = { rollup: 'sum' }
await httpRequests.snapshot(options)   // typed as if nothing was rolled up
```

## Errors

| Message | Cause |
| --- | --- |
| `dims names "pakr", which is not a declared dim` | A filter naming an undeclared dim |
| `groupBy names "pakr", which is not a declared dim` | A `groupBy` naming an undeclared dim |
| `orderBy names "bucket_ts", which is not a column on these rows` | Sorting on a column the other options removed |
| `limit must be a non-negative integer, got -1` | A negative or fractional limit |

## Related

- [Reading live data](/guide/reading-live-data) for what to do with the rows
- [dims](/reference/dims) for the labels these options filter on
- [The house](/guide/the-house#snapshot) for reading a whole schema at once
