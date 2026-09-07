# Coldchain

A hypothetical reefer-monitoring platform, written against MetricHouse **after**
the Tollgate revisions. Where Tollgate stress-tested the original spec, Coldchain
was chosen specifically to attack the fixes that came out of it.

100,000 refrigerated shipping containers. Each reports temperature, humidity,
door state, and compressor duty every 10 seconds. Then the ship leaves port and
the container is offline for six days.

## Why this one

| Coldchain does | which attacks |
| --- | --- |
| uploads 6 days of readings in one request | the new `at:` backdating rule (#06) |
| trusts a drifting device RTC | the single-timestamp row shape |
| runs a ship-side gateway with `memory()` | driver parity, and federation |
| keeps 7 years for regulators | retention, rollup, storage cost |
| answers "minutes above −15 °C" | whether `counter` can express time-in-state |
| tracks 100k long-lived series | `level()`'s unbounded `total` hash |
| runs firmware from 2019 alongside 2026 | `assertCompatible` and schema evolution |

## Layout

```
src/metrics/schema.ts          declarations, using level/distinct/derive/float
src/metrics/house.ts           cloud house
src/ingest/upload.ts           the bulk backfill path — where it breaks
src/ingest/clock.ts            device clock skew
src/edge/gateway.ts            ship-side house, and the federation gap
src/compliance/excursions.ts   time-in-state, and why it half-works
src/dashboard/fleet.ts         live fleet view
src/dashboard/queries.sql      the plating
```

Workarounds are marked `FLAW C01`…`C09` inline. `FINDINGS.md` has the reasoning,
plus a section on which Tollgate fixes held up under a completely different
workload — five of six did.

Nothing here runs.
