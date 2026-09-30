---
"metrichouse": patch
---

- The Redis turn key `mh:turn:<metric>` holds the time alone again, the layout 0.7.0 reads, and the token moves to `mh:turntok:<metric>`. A 0.7.0 process on the same namespace no longer fails every flush, and a turn key left as `at|token` by an earlier build is rewritten into the two keys the first time a process takes or gives back that turn.
- Under immediate delivery, a flush waits only for the immediate sends aimed at a window it claimed, and for at most one `flush` interval, so a `write` function that never answers an immediate send no longer holds up every later flush of the metric.
- When flushes overlap, the cadence counts from the one started last, so a slow flush finishing after a forced one no longer lets the next call ship twice in one interval.
- When Redis has forgotten its scripts, the Redis driver sends the refused scripts of every round trip of one call again in one step, so a later call cannot land between them.
- An immediate send for a write aimed at a released window sends the window the write landed in as well.
- `counter.current()`, `gauge.current()` and `gauge.totals()` on Redis ask where a write lands at the same time as they read, so they wait for one round trip instead of two.
