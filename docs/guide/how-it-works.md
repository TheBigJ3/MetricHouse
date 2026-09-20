# How it works

This page follows one number from the moment your code records it to the moment
it lands in your database.

## The five stages

<figure class="mh-figure">
  <img src="/diagrams/pipeline.svg" alt="Your code, MetricHouse, a driver, your write function and your database in a row." />
  <figcaption>Green is code you wrote. Blue is MetricHouse.</figcaption>
</figure>

1. **Your code writes.** `counter.add()`, `gauge.set()`, `event.record()`,
   `log.info()` or `timer.end()`. These return straight away.
2. **MetricHouse works out where it belongs.** It applies defaults, checks the
   value against what you declared, works out the time window and builds the
   series key from your dimension values.
3. **The driver holds it.** Either in plain maps inside your process, or in
   Redis if several servers need to share one set of totals.
4. **A flush takes what is finished.** The data is set aside, turned into rows,
   and handed to your `write` function.
5. **Your function stores it.** If it succeeds the data is deleted. If it throws,
   the data goes back and comes again next time.

## Two storage styles

The six metric types split into two groups, and the difference explains most of
the behaviour you will meet.

<figure class="mh-figure">
  <img src="/diagrams/two-storage-models.svg" alt="Folded storage adds writes together into one number. Kept whole storage queues each record separately." />
  <figcaption>Counters, gauges, levels and timers fold. Events and logs stay whole.</figcaption>
</figure>

**Folded.** A counter, a gauge, a level and a timer combine writes into one
value per window. A thousand increments in one second become one row that says
`1000`. Memory use depends on how many different label combinations you have,
not on how much traffic you get.

**Kept whole.** An event and a log keep every record. Two identical events are
two rows, because the reason to use an event at all is the detail, and detail
does not survive being added together.

You can see which style a metric uses at runtime:

```ts
pageViews.storage   // 'bucketed'
signups.storage     // 'staged'
```

## Time windows

Every folded metric groups writes into fixed windows called buckets. A bucket is
`resolution` wide and lines up with the Unix epoch, not with when your process
started. That means two servers never disagree about where a minute begins, with
no coordination between them.

<figure class="mh-figure">
  <img src="/diagrams/buckets-and-flush.svg" alt="A row of one second buckets filling up, with a dashed box showing one flush taking three hundred of them at once." />
  <figcaption>Detail and shipping frequency are separate settings.</figcaption>
</figure>

A metric with `resolution: '1s'` and `flush: '5m'` keeps one second of detail and
ships 300 rows every five minutes. Shipping less often costs freshness. It never
costs detail.

There is a full explanation in [Buckets and time](/guide/buckets-and-time).

## Dimensions become rows

Dimensions are the labels you want to break a number down by. Every combination
of values you actually write becomes its own running total, and each one becomes
its own row.

<figure class="mh-figure">
  <img src="/diagrams/dimensions-to-series.svg" alt="Dimension declarations become series keys, and each series key becomes one row per bucket." />
  <figcaption>Three dimensions with a few values each produce a handful of rows per bucket.</figcaption>
</figure>

This is the setting that decides how much data you generate, so it is worth
understanding before you ship. [dims](/reference/dims) covers the declaration,
the argument at each call site and what cardinality costs.

## The flush handshake

A flush never deletes anything before your write succeeds.

<figure class="mh-figure">
  <img src="/diagrams/claim-ack-release.svg" alt="Data is claimed, handed to your write function, then either acknowledged and deleted or released back." />
  <figcaption>Claim, write, then either delete or put back.</figcaption>
</figure>

1. **Claim.** Everything eligible is moved out of the live set into a holding
   area. It is now invisible to live reads and to any other flush, so two servers
   can never ship the same window.
2. **Write.** Your function runs with the rows.
3. **Acknowledge or release.** If your function returns, the claimed data is
   deleted. If it throws, the data goes back exactly as it was, with the same row
   ids, and the next flush tries again with `attempt` increased by one.

The consequence is worth stating plainly. A failed write can produce the same
row twice. It cannot lose a row. See [Reliability](/guide/reliability) for what
that means for your table.

## Nothing runs on its own

`createHouse()` starts no timers and opens no connections. That is what makes it
safe to call at the top level of a module on a platform that reruns module code
on every cold start.

Something has to ask for a flush. There are three choices, and they are all
ordinary function calls:

```ts
house.start()              // one timer per metric, for a server that stays up
await house.flush()        // a cron job, a request handler, a worker loop
await pageViews.flush()    // just this one metric
```

<figure class="mh-figure">
  <img src="/diagrams/runtime-pumping.svg" alt="A long running server uses house.start and house.stop. A serverless platform uses a cron calling house.flush and awaits house.drain." />
  <figcaption>Two shapes, depending on whether your process stays alive.</figcaption>
</figure>

## What this means in practice

- Measuring something costs a validation pass and a map update. It is not a
  network call.
- Nothing you write is visible to your database until a flush runs.
- You can always read the current numbers without touching your database.
- If your database is down, writes keep being accepted and pile up in the
  driver. They ship when it recovers.
