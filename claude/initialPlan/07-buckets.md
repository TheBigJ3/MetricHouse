# Buckets

Bucketing turns a timestamp into an epoch-aligned window of the metric's `resolution`, which is the unit everything is stored, read, and shipped in. Resolution and flush cadence are fully independent: a metric can keep 1-second fidelity while only shipping to your database every 5 minutes.

## Main functions

**Time parsing**
- `parseDuration('5m'): number` — accepts `ms | s | m | h | d`
- `formatDuration(ms): string`

**Boundaries**
- `bucketStart(tsMs, resolutionMs): number` — floor to the epoch-aligned boundary
- `nextBoundary(tsMs, resolutionMs): number`
- `bucketRange(fromMs, toMs, resolutionMs): number[]` — every bucket start in a window

**Lifecycle**
- `isOpen(bucketTs, resolutionMs, nowMs): boolean` — `now` falls inside it
- `isClosed(bucketTs, resolutionMs, nowMs, graceMs): boolean` — ended, and past `grace`
- `closedUpTo(resolutionMs, nowMs, graceMs): number` — the watermark [flush](12-flush.md) claims below

**Validation**
- `assertResolution(metric)` — resolution must divide its `flush` interval evenly, so a shipment never splits a bucket

## Why `grace` exists

A bucket ending at `:07` can still receive a write at `:07.001` from an in-flight request. `grace` (default `'2s'`) holds a closed bucket back from being claimed for that long. Anything arriving after grace lands in the current bucket instead — late, but never lost, and never silently altering a bucket already shipped.

## Backdating with `at`

`add(n, dims, { at })` attributes a write to the instant it describes rather
than the instant it was recorded. A 40-second streamed response can charge each
chunk to the second it was produced, and an ingest endpoint can accept a
timestamp from the payload.

Three outcomes, and which one you get is deterministic:

| `at` falls | outcome |
| --- | --- |
| in the open bucket, or a closed one still within `grace` | written there |
| older than `grace`, but the bucket is unclaimed | written there, `LATE_WRITE` warn |
| in a bucket already claimed or flushed | written to the **oldest open bucket**, `LATE_WRITE` warn with the drift |
| in the future beyond one resolution | rejected, `INVALID_TIMESTAMP` |

The third row is the important one: a backdated write can never modify a bucket
that has already shipped, because that bucket's row id is already in your
database and silently changing its value would break dedupe convergence. The
data is kept, attributed as close as honestly possible, and the drift is
reported rather than hidden.

`allowLate: 'reject' | 'clamp'` on a metric chooses between dropping such
writes and clamping them, for callers who would rather lose the point than
misattribute it.

**`at:` is for stragglers, not for history.** It handles a write that is seconds
behind. Data about a period that is finished and already flushed — a device
uploading six days of backlog, an import from another system — must not go
through buckets at all. Use [`house.backfill()`](22-ingest.md), which folds and
identifies the rows and hands them straight to the sink. Routing history through
`at:` collapses it into one bucket, which is worse than dropping it.

## In use

```ts
const dogPoops = counter('dog_poops', {
  dims: { dogName: str() },
  resolution: '1s',
  flush: '5m',
  grace: '2s',
})
```

```
resolution '1s'   →  one bucket per second, keyed by epoch second
flush      '5m'   →  300 buckets accumulate, then ship together

  14:03:07  14:03:08  14:03:09   …   14:08:06        now = 14:08:09
  ├────────┼─────────┼─────────┼ … ┼──────────┤      grace = 2s
  └──────────── 300 closed buckets ───────────┘      └─ open ─┘
                        │
              one flush() → 300 rows
```

```ts
bucketStart(Date.parse('2026-09-05T14:03:07.482Z'), 1000)
// -> 1788616987000   (14:03:07.000)

closedUpTo(1000, Date.parse('2026-09-05T14:08:09Z'), 2000)
// -> 1788617287000   (14:08:07 — everything strictly below this is claimable)
```

Because resolution survives to the database, any window is a query, not a config change:

```sql
SELECT toStartOfInterval(bucket_ts, INTERVAL 15 SECOND) AS w, sum(value)
FROM dog_poops GROUP BY w;
```
