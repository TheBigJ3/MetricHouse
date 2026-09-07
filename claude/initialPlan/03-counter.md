# Counter

A counter accumulates an integer per (dimension combination, time bucket) and is the one primitive that genuinely cannot be rebuilt after the fact — once the increments are discarded, no query brings the per-minute count back. Increments go straight to the driver pipelined, so the open bucket is always exact across every instance.

## Main functions

**Declaration**
- `counter(name, config)` — returns a typed, inert metric until a [house](08-house.md) registers it

Config fields:
- `dims` — declared bucketing dimensions ([02-dims.md](02-dims.md))
- `value` — `int()` (default, `Int64`) or `float()` (`Float64`, `HINCRBYFLOAT`)
- `resolution` — bucket width, e.g. `'1s'`
- `flush` — minimum shipping cadence, e.g. `'5m'`
- `grace` — how long past a boundary late writes are still accepted, default `'2s'`
- `retention` — keep buckets readable for this long *after* a successful ack, default off ([15-live-read.md](15-live-read.md))
- `write` — this metric's sink ([13-sink.md](13-sink.md)); falls back to the house's

**Write**
- `.add(dims?)` — increment by 1
- `.add(n, dims?)` — increment by `n`; negative allowed
- `.add(n, dims, { at })` — attribute to a specific timestamp ([07-buckets.md](07-buckets.md))
- `.addMany(entries)` — one pipeline round trip for many combinations

**Read** — unflushed data only, see [15-live-read.md](15-live-read.md)
- `.current(dims)` — the open bucket's value for one series
- `.current()` — **the metric's total**, every series in the open bucket summed. A counter tracks one thing; its dims are extra information collected alongside, and reading `dogs_walked` should not require naming a breed
- `.snapshot(opts?)` — every unflushed bucket, optionally filtered by dims or time range

**Introspection**
- `.rowShape()` — the typed row your `write()` will receive

## In use

```ts
// metrics/schema.ts
import { counter, str, oneOf } from 'metrichouse'
import { ch } from '../lib/clickhouse'

export const dogPoops = counter('dog_poops', {
  dims: {
    dogName: str(),
    park: str(),
    kind: oneOf(['solid', 'liquid'] as const),
  },
  resolution: '1s',   // keep per-second fidelity
  flush: '5m',        // but only ship every 5 minutes
  write: async (rows) => ch.insert('dog_poops', rows),
})
```

```ts
// anywhere in the app
import { dogPoops } from './metrics/schema'

dogPoops.add({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
dogPoops.add(3, { dogName: 'Rex', park: 'central', kind: 'liquid' })

// live, before anything has been flushed
await dogPoops.current({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
// -> 1

await dogPoops.current()
// -> 4        the metric's total — every series summed
```

## Dims are extra information, not the point

The counter is `dog_poops`. `dogName`, `park` and `kind` are things worth
knowing *about* those poops, not separate metrics. Every `.add()` raises the
total no matter which dims came with it, and `flush` hands your sink both:

```ts
write: async (rows, ctx) => {
  await ch.insert('dog_poops', rows)   // the breakdown, one row per series
  console.log(ctx.total)               // the headline number, already summed
}
```

A sink that only wants the headline can write `ctx.total` and ignore `rows`
entirely — or log the breakdown and never send it to the database. Deciding
that is the sink's job, which is the whole point of the sink being yours.

At flush, the 5-minute window yields 300 one-second rows — full fidelity, rolled up in SQL:

```sql
SELECT toStartOfMinute(bucket_ts) AS m, dogName, sum(value)
FROM dog_poops GROUP BY m, dogName;
```
