---
'metrichouse': minor
---

A new `level` metric, for a value that holds between writes.

A gauge stores what was observed in a window, so a window nobody wrote to has
no row and a chart of it has a hole. That is right for something you sample and
wrong for queue depth, requests in flight, or connections checked out of a pool.
A level keeps one value per series and carries it into every window nobody wrote
to.

```ts
import { level, oneOf } from 'metrichouse/core'

export const queueDepth = level('queue_depth', {
  dims: { queue: oneOf(['email', 'export', 'webhooks']) },
  resolution: '1m',
  flush: '1m',

  // A series with no write for five minutes stops reporting, so a worker
  // that dies does not leave its last depth on the chart forever. Leave it
  // out and a series holds until something changes it.
  holdFor: '5m',

  write: async (rows) => clickhouse.insert({ table: 'queue_depth', values: rows }),
})

queueDepth.set(42, { queue: 'email' })   // every minute reports 42 from here
inFlight.inc()                           // and inc/dec for what is counted in and out
```

Rows carry one `value` column. `current()` reads the held value rather than the
open window, and returns `undefined` for a series nothing has written to.
`totals()` adds every series up, which is the merge a level can make honestly
and the opposite of the gauge's.

Each flush walks every series forward through whatever was actually written, so
a window belongs to the value that was true then rather than to the newest one.
Set a queue to 42 at noon and to 38 at three and the windows in between hold 42.

**Breaking for custom drivers.** `Driver` grows three methods, because a level
needs a number that outlives the flush that shipped the last window and nothing
in the contract could hold one:

- `setLevel(ops)` puts a series at a value, moves it by a delta, or carries what
  it holds into a window that has none
- `readLevels(metric)` returns every series a level currently holds
- `dropLevels(metric, dimKeys)` forgets series that have expired

The built in `memory()` and `ioredis()` drivers implement all three, and the
shared contract suite covers them, so a driver written against it only has to
run the suite again. `Cell` also gains `LevelCell`, and `isGaugeCell` now checks
the shape of a cell rather than only whether it is an object. The full contract
is on the [driver contract](https://www.metrichouse.dev/reference/driver-contract)
page.
