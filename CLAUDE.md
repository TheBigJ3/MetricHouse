# MetricHouse

The design reference is the docs site in `docs/`: `guide/` for concepts,
`primitives/` for one page per metric type, `reference/` for configuration,
field types and the driver contract. There is no separate spec.

- Read the relevant docs page before changing behaviour, and update it in the
  same change. Docs describe what the code does, never what is planned.
- Follow the writing rules in `docs/README.md`.
- `pnpm check` runs everything CI runs.


# Commits

When working on a feature commit as you go (unless instructed not to) 
Never add yourself as a contributor

# Docs and Writings

Never use - in any form of writing, if you're writing in docs assume your reader is a 2nd graduate student trying to learn a new stack or system design.
Do not use repetive language like 
  - Its not this, its that
  - We did this, so that its not that
  - Its all this and nothing else