---
"metrichouse": patch
---

- A level on Redis keeps each series in the four fields 0.7.0 reads, `value|carried|writtenAt|heldThrough`, and `carriedFrom` in a hash of its own, `mh:lvlfrom:<metric>`, only when those four cannot say it. A carried cell is stored as `@ 7` and a moved one as `@7 `, which 0.7.0 reads as `7`. A 0.7.0 process sharing the namespace in a rolling deploy now ships the same rows as one process alone, where it used to overwrite series it could not read and ship `NaN` for carried cells. A series or cell a prerelease build of 0.8.0 stored as five fields or as `@c7` is still read, and is rewritten in the new layout the next time it is written or carried.
- A second `set()` that missed its window and moved forward to the watermark replaces the first one moved there, and `current()` follows it. It used to be dropped, as if the first were a reading taken in that window. A reading taken in the window itself still wins over both.
- An `inc()` or `dec()` that arrives late, aimed at a window inside a stretch where the series had passed `holdFor` before a newer write revived it, starts from zero. It used to build on the value the series expired with.
- `totals()` and a merging `snapshot()` on a level declared `value: int()` add stored fractions, which a `float()` level wrote, as doubles: `1.5` and `0.5` total `2`, and a total that is not a whole number rejects with an error naming the cause. They used to throw a bare `RangeError`.
- Level writes and flushes on Redis cost about what they cost in 0.7.0 again. A flush holds every series from one read of the windows between its pointer and the window it fills, and a write reads the windows after its own once per call.
- The Redis driver loads a script once when many calls in one batch first need it. A first level carry used to load the same script once per window it filled.
- Document that a level series whose first write lands between a flush's read and its claim, stamped more than `grace` in the past, loses the windows that flush claims.

Custom drivers: `LevelCell` gains `moved`, which a driver sets on a cell only writes moved forward to the watermark have written.
