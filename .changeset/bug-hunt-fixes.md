---
'metrichouse': minor
---

Fixes for data loss, wrong values and driver disagreements found by running
three test applications against both drivers.

**Data that could be lost or counted wrong**

- A write that reached storage after its window had shipped started a second
  copy of that window, with the same row id and only the late part of the
  value. A sink keeping one row per id lost the rest. Such a write now moves
  forward into the oldest window that has not shipped, on both drivers.
- `house.stop()` did not wait for a scheduled flush that was already writing.
  If that write failed, its rows went back to the driver after the final flush
  had looked, and nothing shipped them. `stop()` now waits, and its final flush
  also ships windows still inside grace.
- One `json()` value that JSON cannot hold, such as a BigInt, made the whole
  batch fail and vanish at flush. It now throws at `record()`, and the other
  records ship. A failure turning a claim into rows now releases the claim.
- `derive` incremented its counters before `record()` finished checking the
  record, so a call that threw still moved them. It now runs only after the
  whole call has passed, and all of one function's targets apply or none do.
- A level carried the first value written in a window into the empty windows
  after it, instead of the last. `inc(5)` then `dec(2)` carried 5.
- A level coming back from a gap longer than 10,000 windows resumed at the
  value from before the gap, ignoring a write inside it.
- A level `set()` that landed while a flush was expiring its series was erased.
- A `holdFor` that was not a whole number of windows shipped different rows
  depending on how flushes were spaced.

**Values that came back different from what went in**

- A numeric `oneOf` dim came back as a string, so a snapshot filter on it
  matched nothing. A `oneOf` whose members print the same now throws.
- The memory driver kept a reference to the object passed to `record()`, so
  changing it afterwards changed what shipped. Every driver now stores a copy.
- On Redis, a `json()` payload shaped like the driver's own date marker came
  back as a date.
- On Redis, float counters were rounded to seventeen decimal places, and a
  total past the largest double read back as NaN. Both drivers now add in plain
  doubles and refuse a write that would overflow.
- A dim named after an `Object.prototype` method, such as `constructor`, was
  treated as present when left out.
- A dim value holding half of a surrogate pair became U+FFFD on Redis and
  merged with other series. It now throws.
- A `Date` made in another realm was rejected by `ts()`.

**Reports, retries and reads**

- A failed acknowledgement after a successful write made `house.flush()` throw
  and skip the metrics after it. It is now reported as `ackError`, and a claim
  that fails is reported as `error`, with every other metric still flushed.
- `attempt` stayed at 1 on batch and immediate sends. It now counts
  consecutive failures across every path a metric ships through.
- A locally staged batch that failed was not retried on `maxAge`, and two
  failed batches went back out of order. Records released on either driver now
  return in the order they were staged.
- `event.snapshot()` ignored `orderBy` and `direction` and accepted any `limit`.
- `pending()` read zero while a sink held records in flight. It now counts them.
- `bucket_elapsed_ms` was added once per series under `groupBy`, and a gauge's
  merged `last` came from whichever series sorted last.
- `level.snapshot()` showed only written windows. It now shows the windows the
  next flush will carry, and `house.current()` shows a level's held value.
- The event write context could report `bucketTo` before `bucketFrom`.
- The first flush was skipped when the clock started near zero, a clock stepped
  back an hour blocked flushes for an hour, and a fractional clock made every
  write throw.
- `maxPipelineSize` was ignored for Lua scripts.

**Declaration and shutdown**

- A metric name may no longer contain a colon or whitespace. Two namespaces
  could otherwise share Redis keys: `org` with `e:checkout` and `org:e` with
  `checkout` both used `org:e:e:checkout`.
- A metric declared without `write` now throws at declaration.
- A log level named `snapshot`, `storage`, `record` or another logger property
  now throws instead of being hidden.
- A failed `createHouse` no longer leaves earlier metrics bound, and a schema
  module exporting one metric twice registers it once.
- `timer.end({ status: undefined })` no longer erases a dim bound at `start()`.
- The ioredis driver has `close()`, which closes a client it made from a
  factory, so a script using one can exit.

**Changes a custom driver has to make**

`dropLevels` takes a third argument, `writtenBefore`. `claim` has to remember
the highest watermark and move later writes below it forward. `countPending`
counts records in flight. `increment` and `observe` refuse totals that are not
finite. The [driver contract](https://github.com/TheBigJ3/MetricHouse/blob/main/docs/reference/driver-contract.md)
lists each rule, and the shared test suite checks them.

**Found by a second round of testing**

- `level.snapshot()` with a `to` in the future returned windows that had not
  started. It now stops at the open window.
- Level `current()` and `totals()` kept reporting a series past its `holdFor`
  until a flush removed it. They now leave it out from its first expired window.
- About one scheduler tick in twenty was turned away as a millisecond early,
  which made that metric wait a second interval. A call within fifty
  milliseconds of the cadence now counts as on time.
- `gauge.totals()` and `timer.totals()` overflowed the stack past about 124,000
  series, and `current()` and `totals()` broke when passed around on their own.
- `orderBy` on a column only some rows have, such as `last` after a `groupBy`,
  could throw or rank the missing rows first. They now go last.
- `groupBy: []` typed its rows as `never`.
- Immediate delivery sent nothing for a write that had been moved forward. It
  now sends the window the write landed in, and a failed immediate send from a
  counter, gauge, level or timer counts toward `attempt`.
- A Redis namespace may no longer contain a colon or whitespace. Namespace
  `org:idx` shared its `org:idx:seq` key with the index of a metric named `seq`
  in namespace `org`.
