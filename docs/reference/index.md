# API index

Everything the package exports, grouped by what you would reach for it.

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

| Export | Signature |
| --- | --- |
| `counter` | `counter(name, config): Counter` |
| `gauge` | `gauge(name, config): Gauge` |
| `event` | `event(name, config): Event` |
| `log` | `log(name, config): Log` |
| `timer` | `timer(name, config): Timer` |

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
| `createHouse(config)` | Binds a driver to a schema |
| `createScheduler(options)` | The timer machinery behind `house.start()` |

## Reading

| Export | What it does |
| --- | --- |
| `metric.current(...)` | The window still filling |
| `metric.snapshot(options?)` | Everything unshipped, as rows |
| `house.snapshot(options?)` | The same across every metric |
| `house.current()` | Just the open windows, folded metrics only |
| `event.pending()` | How many records are staged |
| `event.peek(n?)` | The first n staged records, without consuming them |

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
| `isGaugeCell(cell)` | Is this stored value a gauge fold rather than a counter |
| `isBucketClaim(claim)` | Is this claim folded data |
| `isRecordClaim(claim)` | Is this claim staged records |
| `isEmptyClaim(claim)` | Does this claim carry nothing |

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

`log` is built on `stagedMetric`, and `timer` on `gauge`, so both are worked
examples of what these are for.

## Types

All of these are exported as types from `metrichouse/core`.

**Metric shapes**
`Counter`, `CounterConfig`, `CounterRow`, `CounterLiveRow`,
`Gauge`, `GaugeConfig`, `GaugeRow`, `GaugeLiveRow`, `GaugeAggregate`, `GaugeTotals`,
`Event`, `EventConfig`, `EventRow`, `EventLiveRow`, `EventStage`, `EventBatchConfig`,
`Log`, `LogConfig`, `LogLiveRow`, `LogWriters`, `ChildLog`, `LogFieldsArgs`, `DefaultLogLevels`,
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
`Driver`, `DriverCapabilities`, `Cell`, `GaugeCell`, `BucketRow`, `BucketQuery`,
`PendingQuery`, `StagedRecord`, `Claim`, `BucketClaim`, `RecordClaim`,
`ClaimedBucket`, `IncrOp`, `GaugeOp`, `AppendOp`, `Hasher`

**Driver entry points**
`MemoryDriverOptions` from `metrichouse/memory`.
`IoredisClient`, `IoredisDriver`, `IoredisDriverOptions`, `IoredisPipeline`,
`IoredisSource` from `metrichouse/ioredis`.
