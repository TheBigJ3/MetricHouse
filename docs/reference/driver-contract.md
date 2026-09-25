# Driver contract

A driver is where running totals and staged records live between a write and a
flush. The interface is fourteen methods and one `capabilities` property.
Implementing it is how you put MetricHouse on storage it does not ship with.

```ts
import type { Driver } from 'metrichouse/core'
```

Most applications never read this page. Use [`memory()` or
`ioredis()`](/guide/drivers) unless you have a reason not to.

## The shape

```ts
export function myDriver(): Driver {
  return {
    capabilities: { durable: true, shared: true, atomicMerge: true },

    async increment(ops) {},
    async observe(ops) {},
    async setLevel(ops) {},
    async append(ops) {},

    async readLevels(metric) { return [] },
    async dropLevels(metric, dimKeys, writtenBefore) {},

    async readBuckets(query) { return [] },
    async readPending(query) { return [] },
    async countPending(metric) { return 0 },

    async claim(metric, upToBucketTs) { /* BucketClaim */ },
    async claimRecords(metric, limit) { /* RecordClaim */ },
    async ack(claim) {},
    async release(claim) {},
    async recover(metric) { /* RecoveryReport */ },
  }
}
```

## Capabilities

```ts
interface DriverCapabilities {
  durable: boolean      // survives a process restart
  shared: boolean       // visible to other processes
  atomicMerge: boolean  // concurrent writes to one series merge without loss
}
```

Declare these honestly. The house reads them at startup, warns when `durable` is
false, and uses them to resolve `delivery: 'auto'`.

## What a driver stores

There are two storage shapes, and a driver has to support both.

```
folded    metric -> bucket -> series key -> one cell     claim(metric, watermark)
staged    metric -> an append only list of records       claimRecords(metric, limit)
levels    metric -> series key -> one held value         never claimed
```

A cell is a `number` from a counter, a fold from a gauge or a timer, or a held
value from a level.

```ts
type Cell = number | GaugeCell | LevelCell

interface GaugeCell {
  last: number
  min: number
  max: number
  sum: number
  count: number
}

interface LevelCell {
  level: number
}
```

A level's value is boxed rather than stored bare so that storage can tell it
from a counter's scalar. The two are the same digits meaning the opposite thing
when a released claim has to be merged back: two counter cells for one window
add, two level cells do not, because a level that read 42 twice still reads 42.

The driver never interprets a cell. It stores what a metric wrote and hands it
back. Deciding which kind it is belongs to the metric, because the metric is the
only thing that knows its own type.

The third row is the one piece of state a claim never touches. A level has to
report a window nobody wrote to, so the number has to outlive the flush that
shipped the last one. Everything else a driver holds is claimed and then
deleted.

## Writing

### increment

```ts
increment(ops: readonly IncrOp[]): Promise<void>
// IncrOp: { metric, bucketTs, dimKey, delta }
```

Add `delta` to the cell at that metric, window and series. Create the cell if it
does not exist. Deltas may be negative, and may be fractional because a counter
can declare `float()`.

Add in plain doubles, the way JavaScript's `+` does, so every driver holds the
same bits. Redis's `HINCRBYFLOAT` rounds to seventeen decimal places, which turns
`1e-310` into `0`; the Redis driver adds inside a Lua script instead. Refuse an
increment whose total would not be a finite number, and change nothing when you
do. Store `-0` as `0`.

