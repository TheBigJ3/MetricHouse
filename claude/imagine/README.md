# imagine/

Hypothetical projects written against MetricHouse **before it exists**.

## The method

Specifications look correct until something has to use them. So instead of
implementing MetricHouse and finding the gaps in production, each project here
is written as if the library already worked — real schema files, real call
sites, real queries — and every place the design forces a workaround is marked
inline:

```ts
// FLAW 01 — no float counter. Storing micro-dollars as Int64.
```

Each project's `FINDINGS.md` collects those marks into flaws, missing configs,
and missing stat types, ranked by whether they would block that project from
shipping. Accepted findings are folded back into `initialPlan/`, and the next
project is chosen to attack the fixes.

Nothing in here runs. `metrichouse` is not a package.

## Projects

### [`tollgate`](tollgate/) — LLM API gateway

Billing exactness, 180,000 series, streaming responses, live dashboards.
**14 flaws, 9 missing configs, 4 missing stat types.**

Headline finding: the open bucket is always an undercount and nothing marked it,
so every live chart sawtoothed. Also produced `level()`, `distinct()`, float
counters, and `derive`.

### [`coldchain`](coldchain/) — reefer monitoring

100,000 containers, six-day offline gaps, untrusted device clocks, a ship-side
gateway, seven-year regulated retention.
**9 flaws, 4 missing configs, 0 missing stat types.**

Headline finding: the `at:` backdating rule added for Tollgate collapsed a
six-day backlog into a single bucket. Produced `backfill()` / `ingest()` and,
with it, federation.

### [`breadcrumb`](breadcrumb/) — serverless product analytics

Next.js on Vercel, edge middleware, browser-origin events, no process at all.
**9 flaws, 5 missing configs, 0 missing stat types.**

Headline finding: `.add()` is fire-and-forget and a serverless isolate freezes
on response, so writes vanished with no error on the most common deployment
target for the exact use case that motivated the library.

## Reading order

`FINDINGS.md` first — the code exists to justify it. `breadcrumb/FINDINGS.md`
closes with a scorecard tracking every feature across all three projects.

## Picking the next one

A useful project maximises **new ground**, not new features. Each of the three
so far attacked a different axis: data model, time model, process model.
Candidates not yet covered: CI/build analytics (tiny cardinality, hour-long
durations, hierarchical spans), realtime multiplayer (sub-second, ephemeral
sessions), and a metrics product whose customers supply their own sink.
