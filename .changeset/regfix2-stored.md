---
"metrichouse": patch
---

Stored data the current declaration cannot read:

- A house with no `onError` no longer crashes on news the library reports on its own. A locally staged event that cannot ask the driver for records an earlier `stage: 'driver'` declaration left there, and a staged record the current fields cannot read, are reported only when there is an `onError`, instead of raising an unhandled rejection that ends a Node process. The record still ships as stored.
- A locally staged event's failed driver check on a flush comes back in the flush report as `recoveryError`. A scheduled flush hands it to `onError`, or drops it when there is none, and `pending()` reports it only to `onError`.
- Past 10,000 unreadable staged records per event, or 10,000 unreadable stored series keys per metric, one report says so and later ones are not reported, instead of forgetting the oldest and reporting every record again on each read. An event reports records again once some it remembers have shipped.
- A snapshot that merges series, with `groupBy` or a `rollup`, keeps a series stored under an earlier declaration apart from one written since that reads the same, so a level adds both and a gauge leaves `last` off, instead of dropping one of them.
- Docs: a sink that inserts into a typed table may reject every batch that carries a stored key the current dims cannot read.
