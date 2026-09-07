/**
 * Device clock normalisation.
 *
 * A reefer controller's RTC drifts, loses power, and occasionally reports
 * 1970 or 2038. Every timestamp arriving from a device is a claim, not a fact.
 */
import { deviceLog } from '../metrics/schema'

const MAX_TRUSTED_SKEW_MS = 5 * 60_000

/**
 * FLAW C02 — a row has one timestamp, and this workload needs two.
 *
 * MetricHouse rows carry `ts` (events) or `bucket_ts` (aggregates), and `at:`
 * sets it. There is no reserved place for "when did this reach us", so
 * schema.ts hand-declares `deviceTs`, `ingestedTs` and `clockSkewMs` as
 * ordinary fields.
 *
 * That is workable but it means:
 *   - every ingest-shaped MetricHouse user invents different column names
 *   - `metrichouse inspect` cannot show ingest lag, because it does not know
 *     which column means that
 *   - a backfilled row is indistinguishable from a live one after the fact,
 *     which for a regulated dataset is exactly the audit question
 *
 * A reserved `_ingested_at`, written by the driver on every row and never by
 * the caller, costs one column and answers all three.
 */
export function normalizeClock(r: RawReading, receivedAt: number) {
  const skew = receivedAt - r.deviceTs

  if (Math.abs(skew) > MAX_TRUSTED_SKEW_MS) {
    deviceLog.warn('device clock skew', {
      containerId: r.containerId,
      // and the skew value itself has nowhere structured to go
    })
  }

  // A device that reports the future is clamped; `at:` would reject it with
  // INVALID_TIMESTAMP, which for a batch of 51,840 readings means finding the
  // one bad row by reading 51,840 warnings.
  const ts = r.deviceTs > receivedAt ? receivedAt : r.deviceTs

  return { ...r, ts, deviceTs: r.deviceTs, ingestedTs: receivedAt, clockSkewMs: skew }
}

export interface RawReading {
  containerId: string
  deviceTs: number
  sensor: string
  tempC: number
  humidityPct: number
  doorOpen: boolean
  compressorDuty: number
}
