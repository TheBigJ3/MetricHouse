---
layout: home

hero:
  name: MetricHouse
  text: Metrics you capture now, stored wherever you want
  tagline: A small TypeScript library that counts things, records events and times operations. It hands you finished rows and lets you decide where they go.
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

Some information is gone forever if you do not record it as it happens. How many
requests arrived in a given second. How many were errors. How long each one
took. You cannot go back and work those out later.

MetricHouse captures that information cheaply, groups it into time windows, and
hands you the finished rows. It does not query, chart or store anything itself.

If you want a full explanation of the idea before writing code, read
[What MetricHouse is](/guide/what-is-metrichouse). If you would rather see it
running, go to [Getting started](/guide/getting-started).

## Install

```bash
npm install metrichouse
```

Node 20 or newer. The `ioredis` package is optional and only needed if you use
the Redis driver.
