# runtime-tests/

The same test suite, run against every runtime MetricHouse claims to support.

Separate from each package's unit tests because these need real runtimes, not
mocks — they are slow, they run in CI on a matrix, and a green unit suite says
nothing about whether a write survives an isolate freeze.

## Why this is level 1

[Breadcrumb](../claude/imagine/breadcrumb/) found that the write path behaves
differently on every serverless platform, and that the failure mode is silent:
`.add()` never throws, so a lost write looks identical to a successful one.
Nothing but running on the real thing catches it.

## Matrix

| Target | Proves |
| --- | --- |
| Node (LTS + current) | the baseline; `close()` on `SIGTERM` |
| Bun | driver and timer compatibility |
| Deno Deploy | no TCP; `drain()` must be awaited |
| Cloudflare Workers | `httpRedis()`, `ctx.waitUntil`, bundle limit |
| Vercel Edge / middleware | the weakest drain guarantee in the matrix |
| AWS Lambda | drain before the handler resolves |

## What each target must prove

1. A write issued immediately before the response **lands**.
2. A write issued without `drain()` on a platform that needs it **fails loudly**,
   not silently.
3. `stage: 'memory'` and the memory driver are **rejected at declare time**
   where they cannot be drained.
4. `flush({ deadline })` returns `complete: false` rather than livelocking when
   the backlog exceeds the function timeout.
5. The `metrichouse/core` bundle stays under the target's size ceiling.
