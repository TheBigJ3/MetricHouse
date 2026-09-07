# Flush

Flush is explicit — you call it from a cron, a worker, or the [collector](18-collector.md) — and it claims closed buckets, shapes rows, calls your write function, then acks. A metric's `flush` setting is a **minimum cadence**, not a schedule, so calling `house.flush()` every 10 seconds still ships a 5-minute metric only every 5 minutes.

## Main functions

**Entry points**
- `house.flush(opts?): Promise<FlushReport>`
- `metric.flush(opts?): Promise<FlushReport>` — one metric

Opts:
- `only` — restrict to named metrics
- `force` — ignore the `flush` cadence and ship everything closed now
- `includeOpen` — also ship the current partial bucket; off by default, and only safe because row ids make the later re-send converge
- `concurrency` — how many metrics ship in parallel, default `4`
- `rowBatch` — call the sink repeatedly with at most this many rows, default unlimited
- `yieldBetweenBatches` — hand control back to the event loop between batches, so a multi-million-row flush cannot stall a request process
- `deadline` — a timestamp; claim only what can plausibly ship before it, ack what shipped, and report the rest as `remaining` rather than releasing the whole claim
- `signal` — `AbortSignal`, checked between metrics and between batches

**Recovery**
- `house.recover(opts?)` — reclaim work orphaned by a crashed flusher, past `claimTtl`

**Report**
- `FlushReport` — `{ ok, complete, remaining, durationMs, metrics: Record<name, { buckets, rows, skipped, error? }> }`
- `.throwIfFailed()` — for callers that want an exception instead of a report

## Lifecycle, per metric

```
1. cadence     now - lastFlush >= metric.flush ?     no → skip (recorded as skipped)
2. watermark   closedUpTo(resolution, now, grace)
3. claim       driver.claim(metric, watermark)       atomic; invisible to live read
4. materialize dimKey → columns, fold gauge aggregates
5. identify    assign deterministic id per row        → 14-identity.md
6. write       await metric.write(rows, ctx)          → 13-sink.md
               repeated per `rowBatch`, yielding if asked
7a. ok         driver.ack(claim)                      deleted, or kept under `retention`
7b. throw      driver.release(claim)                  retried next flush()
8. cadence     lastFlush = now                        only on success
```

Nothing is deleted before your `write()` resolves. That is the entire at-least-once guarantee, and it is why a duplicate is possible and a loss is not.

**Why `deadline` is not the same as `signal`.** Aborting mid-flush releases the
whole claim, so the next call re-claims the same backlog and hits the same wall
— a backlog longer than one invocation livelocks while every individual flush
"fails" cleanly. `deadline` bounds what is *claimed*, so each call finishes what
it started and `remaining` tells the next one where to continue.

## In use

```ts
// a worker
import { house } from './metrics/house'

setInterval(async () => {
  const report = await house.flush()
  if (!report.ok) console.error(report.metrics)
}, 10_000)
```

```ts
// shutdown — ship everything, including the open bucket
process.on('SIGTERM', async () => {
  await house.flush({ force: true, includeOpen: true })
  await house.close()
})
```

```ts
const report = await house.flush({ only: ['dog_poops'], force: true })

// {
//   ok: true,
//   durationMs: 41,
//   metrics: {
//     dog_poops: { buckets: 300, rows: 812, skipped: false },
//   },
// }
```

Cadence in action — one call, different outcomes per metric:

```ts
await house.flush()
// {
//   dog_poops:    { skipped: true,  reason: 'cadence', nextEligibleIn: '3m41s' },
//   walk_started: { buckets: 0, rows: 214, skipped: false },   // flush: '30s'
//   app_log:      { buckets: 0, rows: 1893, skipped: false },  // memory-staged
// }
```
