# metrichouse

## 0.8.0

### Minor Changes

- 57a43e5: Fix the drivers.
  
  - A turn to ship now carries a token of its own, so a flush that wrote nothing no longer gives back a turn another flush took in the same millisecond. `takeTurn` answers `{ granted: true, turn, previous }` with `Turn` objects of `{ at, token }`, and `returnTurn(metric, turn, previous)` takes the turn it gives back. A custom driver that implements the two has to follow. The Redis driver reads a turn stored by an earlier version.
  - The Redis driver mints claim ids in the process, as the metric and a UUID version 7, instead of from a counter in Redis. A counter that Redis rolled back after losing its latest writes handed out an id still in flight, and settling one claim settled the other. Claims taken under the old ids still recover and settle. `IoredisClient` no longer needs `incr`.
  - `claim()` throws on a watermark that is not a finite number in both drivers, instead of storing `NaN` and letting late writes land in windows that already shipped.
  - `memory()` copies a record's fields on `append` and hands out copies from `readPending`, `readLevels` and `readLevel`, so editing either one no longer changes what is stored.
  - A `memory()` release stopped by a cell of another kind now leaves the claim in flight and the live set unchanged, instead of settling the claim and losing it.
  - `memory({ maxSeries, maxStaged })` throws on anything but a positive whole number or `Number.POSITIVE_INFINITY`, instead of treating `NaN` as no cap and `0` as a cap that refuses every write.
  - The Redis driver issues every round trip of one call before any call made after it, so a call split by `maxPipelineSize` no longer has another call's writes land between its halves.
  - The Redis driver puts a record staged before sequence stamps back ahead of stamped records on release and recovery, the order it reads them in.
  - The Redis driver refuses a namespace holding half of a surrogate pair, which Redis would store as the same key as other such namespaces.
  - The Redis driver reads back a record field named `__mh_x` that a version before 0.6.0 stored, instead of renaming it `x`.
  - Docs: `maxmemory-policy noeviction` is the only safe eviction policy, Redis 4.0 is the minimum version, Redis Cluster is not supported, a large claim backlog blocks Redis while it is claimed, and a refusal is all or nothing per script call of up to 1000 operations.
- 5cb4e3f: Events, logs and timers:
  
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
- dc61a09: - A flush claims again while a claim comes back with a full `claimLimit`, up to a hundred claims, so a fleet sharing one turn is no longer capped at `claimLimit` records per interval. `claimLimit` now bounds one claim, and one call to `write`, rather than one flush.
  - A flush still running counts as the latest shipment, so a second flush started meanwhile on the same process reports `skipped` on the cadence rather than shipping in the same interval.
  - A flush that fails on a later claim reports what the earlier claims wrote as `written`, keeps their `ackError`, and counts as a shipment for the cadence.
  - A call up to a tenth of the cadence early counts as on time, instead of fifty milliseconds, so a cron firing a little earlier within its minute no longer waits a whole interval.
  - A scheduled flush sends its `ackError` to `onError`.
  - `drain()` waits only for the writes issued before it was called, so it resolves under steady traffic. `house.stop()` still waits for writes issued while it drains.
  - Under immediate delivery, a flush waits for the immediate sends of that metric already under way before its rows reach the sink, so a stale running total cannot arrive after the flush row from the same process.
  - An immediate send for a write moved forward past a released window sends every live window of the series from the one aimed at, so the landing window is always sent.
  - `createHouse` refuses a missing driver, an object that is not a driver, and a `now` that is not a function, with messages naming them.
  - `house.register()` binds and schedules every metric before warning, and an `onWarn` that throws goes to `onError` instead of leaving metrics half registered.
