# Driver contract

A driver is where running totals and staged records live between a write and a
flush. The interface is thirteen methods. Implementing it is how you put
MetricHouse on storage it does not ship with.

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
    async append(ops) {},

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
```

A cell is either a `number`, which came from a counter, or a fold, which came from
a gauge or a timer.

```ts
type Cell = number | GaugeCell

interface GaugeCell {
  last: number
  min: number
  max: number
  sum: number
  count: number
}
```

The driver never interprets a cell. It stores what a metric wrote and hands it
back. Deciding which kind it is belongs to the metric, because the metric is the
only thing that knows its own type.

## Writing

### increment

```ts
increment(ops: readonly IncrOp[]): Promise<void>
// IncrOp: { metric, bucketTs, dimKey, delta }
```

Add `delta` to the cell at that metric, window and series. Create the cell if it
does not exist. Deltas may be negative, and may be fractional because a counter
can declare `float()`.

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

How many records are staged and unclaimed. A separate method because on real
storage it is a different, much cheaper call, and counting by dragging a million
rows over the wire is not something to make easy.

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

- **Merge, do not overwrite.** A window that was written to while it was claimed
  now holds new data. A release has to merge the two, not replace one with the
  other. Counter cells add. Gauge folds merge the way the five aggregates merge,
  with the newer observation winning `last`.
- **Records go to the front.** Released records are older than anything appended
  since, so they belong at the head of the queue, not the tail.

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
- A gauge fold keeps full floating point precision.
- Observing into a series holding counter cells throws, and the reverse throws.

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
- Release merges with anything written while the claim was held.
- Released records return ahead of anything appended since.
- Settling the same claim twice throws.
- Nothing is lost when a write fails and the flush retries.

**Recovering**

- A metric with no abandoned claim recovers nothing.
- A claim that was only just taken is left alone, so a flush still writing keeps
  what it is holding.
- Recovery never touches the live set beyond merging into it.
- A recovered window merges with anything written while it was stranded.
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
        const byBucket = bucketsFor(op.metric)
        let series = byBucket.get(op.bucketTs)
        if (!series) byBucket.set(op.bucketTs, (series = new Map()))

        const existing = series.get(op.dimKey)
        series.set(op.dimKey, ((existing as number) ?? 0) + op.delta)
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
          // Merge, never overwrite: this window may have been written to while
          // the claim was held.
          const current = series.get(dimKey)
          series.set(dimKey, ((current as number) ?? 0) + (cell as number))
        }
      }
    },

    // Nothing to recover: this driver's claims live in `inFlight`, which dies
    // with the process. A durable driver sweeps its claim registry here.
    async recover() { return NOTHING_RECOVERED },

    // The staged half is left out for brevity. A real driver implements all
    // thirteen methods.
    async observe() { throw new Error('not implemented') },
    async append() { throw new Error('not implemented') },
    async readPending() { return [] },
    async countPending() { return 0 },
    async claimRecords(metric) {
      return { kind: 'records', id: `${metric}#empty`, metric, claimedAt: Date.now(), records: [] }
    },
  }
}
```
