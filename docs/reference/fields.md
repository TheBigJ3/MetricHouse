# fields

`fields` are the columns a record keeping metric writes for every record. An
[event](/primitives/event) and a [log](/primitives/log) declare them where a
folded metric declares [dims](/reference/dims).

```ts
import { event, int, json, oneOf, str } from 'metrichouse/core'

const checkoutAttempted = event('checkout_attempted', {
  fields: {
    userId: str(),
    plan: oneOf(['starter', 'pro', 'enterprise']),
    amountCents: int(),
    failureReason: str().optional(),
    processor: json<{ name: string; latencyMs: number }>().optional(),
  },
  flush: '30s',
  write,
})

checkoutAttempted.record({ userId: 'u_4821', plan: 'pro', amountCents: 4_999 })
```

## Where fields appear

| Metric type | Declares fields | The argument |
| --- | --- | --- |
| [`event`](/primitives/event) | required | [`record()`](/primitives/event#event-record), [`recordMany()`](/primitives/event#event-recordmany) |
| [`log`](/primitives/log) | optional | [the level methods](/primitives/log#log-level), [`at()`](/primitives/log#log-at), [`child()`](/primitives/log#log-child) |
| counter, gauge, level, timer | no | they declare [dims](/reference/dims) instead |

## fields against dims

Both are an object of [field types](/reference/field-types), and they are
checked the same way at every call site. What differs is what happens to the
value afterwards.

| | `dims` | `fields` |
| --- | --- | --- |
| On | counter, gauge, level, timer | event, log |
| Becomes | part of a series key | a column on one row |
| Merged with other writes | yes, folded into one number per window | no, every record is kept |
| High cardinality | expensive, one series per value | expected, this is what an event is for |
| `json()` | rejected | allowed |
| Cost of a new value | a new series, forever | nothing |

A `userId` field on an event is ordinary. A `userId` dim on a counter turns one
number into one number per person. When you need both the cheap number and the
detail, write both and let [`derive`](/primitives/event#derive) keep them in
step.

## Declaring fields

```ts
fields: {
  userId: str(),
  plan: oneOf(['starter', 'pro']),
  metadata: json<Record<string, unknown>>().optional(),
}
```

| Property | Value |
| --- | --- |
| Type | `Record<string, FieldType>` |
| Required | yes on `event`, no on `log` |
| Default | `{}` on a log, which then writes only the reserved columns |
| Checked | when the module is imported |

### Every type is allowed

All seven [field types](/reference/field-types) are legal, including `json()`.

```ts
fields: { payload: json<{ source: string; retries: number }>() }
```

A `json()` value reaches your sink as a string, ready for a text column or your
database's own JSON type. The TypeScript type stays the object you declared,
because `json<T>()` and `str()` cannot be told apart once inferred.

### Optional and default

The two modifiers behave exactly as they do on a dim, and they decide whether
the key may be left out at the call site.

```ts
fields: {
  route: str(),
  env: str().default('production'),
  errorMessage: str().optional(),
}

apiCall.record({ route: '/checkout' })
// env is 'production', errorMessage is absent
```

Prefer `.optional()` for an event field that genuinely does not apply to every
record, and give the column a nullable type in your table.

### Reserved column names

MetricHouse owns some column names on every record it writes, and a declared
field may not take one. The check runs at declaration.

```ts
import { RESERVED_EVENT_COLUMNS, RESERVED_LOG_COLUMNS } from 'metrichouse/core'

RESERVED_EVENT_COLUMNS   // ['id', 'ts', '_ingested_at', '_sample_rate']
RESERVED_LOG_COLUMNS     // ['id', 'ts', 'level', 'message', 'error_stack',
                         //  '_ingested_at', '_sample_rate']
```

| Column | On | What it holds |
| --- | --- | --- |
| `id` | event, log | A UUID version 7, minted at `record()` so it survives a retry |
| `ts` | event, log | When the record happened. See [timestamp](/primitives/event#timestamp) |
| `_ingested_at` | event, log | When `record()` ran, which is how a backfilled row is told from a live one |
| `_sample_rate` | event | The rate that applied, present only on a metric that samples |
| `level` | log | One of the declared levels |
| `message` | log | The line itself |
| `error_stack` | log | The stack, present only on a line written with an `Error` |

```ts
event('checkout', { fields: { ts: str() }, write })
// Error: checkout: field "ts" is a reserved column. MetricHouse writes
// [id, ts, _ingested_at, _sample_rate] on every row
```

A log reserves more names than an event because the three columns a log adds
are the whole reason it is a preset. `_sample_rate` is reserved on a log that
does not sample today, so that sampling can arrive later without renaming a
column somebody already queries.

## The fields argument

### On an event

`record()` always takes the object, even when every key is optional. The
argument is what makes a reader of the call site see what is being written.

```ts
checkoutAttempted.record({ userId: 'u_1', plan: 'pro', amountCents: 4_999 })

checkoutAttempted.record({ userId: 'u_1' })
//                        ^ Type error: property 'plan' is missing
```

`recordMany()` takes an array of the same object, staged in one round trip.

```ts
checkoutAttempted.recordMany([
  { userId: 'u_1', plan: 'pro', amountCents: 4_999 },
  { userId: 'u_2', plan: 'starter', amountCents: 900 },
])
```

### On a log

A log line takes its message first and its fields second, and the fields
argument may be left out once nothing in the shape is required.

```ts
const appLog = log('app_log', {
  fields: { service: str(), requestId: str().optional() },
  write,
})

appLog.info('server started', { service: 'checkout' })

const requestLog = appLog.child({ service: 'checkout' })
requestLog.info('order placed')            // service is already bound
```

[`child()`](/primitives/log#log-child) marks the keys it bound as omittable for
that logger, and a value given at a call site wins over the bound one.

### Order of evaluation

Every value is checked before anything is staged, so a rejected call writes
nothing and leaves nothing behind. The order for one `record()` is:

1. Defaults are filled in.
2. Unknown and ill typed fields throw at the caller.
3. `ts` is chosen. An explicit `at` wins, then a declared `ts()` field, then the
   house clock.
4. [`sample`](/primitives/event#sample) gives this record its rate, and throws
   for one outside `[0, 1]`.
5. The stored copy is made. A `json()` value becomes its JSON text here, and
   throws when JSON cannot hold it.
6. The rate decides whether this record is kept.
7. [`derive`](/primitives/event#derive) runs on the stored copy, for every
   record, kept or dropped.
8. The kept records are staged, with `id` and `_ingested_at` stamped.

Steps 1 to 6 change nothing, so a call that throws in any of them derives
nothing and stages nothing. Step 7 ignores the decision step 6 made, and that is
not configurable: counters derived from an event stay exact whatever fraction
of the event table you keep. A [durable](/primitives/event#durability) event
swaps the last two steps and derives only once the driver has answered that the
record is staged.

## Reading fields back

```ts
checkoutAttempted.fields          // the declared shape
Object.keys(checkoutAttempted.fields)
// ['userId', 'plan', 'amountCents', 'failureReason', 'processor']

checkoutAttempted.rowShape().columns.map((c) => c.name)
// ['id', 'ts', 'userId', 'plan', 'amountCents', 'failureReason', 'processor',
//  '_ingested_at', '_sample_rate']
```

`fields` holds what you declared. `rowShape()` adds the reserved columns and
puts them in the order your sink receives them, which is the order a
`CREATE TABLE` wants.

A log composes its reserved three into the shape before your fields, so its row
reads `id, ts, level, message, error_stack`, then your fields, then
`_ingested_at`.

## Errors

| Message | Cause |
| --- | --- |
| `field "ts" is a reserved column` | A declared field taking a name MetricHouse owns. At declaration |
| `a field cannot be named "__proto__"` | JavaScript treats that key as an object's prototype, so no row could carry it. At declaration |
| `a field cannot be named "7"` | A name that reads as a whole number, which JavaScript moves ahead of every other key, so the column order you declared would be lost. At declaration |
| `a field cannot be named "bucket_open"` | A name every snapshot row already uses, and the same for `bucket_elapsed_ms`. At declaration |
| `timestamp names "occurredAt", which is not a declared field` | `timestamp` pointing at nothing, or at a name such as `toString` that every object inherits. At declaration |
| `timestamp field "occurredAt" declares str(), and it must be ts()` | `timestamp` pointing at the wrong type. At declaration |
| `default for int(): expected a safe integer, got "five"` | `.default()` given a value its own type rejects. At declaration |
| `missing required field "plan"` | A declared field with no value and no default |
| `unknown field "pln". The declared fields are [userId, plan]` | A key that is not declared. On a log the list holds only your fields, never the columns the log writes |
| `app_log: "error_stack" is a column the log writes itself, so a line cannot pass it as a field` | A log line, or a child it came from, passing a reserved log column as a field |
| `amountCents: expected a safe integer, got 49.99` | A value of the wrong type |
| `at must be a Date or epoch milliseconds` | `record(fields, { at })` given something else |

## Related

- [Field types](/reference/field-types) for each builder and its modifiers
- [dims](/reference/dims) for the folded equivalent
- [event](/primitives/event) and [log](/primitives/log) for the metrics that take fields
- [Writing a sink](/guide/writing-a-sink) for what the finished row looks like