- 866a554: Fix how a level carries and adds up its series.
  
  - A write to a level series past its `holdFor` that no flush had dropped yet
    moved the value it expired with, and the next flush carried that old value
    through every window up to the write. The write now starts the series over,
    so an `inc()` starts from zero, and the flush ships the windows it reported
    before it expired and nothing through the gap.
  - `level.totals()` and a `snapshot()` that adds series together returned
    `Infinity` for fractional series past the largest double. They now reject.
  - On a level declared `value: int()`, `totals()` and a `snapshot()` that adds
    series together now add as whole numbers, exactly, and reject only when the
    exact total is past `9007199254740991`. Added as doubles, a running sum could
    pass that bound partway and come back as a different whole number.
  - `level.dec()` named the negated amount when it refused one: `dec(1.5)` on an
    integer level said `-1.5 is not a legal delta`. It now names `1.5`.
  - A late `set()` moved forward to the oldest unshipped window replaced a newer
    reading already there. It is now dropped.
  - A write that landed while a flush was carrying a series was lost in the
    windows after it. A `set()` landing between the flush reading the series and
    filling its windows now reaches every empty window after it, and one landing
    after the fill replaces the carried values after it up to the next written
    window, and becomes the current value.
  - A series whose earliest write reached storage second, from another process
    or moved forward to the oldest unshipped window, skipped the windows between
    its two writes, and an `inc()` there counted from the later value. The series
    now begins at the earlier write, every window between ships, and the `inc()`
    starts from zero.
  
  Custom drivers: `LevelOp` gains `holdFor`, `LevelSeries` gains `carriedFrom`,
  and `LevelCell` gains `carried`, which a driver sets on a cell a `hold` writes.
  A `hold` fills its window with the value in effect just before it, read when it
  lands. The driver contract page has the rules under `setLevel`, and the shared
  contract suite checks them. `ioredis()` reads
  level state and cells stored by earlier versions.
- 26b461c: - A final flush on a driver that is not durable, such as `memory()`, also ships
    every window ahead of the clock. After the clock stepped back, `house.stop()`
    used to report success with nothing shipped and the writes were lost.
  - A claim raises the watermark no further than one past the newest window that
    held data, and a claim that finds nothing leaves it alone. One flush on a clock
    far ahead no longer moves every later write into a single window that no flush
    can take until the clock catches up.
  - `current()` on a counter, a gauge or a timer, and `gauge.totals()`, read the
    window a write made now lands in, so a write moved ahead of a clock that
    stepped back counts in the open total.
  - A write aimed below the watermark lands on the first window of its own
    resolution at or past it. After a change of resolution it used to land on the
    old watermark, off the new grid, and a level lost the value it set in every
    window carried after it.
  - Driver contract: `IncrOp`, `GaugeOp` and `LevelOp` carry `resolutionMs`,
    `claim()` takes an optional `aheadFrom`, and a driver may add `landing()`. A
    custom driver has to land a moved write on the operation's own grid, and
    follow the new watermark rules in the driver contract reference.

### Patch Changes

- 6512ad5: - A gauge `totals()` or a merged `sum` across series that passes the largest double throws instead of returning `Infinity`.
  - A row's `.default()` dim or field is typed as always present on sink rows and live rows. Call sites still may omit it.
  - The published type declarations no longer include the internal `Gauge.openFolds`.
  - `snapshot({ orderBy })` throws for a name that is not a column of the metric even when there are no rows, and no longer accepts an inherited property such as `toString`.
  - Declaration errors for a `resolution` that does not divide `flush` start with the metric name.
  - A wrong-type value passed to a gauge, level or timer is named by its type in the error, and a cell of the wrong kind names the kind the driver returned.
  - A counter's `add()` errors for a missing or unknown dim start with the metric name, as do the same errors from a gauge, level and timer.
  - An integer counter adds totals across series and windows exactly, and refuses one only when the exact total passes `Number.MAX_SAFE_INTEGER`.
  - A stored fraction on an integer metric, left by changing `float()` to `int()`, is reported as not a whole number and no longer as an overflow. Both drivers.
  - A stored dim value the current declaration cannot hold, such as text under an `int()` dim, a removed `oneOf` member or a missing value for a required dim, is reported to `onError` and shipped as stored. A level stops carrying such a series.
