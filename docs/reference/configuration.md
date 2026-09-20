# Configuration

Every setting in one place, with its default. Each one is explained on the page
for the type that takes it, and the arguments shared by several types have
pages of their own: [dims](/reference/dims), [fields](/reference/fields),
[Field types](/reference/field-types), [Durations](/reference/durations),
[Snapshot options](/reference/snapshot-options) and
[Flush options](/reference/flush-options).

## createHouse

```ts
createHouse({
  driver,
  schema,
  delivery,
  defaults,
  now,
  onError,
  onWarn,
})
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `driver` | `Driver` | required | Where running totals and staged records live |
| `schema` | metrics or a module | none | Registered at startup |
| `delivery` | `'staged'`, `'immediate'`, `'auto'` | `'staged'` | When rows leave |
| `defaults.flush` | duration | none | Cadence for metrics that declare none |
| `defaults.grace` | duration | `'2s'` | Grace for metrics that declare none |
| `now` | `() => number` | `Date.now` | The clock every metric reads |
| `onError` | `(error, { metric }) => void` | none | Failures that cannot be thrown at a caller |
| `onWarn` | `(message, { metric? }) => void` | none | Startup warnings about the setup |

Defaults are filled in, never overridden. A metric that declares its own `flush`
keeps it.

## counter

The page: [counter](/primitives/counter).

```ts
counter(name, { dims, resolution, flush, grace, value, write })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the number down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late write may still land |
| `value` | `int()` or `float()` | `int()` | Whether fractions are allowed |
| `write` | `WriteFn` | required | Where the rows go |

## gauge

The page: [gauge](/primitives/gauge).

```ts
gauge(name, { dims, resolution, flush, grace, aggregate, write })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the value down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late observation may still land |
| `aggregate` | array | `['last','min','max','sum','count']` | Which columns reach your sink |
| `write` | `WriteFn` | required | Where the rows go |

## level

The page: [level](/primitives/level).

```ts
level(name, { dims, resolution, flush, grace, holdFor, value, write })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the value down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late write may still land |
| `holdFor` | duration | forever | How long a series keeps reporting after its last write |
| `value` | `float()` or `int()` | `float()` | Whether fractions are allowed |
| `write` | `WriteFn` | required | Where the rows go |

`holdFor` has to be at least one `resolution`.

## timer

The page: [timer](/primitives/timer).

```ts
timer(name, { dims, resolution, flush, grace, aggregate, record, write })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | shape | none | Labels to break the duration down by |
| `resolution` | duration | required | How wide one window is |
| `flush` | duration | house default | The fastest this may ship |
| `grace` | duration | `'2s'` | How long a late timing may still land |
| `aggregate` | array | `['min','max','sum','count']` | Which columns reach your sink |
| `record` | event name | none | An event every timing is also written to |
| `write` | `WriteFn` | required | Where the rows go |

A dimension may not be named `duration_ms`.

## event

The page: [event](/primitives/event).

```ts
event(name, { fields, stage, batch, flush, timestamp, sample, derive, claimLimit, write })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `fields` | shape | required | The record schema. `json()` is allowed |
| `stage` | `'driver'` or `'local'` | `'driver'` | Where records wait |
| `batch.maxSize` | number | `500` | Local staging: ship at this many |
| `batch.maxAge` | duration | `'10s'` | Local staging: ship this long after the first |
| `flush` | duration | `'30s'` | The fastest this may ship |
| `timestamp` | `'auto'` or a `ts()` field | `'auto'` | Where `ts` comes from |
| `sample` | number or function | keep everything | The fraction to keep, 0 to 1 |
| `derive` | record of functions | none | Counters this event also increments |
| `claimLimit` | number | unlimited | Records one flush may carry |
| `write` | `WriteFn` | required | Where the rows go |

A field may not be named `id`, `ts`, `_ingested_at` or `_sample_rate`.

## log

The page: [log](/primitives/log).

