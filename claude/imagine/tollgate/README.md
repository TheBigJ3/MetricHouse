# Tollgate

A hypothetical LLM API gateway, written against MetricHouse **as designed in `initialPlan/`** and not yet implemented. It exists to break the design.

Tollgate proxies requests to model providers and needs to answer, for every tenant:

- how many requests, right now, per second — a live dashboard number
- how many input / output / cached tokens — the billing input
- how much that cost in USD — money, so exactness matters
- p50 / p95 / p99 latency and time-to-first-token — streaming responses
- how many requests are in flight — a concurrency number, not a rate
- which specific request caused a spike — drill-down from an aggregate
- whether a tenant is over their hourly quota — a rate limit read

That list was chosen because each item hits a different part of MetricHouse. Four of them do not work as designed.

## Layout

```
src/metrics/schema.ts     every metric declaration, with the workarounds visible
src/metrics/house.ts      wiring, ClickHouse sink, provenance dims
src/gateway/proxy.ts      the request path — where writes actually happen
src/gateway/billing.ts    usage rollup, the exactness argument
src/gateway/ratelimit.ts  the one that does not work
src/dashboard/live.ts     live-read endpoints
src/dashboard/queries.sql the plating — histograms MetricHouse refuses to build
```

## Reading it

Every place the design forced a workaround is marked inline:

```ts
// FLAW 01 — no float counter. Storing micro-dollars as Int64.
```

`FINDINGS.md` is the actual output of this exercise: 14 flaws, 9 missing configs, 4 missing stat types, ranked by whether they block Tollgate from shipping.

Nothing here runs. `metrichouse` does not exist yet.
