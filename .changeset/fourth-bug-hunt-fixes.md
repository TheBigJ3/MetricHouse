---
'metrichouse': minor
---

Fixes from a fourth round of bug hunting.

**A metric that stopped shipping**

- Adding a dim at the end of a declaration, which the docs call safe, made
  every flush and every snapshot of that metric fail while windows written
  before the change were still in the driver. A claim takes every closed
  window, so nothing shipped until someone deleted those keys by hand. A key
  with fewer values than the declaration names now reads the dims it has no
  value for as absent, and those series ship with the new dim left off the
  row. A key with more values than dims, left by a removed dim, still throws.
  A metric that had no dims and gains some reads its old series with every
  new dim left off, where a first `int()`, `bool()` or `ts()` dim read back as
  `0`, `false` or the epoch. The one case that cannot be told apart is a
  single `str()` dim, or a `oneOf()` listing `''`, which reads it as `''`.
  A level ships a series held from before the change for the windows it was
  written in and no further, so it no longer appears in every later window,
  or in `current()` and `totals()`, beside the series that replaced it.

**Failures that were silent or permanent**

- An `async` client factory for `ioredis()` that rejected once was kept as the
  answer, so every write and flush failed for the rest of the process. Every
  call waiting on the failed attempt now gets its error, and the next call asks
  the factory again.
- `maxPipelineSize: NaN`, which `Number()` gives for an environment variable
  that is not set, made `ioredis()` send no command at all while every write
  reported success. It now throws when the driver is created, as does any
  value that is not a positive whole number, including `0` and fractions that
  were rounded before.
- A `maxPipelineSize` past about 125,000 overflowed the stack when the replies
  of one round trip came back.
- A locally staged event with a `claimLimit`, whose sink threw rather than
  returning a rejected promise, sent its first batch twice on `drain()` and
  never offered the records behind it. Every record is now offered once.
- `house.stop()` waited only for flushes its own timers had started. A cron's
  `house.flush()`, or a direct `metric.flush()`, still inside its sink when
  `stop()` began made its final flush find nothing, and if that sink then
  failed, its rows went back to the driver after `stop()` had returned. On
  `memory()` they were lost when the process exited. `stop()` now waits for
  every flush still running, including one started while it waits, before its
  final flush, which ships what they put back.
- A second `house.stop()` made while the first was still running, from a
  `SIGINT` and a `SIGTERM` handler both, made a final flush of its own that
  found everything claimed by the first, and could resolve with nothing
  shipped before the first had finished. It now returns the same promise as
  the first call. After a `house.start()` in between, it clears the timers
  that start set and runs its own steps once the first call has finished.
- A name in `only` that matched no metric, a typo for one, made
  `house.flush()` and `house.snapshot()` do nothing for it and say nothing.
  The flush report now lists such names in a new `unmatched` field, and
  `strict: true` on either call rejects before anything runs, naming them and
  the metrics the house holds. Without `strict` nothing throws, since a metric
  registered later with `house.register()` is a legitimate name.

**Values that read back wrong**

- On `memory()`, `gauge.current()` and `timer.current()` returned the stored
  fold itself, so editing the result changed the row a later flush shipped.
  Reads now hand out copies, as Redis does.
- `level.totals()` on a level declared `value: int()`, and a snapshot that adds
  its series together, could pass `Number.MAX_SAFE_INTEGER` and return a
  different whole number. Both now reject, as a counter does.
- A nested `child()` on a log that passed a bound field as `undefined` erased
  the value its parent bound. It now keeps it, as a call site does.
- A log line could pass `error_stack` as a field and forge the stack column,
  and a `level` or `message` passed that way was overwritten without a word.
  A line, or a child it came from, that passes any column the log writes
  itself now throws. The unknown field error on a log lists only the fields
  you declared, rather than `level`, `message` and `error_stack` as well.

**Types that disagreed with the runtime**

- `timer.time()` was typed to return the thenable `fn` returned when that was
  not a `Promise`, such as a query builder, although it hands back a `Promise`
  of its result. Calling a builder method on it compiled and then threw. The
  return type is now a `Promise` of the result.

**Settings accepted and misread**

- An unknown snapshot `direction` sorted ascending. It now throws.

The delivery guide now says that a driver staged event whose immediate send
failed waits for its next `record()` or a flush, rather than retrying on its
own.

Docs that disagreed with the code are corrected. Getting started no longer
suggests `flush({ force: true })` to ship a window that is still open, and
shows a test clock instead. The driver skeletons in the drivers guide and the
driver contract have all fourteen methods and compile. The grace default reads as the house default,
then `'2s'`, on every page that states it. The event page no longer names a
`context.buckets` field, and its pattern counts `3xx` responses. The log page's
nested child example uses only declared fields. The flushing guide lists
`releaseError` in the report, and the dims reference says that a counter's
`current()` may leave its dims out.
