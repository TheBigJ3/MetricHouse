---
'metrichouse': minor
---

Add the `log` primitive — an event preset with three reserved fields.

`log(name, config)` declares a structured log with `ts`, `level` and `message`
reserved, plus whatever fields you declare. It writes through the same
staging, batching, claim/ack and flush path as `event`, so logs are not a
second pipeline with its own crash semantics — they are events with a level in
front of them.

- **One method per declared level.** `levels` defaults to
  `['debug', 'info', 'warn', 'error']` and the type narrows to exactly what you
  list: `levels: ['low', 'high']` gives `.low()` and `.high()`, and `.info()`
  stops existing. `.at(level, …)` covers a level chosen at runtime.
- **`minLevel`** drops anything below it before the fields are validated or
  anything is staged, so a filtered `debug` call costs one array index.
  Severity is declaration order, which is the only ordering that works for a
  custom level set.
- **Errors are a first-class message.** Any level accepts an `Error`; its
  `message` becomes the message column and its stack lands in a reserved
  `error_stack`.
- **`.child(fields)`** returns a bound logger that merges those fields into
  every call. The bound fields become *optional* rather than absent in the
  child's type, so `child({ service })` satisfies a required field without
  making an override at one call site a type error. Children nest, and stage
  into the log that made them.

`MetricKind` gains `'log'`, so a sink can route on `context.kind` — and
`METRIC_KINDS` is now the single list `isMetric` checks against.

**`stagedMetric()`** is factored out of `event()` as the staged counterpart to
`bucketedLifecycle()`, and is what `log` is built on. `Event<F>` becomes
`Event<F, K = 'event'>` so the same lifecycle can report a different kind; the
default keeps every existing usage unchanged.
