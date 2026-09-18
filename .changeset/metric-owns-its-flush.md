---
'metrichouse': minor
---

The metric owns its flush.

A metric is now a complete unit — what it measures, how often it ships, and
where it ships to — so `metric.flush()` works with no house involved. `flush`
and retry state moved out of the house's bookkeeping and onto the metric
itself.

- **`metric.flush(options?)`** ships that metric to its own sink and returns
  its `MetricFlushReport`. Honours the metric's cadence; `{ force: true }`
  ignores it.
- **`house.start()` / `house.stop()`** — an opt-in scheduler that gives each
  metric its own interval at its own cadence, so `flush: '5m'` becomes an
  actual cadence rather than only a floor. For long-lived processes; edge and
  serverless keep pumping `house.flush()` from a cron, because a timer in a
  frozen isolate never fires. `stop()` clears the timers, drains, and forces a
  final flush.
- **`house.flush()`** is now a fan-out over `metric.flush()`. Same signature,
  same `FlushReport`, `only` and `force` unchanged.

**Breaking:** `write` is required on every metric, and `createHouse({ write })`
is gone. A house is somewhere to keep a set of metrics, not the thing that
ships them, so there is no longer a fallback sink to fall back to — which also
retires the "no write()" runtime errors, now a compile error instead.

```diff
-const hits = counter('hits', { resolution: '1s', flush: '5m' })
-const house = createHouse({ driver, schema, write: send })
+const hits = counter('hits', { resolution: '1s', flush: '5m', write: send })
+const house = createHouse({ driver, schema })
```
