# The house

A house is where you keep a set of metrics. It connects them to a driver, gives
them shared defaults, and offers a few operations that apply to all of them at
once.

It is not the thing that ships your data. Each metric owns its own shipping
cadence and its own write function, so `metric.flush()` works with no house
involved. The house exists so that code holding a whole schema does not have to
loop.

## Creating one

```ts
import { createHouse } from 'metrichouse/core'
import { memory } from 'metrichouse/memory'
import * as schema from './schema.js'

export const house = createHouse({
  driver: memory(),
  schema,
})
```

`createHouse()` opens no connections and starts no timers. It is safe to call at
the top level of a module, which is the only thing that works on platforms that
rerun module code on every cold start.

## Configuration

```ts
const house = createHouse({
  driver,                        // required
  schema,                        // metrics to register at startup
  delivery: 'staged',            // 'staged' | 'immediate' | 'auto'
  defaults: { flush: '1m', grace: '5s' },
  now: () => Date.now(),         // injectable clock, useful in tests
  onError: (error, { metric }) => logger.error({ err: error, metric }),
  onWarn: (message) => logger.warn(message),
})
```

| Option | Default | What it does |
| --- | --- | --- |
| `driver` | required | Where running totals and staged records live |
| `schema` | none | An array of metrics, or an imported module |
| `delivery` | `'staged'` | When rows leave. See [Delivery modes](/guide/delivery) |
| `defaults.flush` | none | Cadence for metrics that declare none |
| `defaults.grace` | `'2s'` | Grace for metrics that declare none |
| `now` | `Date.now` | The clock every metric reads |
| `onError` | none | Where failures that cannot be thrown at a caller go |
| `onWarn` | none | Startup warnings about the setup |

Defaults are filled in, never overridden. A metric that declares `flush: '5m'`
because it carries payment data keeps it whatever the house says.

## Registering metrics

You can pass an imported module, and the house picks out the metrics.

```ts
import * as schema from './schema.js'

const house = createHouse({ driver: memory(), schema })
// exports that are not metrics are ignored, and a metric exported under
// two names is registered once
```

An array works too, and so does registering later.

```ts
const house = createHouse({ driver: memory(), schema: [httpRequests, appLog] })

house.register(newMetric)     // bound immediately, and scheduled if start() has run
```

A metric belongs to exactly one house. Registering the same metric with a second
house throws, rather than quietly redirecting its writes. Registering it again
with the house that already holds it does nothing.

Registration is all or nothing. If one metric in a schema cannot be registered,
for example because it has no flush cadence and the house gives none either,
`createHouse` throws and none of the metrics in that call stay bound. Fix the
mistake and call `createHouse` again with the same metrics.

## Looking at what is registered

```ts
house.metrics()               // every registered metric
house.get('http_requests')    // one by name, or undefined
house.delivery                // the resolved delivery mode
house.running                 // is the scheduler ticking
```

This is how you generate table definitions or check a deployment:

```ts
for (const metric of house.metrics()) {
  console.log(metric.name, metric.kind, metric.rowShape().columns.map((c) => c.name))
}
```

## Operations across every metric

### flush

Ships every registered metric to its own write function, one after another, in
registration order.

```ts
const report = await house.flush()

report.ok                     // false if any metric's write threw
report.durationMs
report.metrics.http_requests  // { buckets, rows, skipped, reason?, error? }
report.throwIfFailed()        // throw instead of inspecting, if you prefer
```

Each metric still honours its own cadence, so calling this every 10 seconds ships
a five minute metric every five minutes.

Restrict it to a few metrics with `only`, and ignore cadence with `force`:

```ts
await house.flush({ only: ['http_requests', 'app_log'] })
await house.flush({ force: true })
```

Metrics are flushed one after another on purpose. They are independent writes,
but they are still writes, and firing forty inserts at one database at the same
moment is a burst nobody asked for. If you want that concurrency, call
`metric.flush()` yourself inside `Promise.all`.

### drain

Resolves once every write you have issued has reached the driver.

```ts
await house.drain()
```

`add()`, `set()`, `record()` and the rest return before storage has confirmed
anything. On a platform that freezes your process the moment a response is
returned, this is the only guarantee that a write actually landed.

### snapshot

Every metric's unshipped data, keyed by metric name, read in parallel.

```ts
const snap = await house.snapshot()
snap.http_requests    // LiveRow[]
snap.app_log          // LiveRow[]

await house.snapshot({ only: ['http_requests'], rollup: 'sum' })
```

### current

Just the window that is still filling, for metrics that fold. This is the cheap
call for a live dashboard.

```ts
const now = await house.current()
now.online_users     // rows from the open bucket
```

Events and logs are absent from this result rather than present and empty,
because they have no open window. Use `event.pending()` to count an unshipped
backlog.

## Starting and stopping

On a server that stays running, `start()` gives each metric its own timer at its
own cadence.

```ts
house.start()
```

It is safe to call twice, and a metric registered afterwards gets its timer
straight away. Timers are unreferenced, so a pending flush never keeps your
process alive after your HTTP server has closed.

If a write is slower than the cadence, the next tick is skipped rather than
stacked on top of the one still running.

```ts
process.on('SIGTERM', async () => {
  const report = await house.stop()
  if (!report.ok) logger.error('final flush failed')
  process.exit(0)
})
```

`stop()` does four things in order: clears the timers, waits for any flush a
timer already started, drains writes still on their way to the driver, then
makes a [final flush](/reference/flush-options#final) past every cadence and
every grace period.

What it cannot ship is the window that is still open. It has not finished, and
sending a partial value under the same row id is the exact problem that
[immediate delivery](/guide/delivery) exists to handle. In practice that is at
most one `resolution` of data.

`stop()` does not close the driver's connection, because the final flush needs
it. With `ioredis()` built from a factory, call `driver.close()` after `stop()`
returns so the process can exit. See [Drivers](/guide/drivers).

## In production

A typical Express or Fastify service:

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import Redis from 'ioredis'
import * as schema from './schema.js'
import { logger } from '../logger.js'

export const house = createHouse({
  driver: ioredis(() => new Redis(process.env.REDIS_URL!)),
  schema,
  defaults: { flush: '1m', grace: '5s' },
  onError: (error, { metric }) => {
    logger.error({ err: error, metric }, 'metric write failed')
  },
  onWarn: (message) => logger.warn({ message }, 'metrichouse'),
})
```

```ts
// server.ts
import { house } from './metrics/house.js'

const server = app.listen(3000)
house.start()

async function shutdown() {
  server.close()
  await house.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

Add a health endpoint that exposes the live numbers, which is useful long before
your dashboards exist:

```ts
app.get('/internal/metrics', async (_req, res) => {
  res.json(await house.current())
})
```
