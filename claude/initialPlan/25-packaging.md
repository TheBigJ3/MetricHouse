# Packaging

MetricHouse ships as subpath exports rather than one entry point, so an edge bundle carries the write path and nothing else. The collector, the test helpers, and every driver live behind their own specifiers.

> Added after [Breadcrumb](../imagine/breadcrumb/FINDINGS.md) — flaw B05. `import { counter } from 'metrichouse'` reached build tooling from inside edge middleware that runs on every page request. The SQL generator that originally motivated this no longer exists — MetricHouse emits none — but the rule stands for the collector, the CLI loader, and anything else reaching for `node:fs`.

## Exports map

| Specifier | Contains | Ships to |
| --- | --- | --- |
| `metrichouse/core` | declare, write, drain, live read, identity | the app, including edge |
| `metrichouse/redis` | `redis()`, `httpRedis()` | the app |
| `metrichouse/memory` | `memory()` | the app, tests |
| `metrichouse/collector` | `createCollector()` | the collector process |
| `metrichouse/testing` | assertion helpers | tests only |
| `metrichouse` | everything, for Node servers that do not care | server |

A metric declaration must stay inert and dependency-free: it carries its dims,
its resolution and its `write`, and reaches for nothing else. That is what makes
it importable from an edge bundle at all.

## Main functions — `metrichouse/testing`

- `testValue(metric, dims): number` — the current value as a plain number, no bucket map, no async
- `testRows(metric): Row[]` — every unflushed row for a metric, materialized as your `write()` would receive them
- `testEvents(metric): Fields[]` — staged events, decoded
- `resetMetrics(house)` — drop all state between tests
- `expectRecorded(metric, dims, times?)` — a matcher for `expect.extend`, published for Vitest and Jest

All of it requires the memory driver and throws otherwise, so nothing here can
accidentally read production state.

## In use

```ts
// app code — edge safe
import { counter, str } from 'metrichouse/core'
import { httpRedis } from 'metrichouse/redis'
```

```ts
// tests
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import { testValue, resetMetrics } from 'metrichouse/testing'
import { funnel } from '../metrics/schema'

const house = createHouse({ driver: memory(), schema, write: async () => {} })
beforeEach(() => resetMetrics(house))

it('records completion once', async () => {
  await completeSignup({ variant: 'treatment' })

  expect(testValue(funnel, { flow: 'signup', step: 'completed', variant: 'treatment' })).toBe(1)
  expect(testValue(funnel, { flow: 'signup', step: 'abandoned', variant: 'treatment' })).toBe(0)
})
```

The helper every project was otherwise going to write by hand, written once.
