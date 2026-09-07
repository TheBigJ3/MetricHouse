# Findings — Coldchain

Built against MetricHouse **after** the Tollgate revisions, on a workload chosen
to attack them: 100,000 containers, six-day offline gaps, untrusted clocks, a
ship-side gateway, and a seven-year regulated retention window.

**9 flaws · 4 missing configs · 0 missing stat types.**

Zero new primitives is the useful result. The chef rule held under a workload
that looks nothing like an API gateway — everything Coldchain needed was either
already there or was correctly someone else's job.

---

## Blocking

### C01 · `at:` cannot express backfill, and fails loudly in the wrong direction

`src/ingest/upload.ts`

A container surfaces after six days and posts 51,840 readings. The backdating
rule added for Tollgate says a write into an already-flushed bucket goes to the
**oldest open bucket** with a `LATE_WRITE` warn. Applied here, six days of
history collapse into one bucket at the moment the ship docked: one enormous
spike, six days of nothing, and 51,840 warnings. The data is not lost, it is
worse — it is confidently wrong.

`allowLate: 'reject'` is not an improvement. It drops the regulated measurement
the product exists to retain.

**The distinction the spec is missing: late ≠ historical.** A late write is a
straggler belonging to a bucket that has nearly closed — that is what `grace`
and `at:` were designed for, and they handle it correctly. A historical write
is data about a period that is finished, flushed, and never coming back. It
should not go through buckets at all.

**Fix:** `house.backfill(metric, rows, opts)` — materialize, fold, assign real
deterministic ids, hand straight to the sink, bypassing buckets and claims
entirely. It is the flush pipeline minus the driver, which is most of the way
built already.

Without it, `upload.ts` hand-rolls bucket alignment, gauge folding, and a fake
row id, and the derived counters from `reading.derive` are simply absent for
the backfilled range — so `temp_c` and `reading` disagree for six days of every
voyage.

### C03 · No way to hand pre-materialized rows to a house

`src/ingest/upload.ts`, `src/edge/gateway.ts`

Each vessel runs its own MetricHouse on the memory driver and syncs over
satellite. Its flush produces rows that are already correct — right shape,
folded aggregates, deterministic ids that make a retried uplink converge. The
`14-identity` design works perfectly across a network boundary it was never
designed for.

There is no entry point on the other side. `write()` is the only way out and
there is no `ingest()` in. So the ship either re-implements the wire format or
writes to the cloud database directly — from a vessel, over satellite, with
production credentials on a box in a container yard.

**Fix:** `house.ingest(metricName, rows)`, validating shape and re-deriving
nothing. Same primitive C01 needs. One addition closes both, and it turns
MetricHouse into something that can be tiered — edge → regional → cloud — which
is a capability, not just a fix.

---

## Painful but shippable

### C02 · One timestamp per row, and ingest needs two

`src/ingest/clock.ts`, `src/metrics/schema.ts`

A reefer RTC drifts, loses power, and occasionally reports 1970. Every device
timestamp is a claim. Rows carry `ts`/`bucket_ts` and `at:` sets it; there is no
reserved place for "when did this actually reach us", so `schema.ts` hand-
declares `deviceTs`, `ingestedTs`, and `clockSkewMs` as ordinary fields.

Workable, but: every ingest-shaped user invents different names for the same
three columns; `metrichouse inspect` cannot show ingest lag because it does not
know which column means that; and after the fact a backfilled row is
indistinguishable from a live one — which for a regulated dataset is exactly the
audit question.

**Fix:** a reserved `_ingested_at`, written by the driver on every row and never
by the caller. One column, three problems.

### C05 · No rollup, and the DDL generator is the only thing that could emit one

`src/metrics/schema.ts`, `src/dashboard/queries.sql`

100,000 containers × 3 sensors at 60s resolution is ~29 GB/year before
compression, retained for seven years by regulation. Nobody queries
minute-resolution data from 2021 — but 60s is the right resolution for the first
week, so the metric must declare it.

`metrichouse cost` correctly refuses 1s resolution here, which is the #05 fix
doing its job. What it cannot do is suggest the actual answer, which is
resolution that degrades with age.

The rollup itself is plating — a ClickHouse `TTL … GROUP BY … SET` clause, and
`queries.sql` has it hand-written. But the generator already knows the natural
key and the gauge aggregates, so it is the only component that can write that
clause correctly, and getting it wrong silently corrupts seven years of
compliance data.

**Fix:** `rollup: [{ after: '7d', to: '1h' }, { after: '90d', to: '1d' }]` on a
metric, consumed **only** by the DDL generator. MetricHouse still never runs it.

### C06 · A level's `total` hash is permanent, and `evictAtZero` does not help

`src/metrics/schema.ts`

`level()` keeps a running total that is never flushed and never deleted — stated
plainly in `20-level.md`, and correct. At 100,000 containers that is 100,000
permanent hash fields, and `evictAtZero` makes it worse rather than better: a
closed door is level `0`, the state containers are in ~99% of the time, so
eviction churns the key on every open and close.

A container that leaves the fleet leaks its field forever. Nothing knows when
that happened, so nothing calls `.reset()`.

**Fix:** `totalTtl: '30d'` — expire a series' total if it has seen no activity
for that long, since a level with no writes in a month is a dead series, not a
held value. Refreshed on every `inc`/`dec`, so live series never expire.

