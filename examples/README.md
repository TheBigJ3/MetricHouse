# examples/

Small, complete, runnable applications. Each one boots, emits real metrics,
flushes to a real database, and can be read start to finish in a few minutes.

Not to be confused with [`imagine/`](../claude/imagine/), which contains *hypothetical*
projects written to break the spec. Those do not run and never will. These do,
and CI runs them.

## Planned

| Example | Shows |
| --- | --- |
| `basic-node` | schema, house, `flush()` from a `setInterval`, ClickHouse sink |
| `nextjs-vercel` | serverless: `drain()`, `httpRedis()`, cron flush endpoint |
| `express-dashboard` | live read powering a real chart — the motivating use case |
| `postgres-sink` | the same schema, no ClickHouse anywhere |
| `edge-federation` | two houses, `write()` → `ingest()` across a boundary |
| `custom-driver` | implementing the driver interface against something else |

## Rules

- Every example runs from `docker compose up` plus one command.
- No example depends on another.
- Every example is in CI. An example that does not run is worse than no example.
