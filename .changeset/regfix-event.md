---
'metrichouse': patch
---

Events and logs:

- A staged record the current declaration cannot read, one missing a field now
  required or holding a value its field no longer accepts, ships with its
  values as stored and is reported to `onError` with the metric, its id and the
  reason, instead of failing every flush that claimed it and holding up every
  record behind it. `peek()`, `snapshot()` and `house.snapshot()` return it as
  stored too, and a process reports each record at most once.
- A locally staged event asks the driver for records an earlier
  `stage: 'driver'` declaration left there only until the driver answers that
  it holds none, and again once per flush interval after that. Until then a
  flush and `pending()` make no driver call. A driver that fails or does not
  answer within 5 seconds, or the flush interval when shorter, is reported to
  `onError` and counts as holding none, so a Redis that is down no longer fails
  a local flush, hangs `pending()` or keeps `house.stop()` from returning.
- A flush of a locally staged event ships the records left in the driver and
  the local buffer in the same send, instead of leaving the buffer for the
  next trigger.
- Records refused past `batch.maxStaged` are reported once per turn of the
  event loop, naming how many were refused, instead of one error per record.
