---
'metrichouse': minor
---

Add the `event` primitive, and the staged-record storage model underneath it.

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
