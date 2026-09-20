# metrichouse

## 0.4.0

### Minor Changes

- e35b10b: A new `level` metric, for a value that holds between writes.
  
  A gauge stores what was observed in a window, so a window nobody wrote to has
  no row and a chart of it has a hole. That is right for something you sample and
  wrong for queue depth, requests in flight, or connections checked out of a pool.
  A level keeps one value per series and carries it into every window nobody wrote
  to.
  
  ```ts
  import { level, oneOf } from 'metrichouse/core'
  
  export const queueDepth = level('queue_depth', {
    dims: { queue: oneOf(['email', 'export', 'webhooks']) },
    resolution: '1m',
    flush: '1m',
  
    // A series with no write for five minutes stops reporting, so a worker
    // that dies does not leave its last depth on the chart forever. Leave it
    // out and a series holds until something changes it.
    holdFor: '5m',
  
    write: async (rows) => clickhouse.insert({ table: 'queue_depth', values: rows }),
  })
  
  queueDepth.set(42, { queue: 'email' })   // every minute reports 42 from here
  inFlight.inc()                           // and inc/dec for what is counted in and out
  ```
  
  Rows carry one `value` column. `current()` reads the held value rather than the
  open window, and returns `undefined` for a series nothing has written to.
  `totals()` adds every series up, which is the merge a level can make honestly
  and the opposite of the gauge's.
  
  Each flush walks every series forward through whatever was actually written, so
  a window belongs to the value that was true then rather than to the newest one.
  Set a queue to 42 at noon and to 38 at three and the windows in between hold 42.
  
  **Breaking for custom drivers.** `Driver` grows three methods, because a level
  needs a number that outlives the flush that shipped the last window and nothing
  in the contract could hold one:
  
  - `setLevel(ops)` puts a series at a value, moves it by a delta, or carries what
    it holds into a window that has none
  - `readLevels(metric)` returns every series a level currently holds
  - `dropLevels(metric, dimKeys)` forgets series that have expired
  
  The built in `memory()` and `ioredis()` drivers implement all three, and the
  shared contract suite covers them, so a driver written against it only has to
  run the suite again. `Cell` also gains `LevelCell`, and `isGaugeCell` now checks
  the shape of a cell rather than only whether it is an object. The full contract
  is on the [driver contract](https://www.metrichouse.dev/reference/driver-contract)
  page.

## 0.3.0

### Minor Changes

- 8ac0610: A metric's `write` function now receives typed rows.
  
  `rows` used to be `Row[]`, so every dimension and field read as `unknown` inside
  a sink. It now has the type `snapshot()` already gave you, worked out from the
  dims or fields declared next to `write`:
  
  ```ts
  counter('http_requests', {
    dims: { route: str(), status: oneOf(['2xx', '4xx', '5xx']) },
    resolution: '10s',
    flush: '1m',
    write: async (rows) => {
      rows[0].status // '2xx' | '4xx' | '5xx', where it used to be unknown
    },
  })
  ```
  
  Each kind names its row: `CounterRow<D>`, `GaugeRow<D>` for a gauge or a timer,
  `EventRow<F>`, and the new `LogRow<F, L>`. `WriteFn` takes the row as an optional
  type parameter. A sink typed with plain `Row[]` is still accepted by every
  metric, so shared helpers need no change.

## 0.2.0

### Minor Changes

- 830e657: The metric owns its flush.
  
  A metric is now a complete unit — what it measures, how often it ships, and
  where it ships to — so `metric.flush()` works with no house involved. `flush`
  and retry state moved out of the house's bookkeeping and onto the metric
  itself.
  
  - **`metric.flush(options?)`** ships that metric to its own sink and returns
    its `MetricFlushReport`. Honours the metric's cadence; `{ force: true }`
    ignores it.
  - **`house.start()` / `house.stop()`** — an opt-in scheduler that gives each
    metric its own interval at its own cadence, so `flush: '5m'` becomes an
    actual cadence rather than only a floor. For long-lived processes; edge and
    serverless keep pumping `house.flush()` from a cron, because a timer in a
    frozen isolate never fires. `stop()` clears the timers, drains, and forces a
    final flush.
  - **`house.flush()`** is now a fan-out over `metric.flush()`. Same signature,
    same `FlushReport`, `only` and `force` unchanged.
  
  **Breaking:** `write` is required on every metric, and `createHouse({ write })`
  is gone. A house is somewhere to keep a set of metrics, not the thing that
  ships them, so there is no longer a fallback sink to fall back to — which also
  retires the "no write()" runtime errors, now a compile error instead.
  
  ```diff
  -const hits = counter('hits', { resolution: '1s', flush: '5m' })
  -const house = createHouse({ driver, schema, write: send })
  +const hits = counter('hits', { resolution: '1s', flush: '5m', write: send })
  +const house = createHouse({ driver, schema })
  ```
- 4ef51c2: Claims stranded by a crashed flush are now recovered.
  
  A claim moves data out of the live set, which is what stops two flushers
  shipping one window. It is also why a process that died holding one left data
  nothing could reach again: `claim` reads the live set, and the abandoned batch
  was no longer in it. On `ioredis` that batch survived the crash in Redis and
  then sat there for ever. At-least-once held across a failed *write*; it did not
  hold across a failed *process*. Now it does.
  
  - **`driver.recover(metric)`** is new. The flush calls it after the cadence
    check and before it claims, so whatever it puts back ships in that same
    flush. There is nothing to turn on.
  - **`ioredis(client, { recoverAfter })`**, five minutes by default, is how long
    a claim may be held before a flush treats it as abandoned. Keep it above your
    sink's timeout. Nothing can ask a claim whether its owner is still writing,
    and taking one back from an owner that is merely slow ships those rows twice
    and then fails that owner's `ack`. Waiting is much the cheaper mistake, which
    is why the default is generous.
  - **`MetricFlushReport.recovered`** carries a `RecoveryReport` when a pass found
    something and is absent otherwise, so its presence is the news: something
    crashed between claiming a batch and settling it. A pass that throws is
    reported as `recoveryError` and does not stop the flush, so one stuck claim
    never becomes a metric that stops delivering.
  
  A recovered window is merged back into the live set, never shipped from
  `recover`. An aggregate row is identified by its metric, its window and its
  dims, so the abandoned half and anything written since carry the same row id —
  sending them as two batches would let a sink upserting on that id keep one and
  discard the other, and the total would be wrong.
  
  `memory()` recovers nothing and always will: its claims live in the process
  that took them, so a crash leaves nothing behind to find. That is what
  `durable: false` costs, and it is unchanged.
  
  **Breaking for custom drivers:** `Driver` is thirteen methods now, and
  `recover` is required. A driver whose claims cannot outlive the process returns
  the exported `NOTHING_RECOVERED`.
  
  ```diff
   async release(claim) { /* ... */ },
  +async recover(metric) { return NOTHING_RECOVERED },
  ```

### Patch Changes

- cccecf4: The package README and description now explain why MetricHouse exists: it
  fits into the stack you already have, lets your own code read the numbers
  live, and hands you finished rows to store however your storage needs.

## 0.1.0

### Minor Changes

- c0c4436: Add the `timer` primitive — a gauge of durations.
  
  `timer(name, config)` measures how long something took and folds each duration
  into a gauge, so min/max/mean are live-readable and merge across buckets. It
  adds no storage model; it owns the start timestamp, the `finally`, and the
  monotonic clock.
  
  - **`start(dims?)` returns a handle**; `handle.end(dims?)` records and returns
    milliseconds. Dims unknown at start — a status code — are supplied at the
    end, and may override one bound earlier. The handle is the state, so there
    is no registry to leak and overlapping timings need not nest. `end()` is
    idempotent, because it lives in `catch` and `finally` blocks where a throw
    would replace the error being handled.
  - **`time(dims?, fn)`** times a sync or async function and returns what it
    returns. Failures are recorded and rethrown unchanged; invalid dims or an
    unbound timer are rejected before `fn` runs, never after.
  - **`observe(ms, dims?)`** records a duration measured elsewhere.
  - **`record: 'event_name'`** also records `{ ...dims, duration_ms }` to an event
    for percentiles. The pairing is validated at the first timing, a broken one
    is reported through `onError` while the gauge still records, and the event
    keeps its own sampling — exact aggregate, sampled detail.
  
  Durations come from `performance.now()`, not `Date.now()`, which can step
  backwards; the bucket is where the timing completed. `aggregate` defaults to
  `min`/`max`/`sum`/`count` — `last` is arbitrary for a duration. `MetricKind`
  gains `'timer'`.
  
  `RequiredKeys`, `ShapeArgs` and `MarkOptional` move from `log` into the schema
  types and are exported, since both presets need them. `LogFieldsArgs` is now an
  alias of `ShapeArgs`, unchanged in behavior.
- be14086: Add the `ioredis` driver — shared, durable storage — and lift the driver
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
- 101b088: Add the `log` primitive — an event preset with three reserved fields.
  
  `log(name, config)` declares a structured log with `ts`, `level` and `message`
  reserved, plus whatever fields you declare. It writes through the same
  staging, batching, claim/ack and flush path as `event`, so logs are not a
  second pipeline with its own crash semantics — they are events with a level in
  front of them.
  
  - **One method per declared level.** `levels` defaults to
    `['debug', 'info', 'warn', 'error']` and the type narrows to exactly what you
    list: `levels: ['low', 'high']` gives `.low()` and `.high()`, and `.info()`
    stops existing. `.at(level, …)` covers a level chosen at runtime.
  - **`minLevel`** drops anything below it before the fields are validated or
    anything is staged, so a filtered `debug` call costs one array index.
    Severity is declaration order, which is the only ordering that works for a
    custom level set.
  - **Errors are a first-class message.** Any level accepts an `Error`; its
    `message` becomes the message column and its stack lands in a reserved
    `error_stack`.
  - **`.child(fields)`** returns a bound logger that merges those fields into
    every call. The bound fields become *optional* rather than absent in the
    child's type, so `child({ service })` satisfies a required field without
    making an override at one call site a type error. Children nest, and stage
    into the log that made them.
  
  `MetricKind` gains `'log'`, so a sink can route on `context.kind` — and
  `METRIC_KINDS` is now the single list `isMetric` checks against.
  
  **`stagedMetric()`** is factored out of `event()` as the staged counterpart to
  `bucketedLifecycle()`, and is what `log` is built on. `Event<F>` becomes
  `Event<F, K = 'event'>` so the same lifecycle can report a different kind; the
  default keeps every existing usage unchanged.
- 8c460f0: Add `snapshot()` — the read path, and a kind-erased surface for it.
  
  `current()` answered one number about the open bucket. Everything else still in
  the driver — closed buckets not yet flushed and acked, which on a metric with a
  long cadence is most of the useful history — was unreachable. `snapshot()` is
  that read, and it lands on `AnyMetric` rather than on each kind, because the
  write path has had the equivalent abstraction since day one in the four batch
  methods and the read path had none.
  
  - **`metric.snapshot(options?)`** — `dims` (partial match), `from` / `to`,
    `complete`, `rollup`, `groupBy`, `orderBy` / `direction`, `limit`.
  - **The open bucket is partial, and every row says so.** `bucket_open` and
    `bucket_elapsed_ms` on every live row, and `complete` defaults to `true`, so
    the partial window is excluded unless asked for. Polling a `10s` counter
    mid-window reads ~50% low as a count and sawtooths as a rate; the default is
    correct-but-stale and opting out comes with the numbers to extrapolate from.
  - **`house.snapshot(options?)`** across every metric, keyed by name, read in
    parallel; **`house.current()`** for just the open buckets, each metric against
    its own resolution.
  - **`AnyMetric` gains `storage`, `snapshot()` and `rowShape()`.** `storage` is
    `'bucketed' | 'staged'` — the distinction the library was already built around,
    said out loud instead of inferred from `kind` against a hardcoded list.
  - **A staged kind answers with its unshipped records**, every one
    `bucket_open: false`, because a record is complete the instant it is appended
    and there is no partial window for `complete` to exclude. The aggregate-only
    options are ignored rather than rejected, so one set of them can be handed to a
    mixed schema.
  - **Rows keep the identity a sink would give them** — `id` and `bucket_ts`,
    unless a `rollup` or a `groupBy` merged the row that owned them, in which case
    both are dropped rather than left pointing at a row that no longer exists.
  - **`bucketedReader()`** is exported beside `bucketedLifecycle()`: a new
    aggregate kind supplies `materialize` and `mergeValues` and inherits filtering,
    rollup, ordering and top-K. The engine in `runtime/live.ts` is pure, so the
    awkward parts are testable without a driver or a clock.
  
  - **Rows are typed to the metric that produced them.** `counter.snapshot()`
    returns `park: string` and `kind: 'solid' | 'liquid'`, not `unknown` per key,
    and the row type depends on the options: `rollup: 'sum'` drops `id` and
    `bucket_ts` from the type because it drops them from the row, and a `groupBy`
    keeps only the dims it named. A log's `level` narrows to its declared levels.
    The erased `AnyMetric.snapshot()` is unchanged — the concrete kinds narrow it,
    which is legal because a typed row is still a `LiveRow`.
  
  `rollup` takes `'none'` and `'sum'`. The spec's third mode, `'window'`, is left
  out rather than guessed at — it names a collapse it never defines.
  
  Options are read through a `const` type parameter, so an inline
  `{ rollup: 'sum' }` keeps its literal type. A caller that widens its options to
  `SnapshotOptions` first gets the unrolled row shape, because at that point the
  type has nothing left to read.
- 1b867bf: Separate **delivery** from measurement — the house decides how rows get out.
  
  A metric declares what it measures: resolution, dims, which aggregates it
  keeps. How that data reaches your `write()` is a property of the deployment,
  not of the schema, so it moves to `createHouse`. The same schema file now runs
  on a dev branch against `memory()` and in production against a shared driver
  without either one editing a metric.
  
  - **`createHouse({ delivery })`** — `'staged'` (the default, and what every
    house did before) waits for `flush()`; `'immediate'` ships as data arrives;
    `'auto'` asks the driver. A driver that cannot survive a restart holds data
    at risk for no benefit, so `'auto'` resolves it to `'immediate'` — which is
    the memory driver, and the reason the setting exists. `house.delivery`
    reports the resolved mode.
  - **`createHouse({ defaults })`** — `flush` and `grace` for metrics that
    declare neither. Filled in, never overridden: a counter that declares
    `flush: '5m'` because it carries money keeps it. `flush` is consequently
    optional on `counter`, `gauge` and `timer`, and the check that resolution
    divides it evenly now also runs at bind time, where a cadence from the house
    first becomes knowable.
  - **The two storage models diverge, on purpose.** A staged kind — event, log —
    is complete when recorded, so immediate delivery claims and ships it exactly
    as a flush would and **replaces** flush. A bucketed kind is still folding, so
    immediate delivery sends the *cumulative* open bucket through the read path
    and deletes nothing; `flush()` is still what retires the closed bucket, and
    its row carries the same id and the complete fold. `stage` still says where a
    record waits; `delivery` says when it leaves.
  - **`source: 'immediate'`** on `WriteContext`, and a sink handling it must keep
    the **newest row per `id`** rather than fold duplicates — a bucketed row is a
    running total that a later send supersedes. The house warns once at boot
    rather than leaving it to be discovered from a wrong dashboard.
  - **`shipOpenSeries()`** is exported beside `shipClaim()`: read one live
    series, materialize, write, claim nothing. Shipping one row per `add()` would
    be silent corruption — `rowId` hashes the bucket and the dims and not the
    value, so every increment in a bucket mints the same id.
  - **`gauge()` takes a kind**, as `stagedMetric()` already did, so a timer
    shipping itself reports `'timer'` and not `'gauge'`.
- e18f7e0: Add the `event` primitive, and the staged-record storage model underneath it.
  
  Events are discrete typed records that are never aggregated — the home for the
  high-cardinality metadata a counter has to throw away. `record()`,
  `recordMany()`, `pending()`, `peek()` and `rowShape()`, with `json()` fields,
  per-event `sample` rates written to `_sample_rate`, `derive` fan-out into
  counters (evaluated *before* sampling, so the counters stay exact), a reserved
  `_ingested_at` stamped at `record()`, and uuidv7 row ids minted at `record()`
  so a released batch resends byte-identical rows.
  
  Two staging modes: `stage: 'driver'` goes through the bound driver's
  claim/ack handshake, `stage: 'local'` buffers in-process and ships itself at
  `batch.maxSize`, at `batch.maxAge`, on `flush()` or on `drain()`. (The spec
  called these `'redis'` and `'memory'`; `'memory'` collided with the memory
  driver.)
  
  **Driver contract** grows `append`, `readPending`, `countPending` and
  `claimRecords`, and `Claim` becomes a union of `BucketClaim | RecordClaim`.
  The memory driver implements all four, plus a `maxStaged` backlog cap matching
  its existing `maxSeries`.
  
  **`AnyMetric` is now storage-agnostic**: `materialize`/`totalOf` are replaced
  by `claimBatch`/`materializeClaim`/`ackBatch`/`releaseBatch`, so the flush
  engine no longer knows what a bucket is and a new primitive implements four
  methods instead of editing the lifecycle. Counter and gauge share that
  implementation through `bucketedLifecycle()`. `Row` is now `{ id } & …` rather
  than `{ id, bucket_ts } & …`, because an event row is stamped `ts`.
