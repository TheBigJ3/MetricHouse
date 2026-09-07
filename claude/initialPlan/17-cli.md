# CLI

`metrichouse` is a small CLI that loads your schema file and answers the two
questions the library cannot answer at runtime: what a metric's declared
dimensions will actually cost in rows, and what is sitting in the buckets right
now. It also carries a one-shot flush, so a cron is the whole scheduling story.

> **Not built.** The CLI package was removed until the runtime exists — nothing
> here is buildable before `counter` and the memory driver are. The command set
> below is the design record. Its package name and the `defineConfig` specifier
> land with it.

It emits no SQL, generates no migrations, and never connects to your database.
Creating and evolving the tables your `write()` targets is entirely yours —
see [13-sink.md](13-sink.md).

## Main commands

**Setup**
- `metrichouse init` — scaffold `metrichouse.config.ts`, a schema file, and a house
- `metrichouse config` — print the resolved config and exit

**Cardinality**
- `metrichouse check` — exit non-zero if any metric's projected rows-per-flush exceeds its budget; for CI
- `metrichouse cost [--tenants N]` — the same projection, printed in full, with a cardinality estimate you supply per dim

**Operations**
- `metrichouse flush [--only] [--force]` — one flush, print the report, exit; the whole cron story if you want it
- `metrichouse inspect [metric] [--watch]` — live buckets in the terminal
- `metrichouse collect` — run the [collector](18-collector.md) in the foreground

## Config

```ts
// metrichouse.config.ts
import { defineConfig } from 'metrichouse/config'

export default defineConfig({
  schema: './metrics/schema.ts',
  house: './metrics/house.ts',
})
```

## In use

```console
$ npx metrichouse cost --tenants 500

  metric        dims                          series   res   flush  buckets      rows/flush
  ────────────────────────────────────────────────────────────────────────────────────────
  requests      tenant×model×endpoint×status  180,000    1s     30s       30      5,400,000  ⚠
  tokens        tenant×model×kind              24,000   10s      1m        6        144,000
  cost_usd      tenant×model×kind              24,000   60s      1m        1         24,000
  dog_poops     dogName×park×kind                 240    1s      5m      300         72,000
  ────────────────────────────────────────────────────────────────────────────────────────
  ⚠ requests exceeds 1,000,000 rows/flush
    coarsen resolution to 10s  → 540,000
    or shorten flush to 10s    → 1,800,000

  exit 1   (--warn-only to pass)
```

Series counts come from `--tenants`-style estimates you supply for open dims;
`oneOf` dims are counted exactly. It is an estimate, deliberately — the point
is to make the multiplication visible at declare time, not to be precise.

```console
$ npx metrichouse inspect dog_poops --watch

  dog_poops   resolution 1s   flush 5m   next in 3m41s
  ────────────────────────────────────────────────────
  dogName   park        kind     open   unflushed
  Willow    riverside   solid       2          41
  Willow    central     solid       0          12
  Rex       riverside   liquid      1           8
  ────────────────────────────────────────────────────
  3 series   287 buckets held   ~14 KB
```

```console
$ npx metrichouse flush --force
  dog_poops     300 buckets   812 rows   38ms
  walk_started    -           214 rows   22ms
  app_log         -          1893 rows   61ms
  ok  3/3
```
