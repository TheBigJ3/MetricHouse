# packages/

Everything published to npm. pnpm workspace, one directory per package.

## One package, for now

`metrichouse` is the runtime and the only published package. Subpath exports
keep an edge bundle down to the write path.

| Subpath | Contains | Status |
| --- | --- | --- |
| `metrichouse/core` | declare, write, drain, live read, identity, buckets | ✅ exported |
| `metrichouse/memory` | `memory()` | ✅ exported |
| `metrichouse/ioredis` | `ioredis()` | ✅ exported |
| `metrichouse` | everything, for Node servers that do not care | ✅ exported |
| `metrichouse/collector` | `createCollector()` | planned |
| `metrichouse/testing` | assertion helpers, memory driver only | planned |

Only the four above appear in `package.json`. **A subpath is added to the
exports map together with the code behind it, never ahead of it** — an entry
resolving to an empty module is worse than an absent one, because the consumer
importing it gets nothing and no error. The same rule governs
`peerDependencies`: `ioredis` is optional, and declared only because
`metrichouse/ioredis` exists.

`dependencies` must stay near zero.

## The CLI

A CLI — `init`, `cost`, `inspect`, `flush`, `collect` — is planned as a
separate package, because it needs `node:fs` and must never be a runtime
dependency. It is not built yet.

## The boundary

MetricHouse sits between the data and the datastore. It owns bucketing,
aggregation, staging, identity and flush; it hands your `write()` typed rows
and stops. It emits no SQL, diffs no schema, and opens no connection. What
those rows land in — the table, its types, whether it collapses duplicate
`id`s — is yours. See [Writing a sink](https://www.metrichouse.dev/guide/writing-a-sink).
