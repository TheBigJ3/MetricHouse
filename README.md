# MetricHouse

A metric collection layer for TypeScript that owns the parts of metrics a query
can never reconstruct — bucket boundaries, atomic aggregation, durable staging,
flush — and refuses to own anything else.

> **Status: three primitives run.** `counter`, `gauge` and `event` all write
> through the memory driver, live-read, and flush to your `write()` with stable
> row ids — the snippet below is a working program, not a sketch. `event`
> brings the second storage model with it: records are staged and shipped
> whole, never folded, so the driver contract now covers both aggregation and
> durable staging. Still missing: the Redis driver, `level`/`log`/`distinct`,
> `ingest`/`backfill`, and the CLI. The specification in
> [`claude/initialPlan/`](claude/initialPlan/) describes the whole design;
> [`claude/imagine/`](claude/imagine/) holds three hypothetical projects
> written to break it.

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

## What it looks like

```ts
// metrics/schema.ts
import { counter, str, oneOf } from 'metrichouse/core'

export const dogPoops = counter('dog_poops', {
  dims: { dogName: str(), park: str(), kind: oneOf(['solid', 'liquid'] as const) },
  resolution: '1s',        // keep per-second fidelity
  flush: '5m',             // but only ship every 5 minutes

  // you own this. MetricHouse owns everything above it.
  write: async (rows) => ch.insert('dog_poops', rows),
})
```

```ts
dogPoops.add({ dogName: 'Willow', park: 'riverside', kind: 'solid' })

await dogPoops.current({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
// -> 7        live, from the unflushed bucket, before anything hits the database
```

## Repository layout

```
packages/             published to npm — the runtime and the CLI, split apart
runtime-tests/        the same suite against Node, Bun, Deno, Workers, Edge, Lambda
benchmarks/           write-path overhead, Lua contention, flush throughput
examples/             small runnable apps, all in CI
docs/                 the documentation site
claude/initialPlan/   the specification — 25 files, one per system
claude/imagine/       hypothetical projects written to break the specification
```

One package: `metrichouse`, the runtime, small enough to ship to an edge
bundle. Subpath exports keep the write path separate from the drivers. A CLI
package will follow once the runtime exists — see
[`packages/README.md`](packages/README.md).

`runtime-tests/` and `benchmarks/` are level 1 because both design decisions
they cover — a network call on the hot path, and a write path that can be
silently discarded by a serverless isolate — are only defensible with numbers
and a matrix, not with prose.

### `initialPlan/` — the specification

25 files. Each covers one system: a two-sentence summary, its main functions,
and a usage snippet. Start with
[`00-overview.md`](claude/initialPlan/00-overview.md), which carries the locked
decisions, the data flow, and an index.

### `imagine/` — hypothetical projects that break the spec

Three projects written against MetricHouse *before it exists*, each chosen to
attack a different assumption. Each carries a `FINDINGS.md`. See
[`imagine/README.md`](claude/imagine/README.md) for the method.

| Project | Workload | Found |
| --- | --- | --- |
| [`tollgate`](claude/imagine/tollgate/) | LLM API gateway | 14 flaws, 9 configs, 4 stat types |
| [`coldchain`](claude/imagine/coldchain/) | 100k IoT devices, 6-day offline gaps | 9 flaws, 4 configs, 0 stat types |
| [`breadcrumb`](claude/imagine/breadcrumb/) | serverless product analytics | 9 flaws, 5 configs, 0 stat types |

Three rounds in, the pattern is clear: **the data model has held under every
workload, and the runtime contract has broken under each new one.**

## Where it stands

Settled and stress-tested across three workloads: the chef rule, resolution
independent of flush, deterministic row ids, explicit `flush()`, per-metric
write functions, pre-declared dimensions.

Open, and worth arguing about before any code is written:

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
