---
'metrichouse': minor
---

Separate **delivery** from measurement — the house decides how rows get out.

A metric declares what it measures: resolution, dims, which aggregates it
keeps. How that data reaches your `write()` is a property of the deployment,
not of the schema, so it moves to `createHouse`. The same schema file now runs
on a dev branch against `memory()` and in production against a shared driver
without either one editing a metric.

- **`createHouse({ delivery })`** — `'staged'` (the default, and what every
  house did before) waits for `flush()`; `'immediate'` ships as data arrives;
  `'auto'` asks the driver. A driver that cannot survive a restart holds data
  at risk for no benefit, so `'auto'` resolves it to `'immediate'` — which is
  the memory driver, and the reason the setting exists. `house.delivery`
  reports the resolved mode.
- **`createHouse({ defaults })`** — `flush` and `grace` for metrics that
  declare neither. Filled in, never overridden: a counter that declares
  `flush: '5m'` because it carries money keeps it. `flush` is consequently
  optional on `counter`, `gauge` and `timer`, and the check that resolution
  divides it evenly now also runs at bind time, where a cadence from the house
  first becomes knowable.
- **The two storage models diverge, on purpose.** A staged kind — event, log —
  is complete when recorded, so immediate delivery claims and ships it exactly
  as a flush would and **replaces** flush. A bucketed kind is still folding, so
  immediate delivery sends the *cumulative* open bucket through the read path
  and deletes nothing; `flush()` is still what retires the closed bucket, and
  its row carries the same id and the complete fold. `stage` still says where a
  record waits; `delivery` says when it leaves.
- **`source: 'immediate'`** on `WriteContext`, and a sink handling it must keep
  the **newest row per `id`** rather than fold duplicates — a bucketed row is a
  running total that a later send supersedes. The house warns once at boot
  rather than leaving it to be discovered from a wrong dashboard.
- **`shipOpenSeries()`** is exported beside `shipClaim()`: read one live
  series, materialize, write, claim nothing. Shipping one row per `add()` would
  be silent corruption — `rowId` hashes the bucket and the dims and not the
  value, so every increment in a bucket mints the same id.
- **`gauge()` takes a kind**, as `stagedMetric()` already did, so a timer
  shipping itself reports `'timer'` and not `'gauge'`.
