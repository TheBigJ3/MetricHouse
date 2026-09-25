# API index

Everything the package exports, and every method on the objects those exports
return, grouped by what you would reach for it.

The arguments that appear on more than one type have pages of their own:
[dims](/reference/dims), [fields](/reference/fields),
[Field types](/reference/field-types), [Durations](/reference/durations),
[Snapshot options](/reference/snapshot-options) and
[Flush options](/reference/flush-options).

## Entry points

| Import path | Contains |
| --- | --- |
| `metrichouse/core` | Declaring, writing, reading, flushing, identity |
| `metrichouse/memory` | `memory()` |
| `metrichouse/ioredis` | `ioredis()` |
| `metrichouse` | Everything, for Node servers where bundle size is not a concern |

Use the specific paths in anything that ships to a browser or an edge runtime.
The package is marked side effect free, so a bundler removes what you do not use.

## Declaring

| Export | Signature | Page |
| --- | --- | --- |
| `counter` | `counter(name, config): Counter` | [counter](/primitives/counter) |
| `gauge` | `gauge(name, config): Gauge` | [gauge](/primitives/gauge) |
| `level` | `level(name, config): Level` | [level](/primitives/level) |
| `timer` | `timer(name, config): Timer` | [timer](/primitives/timer) |
| `event` | `event(name, config): Event` | [event](/primitives/event) |
| `log` | `log(name, config): Log` | [log](/primitives/log) |

Each page lists that type's configuration one setting at a time, then every
method it carries. [Configuration](/reference/configuration) has the same
settings as one table per type.

## Field types

| Export | Accepts |
| --- | --- |
| `str()` | `string` |
| `int()` | whole `number` |
| `float()` | finite `number` |
| `bool()` | `boolean` |
| `ts()` | `Date` |
| `oneOf([...])` | one of the listed values |
| `json<T>()` | anything, on event fields only |

Each returns a `FieldType` with `.optional()` and `.default(value)`. Full details
in [Field types](/reference/field-types).

## Runtime

