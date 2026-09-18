# Metrics and dimensions

A metric declaration says what you are measuring, how it should be labelled, and
where the finished rows go. This page covers the declaration itself and the
labelling system, which is the setting that most affects how much data you
produce.

## Declaring a metric

Every metric takes a name and a configuration object.

```ts
import { counter, oneOf, str } from 'metrichouse/core'

export const httpRequests = counter('http_requests', {
  dims: {
    route: str(),
    method: oneOf(['GET', 'POST', 'PUT', 'DELETE']),
    status: oneOf(['2xx', '3xx', '4xx', '5xx']),
  },
  resolution: '10s',
  flush: '1m',
  write: async (rows) => clickhouse.insert('http_requests', rows),
})
```

The name is what your table and your queries use. It has to be unique inside a
house, and two metrics sharing a name is an error at startup.

Mistakes in the configuration are caught when the file is first imported, not at
the first write. An invalid duration, a dimension type that cannot be used as a
label, or a `resolution` that does not divide `flush` evenly all throw
immediately.

## Dimensions

Dimensions are the labels you want to break a number down by. They are declared
in advance, and the type system uses those declarations to check every call.

```ts
httpRequests.add({ route: '/checkout', method: 'POST', status: '2xx' })

httpRequests.add({ route: '/checkout', method: 'POST', status: '200' })
//                                                     ^^^^^
// Type error: '200' is not assignable to '2xx' | '3xx' | '4xx' | '5xx'

httpRequests.add({ route: '/checkout', method: 'POST' })
// Type error: property 'status' is missing
```

That checking happens with no code generation step and no build tool. The
declaration is an ordinary value, so TypeScript reads it directly.

### Every combination is its own running total

<figure class="mh-figure">
  <img src="/diagrams/dimensions-to-series.svg" alt="Dimension declarations become series keys, and each series key becomes one row per bucket." />
  <figcaption>Each distinct combination of values you write becomes one row per bucket.</figcaption>
</figure>

With the metric above, a bucket that saw three routes, two methods and two status
classes holds up to twelve separate totals, and produces up to twelve rows.

Work out roughly what that number is before you ship:

```
rows per flush  =  distinct combinations  x  buckets per flush
```

For `resolution: '10s'` and `flush: '1m'` there are 6 buckets per flush. Twelve
combinations gives up to 72 rows a minute, which is nothing. Add a `userId`
dimension with a hundred thousand users and the same metric produces up to
600,000 rows a minute, which is a problem.

The other half of that number is the resolution, and
[Buckets and time](/guide/buckets-and-time) covers how to choose it.

### The rule for choosing dimensions

Use a dimension when the set of possible values is small and predictable. Route
names, country codes, plan tiers, status classes and boolean flags are all good.

Never use a dimension for something unique per request or per user. User ids,
request ids, session ids, raw URLs with query strings and email addresses all
belong on an [event](/primitives/event) instead, which is built to hold exactly
that kind of detail.

::: warning The memory driver is the only one that stops you
The `memory()` driver refuses writes past 100,000 distinct combinations per
metric so that a runaway dimension fails loudly instead of running the process
out of memory. The Redis driver has no such limit, so the same mistake there is
a slow growth in memory use rather than an error. Decide the shape of your
dimensions deliberately.
:::

### A metric with no dimensions

Leave `dims` out entirely for a metric that is a single number.

```ts
const jobsProcessed = counter('jobs_processed', {
  resolution: '1m',
  flush: '1m',
  write: async (rows) => db.insert(rows),
})

jobsProcessed.add()       // no argument needed
jobsProcessed.add(5)
await jobsProcessed.current()
```

Do not add a dimension you do not need. A `userId` dimension turns one number
into one number per user.

## Field types

Dimensions and event fields are declared with type builders. They are all
exported from `metrichouse/core`.