```ts
log(name, { fields, levels, minLevel, stage, batch, flush, claimLimit, write })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `fields` | shape | none | Extra fields beyond the reserved ones |
| `levels` | array of strings | `['debug','info','warn','error']` | Ascending severity |
| `minLevel` | one of `levels` | the lowest | Drop anything below this |
| `stage` | `'driver'` or `'local'` | `'driver'` | Where lines wait |
| `batch.maxSize` | number | `500` | Local staging: ship at this many |
| `batch.maxAge` | duration | `'10s'` | Local staging: ship this long after the first |
| `flush` | duration | `'30s'` | The fastest this may ship |
| `claimLimit` | number | unlimited | Lines one flush may carry |
| `write` | `WriteFn` | required | Where the rows go |

A field may not be named `id`, `ts`, `level`, `message`, `error_stack`,
`_ingested_at` or `_sample_rate`. A level may not shadow a method on the logger.

## memory

```ts
memory({ maxSeries, maxStaged })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxSeries` | number | `100_000` | Distinct label combinations per metric |
| `maxStaged` | number | `100_000` | Staged records per metric |

Set either to `Number.POSITIVE_INFINITY` to disable. Leave them on. They turn a
runaway dimension into a loud error instead of a crash with no warning.

## ioredis

```ts
ioredis(clientOrFactory, { namespace, maxPipelineSize, recoverAfter })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `namespace` | string | `'mh'` | Key prefix |
| `maxPipelineSize` | number | `1000` | Commands per round trip |
| `recoverAfter` | duration | `'5m'` | How long a claim may be held before a flush treats it as abandoned |

Pass a function rather than a client to delay connecting until the first write.

Keep `recoverAfter` above your sink's timeout. It is what separates a flusher
that crashed from one that is merely slow, and taking a claim back from a slow
one ships those rows twice. See
[Recovering a crashed flush](/guide/reliability#recovering-a-crashed-flush).

## Durations

Every time based setting takes a whole number followed by a lowercase unit, or
a plain number of milliseconds.

```ts
'500ms'   '30s'   '5m'   '2h'   '7d'   5_000
```

[Durations](/reference/durations) has the units, the rejected inputs and the
rule that `resolution` must divide `flush`.

## Flush options

```ts
metric.flush({ force })
house.flush({ force, only })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `force` | boolean | `false` | Ignore the cadence and ship everything finished |
| `only` | array of names | every metric | Restrict the flush to these metrics. House only |

[Flush options](/reference/flush-options) also covers every field of the report
that comes back.

## Snapshot options

```ts
metric.snapshot({ dims, from, to, complete, rollup, groupBy, orderBy, direction, limit })
house.snapshot({ only, ...theSame })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dims` | partial values | none | Match on declared dimensions |
| `from` | number or `Date` | none | Lower bound on the window, inclusive |
| `to` | number or `Date` | none | Upper bound, exclusive |
| `complete` | boolean | `true` | Exclude the window still filling |
| `rollup` | `'none'` or `'sum'` | `'none'` | Merge every window of a series into one row |
| `groupBy` | array of dimension names | every dimension | Collapse to these |
| `orderBy` | column name | none | Sort before `limit` applies |
| `direction` | `'asc'` or `'desc'` | `'desc'` | Sort direction |
| `limit` | number | none | Take this many, after sorting |
| `only` | array of names | every metric | House only |

[Snapshot options](/reference/snapshot-options) covers what each metric type
does with them, and how the row type follows.

## Validation that runs at startup

These all throw when the module is first imported, not at the first write.

| Check | Message |
| --- | --- |
| Empty metric name | `counter: name must be a non-empty string` |
| `json()` as a dimension | `dim "x" declares json(), which cannot be encoded into a series key` |
| Resolution does not divide flush | `resolution 7s does not divide flush 1m evenly` |
| Invalid duration | `parseDuration: "1.5m"` |
| Bad default value | `default for int(): expected a safe integer, got "five"` |
| Unknown gauge aggregate | `unknown aggregate "avg"` |
| Reserved event field name | `field "ts" is a reserved column` |
| Duplicate level | `level "info" is declared twice` |
| `minLevel` not in `levels` | `minLevel "trace" is not one of the declared levels` |
| A level shadowing a method | `level "flush" would shadow an existing property on the logger` |
| A timer dimension named `duration_ms` | `dim "duration_ms" is reserved` |
| Two metrics with the same name | `createHouse: two metrics are both named "x"` |
| A metric registered twice | `already bound to a house` |
| No cadence anywhere | `no flush cadence — declare flush on the counter, or defaults.flush on the house` |
