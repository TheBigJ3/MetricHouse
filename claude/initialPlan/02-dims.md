# Dimensions

Dimensions are the declared, per-call metadata a counter or gauge buckets by — `dogName`, `park` — and together they form the composite key of one series. Keys are the full cross-product of dim values, which is exactly what makes "Willow at riverside" answerable later and what makes cardinality multiply.

> **Risk, by design.** Dim keys are declared but values are open, and there is no cardinality guard. A `userId` in a dim will multiply your series count without limit. Put unbounded values on an [event](05-events.md) instead.

## Main functions

**Legal dim types** — must be losslessly encodable into a key
- `str()`, `int()`, `float()`, `bool()`, `oneOf([...])`
- `json()` is **rejected at declare time** — you cannot key on a payload

**Encoding**
- `encodeDimKey(metric, values): string` — validate, coerce, escape, join in declaration order
- `decodeDimKey(metric, key): Record<string, unknown>` — inverse, used when materializing rows
- `dimOrder(metric): string[]` — canonical declaration order; the key depends on it, so reordering dims is a schema change
- `escapeDimValue(v) / unescapeDimValue(v)` — `\` → `\\`, `|` → `\|`

**Validation**
- `validateDims(metric, values)` — missing required dim, unknown key, or bad `oneOf` member
- `applyDimDefaults(metric, values)` — fills `.default()` and `.optional()` slots

**Introspection**
- `seriesCount(metric)` — distinct keys currently live in the driver, for when you want to watch cardinality yourself

## In use

```ts
const dogPoops = counter('dog_poops', {
  dims: { dogName: str(), park: str() },
  resolution: '1s',
  flush: '5m',
})

dogPoops.add({ dogName: 'Willow', park: 'riverside' })
dogPoops.add({ dogName: 'Willow', park: 'riverside' })
dogPoops.add({ dogName: 'Willow', park: 'central'   })
dogPoops.add({ dogName: 'Rex',    park: 'riverside' })
```

One 1-second bucket in the driver — one hash, one field per combination:

```
mh:dog_poops:1757081527
  "Willow|riverside" -> 2
  "Willow|central"   -> 1
  "Rex|riverside"    -> 1
```

Materialized into rows at flush, dims as real columns:

```ts
[
  { id: 'a3f9…', bucket_ts: …:07Z, dogName: 'Willow', park: 'riverside', value: 2 },
  { id: '7c11…', bucket_ts: …:07Z, dogName: 'Willow', park: 'central',   value: 1 },
  { id: 'e08d…', bucket_ts: …:07Z, dogName: 'Rex',    park: 'riverside', value: 1 },
]
```

```sql
-- both questions survive, because the key was the cross-product
SELECT sum(value) FROM dog_poops WHERE dogName = 'Willow' AND park = 'riverside';
SELECT sum(value) FROM dog_poops WHERE dogName = 'Willow';
```