- 6735fe5: - Reword the startup warning of immediate delivery. It now says the sink must upsert on id and keep the flush row over an immediate one.
- ef48c84: Events and logs:
  
  - A staged record the current declaration cannot read, one missing a field now
    required or holding a value its field no longer accepts, ships with its
    values as stored and is reported to `onError` with the metric, its id and the
    reason, instead of failing every flush that claimed it and holding up every
    record behind it. `peek()`, `snapshot()` and `house.snapshot()` return it as
    stored too, and a process reports each record at most once.
  - A locally staged event asks the driver for records an earlier
    `stage: 'driver'` declaration left there only until the driver answers that
    it holds none, and again once per flush interval after that. Until then a
    flush and `pending()` make no driver call. A driver that fails or does not
    answer within 5 seconds, or the flush interval when shorter, is reported to
    `onError` and counts as holding none, so a Redis that is down no longer fails
    a local flush, hangs `pending()` or keeps `house.stop()` from returning.
  - A flush of a locally staged event ships the records left in the driver and
    the local buffer in the same send, instead of leaving the buffer for the
    next trigger.
  - Records refused past `batch.maxStaged` are reported once per turn of the
    event loop, naming how many were refused, instead of one error per record.
- d579474: - The Redis turn key `mh:turn:<metric>` holds the time alone again, the layout 0.7.0 reads, and the token moves to `mh:turntok:<metric>`. A 0.7.0 process on the same namespace no longer fails every flush, and a turn key left as `at|token` by an earlier build is rewritten into the two keys the first time a process takes or gives back that turn.
  - Under immediate delivery, a flush waits only for the immediate sends aimed at a window it claimed, and for at most one `flush` interval, so a `write` function that never answers an immediate send no longer holds up every later flush of the metric.
  - When flushes overlap, the cadence counts from the one started last, so a slow flush finishing after a forced one no longer lets the next call ship twice in one interval.
  - When Redis has forgotten its scripts, the Redis driver sends the refused scripts of every round trip of one call again in one step, so a later call cannot land between them.
  - An immediate send for a write aimed at a released window sends the window the write landed in as well.
  - `counter.current()`, `gauge.current()` and `gauge.totals()` on Redis ask where a write lands at the same time as they read, so they wait for one round trip instead of two.
- 9449f1f: - A level on Redis keeps each series in the four fields 0.7.0 reads, `value|carried|writtenAt|heldThrough`, and `carriedFrom` in a hash of its own, `mh:lvlfrom:<metric>`, only when those four cannot say it. A carried cell is stored as `@ 7` and a moved one as `@7 `, which 0.7.0 reads as `7`. A 0.7.0 process sharing the namespace in a rolling deploy now ships the same rows as one process alone, where it used to overwrite series it could not read and ship `NaN` for carried cells. A series or cell an earlier build stored as five fields or as `@c7` is still read, and is rewritten in the new layout the next time it is written or carried.
  - A second `set()` that missed its window and moved forward to the watermark replaces the first one moved there, and `current()` follows it. It used to be dropped, as if the first were a reading taken in that window. A reading taken in the window itself still wins over both.
  - An `inc()` or `dec()` that arrives late, aimed at a window inside a stretch where the series had passed `holdFor` before a newer write revived it, starts from zero. It used to build on the value the series expired with.
  - `totals()` and a merging `snapshot()` on a level declared `value: int()` add stored fractions, which a `float()` level wrote, as doubles: `1.5` and `0.5` total `2`, and a total that is not a whole number rejects with an error naming the cause. They used to throw a bare `RangeError`.
  - Level writes and flushes on Redis cost about what they cost in 0.7.0 again. A flush holds every series from one read of the windows between its pointer and the window it fills, and a write reads the windows after its own once per call.
  - The Redis driver loads a script once when many calls in one batch first need it. A first level carry used to load the same script once per window it filled.
  - Document that a level series whose first write lands between a flush's read and its claim, stamped more than `grace` in the past, loses the windows that flush claims.
  
  Custom drivers: `LevelCell` gains `moved`, which a driver sets on a cell only writes moved forward to the watermark have written.