A write aimed below the claimed watermark lands at the watermark instead. See
[claim](#claim).

One round trip per call, not per operation. An empty array does nothing.

### observe

```ts
observe(ops: readonly GaugeOp[]): Promise<void>
// GaugeOp: { metric, bucketTs, dimKey, value }
```

Fold `value` into the cell:

```
last  = value
min   = min(existing.min, value)
max   = max(existing.max, value)
sum   = existing.sum + value
count = existing.count + 1
```

Unlike `increment`, this is a read, modify and write. On shared storage it has to
be atomic, or two writers lose observations. The Redis driver uses a Lua script
for exactly this.

Refuse an observation whose `sum` would not be a finite number, as `increment`
does, and move it to the watermark the same way when it is aimed below it.

### setLevel

```ts
setLevel(ops: readonly LevelOp[]): Promise<void>
// LevelOp: { metric, bucketTs, dimKey, value, mode }
// mode: 'set' | 'add' | 'hold'
```

Two things move per operation, and they move together or not at all: the
series' held value, and the cell in the window the operation names.

| `mode` | Held value becomes | Cell at `bucketTs` becomes |
| --- | --- | --- |
| `set` | `value` | `value` |
| `add` | held plus `value`, treating an unseen series as zero | the new held value |
| `hold` | unchanged | `value`, but only if that window has no cell yet |

A `hold` is what a flush issues for the windows nobody wrote to. It names its
own value rather than reading the held one, because the window it fills is in
the past and the series may have moved since. It leaves an existing cell alone,
so a written value always beats a carried one. A `hold` for a series the driver
has never seen does nothing at all, and must not bring one into existence.

Each series also carries two timestamps, both handed to the driver rather than
read from a clock it owns:

```ts
interface LevelSeries {
  dimKey: string
  value: number        // what it is at now
  carried: number      // what it was at in the window `heldThrough` names
  writtenAt: number    // the window the last set or add landed in
  heldThrough: number  // the newest window a hold has carried it through
}
```

`heldThrough` moves only on a `hold`, never on a `set` or an `add`. A series
written at noon and again at three is still owed a row for every window in
between, and a pointer that jumped to the later write would skip them.

`carried` is the value the next carry starts from, and it is not always `value`
for the same reason. The rule for a `set` or an `add`:

| Where the write lands | `carried` becomes |
| --- | --- |
| a series the driver has not seen | the new value |
| the window `heldThrough` names, or an earlier one | the new value, because that window now ends at it |
| a window after `heldThrough` | unchanged, because the windows in between belong to the older number |

Getting the middle row wrong is easy and shows up as a bug nobody notices for a
while: `set(5)` then `set(3)` in one window carries `5` into every empty window
after it.

A `set` or an `add` aimed below the claimed watermark lands at the watermark,
and the rule above uses the window it landed in. A `hold` aimed below it writes
no cell, because a claim has already taken that window, and still moves
`heldThrough`. An `add` whose result would not be a finite number is refused.

### readLevels

```ts
readLevels(metric: string): Promise<LevelSeries[]>
```

Every series the metric currently holds, ascending by dim key. Unaffected by
claims, because this is the state beside the buckets rather than in them.

### dropLevels

```ts
dropLevels(
  metric: string,
  dimKeys: readonly string[],
  writtenBefore?: number,
): Promise<void>
```

Forget those series entirely. What a `holdFor` expiry calls. Windows they have
already filled are untouched; what goes is the reason to keep filling more.

With `writtenBefore`, drop a series only if its `writtenAt` is still below it,
checked at the moment of the drop and atomically with it on shared storage. The
metric decides a series has expired from a `readLevels` taken a little earlier,
and a `set` can land in between. Without this check, that write would be erased
along with the series.

### append

```ts
append(ops: readonly AppendOp[]): Promise<void>
// AppendOp: { metric, id, ts, fields }
```

Store each record verbatim, preserving append order. Never aggregate: two
identical records are two records.

`fields` is opaque. The driver stores it and hands it back untouched. It does not
know which keys are declared, which are reserved, or how any of it becomes a
column, and keeping that out of storage is what lets a driver serve a metric type
it has never heard of.

A `Date` inside `fields` has to survive the round trip. Plain `JSON.stringify`
turns a `Date` into a string, which would hand the metric text for a column that
wants a date.

## Reading

### readBuckets

```ts
readBuckets(query: BucketQuery): Promise<BucketRow[]>
// BucketQuery: { metric, dimKey?, from?, to? }
// BucketRow:   { bucketTs, dimKey, value }
```

Unflushed, unclaimed windows only. `from` and `to` are half open, `[from, to)`.

Results are ordered by window, then by series key. Sorted output is part of the
contract, because merging a rollup and answering `last` both depend on it.

There is no `complete` flag. Excluding the window still filling is just
`to = bucketStart(now, resolution)`, and keeping resolution out of storage is what
stops a driver from needing to understand metric configuration.

### readPending

```ts
readPending(query: PendingQuery): Promise<StagedRecord[]>
// PendingQuery: { metric, from?, to?, limit? }
```

Staged, unclaimed records, oldest first. `from` and `to` bound the record
timestamp and are half open. `limit` caps what comes back, and on storage that
supports it this should be a bounded read rather than fetching everything and
slicing.

Reading does not consume.

### countPending

```ts
countPending(metric: string): Promise<number>
```

How many records have not shipped: staged, plus claimed and not yet settled. A
separate method because on real storage it is a different, much cheaper call,
and counting by dragging a million rows over the wire is not something to make
easy.

In flight records count because they have not shipped. A sink that hangs holds
its batch in a claim, and a backlog that read zero during the hang would hide
it. `readPending` still returns only unclaimed records.

## Claiming

A claim moves data out of the live set and holds it pending a write. Claimed data
is invisible to `readBuckets`, to `readPending` and to a second claim. That
invisibility is what stops two processes shipping the same window.

### claim

```ts
claim(metric: string, upToBucketTs: number): Promise<BucketClaim>
```

Move every window **strictly below** `upToBucketTs` into a claim.

```ts
interface BucketClaim {
  kind: 'buckets'
  id: string              // unique per claim
  metric: string
  claimedAt: number
  buckets: readonly { bucketTs: number; values: ReadonlyMap<string, Cell> }[]
}
```

Buckets ascend by `bucketTs`, so rows ship in a predictable order. When nothing
qualifies, return an empty claim rather than null.

The driver knows nothing about time here. It is handed a watermark and claims
everything below it. Deciding what "finished" means belongs to the metric, which
is the only thing that knows its own resolution and grace.

**Remember the highest watermark any claim of a metric has used**, even a claim
that found nothing, and never lower it. From then on, every `increment`,
`observe`, `set` and `add` aimed at a window below it lands in the watermark
window instead. A window below the watermark has been claimed already. A write
that reaches it late, from a slow request or a clock running behind, would
otherwise start a second copy of a window that shipped, with the same row id and
only the late part of the value, and a sink keeping one row per id would lose
the rest. On shared storage the raise and the move have to be atomic, or a write
can slip below the watermark between the two.

### claimRecords

```ts
claimRecords(metric: string, limit?: number): Promise<RecordClaim>
```

Move staged records into a claim, oldest first, at most `limit` of them.

```ts
interface RecordClaim {
  kind: 'records'
  id: string
  metric: string
  claimedAt: number
  records: readonly { id: string; ts: number; fields: Record<string, unknown> }[]
}
```

There is no watermark, because a record is complete the instant it is appended.
There is no equivalent of a window still filling to hold back.

## Settling

### ack

```ts
ack(claim: Claim): Promise<void>
```

The write succeeded. Discard the claimed data permanently.

### release

```ts
release(claim: Claim): Promise<void>
```

The write failed. Return the claimed data to the live set, unchanged.

Two rules that are easy to get wrong:

- **Merge, do not overwrite.** With writes moved past the watermark, nothing
  new should land in a claimed window. Data written by an older driver still
  might have, so a release that finds a cell already there merges the two rather
  than replacing one with the other. Counter cells add. Gauge folds merge the way
  the five aggregates merge, with the newer observation winning `last`.
- **Records go back where they came from.** Released records are older than
  anything appended since, so they go ahead of it. They go behind any records an
  earlier claim already put back, though, because those are older still. Keep
  the order records were appended in so a release can find its place.

### Settling twice

A claim can be settled exactly once. Acking a released claim, or releasing an
acked one, has to throw. Silently accepting it means a bug in the layer above
turns into missing data.

## Recovering

### recover

```ts
recover(metric: string): Promise<RecoveryReport>
```

Return claims abandoned by a flusher that died to the live set.

```ts
interface RecoveryReport {
  claims: number             // abandoned claims put back
  buckets: number            // windows put back, across those claims
  records: number            // records put back, across those claims
  oldestClaimedAt?: number   // when the longest stranded one was taken
}
```

This is the hole that claiming opens. A claim moves data **out** of the live set,
so a process that dies between `claim` and `ack` leaves a batch no later `claim`
can reach, because `claim` only ever reads the live set. Storage that outlives
the process is what keeps that batch in existence. This is what makes it
reachable again.

The flush calls it before it claims, so whatever is put back ships in that same
flush.

Four rules:

- **Put back, never shipped.** An aggregate row is identified by its metric,
  window and dimension values, so an abandoned half and a live half carry the
  same `id`. Sending them as two batches means a table upserting on that id keeps
  one and discards the other. Merge them into one live window instead.
- **Merge the same way `release` does.** It is the same operation on the same
  data, and a merge rule written twice eventually disagrees with itself.
- **Decide for yourself when a claim is abandoned, and err long.** Only the
  driver knows how long it has held one. Taking a claim back from an owner that
  is merely slow ships those rows twice and then fails that owner's `ack`, and
  waiting costs nothing by comparison. The Redis driver waits five minutes by
  default and exposes `recoverAfter`.
- **Settle exactly once.** Two instances sweeping at the same moment must put the
  data back once, not twice. Whatever makes `ack` and `release` single shot is
  what makes this single shot.

A driver whose `capabilities.durable` is `false` has nothing to recover, because
its claims die with the process. Reporting zero is the honest answer:

```ts
import { NOTHING_RECOVERED } from 'metrichouse/core'

async recover() {
  return NOTHING_RECOVERED
}
```

## The rules in full

A driver has to satisfy all of these.

**Writing**

- Increments accumulate within one window and series.
- Series and windows stay separate.
- A whole batch applies in one call.
- Negative and fractional values are accepted.
- Metrics are independent.
- An empty batch does nothing.
- A series key containing the separator or a backslash round trips intact.
- A gauge fold and a counter total keep full floating point precision.
- A total, sum or level that would not be a finite number is refused, and
  nothing changes.
- `-0` is stored as `0`.
- A write aimed below the highest claimed watermark lands at the watermark.
- Writing a cell of one kind into a series that holds another throws, whichever
  two kinds they are.

**Levels**

- A `set` puts the series at a value, a second `set` replaces it.
- An `add` treats a series nothing has written to as zero.
- A `hold` writes only into a window that has no cell, and writes the value it
  was given rather than the one the series is at.
- A `hold` for a series storage has never seen does nothing and creates nothing.
- `heldThrough` moves on a hold and never on a write; `writtenAt` moves on a
  write and never on a hold.
- Held values survive the claim and the ack that ship their windows.
- A `set` or `add` in the window `heldThrough` names replaces `carried`.
- A `hold` below the claimed watermark writes no cell and still moves the pointer.
- `dropLevels` forgets a series without touching the windows it already filled,
  and keeps a series written at or after `writtenBefore`.

**Reading**

- An unknown metric returns an empty array.
- `dimKey` filters to one series.
- `from` and `to` are half open.
- Results are ordered by window, then series key, regardless of insertion order.
- Claimed data is invisible.
- Reading never consumes.

**Claiming**

- A claim takes everything strictly below the watermark.
- Claimed windows are hidden from reads and from a second claim.
- An empty claim is returned rather than null.
- Every claim gets a distinct id.
- A claim carries its values keyed by series, and a gauge fold arrives intact.

**Settling**

- Ack discards permanently and leaves unclaimed data alone.
- Release restores the data unchanged, including record ids.
- A late write that moved forward stays apart from the released window.
- Released records return ahead of anything appended since, and behind records
  an older claim already put back.
- `countPending` counts records in a claim until it is settled.
- Settling the same claim twice throws.
- Nothing is lost when a write fails and the flush retries.

**Recovering**

- A metric with no abandoned claim recovers nothing.
- A claim that was only just taken is left alone, so a flush still writing keeps
  what it is holding.
- Recovery never touches the live set beyond merging into it.
- A recovered window comes back exactly as it was claimed.
- Recovered records return ahead of anything appended since.
- An empty claim is settled rather than left registered for ever.
- Two sweeps running at once put the data back once.

## Testing your driver

The repository holds an executable version of the list above as a shared test
suite, in `packages/metrichouse/src/drivers/contract.ts`. Both built in drivers
run it.

```ts
// packages/metrichouse/src/drivers/mydriver.test.ts
import { describeDriverContract } from './contract.js'

describeDriverContract('mydriver', {
  make: () => myDriver({ namespace: `test-${Math.random()}` }),
  cleanup: (driver) => driver.close(),
  capabilities: { durable: true, shared: true, atomicMerge: true },
})
```

The suite is not exported from the published package, so the import above is a
relative one inside a checkout of MetricHouse. Call it, watch it fail, make it
pass.

Anything a driver is *allowed* to differ on, such as a series cap, a key layout or
whether a claim survives a restart, belongs in that driver's own test file rather
than in the shared suite.

## A worked minimal driver

Folded storage only, enough to see the shape.

```ts
import type { BucketClaim, Cell, Claim, Driver } from 'metrichouse/core'
import { isBucketClaim, NOTHING_RECOVERED } from 'metrichouse/core'

export function tinyDriver(): Driver {
  // metric -> bucketTs -> dimKey -> cell
  const live = new Map<string, Map<number, Map<string, Cell>>>()
  const inFlight = new Map<string, Claim>()
  // metric -> the highest watermark a claim has used
  const claimedUpTo = new Map<string, number>()
  let seq = 0

  const bucketsFor = (metric: string) => {
    let byBucket = live.get(metric)
    if (!byBucket) live.set(metric, (byBucket = new Map()))
    return byBucket
  }

  return {
    capabilities: { durable: false, shared: false, atomicMerge: true },

    async increment(ops) {
      for (const op of ops) {
        // A write aimed at a window a claim already took lands at the
        // watermark instead, so a late write never reopens a shipped window.
        const floor = claimedUpTo.get(op.metric) ?? Number.NEGATIVE_INFINITY
        const bucketTs = Math.max(op.bucketTs, floor)

        const byBucket = bucketsFor(op.metric)
        let series = byBucket.get(bucketTs)
        if (!series) byBucket.set(bucketTs, (series = new Map()))

        const total = ((series.get(op.dimKey) as number) ?? 0) + op.delta
        if (!Number.isFinite(total)) throw new Error(`${op.metric}: total out of range`)
        series.set(op.dimKey, total === 0 ? 0 : total)
      }
    },

    async readBuckets(query) {
      const rows = []

      for (const [bucketTs, series] of bucketsFor(query.metric)) {
        if (query.from !== undefined && bucketTs < query.from) continue
        if (query.to !== undefined && bucketTs >= query.to) continue

        for (const [dimKey, value] of series) {
          if (query.dimKey !== undefined && dimKey !== query.dimKey) continue
          rows.push({ bucketTs, dimKey, value })
        }
      }

      // Ordering is part of the contract.
      return rows.sort((a, b) => a.bucketTs - b.bucketTs || a.dimKey.localeCompare(b.dimKey))
    },

    async claim(metric, upToBucketTs) {
      const byBucket = bucketsFor(metric)
      const buckets = []

      for (const [bucketTs, series] of [...byBucket].sort((a, b) => a[0] - b[0])) {
        if (bucketTs >= upToBucketTs) continue

        buckets.push({ bucketTs, values: new Map(series) })

        // Claimed data leaves the live set, so a second claim cannot take it.
        byBucket.delete(bucketTs)
      }

      // Raised even when nothing was claimed, and never lowered.
      claimedUpTo.set(metric, Math.max(claimedUpTo.get(metric) ?? upToBucketTs, upToBucketTs))

      const claim: BucketClaim = {
        kind: 'buckets',
        id: `${metric}#${(seq += 1)}`,
        metric,
        claimedAt: Date.now(),
        buckets,
      }

      inFlight.set(claim.id, claim)
      return claim
    },

    async ack(claim) {
      if (!inFlight.delete(claim.id)) {
        throw new Error(`claim ${claim.id} is not in flight`)
      }
    },

    async release(claim) {
      if (!inFlight.delete(claim.id)) {
        throw new Error(`claim ${claim.id} is not in flight`)
      }
      if (!isBucketClaim(claim)) return

      const byBucket = bucketsFor(claim.metric)

      for (const bucket of claim.buckets) {
        let series = byBucket.get(bucket.bucketTs)
        if (!series) byBucket.set(bucket.bucketTs, (series = new Map()))

        for (const [dimKey, cell] of bucket.values) {
          // Merge, never overwrite: data from an older driver may have landed
          // in this window while the claim was held.
          const current = series.get(dimKey)
          series.set(dimKey, ((current as number) ?? 0) + (cell as number))
        }
      }
    },

    // Nothing to recover: this driver's claims live in `inFlight`, which dies
    // with the process. A durable driver sweeps its claim registry here.
    async recover() { return NOTHING_RECOVERED },

    // The staged and level halves are left out for brevity. A real driver
    // implements all fourteen methods.
    async observe() { throw new Error('not implemented') },
    async setLevel() { throw new Error('not implemented') },
    async readLevels() { return [] },
    async dropLevels() {},
    async append() { throw new Error('not implemented') },
    async readPending() { return [] },
    async countPending() { return 0 },
    async claimRecords(metric) {
      return { kind: 'records', id: `${metric}#empty`, metric, claimedAt: Date.now(), records: [] }
    },
  }
}
```
