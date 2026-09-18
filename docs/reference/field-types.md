# Field types

Dimensions and event fields are declared with type builders. They are ordinary
values, so TypeScript reads them directly and checks every call site with no code
generation step.

```ts
import { bool, float, int, json, oneOf, str, ts } from 'metrichouse/core'
```

## The builders

### str

```ts
str()
```

Accepts a `string`. The workhorse for names, identifiers and free text.

```ts
dims: { route: str() }
requests.add({ route: '/checkout' })
```

### int

```ts
int()
```

Accepts a whole `number` inside the safe integer range. A fraction is rejected.

```ts
fields: { amountCents: int() }
purchase.record({ amountCents: 4999 })
purchase.record({ amountCents: 49.99 })   // Error: expected a safe integer
```

Use whole units for money. A counter folds by adding, and repeated floating point
addition is exactly where money goes missing.

### float

```ts
float()
```

Accepts any finite `number`. Rejects `NaN` and `Infinity`.

```ts
fields: { durationMs: float() }
```

### bool

```ts
bool()
```

Accepts `true` or `false`. As a dimension it encodes as the strings `'true'` and
`'false'`.

```ts
dims: { cached: bool() }
requests.add({ cached: true })
```

### ts

```ts
ts()
```

Accepts a `Date`, and rejects an invalid one. Stored as epoch milliseconds and
handed back to your sink as a `Date`.

```ts
fields: { occurredAt: ts() }
reading.record({ occurredAt: new Date('2026-09-17T09:14:02Z') })
```

This is the only type an event's `timestamp` setting can name.

### oneOf

```ts
oneOf(['solid', 'liquid'])
```

A closed set of strings or numbers. The type narrows to a union at every call
site, so a typo is a compile error rather than a row nothing queries.

```ts
dims: { status: oneOf(['2xx', '3xx', '4xx', '5xx']) }

requests.add({ status: '2xx' })
requests.add({ status: '200' })
//                     ^^^^^ Type error
```

Writing `as const` is unnecessary but harmless. The set must have at least one
member.

```ts
// Declare once and reuse, so the values stay in step across metrics.
const STATUS = ['2xx', '3xx', '4xx', '5xx'] as const

dims: { status: oneOf(STATUS) }
```

### json

```ts
json<T>()
```

Accepts anything. Legal on event and log fields, **rejected as a dimension**,
because a payload cannot be turned into a label without either losing information
or creating a different label for every write.

```ts
fields: { metadata: json<{ source: string; retries: number }>() }

purchase.record({ metadata: { source: 'mobile', retries: 0 } })
```

The value arrives at your sink already turned into a string, so the column it
wants is text or your database's own JSON type.

```ts
dims: { metadata: json() }
// Error: dim "metadata" declares json(), which cannot be encoded into a series
// key. Put it on an event instead.
```

## Modifiers

Both return a fresh declaration rather than changing the original, so sharing one
across metrics is safe.

### optional

```ts
str().optional()
```

The caller may leave the key out, and the row does not carry it.

```ts
dims: { campaign: str().optional() }

signups.add({ plan: 'pro' })                        // no campaign column
signups.add({ plan: 'pro', campaign: 'launch' })
```

An absent optional dimension is distinct from an empty string. The two never
collide.

### default

```ts
str().default('unknown')
```

The caller may leave the key out, and this value is used.

```ts
dims: { referrer: str().default('direct') }

signups.add({ plan: 'pro' })                        // referrer is 'direct'
signups.add({ plan: 'pro', referrer: 'twitter' })
```

The default is checked against the type when you declare it, so a wrong one fails
at startup rather than at the first write.

```ts
int().default('five')
// Error: default for int(): expected a safe integer, got "five"
```

Only a genuinely absent key is filled in. A falsy value you passed on purpose,
such as `0` or `''`, survives.

### Which one to use

| | `.optional()` | `.default(v)` |
| --- | --- | --- |
| Caller may omit it | Yes | Yes |
| The row carries a value | No | Yes |
| Your column can be null | Yes | No |

Use `.default()` for a dimension, so every row has a value and grouping behaves
consistently. Use `.optional()` for an event field that genuinely does not apply
to every record.

## What each type produces

| Builder | TypeScript type | Column your sink receives |
| --- | --- | --- |
| `str()` | `string` | `string` |
| `int()` | `number` | `number` |
| `float()` | `number` | `number` |
| `bool()` | `boolean` | `boolean` |
| `ts()` | `Date` | `Date` |
| `oneOf([...])` | a union of the values | `string` or `number` |
| `json<T>()` | `T` | a JSON `string` |

## Reading a declaration back

```ts
const route = str().optional()

route.kind          // 'str'
route.isOptional    // true
route.hasDefault    // false
route.defaultValue  // undefined
route.dimLegal      // true, false only for json()

oneOf(['a', 'b']).values    // ['a', 'b'], in declaration order
```

And the column list a sink will receive:

```ts
requests.rowShape()
// {
//   columns: [
//     { name: 'id',        kind: 'str',   optional: false },
//     { name: 'bucket_ts', kind: 'ts',    optional: false },
//     { name: 'route',     kind: 'str',   optional: false },
//     { name: 'status',    kind: 'oneOf', optional: false },
//     { name: 'value',     kind: 'int',   optional: false },
//   ]
// }
```

## Error messages

Every failure names the offending key, so you do not have to guess.

```
route: expected a string, got 42
amountCents: expected a safe integer, got 49.99
status: "200" is not one of ["2xx", "3xx", "4xx", "5xx"]
missing required dim "status"
unknown dim "pakr" — declared dims are [route, status]
occurredAt: expected a valid Date, got "2026-09-17"
```

## Declaration order matters

The label key for a folded metric is built from your dimension values in
declaration order. Reordering dimensions is a breaking change: rows written before
the change will not match rows written after it.

Add new dimensions at the end, and treat a reorder like a schema migration.
