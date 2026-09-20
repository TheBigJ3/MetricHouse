# Declaring a metric

A metric declaration says what you are measuring, how it should be labelled,
and where the finished rows go. This page covers the declaration itself. The
arguments that appear on more than one type have pages of their own:
[dims](/reference/dims), [fields](/reference/fields),
[Field types](/reference/field-types) and [Durations](/reference/durations).

## The shape of a declaration

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

| Part | What it decides |
| --- | --- |
| The name | What your table and your queries call it. Unique inside a house |
| The labels | [`dims`](/reference/dims) on a folded type, [`fields`](/reference/fields) on a record keeping one |
| The time settings | [`resolution`](/guide/buckets-and-time), `flush` and `grace` |
| `write` | [The one function you write](/guide/writing-a-sink) |

Each type adds a few settings of its own, and each metric page lists them one
by one. [Metric types](/primitives/) has the side by side table.

## A declaration is inert

`counter()` opens nothing, starts no timer and touches no driver. It returns an
object describing what you want, and a [house](/guide/the-house) is what turns
that into something that writes.

```ts
httpRequests.add({ route: '/checkout', method: 'GET', status: '2xx' })
// Error: not bound to a house — pass it to createHouse({ schema }) before writing
```

That is why a schema file is safe to import anywhere, including at module scope
on a serverless runtime that re runs it on every cold start.

## Mistakes surface at import

Configuration is checked when the module is first imported rather than at the
first write. An invalid duration, a type that cannot be used as a label, a
`resolution` that does not divide `flush` evenly, a reserved field name and a
bad default value all throw there.

```ts
counter('requests', { resolution: '7s', flush: '1m', write })
// Error: resolution 7s does not divide flush 1m evenly
```

[Validation that runs at startup](/reference/configuration#validation-that-runs-at-startup)
lists every check and the message it produces.

Two checks cannot run that early, and happen when the house registers the
metric instead: a cadence that comes from `defaults.flush`, and a second metric
claiming a name that is taken.

## The types come from the declaration

The declaration is an ordinary value, so TypeScript reads it directly. There is
no code generation step and no build tool.

```ts
httpRequests.add({ route: '/checkout', method: 'POST', status: '2xx' })

httpRequests.add({ route: '/checkout', method: 'POST', status: '200' })
//                                                     ^^^^^
// Type error: '200' is not assignable to '2xx' | '3xx' | '4xx' | '5xx'

httpRequests.add({ route: '/checkout', method: 'POST' })
// Type error: property 'status' is missing
```

The same declaration types the rows your `write` function receives, and the
rows `snapshot()` returns. [Rows are typed](/guide/writing-a-sink#rows-are-typed)
follows that through to the sink.

## Reading a declaration back

Every metric exposes what it was declared with, which is useful for building a
table, checking a deployment, or generating a schema.

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
//     { name: 'id',        kind: 'str',   optional: false },
//     { name: 'bucket_ts', kind: 'ts',    optional: false },
//     { name: 'route',     kind: 'str',   optional: false },
//     { name: 'method',    kind: 'oneOf', optional: false },
//     { name: 'status',    kind: 'oneOf', optional: false },
//     { name: 'value',     kind: 'int',   optional: false },
//   ]
// }
```

`rowShape()` is the exact column list your `write` function will receive, in
order. It is the honest answer to "what columns does my table need".

## Keeping a schema in one module

Keep declarations in one module and the house in another, then import the whole
schema module rather than listing metrics by hand.

```ts
// metrics/schema.ts
export const httpRequests = counter('http_requests', { /* ... */ })
export const httpLatency = timer('http_latency', { /* ... */ })
export const appLog = log('app_log', { /* ... */ })
```

```ts
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

## Where to go next

- [dims](/reference/dims) for labelling a folded metric, and what it costs
- [fields](/reference/fields) for the record keeping types
- [Buckets and time](/guide/buckets-and-time) for choosing `resolution` and `flush`
- [The house](/guide/the-house) for binding a schema to a driver
- [Metric types](/primitives/) for the page on each type