| Export | What it does |
| --- | --- |
| `createHouse(config)` | Binds a driver to a schema and returns a house. Its methods are in [The house](#the-house) below |
| `createScheduler(options)` | The timer machinery behind `house.start()` |

A house makes its own scheduler, so you only need `createScheduler()` to put
metrics on timers without a house. It returns a `Scheduler` with these members.

| Member | What it does |
| --- | --- |
| `scheduler.start()` | Starts one interval per metric, at that metric's `flushMs`. Calling it again does nothing |
| `scheduler.add(metric)` | Schedules a metric that arrived after `start()`. Does nothing while stopped |
| `scheduler.stop()` | Clears every interval. It does not flush |
| `scheduler.running` | `true` between `start()` and `stop()` |

## The house

Everything on the object `createHouse()` returns.
[The house](/guide/the-house) walks through each one with examples, and
[Flushing](/guide/flushing) covers the scheduler behind `start()` and `stop()`.

| Member | Returns | What it does |
| --- | --- | --- |
| `house.register(...metrics)` | `void` | Adds metrics after startup. Throws if a metric is already bound to a house, this one included, or if another metric has its name |
| `house.metrics()` | `AnyMetric[]` | Every registered metric, in the order they were registered |
| `house.get(name)` | `AnyMetric \| undefined` | One metric by name |
| `house.delivery` | `DeliveryMode` | `'staged'` or `'immediate'`. A house configured with `'auto'` has already picked one |
| `house.flush(options?)` | `Promise<FlushReport>` | Flushes every metric, one after another. Each still waits for its own cadence unless you pass `force` |
| `house.start()` | `void` | Gives every metric a timer that flushes it at its own cadence. Calling it again does nothing |
| `house.running` | `boolean` | `true` between `start()` and `stop()` |
| `house.stop()` | `Promise<FlushReport>` | Clears the timers, waits for queued writes to reach the driver, then flushes every metric ignoring cadence |
| `house.drain()` | `Promise<void>` | Resolves once every queued write has reached the driver |
| `house.snapshot(options?)` | `Promise<HouseSnapshot>` | Every metric's unshipped rows, keyed by metric name |
| `house.current()` | `Promise<HouseSnapshot>` | Only the windows still filling, for counters, gauges, levels and timers |

`start()` is for a server that stays running. On serverless and edge platforms
the process is frozen between requests, so the timers never fire. Call
`house.flush()` from a scheduled job there instead.

## Every metric

Every metric type has these members, whatever it measures.

| Member | Returns | What it does |
| --- | --- | --- |
| `metric.name` | `string` | The name it was declared with |
| `metric.kind` | `MetricKind` | `'counter'`, `'gauge'`, `'level'`, `'event'`, `'log'` or `'timer'` |
| `metric.storage` | `StorageModel` | `'bucketed'` for types that fold writes into time windows, `'staged'` for types that keep every record |
| `metric.dims` | `Shape` | The declared dimensions |
| `metric.resolutionMs` | `number` | How wide one time window is, in milliseconds |
| `metric.flushMs` | `number` | The shortest gap allowed between two shipments, in milliseconds |
| `metric.graceMs` | `number` | How long a window waits after it ends before a flush may claim it, in milliseconds |
| `metric.isBound` | `boolean` | Whether a house has registered it yet |
| `metric.write` | `WriteFn` | The write function it was declared with. Each type narrows its rows, as it narrows `snapshot()` |
| `metric.flush(options?)` | `Promise<MetricFlushReport>` | Ships everything finished to its write function, if its cadence allows. Needs no house |
| `metric.drain()` | `Promise<void>` | Resolves once this metric's queued writes have reached the driver |
| `metric.snapshot(options?)` | `Promise<LiveRow[]>` | Everything unshipped, as rows |
| `metric.rowShape()` | `RowShape` | The columns your write function will receive, in order |
| `metric.bind(binding)` | `void` | Connects the metric to a house's driver, clock and defaults. `createHouse()` and `house.register()` call it for you |

An event or a log keeps records whole rather than folding them into windows, so
it reports an empty `dims`, a `resolutionMs` of `1` and a `graceMs` of `0`.

Five more methods move a batch through a flush: `recoverBatch()`,
`claimBatch(nowMs)`, `materializeClaim(claim)`, `ackBatch(claim)` and
`releaseBatch(claim)`. `metric.flush()` calls the first three in that order,
then `ackBatch()` when the write function succeeds or `releaseBatch()` when it
throws. You only write them yourself when adding a new metric type. See
[Extension points](#extension-points).

Some types add properties of their own.

| Property | On | What it holds |
| --- | --- | --- |
| `isFloat` | counter, level | `true` when fractional writes are allowed. A counter is whole by default, a level fractional |
| `aggregate` | gauge, timer | The aggregates each window stores |
| `holdForMs` | level | How long a series keeps reporting after its last write, or `undefined` for forever |
| `record` | timer | The name of the event it also records each timing to, or `undefined` |
| `fields` | event, log | The declared record fields |
| `stage` | event, log | Where records wait, `'driver'` or `'local'` |
| `levels` | log | The declared levels, lowest severity first |
| `minLevel` | log | The lowest level it keeps |

## Writing

| Method | What it does |
| --- | --- |
| `counter.add(delta?, dims?)` | Adds `delta` to the open window, or 1 when you leave it out. `delta` may be negative |
| `gauge.set(value, dims?)` | Records one observation into the open window |
| `level.set(value, dims?)` | Puts the series at `value`, where it stays until something changes it |
| `level.inc(delta?, dims?)`, `level.dec(delta?, dims?)` | Moves the series by `delta`, or by 1. A series nothing has written to starts at zero |
| `timer.time(dims?, fn)` | Runs `fn`, records how long it took, and returns what `fn` returned |
| `timer.start(dims?)` | Starts a timing and returns a handle |
| `handle.end(dims?)` | Stops the timing, records it, and returns the milliseconds. A second call records nothing |
| `handle.elapsed()` | Milliseconds so far, without stopping |
| `timer.observe(ms, dims?)` | Records a duration measured somewhere else |
| `event.record(fields, options?)` | Stages one record. `options.at` sets its timestamp |
| `event.recordMany(records, options?)` | Stages several records in one round trip |
| `log.info(message, fields?)` | One method per declared level, so `log.info()` exists only when `info` is declared. The default levels are `debug`, `info`, `warn` and `error` |
| `log.at(level, message, fields?)` | Writes at a level chosen while the program runs. Throws if the level was not declared |
| `log.child(fields)` | A logger that adds `fields` to every line it writes |

`dims?` may be left out only on a metric that declares no dimensions, or on a
timer handle whose `start()` already supplied them. A log `message` may be a
string or an `Error`, and an `Error` fills the `error_stack` column. A child
logger has the same level methods, `at()` and `child()`, plus `bound`, the
fields it adds to every line.

Every write method returns before storage has confirmed anything. Call `drain()`
on the metric or the house when you need to know a write landed. Each method,
with its parameters and what it throws, is on the page for its type:
[counter](/primitives/counter), [gauge](/primitives/gauge),
[level](/primitives/level), [timer](/primitives/timer),
[event](/primitives/event) and [log](/primitives/log).

## Reading

| Method | What it does |
| --- | --- |
| `counter.current(dims?)` | The open window for one series, or every series added together when you leave out `dims` |
| `gauge.current(dims?)`, `timer.current(dims?)` | The open window's fold for one series, or `undefined` if nothing was observed |
| `gauge.totals()`, `timer.totals()` | Every series in the open window merged into one fold, without `last` |
| `level.current(dims?)` | What one series is at now, or `undefined` if nothing has ever written to it. Read from the held value, not from the open window |
| `level.totals()` | Every series added up, or `undefined` if none has been written to |
| `metric.snapshot(options?)` | Everything unshipped, as rows |
| `house.snapshot(options?)` | The same across every metric |
| `house.current()` | Just the open windows, folded metrics only |
| `event.pending()`, `log.pending()` | How many records are staged |
| `event.peek(n?)`, `log.peek(n?)` | The first n staged records, without consuming them |

## Identity

| Export | What it does |
| --- | --- |
| `rowId(metric, bucketTs, dimKey)` | The stable id for one folded row |
| `naturalKey(dims)` | The columns your table should treat as unique |
| `uuidv7(nowMs)` | The id minted for one staged record |
| `hash(parts)` | The default content hash |
| `setHasher(fn)` | Replace the hasher, returning the previous one |
| `getHasher()` | The hasher currently in effect |

::: warning Changing the hasher is a migration
`setHasher` changes every id the process produces. Ids already in your database
were written by the old one and will never converge with new ones.
:::

## Constants

| Export | Value |
| --- | --- |
| `DEFAULT_GRACE_MS` | `2000` |
| `DEFAULT_LOG_LEVELS` | `['debug', 'info', 'warn', 'error']` |
| `GAUGE_AGGREGATES` | `['last', 'min', 'max', 'sum', 'count']` |
| `TIMER_AGGREGATES` | `['min', 'max', 'sum', 'count']` |
| `RESERVED_EVENT_COLUMNS` | `['id', 'ts', '_ingested_at', '_sample_rate']` |
| `RESERVED_LOG_COLUMNS` | `['id', 'ts', 'level', 'message', 'error_stack', '_ingested_at', '_sample_rate']` |
| `DURATION_FIELD` | `'duration_ms'` |

## Driver helpers

| Export | What it does |
| --- | --- |
| `isGaugeCell(cell)` | Is this stored value a gauge fold |
| `isLevelCell(cell)` | Is this stored value a level's held value |
| `isBucketClaim(claim)` | Is this claim folded data |
| `isRecordClaim(claim)` | Is this claim staged records |
| `isEmptyClaim(claim)` | Does this claim carry nothing |
| `NOTHING_RECOVERED` | A `RecoveryReport` of zeros, for a driver whose `recover()` has nothing to put back |

## Extension points

These exist so that a new metric type or a custom driver can be written outside
the package. Most applications never touch them.

| Export | What it is |
| --- | --- |
| `bucketedLifecycle(options)` | The claim and settle half of a folded metric |
| `bucketedReader(options)` | The live read half of a folded metric |
| `stagedMetric(name, config, kind)` | The whole lifecycle for a record keeping metric |
| `metricFlush(options)` | The cadence and retry logic every type shares |
| `shipClaim(metric, claim, sink, options)` | One claim, from materialise to settle |
| `shipOpenSeries(options)` | One open series sent without claiming it |
| `applySnapshot(rows, options, context)` | Filter, collapse, order and cut, as pure code |
| `snapshotRange(options, resolutionMs, nowMs)` | The window a snapshot should ask for |
| `liveness(bucketTs, resolutionMs, nowMs)` | Is this window open, and how far into it are we |
| `resolveDelivery(config, capabilities)` | Turn `'auto'` into a concrete mode |
| `MAX_CARRY_BUCKETS` | The most windows one flush carries a level through, so returning from downtime leaves a gap |

`log` is built on `stagedMetric`, and `timer` on `gauge`, so both are worked
examples of what these are for.

## Types

All of these are exported as types from `metrichouse/core`.

**Metric shapes**
`Counter`, `CounterConfig`, `CounterRow`, `CounterLiveRow`,
`Gauge`, `GaugeConfig`, `GaugeRow`, `GaugeLiveRow`, `GaugeAggregate`, `GaugeTotals`,
`Level`, `LevelConfig`, `LevelRow`, `LevelLiveRow`,
`Event`, `EventConfig`, `EventRow`, `EventLiveRow`, `EventStage`, `EventBatchConfig`,
`DeriveFn`, `DeriveTarget`,
`Log`, `LogConfig`, `LogRow`, `LogLiveRow`, `LogWriters`, `ChildLog`, `LogFieldsArgs`, `DefaultLogLevels`,
`Timer`, `TimerConfig`, `TimerHandle`, `TimeArgs`

**Shared**
`AnyMetric`, `MetricKind`, `StorageModel`, `MetricBinding`, `DimsArgs`,
`Row`, `RowShape`, `RowColumn`, `WriteFn`, `WriteContext`, `MaterializedBatch`

**Runtime**
`House`, `HouseConfig`, `HouseDefaultsConfig`, `HouseSnapshot`,
`HouseSnapshotOptions`, `SchemaInput`, `Scheduler`, `SchedulerOptions`,
`DeliveryMode`, `DeliveryConfig`, `HouseDefaults`,
`FlushOptions`, `FlushReport`, `FlushSkipReason`, `HouseFlushOptions`,
`MetricFlushOptions`, `MetricFlushReport`

**Reading**
`SnapshotOptions`, `LiveRow`, `LiveRowOf`, `LiveFields`, `LiveDims`,
`LiveIdentity`, `TypedSnapshot`, `RollupMode`, `Direction`, `BucketedRow`,
`MergeValues`

**Schema**
`FieldType`, `Shape`, `ShapeArgs`, `TypeKind`, `InferShape`, `InferValue`,
`RequiredKeys`, `MarkOptional`, `Simplify`

**Drivers**
`Driver`, `DriverCapabilities`, `Cell`, `GaugeCell`, `LevelCell`, `LevelSeries`, `BucketRow`, `BucketQuery`,
`PendingQuery`, `StagedRecord`, `Claim`, `BucketClaim`, `RecordClaim`,
`ClaimedBucket`, `IncrOp`, `GaugeOp`, `LevelOp`, `AppendOp`, `RecoveryReport`, `Hasher`

**Extension points**
`BatchLifecycle`, `BucketedOptions`, `BucketedReader`, `BucketedReaderOptions`,
`OpenSeriesShip`, `ShipOutcome`

**Driver entry points**
`MemoryDriverOptions` from `metrichouse/memory`.
`IoredisClient`, `IoredisDriver`, `IoredisDriverOptions`, `IoredisPipeline`,
`IoredisSource` from `metrichouse/ioredis`.
