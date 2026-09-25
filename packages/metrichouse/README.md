# metrichouse

A metric collection layer for TypeScript that fits into the stack you already
have. It collects your counts, events and timings, lets you read them live, and
hands you finished rows to store however your storage needs.

## Why

Most analytics tools want to be chosen before the rest of your stack. Hosted
ones keep your data and report it late. Self hosted ones bring a cluster to run,
such as ClickHouse, Kafka and Postgres. Observability libraries expect a
collector or a Prometheus server around them. And none of them lets your own
code ask what the number is right now, across every server.

MetricHouse is a library with no runtime dependencies, and it runs in your
process. You keep the most important part: how the data is written, where it
lives and what you do with it. MetricHouse handles collection: bucketing, atomic
aggregation, durable staging and flush. The full comparison is in
[What MetricHouse is](https://www.metrichouse.dev/guide/what-is-metrichouse).

```bash
npm install metrichouse
```

Full documentation: **[www.metrichouse.dev](https://www.metrichouse.dev/guide/getting-started)**.

## The rule

> The chef cooks the food. Someone else plates it.

MetricHouse handles the work that can only happen **at write time**. Work that
is **derivable at query time**, such as an average or a percentile, stays with
your database.

- There is a `counter` primitive, because discarded increments cannot be
  recovered. There is **no histogram**, because `quantile()` is a `SELECT`.
- Gauges store `sum` and `count`, never `avg` — an average does not merge
  across buckets and can be derived from two numbers that do.
- There is no query engine, no dashboard, and no database driver. You write the
  function that puts rows wherever you want them.
- There is **no SQL**. MetricHouse emits none, diffs no schema and opens no
  connection — the table your rows land in is yours to create and evolve.

## Quickstart

Declare a metric:

```ts
// metrics/schema.ts
import { counter, str, oneOf } from 'metrichouse/core'

export const dogPoops = counter('dog_poops', {
  dims: { dogName: str(), park: str(), kind: oneOf(['solid', 'liquid'] as const) },
  resolution: '1s',        // keep per-second fidelity
  flush: '5m',             // but ship no more often than every 5 minutes

  // you own this. MetricHouse owns everything above it.
  write: async (rows) => ch.insert('dog_poops', rows),
})
```

Bind it to a house once, at startup. A metric is an inert declaration until a
house registers it — writing to an unbound metric throws rather than dropping
data silently:

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import * as schema from './schema.js'

export const house = createHouse({ driver: memory(), schema })
```

Then write and read:

```ts
import { dogPoops } from './metrics/schema.js'

dogPoops.add({ dogName: 'Willow', park: 'riverside', kind: 'solid' })

await dogPoops.current({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
// -> 7        live, from the unflushed bucket, before anything hits the database
```

### Flush is explicit

Nothing flushes on its own. `house.flush()` is called by you — from a cron, a
worker, or a timer — and a metric's `flush` setting is a **minimum cadence**,
not a schedule. Calling `house.flush()` every 10 seconds still ships a
5-minute metric only every 5 minutes:

```ts
setInterval(() => house.flush(), 10_000)
```

On a serverless or edge runtime, where the isolate can freeze the moment a
response is returned, `await house.drain()` is the write guarantee — it
resolves once every queued write has reached the driver.

## Primitives

| Primitive | Measures | Storage |
| --- | --- | --- |
| `counter` | increments that cannot be recovered if discarded | aggregated |
| `gauge` | a value you sample, folded to `last`/`min`/`max`/`sum`/`count` | aggregated |
| `level` | a value that holds between writes, carried into the windows nobody wrote to | aggregated |
| `event` | records staged and shipped whole, never folded | staged |
| `log` | an event with a level, a `minLevel` filter and a bound `child()` | staged |
| `timer` | a gauge of durations, with `start()`, `time()` and `observe()` | aggregated |

## Entry points

Subpath exports keep the write path separate from the drivers, so an edge
bundle never pulls in a driver it does not use.

| Subpath | Contains |
| --- | --- |
| `metrichouse/core` | declare, write, drain, live read, identity, buckets |
| `metrichouse/memory` | `memory()` — plain Maps, for a long-lived single process |
| `metrichouse/ioredis` | `ioredis()` — shared, durable storage over an `ioredis` client |
| `metrichouse` | everything, for Node servers that do not care about bundle size |

`ioredis` is an **optional** peer dependency. Importing `metrichouse/ioredis`
is what requires it; an app on `metrichouse/memory` never installs it.

## Status

Early. Six primitives run: `counter`, `gauge`, `level`, `timer`, `event` and
`log`, against two drivers measured by the same executable driver contract. The
API is not yet stable. This is `0.x`, and minor versions may break.

Not yet built: the `distinct` primitive, `house.ingest()` and backfill, the
collector, and the CLI.

At-least-once holds across a failed *process* as well as a failed write, on
`ioredis`: a claim is a durable move, and a flush merges back any claim held
longer than `recoverAfter` (five minutes by default) before it claims, so a
crash mid-flush ships that window late rather than never. On `memory` a failed
process still loses the window in flight, because its claims never leave the
process and there is nothing left behind to recover.

## Requirements

Node 20 or newer.

## Documentation

**[www.metrichouse.dev](https://www.metrichouse.dev/guide/getting-started)** —
getting started, one page per primitive, deployment guides, worked examples and
an API reference.

## License

MIT — see [LICENSE](https://github.com/TheBigJ3/MetricHouse/blob/main/LICENSE).
