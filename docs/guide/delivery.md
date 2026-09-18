# Delivery modes

Delivery decides *when* rows leave for your database. It is a house setting
rather than a metric setting, because it describes your deployment rather than
what you are measuring. The same schema file runs on a laptop against `memory()`
and in production against Redis, and only one of those has a reason to hold data
back.

```ts
const house = createHouse({
  driver,
  schema,
  delivery: 'staged',     // 'staged' | 'immediate' | 'auto'
})
```

## The two modes

<figure class="mh-figure">
  <img src="/diagrams/delivery-modes.svg" alt="Staged delivery holds data in the driver until flush. Immediate delivery sends it as soon as it arrives." />
  <figcaption>Staged waits for a flush. Immediate does not.</figcaption>
</figure>

### staged, the default

Writes go into the driver and stay there. A flush claims the finished windows and
hands them over. Your `write` function sees each window exactly once, with its
final value.

This is what you want almost always.

### immediate

Rows go to your `write` function as the data arrives, without waiting for a
flush. Use it when the driver cannot be trusted to hold data, which in practice
means a memory driver on a platform that can freeze or discard your process at
any moment.

```ts
const house = createHouse({ driver: memory(), schema, delivery: 'immediate' })
```

### auto

Asks the driver. If the driver cannot survive a restart, holding data back puts
it at risk for no benefit, so `auto` chooses `immediate`. Otherwise it chooses
`staged`.

```ts
const house = createHouse({ driver, schema, delivery: 'auto' })

house.delivery   // 'staged' or 'immediate', already resolved
```

| Driver | `'auto'` resolves to |
| --- | --- |
| `memory()` | `'immediate'` |
| `ioredis()` | `'staged'` |

## What immediate does to each metric type

The two storage styles behave differently here, and the difference is not
cosmetic.

### Events and logs

A record is complete the instant you write it, so immediate delivery claims it
and ships it exactly as a flush would, just without waiting. Records leave the
driver and are deleted normally.

For these, immediate delivery **replaces** flushing.

### Counters, gauges and timers

A window that is still filling is not complete. Immediate delivery sends the
**cumulative** value of the open window and deletes nothing, so each send carries
a running total that supersedes the one before it.

```
add()  ->  write [{ id: 'abc', value: 1 }]
add()  ->  write [{ id: 'abc', value: 2 }]
add()  ->  write [{ id: 'abc', value: 3 }]
```

Same id every time, with a larger value. That is why it has to be cumulative:
the row id is derived from the metric, the window and the dimension values, and
deliberately not from the value. Sending one row per increment would mint the
same id three times with `value: 1`, and a table that keeps the last write would
end up believing the answer was one.

::: danger Your table must keep the newest row per id
Under immediate delivery, a folded row is a running total that a later send
replaces. A table that adds up duplicate ids rather than keeping the newest will
badly over count. The house warns about this once at startup through `onWarn`.
:::

In ClickHouse that means `ReplacingMergeTree`. In Postgres it means
`ON CONFLICT (id) DO UPDATE`.

### Flushing is still required for folded metrics

Immediate delivery does not retire finished windows. A counter still needs
`flush()` from a timer, a cron or a direct call so that closed windows are
claimed and deleted, otherwise they pile up in the driver forever.

The final flush sends the same id with the complete value, so it supersedes every
partial send. The two paths agree rather than fight.

| | Events and logs | Counters, gauges, timers |
| --- | --- | --- |
| Immediate delivery replaces flush | Yes | No |
| Still need to call flush | No | Yes, to retire finished windows |
| Rows are deleted after sending | Yes | Only by a flush |
| Duplicate ids in your table | No | Yes, keep the newest |

## Telling the two apart in your sink

`context.source` says which path a call came from.

```ts
write: async (rows, context) => {
  if (context.source === 'immediate') {
    // A running total. Upsert, keeping the newest.
    await upsert(rows)
    return
  }

  // 'flush' or 'batch'. Send once, and a resend is byte identical.
  await insert(rows)
}
```

| `source` | When | What your table should do |
| --- | --- | --- |
| `'flush'` | A normal flush | Insert. A duplicate is an identical retry |
| `'batch'` | A locally staged event shipped itself | Insert |
| `'immediate'` | Immediate delivery | Keep the newest row per id |

## Choosing

| Situation | Delivery |
| --- | --- |
| A server that stays running, any driver | `'staged'` |
| Serverless or edge with a shared driver | `'staged'`, flushed from a cron |
| Serverless or edge with `memory()` | `'immediate'` |
| Not sure, and you want the safe default | `'auto'` |
| You want rows in your database within a second | `'immediate'` |

Immediate delivery costs one extra read and one write call per write you make. It
reads only the series that changed, so the cost scales with how often you write
rather than with how many distinct label combinations the metric has. It is still
a call to your database per application write, so treat it as a deliberate
trade rather than a default.

## Defaults for a whole house

Alongside delivery, a house can supply the cadence and grace that metrics use
when they declare none.

```ts
const house = createHouse({
  driver,
  schema,
  defaults: { flush: '1m', grace: '5s' },
})
```

```ts
// Takes flush: '1m' and grace: '5s' from the house.
const requests = counter('requests', {
  resolution: '10s',
  write: toClickHouse('requests'),
})

// Keeps its own, whatever the house says.
const payments = counter('payments', {
  resolution: '1s',
  flush: '5m',
  write: toClickHouse('payments'),
})
```

Defaults are filled in, never overridden. Delivery mode is the one thing a house
decides outright, because "this platform cannot flush" is a fact about the
deployment that a schema file has no standing to argue with.

::: tip A metric with no cadence anywhere is an error
A counter, gauge or timer that declares no `flush` and is registered with a house
that supplies no `defaults.flush` throws at startup. Events and logs fall back to
`'30s'`, since they have no resolution for a cadence to divide.
:::

## In production

The pattern that covers most deployments:

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import { ioredis } from 'metrichouse/ioredis'
import Redis from 'ioredis'
import * as schema from './schema.js'

const useRedis = Boolean(process.env.REDIS_URL)

export const house = createHouse({
  driver: useRedis ? ioredis(() => new Redis(process.env.REDIS_URL!)) : memory(),

  // Redis can hold data safely, so wait for a flush. Memory cannot, so ship now.
  delivery: 'auto',

  schema,
  defaults: { flush: '1m', grace: '5s' },
  onWarn: (message) => logger.warn({ message }, 'metrichouse'),
  onError: (error, { metric }) => logger.error({ err: error, metric }),
})

logger.info({ delivery: house.delivery }, 'metrics ready')
```

Log `house.delivery` at startup. It is a single line that tells you, during an
incident, whether your rows should be arriving continuously or in batches.
