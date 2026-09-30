---
"metrichouse": patch
---

Keep Redis storage readable by 0.7.0 during a rolling deploy.

- A claim on Redis raises `mh:wm:<metric>` to the window boundary it claimed up to, the value 0.7.0 reads, and keeps the lower watermark this version lands late writes by in the hash `mh:wmown:<metric>`, with the windows its writes start between the two, so a write of this version moves past one that a 0.7.0 claim at the same boundary has taken since. The key 0.7.0 reads used to hold one past the newest window with data, off the metric's grid, so a 0.7.0 process moved a late write into a window of its own one millisecond past a real one, and a level carried the wrong value from it. A watermark a 0.7.0 claim raises is still honoured, and one an earlier build stored off the grid is read as it is and replaced by the next claim of this version.
- Every flush of a level on Redis rewrites series an earlier build stored in five fields into the four 0.7.0 reads, even when it carries nothing. They used to stay in five fields until written or carried, and 0.7.0 treated them as absent. A claim that takes, or a release or recovery that puts back, a cell such a build marked `@c` rewrites it as `@ `, which 0.7.0 reads as its number.
- Docs: a namespace shared with 0.7.0 ships each level window by the rules of the version that wrote or carried it, and the upgrade notes say how the two differ.
