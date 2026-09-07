# Drivers

A driver is the storage contract for open buckets and staged events — increment, observe, append, read, claim, ack. Everything above it is driver-agnostic (schema, bucketing, row shaping, identity), so adding a backend is one interface, not a fork.

## Main functions

**Write path** — all batched, one round trip per call
- `increment(ops: IncrOp[]): Promise<void>` — `{ metric, bucketTs, dimKey, delta }`
- `observe(ops: GaugeOp[]): Promise<void>` — `{ metric, bucketTs, dimKey, value }`, folded into last/min/max/sum/count
- `append(ops: EventOp[]): Promise<void>` — `{ metric, id, ts, payload }`
- `adjust(ops: LevelOp[]): Promise<void>` — `{ metric, bucketTs, dimKey, delta }`, applied to both the bucket and the running total ([20-level.md](20-level.md))
- `addDistinct(ops: DistinctOp[]): Promise<void>` — `{ metric, bucketTs, dimKey, value }` into a sketch ([21-distinct.md](21-distinct.md))

**Read path** — [live read](15-live-read.md)
- `readBuckets(q): Promise<BucketRow[]>` — `{ metric, from?, to?, dimKey?, complete?, orderBy?, groupBy?, limit? }`; every row is tagged `bucket_open` and `bucket_elapsed_ms`
- `readTotals(metric, dimKey?): Promise<TotalRow[]>` — a level's running total, without scanning buckets
- `dumpTotals(metric): Promise<Record<string, number>>` / `restoreTotals(metric, map)` — persist and reseed level state across a restart ([20-level.md](20-level.md))
- `readPending(metric, limit?): Promise<EventRow[]>`

**Flush path** — [at-least-once](12-flush.md)
- `claim(metric, upToBucketTs, opts): Promise<Claim>` — atomically move closed buckets into an in-flight state
- `ack(claim, retentionMs?): Promise<void>` — delete the claimed data, or move it to a read-only TTL'd copy when the metric sets `retention`
- `release(claim): Promise<void>` — return it to claimable; called when `write()` throws
- `recoverStale(metric, olderThan): Promise<Claim[]>` — reclaim work orphaned by a crashed flusher

**Lifecycle**
- `drain(): Promise<void>` — resolve when every queued op has been issued and acknowledged; the basis of [`house.drain()`](24-runtimes.md)
- `close(): Promise<void>`
- `ping(): Promise<boolean>`

**Capabilities**
- `capabilities: { durable: boolean; shared: boolean; atomicMerge: boolean; sketches: boolean; retention: boolean }` — the house reads this to decide whether at-least-once is honestly available, and which primitives this driver can host

## What is implemented

Ten of the methods above exist today, in `packages/metrichouse/src/drivers/`.
The rest wait on the primitives that need them: `adjust`/`readTotals`/
`dumpTotals`/`restoreTotals` on [`level`](20-level.md), `addDistinct` on
[`distinct`](21-distinct.md), `recoverStale` on a driver where a claim can
outlive the process that took it.

```
increment  observe  append          write path
readBuckets  readPending  countPending    read path
claim  claimRecords  ack  release      flush path
```

Three differences from the sketch above, all found by building it:

- **`claim` takes a watermark; `claimRecords` takes a limit.** They are separate
  methods because the storage models are separate. Whether a *bucket* may ship
  is a question about time — it may still be open, or inside grace. A *record*
  is complete the instant it is appended, so the only question left is how many
  to carry at once, and that is what bounds a backlog larger than the sink will
  accept.
- **`append` carries `fields`, not `payload`.** One word for one concept:
  `event({ fields })` declares them, so the op that carries them says the same
  thing. The driver still treats them as opaque and never reads inside.
- **`readPending` takes a query object**, like `readBuckets`, rather than
  positional arguments — and `countPending` is split out of it, because `XLEN`
  and `XRANGE` are different calls and counting a million staged rows by
  dragging them over the wire should not be the easy path.

`capabilities` is three flags, not five: `sketches` and `retention` describe
features no primitive has asked for yet.

## The claim/ack contract

This is the whole durability story, and it is the only thing a new driver must get exactly right:

```
claim  → data moves to in-flight, no longer visible to live read or a second claim
write  → your function runs
  ok   → ack     → data deleted
  fail → release → data claimable again next flush()
  crash→ recoverStale() picks it up after the claim TTL expires
```

A driver whose `capabilities.durable` is `false` may implement `claim` as a plain read-and-hold — that is what makes the memory driver best-effort rather than at-least-once.

## In use

```ts
import type { Driver } from 'metrichouse'

export function myDriver(conn: MyConn): Driver {
  return {
    capabilities: { durable: true, shared: true, atomicMerge: true },

    async increment(ops) {
      const tx = conn.pipeline()
      for (const op of ops) {
        tx.hincrby(`mh:${op.metric}:${op.bucketTs}`, op.dimKey, op.delta)
      }
      await tx.exec()
    },

    async observe(ops) { /* atomic last/min/max/sum/count merge */ },
    async append(ops)  { /* durable append */ },

    async readBuckets(q) { /* unflushed only */ return [] },
    async readPending(metric, limit) { return [] },

    async claim(metric, upTo)  { /* move to in-flight, return Claim */ },
    async ack(claim)           { /* delete */ },
    async release(claim)       { /* return to claimable */ },
    async recoverStale(metric, olderThan) { return [] },

    async ping()  { return true },
    async close() { await conn.quit() },
  }
}
```

```ts
createHouse({ driver: myDriver(conn), schema })
```
