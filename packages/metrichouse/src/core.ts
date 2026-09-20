/**
 * metrichouse/core — declare, write, drain, live read, identity.
 *
 * Everything an application calls at runtime. No SQL, no filesystem, no build
 * tooling: this entry point must stay small enough to ship to an edge bundle.
 */

export type {
  AppendOp,
  BucketClaim,
  BucketQuery,
  BucketRow,
  Cell,
  Claim,
  ClaimedBucket,
  Driver,
  DriverCapabilities,
  GaugeCell,
  GaugeOp,
  IncrOp,
  LevelCell,
  LevelOp,
  LevelSeries,
  PendingQuery,
  RecordClaim,
  RecoveryReport,
  StagedRecord,
} from './drivers/types.js'
// the driver contract, for anyone implementing a backend
export {
  isBucketClaim,
  isEmptyClaim,
  isGaugeCell,
  isLevelCell,
  isRecordClaim,
  NOTHING_RECOVERED,
} from './drivers/types.js'
export type { Hasher } from './identity.js'
// identity — public so a sink can reproduce a row id, and so a custom hasher
// can be installed before anything writes
export { getHasher, hash, naturalKey, rowId, setHasher, uuidv7 } from './identity.js'
export type {
  BatchLifecycle,
  BucketedOptions,
  BucketedReader,
  BucketedReaderOptions,
} from './metrics/bucketed.js'
// the shared aggregate lifecycle and its read half, for anyone adding a
// primitive — the staged counterpart is `stagedMetric`, below
export { bucketedLifecycle, bucketedReader, DEFAULT_GRACE_MS } from './metrics/bucketed.js'
export type {
  Counter,
  CounterConfig,
  CounterLiveRow,
  CounterRow,
} from './metrics/counter.js'
// primitives
export { counter } from './metrics/counter.js'
export type {
  DeriveFn,
  DeriveTarget,
  Event,
  EventBatchConfig,
  EventConfig,
  EventLiveRow,
  EventRow,
  EventStage,
} from './metrics/event.js'
export { event, RESERVED_EVENT_COLUMNS, stagedMetric } from './metrics/event.js'
export type {
  Gauge,
  GaugeAggregate,
  GaugeConfig,
  GaugeLiveRow,
  GaugeRow,
  GaugeTotals,
} from './metrics/gauge.js'
export { GAUGE_AGGREGATES, gauge } from './metrics/gauge.js'
export type {
  Level,
  LevelConfig,
  LevelLiveRow,
  LevelRow,
} from './metrics/level.js'
export { level, MAX_CARRY_BUCKETS } from './metrics/level.js'
export type {
  ChildLog,
  DefaultLogLevels,
  Log,
  LogConfig,
  LogFieldsArgs,
  LogLiveRow,
  LogRow,
  LogWriters,
} from './metrics/log.js'
export { DEFAULT_LOG_LEVELS, log, RESERVED_LOG_COLUMNS } from './metrics/log.js'
export type { TimeArgs, Timer, TimerConfig, TimerHandle } from './metrics/timer.js'
export { DURATION_FIELD, TIMER_AGGREGATES, timer } from './metrics/timer.js'
export type {
  AnyMetric,
  DimsArgs,
  MaterializedBatch,
  MetricBinding,
  MetricKind,
  Row,
  RowColumn,
  RowShape,
  StorageModel,
  WriteContext,
  WriteFn,
} from './metrics/types.js'
// delivery — how a house gets rows out, as opposed to what a metric measures
export type { DeliveryConfig, DeliveryMode, HouseDefaults } from './runtime/delivery.js'
export { resolveDelivery } from './runtime/delivery.js'
export type {
  FlushOptions,
  FlushReport,
  FlushSkipReason,
  HouseFlushOptions,
  MetricFlushOptions,
  MetricFlushReport,
} from './runtime/flush.js'
// the flush half of a metric, for anyone adding a primitive — the storage
// halves are `bucketedLifecycle` and `stagedMetric`
export { metricFlush } from './runtime/flush.js'
export type {
  House,
  HouseConfig,
  HouseDefaultsConfig,
  HouseSnapshot,
  HouseSnapshotOptions,
  SchemaInput,
} from './runtime/house.js'
// runtime
export { createHouse } from './runtime/house.js'
// live read — the snapshot engine is pure, and exported so a custom primitive
// can reuse it rather than reimplement rollup and top-K
export type {
  BucketedRow,
  Direction,
  LiveDims,
  LiveFields,
  LiveIdentity,
  LiveRow,
  LiveRowOf,
  MergeValues,
  RollupMode,
  SnapshotOptions,
  TypedSnapshot,
} from './runtime/live.js'
export { applySnapshot, liveness, snapshotRange } from './runtime/live.js'
export type { Scheduler, SchedulerOptions } from './runtime/scheduler.js'
export { createScheduler } from './runtime/scheduler.js'
export type { OpenSeriesShip, ShipOutcome } from './runtime/ship.js'
export { shipClaim, shipOpenSeries } from './runtime/ship.js'
export type {
  FieldType,
  InferShape,
  InferValue,
  MarkOptional,
  RequiredKeys,
  Shape,
  ShapeArgs,
  Simplify,
  TypeKind,
} from './schema/types.js'
// declaration
export { bool, float, int, json, oneOf, str, ts } from './schema/types.js'
