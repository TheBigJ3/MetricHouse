---
layout: home

hero:
  text: Analytics that fit the stack you already have
  tagline: A small TypeScript library that counts things, records events and times operations. You can read the numbers live, and it hands you finished rows to store however you like.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What it is
      link: /guide/what-is-metrichouse
    - theme: alt
      text: Examples
      link: /examples/

features:
  - icon: 🧮
    title: Five kinds of metric
    details: Counters for things you tally, gauges for values you sample, events and logs for records you keep whole, timers for how long work takes.
    link: /primitives/
    linkText: Compare them
  - icon: 🔌
    title: No database built in
    details: MetricHouse writes no SQL and opens no connections. You supply one function that takes rows, and it can put them anywhere.
    link: /guide/writing-a-sink
    linkText: Write a sink
  - icon: 📈
    title: Read the numbers before they ship
    details: Ask a metric what it holds right now, without waiting for a flush and without querying your database.
    link: /guide/reading-live-data
    linkText: Live reads
  - icon: 🛡️
    title: A failed write loses nothing
    details: Data is only deleted after your function succeeds. If it throws, the same rows come back on the next attempt with the same row ids.
    link: /guide/reliability
    linkText: How it recovers
---

## In one file

```ts
import { counter, createHouse, str } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'

// 1. Say what you want to measure.
const pageViews = counter('page_views', {
  dims: { path: str() },
  resolution: '1m',                       // keep one row per minute
  flush: '5m',                            // ship no more than once every 5 minutes
  write: async (rows) => {
    await db.insertInto('page_views').values(rows).execute()
  },
})

// 2. Connect it to somewhere that holds the running totals.
const house = createHouse({ driver: memory(), schema: { pageViews } })
house.start()

// 3. Count.
pageViews.add({ path: '/pricing' })

// 4. Read it back straight away, before anything reaches the database.
await pageViews.current({ path: '/pricing' })   // 1
```

<figure class="mh-figure">
  <img src="/diagrams/pipeline.svg" alt="Your code calls add, MetricHouse counts it, a driver holds it, then your write function puts it in your database." />
  <figcaption>Your code adds to a metric. MetricHouse keeps the running totals and hands them to the function you wrote.</figcaption>
</figure>

## What it is for

Adding analytics to a project usually means adopting someone else's stack: a
hosted service that keeps your data, a cluster you run yourself, or a collector
service to feed. Those tools expect to be chosen early, and fitting one into an
application that already exists is hard.

MetricHouse is a TypeScript library that runs inside your own code. You call
`add()` wherever something happens. It groups those calls into time windows and
keeps a running total for each one, which your code can read at any moment.
When it is time to write, it hands your function finished rows to store however
your storage needs. Querying, charting and long term storage stay with the tools
you already use.

If you want a full explanation of the idea before writing code, read
[What MetricHouse is](/guide/what-is-metrichouse). If you would rather see it
running, go to [Getting started](/guide/getting-started).

## Install

```bash
npm install metrichouse
```

Node 20 or newer. The `ioredis` package is optional and only needed if you use
the Redis driver.
