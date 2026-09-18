---
'metrichouse': minor
---

A metric's `write` function now receives typed rows.

`rows` used to be `Row[]`, so every dimension and field read as `unknown` inside
a sink. It now has the type `snapshot()` already gave you, worked out from the
dims or fields declared next to `write`:

```ts
counter('http_requests', {
  dims: { route: str(), status: oneOf(['2xx', '4xx', '5xx']) },
  resolution: '10s',
  flush: '1m',
  write: async (rows) => {
    rows[0].status // '2xx' | '4xx' | '5xx', where it used to be unknown
  },
})
```

Each kind names its row: `CounterRow<D>`, `GaugeRow<D>` for a gauge or a timer,
`EventRow<F>`, and the new `LogRow<F, L>`. `WriteFn` takes the row as an optional
type parameter. A sink typed with plain `Row[]` is still accepted by every
metric, so shared helpers need no change.
