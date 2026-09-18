# MetricHouse

A metric collection layer for TypeScript that owns the parts of metrics a query
can never reconstruct — bucket boundaries, atomic aggregation, durable staging,
flush — and refuses to own anything else.

> **Status: five primitives run.** `counter`, `gauge`, `event`, `log` and
> `timer` all write through the memory driver, live-read, and flush to your
> `write()` with stable row ids — the snippet below is a working program, not a
> sketch. `event` brought the second storage model with it: records are staged
> and shipped whole, never folded, so the driver contract covers both
> aggregation and durable staging. The two newest add no storage of their own:
> `log` is an event with a level, a `minLevel` filter and a bound `child()`
> logger, and `timer` is a gauge of durations with a `start()` handle, a scoped
> `time()`, and an optional event for percentiles. Storage is now two drivers,
> not one: `ioredis` joined `memory`, both measured against the same executable
> driver contract, so at-least-once holds across a failed write rather than
> just a failed call. On `ioredis` it now holds across a failed *process* too:
> a flush puts back any claim held longer than `recoverAfter` before it claims,
> so a crash mid-flush delays that window rather than stranding it. Still
> missing: `level`/`distinct`, `ingest`/`backfill`, and the CLI.

## The rule

> The chef cooks the food. Someone else plates it.

MetricHouse owns anything **lost forever if not captured at write time**. It
refuses anything **derivable at query time**. That one line settles most of the
design:

- There is a `counter` primitive, because discarded increments cannot be
  recovered. There is **no histogram**, because `quantile()` is a `SELECT`.
- Gauges store `sum` and `count`, never `avg` — an average does not merge across
  buckets and can be derived from two numbers that do.
- There is no query engine, no dashboard, and no database driver. You write the
  function that puts rows wherever you want them.
- There is **no SQL**. MetricHouse emits none, diffs no schema and opens no
  connection — the table your rows land in is yours to create and evolve.

## Install

```bash
npm install metrichouse
```

Node 20 or newer. `ioredis` is an optional peer dependency, required only if
you import `metrichouse/ioredis`.

## Documentation

The user-facing docs are a VitePress site in [`docs/`](docs/): getting started,
one page per primitive, deployment guides, worked examples, and an API
reference. Every snippet in it is checked against the built package.

```bash
pnpm --filter @metrichouse/docs dev      # http://localhost:5173
```

It is deployed on Vercel, which builds it from `docs/` on every push to `main`.
[`docs/vercel.json`](docs/vercel.json) holds the build command and the output
directory, and [`docs/README.md`](docs/README.md) explains the rest.

## What it looks like

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
dogPoops.add({ dogName: 'Willow', park: 'riverside', kind: 'solid' })

await dogPoops.current({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
// -> 7        live, from the unflushed bucket, before anything hits the database
```

### Getting it out

A metric is a complete unit — what it measures, how often it ships, and where
it ships to — so flushing one needs no house at all:

```ts
await dogPoops.flush()
// -> { rows: 12, buckets: 300, skipped: false }
```

Nothing ticks on its own. On a **long-lived process**, `house.start()` gives
each metric its own interval at its own cadence, and nothing else has to pump:

```ts
house.start()                     // dog_poops ships every 5m, on its own timer
process.on('SIGTERM', async () => {
  await house.stop()              // clear timers, drain, force a final flush
})
```

On **edge and serverless**, where the isolate is frozen between requests and a
timer never fires, you pump it yourself. `house.flush()` is a fan-out over
`metric.flush()`, and each metric still honours its own cadence — so a cron
every ten seconds still ships `dog_poops` only every five minutes:

```ts
setInterval(() => house.flush(), 10_000)   // or a cron, or a request handler
```

Three separate knobs, and it is worth keeping them apart:

| | what it is | who owns it |
|---|---|---|
| `resolution: '1s'` | bucket width — the fidelity of the stored series | the metric |
| `flush: '5m'` | a **minimum** on how often this metric ships | the metric |
| `start()` / `flush()` | what actually asks it to | you |

Under-pumping costs freshness, never fidelity: a claim takes *every* closed
bucket, so five minutes of one-second buckets arrive as 300 rows at once.

## Repository layout

```
packages/             published to npm — the runtime and the CLI, split apart
runtime-tests/        the same suite against Node, Bun, Deno, Workers, Edge, Lambda
benchmarks/           write-path overhead, Lua contention, flush throughput
examples/             small runnable apps, all in CI
docs/                 the documentation site
```

One package: `metrichouse`, the runtime, small enough to ship to an edge
bundle. Subpath exports keep the write path separate from the drivers. A CLI
package will follow once the runtime exists — see
[`packages/README.md`](packages/README.md).

`runtime-tests/` and `benchmarks/` are level 1 because both design decisions
they cover — a network call on the hot path, and a write path that can be
silently discarded by a serverless isolate — are only defensible with numbers
and a matrix, not with prose.

## Where it stands

Settled: the chef rule, resolution independent of flush, deterministic row ids,
explicit `flush()`, per-metric write functions, pre-declared dimensions.

Open, and worth arguing about:

- **`house.ingest()` is doing a lot of work.** It arrived for historical
  backfill, then answered edge federation and multi-region latency. That is
  either good design or a bucket that catches everything.
- **No cardinality guard on Redis.** Deliberate — the answer is a static
  projection in `metrichouse check`, not a runtime cap. The memory driver caps
  anyway, and that asymmetry is a real seam.
- **No live percentiles.** Live read cannot see staged events, so p95 for the
  current window is unavailable. Accepted, and documented rather than hidden.

## Development

```bash
pnpm install
pnpm build          # tsdown
pnpm typecheck      # tsc --noEmit per package
pnpm test           # vitest
pnpm check          # everything CI runs
```

Requires Node 20+ and pnpm 12. If `pnpm` on your machine is Corepack's shim
from a Node install older than Corepack 0.35, it cannot launch pnpm 12 — pnpm
moved to a native binary and Corepack still looks for `bin/pnpm.cjs`. Install
pnpm directly instead:

```bash
brew install pnpm            # or: npm i -g pnpm@12 --force
```

## License

MIT — see [LICENSE](LICENSE).