- 885969c: Fix the reads.
  
  - A stored series key the current declaration cannot decode, such as text under an `int()` dim, a removed `oneOf` member, a dim removed from the end or a value stored as absent for a dim that is now required, no longer fails the flush of its metric and `snapshot()`. It is reported to `onError` once per process with the metric, the dim, the stored text and the reason, and its rows ship with the stored text as the value of each dim that cannot be read. Other series ship as usual. This holds for a counter, gauge, level and timer. A level still leaves such a series out of its carry and `totals()`.
  - A number or a timestamp stored in a dim key is decoded only from the text MetricHouse writes for it, so `0x1F`, `1e3`, ` 7`, `+5` and `007` are no longer read as numbers.
  - Docs: a `oneOf` member or a `.default()` added to an optional dim reaches processes still on the old declaration as keys they cannot decode during a rolling deploy, and the dim errors that docs quote start with the metric name.
- 5917b6c: Keep Redis storage readable by 0.7.0 during a rolling deploy.
  
  - A claim on Redis raises `mh:wm:<metric>` to the window boundary it claimed up to, the value 0.7.0 reads, and keeps the lower watermark this version lands late writes by in the hash `mh:wmown:<metric>`, with the windows its writes start between the two, so a write of this version moves past one that a 0.7.0 claim at the same boundary has taken since. The key 0.7.0 reads used to hold one past the newest window with data, off the metric's grid, so a 0.7.0 process moved a late write into a window of its own one millisecond past a real one, and a level carried the wrong value from it. A watermark a 0.7.0 claim raises is still honoured, and one an earlier build stored off the grid is read as it is and replaced by the next claim of this version.
  - Every flush of a level on Redis rewrites series an earlier build stored in five fields into the four 0.7.0 reads, even when it carries nothing. They used to stay in five fields until written or carried, and 0.7.0 treated them as absent. A claim that takes, or a release or recovery that puts back, a cell such a build marked `@c` rewrites it as `@ `, which 0.7.0 reads as its number.
  - Docs: a namespace shared with 0.7.0 ships each level window by the rules of the version that wrote or carried it, and the upgrade notes say how the two differ.
- 6e5ca64: Fix how sends wait for one another.
  
  - A flush under immediate delivery waits for an immediate send only until one flush interval after that send started, and never waits again for a send an earlier flush gave up on. A `write` function that never answered one immediate send used to hold up every later flush of the metric by a full interval, so a metric on the scheduler shipped only every other interval.
  - The Redis driver keeps one writer's writes in order when Redis forgets its scripts. After the first NOSCRIPT refusal it issues nothing new until every round trip already sent is answered, then sends every refused call again in the order the calls were made. A call made between two refusals used to land ahead of the second one's resend, so a level set or gauge could end on the older value.
  - Docs: `drain()` and `house.stop()` wait for an immediate send already under way with no limit, so a `write` function needs a timeout of its own.
- d0320bb: Stored data the current declaration cannot read:
  
  - A house with no `onError` no longer crashes on news the library reports on its own. A locally staged event that cannot ask the driver for records an earlier `stage: 'driver'` declaration left there, and a staged record the current fields cannot read, are reported only when there is an `onError`, instead of raising an unhandled rejection that ends a Node process. The record still ships as stored.
  - A locally staged event's failed driver check on a flush comes back in the flush report as `recoveryError`. A scheduled flush hands it to `onError`, or drops it when there is none, and `pending()` reports it only to `onError`.
  - Past 10,000 unreadable staged records per event, or 10,000 unreadable stored series keys per metric, one report says so and later ones are not reported, instead of forgetting the oldest and reporting every record again on each read. An event reports records again once some it remembers have shipped.
  - A snapshot that merges series, with `groupBy` or a `rollup`, keeps a series stored under an earlier declaration apart from one written since that reads the same, so a level adds both and a gauge leaves `last` off, instead of dropping one of them.
  - Docs: a sink that inserts into a typed table may reject every batch that carries a stored key the current dims cannot read.

## 0.7.0

### Minor Changes

- 9b6dc34: Add `durability` to `event()`. An event declared `durability: 'durable'` makes
  `record()` and `recordMany()` return a promise that resolves once the driver has
  answered that the record is staged, and rejects otherwise, so an order log or an
  audit trail is never reported as kept when it was not. A relaxed event still
  returns at once and reports a refused write to `onError`.
  
  A durable event needs `stage: 'driver'` and no `sample`, and its derived counters
  move once the driver has answered. Whether a staged record also survives a crash
  of Redis is Redis's own setting: under `appendfsync always`, Redis writes to disk
  before it answers. The house warns at startup when a durable event is bound to a
  driver that cannot survive a restart, such as `memory()`.
  
  `driver.close()` on `ioredis()` now quits a client it made once when it is called
  twice at the same time, where the second call used to reject.

