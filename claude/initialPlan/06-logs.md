# Logs

A log is an [event](05-events.md) preset with three reserved fields — `ts`, `level`, `message` — plus whatever else you declare. It exists so structured logs travel the same staging, flush, dedupe, and table story as everything else, rather than becoming a second pipeline nobody maintains.

## Main functions

**Declaration**
- `log(name, config)`

Config fields:
- `fields` — extra declared fields alongside the reserved three
- `levels` — default `['debug','info','warn','error']`; the type narrows to whatever you list
- `minLevel` — drop anything below this before it reaches the driver
- `stage`, `batch`, `flush`, `write` — same semantics as events

**Write**
- `.debug(message, fields?)`
- `.info(message, fields?)`
- `.warn(message, fields?)`
- `.error(message, fields?)` — accepts an `Error`; stack lands in a reserved `error_stack` field
- `.at(level, message, fields?)` — for a dynamic level

**Context**
- `.child(fields)` — a bound logger that merges those fields into every call

**Read / introspection**
- `.pending()` / `.peek(n?)`
- `.rowShape()` — the typed row your `write()` will receive

## In use

```ts
// metrics/schema.ts
import { log, str } from 'metrichouse'
import { ch } from '../lib/clickhouse'

export const appLog = log('app_log', {
  fields: {
    requestId: str().optional(),
    userId: str().optional(),
    service: str(),
  },
  levels: ['debug', 'info', 'warn', 'error'],
  minLevel: 'info',
  stage: 'memory',
  batch: { maxSize: 500, maxAge: '5s' },
  write: async (rows) => ch.insert('app_log', rows),
})
```

```ts
import { appLog } from './metrics/schema'

const reqLog = appLog.child({ requestId: req.id, service: 'api' })

reqLog.info('walk booked', { userId: 'u_42' })
reqLog.error(new Error('payment declined'), { userId: 'u_42' })

appLog.debug('never shipped')   // below minLevel, dropped before the driver
```

Row handed to `write()`:

```ts
{
  id: '018f7c2b…',
  ts: 2026-09-05T14:03:07.601Z,
  level: 'error',
  message: 'payment declined',
  error_stack: 'Error: payment declined\n    at …',
  requestId: 'req_9f21',
  userId: 'u_42',
  service: 'api',
}
```
