---
"metrichouse": minor
---

- A flush claims again while a claim comes back with a full `claimLimit`, up to a hundred claims, so a fleet sharing one turn is no longer capped at `claimLimit` records per interval. `claimLimit` now bounds one claim, and one call to `write`, rather than one flush.
- A flush still running counts as the latest shipment, so a second flush started meanwhile on the same process reports `skipped` on the cadence rather than shipping in the same interval.
- A flush that fails on a later claim reports what the earlier claims wrote as `written`, keeps their `ackError`, and counts as a shipment for the cadence.
- A call up to a tenth of the cadence early counts as on time, instead of fifty milliseconds, so a cron firing a little earlier within its minute no longer waits a whole interval.
- A scheduled flush sends its `ackError` to `onError`.
- `drain()` waits only for the writes issued before it was called, so it resolves under steady traffic. `house.stop()` still waits for writes issued while it drains.
- Under immediate delivery, a flush waits for the immediate sends of that metric already under way before its rows reach the sink, so a stale running total cannot arrive after the flush row from the same process.
- An immediate send for a write moved forward past a released window sends every live window of the series from the one aimed at, so the landing window is always sent.
- `createHouse` refuses a missing driver, an object that is not a driver, and a `now` that is not a function, with messages naming them.
- `house.register()` binds and schedules every metric before warning, and an `onWarn` that throws goes to `onError` instead of leaving metrics half registered.
