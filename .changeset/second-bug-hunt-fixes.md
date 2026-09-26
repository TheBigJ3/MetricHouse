---
'metrichouse': minor
---

Fixes for wrong values, lost errors and driver disagreements found by a second
round of bug hunting across the drivers, the metric types and the runtime.

**Values that shipped wrong**

- A level whose flush carried a value into a window that a late `set()` had
  already written kept the window right but carried the older value into every
  empty window after it. It now carries the value the window ended at.
- A dim named after a column the metric writes, such as `id`, `value` or a
  gauge's `min`, overwrote that column or was overwritten by it. A dim named
  `id` gave every window of a series the same row id. These names now throw at
  declaration.
- A gauge or timer that did not ship `sum` told its sink a `total` of `0`. The
  total is now every observed value added up, whichever columns ship.
- `add(5n)` or `add(true)` on a counter with no dims counted 1, and `inc(5n)`
  moved a level by 1. A first argument that is neither a number nor a dims
  object now throws.
- An integer counter or level could pass `Number.MAX_SAFE_INTEGER` and stop
  being exact without any error. The driver now refuses that write, and a delta
  past the limit throws at the call with a message that no longer calls it a
  fraction.
- On Redis, a batch of gauge observations aimed at two windows below the
  watermark was folded out of order, so `last` could be wrong.
- `rowShape()` reported a dim or field with a `.default()` as optional, so a
  table built from it had a nullable column.

**Failures reported as success, or not at all**

- A sink that rejected with no reason, as `Promise.reject()` does, counted as a
  successful flush. `house.stop()` then called it a hundred times. It is now
  reported as an error naming the metric.
- On Redis, an `ack` whose reply was lost and resent after a reconnect failed a
  flush that had succeeded, a resent recovery reported that it found nothing,
  and a resent `claimRecords` took twice its limit. Each now answers the way
  its first arrival did.
- A failed recovery pass on a scheduled flush never reached `onError`.
- A log line threw for a caught value `String()` cannot convert, and for an
  `Error` whose `message` or `stack` is not a string. It now writes a row.

**Settings and inputs that were accepted and misbehaved**

- A `flush`, `defaults.flush` or `batch.maxAge` of zero, or longer than just
  under 25 days, made the scheduler fire about every millisecond. Both now throw
  at declaration.
- An unknown `delivery` value behaved as `'staged'`. It now throws.
- A metric whose own registration failed stayed bound, so calling `createHouse`
  again with the same metrics, as the docs say to, failed.
- A metric named `__proto__` vanished from flush reports and snapshots, and a
  metric name holding half of a surrogate pair could share Redis keys with
  another. Both now throw.
- A dim or field named like a whole number, such as `'2024'`, lost its declared
  place in the row. Those names now throw.
- An invalid `Date` for a snapshot's `to` included the window still filling. It
  now throws, as does one for `from`.
- A grouped snapshot row carried an absent optional dim as a key holding
  `undefined`.
- A gauge accepted an aggregate named twice, an event `timestamp` naming an
  inherited property such as `toString` got the wrong error, and a level named
  `then` made a logger awaitable. All three now throw clearly.

**The two drivers now agree on**

- Refusing a first increment or observation that is not a finite number.
- Changing nothing when one write in a batch is refused, and leaving no empty
  window behind when the memory driver refuses a new series.
- A read on Redis seeing a write issued before it that has not resolved yet.
- Handing back a record field shaped like the Redis driver's own date marker
  unchanged.

Error messages no longer use a dash as punctuation, so a few messages read
differently. A test matching on the exact old text may need updating.
