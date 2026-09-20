# Durations

Every time based setting in MetricHouse takes the same input: a whole number
followed by a lowercase unit, or a plain number of milliseconds.

```ts
resolution: '10s'
flush: '1m'
grace: '2s'
holdFor: '5m'
batch: { maxAge: '10s' }
```

## The format

```
<whole number><unit>
```

| Unit | Meaning | Example | Milliseconds |
| --- | --- | --- | --- |
| `ms` | milliseconds | `'500ms'` | 500 |
| `s` | seconds | `'30s'` | 30,000 |
| `m` | minutes | `'5m'` | 300,000 |
| `h` | hours | `'2h'` | 7,200,000 |
| `d` | days | `'7d'` | 604,800,000 |

A plain `number` is accepted and read as milliseconds, so `5_000` and `'5s'`
mean the same thing. Whitespace around a string is trimmed. Zero is a valid
duration wherever zero is meaningful, which in practice means `grace: '0s'`.

## Every setting that takes one

| Setting | On | Default |
| --- | --- | --- |
| [`resolution`](/primitives/counter#resolution) | counter, gauge, level, timer | required |
| [`flush`](/primitives/counter#flush) | every metric type | the house default, then `'30s'` on event and log |
| [`grace`](/primitives/counter#grace) | counter, gauge, level, timer | `'2s'` |
| [`holdFor`](/primitives/level#holdfor) | level | forever |
| [`batch.maxAge`](/primitives/event#batch) | event, log | `'10s'` |
| [`defaults.flush`](/reference/configuration#createhouse) | `createHouse` | none |
| [`defaults.grace`](/reference/configuration#createhouse) | `createHouse` | `'2s'` |
| [`recoverAfter`](/reference/configuration#ioredis) | `ioredis` | `'5m'` |

## Rejected inputs

Each one throws when the module is imported, with a message naming what you
wrote.

| Rejected | Why |
| --- | --- |
| `'1.5m'` | Fractions are not allowed. Write `'90s'` |
| `'5M'` | An uppercase `M` reads as minutes to some people and months to others, so neither is accepted |
| `'5'` | A bare numeric string could mean anything. Write `5` for milliseconds, or `'5s'` |
| `'-5m'` | A negative duration has no meaning here |
| `'5 s'` | The number and the unit run together, with no space between them |
| `'5w'` | Weeks, months and years are not units. Write `'7d'` |
| `NaN`, `Infinity`, `1.5` | A plain number has to be a whole, non negative, safe integer |

```
parseDuration: "1.5m"
parseDuration: "5M"
parseDuration: -300000
```

The strictness is deliberate. Loosening what parses later is a change nobody
has to think about, and tightening it is a change that breaks a running
deployment.

## resolution has to divide flush

A flush ships whole windows, so `flush` has to be a whole multiple of
`resolution`. Anything else would split a window across two shipments.

```ts
counter('requests', { resolution: '10s', flush: '1m', write })   // 6 windows per flush
counter('requests', { resolution: '7s', flush: '1m', write })
// Error: resolution 7s does not divide flush 1m evenly - a shipment would
// split a bucket
```

The check runs at declaration when the metric names its own cadence. A metric
taking `flush` from the house is checked when the house registers it, which is
still startup rather than the first flush.

[Buckets and time](/guide/buckets-and-time) covers how to choose the pair.

## Reading a duration back

Each parsed value is available in milliseconds, which is the form every
calculation uses.

```ts
httpRequests.resolutionMs   // 10000
httpRequests.flushMs        // 60000
httpRequests.graceMs        // 2000
queueDepth.holdForMs        // 300000, or undefined for a level that holds forever
```

Parsing happens once, at declaration. The write path does integer arithmetic
and never sees a string, which is why `add()` costs what it costs.

## Where the boundaries fall

Windows are aligned to the Unix epoch rather than to the moment your process
started. A `10s` window starts at `:00`, `:10`, `:20` and so on, so two servers
that booted minutes apart agree on every boundary with no coordination between
them.

```ts
const bucketTs = Math.floor(Date.now() / 10_000) * 10_000
```

That is the whole calculation. [Buckets and time](/guide/buckets-and-time)
covers what it means for late writes and for a fleet.

## Related

- [Buckets and time](/guide/buckets-and-time) for choosing resolution and flush
- [Flushing](/guide/flushing) for what a cadence does at run time
- [Configuration](/reference/configuration) for every setting in one table
