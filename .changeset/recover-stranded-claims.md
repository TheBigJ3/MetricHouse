---
'metrichouse': minor
---

Claims stranded by a crashed flush are now recovered.

A claim moves data out of the live set, which is what stops two flushers
shipping one window. It is also why a process that died holding one left data
nothing could reach again: `claim` reads the live set, and the abandoned batch
was no longer in it. On `ioredis` that batch survived the crash in Redis and
then sat there for ever. At-least-once held across a failed *write*; it did not
hold across a failed *process*. Now it does.

- **`driver.recover(metric)`** is new. The flush calls it after the cadence
  check and before it claims, so whatever it puts back ships in that same
  flush. There is nothing to turn on.
- **`ioredis(client, { recoverAfter })`**, five minutes by default, is how long
  a claim may be held before a flush treats it as abandoned. Keep it above your
  sink's timeout. Nothing can ask a claim whether its owner is still writing,
  and taking one back from an owner that is merely slow ships those rows twice
  and then fails that owner's `ack`. Waiting is much the cheaper mistake, which
  is why the default is generous.
- **`MetricFlushReport.recovered`** carries a `RecoveryReport` when a pass found
  something and is absent otherwise, so its presence is the news: something
  crashed between claiming a batch and settling it. A pass that throws is
  reported as `recoveryError` and does not stop the flush, so one stuck claim
  never becomes a metric that stops delivering.

A recovered window is merged back into the live set, never shipped from
`recover`. An aggregate row is identified by its metric, its window and its
dims, so the abandoned half and anything written since carry the same row id —
sending them as two batches would let a sink upserting on that id keep one and
discard the other, and the total would be wrong.

`memory()` recovers nothing and always will: its claims live in the process
that took them, so a crash leaves nothing behind to find. That is what
`durable: false` costs, and it is unchanged.

**Breaking for custom drivers:** `Driver` is thirteen methods now, and
`recover` is required. A driver whose claims cannot outlive the process returns
the exported `NOTHING_RECOVERED`.

```diff
 async release(claim) { /* ... */ },
+async recover(metric) { return NOTHING_RECOVERED },
```