| Builder | Accepts | Notes |
| --- | --- | --- |
| `str()` | `string` | |
| `int()` | whole `number` | Rejects fractions |
| `float()` | any finite `number` | |
| `bool()` | `boolean` | |
| `ts()` | `Date` | Stored as epoch milliseconds |
| `oneOf([...])` | one of the listed values | Narrows to a union in TypeScript |
| `json<T>()` | anything | Event fields only, never a dimension |

Two modifiers apply to any of them:

```ts
str().optional()            // the caller may leave this out
str().default('unknown')    // the caller may leave it out, and this is used
```

Both make the key optional at the call site. The difference is what ends up in
the row: `.optional()` leaves the value absent, `.default()` fills it in.

```ts
const signups = counter('signups', {
  dims: {
    plan: oneOf(['free', 'pro', 'team']),
    referrer: str().default('direct'),
    campaign: str().optional(),
  },
  resolution: '1m',
  flush: '5m',
  write: async (rows) => db.insert(rows),
})

signups.add({ plan: 'pro' })
// referrer is 'direct', campaign is absent

signups.add({ plan: 'pro', campaign: 'launch' })
```

`json()` is rejected as a dimension and the error says so at declaration time. A
payload cannot be turned into a label without either losing information or
producing a different label for every write.

Full details are in the [field type reference](/reference/field-types).

### Reordering dimensions is a breaking change

The label key is built from your dimension values in declaration order. Rows
written before a reorder will not match rows written after it. Add new dimensions
at the end, and treat a reorder like a schema migration.

## Durations

Every time based setting takes the same format: a whole number followed by a
lowercase unit.

| Unit | Meaning | Example |
| --- | --- | --- |
| `ms` | milliseconds | `'500ms'` |
| `s` | seconds | `'30s'` |
| `m` | minutes | `'5m'` |
| `h` | hours | `'2h'` |
| `d` | days | `'7d'` |

A plain number is accepted and taken as milliseconds.

These are rejected, each with an error naming the input:

| Rejected | Why |
| --- | --- |
| `'1.5m'` | Fractions are not allowed. Write `'90s'`. |
| `'5M'` | Uppercase is ambiguous between minutes and months. |
| `'5'` | A bare numeric string could mean anything. Use `5` or `'5s'`. |
| `'-5m'` | Negative durations are never meaningful. |

## Reading a declaration back

Every metric exposes what it was declared with, which is useful for building a
table or checking a deployment.

```ts
httpRequests.name           // 'http_requests'
httpRequests.kind           // 'counter'
httpRequests.storage        // 'bucketed'
httpRequests.resolutionMs   // 10000
httpRequests.flushMs        // 60000
httpRequests.graceMs        // 2000
httpRequests.dims           // the declared shape
httpRequests.isBound        // true once a house has registered it

httpRequests.rowShape()
// {
//   columns: [
//     { name: 'id',        kind: 'str', optional: false },
//     { name: 'bucket_ts', kind: 'ts',  optional: false },
//     { name: 'route',     kind: 'str', optional: false },
//     { name: 'method',    kind: 'oneOf', optional: false },
//     { name: 'status',    kind: 'oneOf', optional: false },
//     { name: 'value',     kind: 'int', optional: false },
//   ]
// }
```

`rowShape()` is the exact column list your `write` function will receive, in
order. It is the honest answer to "what columns does my table need".

## In production

Keep declarations in one module and the house in another. Import the whole
schema module rather than listing metrics by hand.

```ts
// metrics/schema.ts
export const httpRequests = counter('http_requests', { /* ... */ })
export const httpLatency = timer('http_latency', { /* ... */ })
export const appLog = log('app_log', { /* ... */ })

// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import Redis from 'ioredis'
import * as schema from './schema.js'

export const house = createHouse({
  driver: ioredis(() => new Redis(process.env.REDIS_URL!)),
  schema,
  defaults: { flush: '1m', grace: '5s' },
  onError: (error, { metric }) => logger.error({ err: error, metric }, 'metric write failed'),
})
```

The house picks metrics out of the module and ignores every other export, so
adding a metric is one export and nothing else.
