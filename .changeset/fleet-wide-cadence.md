---
'metrichouse': patch
---

The `flush` cadence now holds across every process that shares a driver, and
neither a rolling deploy nor one server's own timers send bursts of small
inserts.

**One shipment per interval for the whole fleet**

Each process used to keep its own record of when a metric last shipped. With
`ioredis()` and several servers running `house.start()`, the claim stopped two
of them shipping the same rows, but each server still shipped whatever had
closed since another one last did. N servers made up to N inserts per
interval. An event with `flush: '12s'` on six servers made 32 inserts in 72
seconds where the cadence allows 7, and 58 on twelve servers. ClickHouse
writes every insert as a new part, so this showed up as `Too many parts`.

A flush on a shared driver now takes the metric's turn from the driver before
it claims. The driver refuses the next turn until a full interval has passed,
whichever process asks, so each metric ships at most once per interval for the
whole fleet. Six servers and twelve servers each made 6 event inserts in the
same 72 seconds.

- A flush another process beat to the turn reports `skipped: true` with
  `reason: 'cadence'`, and `nextEligibleInMs` counts from that process's turn.
- A flush that writes nothing, because nothing had closed or because the sink
  threw, gives its turn back, so another process can ship straight away.
- `force` still ships at once, and records its turn.
- A flush that cannot reach the driver to take its turn reports that as its
  `error` and claims nothing.
- A locally staged event takes no turn, since only its own process holds its
  records. Neither does `memory()`, which serves one process.
- Turns compare each server's own clock. A turn stamped by a clock less than
  one interval ahead holds the others back, and one more than an interval away
  counts as a clock that stepped and lets the flush go ahead.

**Rolling deploys**

The final flush `house.stop()` makes now waits for the turn on a driver that
is shared and durable, where it used to ship at once. Six servers stopping
three seconds apart sent 16 small inserts, as few as 7 rows each, and now send
3. What a stopping server leaves stays in Redis for whichever server takes the
next turn. If every server stops, it waits there until one runs again. Pass
`house.flush({ final: true, force: true })` to ship it anyway from a process
that knows it is the last. On a shared driver that is not durable, a final
flush still ships at once.

**Metrics on one server**

`house.start()` armed every metric's timer at the same moment, so a server
sent all its inserts within the same second each interval. Each metric's first
tick now fires at its own point in the interval, worked out from a hash of its
name, so the same metric sits at the same point on every server and after a
restart. How often a metric ships does not change.

**For driver authors**

`Driver` gains two optional methods, `takeTurn` and `returnTurn`, and a
`ShipTurn` type. A driver without them, or with `shared: false`, keeps the
cadence in each process as before. `ioredis()` keeps each turn in a key
`<namespace>:turn:<metric>`.

The sink guide now covers ClickHouse asynchronous inserts, and why
`wait_for_async_insert` has to stay at `1`.
