/**
 * Coldchain metric schema — written against MetricHouse *after* the Tollgate
 * revisions. Gaps found here are marked `FLAW Cnn` and explained in FINDINGS.md.
 */
import {
  counter, gauge, level, distinct, event, log,
  str, int, float, oneOf, json,
  defineDefaults,
} from 'metrichouse'
import { ch } from '../lib/clickhouse'

// The #12 fix, working exactly as intended. Declared once, on every metric,
// filled in by house.bind() and never repeated at a call site.
const defaults = defineDefaults({
  resolution: '60s',
  flush: '5m',
  grace: '10s',
  dims: {
    fleet: str(),
    region: str().lowCardinality(),   // the #09 fix — open set, narrow storage
    firmware: str().lowCardinality(),
  },
})

// ---------------------------------------------------------------------------
// Temperature — the regulated measurement
// ---------------------------------------------------------------------------

// FLAW C05 — cardinality is per-container and irreducible. 100,000 containers
// is 100,000 series, and no roll-up helps because the compliance question is
// always about one container. `metrichouse cost` correctly refuses this at 1s
// resolution; at 60s it passes at 100k rows per flush, ~29 GB/year before
// compression. There is no `rollupAfter` and no TTL-with-aggregation in the
// generated DDL, so the 7-year retention story is hand-written SQL.
export const tempC = gauge('temp_c', {
  ...defaults,
  dims: { ...defaults.dims, containerId: str(), sensor: oneOf(['supply', 'return', 'ambient'] as const) },
  aggregate: ['last', 'min', 'max', 'sum', 'count'],
  write: async (rows) => ch.insert('temp_c', rows),
})

export const humidityPct = gauge('humidity_pct', {
  ...defaults,
  dims: { ...defaults.dims, containerId: str() },
  aggregate: ['last', 'min', 'max', 'sum', 'count'],
  write: async (rows) => ch.insert('humidity_pct', rows),
})

// ---------------------------------------------------------------------------
// Compressor duty — a float counter, which now exists
// ---------------------------------------------------------------------------

// The #01 fix. Duty cycle is a fraction of a minute; before `value: float()`
// this was another micro-unit column with the unit in the name.
export const compressorMinutes = counter('compressor_minutes', {
  ...defaults,
  value: float(),
  dims: { ...defaults.dims, containerId: str() },
  write: async (rows) => ch.insert('compressor_minutes', rows),
})

// ---------------------------------------------------------------------------
// Doors open — a level, which now exists
// ---------------------------------------------------------------------------

// The #03 fix, and the workload that exposes its cost. `level()` keeps a
// running total per series that is never flushed and never deleted.
//
// FLAW C06 — with 100k containers the `total` hash is 100k permanent fields,
// and `evictAtZero` does not help: a closed door is level 0, which is the
// state 99% of containers are in 99% of the time, so eviction churns the key
// on every open/close. A container that leaves the fleet leaks its field
// forever unless something calls `.reset()`, and nothing knows when that is.
export const doorsOpen = level('doors_open', {
  ...defaults,
  resolution: '60s',
  dims: { ...defaults.dims, containerId: str() },
  evictAtZero: false,          // see above — eviction is worse here
  write: async (rows) => ch.insert('doors_open', rows),
})

// ---------------------------------------------------------------------------
// Excursions — time above threshold
// ---------------------------------------------------------------------------

// FLAW C04 — this works, and it half-works.
//
// "How many minutes was this container above -15C" is expressible: accumulate
// elapsed milliseconds into a counter when the excursion *ends*. No new
// primitive needed, which is the right answer — see FINDINGS.
//
// What does not work is the live view. An excursion that started three hours
// ago and is still running has contributed nothing to this counter, because
// nothing has ended. The dashboard that most needs to show it shows zero.
// compliance/excursions.ts carries the workaround.
export const excursionMs = counter('excursion_ms', {
  ...defaults,
  resolution: '60s',
  flush: '5m',
  dims: {
    ...defaults.dims,
    containerId: str(),
    threshold: oneOf(['above_max', 'below_min'] as const),
    severity: oneOf(['minor', 'major', 'critical'] as const),
  },
  write: async (rows) => ch.insert('excursion_ms', rows),
})

// ---------------------------------------------------------------------------
// Reporting containers — a distinct, which now exists
// ---------------------------------------------------------------------------

// The `distinct()` addition, doing exactly what it was added for: "how many
// containers have reported in the current window" is not derivable from any
// counter, and the reading events are far too voluminous to keep unsampled.
export const reporting = distinct('reporting_containers', {
  ...defaults,
  of: str(),
  resolution: '5m',
  flush: '15m',
  dims: { ...defaults.dims },
  write: async (rows) => ch.insert('reporting_containers', rows),
})

// ---------------------------------------------------------------------------
// Readings — the regulated event stream
// ---------------------------------------------------------------------------

// The #04 and #08 fixes together. `derive` keeps the aggregates exact and
// removes the six-hand-maintained-writes problem from Tollgate entirely.
//
// Note `sample: 1.0`. Compliance data cannot be sampled, and the config being
// explicit is better than it being absent — a reviewer can see the decision.
export const reading = event('reading', {
  fields: {
    ...defaults.dims,
    containerId: str(),
    sensor: str(),
    tempC: float(),
    humidityPct: float(),
    doorOpen: str(),
    compressorDuty: float(),
    batteryPct: float().optional(),
    gps: json<{ lat: number; lon: number; hdop: number }>().optional(),

    // FLAW C02 — the device clock is not trustworthy and there is nowhere
    // standard to say so. `ts` is whatever the device claimed. These two
    // columns are hand-declared, hand-populated, and every other MetricHouse
    // user with an untrusted clock will invent their own names for them.
    deviceTs: int(),
    ingestedTs: int(),
    clockSkewMs: int(),
  },

  derive: {
    temp_c: (e) => [{ dims: { containerId: e.containerId, sensor: e.sensor }, value: e.tempC }],
    compressor_minutes: (e) => [{ dims: { containerId: e.containerId }, value: e.compressorDuty }],
    reporting_containers: (e) => [{ dims: {}, value: e.containerId }],
  },

  sample: 1.0,
  stage: 'redis',
  flush: '1m',
  write: async (rows) => ch.insert('reading', rows),
})

export const deviceLog = log('device_log', {
  fields: { ...defaults.dims, containerId: str().optional() },
  minLevel: 'info',
  stage: 'memory',
  batch: { maxSize: 500, maxAge: '10s' },
  write: async (rows) => ch.insert('device_log', rows),
})
