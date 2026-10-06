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

For these, immediate delivery **replaces** flushing while the sink succeeds.
Each send takes every record waiting. With a
[`claimLimit`](/primitives/event#claimlimit), an event staged in the driver
claims again while a claim comes back full, so one send still empties the
backlog.

When a send fails, its records go back to where they were staged, and
`record()` stops sending for a while, so a sink that is down is not handed the
whole backlog again by every new record. A locally staged event holds back for
`batch.maxAge` after the failure, and its age clock retries everything then on
its own. An event staged in the driver holds back for its
[`flush`](/primitives/event#flush) interval and has no timer of its own: its
records wait until a flush claims them, or until the first `record()` after the
interval sends them together with the new one. An event that can go quiet after
a failure still wants a flush on a schedule, and `house.stop()` makes a final
one.

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

::: danger Your table must upsert on id, and let the flush row win
Under immediate delivery, a folded row is a running total that a later send
replaces. A table that adds up duplicate ids will badly over count, and one that
keeps whichever row arrived last can end on an older total than the flush row.
The house warns about this once at startup through `onWarn`.
:::

In ClickHouse that means `ReplacingMergeTree`. In Postgres it means
`ON CONFLICT (id) DO UPDATE`.

### Flushing is still required for folded metrics

Immediate delivery does not retire finished windows. A counter still needs
`flush()` from a timer, a cron or a direct call so that closed windows are
claimed and deleted, otherwise they pile up in the driver forever.

The flush sends the same id with the complete value, so it supersedes every
partial send, as long as your table lets it. An immediate send reads the running
total and then calls your function, and a flush can claim the window in
between. Within one process the flush waits for the immediate sends already
under way for that metric that could have read a window it claimed, so its row
reaches your function after theirs. Sends that start after the claim cannot
read the claimed window, and a send aimed at a window newer than every one the
flush claimed reads none of them, so neither is waited for.

The wait for a send lasts until one `flush` interval after that send started.
A `write` function that never answers an immediate send would otherwise hold
up every flush of the metric. When the interval runs out, the flush hands its
rows over anyway, and no later flush waits for that send again. The send still
waiting may then reach your function after the flush row, with an older total
under the same id, exactly as a send from another process can. The table below
keeps the flush row in that case.

That limit belongs to the flush alone. [`drain()`](/guide/the-house#drain) and
[`house.stop()`](/guide/the-house#starting-and-stopping) wait for every immediate send already
under way, with no limit, so a `write` function that never answers keeps them
waiting for ever. Give your `write` function a timeout of its own, as
[Writing a sink](/guide/writing-a-sink#in-production) shows.

Across processes nothing can order the two. Another process may read its running
total just before the claim and deliver it just after the flush row. So your
table has to let a row whose `source` is `'flush'` win over an `'immediate'` row
with the same id, whichever arrives last. [Telling the two apart in your
sink](#telling-the-two-apart-in-your-sink) shows one way.

A write that arrived after its window was claimed is
[moved forward](/guide/buckets-and-time#a-write-that-misses-its-window) to a
window that has not shipped, and the immediate send follows it. Once this
process has claimed the window the write aimed at, or when that window reads
back empty, the send asks the driver which window the write landed in, and
sends every live window of that series from the one the write aimed at through
that one. A window a failed flush of this process released can sit in front of
the landing window, or be the aimed window itself, and the landing window is
still sent. Otherwise the send reads the aimed window alone, which saves a
driver call on nearly every write. The one case it misses is a window another
process claimed and then put back, after a failed flush or a recovery: a write
aimed there is moved forward and the send carries only the window it aimed at.
The flush ships the landing window with its full value either way. A failed
send counts toward `attempt` exactly as a failed flush does.

With several processes writing to one Redis, each of them sends the running
total it read, and two immediate sends can arrive at your table in either order.
A table that keeps whichever row arrived last can briefly hold an older total. Rows
carry no version number to settle that. What settles it is the flush row, which
holds the complete value, provided your table keeps it over any immediate row
that arrives after it.

| | Events and logs | Counters, gauges, timers |
| --- | --- | --- |
| Immediate delivery replaces flush | Yes | No |
| Still need to call flush | Only to retry a failed send of a driver staged event | Yes, to retire finished windows |
| Rows are deleted after sending | Yes | Only by a flush |
| Duplicate ids in your table | No | Yes, upsert on `id` and keep the flush row |

## Telling the two apart in your sink

`context.source` says which path a call came from. Under immediate delivery a
folded metric's flush row carries the id its immediate rows already used, so
every source is an upsert on `id`. The table also records whether the row it
holds came from a flush, and an immediate row never replaces one that did.

```sql
CREATE TABLE http_requests (
  id         TEXT PRIMARY KEY,
  bucket_ts  TIMESTAMPTZ NOT NULL,
  route      TEXT NOT NULL,
  value      BIGINT NOT NULL,
  final      BOOLEAN NOT NULL
);
```

```ts
write: async (rows, context) => {
  // true for a flush row, which holds the window's complete value
  const final = context.source === 'flush'
  await sql`
    INSERT INTO http_requests ${sql(
      rows.map((row) => ({ ...row, final })),
      'id', 'bucket_ts', 'route', 'value', 'final',
    )}
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, final = EXCLUDED.final
    WHERE EXCLUDED.final OR NOT http_requests.final
  `
}
```

The `WHERE` on the update is what lets the flush row win. A later immediate row
for the same id finds `final` set and changes nothing, and a flush resent after
a failed acknowledgement replaces the row with the same value.

| `source` | When | What your table should do |
| --- | --- | --- |
| `'flush'` | A normal flush | Upsert on `id`. Under immediate delivery it replaces the running totals sent before it, and keeps its place against any that arrive after it |
| `'batch'` | A locally staged event shipped itself | Insert, or upsert on `id`. A duplicate is an identical retry |
| `'immediate'` | Immediate delivery | Upsert on `id`, unless the row held came from a flush |

## Choosing

| Situation | Delivery |
| --- | --- |
| A server that stays running, any driver | `'staged'` |
| Serverless or edge with a shared driver | `'staged'`, flushed from a cron |
| Serverless or edge with `memory()` | `'immediate'`, and events only: each isolate's counter total overwrites the others' |
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
A counter, gauge, level or timer that declares no `flush` and is registered with a house
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
import { Redis } from 'ioredis'
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
