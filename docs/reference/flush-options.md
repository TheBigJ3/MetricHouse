# Flush options

A flush ships everything finished to a metric's own `write` function and settles
the claim. These are the arguments it takes and the report it gives back.

```ts
await httpRequests.flush()
await httpRequests.flush({ force: true })
await httpRequests.flush({ final: true })

await house.flush()
await house.flush({ force: true, only: ['http_requests'] })
```

## Where they are accepted

| Callable | Options | Returns |
| --- | --- | --- |
| `metric.flush(options?)` | [`force`](#force), [`final`](#final) | [`MetricFlushReport`](#the-metric-report) |
| `house.flush(options?)` | [`force`](#force), [`final`](#final), [`only`](#only), [`strict`](#strict) | [`FlushReport`](#the-house-report) |
| `house.stop()` | none, it passes `final` itself | [`FlushReport`](#the-house-report) |

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

On a shared driver, a forced flush that writes rows still records the metric's
turn, so the other processes count their next interval from it. See
[Several processes on one driver](/guide/flushing#several-processes-on-one-driver).

What `force` does not do is ship the window that is still filling. That window
has not closed, and a partial fold carrying the same row id is the corruption
[`delivery: 'immediate'`](/guide/delivery) exists to handle. The final flush
`house.stop()` makes has the same limit.

Nor does `force` skip [grace](/primitives/counter#grace). A window that ended a
second ago is still held back, in case a write stamped inside it has not reached
storage yet.

### final

```ts
final?: boolean      // default false
```

The last flush this process will make. It ignores this process's own cadence,
as `force` does, and it also ships windows that have ended but are still inside
grace.

On a driver that is shared and durable, such as `ioredis()`, it still waits for
the metric's [turn](/guide/flushing#several-processes-on-one-driver). A final
flush another process beat to it reports `skipped: true` with
`reason: 'cadence'`, and leaves its rows in storage for whichever process takes
the next turn. Pass `force` as well to ship them now whatever the turn says.
On a driver that is shared but not durable, a final flush takes the turn at
once, since nothing else may be left to ship its rows.

```ts
await house.drain()
await house.flush({ final: true })   // everything but the open window
```

Grace waits for writes that are still on their way to storage. A process that
is shutting down has drained its own writes already, so there is nothing left
of its own to wait for. Another instance may still send a write for one of
those windows, and that write is moved forward into a window that has not
shipped rather than lost
([Buckets and time](/guide/buckets-and-time#a-write-that-misses-its-window)).

A final flush also keeps claiming until the backlog is empty, for a metric with
a [`claimLimit`](/primitives/event#claimlimit) that ships a backlog across
several claims. It stops after a hundred claims, so a process that is stopping
does not chase records another instance is still adding.

`house.stop()` passes `final` for you. Pass it yourself only in a shutdown path
that does not go through `stop()`, and call `drain()` first.

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

A name that matches no registered metric flushes nothing, and the report lists
it in [`unmatched`](#the-house-report), so a typo shows up there rather than as
a metric that seems quiet.

```ts
const report = await house.flush({ only: ['app_log', 'chekout_attempted'] })
report.unmatched   // ['chekout_attempted']
```

The call does not throw for it, because a metric can be registered later with
[`house.register()`](/guide/the-house#registering-metrics), and a name for a
metric that has not arrived yet is not a mistake. Pass [`strict`](#strict) when
it is.

### strict

```ts
strict?: boolean      // default false, house calls only
```

Rejects the call before anything is flushed when `only` names a metric the
house does not hold.

```ts
await house.flush({ only: ['app_log', 'chekout_attempted'], strict: true })
// Error: house.flush: only names "chekout_attempted", which is not a registered
// metric. The registered metrics are [app_log, checkout_attempted]
```

Several unmatched names are all named, and a house with nothing registered says
`None is registered`. Without `only`, `strict` has nothing to check.

## The metric report

`metric.flush()` resolves with a report rather than rejecting, because a flush
that fails has already released its claim. The data is safe, and you are being
told what happened. That holds for a driver that cannot be reached as well: the
claim fails, nothing leaves storage, and the report carries the error.

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
| `error` | `unknown` | when the flush shipped nothing it meant to | What your `write` function threw, or why taking the turn or the claim failed. The rows are back in the live set, or never left it. A `write` that rejects with no reason, as `Promise.reject()` does, reports `Error: <metric>: the sink rejected without a reason` |
| `releaseError` | `unknown` | when the write failed and putting the rows back failed too | `error` still holds what `write` threw. The rows are held in the claim rather than back in the live set, where a durable driver's recovery returns them once `recoverAfter` has passed |
| `ackError` | `unknown` | when the rows were written and the claim could not be settled | The rows did ship. Another flusher had usually recovered the claim first, so the same rows, with the same ids, will arrive again |
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

`ackError` is the one failure that sits beside a success. The rows reached your
`write` function and it returned, so they count as shipped and the cadence moves
on. If it shows up often, `recoverAfter` on the
[ioredis driver](/guide/drivers) is shorter than your sink takes to write.

## The house report

```ts
const report = await house.flush()
```

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `boolean` | `false` when any metric reported an `error`. An `ackError` alone leaves it `true` |
| `durationMs` | `number` | How long the whole fan out took |
| `metrics` | `Record<string, MetricFlushReport>` | One report per metric, keyed by name |
| `unmatched` | `string[]` | The names in [`only`](#only) that matched no registered metric, each once, in the order given. Empty when all matched or there was no `only` |
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
cadence -> turn -> recover -> claim -> materialise -> write -> ack or release
```

| Step | What happens |
| --- | --- |
| Cadence | An early call returns `skipped: true` unless `force` or `final` says otherwise |
| Turn | On a shared driver, the metric's turn is taken from the driver. A call another process beat to it returns `skipped: true`. A flush that writes nothing gives the turn back |
| Recover | A claim a previous flusher died holding is put back, so this flush can ship it |
| Claim | Finished data leaves the live set atomically, so a second flusher cannot take it. `final` counts a window inside grace as finished |
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
