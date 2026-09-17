# Redis driver

The Redis driver is the shared, durable backend: writes go straight to Redis pipelined, with no local buffer, so every instance contributes to the same bucket and a live read is globally exact. Claimed buckets survive a process crash and are only deleted after your write function resolves, which is what makes flush at-least-once.

## Named for the client, not the database

Shipped as **`ioredis(client)`**, not `redis(client)`.

The original sketch here had one `redis()` taking "a `node-redis` or `ioredis`
client". Building it showed why that is a trap: the two clients agree on
nothing at the surface — `hincrby` against `hIncrBy`, `pipeline()` against
`multi()`, positional `eval` against an options object — so one function
serving both is either a translation layer pretending to be a driver, or a
function that silently works better with one of them.

Naming the driver after its client keeps the promise narrow and true, and
leaves `nodeRedis()` and `httpRedis()` free for whoever writes them. They will
not be starting from nothing: [`contract.ts`](../../packages/metrichouse/src/drivers/contract.ts)
is the whole driver contract as an executable suite, and it is what says
whether a new backend is finished.

**Redis Cluster is not supported yet.** Every script here touches one key, so
the Lua is already crossslot-safe, but pipelines still span the bucket hash and
the index. Hash-tagging the namespace is the fix, and nothing in the key layout
below blocks it.

## Main functions

**Construction**
- `ioredis(client, opts?)` — an `ioredis` client you already own, or a `() => Client | Promise<Client>` factory called on first write rather than at module scope
- `httpRedis({ url, token }, opts?)` — *not built.* The same driver over Redis REST (Upstash and compatible), for edge runtimes with no TCP sockets; pipelines become batched HTTP calls, and `capabilities` are identical

The client is typed **structurally** — `IoredisClient` describes only the
commands the driver calls — so `ioredis` stays an *optional* peer dependency
and an app on `metrichouse/memory` never installs it.

Opts:
- `namespace` — key prefix, default `mh`
- `maxPipelineSize` — commands per round trip, default `1000`; also the page size for a bounded `readPending`

Deferred, with the feature behind them: `claimTtl` (waits on `recoverStale`),
`pipelineWindow` (coalescing belongs to `runtime/delivery.ts`, not here).

**Driver interface** — see [09-drivers.md](09-drivers.md) for full signatures
- `increment` — `HINCRBYFLOAT`, pipelined
- `observe` — Lua `MERGE_GAUGE`, because `min`/`max`/`last` are read-modify-write
- `append` — `RPUSH` to a list per metric
- `claim` / `claimRecords` / `ack` / `release` — Lua, atomic move into an in-flight key
- `readBuckets` / `readPending` / `countPending` — unflushed data only

**Introspection**
- `.keyFor(metric, bucketTs)` — the exact key, so you can inspect in `redis-cli`
- `.scanSeries(metric)` — distinct dim keys currently live, for watching cardinality

## Key layout

```
{ns}:b:{metric}:{bucketTs}        HASH   dimKey -> cell
{ns}:idx:{metric}                 ZSET   bucketTs -> bucketTs (which buckets exist)
{ns}:e:{metric}                   LIST   JSON records, oldest at the head
{ns}:inflight:{claimId}           HASH   claimed buckets, awaiting ack
                                  LIST   claimed records, awaiting ack
{ns}:claims:{metric}              ZSET   claimId -> claimedAt
{ns}:seq                          STRING INCR, mints claim ids
```

A **cell** is either a counter's scalar (`"7"`) or a gauge's packed fold
(`"last|min|max|sum|count"`). Five differences from the sketch this file used
to carry, each one found by building it:

- **One `b:` prefix, not `c:` and `g:`.** `readBuckets(query)` takes a metric
  name and nothing else — the driver is not told whether it is serving a
  counter or a gauge, and it should not be. Separate prefixes would mean
  querying both and merging, and a `claim` would have to rename two keys into
  one in-flight hash anyway, losing the distinction at exactly the moment it
  was supposed to matter. One key, and the *value* says which kind it is —
  which is what `Cell = number | GaugeCell` already said in the types.
