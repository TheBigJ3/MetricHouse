# Identity

Every row carries a stable `id` so an at-least-once resend is harmless — aggregate rows hash their natural key, events carry an id minted at `record()` time. A retried flush hands your `write()` the identical id, so the resend is recognisable as one.

> **Where the guarantee stops.** MetricHouse guarantees it produces the *same
> row with the same id* on a retry. It does not guarantee your store collapses
> the two — that is your `write()` and your table, and MetricHouse neither
> creates nor inspects either. At-least-once means a duplicate is possible and
> a loss is not; turning that duplicate into one row is the sink's job. Build
> the destination to upsert on `id`, or accept duplicates and fold them at read
> time.

## Main functions

**Aggregates** — deterministic, content-derived
- `rowId(metricName, bucketTs, dimKey): string` — hash of the metric name, the bucket, and the encoded series key (dim values already in declaration order)
- `naturalKey(metric): string[]` — `['bucket_ts', ...dimOrder(metric)]`, the tuple that defines a row's identity and the one your sink should key on

**Events and logs** — deterministic by assignment
- `eventId(): string` — uuidv7, minted at `record()` and stored with the staged event, so a retried flush carries the identical id

**Hashing**
- `hash(parts: string[]): string` — **128 bits, 32 lowercase hex characters.** Four 32-bit lanes advanced in one pass, each finalized with Murmur3's `fmix32`. Non-cryptographic and fast; ids are for dedupe, not secrecy. Parts are length-prefixed, so `['a','bc']` and `['ab','c']` differ and a metric name cannot impersonate a dim value.

  > **Why 128 and not 64.** This originally specified xxhash64 → 16 hex. But
  > [`metrichouse cost`](17-cli.md) projects 5.4M rows per 30-second flush for
  > a high-cardinality metric — ~15B rows/day — and at 64 bits the birthday
  > bound makes collisions a daily event. A collision here silently merges two
  > unrelated series into one row, which is data loss, not drift. 16 extra
  > bytes per row removes the failure mode. Measured on the implementation:
  > avalanche mean 64.0/128, zero collisions over 1M realistic keys.
- `setHasher(fn)` — swap it, returning the previous hasher. Changing this changes every id the process produces; ids already in your database were written by the old one and will not converge with new ones, so it is a migration, not a setting.

## Why two strategies

| | aggregate rows | events / logs |
| --- | --- | --- |
| Identity is | derived from content | assigned at write time |
| Two rows with same id are | the same bucket, re-sent | the same event, re-sent |
| Two identical payloads are | one row (correct — they merged in the bucket) | two rows with different ids (correct — they are two events) |

Hashing an event payload would be wrong: two genuinely distinct signups with identical fields must stay two rows.

## In use

```ts
// same bucket, shipped twice — flush crashed after write, before ack
{ id: '206c40af840dbc248064ccd53df13b9d', bucket_ts: '14:03:07', dogName: 'Willow', park: 'riverside', value: 2 }
{ id: '206c40af840dbc248064ccd53df13b9d', bucket_ts: '14:03:07', dogName: 'Willow', park: 'riverside', value: 2 }
```

Identical id, identical content. Your `write()` receives both and decides what
that means — upsert, ignore-on-conflict, or insert twice and deduplicate when
you read. MetricHouse has no opinion and no visibility past the function call.


Events, retried — the id came from `record()`, not from the flush:

```ts
{ id: '018f7c2a91b7…', ts: '14:03:07.482Z', dogName: 'Willow', walkerId: 'u_42' }
{ id: '018f7c2a91b7…', ts: '14:03:07.482Z', dogName: 'Willow', walkerId: 'u_42' }
// same id → one row after dedupe
```
