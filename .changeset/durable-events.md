---
'metrichouse': minor
---

Add `durability` to `event()`. An event declared `durability: 'durable'` makes
`record()` and `recordMany()` return a promise that resolves once the driver has
answered that the record is staged, and rejects otherwise, so an order log or an
audit trail is never reported as kept when it was not. A relaxed event still
returns at once and reports a refused write to `onError`.

A durable event needs `stage: 'driver'` and no `sample`, and its derived counters
move once the driver has answered. Whether a staged record also survives a crash
of Redis is Redis's own setting: under `appendfsync always`, Redis writes to disk
before it answers. The house warns at startup when a durable event is bound to a
driver that cannot survive a restart, such as `memory()`.

`driver.close()` on `ioredis()` now quits a client it made once when it is called
twice at the same time, where the second call used to reject.
