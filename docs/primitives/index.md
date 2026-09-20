# Metric types

There are six. Pick by the question you want to answer later.

| Type | Answers | Storage | Write with | Read with |
| --- | --- | --- | --- | --- |
| [`counter`](/primitives/counter) | How many times did this happen | Folded | `add()` | `current()`, `snapshot()` |
| [`gauge`](/primitives/gauge) | What was this value when we looked | Folded | `set()` | `current()`, `totals()`, `snapshot()` |
| [`level`](/primitives/level) | What is this value now, and what was it in between | Folded | `set()`, `inc()`, `dec()` | `current()`, `totals()`, `snapshot()` |
| [`timer`](/primitives/timer) | How long did this take | Folded | `time()`, `start()`, `observe()` | `current()`, `totals()`, `snapshot()` |
| [`event`](/primitives/event) | What exactly happened, with all the detail | Kept whole | `record()`, `recordMany()` | `pending()`, `peek()`, `snapshot()` |
| [`log`](/primitives/log) | What did the application say, and how serious was it | Kept whole | `info()` and one method per level | `pending()`, `peek()`, `snapshot()` |

## Choosing one

**Are you tallying occurrences?** Use a [`counter`](/primitives/counter).
Requests served, errors, signups, emails sent, bytes transferred, money taken.

**Are you sampling a value, and do you want the spread of your readings?** Use a
[`gauge`](/primitives/gauge). Users online, cache hit ratio, temperature, disk
usage.

**Does the value hold between the times you write to it?** Use a
[`level`](/primitives/level). Queue depth, requests in flight, connections
checked out of a pool. A gauge leaves a hole in every window nobody wrote to,
and a level carries the last value in.

**Are you measuring how long something took?** Use a
[`timer`](/primitives/timer). It is a gauge of durations with the clock
handling built in.

**Do you need per item detail you cannot label?** Use an
[`event`](/primitives/event). A user id, a request id, a free text note, a JSON
payload. Anything unique per occurrence.

**Are you writing application messages with a severity?** Use a
[`log`](/primitives/log). It is an event with a level, a filter and a bound
child logger.

## Shared arguments

Four arguments appear on more than one type, and each has a page of its own.

| Argument | On | Page |
| --- | --- | --- |
| `dims` | counter, gauge, level, timer | [dims](/reference/dims) |
| `fields` | event, log | [fields](/reference/fields) |
| `resolution`, `flush`, `grace`, `holdFor`, `batch.maxAge` | every type that takes a time | [Durations](/reference/durations) |
| `snapshot(options)` | every type | [Snapshot options](/reference/snapshot-options) |
| `flush(options)` | every type | [Flush options](/reference/flush-options) |
| `write` | every type | [Writing a sink](/guide/writing-a-sink) |

The declaration settings each type takes, side by side:

| Setting | counter | gauge | level | timer | event | log |
| --- | --- | --- | --- | --- | --- | --- |
| `dims` | yes | yes | yes | yes | | |
| `fields` | | | | | required | yes |
| `resolution` | required | required | required | required | | |
| `flush` | yes | yes | yes | yes | yes | yes |
| `grace` | yes | yes | yes | yes | | |
| `value` | `int()` | | `float()` | | | |
| `aggregate` | | five | | four | | |
| `holdFor` | | | yes | | | |
| `record` | | | | yes | | |
| `stage`, `batch`, `claimLimit` | | | | | yes | yes |
| `timestamp`, `sample`, `derive` | | | | | yes | |
| `levels`, `minLevel` | | | | | | yes |
| `write` | required | required | required | required | required | required |

[Configuration](/reference/configuration) has the same information as one table
per type, with defaults.

## Shared members

Every metric, whatever it measures, carries these.

```ts
metric.name
metric.kind          // 'counter' | 'gauge' | 'level' | 'event' | 'log' | 'timer'
metric.storage       // 'bucketed' | 'staged'
metric.flushMs
metric.isBound
metric.rowShape()    // the exact columns your sink will receive
metric.snapshot()    // unshipped rows
metric.flush()       // ship now, if the cadence allows
metric.drain()       // wait for queued writes to reach the driver
```

[Every metric](/reference/#every-metric) in the API index lists them with
types.

## Folded against kept whole

<figure class="mh-figure">
  <img src="/diagrams/two-storage-models.svg" alt="Folded storage adds writes together into one number. Kept whole storage queues each record separately." />
  <figcaption>The split that explains most of the behaviour you will meet.</figcaption>
</figure>

**Folded** types combine writes into one value per time window. Memory use
depends on how many label combinations you have rather than on how much traffic
you get, so a thousand increments in one second become one row.

A level folds too, and differs in one way worth knowing before you pick it: it
writes a row for every window whether or not anything happened, because a held
value is only useful if it is there in the windows nobody touched.

**Kept whole** types keep every record. Memory use grows with traffic until the
records ship, which is why they have batching settings and a backlog you can
query.

```ts
requests.storage   // 'bucketed'
signups.storage    // 'staged'
```

## Using two together

Counters and events are complementary, and the common pattern is to write both.

```ts
const checkouts = counter('checkouts', {
  dims: { plan: oneOf(['free', 'pro', 'team']), outcome: oneOf(['paid', 'failed']) },
  resolution: '1m',
  flush: '1m',
  write: toClickHouse('checkouts'),
})

const checkoutAttempted = event('checkout_attempted', {
  fields: {
    userId: str(),
    plan: oneOf(['free', 'pro', 'team']),
    outcome: oneOf(['paid', 'failed']),
    amountCents: int(),
    failureReason: str().optional(),
  },
  flush: '1m',

  // Every event also increments the counter. No second write path to forget.
  derive: {
    checkouts: (fields) => ({ dims: { plan: fields.plan, outcome: fields.outcome } }),
  },

  write: toClickHouse('checkout_attempted'),
})
```

The counter stays small and is fast to query for charts. The event holds the
detail you need when a number looks wrong. [`derive`](/primitives/event#derive)
keeps them consistent, and runs before sampling, so the counter stays exact
even when the event table only keeps a slice.

The same pairing for durations is a timer with
[`record`](/primitives/timer#record).

## Things that are deliberately missing

**No histogram.** Percentiles are a query over rows you already have. Record the
values to an [event](/primitives/event) and write `quantile(0.95)(duration_ms)`.

**No average on a gauge.** It stores `sum` and `count`. An average cannot be
merged across windows, so storing it would produce wrong numbers when two
windows are combined. `sum / count` is exact and one division away.

**No `set` and no `distinct`.** Counting unique users is not implemented yet.
Record a `userId` to an event and use `uniq()` in your query.