- **`HINCRBYFLOAT`, not `HINCRBY`.** A counter may declare `float()`, and
  `HINCRBY` refuses `0.5`. Integer counts are exact in an f64 to 2^53, and
  `delta: number` was an f64 before it ever reached Redis.
- **A LIST for records, not a STREAM.** `release` must return claimed records
  to the **front** of the queue, because they are older than anything appended
  while they were in flight. A stream's ids are monotonic, so prepending to one
  is not possible once anything else has arrived. Consumer groups would solve
  it a different way, but then bucket claims and record claims would need two
  separate staleness mechanisms; `{ns}:claims:{metric}` is one, for both. The
  stream's id generation bought nothing either — `AppendOp.id` is minted by the
  metric, on purpose.
- **In-flight is keyed by claim, not by metric and claim.** `{ns}:inflight:{claimId}`,
  where the id is already `{metric}#{n}`. One key to build, one to delete.
- **The claims ZSET registers even an empty claim.** An empty claim is still a
  claim that must be settled exactly once, and the `ZREM` returning 0 is what
  makes a double-ack an error rather than a silent no-op.

`%.17g`, not Lua's default `tostring`. Lua 5.1 formats numbers at `%.14g`, so a
fold that round-trips through a packed string would lose the bottom bits of
every `sum` on every observation. Seventeen significant digits is what an f64
needs to survive the trip unchanged, and
[`contract.ts`](../../packages/metrichouse/src/drivers/contract.ts) pins it
with `0.1 + 0.2`.

A `Date` in a record's `fields` is tagged on the way out and rebuilt on the way
back. `fields` is opaque to the driver but not to `JSON`, and a declared `ts()`
field reaches storage as a real `Date` — plain `JSON.stringify` would hand the
metric a string to put in a column that wants a date, and nothing would report
it.

## Lua scripts

- `MERGE_GAUGE` — folds a batch of observations into packed `last|min|max|sum|count` fields, one bucket per call
- `CLAIM_BUCKETS` — reads `idx`, moves every bucket below the watermark into one in-flight key, registers the claim, in one round trip
- `ACK_CLAIM` — drops the claim entry and deletes the in-flight key
- `RELEASE_BUCKETS` — merges in-flight data back into live buckets (they may have moved on) and drops the claim
- `CLAIM_RECORDS` / `RELEASE_RECORDS` — the same handshake for the staged list, releasing to the front

Scripts are `SCRIPT LOAD`ed once and called by SHA. A `NOSCRIPT` — a restart, a
`SCRIPT FLUSH` — invalidates every SHA at once, so the recovery is to drop the
whole cache and replay the batch rather than unpick which call failed.

## In use

```ts
import { createHouse, ioredis } from 'metrichouse'
import { Redis } from 'ioredis'
import * as schema from './schema'

const client = new Redis(process.env.REDIS_URL)

export const house = createHouse({
  driver: ioredis(client, {
    namespace: 'dogwalk',
    maxPipelineSize: 1000,
  }),
  schema,
})
```

Three app instances, one bucket — no coordination needed:

```
instance-a  dogPoops.add({ dogName:'Willow', park:'riverside' })  ─┐
instance-b  dogPoops.add({ dogName:'Willow', park:'riverside' })  ─┼→ HINCRBYFLOAT
instance-c  dogPoops.add({ dogName:'Rex',    park:'riverside' })  ─┘

HGETALL dogwalk:b:dog_poops:1757081587
  1) "Willow|riverside"  2) "2"
  3) "Rex|riverside"     4) "1"
```

Swapping from the single-process driver is one line, and **adds** a guarantee
while **removing** a guard — see [11-driver-memory.md](11-driver-memory.md):

```diff
- driver: memory({ maxSeries: 50_000 }),
+ driver: ioredis(client),
```

## Testing

Needs a real server; `REDIS_URL`, or localhost:6379. Without one the driver's
test file reports as skipped rather than failing, so a contributor with no
Redis can still run `pnpm test` and trust the result. CI runs `redis:7` as a
service across the whole Node matrix.

A fake was considered and rejected: a fake that passes proves nothing about Lua
atomicity or the claim handshake, which are the only parts of this driver that
are hard.
