---
'metrichouse': minor
---

Fix how a level carries and adds up its series.

- A write to a level series past its `holdFor` that no flush had dropped yet
  moved the value it expired with, and the next flush carried that old value
  through every window up to the write. The write now starts the series over,
  so an `inc()` starts from zero, and the flush ships the windows it reported
  before it expired and nothing through the gap.
- `level.totals()` and a `snapshot()` that adds series together returned
  `Infinity` for fractional series past the largest double. They now reject.
- On a level declared `value: int()`, `totals()` and a `snapshot()` that adds
  series together now add as whole numbers, exactly, and reject only when the
  exact total is past `9007199254740991`. Added as doubles, a running sum could
  pass that bound partway and come back as a different whole number.
- `level.dec()` named the negated amount when it refused one: `dec(1.5)` on an
  integer level said `-1.5 is not a legal delta`. It now names `1.5`.
- A late `set()` moved forward to the oldest unshipped window replaced a newer
  reading already there. It is now dropped.
- A write that landed while a flush was carrying a series was lost in the
  windows after it. A `set()` landing between the flush reading the series and
  filling its windows now reaches every empty window after it, and one landing
  after the fill replaces the carried values after it up to the next written
  window, and becomes the current value.
- A series whose earliest write reached storage second, from another process
  or moved forward to the oldest unshipped window, skipped the windows between
  its two writes, and an `inc()` there counted from the later value. The series
  now begins at the earlier write, every window between ships, and the `inc()`
  starts from zero.

Custom drivers: `LevelOp` gains `holdFor`, `LevelSeries` gains `carriedFrom`,
and `LevelCell` gains `carried`, which a driver sets on a cell a `hold` writes.
A `hold` fills its window with the value in effect just before it, read when it
lands. The driver contract page has the rules under `setLevel`, and the shared
contract suite checks them. `ioredis()` reads
level state and cells stored by earlier versions.
