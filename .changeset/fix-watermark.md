---
'metrichouse': minor
---

- A final flush on a driver that is not durable, such as `memory()`, also ships
  every window ahead of the clock. After the clock stepped back, `house.stop()`
  used to report success with nothing shipped and the writes were lost.
- A claim raises the watermark no further than one past the newest window that
  held data, and a claim that finds nothing leaves it alone. One flush on a clock
  far ahead no longer moves every later write into a single window that no flush
  can take until the clock catches up.
- `current()` on a counter, a gauge or a timer, and `gauge.totals()`, read the
  window a write made now lands in, so a write moved ahead of a clock that
  stepped back counts in the open total.
- A write aimed below the watermark lands on the first window of its own
  resolution at or past it. After a change of resolution it used to land on the
  old watermark, off the new grid, and a level lost the value it set in every
  window carried after it.
- Driver contract: `IncrOp`, `GaugeOp` and `LevelOp` carry `resolutionMs`,
  `claim()` takes an optional `aheadFrom`, and a driver may add `landing()`. A
  custom driver has to land a moved write on the operation's own grid, and
  follow the new watermark rules in the driver contract reference.
