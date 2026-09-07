# Redis driver

The Redis driver is the shared, durable backend: writes go straight to Redis pipelined, with no local buffer, so every instance contributes to the same bucket and a live read is globally exact. Claimed buckets survive a process crash and are only deleted after your write function resolves, which is what makes flush at-least-once.

## Main functions

**Construction**
- `redis(client, opts?)` — accepts a `node-redis` or `ioredis` client you already own, or a `() => Promise<Client>` factory called on first write rather than at module scope
- `httpRedis({ url, token }, opts?)` — the same driver over Redis REST (Upstash and compatible), for edge runtimes with no TCP sockets; pipelines become batched HTTP calls, and `capabilities` are identical

Opts:
- `namespace` — key prefix, default `mh`
- `claimTtl` — how long a claim may sit before `recoverStale` may take it, default `'60s'`
- `pipelineWindow` — microtask window for coalescing writes, default one event-loop tick
- `maxPipelineSize` — flush the pipeline early past this many ops, default `1000`

**Driver interface** — see [09-drivers.md](09-drivers.md) for full signatures
- `increment` — `HINCRBY`, or `HINCRBYFLOAT` for a `value: float()` counter, pipelined
- `observe` — Lua `MERGE_GAUGE`, because `min`/`max`/`last` are read-modify-write
- `append` — `XADD` to a stream per event type
- `adjust` — Lua `APPLY_DELTA`, one script touching both the bucket delta and the running total
- `addDistinct` — `PFADD`, one call per op, pipelined
- `claim` / `ack` / `release` / `recoverStale` — Lua `CLAIM_BUCKETS`, atomic rename into an in-flight key
- `readBuckets` / `readPending` — unflushed data only

**Introspection**
- `.keyFor(metric, bucketTs)` — the exact key, so you can inspect in `redis-cli`
- `.scanSeries(metric)` — distinct dim keys currently live, for watching cardinality

## Key layout

```
{ns}:c:{metric}:{bucketTs}        HASH    dimKey -> Int64 count (or float)
{ns}:g:{metric}:{bucketTs}        HASH    dimKey -> "last|min|max|sum|count"
{ns}:l:{metric}:{bucketTs}        HASH    dimKey -> delta
{ns}:l:{metric}:total             HASH    dimKey -> current level  (never flushed)
{ns}:d:{metric}:{bucketTs}:{dim}  HLL     PFADD values
{ns}:e:{metric}                   STREAM  event payloads
{ns}:idx:{metric}                 ZSET    bucketTs -> bucketTs (which buckets exist)
{ns}:lastflush:{metric}           STRING  epoch ms, enforces the `flush` cadence
{ns}:inflight:{metric}:{claimId}  HASH    claimed data, awaiting ack
{ns}:claims:{metric}              ZSET    claimId -> claimedAt (for recoverStale)
{ns}:ret:{metric}:{bucketTs}      HASH    acked copy, EXPIRE `retention`  (read-only)
```

`{ns}:l:{metric}:total` is the one key with unbounded lifetime — see
[20-level.md](20-level.md) for why, and `evictAtZero` for the knob.

## Lua scripts

- `MERGE_GAUGE` — folds one observation into a packed `last|min|max|sum|count` field atomically
- `CLAIM_BUCKETS` — reads `idx`, renames every bucket at or below the watermark into one in-flight key, registers the claim, all in one round trip
- `ACK_CLAIM` — deletes the in-flight key and its claim entry
- `RELEASE_CLAIM` — merges in-flight data back into live buckets (it may have moved on) and drops the claim

## In use

```ts
import { createHouse, redis } from 'metrichouse'
import { createClient } from 'redis'
import * as schema from './schema'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

export const house = createHouse({
  driver: redis(client, {
    namespace: 'dogwalk',
    claimTtl: '60s',
    maxPipelineSize: 1000,
  }),
  schema,
})
```

Three app instances, one bucket — no coordination needed:

```
instance-a  dogPoops.add({ dogName:'Willow', park:'riverside' })  ─┐
instance-b  dogPoops.add({ dogName:'Willow', park:'riverside' })  ─┼→ HINCRBY
instance-c  dogPoops.add({ dogName:'Rex',    park:'riverside' })  ─┘

HGETALL dogwalk:c:dog_poops:1757081587
  1) "Willow|riverside"  2) "2"
  3) "Rex|riverside"     4) "1"
```