### Patch Changes

- 03e0da9: `ioredis()` no longer applies a write twice when the client has a
  `commandTimeout`. A write that timed out, or whose connection closed before
  Redis answered, stopped being tracked at once, so the next write let Redis
  forget it had applied it. ioredis still resends such a write after a reconnect,
  and the resend then counted again: three `add(1)` calls could leave a counter
  at 4. Such a write is now tracked until a write sent after it has been answered.

## 0.6.1

### Patch Changes

- 775b547: The `flush` cadence now holds across every process that shares a driver, and
  neither a rolling deploy nor one server's own timers send bursts of small
  inserts.
  
  **One shipment per interval for the whole fleet**
  
  Each process used to keep its own record of when a metric last shipped. With
  `ioredis()` and several servers running `house.start()`, the claim stopped two
  of them shipping the same rows, but each server still shipped whatever had
  closed since another one last did. N servers made up to N inserts per
  interval. An event with `flush: '12s'` on six servers made 32 inserts in 72
  seconds where the cadence allows 7, and 58 on twelve servers. ClickHouse
  writes every insert as a new part, so this showed up as `Too many parts`.
  
  A flush on a shared driver now takes the metric's turn from the driver before
  it claims. The driver refuses the next turn until a full interval has passed,
  whichever process asks, so each metric ships at most once per interval for the
  whole fleet. Six servers and twelve servers each made 6 event inserts in the
  same 72 seconds.
  
  - A flush another process beat to the turn reports `skipped: true` with
    `reason: 'cadence'`, and `nextEligibleInMs` counts from that process's turn.
  - A flush that writes nothing, because nothing had closed or because the sink
    threw, gives its turn back, so another process can ship straight away.
  - `force` still ships at once, and records its turn.
  - A flush that cannot reach the driver to take its turn reports that as its
    `error` and claims nothing.
  - A locally staged event takes no turn, since only its own process holds its
    records. Neither does `memory()`, which serves one process.
  - Turns compare each server's own clock. A turn stamped by a clock less than
    one interval ahead holds the others back, and one more than an interval away
    counts as a clock that stepped and lets the flush go ahead.
  
  **Rolling deploys**
  
  The final flush `house.stop()` makes now waits for the turn on a driver that
  is shared and durable, where it used to ship at once. Six servers stopping
  three seconds apart sent 16 small inserts, as few as 7 rows each, and now send
  3. What a stopping server leaves stays in Redis for whichever server takes the
  next turn. If every server stops, it waits there until one runs again. Pass
  `house.flush({ final: true, force: true })` to ship it anyway from a process
  that knows it is the last. On a shared driver that is not durable, a final
  flush still ships at once.
  
  **Metrics on one server**
  
  `house.start()` armed every metric's timer at the same moment, so a server
  sent all its inserts within the same second each interval. Each metric's first
  tick now fires at its own point in the interval, worked out from a hash of its
  name, so the same metric sits at the same point on every server and after a
  restart. How often a metric ships does not change.
  
  **For driver authors**
  
  `Driver` gains two optional methods, `takeTurn` and `returnTurn`, and a
  `ShipTurn` type. A driver without them, or with `shared: false`, keeps the
  cadence in each process as before. `ioredis()` keeps each turn in a key
  `<namespace>:turn:<metric>`.
  
  The sink guide now covers ClickHouse asynchronous inserts, and why
  `wait_for_async_insert` has to stay at `1`.

## 0.6.0

### Minor Changes

