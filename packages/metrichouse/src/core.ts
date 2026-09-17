/**
 * metrichouse/core — declare, write, drain, live read, identity.
 *
 * Everything an application calls at runtime. No SQL, no filesystem, no build
 * tooling: this entry point must stay small enough to ship to an edge bundle.
 *
 * Spec: initialPlan/01-schema.md, 03-counter.md, 05-events.md, 06-logs.md,
 *       08-house.md, 14-identity.md, 15-live-read.md, 25-packaging.md,
 *       26-timer.md
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
  PendingQuery,
  RecordClaim,
  StagedRecord,
} from './drivers/types.js'
// the driver contract, for anyone implementing a backend
export {
  isBucketClaim,
  isEmptyClaim,
  isGaugeCell,
  isRecordClaim,
} from './drivers/types.js'
export type { Hasher } from './identity.js'
// identity — public so a sink can reproduce a row id, and so a custom hasher
// can be installed before anything writes
export { getHasher, hash, naturalKey, rowId, setHasher, uuidv7 } from './identity.js'
export type { BatchLifecycle, BucketedOptions } from './metrics/bucketed.js'
// the shared aggregate lifecycle, for anyone adding a primitive — its staged
// counterpart is `stagedMetric`, below
export { bucketedLifecycle } from './metrics/bucketed.js'
export type { Counter, CounterConfig, CounterRow } from './metrics/counter.js'
// primitives
export { counter } from './metrics/counter.js'
export type {
  DeriveFn,
  DeriveTarget,
  Event,
  EventBatchConfig,
  EventConfig,
  EventRow,
  EventStage,
} from './metrics/event.js'
export { event, RESERVED_EVENT_COLUMNS, stagedMetric } from './metrics/event.js'
export type { Gauge, GaugeAggregate, GaugeConfig, GaugeRow, GaugeTotals } from './metrics/gauge.js'
export { GAUGE_AGGREGATES, gauge } from './metrics/gauge.js'
export type {
  ChildLog,
  DefaultLogLevels,
  Log,
  LogConfig,
  LogFieldsArgs,
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
  WriteContext,
  WriteFn,
} from './metrics/types.js'
export type {
  FlushOptions,
  FlushReport,
  FlushSkipReason,
  MetricFlushReport,
} from './runtime/flush.js'
export type { House, HouseConfig, SchemaInput } from './runtime/house.js'
// runtime
export { createHouse } from './runtime/house.js'
export type { ShipOutcome } from './runtime/ship.js'
export { shipClaim } from './runtime/ship.js'
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
