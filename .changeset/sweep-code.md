---
"metrichouse": patch
---

- A final flush of a locally staged event, or of an event staged in a driver that is not durable such as `memory()`, claims until a claim comes back empty, with no cap of a hundred claims. With a small `claimLimit`, `house.stop()` no longer drops the records past the hundredth claim.
- `nextEligibleInMs` in a cadence skip counts to nine tenths of the interval, the moment the cadence lets the metric ship again, rather than to the whole interval.
- `createHouse({ driver: memory })`, a driver factory passed without calling it, throws `createHouse: driver is a function, not a driver. Call it, as in memory() or ioredis(client)` instead of printing the function's source.
- A `defaults.grace` or `defaults.flush` that is not a duration throws an error naming the setting, such as `createHouse: defaults.grace: parseDuration: -1`.
- When a send of a locally staged batch fails, the `batch.maxAge` clock starts again from the failure even when a record staged during the send had already started it.
- A locally staged event ships the records an earlier `stage: 'driver'` declaration left in the driver on its immediate sends and on `drain()`, so under immediate delivery they no longer wait for a `flush()` that may never come.
- An immediate send of a counter, gauge, timer or level asks the driver where its write landed only when this process has claimed at or past the window the write aimed at, or when that window reads back empty. On nearly every write the send now makes one read instead of two.
- When Redis forgets its scripts again between the reload and the resend, the Redis driver reloads and resends the refused call again, up to three times, still ahead of anything made after it, instead of failing the call.
- The Redis driver loads its scripts inside one `MULTI`/`EXEC` when the client has `multi()`, and each script carries a comment naming its set, so no script shares a SHA with 0.7.0 or with a build whose scripts differ. `IoredisTransaction` is exported from `metrichouse/ioredis`.
