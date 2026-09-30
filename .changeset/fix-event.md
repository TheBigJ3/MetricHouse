---
'metrichouse': minor
---

Events, logs and timers:

- `timer.time()` returns a new promise when `fn` returns one, settled once the
  timing is recorded, instead of the caller's own promise. A handler on that
  promise hid a rejection nobody awaited, which is now reported as an unhandled
  rejection again.
- A timer dim may no longer be named `ts`, `_ingested_at` or `_sample_rate`, the
  columns a `record` event writes, so pairing a timer with an event later never
  invalidates it.
- `timer.start()` and `log.child()` mark as supplied only the keys the argument
  is sure to hold, so an object typed `Partial<...>` no longer lets `end()` or a
  line leave out a required value that then throws.
- `timer.start()`, `timer.time()` and a log's own `child()` copy the object they
  are given, so changing it afterwards moves nothing. `child()` on the log also
  drops a field passed as `undefined`, as a nested child already did.
- After a failed send, `record()` stops sending an event's backlog itself until
  `batch.maxAge` (local staging) or `flush` (driver staging) has passed. Every
  record used to hand a sink that was down the whole backlog again, with one
  `onError` report each. The age clock, `flush()` and `drain()` still send.
- New `batch.maxStaged` caps how many records a locally staged event or log
  holds, `100_000` by default or `maxSize` when larger. A record past it is
  refused and reported to `onError`.
- Under immediate delivery, a driver staged event with a `claimLimit` keeps
  claiming while a claim comes back full, so one send empties the backlog.
- A locally staged event also ships, and counts in `pending()`, records a
  `stage: 'driver'` declaration of it left in the driver.
- A staged record becomes a row under the current declaration: a default
  declared since fills a missing field, a record staged before `sample` carries
  `_sample_rate: 1`, text in a field now `json()` ships as JSON text, and a value
  the field no longer accepts throws, naming the record and the field.
- `house.drain()` waits for the counter writes a durable record derives, and
  derive reads the record as stored, with a fresh copy for each function.
- A failed ack after an immediate or local batch send reaches `onError`.
- `peek()`, `snapshot()` and sink rows of a locally staged event carry copies of
  `ts()` values.
- `stage: null` is refused at declaration instead of read as `'driver'`.
