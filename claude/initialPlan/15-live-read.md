# Live read

Live read exposes only what is still in the driver — the open bucket, plus any closed buckets not yet flushed and acked. Once a flush is acked that data is gone from here and lives solely in your database, unless the metric sets `retention`, which keeps an acked copy readable under a TTL.

## Main functions

**Per metric**
- `.current(dims?)` — the open bucket. With dims, one value; without, every live series.
- `.snapshot(opts?)` — every unflushed bucket for this metric

Opts:
- `dims` — partial match filter, e.g. `{ park: 'riverside' }`
- `from` / `to` — restrict the bucket range
- `complete` — exclude the open bucket; **default `true`**
- `rollup` — `'none' | 'sum' | 'window'`, collapse buckets before returning
- `groupBy` — collapse to these dims in the driver rather than in JS
- `orderBy` / `direction` — sort before limiting, so `limit` means top-K
- `limit`

**Per house**
- `house.snapshot(opts?)` — same, across every registered metric
- `house.current()` — every metric's open bucket, the cheap dashboard call

**Events and logs**
- `.pending()` — count staged and not yet shipped
- `.peek(n?)` — inspect staged records without consuming them

## The open bucket is partial, and every row says so

A bucket that has not closed is by definition incomplete. Polling a `10s`
counter at an arbitrary moment reads a bucket that is on average half full —
shown as a count it is ~50% low, shown as a rate it sawtooths at every
boundary and reads as a traffic pattern that is not there.

So every live row carries two extra fields:

- `bucket_open: boolean` — is this window still accumulating
- `bucket_elapsed_ms: number` — how far into it we are

and `complete` defaults to **`true`**, excluding the open bucket entirely. The
default is correct-but-stale; opting in to the open bucket is a deliberate act
with the information needed to extrapolate honestly.

```ts
await requests.snapshot({ complete: false })
// [
//   { bucket_ts: '14:03:00', value: 812, bucket_open: false, bucket_elapsed_ms: 10000 },
//   { bucket_ts: '14:03:10', value: 194, bucket_open: true,  bucket_elapsed_ms:  2400 },
//   //                              ↑ 24% of a window. 194 is not the rate.
// ]
```

## What live read cannot do: percentiles

Live read sees counters, gauges, levels and distincts. It does **not** see
staged events, which are opaque until flushed — so **p95 for the current
window is unavailable**, at any price.

This is the price of [dropping histograms](00-overview.md), and it is worth
paying: six lines of SQL over an event table replace an entire subsystem. But
it lands on latency, which is the metric people most want percentiles for, so
it should be a decision you made rather than a surprise.

What a live latency panel *can* show, from a gauge: `min`, `max`, `count`, and
`sum / count` for the mean. For p95 the options are a shorter `flush` on the
event, or a ClickHouse query that lags by one flush interval.

## What you can and cannot see

| | visible to live read |
| --- | --- |
| Open bucket | yes |
| Closed, not yet flushed | yes |
| Claimed, write in flight | **no** — hidden for the duration of the claim |
| Flushed and acked | **no** — unless the metric sets `retention` |
| Kept under `retention` | yes, read-only, until the TTL expires |

A metric with `resolution: '1s'` and `flush: '5m'` therefore has up to 5 minutes of live history. A metric that flushes every 10 seconds has almost none — live read is most useful precisely where the flush cadence is long, which is the case that motivated it.

## In use

```ts
import { dogPoops } from './metrics/schema'

// the headline case: a dashboard reading a 5-minute counter mid-window
await dogPoops.current({ dogName: 'Willow', park: 'riverside', kind: 'solid' })
// -> 7

await dogPoops.current()
// -> [
//      { dogName: 'Willow', park: 'riverside', kind: 'solid',  value: 7 },
//      { dogName: 'Rex',    park: 'central',   kind: 'liquid', value: 2 },
//    ]
```

```ts
// per-second detail inside the current unflushed window
await dogPoops.snapshot({ dims: { park: 'riverside' }, rollup: 'none' })
// -> [
//      { bucket_ts: '14:03:07', dogName: 'Willow', park: 'riverside', value: 2 },
//      { bucket_ts: '14:03:08', dogName: 'Willow', park: 'riverside', value: 1 },
//      …
//    ]

await dogPoops.snapshot({ rollup: 'sum' })
// -> [{ dogName: 'Willow', park: 'riverside', value: 7 }, …]
```

```ts
// a dashboard endpoint — DB for history, live read for the tail
app.get('/api/poops', async (req, res) => {
  const [history, live] = await Promise.all([
    ch.query(`SELECT bucket_ts, dogName, sum(value) AS value
              FROM dog_poops WHERE bucket_ts >= now() - INTERVAL 1 HOUR
              GROUP BY bucket_ts, dogName`),
    dogPoops.snapshot({ rollup: 'none' }),
  ])
  res.json([...history, ...live])   // live picks up exactly where the DB stops
})
```