### C07 · Memory-driver levels reset on reboot, with no way to restore

`src/edge/gateway.ts`

Documented behaviour, and the doc is honest. But the memory driver was blessed
for single-process production use, and a ship-side gateway on a brownout-prone
vessel is exactly that case. Every reboot zeroes `doors_open` for 200
containers, and `onBoot()` hand-persists and hand-restores.

**Fix:** `driver.restoreTotals(map)` plus a `dumpTotals()` to pair with it. Small,
and it makes the memory driver's production blessing actually true.

### C04 · Time-in-state works; the live half does not

`src/compliance/excursions.ts`

"Minutes above −15 °C" is expressible with a plain counter: accumulate elapsed
milliseconds when the excursion ends, attributed with `at: startedAt`. **No new
primitive needed**, which is the right answer — duration is derivable from
transitions, so the chef rule says MetricHouse should not grow a `stopwatch()`.

The gap is that an excursion in progress has contributed nothing. A container at
−8 °C for three hours reads as zero excursion minutes on every dashboard until
it recovers — precisely when someone needs to see it. `level()` covers "how many
containers are in excursion right now", which is genuinely useful and not the
same number.

**Not a fix, a doc.** A "durations and time-in-state" recipe in the spec, because
two projects will each write this file slightly differently and both get the
live view slightly wrong.

### C09 · Health reports flush lag, not ingest lag

`src/dashboard/fleet.ts`

`house.health()` and `metrichouse inspect` report on writes MetricHouse
received. A fleet where 4,000 containers last reported 40 minutes ago is broken,
and every MetricHouse signal says healthy — the writes it did receive were
handled promptly.

Arguably correct scoping: MetricHouse cannot know what did not arrive. Recorded
because it is the health question this workload actually has, and the answer is
hand-written SQL in `queries.sql`.

### C08 · Live excursion view is process-local

`src/dashboard/fleet.ts`, `src/compliance/excursions.ts`

Downstream of C04. The in-progress map lives in one worker's memory, so the
number is wrong across N ingest workers. Would be solved by C04 having a live
representation, or by accepting `level()` as the answer to a different question.

---

## Missing configs

| # | Config | For |
|---|---|---|
| 1 | `house.backfill(metric, rows)` / `house.ingest(metric, rows)` | historical uploads, edge federation (C01, C03) |
| 2 | reserved `_ingested_at` | untrusted clocks, audit, ingest lag (C02) |
| 3 | `rollup: [{ after, to }]` consumed by DDL only | long regulated retention (C05) |
| 4 | `level({ totalTtl })`, `restoreTotals()` / `dumpTotals()` | long-lived and rebooting levels (C06, C07) |

## Missing stat types

None.

Coldchain needed temperature (gauge), duty cycle (float counter), door state
(level), reporting containers (distinct), excursion minutes (counter of
durations), and raw readings (event). Every one of those existed after the
Tollgate round. The one candidate — a `stopwatch()` for time-in-state — turned
out to be a counter plus `at:`, which is the chef rule holding under pressure.

---

## Which Tollgate fixes held up

The point of this project. Five of six survived a workload with nothing in
common with an API gateway.

| Fix | Verdict |
| --- | --- |
| #11 `complete` + `bucket_open` | **Held.** `fleet.ts` never mentions resolution and never sawtooths. The default being `true` is doing the work. |
| #12 `defineDefaults({ dims })` + `bind()` | **Held.** Tollgate's loudest ergonomic complaint is entirely gone — three constants, declared once, supplied once. |
| #13 `orderBy` / `groupBy` / `limit` | **Held.** 100,000 series, 20 rows over the wire. |
| #03 `level()` | **Held, with a cost.** Expressed door state across N workers with no `instanceId` dim and no local Map. The permanent `total` hash (C06) is the bill. |
| #07 `rowBatch` / `yieldBetweenBatches` | **Held, unexpectedly.** Added to stop a flush blocking a request loop; used here to size a flush to a satellite bandwidth budget. |
| #06 `at:` backdating | **Broke.** Correct for a 40-second stream, catastrophic for a six-day backlog. The rule needs a sibling, not a rewrite (C01). |
| #01 float counters | **Held.** `compressor_minutes` is a plain `Float64` with no unit in the name. |
| #04 `derive` | **Held, and then broke with C01.** Removes the fan-out problem completely on the live path; contributes nothing on the backfill path, so aggregates and events disagree for backfilled ranges. |
| #05 `metrichouse cost` | **Held, partially.** Correctly refused 1s resolution at 100k containers. Cannot suggest the real answer, which is rollup (C05). |
| `distinct()` | **Held.** Exactly the intended use: uniques not derivable from any counter, over an event stream too voluminous to keep. |

## Ranked: what to change next

1. **C01 + C03 together** — one entry point, `house.ingest()`. Fixes backfill,
   fixes edge federation, and makes MetricHouse tierable. Highest value of
   anything in either findings document.
2. **C02** — reserved `_ingested_at`. One column, and it is the difference
   between an auditable regulated dataset and a plausible one.
3. **C05** — `rollup` in the DDL generator. Not doing it means every long-
   retention user hand-writes a clause that silently corrupts data when wrong.
4. **C06** — `totalTtl` on levels. The one real cost of the `level()` addition.
5. **C04** — a recipe, not a feature.
