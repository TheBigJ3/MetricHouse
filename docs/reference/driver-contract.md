# Driver contract

A driver is where running totals and staged records live between a write and a
flush. The interface is fourteen methods and one `capabilities` property, plus
two [optional reads](#optional-reads) a driver may add to answer two questions
with less data on the wire, and two optional methods for
[taking turns](#taking-turns), which keep every process sharing the driver to
one flush cadence. Implementing it is how you put MetricHouse on storage it
does not ship with.

```ts
import type { Driver } from 'metrichouse/core'
```

Most applications never read this page. Use [`memory()` or
`ioredis()`](/guide/drivers) unless you have a reason not to.

## The shape

```ts
import type { Driver } from 'metrichouse/core'

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

    // These return a BucketClaim, a RecordClaim and a RecoveryReport. The
    // sections below say what each one holds.
    async claim(metric, upToBucketTs) { throw new Error('not implemented') },
    async claimRecords(metric, limit) { throw new Error('not implemented') },
    async ack(claim) {},
    async release(claim) {},
    async recover(metric) { throw new Error('not implemented') },
  }
}
```

The bodies are placeholders, so this compiles and does nothing useful yet.

## Capabilities

```ts
interface DriverCapabilities {
  durable: boolean      // survives a process restart
  shared: boolean       // visible to other processes
  atomicMerge: boolean  // concurrent writes to one series merge without loss
}
```

Declare these honestly. The house reads them at startup, warns when `durable` is
false, and uses them to resolve `delivery: 'auto'`. A flush takes
[turns](#taking-turns) only on a driver whose `shared` is true.

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

Metric names and series keys reach a driver as well formed Unicode. A metric
refuses a name, and a dim value, that holds half of a UTF-16 surrogate pair, so
storage that keeps text as UTF-8, as Redis does, never has to tell two such
keys apart.

## Writing

### increment

```ts
increment(ops: readonly IncrOp[]): Promise<void>
// IncrOp: { metric, bucketTs, dimKey, delta, integer? }
```

Add `delta` to the cell at that metric, window and series. Create the cell if it
does not exist. Deltas may be negative, and may be fractional because a counter
can declare `float()`.

Add in plain doubles, the way JavaScript's `+` does, so every driver holds the
same bits. Redis's `HINCRBYFLOAT` rounds to seventeen decimal places, which turns
`1e-310` into `0`; the Redis driver adds inside a Lua script instead. Refuse an
increment whose total would not be a finite number, the first one into an empty
cell included, and change nothing in that window when you do. Store `-0` as `0`.

`integer` is set by a counter that counts whole numbers. Refuse an increment
whose total would pass `9007199254740991`, `Number.MAX_SAFE_INTEGER`, as well:
past it a double cannot hold every whole number, and the total would stop being
exact without anyone noticing.

Apply the operations in the order they were given. Two aimed at different
windows can land in the same one, as the next paragraph explains, and a sum of
doubles depends on the order it was added in.

A refusal is only promised to leave unchanged the operations it was checked
together with. The memory driver checks a whole call before storing any of it.
The Redis driver checks one script call as one step, and a script call carries
the neighbouring operations for one window, up to 1000 of them. So a call
spanning two windows can keep the first when the second is refused, and a call
with more than 1000 operations for one window is split into several script
calls, each applied or refused on its own. Every metric writes one operation
per call, so this only shows through the driver itself.

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
does, the first one into an empty cell included. Move it to the watermark the
same way when it is aimed below it, and fold a batch in the order it was given,
because `last` is whichever observation came last.

### setLevel

```ts
setLevel(ops: readonly LevelOp[]): Promise<void>
// LevelOp: { metric, bucketTs, dimKey, value, mode, integer? }
// mode: 'set' | 'add' | 'hold'
```

Two things move per operation, and they move together or not at all: the
series' held value, and the cell in the window the operation names. A call that
refuses one operation changes nothing that call wrote in that window, although
an operation later in the call reads what the earlier ones did. The Redis driver
works a whole window's operations out before it writes any of them, and the
memory driver undoes the call's writes when one is refused.

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

When a `hold` finds its window already written, `carried` becomes the value in
that cell rather than the one the hold named. The flush worked out its value
before a late `set` landed in the window, and carrying that older number would
repeat a level the series had already left in every empty window after it. The
same rule makes a `hold` safe to apply twice. A `hold` for the window
`heldThrough` already names, arriving once a claim has taken that window, leaves
`carried` alone: the cell that would say what the window ended at is gone, and
`carried` already holds it.

`integer` is set by a level that holds whole numbers. Refuse a `set` or an `add`
that would leave a cell or the held value past `9007199254740991`, as
[`increment`](#increment) does.

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
for the same reason.

Two processes writing to one series near a window boundary can deliver the later
window's write first. The rules below keep every window right whichever arrives
second. An `add` is a change, so it applies from the window it lands in onwards.
A `set` is a reading, and a window after it that already has a cell was written
later.

| | `add` of `delta` | `set` to `value` |
| --- | --- | --- |
| Cell in the landing window | the value in effect just before it, plus `delta` | `value` |
| Cells already in later windows | each plus `delta` | unchanged |
| Held `value` | plus `delta` | `value`, unless a later window already has a cell |
| `carried` | plus `delta` when the landing window is at or before `heldThrough` | `value` when the landing window is at or before `heldThrough` and no later cell is too |

"The value in effect just before" is the newest cell between `heldThrough` and
the landing window, or `carried` when there is none, or `0` for a series the
driver has never seen. For a first write, `carried` and the held value are the
new value.

Getting these wrong is easy and shows up as a bug nobody notices for a while:
`set(5)` then `set(3)` in one window carrying `5` into every empty window after
it, or an `inc` from one process and a `dec` from another leaving every carried
window one off.

A `set` or an `add` aimed below the claimed watermark lands at the watermark,
and the rule above uses the window it landed in. A `hold` aimed below it writes
no cell, because a claim has already taken that window, and still moves
`heldThrough`. A `hold` for a window before `heldThrough` changes neither
`heldThrough` nor `carried`: it comes from a flusher running behind, and
`carried` belongs to the pointer's window. An `add` whose result would not be a
finite number is refused.

### readLevels

```ts
readLevels(metric: string): Promise<LevelSeries[]>
```

Every series the metric currently holds, ascending by dim key. Unaffected by
claims, because this is the state beside the buckets rather than in them.

Hand out copies. A caller that edits a series it was given must not change what
the driver holds. The Redis driver builds a fresh object on every read, and the
memory driver copies what it stores. The same goes for every other read:
`readLevel`, a cell from `readBuckets`, and a record from `readPending`.

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
identical records are two records. Store a copy of `fields`, so a caller who
reuses the object it passed does not change a record already staged. The
memory driver copies each value and clones a `Date`, an array or a nested
object whole.

`fields` is opaque. The driver stores it and hands it back untouched. It does not
know which keys are declared, which are reserved, or how any of it becomes a
column, and keeping that out of storage is what lets a driver serve a metric type
it has never heard of.

A `Date` inside `fields` has to survive the round trip. Plain `JSON.stringify`
turns a `Date` into a string, which would hand the metric text for a column that
wants a date. However a driver marks a date inside stored text, an object of the
caller's own that has the same shape must come back as it went in. The Redis
driver writes a date as `{ "__mh_date": <ms> }`, and stores any key of the
caller's that starts with `__mh_` with that prefix written twice.

## Reading

### readBuckets

```ts
readBuckets(query: BucketQuery): Promise<BucketRow[]>
// BucketQuery: { metric, dimKey?, from?, to? }
// BucketRow:   { bucketTs, dimKey, value }
```

Unflushed, unclaimed windows only. `from` and `to` are half open, `[from, to)`.
With `dimKey`, only that series, and a window that does not hold it is left
out. `counter.current(dims)` and every [immediate](/guide/delivery) send read
this way, so it is worth answering without fetching every series. The Redis
driver finds the windows and reads the one field in each inside a single
script, one round trip.

Results are ordered by window, then by series key. Sorted output is part of the
contract, because merging a rollup and answering `last` both depend on it.

A read sees every write the same driver was handed before it, even one whose
promise has not resolved yet. The Redis driver sends each read behind the
writes queued ahead of it, the same queue that
[keeps one writer's writes in order](#release). `readLevels` and `readPending`
follow the same rule.

There is no `complete` flag. Excluding the window still filling is just
`to = bucketStart(now, resolution)`, and keeping resolution out of storage is what
stops a driver from needing to understand metric configuration.

### readPending

```ts
readPending(query: PendingQuery): Promise<StagedRecord[]>
// PendingQuery: { metric, from?, to?, limit? }
```

Staged, unclaimed records, in the order they were appended. That is ascending
by `ts` for every record appended in time order. A record appended with a `ts`
older than one staged before it keeps its place in the line and is not sorted
forward, so `limit` takes the first records appended, whatever their `ts`.
`from` and `to` bound the record timestamp and are half open. `limit` caps what
comes back, and on storage that supports it this should be a bounded read rather
than fetching everything and slicing.

A read taken in pages must not skip a record, or return one twice, when
another process claims or releases records between two pages. The Redis driver
starts each page after the last record it read rather than at an index, and
finds that record again when the list has moved.

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

## Optional reads

Two methods a driver may leave out. Each answers a question a metric could
also answer from the required reads, by fetching everything and picking out
what it needs. A driver on remote storage adds them so that the answer crosses
the wire instead of the data. When a driver has neither, every result is the
same, only slower on a metric with many series.

```ts
export function myDriver(): Driver {
  return {
    // ...the fourteen methods above, then, if storage can do better:
    async readLevel(metric, dimKey) { return undefined },
    async sumBuckets(query) { return undefined },
  }
}
```

Both follow the ordering rule of [readBuckets](#readbuckets): they see every
write the same driver was handed before them.

### readLevel

```ts
readLevel?(metric: string, dimKey: string): Promise<LevelSeries | undefined>
```

The one series a level holds under `dimKey`, exactly as `readLevels` would list
it, or `undefined` when it holds none. `level.current(dims)` asks for one series,
and without this method it reads every series the level holds to find it. The
Redis driver reads the one field of the level hash.

### sumBuckets

```ts
sumBuckets?(query: BucketRange): Promise<number | undefined>
// BucketRange: { metric, from?, to? }
```

Every counter cell in the windows `[from, to)` added up, but only when that sum
is exact, and `undefined` otherwise. `counter.current()` with no dims asks for
the total of an integer counter's open window, and without this method it reads
every series in that window and adds them up itself.

Exact has a precise meaning here. The metric adds cells one at a time in the
order `readBuckets` returns them, and a double rounds any whole number past
2^53. So the driver may answer only when the order cannot matter: every cell is
a whole number, the positive cells add up to at most 2^53 minus 1, and the
negative ones to at least minus that. Every partial sum then lies between those
two, where a double holds each whole number, so any order gives the same total.
A fraction, a gauge or level cell, or a sum past either limit answers
`undefined`, and the metric reads the cells instead. That keeps its answer, and
the error it raises for a total a double cannot hold, the same as without this
method. A float counter never asks, because the order fractions are added in
changes the last bits of their sum.

The Redis driver adds the cells inside a script and sends back one number.

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

Throw when `upToBucketTs` is not a finite number, before claiming anything or
storing it as the watermark. A watermark of `NaN` compares false against every
window, so no late write would ever move forward again.

**Never reuse a claim id**, even after storage loses its most recent writes. A
Redis restart between two disk syncs, or a failover to a replica that was
behind, rolls back anything Redis kept, a counter included. An id handed out a
second time names a claim still in flight, the two share one in-flight key, and
settling either one settles both. The Redis driver mints each id in the process
as the metric name and a UUID version 7, which needs nothing Redis remembers.
Claims taken under the `metric#n` ids of an earlier version still recover and
settle, because nothing reads an id apart from the key it names.

The driver knows nothing about time here. It is handed a watermark and claims
everything below it. Deciding what "finished" means belongs to the metric, which
is the only thing that knows its own resolution and grace.

The Redis driver claims the whole backlog below the watermark in one script,
and Redis runs nothing else while a script runs. A backlog of about a million
cells, from a metric that has not flushed in a long while or one with very many
series, holds Redis for roughly a second, and every other client waits that
long. Flushing on schedule keeps a claim to one or two windows.

**Stamp the claim with storage's own clock** where there is one. The age of a
claim decides whether [`recover`](#recover) takes it back, and a stamp from the
claiming host's clock would later be compared against the recovering host's.
Two hosts whose clocks disagree by a minute would then take back claims that
are seconds old. The Redis driver reads Redis's `TIME` inside the claim script
and inside recovery.

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

Move staged records into a claim, first appended first, at most `limit` of
them. A `limit` of zero or less claims nothing, and one past the backlog claims
all of it. The order is the one [`readPending`](#readpending) returns.

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

Four rules that are easy to get wrong:

- **Keep the claim until the data is back.** A release that fails partway,
  for instance on a cell of another kind, must leave the rest of the claim
  where a retried release or a recovery pass still finds it. The Redis driver
  removes the claim from its registry only once every cell has been restored.
  The memory driver works out every merge before it moves anything, so a
  refused release leaves the live set as it was and the whole claim in flight.
- **Merge, do not overwrite.** With writes moved past the watermark, nothing
  new should land in a claimed window. Data written by an older driver still
  might have, so a release that finds a cell already there merges the two rather
  than replacing one with the other. Counter cells add. Gauge folds merge the way
  the five aggregates merge, with the cell already in the window winning `last`,
  since it was written later. Level cells do not merge: the one already in the
  window is kept, for the same reason.
- **Records go back where they came from.** Released records are older than
  anything appended since, so they go ahead of it. Records an earlier release
  already put back can be older than some of them and newer than others, so the
  two are merged by the order they were appended in. Keep that order somewhere
  a release can read it. The Redis driver keeps it as a sequence stamp in front
  of each stored record, and counts a record staged before stamps existed as
  older than every stamped one, in its scripts and in the driver alike.
- **Keep one writer's writes in order.** Two `set` calls from one process must
  reach storage in the order they were made. The Redis driver queues each send
  behind the one before it, because a send that first has to load its script
  would otherwise be overtaken. A call split into several round trips by
  `maxPipelineSize` issues all of them in one step of that queue, so a call made
  after it cannot land between two of them.

### Settling twice

A claim can be settled exactly once. Acking a released claim, or releasing an
acked one, has to throw. Silently accepting it means a bug in the layer above
turns into missing data.

A settle that reaches shared storage twice is not settling twice. A client that
resends an `ack` after a reconnect cannot know whether the first one ran, and
the second arrival would find the claim gone and throw, turning a successful
flush into an error. Recognise the second arrival and answer the way the first
one did. The same goes for `release`, for `recover`, which would otherwise
report that it found nothing, and for `claimRecords`, which would otherwise take
a second `limit` of records into the same claim. The Redis driver records each
of these beside its writes and replays the recorded reply.

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

## Taking turns

Two methods a driver may leave out, and has both of or neither. They keep one
cadence for every process that shares the driver.

```ts
takeTurn?(metric: string, now: number, gapMs: number): Promise<ShipTurn>
returnTurn?(metric: string, turn: Turn, previous: Turn | undefined): Promise<void>

interface Turn {
  at: number     // when it was taken, by the caller's clock
  token: string  // unique to this turn
}

type ShipTurn =
  | { granted: true; turn: Turn; previous: Turn | undefined }  // this turn, and the one it replaced
  | { granted: false; lastTakenAt: number }                     // when the turn in the way was taken
```

A metric's `flush` setting is the fastest it may ship. Each process tracks its
own last shipment, and on its own that lets N processes ship up to N times an
interval between them. Before a flush claims, it calls `takeTurn`, and the
driver answers for every process at once.

### takeTurn

Grant the turn and record it, with `now` as the time it was taken and a token
no other turn has, or refuse it.

- Grant it when no turn has been taken for the metric.
- Grant it when the last turn is `gapMs` or more away from `now`, before or
  after it. A turn a little after `now` comes from a host whose clock runs
  ahead, and it holds this one back like any other. One a whole gap after `now`
  means this clock stepped backwards, and waiting for it to catch up would stall
  the metric.
- Refuse it otherwise, and answer when the last turn was taken.
- A `gapMs` of `0` is always granted, and still recorded. That is how `force`
  and `final` take one.

Check and record in one atomic step. Two processes asking at the same moment
must get one grant and one refusal. The Redis driver does both in one script,
against a key per metric, `mh:turn:<metric>`, holding the time in milliseconds
and the token as `at|token`. It mints the token in the process, a UUID version
7, and reads a turn stored by an earlier version, the time alone, as a turn
with an empty token.

The time is the caller's `now`, so an injected test clock applies to turns as it
does to windows.

### returnTurn

Put `previous` back as the recorded turn, token included, or clear the turn
when `previous` is `undefined`. Do it only while the recorded turn is still
`turn`, compared by time and token. A later turn belongs to a flush that is
still running, and writing an older one over it would let a third process ship
beside that one. The token is what tells them apart when both were taken in
the same millisecond, as a forced flush and a scheduled one can be. Compared by
time alone, the scheduled flush giving back its turn would erase the forced
one.

A flush calls it when it wrote nothing: the claim was empty, or the `write`
function threw. A failure here is ignored. The next turn is then granted one
interval later than it could have been, and nothing else changes.

### Without them

A driver that leaves both out, or says `shared: false`, gets a cadence kept in
each process, which is all `memory()` needs. A flush on such a driver never
calls them.

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
- A write that reaches shared storage twice applies once. A client that resends
  a command after a reconnect cannot know whether the first send ran, so
  `increment`, `observe`, a level `set` or `add`, and `append` each carry
  something that lets storage recognise the second arrival.
- A batch is applied in the order it was given, even when its operations move
  forward to one window.
- A gauge fold and a counter total keep full floating point precision.
- A total, sum or level that would not be a finite number is refused, and
  nothing in that window changes. That includes the first write into a cell.
- With `integer` set, a total or level past `9007199254740991` is refused too.
- `-0` is stored as `0`.
- A write aimed below the highest claimed watermark lands at the watermark.
- A record's fields are stored as a copy, so editing the object passed in
  changes nothing staged.
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
- A `hold` into a window that already has a cell carries that cell's value.
- A `hold` for the pointer's window, after a claim has taken it, leaves
  `carried` alone.
- A refused operation changes nothing its call wrote in that window.
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
- A read sees a write issued before it, awaited or not.
- An error names the metric of the operation that was refused.
- Every read hands out copies, so editing what it returned changes nothing
  stored.
- Staged records come back in append order, a backdated one included.
- An invalid `Date` in `fields` comes back as an invalid `Date`.
- A field shaped like the driver's own date marker comes back untouched.

**Claiming**

- A claim takes everything strictly below the watermark.
- Claimed windows are hidden from reads and from a second claim.
- An empty claim is returned rather than null.
- Every claim gets a distinct id.
- A claim carries its values keyed by series, and a gauge fold arrives intact.
- A watermark that is not a finite number throws and changes nothing.
- A record claim takes nothing for a `limit` of zero or less, and takes records
  in append order.

**Settling**

- Ack discards permanently and leaves unclaimed data alone.
- Release restores the data unchanged, including record ids.
- A late write that moved forward stays apart from the released window.
- A release that finds a cell already in its window merges into it: counters
  add, gauge folds fold with the existing cell keeping `last`, and the existing
  level cell is kept.
- A release stopped by a cell of another kind leaves the claim in flight.
- Released records return ahead of anything appended since, merged by append
  order with records an earlier release already put back.
- `countPending` counts records in a claim until it is settled.
- Settling the same claim twice throws, and one settle that reaches storage
  twice does not.
- Nothing is lost when a write fails and the flush retries.

**Recovering**

- A metric with no abandoned claim recovers nothing.
- An abandoned window, or an abandoned run of records, is put back and
  reported, with when its claim was taken.
- A claim that was only just taken is left alone, so a flush still writing keeps
  what it is holding.
- Recovery never touches the live set beyond merging into it.
- A recovered window comes back exactly as it was claimed.
- Recovered records return ahead of anything appended since.
- An empty claim is settled rather than left registered for ever.
- Two sweeps running at once put the data back once.
- A sweep that reaches storage twice reports what the first arrival put back.

**Taking turns**

- The first turn for a metric is granted, with no previous turn.
- A turn less than the gap after the last one is refused, and names it.
- A turn exactly the gap after the last one is granted, and names the one it
  replaced.
- A turn less than the gap before the last one is refused.
- A turn the gap or more before the last one is granted.
- A gap of zero is always granted, and recorded.
- Each metric keeps its own turn.
- Of two turns asked for at once, one is granted.
- Every turn gets a token of its own, two taken in one millisecond included.
- Giving a turn back restores the previous one, token included, or clears it
  when there was none, and leaves a later turn alone, one taken in the same
  millisecond included.
- A turn that reaches storage twice answers the way the first arrival did.

## Testing your driver

The repository holds an executable version of the list above as a shared test
suite, in `packages/metrichouse/src/drivers/contract.ts`. Both built in drivers
run it.

```ts
// packages/metrichouse/src/drivers/mydriver.test.ts
import { describeDriverContract } from './contract.js'

describeDriverContract('mydriver', {
  // A fresh, empty driver for every test. A driver over shared storage should
  // use a new namespace or database each time.
  make: () => myDriver(),
  // Optional. Empty the storage after each test when make() does not isolate it.
  cleanup: async () => {},
  capabilities: { durable: true, shared: true, atomicMerge: true },
})
```

The suite is not exported from the published package, so the import above is a
relative one inside a checkout of MetricHouse. Call it, watch it fail, make it
pass.

Anything a driver is *allowed* to differ on, such as a series cap, a key layout or
whether a claim survives a restart, belongs in that driver's own test file rather
than in the shared suite.

The tests for the [optional reads](#optional-reads) and for
[taking turns](#taking-turns) pass without checking anything when a driver
leaves the methods out, and hold it to the rules above when it has them.

Two more options switch on the tests that need to reach past the contract.
`plant(driver, metric, bucketTs, dimKey, cell)` puts a cell straight into a
window, past the watermark, the way a driver older than the watermark could
have left one. It is the only way to hand `release` a window that already
holds a cell. `abandoned(driver)` returns a second driver on the same storage
that treats every claim as abandoned, for the recovery tests. A driver whose
claims die with its process has nothing to recover and leaves it out.

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
