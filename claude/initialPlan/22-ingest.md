# Ingest

`ingest()` accepts rows that are already materialized — folded, identified, and shaped exactly as a flush would produce them — and hands them straight to the sink without touching buckets or claims. It is the flush pipeline minus the driver, and it exists because **late and historical are not the same thing**.

> Added after [Coldchain](../imagine/coldchain/FINDINGS.md) — flaws C01 and C03. A container offline for six days posted 51,840 readings at once; the [`at:`](07-buckets.md) rule collapsed all of them into the oldest open bucket.

## Late vs. historical

| | late | historical |
| --- | --- | --- |
| Describes | a period that is nearly closed | a period that is finished and flushed |
| Arrives | seconds behind | hours or days behind |
| Handled by | `at:` within `grace` | `ingest()` / `backfill()` |
| Goes through buckets | yes | **no** |
| Can be reordered | no | yes, it is already ordered |

Routing historical data through buckets is not a degraded version of the right
answer — it is a different and wrong answer, because a bucket that has shipped
cannot be reopened without breaking dedupe convergence.

## Main functions

**Raw historical data** — you have observations, MetricHouse folds them
- `house.backfill(metric, observations, opts?)` — bucket-aligns, folds gauge aggregates, assigns real deterministic ids, calls the sink
- `metric.backfill(observations, opts?)` — same, one metric

**Pre-materialized rows** — you have rows, MetricHouse validates and forwards
- `house.ingest(metricName, rows, opts?)` — shape-check against the schema, then straight to the sink
- `house.ingestBatch(batches, opts?)` — many metrics in one call

Opts:
- `rowBatch` / `yieldBetweenBatches` — as [flush](12-flush.md)
- `derive` — default `true` for `backfill`, `false` for `ingest`; a backfill runs the event's [`derive`](05-events.md) functions so aggregates and events do not disagree for the backfilled range
- `signal` — `AbortSignal`

**Report**
- `IngestReport` — `{ ok, rows, metrics, durationMs, rejected }`

## Validation

`ingest()` rejects a row that does not match the schema, rather than coercing
it: unknown column, missing dim, wrong type. Ids are **not** recomputed — the
sender's ids are trusted and forwarded, because recomputing them would break
the convergence that makes a retried upload safe.

`backfill()` computes ids itself, using the same hash as flush, so a backfilled
bucket and a live-flushed one for the same window collapse into one row.

## Federation

Because `ingest()` accepts exactly what `write()` emits, one house's sink can be
another house's ingest endpoint. That makes MetricHouse tierable — edge →
regional → cloud — with the [identity](14-identity.md) design providing
end-to-end idempotency across every hop, including retries over a bad link.

```
  ┌── vessel gateway ──┐        ┌──── cloud ────┐
  │  memory() driver   │        │ redis() driver│
  │  200 containers    │        │  100k devices │
  │                    │        │               │
  │  flush()           │        │  ingest()     │
  │    └─ write() ─────┼─HTTPS─▶│    └─ sink ──▶│ ClickHouse
  └────────────────────┘        └───────────────┘
        deterministic ids assigned here, trusted the whole way
```

## In use

```ts
// a device surfaces with six days of backlog
export async function ingestBacklog(batch: DeviceBatch) {
  const report = await house.backfill(reading, batch.readings.map(r => ({
    at: r.deviceTs,
    fields: { containerId: batch.containerId, sensor: r.sensor, tempC: r.tempC, ... },
  })))

  // derive ran, so temp_c and compressor_minutes are populated for the
  // backfilled range too — the aggregates do not disagree with the events
  return report   // { ok: true, rows: 51_840, metrics: ['reading','temp_c',…] }
}
```

```ts
// ship side — the sink is an uplink
export const edgeHouse = createHouse({
  driver: memory(),
  schema,
  write: async (rows, ctx) => uplink.post('/ingest', { metric: ctx.metric, rows }),
})

// cloud side — the endpoint is an ingest
app.post('/ingest', async (req, res) => {
  const report = await house.ingest(req.body.metric, req.body.rows)
  res.json(report)
})
```

A retried uplink sends identical ids, so the second delivery converges instead
of double-counting. Nothing in either process has to know a retry happened.