- 6bbaccd: Less CPU per write, per staged record and per row a flush or a snapshot
  builds, and fewer bytes on the wire for the live reads that ask about one
  series or one total. Nothing stored changes, and no result, row id or error
  does either.
  
  A minor bump rather than a patch, because the `Driver` interface gains two
  optional methods, `readLevel` and `sumBuckets`, and `BucketRange` is exported
  for the second. A driver written before them still works unchanged: a metric
  asks for them only when a driver has them, and reads the long way otherwise.
  
  - A counter, gauge, level or timer builds its dim key encoder once, when it is
    declared, instead of reading its declaration again on every write. Encoding
    five dims takes about 265 ns instead of 800, and `counter.add()` on
    `memory()` takes about 960 ns instead of 1400.
  - An event or log record id draws its random bytes from a pool that is
    refilled from the platform's crypto source, instead of asking the platform
    once per id. Minting an id takes about 150 ns instead of 700.
  - The `ioredis()` driver stores and reads a record without the extra JSON
    pass when there is no date and no reserved key in it. The stored bytes are
    the same. Reading a claim of 10,000 records takes about 16 ms instead of 30.
  - A counter or gauge `snapshot({ dims })` builds only the rows the filter
    keeps. Picking one series out of 50,000 on `memory()` takes about 15 ms
    instead of 53.
  - A row id is written out as hex a byte at a time from a table, instead of
    through `toString(16)` and `padStart`. The ids are the same to the
    character. Hashing 200,000 ids takes about 50 ms instead of 196.
  - A counter, gauge or level builds its dim key decoder once, when it is
    declared. A key with no escape character in it is split in one pass, and
    every other key is read exactly as before. Decoding 200,000 keys of three
    dims takes about 55 to 70 ms instead of 125 to 180. With the faster ids,
    turning a claim of 200,000 counter rows into rows takes about 220 ms
    instead of 484, and a level carrying 200 series through 1,000 windows on
    `memory()` flushes in about 340 ms instead of 520.
  - Keeping track of a write until it lands makes one promise instead of three.
    Tracking 200,000 writes takes about 80 ms instead of 158, and 200,000
    `counter.add()` calls on `memory()` take about 213 ms instead of 275.
  - A level `set()` or `inc()` on `memory()` that lands in the newest window no
    longer looks through every unflushed window for a later one. With 3,000
    unflushed windows, 20,000 writes take about 25 ms instead of 498.
  - The `ioredis()` driver sends a write without waiting on a promise per
    script once every script it uses is loaded.
  - The `ioredis()` driver reads one series across its windows in one round
    trip instead of two. `counter.current(dims)` and every immediate delivery
    send read this way.
  - `level.current(dims)` reads the one series it asks about instead of every
    series the level holds. With 5,000 series on `ioredis()` it takes about
    0.15 ms instead of 17.
  - `counter.current()` on an integer counter adds up the open window inside
    Redis when no order of adding could change the total, instead of fetching
    every series. With 20,000 series it takes about 5 ms instead of 47. A float
    counter, and any total that could round, still adds the series itself.
