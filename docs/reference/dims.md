# dims

`dims` are the labels a folded metric breaks its number down by. You declare
them once, and every write, every live read and every stored row carries them.

```ts
import { counter, oneOf, str } from 'metrichouse/core'

const httpRequests = counter('http_requests', {
  dims: {
    route: str(),
    status: oneOf(['2xx', '3xx', '4xx', '5xx']),
  },
  resolution: '10s',
  flush: '1m',
  write,
})

httpRequests.add({ route: '/checkout', status: '2xx' })
```

This page is the whole of `dims`: the declaration, the argument at each call
site, the series key underneath, what it costs, and every error it can raise.

## Where dims appear

| Metric type | Declares dims | The argument |
| --- | --- | --- |
| [`counter`](/primitives/counter) | yes | [`add()`](/primitives/counter#counter-add), [`current()`](/primitives/counter#counter-current) |
| [`gauge`](/primitives/gauge) | yes | [`set()`](/primitives/gauge#gauge-set), [`current()`](/primitives/gauge#gauge-current) |
| [`level`](/primitives/level) | yes | [`set()`](/primitives/level#level-set), [`inc()`](/primitives/level#level-inc), [`dec()`](/primitives/level#level-dec), [`current()`](/primitives/level#level-current) |
| [`timer`](/primitives/timer) | yes | [`start()`](/primitives/timer#timer-start), [`end()`](/primitives/timer#handle-end), [`time()`](/primitives/timer#timer-time), [`observe()`](/primitives/timer#timer-observe) |
| [`event`](/primitives/event) | no | declares [`fields`](/reference/fields) instead |
| [`log`](/primitives/log) | no | declares [`fields`](/reference/fields) instead |

Every metric that folds writes into time windows takes `dims`. The two types
that keep each record whole take `fields`, which allow values that are unique
per record. [fields](/reference/fields) covers the difference in full.

`snapshot({ dims })` accepts them as a filter on every type that declares them.
That option lives in [Snapshot options](/reference/snapshot-options#dims).

## Declaring dims

`dims` is an object. Each key is a column name, and each value is a
[field type](/reference/field-types).

```ts
dims: {
  route: str(),
  status: oneOf(['2xx', '3xx', '4xx', '5xx']),
  cached: bool(),
}
```

| Property | Value |
| --- | --- |
| Type | `Record<string, FieldType>` |
| Required | no |
| Default | `{}`, a metric with a single series |
| Checked | when the module is imported |

Leave `dims` out entirely for a metric that is one number.

```ts
const jobsProcessed = counter('jobs_processed', { resolution: '1m', flush: '1m', write })

jobsProcessed.add()
jobsProcessed.add(5)
await jobsProcessed.current()
```

### Which types are allowed

Six of the seven [field types](/reference/field-types) are legal as a dim.

| Builder | Legal as a dim | Stored in the key as |
| --- | --- | --- |
| `str()` | yes | the string itself |
| `int()` | yes | the number, written out |
| `float()` | yes | the number, written out |
| `bool()` | yes | `'true'` or `'false'` |
| `ts()` | yes | epoch milliseconds |
| `oneOf([...])` | yes | the member, written out |
| `json<T>()` | no | rejected at declaration |

`json()` is refused because a payload has no single short form that identifies
a series. Put it on an [event field](/reference/fields) instead.

```ts
dims: { metadata: json() }
// Error: dim "metadata" declares json(), which cannot be encoded into a series
// key — put it on an event instead
```

### Optional dims

`.optional()` lets a call site leave the key out, and the row then carries no
value for it.

```ts
dims: { plan: oneOf(['free', 'pro']), campaign: str().optional() }

signups.add({ plan: 'pro' })                      // campaign is absent
signups.add({ plan: 'pro', campaign: 'launch' })  // campaign is 'launch'
```

An absent optional dim is its own series, separate from the series where the
same dim holds an empty string. The two can never collide, because the key
marks absence with a sentinel no real value can produce.

### Dims with a default

`.default(value)` lets a call site leave the key out, and fills the value in.

```ts
dims: { plan: oneOf(['free', 'pro']), referrer: str().default('direct') }

signups.add({ plan: 'pro' })                      // referrer is 'direct'
signups.add({ plan: 'pro', referrer: 'twitter' })
```

The default is checked against its own type at declaration, so a wrong one
fails when the file is imported.

```ts
int().default('five')
// Error: default for int(): expected a safe integer, got "five"
```

Only a genuinely missing key is filled in. A falsy value you passed on purpose,
such as `0` or `''`, reaches the row untouched.

Prefer `.default()` on a dim and `.optional()` on an event field. Every row then
carries a value, so grouping in SQL behaves the same for every series.

### Declaration order

The order you write the keys in is the order everything downstream uses: the
series key, the columns in `rowShape()`, and the columns your sink receives.

```ts
httpRequests.rowShape().columns.map((c) => c.name)
// ['id', 'bucket_ts', 'route', 'status', 'value']
```

Add new dims at the end. [Reordering is a breaking change](#reordering-is-a-breaking-change).

## The dims argument

Every write method on a folded metric takes the declared values as its last
argument. Two rules decide whether you may leave that argument out, and they
differ by method.

### When the argument is required

`add()`, `set()`, `inc()`, `dec()` and `current()` require the argument as soon
as the metric declares one dim, whatever modifiers those dims carry.

```ts
const signups = counter('signups', {
  dims: { campaign: str().optional() },
  resolution: '1m',
  flush: '1m',
  write,
})

signups.add({})                  // every key is optional, so an empty object
signups.add({ campaign: 'x' })
signups.add()
//        ^ Type error: expected 1 argument
```

A metric that declares no dims takes no argument at all.

```ts
jobsProcessed.add()
jobsProcessed.add(5)
```

The rule is deliberately blunt. A metric with dims makes the argument visible
at every call site, which is where a reader decides whether the label is right.

### When the argument may be left out

[`handle.end()`](/primitives/timer#handle-end),
[`timer.observe()`](/primitives/timer#timer-observe),
[`timer.time()`](/primitives/timer#timer-time) and the
[log level methods](/primitives/log#log-level) use a looser rule: the argument
may be left out once nothing in the shape is still required.

```ts
const httpLatency = timer('http_latency', {
  dims: { route: str(), status: oneOf(['ok', 'error']) },
  resolution: '10s',
  flush: '1m',
  write,
})

const span = httpLatency.start({ route: '/checkout' })
span.end({ status: 'ok' })       // route was bound at start, status is still required

const both = httpLatency.start({ route: '/checkout', status: 'ok' })
both.end()                       // nothing left to supply
```

`start()` marks the keys it bound as omittable for that handle. A key given at
the end overrides one bound at the start, because the end of an operation knows
more than its beginning did.

### Reading dims for a partial value

`start()` accepts any subset of the declared dims and checks what you gave it.
A key that is not declared throws there, and a required key that is still
missing throws at `end()`, where it is the last chance to supply one.

```ts
httpLatency.start({ rout: '/checkout' })
// Error: unknown dim "rout" — declared dims are [route, status]

httpLatency.start({}).end({})
// Error: missing required dim "route"
```

## The series key

One combination of dim values is one series. MetricHouse encodes that
combination into a single string, the series key, and stores one running total
per key per time window.

<figure class="mh-figure">
  <img src="/diagrams/dimensions-to-series.svg" alt="Dimension declarations become series keys, and each series key becomes one row per bucket." />
  <figcaption>Each distinct combination of values you write becomes one row per window.</figcaption>
</figure>

```
{ route: '/checkout', status: '2xx' }   ->   /checkout|2xx
{ route: '/pricing',  status: '4xx' }   ->   /pricing|4xx
```

Three rules govern the encoding.

| Rule | Detail |
| --- | --- |
| Order | Values are written in declaration order, joined by `\|` |
| Escaping | A `\|` or a `\` inside a value is prefixed with `\`, so a value containing the separator still parses |
| Absence | An omitted optional dim is written as `\0`, which escaping makes unreachable for a real value |

You never handle the key yourself. It is worth knowing because it explains the
two consequences below, and because `rowId()` hashes it when it mints the id
for a row.

### Reordering is a breaking change

Rows written before a reorder were keyed in the old order, and rows written
after it are keyed in the new one. The two sets never match, so a query that
groups across the change sees two populations.

Treat a reorder the way you would treat a column rename in a database. Adding a
dim at the end is safe for rows written from that point on, and rows already
stored carry no value for it.

### Every combination is a running total

A metric keeps one total per key per window, so the number of series it can
produce is the product of the sizes of its dims.

```
series        =  distinct values of dim 1  x  distinct values of dim 2  x  ...
rows per flush = series that were written to  x  buckets per flush
```

For `resolution: '10s'` and `flush: '1m'` there are six buckets per flush. Three
routes, two methods and four status classes give twenty four combinations, so
at most 144 rows a minute, which is nothing. Add a `userId` dim with a hundred
thousand users and the same metric produces up to 600,000 rows a minute, which
is a problem you will meet in your database bill.

[Buckets and time](/guide/buckets-and-time) covers the other half of that
number, which is the resolution.

## Choosing what to label

Use a dim when the set of possible values is small and you can name it in
advance. Route patterns, country codes, plan tiers, status classes, queue names
and boolean flags all qualify.

Keep anything unique per request or per person off a dim. User ids, request
ids, session ids, raw URLs with query strings and email addresses all belong on
an [event](/primitives/event), which is built to hold them.

```ts
// A dim: four values, forever.
dims: { status: oneOf(['2xx', '3xx', '4xx', '5xx']) }

// A dim: one value per URL ever requested, which grows without bound.
dims: { url: str() }
```

Two habits keep the count down:

- **Label with the route pattern rather than the path.** `'/users/:id'` is one
  series. `'/users/98421'` is one series per user.
- **Label with classes rather than codes.** Four status classes read the same on
  a chart as forty status codes, at a tenth of the rows.

::: warning The memory driver is the only one that stops you
`memory()` refuses a write past 100,000 distinct series for one metric, so a
runaway dim fails loudly rather than exhausting the heap. `ioredis()` has no
such cap, so the same mistake there shows up as memory use that climbs. The
limit is [`maxSeries`](/reference/configuration#memory) and you can raise it.
:::

## Reading dims back

A declaration is an ordinary value, so you can read it.

```ts
httpRequests.dims
// { route: FieldType, status: FieldType }

Object.keys(httpRequests.dims)
// ['route', 'status']

httpRequests.dims.status.values
// ['2xx', '3xx', '4xx', '5xx']
```

That makes a shape reusable. Declare it once and spread it wherever it belongs,
which is how a timer and its sample event stay in step.

```ts
const REQUEST_DIMS = { route: str(), status: oneOf(['ok', 'error']) }

const httpLatency = timer('http_latency', { dims: REQUEST_DIMS, ...rest })

const httpLatencySamples = event('http_latency_samples', {
  fields: { ...httpLatency.dims, duration_ms: float() },
  ...rest,
})
```

`naturalKey(dims)` gives the columns your table should treat as unique for a
folded metric.

```ts
import { naturalKey } from 'metrichouse/core'

naturalKey(httpRequests.dims)   // ['bucket_ts', 'route', 'status']
```

## Filtering by dims

### One series, live

`current()` takes the declared values and answers for that series alone.

```ts
await httpRequests.current({ route: '/checkout', status: '2xx' })   // 42
```

A counter also answers without the argument, and then adds every series
together. The other folded types answer per series, with
[`totals()`](/primitives/gauge#gauge-totals) as the way to merge them.

### A partial match on rows

`snapshot({ dims })` matches on any subset of the declared dims.

```ts
await httpRequests.snapshot({ dims: { route: '/checkout' } })
```

The match runs over materialised rows rather than over the key, so any subset
works, in any order. Naming a dim the metric never declared throws, because a
typo would otherwise match nothing and render as an empty chart.

### Collapsing dims away

`groupBy` keeps the dims you name and merges the rest.

```ts
await httpRequests.snapshot({ rollup: 'sum', groupBy: ['route'], orderBy: 'value', limit: 10 })
```

Both options are covered in full in
[Snapshot options](/reference/snapshot-options).

## Errors

Every check below runs before anything is written, so a rejected call leaves no
half finished state behind.

| Message | Cause |
| --- | --- |
| `dim "x" declares json(), which cannot be encoded into a series key` | `json()` used as a dim. At declaration |
| `default for int(): expected a safe integer, got "five"` | `.default()` given a value its own type rejects. At declaration |
| `dim "duration_ms" is reserved` | A timer dim using the name a timing carries onto its record event. At declaration |
| `missing required dim "status"` | A declared dim with no value and no default |
| `unknown dim "pakr" — declared dims are [route, status]` | A key that is not declared |
| `route: expected a string, got 42` | A value of the wrong type |
| `status: "200" is not one of ["2xx", "3xx", "4xx", "5xx"]` | A value outside a `oneOf` set |
| `occurredAt: expected a valid Date, got "2026-09-17"` | A `ts()` dim given something that is not a `Date` |
| `http_requests: dims names "pakr", which is not a declared dim` | A snapshot filter or `groupBy` naming an undeclared dim |
| `memory driver: http_requests exceeded maxSeries (100000)` | A dim with unbounded values, on `memory()` |

## Related

- [Field types](/reference/field-types) for each builder and its modifiers
- [fields](/reference/fields) for the event and log equivalent
- [Snapshot options](/reference/snapshot-options) for reading dims back as rows
- [Buckets and time](/guide/buckets-and-time) for the other half of the row count
