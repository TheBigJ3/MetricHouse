# metrichouse

A metric collection layer for TypeScript that owns the parts of metrics a query
can never reconstruct — bucket boundaries, atomic aggregation, durable staging,
flush — and refuses to own anything else.

```bash
npm install metrichouse
```

## The rule

> The chef cooks the food. Someone else plates it.

MetricHouse owns anything **lost forever if not captured at write time**. It
refuses anything **derivable at query time**.

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
| `gauge` | a value over time, folded to `last`/`min`/`max`/`sum`/`count` | aggregated |
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

Early. Five primitives run, against two drivers measured by the same
executable driver contract. The API is not yet stable — this is `0.x`, and
minor versions may break.

Not yet built: the `level` and `distinct` primitives, `house.ingest()` and
backfill, the collector, and the CLI.

One known gap worth stating plainly: the `ioredis` driver tracks in-flight
claims but never sweeps them, so a process that dies between claiming a window
and acknowledging it leaves that window's data staged and undelivered. Failed
*writes* retry correctly and lose nothing; a failed *process* currently does
not. See [issue tracker](https://github.com/TheBigJ3/MetricHouse/issues).

## Requirements

Node 20 or newer.

## Documentation

The full design specification — 26 files, one per system — lives in
[`claude/initialPlan/`](https://github.com/TheBigJ3/MetricHouse/tree/main/claude/initialPlan),
starting with
[`00-overview.md`](https://github.com/TheBigJ3/MetricHouse/blob/main/claude/initialPlan/00-overview.md).

## License

MIT — see [LICENSE](https://github.com/TheBigJ3/MetricHouse/blob/main/LICENSE).