- ab06cf8: Fixes from a fourth round of bug hunting.
  
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
- 37ea08a: Fixes for wrong values, lost errors and driver disagreements found by a second
  round of bug hunting across the drivers, the metric types and the runtime.
  
  **Values that shipped wrong**
  
  - A level whose flush carried a value into a window that a late `set()` had
    already written kept the window right but carried the older value into every
    empty window after it. It now carries the value the window ended at.
  - A dim named after a column the metric writes, such as `id`, `value` or a
    gauge's `min`, overwrote that column or was overwritten by it. A dim named
    `id` gave every window of a series the same row id. These names now throw at
    declaration.
  - A gauge or timer that did not ship `sum` told its sink a `total` of `0`. The
    total is now every observed value added up, whichever columns ship.
  - `add(5n)` or `add(true)` on a counter with no dims counted 1, and `inc(5n)`
    moved a level by 1. A first argument that is neither a number nor a dims
    object now throws.
  - An integer counter or level could pass `Number.MAX_SAFE_INTEGER` and stop
    being exact without any error. The driver now refuses that write, and a delta
    past the limit throws at the call with a message that no longer calls it a
    fraction.
  - On Redis, a batch of gauge observations aimed at two windows below the
    watermark was folded out of order, so `last` could be wrong.
  - `rowShape()` reported a dim or field with a `.default()` as optional, so a
    table built from it had a nullable column.
  
  **Failures reported as success, or not at all**
  
  - A sink that rejected with no reason, as `Promise.reject()` does, counted as a
    successful flush. `house.stop()` then called it a hundred times. It is now
    reported as an error naming the metric.
  - On Redis, an `ack` whose reply was lost and resent after a reconnect failed a
    flush that had succeeded, a resent recovery reported that it found nothing,
    and a resent `claimRecords` took twice its limit. Each now answers the way
    its first arrival did.
  - A failed recovery pass on a scheduled flush never reached `onError`.
  - A log line threw for a caught value `String()` cannot convert, and for an
    `Error` whose `message` or `stack` is not a string. It now writes a row.
  
  **Settings and inputs that were accepted and misbehaved**
  
  - A `flush`, `defaults.flush` or `batch.maxAge` of zero, or longer than just
    under 25 days, made the scheduler fire about every millisecond. Both now throw
    at declaration.
  - An unknown `delivery` value behaved as `'staged'`. It now throws.
  - A metric whose own registration failed stayed bound, so calling `createHouse`
    again with the same metrics, as the docs say to, failed.
  - A metric named `__proto__` vanished from flush reports and snapshots, and a
    metric name holding half of a surrogate pair could share Redis keys with
    another. Both now throw.
  - A dim or field named like a whole number, such as `'2024'`, lost its declared
    place in the row. Those names now throw.
  - An invalid `Date` for a snapshot's `to` included the window still filling. It
    now throws, as does one for `from`.
  - A grouped snapshot row carried an absent optional dim as a key holding
    `undefined`.
  - A gauge accepted an aggregate named twice, an event `timestamp` naming an
    inherited property such as `toString` got the wrong error, and a level named
    `then` made a logger awaitable. All three now throw clearly.
  
  **The two drivers now agree on**
  
  - Refusing a first increment or observation that is not a finite number.
  - Changing nothing when one write in a batch is refused, and leaving no empty
    window behind when the memory driver refuses a new series.
  - A read on Redis seeing a write issued before it that has not resolved yet.
  - Handing back a record field shaped like the Redis driver's own date marker
    unchanged.
  
  Error messages no longer use a dash as punctuation, so a few messages read
  differently. A test matching on the exact old text may need updating.
- a7f92d6: Fixes from a third round of bug hunting, mostly in code the previous round
  changed.
  
  **Values that shipped or read back wrong**
  
  - A level hold for a window that a claim had already taken, arriving a second
    time from a racing flusher or a resend, put `carried` back to an older value,
    so every empty window after it shipped that value.
  - A level `set` or `inc` batch refused partway kept the operations before the
    refusal, and on Redis a resend applied them a second time. A refused call now
    changes nothing in its window.
  - A level snapshot could leave out the oldest window the next flush shipped
    after a gap longer than 10,000 windows.
  - An event row, and a grouped snapshot row, carried an inherited value such as
    `Object`'s `constructor` for an omitted field or dim of that name.
  - `add(new Date())`, `add([])` or `add(new Number(5))` on a counter with no dims
    counted 1. They now throw, as `inc()` and `dec()` on a level do.
  - An integer counter's total across series, from `current()` or a merging
    `snapshot()`, could pass `Number.MAX_SAFE_INTEGER` and come back as a
    different whole number. It now rejects.
  - A dim or field named `bucket_open` or `bucket_elapsed_ms` was overwritten in
    every snapshot row. Those names now throw at declaration.
  - `timer.time()` returned a new promise rather than the one `fn` returned, and
    a thenable whose `then` returns nothing came back as `undefined`.
  - On Redis, a bounded `readPending`, which `event.snapshot({ from, to })` uses,
    skipped or repeated records when another process claimed or released between
    pages.
  - On Redis, an invalid `Date` in record fields came back as an object, and a
    level write at a fifteen digit timestamp read the wrong window.
  
  **Failures that stopped other work or were lost**
  
  - With no `onError`, one failed background write made `house.drain()` and
    `house.stop()` reject early, and `stop()` then skipped the final flush for
    every metric. An `onError` that threw on a scheduled flush did the same.
  - When a sink failed and putting its rows back failed too, the flush report
    carried only the second error. The sink's error stays in `error`, and the
    new `releaseError` field reports the other.
  - A locally staged event kept calling its sink on a timer after `house.stop()`
    had returned.
  - A scheduled flush that failed with no `onError` was dropped silently, where
    the docs say it becomes an unhandled rejection. It now does.
  - On Redis, a release that met a cell of another kind stranded the rest of its
    claim where no recovery could find it.
  - On Redis, an error from a batch spanning several metrics named the first
    metric rather than the one refused.
  - A log line still threw for a revoked proxy, or a value whose class tag
    getter throws.
  - A level with a `holdFor` long enough to pass the largest safe timestamp
    failed every flush.
  
  **Settings accepted and misread**
  
  - An unknown event `stage`, a `sample` that is neither a number nor a function,
    and an unknown snapshot `rollup` now throw instead of acting as a default.

