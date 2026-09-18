# What MetricHouse is

MetricHouse is a TypeScript library for recording things that happen in your
application: how many requests arrived, how many users were online, which
events occurred, how long each operation took.

It does three jobs:

1. It accepts writes cheaply, so measuring something does not slow it down.
2. It groups those writes into time windows and keeps running totals.
3. It hands you finished rows on a schedule you choose.

It does not store the rows. It has no query language, no dashboard and no
database driver. You supply a function, MetricHouse calls it with an array of
plain objects, and what happens next is yours.

## The problem it solves

Imagine you want to know how many times each page on your site was viewed, per
minute, for the last year.

The obvious approach is to insert one database row per page view. That works
until traffic grows, and then you are inserting millions of rows to answer a
question about a few thousand numbers. Most databases will accept the writes and
then struggle to aggregate them.

The better approach is to count in memory and write one row per page per minute.
That is a small amount of code to write, and it is very easy to get wrong:

- Where exactly does a minute start and end?
- What happens to a write that arrives a few milliseconds after the minute ends?
- What happens if the database is down when you try to write?
- How do you avoid writing the same minute twice after a retry?
- How do two servers agree on the same minute?

MetricHouse is that small amount of code, written carefully, with those five
questions answered.

[Buckets and time](/guide/buckets-and-time) works through this trade in full:
what a summarised row looks like in your table, what it costs you, and how to
pick the settings that control it.

## The rule it follows

> Capture what a query cannot rebuild. Refuse everything else.

If information is lost forever unless you record it at the moment it happens,
MetricHouse takes responsibility for it. If you could work it out later from data
you already have, MetricHouse leaves it alone.

That single rule decides the whole shape of the library:

| Question | Answer | Why |
| --- | --- | --- |
| Is there a counter? | Yes | Increments you throw away are gone. Nothing can rebuild them. |
| Is there a histogram? | No | Percentiles are a `SELECT` over rows you already kept. |
| Does a gauge store an average? | No | It stores `sum` and `count`. Average is one division in SQL. |
| Is there a query engine? | No | Your database already has one. |
| Does it write SQL? | No | Your table is yours to design and migrate. |

The practical effect is that MetricHouse stays small and never gets in the way of
your database.

## What you are responsible for

<figure class="mh-figure">
  <img src="/diagrams/pipeline.svg" alt="A pipeline showing your code, MetricHouse, a driver, your write function and your database." />
  <figcaption>Green is yours. Blue is MetricHouse. The boundary is the write function.</figcaption>
</figure>

| MetricHouse handles | You handle |
| --- | --- |
| Deciding which time window a write belongs to | Creating the table |
| Adding up values safely when many writes arrive at once | Writing the insert |
| Holding data until you ask for it | Deciding how often to ask |
| Giving every row a stable id | Deciding whether your table treats that id as unique |
| Retrying rows whose write failed | Reporting or alerting on repeated failures |

## When to use something else

MetricHouse is a good fit when you already have somewhere to put the data, such
as ClickHouse, Postgres, BigQuery, S3 or a log pipeline, and you want clean rows
to put in it.

It is not a good fit if you want a finished monitoring product. If you want
dashboards, alert rules and a hosted backend without writing any storage code,
use a monitoring service or a Prometheus setup instead.

## Where to go next

- [Getting started](/guide/getting-started) builds a working counter in about
  twenty lines.
- [How it works](/guide/how-it-works) explains the pipeline in detail.
- [Metric types](/primitives/) compares the five things you can declare.
