# Schema

The schema layer is where every metric is declared: name, kind, dimensions or fields, resolution, flush cadence, and the write function that ships its rows. It is plain TypeScript you import directly — there is no generated client, so call-site types are inferred straight from the declaration.

## Main functions

**Metric factories**
- `counter(name, config)` — declare a counter. See [03-counter.md](03-counter.md).
- `gauge(name, config)` — declare a gauge. See [04-gauge.md](04-gauge.md).
- `level(name, config)` — declare a level. See [20-level.md](20-level.md).
- `distinct(name, config)` — declare a unique count. See [21-distinct.md](21-distinct.md).
- `event(name, config)` — declare an event type. See [05-events.md](05-events.md).
- `log(name, config)` — declare a log stream. See [06-logs.md](06-logs.md).

**Type builders** (shared by `dims` and `fields`)
- `str()` — string
- `int()` — 64-bit integer
- `float()` — double
- `bool()` — boolean
- `oneOf([...] as const)` — closed set, narrows to a union type
- `ts()` — timestamp
- `json<T>()` — arbitrary payload; **event/log fields only**, never a dim

**Modifiers**
- `.optional()` — the value may be absent
- `.default(v)` — filled in when the call omits it

**Composition**
- `defineDefaults(partial)` — shared `resolution` / `flush` / `write` / `stage` **and `dims`** merged into metrics that omit them; declared dims are merged key-by-key, and a metric redeclaring a key wins
- `metric.extend(partial)` — clone a declaration with overrides

**Type helpers**
- `InferDims<typeof metric>` — the object `.add()` accepts
- `InferRow<typeof metric>` — the row shape your `write()` receives
- `InferFields<typeof metric>` — the object `.record()` accepts

## In use

```ts
// metrics/schema.ts
import {
  counter, gauge, event, log,
  str, int, float, oneOf, json,
  defineDefaults,
} from 'metrichouse/core'   // write path only — see 25-packaging.md
import { ch } from '../lib/clickhouse'

// dims declared once here land on every metric that spreads `defaults`
const defaults = defineDefaults({
  resolution: '1s',
  flush: '5m',
  dims: {
    service: str(),
    environment: oneOf(['dev', 'staging', 'prod'] as const),
    region: str(),
    release: str(),
  },
})

export const dogPoops = counter('dog_poops', {
  ...defaults,
  dims: {
    dogName: str(),
    park: str(),
    kind: oneOf(['solid', 'liquid'] as const),
  },
  write: async (rows) => ch.insert('dog_poops', rows),
})

export const bowlLevel = gauge('bowl_level', {
  ...defaults,
  resolution: '10s',
  dims: { bowlId: str() },
  aggregate: ['last', 'min', 'max', 'sum', 'count'],
  write: async (rows) => ch.insert('bowl_level', rows),
})

export const walkStarted = event('walk_started', {
  fields: {
    dogName: str(),
    walkerId: str(),
    routeMeters: int().optional(),
    weather: json<{ tempC: number; rain: boolean }>().optional(),
  },
  stage: 'redis',
  write: async (rows) => ch.insert('walk_started', rows),
})
```

```ts
// call site — fully typed, nothing generated
import { dogPoops } from './metrics/schema'

dogPoops.add({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
//                                                    ^ 'solid' | 'liquid'
```
