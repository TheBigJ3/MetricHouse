# Timer

A timer measures how long something took and folds each duration into a [gauge](04-gauge.md). It adds no storage model: [23-patterns.md](23-patterns.md) already settled that a completed duration is one observation, on a gauge for min/max/mean and on an [event](05-events.md) for percentiles. What a timer owns is the part everyone writes by hand and gets subtly wrong — the start timestamp, the `finally`, and a clock that can run backwards.

> Added after the log primitive, from a proposal to link `metric.start()` and `metric.end()` implicitly by call stack. That cannot work — see [Why a handle](#why-a-handle).

## Main functions

**Declaration**
- `timer(name, config)`

Config fields:
- `dims`, `resolution`, `flush`, `grace`, `write` — same as [gauge](04-gauge.md)
- `aggregate` — default `['min','max','sum','count']`; the gauge's five minus `last`, which is arbitrary for a duration — of many operations finishing in one bucket, the last to finish is not the latest state of anything
- `record` — name of an event every timing is also recorded to, for percentiles; resolved lazily like a `derive` target

**Write**
- `.start(dims?)` → handle — bind whatever dims are known now
- `handle.end(dims?)` → `number` — supply the rest, record, return milliseconds
- `handle.elapsed()` → `number` — without ending
- `.time(dims?, fn)` — time a sync or async function, return what it returns
- `.observe(ms, dims?)` — a duration measured elsewhere

**Read** — unflushed data only
- `.current(dims?)`, `.totals()` — as gauge

**Introspection**
- `.rowShape()` — a gauge row

## Why a handle

`start()` returns the timing's state instead of filing it somewhere for `end()` to find. Every implicit alternative fails on a server:

- **Call stacks** cannot tell two concurrent requests apart. Dispatched from one call site they are byte-identical, and past an `await` the frames that led there are gone. Capturing one also costs ~2–3.5µs against ~5ns for anything else.
- **A LIFO stack** is wrong the moment two timings overlap without nesting — two parallel fetches in one request.
- **Matching on dims** confuses two concurrent requests to the same route.
- **`AsyncLocalStorage`** does propagate correctly, but a free-floating `start()` needs `enterWith()`, which leaks context past the `end()`; EventEmitter listeners silently run in the wrong context; and `node:async_hooks` cannot be imported by `metrichouse/core`, which must ship to an edge bundle.

A handle needs no registry, so it cannot leak. Abandoning one *is* cancelling it. It works on every runtime, and anyone who wants implicit linking can put the handle in their own async context — that composes, and the reverse does not.

## Semantics worth knowing

**`end()` is idempotent.** A second call records nothing and returns the first duration. Throwing would be louder, but `end()` lives in `catch` and `finally`, where a throw replaces the error being handled.

**A failed `end()` leaves the handle open.** Incomplete or invalid merged dims throw and record nothing, so a corrected call still ends it.

**`time()` records failures.** The duration is recorded whether `fn` returns or throws, and the error is rethrown unchanged — a request that times out after 30 seconds is the latency most worth seeing. Everything `time()` can reject — an unbound timer, invalid dims — is checked *before* `fn` runs, never after the work has happened. Split by outcome with a dim on `start()`/`end()`.

**Two clocks.** The duration comes from `performance.now()`, which is monotonic; `Date.now()` can step backwards under NTP. The bucket comes from the house clock at `end()`, so a timing lands where it *completed*. Durations are rounded to the microsecond — finer digits are scheduler jitter.

**On Cloudflare Workers**, `performance.now()` only advances across I/O. A timer there measures I/O-bound work and reads pure CPU work as zero.

**`duration_ms` is a reserved dim name** whether or not `record` is set, so adding `record` later can never invalidate a declaration that used to work.

## Percentiles: `record`

The gauge answers min/max/mean, live. For p95 name an event; the timer records `{ ...dims, duration_ms }` to it on every timing.

The pairing is checked at the first timing, with an error that says what is wrong with the pair rather than the event's generic "unknown field": the target must be an event, declare `duration_ms: float()` (an `int()` would reject fractional milliseconds), declare every timer dim, and require nothing else. A broken pairing is reported through `onError` and the gauge still records — a misconfigured detail table must not turn a recorded timing into a thrown one.

The event keeps its own staging, sampling and sink, so the gauge stays exact while the event table holds a sampled slice. That is the same split `derive` makes.

## In use

```ts
// metrics/schema.ts
import { event, float, oneOf, str, timer } from 'metrichouse'

export const checkoutLatency = timer('checkout_latency', {
  dims: { route: str(), status: oneOf(['ok', 'error']) },
  resolution: '10s',
  flush: '1m',
  record: 'checkout_latency_events',
  write: async (rows) => ch.insert('checkout_latency', rows),
})

// the whole declaration is a spread
export const checkoutLatencyEvents = event('checkout_latency_events', {
  fields: { ...checkoutLatency.dims, duration_ms: float() },
  sample: 0.1,
  write: async (rows) => ch.insert('checkout_latency_events', rows),
})
```

```ts
// scoped — cannot leak, cannot mis-pair
const order = await checkoutLatency.time({ route: '/checkout', status: 'ok' }, () =>
  placeOrder(cart),
)

// a handle, when the outcome is only known at the end
const span = checkoutLatency.start({ route: '/checkout' })
try {
  const order = await placeOrder(cart)
  span.end({ status: 'ok' })
  return order
} catch (error) {
  span.end({ status: 'error' })
  throw error
}

await checkoutLatency.current({ route: '/checkout', status: 'ok' })
// -> { last: 181.2, min: 94.7, max: 412.9, sum: 2804.1, count: 14 }
```

Row handed to `write()`:

```ts
{
  id: '7b2e…',
  bucket_ts: 2026-09-16T14:03:10Z,
  route: '/checkout',
  status: 'ok',
  min: 94.7, max: 412.9, sum: 2804.1, count: 14,
}
```

```sql
-- mean latency, merged correctly across any window
SELECT toStartOfMinute(bucket_ts) AS m, sum(sum) / sum(count) AS mean_ms, max(max) AS max_ms
FROM checkout_latency GROUP BY m;

-- p95 from the sampled detail
SELECT quantile(0.95)(duration_ms) FROM checkout_latency_events WHERE route = '/checkout';
```
