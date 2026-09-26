---
'metrichouse': minor
---

Less CPU per write, per staged record and per row a flush or a snapshot
builds, and fewer bytes on the wire for the live reads that ask about one
series or one total. Nothing stored changes, and no result, row id or error
does either.

A minor bump rather than a patch, because the `Driver` interface gains two
optional methods, `readLevel` and `sumBuckets`, and `BucketRange` is exported
for the second. A driver written before them still works unchanged: a metric
asks for them only when a driver has them, and reads the long way otherwise.

- A counter, gauge, level or timer builds its dim key encoder once, when it is
  declared, instead of reading its declaration again on every write. Encoding
  five dims takes about 265 ns instead of 800, and `counter.add()` on
  `memory()` takes about 960 ns instead of 1400.
- An event or log record id draws its random bytes from a pool that is
  refilled from the platform's crypto source, instead of asking the platform
  once per id. Minting an id takes about 150 ns instead of 700.
- The `ioredis()` driver stores and reads a record without the extra JSON
  pass when there is no date and no reserved key in it. The stored bytes are
  the same. Reading a claim of 10,000 records takes about 16 ms instead of 30.
- A counter or gauge `snapshot({ dims })` builds only the rows the filter
  keeps. Picking one series out of 50,000 on `memory()` takes about 15 ms
  instead of 53.
- A row id is written out as hex a byte at a time from a table, instead of
  through `toString(16)` and `padStart`. The ids are the same to the
  character. Hashing 200,000 ids takes about 50 ms instead of 196.
- A counter, gauge or level builds its dim key decoder once, when it is
  declared. A key with no escape character in it is split in one pass, and
  every other key is read exactly as before. Decoding 200,000 keys of three
  dims takes about 55 to 70 ms instead of 125 to 180. With the faster ids,
  turning a claim of 200,000 counter rows into rows takes about 220 ms
  instead of 484, and a level carrying 200 series through 1,000 windows on
  `memory()` flushes in about 340 ms instead of 520.
- Keeping track of a write until it lands makes one promise instead of three.
  Tracking 200,000 writes takes about 80 ms instead of 158, and 200,000
  `counter.add()` calls on `memory()` take about 213 ms instead of 275.
- A level `set()` or `inc()` on `memory()` that lands in the newest window no
  longer looks through every unflushed window for a later one. With 3,000
  unflushed windows, 20,000 writes take about 25 ms instead of 498.
- The `ioredis()` driver sends a write without waiting on a promise per
  script once every script it uses is loaded.
- The `ioredis()` driver reads one series across its windows in one round
  trip instead of two. `counter.current(dims)` and every immediate delivery
  send read this way.
- `level.current(dims)` reads the one series it asks about instead of every
  series the level holds. With 5,000 series on `ioredis()` it takes about
  0.15 ms instead of 17.
- `counter.current()` on an integer counter adds up the open window inside
  Redis when no order of adding could change the total, instead of fetching
  every series. With 20,000 series it takes about 5 ms instead of 47. A float
  counter, and any total that could round, still adds the series itself.
