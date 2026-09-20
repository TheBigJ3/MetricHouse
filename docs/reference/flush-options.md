# Flush options

A flush ships everything finished to a metric's own `write` function and settles
the claim. These are the arguments it takes and the report it gives back.

```ts
await httpRequests.flush()
await httpRequests.flush({ force: true })

await house.flush()
await house.flush({ force: true, only: ['http_requests'] })
```

## Where they are accepted

| Callable | Options | Returns |
| --- | --- | --- |
| `metric.flush(options?)` | [`force`](#force) | [`MetricFlushReport`](#the-metric-report) |
| `house.flush(options?)` | [`force`](#force), [`only`](#only) | [`FlushReport`](#the-house-report) |
| `house.stop()` | none, it forces | [`FlushReport`](#the-house-report) |

Every metric type takes the same options, whether it folds writes into windows
or keeps each record whole.

## The options

### force

```ts
force?: boolean      // default false
```

Ignores the cadence and ships everything finished right now.

```ts
await httpRequests.flush()               // respects flush: '5m'
await httpRequests.flush({ force: true })   // ships whatever is closed
```

`flush` is a floor rather than a schedule, so an ordinary call that arrives
early does nothing and says so in its report.

```ts
const report = await httpRequests.flush()
// { buckets: 0, rows: 0, skipped: true, reason: 'cadence', nextEligibleInMs: 41_200 }
```

Force is for the moments where the cadence is the wrong rule: a shutdown, a
test, a cron handler that runs once and will not come back.

What `force` does not do is ship the window that is still filling. That window
has not closed, and a partial fold carrying the same row id is the corruption
[`delivery: 'immediate'`](/guide/delivery) exists to handle. `house.stop()`
forces a flush for the same reason and has the same limit.

### only

```ts
only?: readonly string[]      // house calls only
```

Restricts the flush to the named metrics. Everything else is reported as
skipped with `reason: 'not-selected'`, so the report still lists every metric
the house holds.

```ts
await house.flush({ only: ['app_log', 'checkout_attempted'] })
```

Metrics still flush in registration order, one after another. The order is
sequential on purpose: forty metrics flushing at once into one database is a
burst nobody asked for. Use `metric.flush()` with `Promise.all` when you want
the concurrency.

## The metric report

`metric.flush()` resolves with a report rather than rejecting, because a flush
that fails has already released its claim. The data is safe, and you are being
told what happened.

```ts
const report = await httpRequests.flush()
```

| Field | Type | When it is there | Meaning |
| --- | --- | --- | --- |
| `buckets` | `number` | always | Windows in this shipment. `0` for an event or a log |
| `rows` | `number` | always | Rows handed to `write` |
| `skipped` | `boolean` | always | Whether anything was attempted |
| `reason` | `'cadence'` or `'not-selected'` | when skipped | Why nothing was attempted |
| `nextEligibleInMs` | `number` | when skipped on cadence | How long until this metric may ship again |
| `error` | `unknown` | when the sink threw | What your `write` function threw. The rows are back in the live set |
| `recovered` | `RecoveryReport` | when a dead flusher left a claim | What this flush put back before claiming |
| `recoveryError` | `unknown` | when recovery itself failed | The flush below it still ran |

```ts
if (report.error) {
  logger.error({ err: report.error }, 'flush failed, rows will retry')
}
if (report.recovered) {
  logger.warn({ recovered: report.recovered }, 'a previous flusher died holding a claim')
}
```

An empty flush leaves the cadence clock untouched. Nothing shipped, so nothing
should count as a shipment, and data that closes a second later does not have
to wait a full interval for the next one.

## The house report

```ts
const report = await house.flush()
```

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `boolean` | `false` when any metric reported an error |
| `durationMs` | `number` | How long the whole fan out took |
| `metrics` | `Record<string, MetricFlushReport>` | One report per metric, keyed by name |
| `throwIfFailed()` | `() => void` | Throws naming every metric that failed |

```ts
const report = await house.flush()
report.metrics.http_requests.rows      // 42
report.metrics.app_log.skipped         // true

// For a cron handler that would rather have an exception than a report.
report.throwIfFailed()
```

`throwIfFailed()` is there for a scheduled job whose platform decides what to
retry from the status code. Reading the report field by field is the other
half of the same choice.

## What a flush does

```
cadence -> recover -> claim -> materialise -> write -> ack or release
```

| Step | What happens |
| --- | --- |
| Cadence | An early call returns `skipped: true` unless `force` says otherwise |
| Recover | A claim a previous flusher died holding is merged back, so this flush can ship it |
| Claim | Finished data leaves the live set atomically, so a second flusher cannot take it |
| Materialise | The claim becomes the rows your `write` function receives |
| Write | Your function runs. Throwing means the rows come back |
| Settle | Success deletes the claimed data, failure returns it with `attempt` raised |

[Flushing](/guide/flushing) walks through the same path with examples, and
[Reliability](/guide/reliability) covers what each step guarantees.

## Related

- [Flushing](/guide/flushing) for cadence, schedulers and cron
- [Writing a sink](/guide/writing-a-sink) for the function a flush calls
- [Delivery modes](/guide/delivery) for shipping without waiting for a flush
- [The house](/guide/the-house) for `start()`, `stop()` and the fan out
