# packages/

Everything published to npm. pnpm workspace, one directory per package.

## One package, for now

`metrichouse` is the runtime and the only published package. Subpath exports
keep an edge bundle down to the write path.

| Subpath | Contains | Status |
| --- | --- | --- |
| `metrichouse/core` | declare, write, drain, live read, identity, buckets | ✅ exported |
| `metrichouse/memory` | `memory()` | ✅ exported |
| `metrichouse` | everything, for Node servers that do not care | ✅ exported |
| `metrichouse/redis` | `redis()`, `httpRedis()` | planned |
| `metrichouse/collector` | `createCollector()` | planned |
| `metrichouse/testing` | assertion helpers, memory driver only | planned |

Only the first three appear in `package.json`. **A subpath is added to the
exports map together with the code behind it, never ahead of it** — an entry
resolving to an empty module is worse than an absent one, because the consumer
importing it gets nothing and no error. The same rule governs
`peerDependencies`: the Redis clients come back when `metrichouse/redis` does.

`dependencies` must stay near zero.

## Why `metrichouse-kit` is gone

The second package existed for [Breadcrumb flaw
B05](../claude/imagine/breadcrumb/FINDINGS.md): one entry point put a SQL
generator inside edge middleware. MetricHouse now emits no SQL at all, so the
generator, the schema differ, and the migration commands are deleted rather
than relocated — and the split's stated reason went with them.

What remained of the kit — `init`, `cost`, `inspect`, `flush`, `collect` — is
worth building, and [17-cli.md](../claude/initialPlan/17-cli.md) keeps the
design. None of it is buildable before the runtime exists, and `cost` has no
schema to project from until there is one. The package comes back after slice 1
lands, and its justification will be "a CLI needs `node:fs` and must never be a
runtime dependency" — a real reason, but a different one.

## The boundary

MetricHouse sits between the data and the datastore. It owns bucketing,
aggregation, staging, identity and flush; it hands your `write()` typed rows
and stops. It emits no SQL, diffs no schema, and opens no connection. What
those rows land in — the table, its types, whether it collapses duplicate
`id`s — is yours. See [13-sink.md](../claude/initialPlan/13-sink.md).
