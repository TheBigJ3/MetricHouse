# Breadcrumb

Product analytics for Next.js apps — funnels, sessions, A/B variants — deployed
on Vercel, with tracking in edge middleware and events arriving from browsers.

Written against MetricHouse after two rounds of revisions. Tollgate and
Coldchain both assumed a long-lived Node process. **Breadcrumb has no process.**

## Why this one

Everything the spec assumes about a runtime is false here:

| The spec assumes | Serverless reality |
| --- | --- |
| writes coalesce over an event-loop tick | the isolate freezes the moment the response returns |
| `close()` runs on `SIGTERM` | there is no `SIGTERM`; the isolate is discarded |
| `setInterval` drives the flush | timers do not survive a response |
| `createHouse` connects once at boot | boot happens on every cold start, thousands of times an hour |
| Redis is next to the app | the app is in 18 regions and Redis is in one |
| bundle size is irrelevant | edge middleware has a hard bundle limit |

It also covers two things neither previous project reached: how you **test** code
that emits metrics, and what happens when the data comes from a **browser** you
do not control.

## Layout

```
src/lib/analytics.ts             the wrapper every route uses — where drain lives
src/middleware.ts                edge runtime, the tightest constraint
src/metrics/house.ts             serverless wiring, cold starts, region
src/metrics/schema.ts            funnels, variants, sessions
src/app/api/track/route.ts       browser-origin events
src/app/api/cron/flush/route.ts  who calls flush(), and the 60-second ceiling
src/__tests__/funnel.test.ts     asserting a metric fired
src/dashboard/queries.sql        sessionization, funnels, variant lift
```

Marked `FLAW B01`…`B09` inline. `FINDINGS.md` closes with a scorecard for all
three projects.
