# Sink

The sink is the one function you write: it receives a typed, flattened array of rows and puts them wherever you like. MetricHouse never opens a database connection of its own, which is what keeps ClickHouse, Postgres, Kafka, S3, and a plain `console.log` equally first-class.

> **The destination is entirely yours.** MetricHouse emits no SQL, generates no
> migrations, and never inspects what it is writing into. Creating the table,
> choosing its types, evolving it as your dims change, and making it collapse
> duplicate `id`s are all your side of the line. `rowShape()` and
> `InferRow<typeof metric>` below tell you exactly what arrives, which is the
> only contract there is — build the destination to match it.

## Main functions

**Declaration** — per metric, or fall back to the house
- `write(rows, ctx): Promise<void>` — on any metric config
- `write(rows, ctx): Promise<void>` — on `createHouse`, used by metrics that omit their own

**Context** — second argument
- `ctx.metric` — metric name, so a global sink can route by table
- `ctx.kind` — `'counter' | 'gauge' | 'level' | 'distinct' | 'event' | 'log'`
- `ctx.bucketFrom` / `ctx.bucketTo` — the window being shipped
- `ctx.attempt` — `1` on first try, higher after a previous release
- `ctx.batch` / `ctx.batchCount` — position in a `rowBatch`-split flush, so you can stream inserts
- `ctx.source` — `'flush' | 'backfill' | 'ingest'`, so a sink can route historical loads differently
- `ctx.signal` — `AbortSignal` from `flush({ signal })`

**Failure**
- Throw to signal failure. The claim is released and the same rows come back next flush with `ctx.attempt` incremented.
- `onWriteError(err, ctx)` on the house — observe without changing the outcome
- `retry` on a metric — `{ attempts: 3, backoff: '200ms' }`, retried inside one flush before releasing

**Row shapes**
- `metric.rowShape()` — the exact TypeScript type at runtime
- `InferRow<typeof metric>` — the same type, statically

## Row shapes by kind

```ts
// every row additionally carries `_ingested_at: Date`, stamped by the driver
// and never by the caller — the only way to tell a backfilled row from a live
// one, and the basis for any ingest-lag question

// counter — dims become real columns
{ id: string, bucket_ts: Date, ...dims, value: number }

// gauge — one column per declared aggregate
{ id: string, bucket_ts: Date, ...dims,
  last: number, min: number, max: number, sum: number, count: number }

// level — deltas, not levels; reconstruct with a window function
{ id: string, bucket_ts: Date, ...dims, delta: number }

// distinct — per-bucket count (not summable) plus the raw sketch
{ id: string, bucket_ts: Date, ...dims, approx_count: number, sketch: Buffer }

// event — declared fields, id and ts minted at record()
// `_sample_rate` is present only when the event declares `sample`
{ id: string, ts: Date, ...fields, _sample_rate?: number }

// log — event plus the three reserved fields
{ id: string, ts: Date, level: string, message: string, ...fields }
```

## In use

```ts
// per metric — its own table, fully typed rows
export const dogPoops = counter('dog_poops', {
  dims: { dogName: str(), park: str() },
  resolution: '1s',
  flush: '5m',

  // you own this. MetricHouse owns everything above it.
  write: async (rows) => {
    await ch.insert({ table: 'dog_poops', values: rows, format: 'JSONEachRow' })
  },
})
```

```ts
// global fallback — route by ctx.metric
createHouse({
  driver: redis(client),
  schema,
  write: async (rows, ctx) => {
    await ch.insert({ table: ctx.metric, values: rows, format: 'JSONEachRow' })
  },
  onWriteError: (err, ctx) => {
    console.error(`[metrichouse] ${ctx.metric} attempt ${ctx.attempt}`, err)
  },
})
```

```ts
// somewhere else entirely — the point of owning the function
export const auditLog = event('audit_log', {
  fields: { actorId: str(), action: str(), target: str() },
  stage: 'redis',
  write: async (rows) => {
    await kafka.send({ topic: 'audit', messages: rows.map(r => ({
      key: r.actorId, value: JSON.stringify(r),
    })) })
  },
})
```
