---
'metrichouse': minor
---

Add the `ioredis` driver — shared, durable storage — and lift the driver
contract into a suite both drivers run.

`ioredis(client, opts?)` writes straight to Redis, pipelined, with no local
buffer, so every instance contributes to the same bucket and a live read is
globally exact. A claim is a real move into a key of its own, so it outlives
the process that took it: `capabilities.durable` and `shared` are both `true`,
and the house stops downgrading the guarantee to best-effort.

- **Named for the client, not the database.** The two mainstream clients agree
  on nothing at the surface, and one function serving both would be a
  translation layer pretending to be a driver. `nodeRedis()` and `httpRedis()`
  stay free for whoever writes them.
- **`ioredis` is an optional peer dependency.** The client is typed
  structurally — `IoredisClient` names only the commands the driver calls — so
  the package is never imported and an app on `metrichouse/memory` never
  installs it. Available as `metrichouse/ioredis` or from the root entry.
- **Accepts a client or a `() => Client` factory**, called on first write
  rather than at module scope, so importing a schema never opens a socket.
- **Lua where it has to be.** `observe` folds `last/min/max/sum/count` in one
  script per bucket, because a client-side read-modify-write loses observations
  under concurrency; `claim`/`ack`/`release` are atomic moves. Scripts are
  called by SHA and reloaded on `NOSCRIPT`.
- **`.keyFor(metric, bucketTs)` and `.scanSeries(metric)`** for looking at a
  running system in `redis-cli`.
- `namespace` (default `mh`) and `maxPipelineSize` (default `1000`).

`describeDriverContract(name, options)` is the new shared suite: everything a
driver must do, written against the memory driver because that is the one
implementation small enough to read in a sitting. `memory.test.ts` and
`ioredis.test.ts` both call it and keep only what each backend is *allowed* to
differ on. Adding a backend is now mechanical — call it, watch it fail, make it
pass.

Extracting it found a gap: `observe` had no driver-level coverage at all. It
now does, and the gauge tests are why several decisions below exist.

Four deviations from the original Redis plan, each forced by building it:

- **One `b:` key prefix, not `c:` and `g:`.** The driver is never told whether
  it serves a counter or a gauge, so one storage shape and the value says which
  it is. Separate prefixes would have made `readBuckets` query both and a
  `claim` merge them anyway.
- **`HINCRBYFLOAT`, not `HINCRBY`** — a counter may declare `float()`.
- **A LIST for staged records, not a STREAM.** `release` returns records to the
  front of the queue, and a stream's monotonic ids make prepending impossible.
  One staleness mechanism now covers both claim kinds.
- **`%.17g` when packing a gauge fold.** Lua's default `tostring` is `%.14g`,
  which would lose the bottom bits of every `sum` on every observation.

A `Date` in a record's `fields` now survives the round trip — a declared `ts()`
field reaches storage as a real `Date`, and plain `JSON.stringify` would have
handed the metric a string for a column that wants a date.

The driver's tests need a real server (`REDIS_URL`, or localhost:6379) and
report as skipped without one, so `pnpm test` stays trustworthy on a machine
with no Redis. CI runs `redis:7` across the Node matrix.
