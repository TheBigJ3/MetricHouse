# docs/

The documentation site.

## Relationship to the design docs

[`initialPlan/`](../claude/initialPlan/) is the **specification** — 25 files written
before any code, one per system, arguing about trade-offs and recording
decisions. It is a design record and stays useful as one.

`docs/` is for **users**, who do not care why `avg` is not stored. Getting
started, the API reference, guides per deployment target, and recipes.

Some `initialPlan/` content graduates here as it stabilises —
[23-patterns.md](../claude/initialPlan/23-patterns.md) is already user-facing, and
[24-runtimes.md](../claude/initialPlan/24-runtimes.md) is most of a deployment guide.
The rest stays a design record.

## Planned structure

```
docs/
  getting-started/    install, first metric, first flush
  concepts/           buckets, dims, the chef rule, at-least-once
  primitives/         counter, gauge, level, distinct, event, log
  guides/             clickhouse, postgres, serverless, edge, testing, migrating
  reference/          generated API docs
  design/             the argued decisions, promoted from initialPlan/
```

## Note

Documentation is where this project's premise gets tested. The whole pitch is
"the existing options are too heavy or too rigid" — if the getting-started page
is longer than a page, the pitch is wrong.