## 0.5.0

### Minor Changes

- 2d10e32: Fixes for data loss, wrong values and driver disagreements found by running
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
  - On Redis, a restart or dropped connection could count a write twice: ioredis
    resends a command after reconnecting, and the first send may already have
    run. Every write now carries its writer's id and a sequence number, and Redis
    applies each one once. After `NOSCRIPT`, only the calls Redis did not know are
    sent again.
  - A level `inc` or `dec` that reached Redis after a write for a later window
    left that window, and every carried window after it, one off. A late `add`
    now applies from its window onwards, and a late `set` no longer replaces a
    newer value.
  - A carry from a flusher whose clock ran behind could move a level's carried
    value backwards.
  - A claim's age is now measured with Redis's clock, so a host whose clock runs
    fast no longer takes back claims that are seconds old.
  - On Redis, a write that first had to load its script could be overtaken by a
    later one, so `set(1)`, `set(2)`, `set(3)` could end at 2. Sends now go out
    in the order they were made.
  - On Redis, releasing a claim whose records interleaved with records already
    put back returned them out of order, and past 10,000 put back records a
    release landed in the middle. Releases now merge by append order.
  - With `claimLimit`, `drain()`, `batch.maxAge` and `house.stop()` shipped one
    batch and left the rest behind while reporting success. They now ship the
    whole backlog in batches of `claimLimit`.
  - `snapshot({ dims })` never matched a `ts()` dim, because it compared `Date`
    objects by identity.
  - `record(fields, { at })` accepted a time past the range a `Date` can hold and
    shipped an Invalid Date. It now throws.
  - A `-0` event field came back as `-0` from memory and `0` from Redis. Both
    store `0`, and a level set to `-0` no longer carries `-0`.
  - An invalid `Date` in a `ts()` field threw a bare RangeError instead of the
    message naming the field.
  - A dim or field named `__proto__` was accepted and then missing from every row.
    It now throws at declaration.
  - A log child's bound field was erased by `undefined` at the call site, and an
    `Error` from another realm lost its stack.
  - `timer.observe()` now rounds to the microsecond, as `end()` does.
  - The serverless recipe that paired `memory()` with immediate delivery claimed
    counters would be exact across isolates. They are not, and the docs now say
    to count with events there.
  
  **Found by a load test**
  
  - On Redis, each write scanned every write still waiting for a reply, so a
    burst slowed quadratically (40,000 writes took 27 seconds to drain), and
    past about 125,000 waiting writes the scan overflowed the stack and the
    writes were dropped. Finding the lowest waiting write now costs next to
    nothing, and a burst of 150,000 drains in about two seconds.
  - A release of more than about 125,000 records, on the memory driver or from a
    local event buffer, overflowed the stack after the claim was settled and lost
    every record in it. A `recordMany` that large overflowed after derive had
    already run. None of these pass their records as function arguments any more.
  - On Redis, one script call carries at most 1,000 items, so a large append,
    increment or level batch no longer overflows the stack either.
  - The memory driver read one series by walking every series in the window, so
    `current(dims)` and every immediate send slowed as series grew. It is now a
    single lookup.
  - A level carry now sends one script per window for all its series, instead of
    one per series per window.

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
