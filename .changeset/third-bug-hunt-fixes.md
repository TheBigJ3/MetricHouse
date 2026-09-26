---
'metrichouse': minor
---

Fixes from a third round of bug hunting, mostly in code the previous round
changed.

**Values that shipped or read back wrong**

- A level hold for a window that a claim had already taken, arriving a second
  time from a racing flusher or a resend, put `carried` back to an older value,
  so every empty window after it shipped that value.
- A level `set` or `inc` batch refused partway kept the operations before the
  refusal, and on Redis a resend applied them a second time. A refused call now
  changes nothing in its window.
- A level snapshot could leave out the oldest window the next flush shipped
  after a gap longer than 10,000 windows.
- An event row, and a grouped snapshot row, carried an inherited value such as
  `Object`'s `constructor` for an omitted field or dim of that name.
- `add(new Date())`, `add([])` or `add(new Number(5))` on a counter with no dims
  counted 1. They now throw, as `inc()` and `dec()` on a level do.
- An integer counter's total across series, from `current()` or a merging
  `snapshot()`, could pass `Number.MAX_SAFE_INTEGER` and come back as a
  different whole number. It now rejects.
- A dim or field named `bucket_open` or `bucket_elapsed_ms` was overwritten in
  every snapshot row. Those names now throw at declaration.
- `timer.time()` returned a new promise rather than the one `fn` returned, and
  a thenable whose `then` returns nothing came back as `undefined`.
- On Redis, a bounded `readPending`, which `event.snapshot({ from, to })` uses,
  skipped or repeated records when another process claimed or released between
  pages.
- On Redis, an invalid `Date` in record fields came back as an object, and a
  level write at a fifteen digit timestamp read the wrong window.

**Failures that stopped other work or were lost**

- With no `onError`, one failed background write made `house.drain()` and
  `house.stop()` reject early, and `stop()` then skipped the final flush for
  every metric. An `onError` that threw on a scheduled flush did the same.
- When a sink failed and putting its rows back failed too, the flush report
  carried only the second error. The sink's error stays in `error`, and the
  new `releaseError` field reports the other.
- A locally staged event kept calling its sink on a timer after `house.stop()`
  had returned.
- A scheduled flush that failed with no `onError` was dropped silently, where
  the docs say it becomes an unhandled rejection. It now does.
- On Redis, a release that met a cell of another kind stranded the rest of its
  claim where no recovery could find it.
- On Redis, an error from a batch spanning several metrics named the first
  metric rather than the one refused.
- A log line still threw for a revoked proxy, or a value whose class tag
  getter throws.
- A level with a `holdFor` long enough to pass the largest safe timestamp
  failed every flush.

**Settings accepted and misread**

- An unknown event `stage`, a `sample` that is neither a number nor a function,
  and an unknown snapshot `rollup` now throw instead of acting as a default.
