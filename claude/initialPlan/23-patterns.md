# Patterns

Things people will build on top of MetricHouse that are **not** primitives, with the sharp edge named in each. Each one exists here because two projects would otherwise write it slightly differently and both get the same part wrong.

> Added after [Coldchain](../imagine/coldchain/FINDINGS.md) — flaw C04. Time-in-state turned out to be a counter plus `at:`, which is the chef rule holding. It still deserves a recipe.

## Time in state

**The question:** "how many minutes was this container above −15 °C?"

**The shape:** accumulate elapsed milliseconds into a counter when the state
*exits*, attributed with `at:` to when it *entered*.

```ts
export const excursionMs = counter('excursion_ms', {
  dims: { containerId: str(), threshold: oneOf(['above_max','below_min'] as const) },
  resolution: '60s',
  flush: '5m',
})

function onExit(e: Excursion, now: number) {
  excursionMs.add(now - e.startedAt, {
    containerId: e.containerId,
    threshold: e.threshold,
  }, { at: e.startedAt })   // attributed to when it began, not when it ended
}
```

**The sharp edge, and it is unavoidable:** a state still in progress has
contributed nothing. A container that has been in excursion for three hours
reads as zero on every dashboard until it recovers — exactly when someone needs
to see it.

**The complement:** pair it with a [`level()`](20-level.md) that goes up on
entry and down on exit. That answers "how many are in this state right now",
which is a different and equally useful number, and it is correct across every
instance with no local bookkeeping.

```ts
export const inExcursion = level('in_excursion', {
  dims: { threshold: oneOf(['above_max','below_min'] as const) },
  resolution: '60s',
})

onEnter: inExcursion.inc({ threshold })
onExit:  inExcursion.dec({ threshold })
```

Ship both. Neither replaces the other, and the elapsed-time answer is the one
regulators ask for.

## Rates and ratios

**The question:** "what is the error rate?"

**Do not** declare a `rate` metric. Declare the numerator and denominator as
dims on one counter and divide at query time — a ratio is not mergeable, so
storing it destroys every window except the one you stored.

```ts
requests.add({ status })    // 'ok' | 'error'
```

```sql
SELECT sumIf(value, status != 'ok') / sum(value) AS error_rate
FROM requests FINAL GROUP BY toStartOfMinute(bucket_ts);
```

## Funnels

**The question:** "how many users reached step 3?"

Stages are dim values on one counter, not separate metrics. One declaration,
one table, and the ordering lives in the query where it can change without a
migration.

```ts
export const funnel = counter('funnel', {
  dims: { flow: str(), step: str(), variant: str() },
  resolution: '60s',
  flush: '5m',
})
```

Per-user funnel *sequences* are not this — that is sessionization, it needs raw
events, and it is plating.

## Durations that are not states

**The question:** "how long did that job take?"

A completed duration is one observation: put it on a [gauge](04-gauge.md) for
min/max/mean, and on an [event](05-events.md) if you want percentiles. Do not
reach for time-in-state; there is no state to be in.

## What not to build on MetricHouse

- **Rate limits and quotas.** Needs a sliding window MetricHouse deliberately
  does not keep. Use `retention` if the window is short, a dedicated counter if
  it is not. Coldchain's sibling project shipped a second Redis counter for
  exactly this and it was the right call.
- **Alerting thresholds.** Reading a value and comparing it is not collection.
- **Sessionization, retention curves, cohorts.** All derivable from an event
  table, all plating.
