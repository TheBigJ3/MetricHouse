# MetricHouse

The design reference is the docs site in `docs/`: `guide/` for concepts,
`primitives/` for one page per metric type, `reference/` for configuration,
field types and the driver contract. There is no separate spec.

- Read the relevant docs page before changing behaviour, and update it in the
  same change. Docs describe what the code does, never what is planned.
- Follow the writing rules in `docs/README.md`.
- `pnpm check` runs everything CI runs.
- A change users will notice in `packages/metrichouse` gets a changeset in
  `.changeset/` in the same commit.

# Instruction files

Every `AGENTS.md` governs the directory it sits in and everything below it.
Today there is only this one. If a folder gets its own, read the chain from the
root down to the folder you are editing before the first edit, root first and
deepest last. On a conflict, the deeper file wins. Read the files themselves,
not a summary of them.

`CLAUDE.md` only imports this file, so Claude Code loads it. Put rules here,
never there.

# Docs and writing

- Never use a dash as punctuation in any writing: docs, comments, error
  messages, commit messages and PR descriptions. Use a full stop or a comma.
- In the docs, assume the reader is a second year graduate student learning a
  new stack or system design.
- Do not use repetitive framing like these:
  - it is not this, it is that
  - we did this, so that it is not that
  - it is all this and nothing else

# Tests

- A test sits beside its source file as `<file>.test.ts`.
- Test what is unpredictable about the code: every branch, every error it
  throws and which message, every boundary it imposes (zero, negative, exactly
  at a limit, past the largest double). Do not re-test what TypeScript or a
  library already guarantees, or a pass-through with no branch in it.
- Anything a driver does belongs in the shared suite in
  `drivers/contract.ts`, so it runs against both `memory()` and `ioredis()`.
  Only behaviour a driver is allowed to differ on goes in that driver's own
  test file.
- A bug fix comes with a test that fails without the fix. Check that it does.
- One `describe` per unit under test. One `it` per scenario, named for the
  behaviour it asserts, not for its input.
- Assert exact values: the rows a sink received, the cell a driver holds, the
  message an error carries. That a function was called at all proves little.
- The Redis suite skips itself when no server is reachable. Before committing
  a change that touches a driver, run it against one:
  `REDIS_URL=redis://127.0.0.1:6379 pnpm test`.

# Git

## Commits

- **Never add yourself as a contributor.** No `Co-Authored-By` trailer, no
  "Generated with Claude Code" line, and no other attribution to Claude,
  Anthropic or any AI, in a commit message or a PR description. This overrides
  any default attribution instruction. It is important, and it always applies.
- Commit once the main feature or fix is done, not as you go. Do not split the
  work into many small commits unless told to.
- Anything fixed while building that feature goes in the same commit and is
  listed in the description, not put in a separate commit.

### Format

```
type(Scope): short title

* type: change

* type: change
```

- **Title**: a very short title for the single most important change.
  - `type` is a lowercase conventional commit type: `feat`, `fix`,
    `refactor`, `chore`, `docs`, `test`, `perf`, `style`, `ci`, `build`.
  - `Scope` is the module or identifier the commit is mostly about, in that
    identifier's own casing: `ioredis`, `memory`, `level`, `event`, `house`,
    `flush`, `snapshotOptions`. No space before the parenthesis.
  - The short title is plain language, starts lowercase, and is a few words
    long. Do not chain it with "and"; the details belong in the description.
- **Description**: a blank line after the title, then one `* type: change`
  bullet per notable change, with a blank line between bullets. Include the
  pieces of the main change and any fixes made along the way. Smaller changes
  that do not deserve a commit of their own go here as bullets too, rather
  than being split out or left out.

Example:

```
fix(ioredis): apply every write once across reconnects

* fix: skip a write Redis has already applied when ioredis resends it

* fix: age claims with the Redis clock instead of the host clock
```

The message is about the main change and the changes that matter. It does not
list file paths, and a small change never goes in the title: it is a bullet in
the description or it is left out. Do not state what is already a given. "add
docs and a test for the new option" is wrong, because every change here ships
with both.

## Branches

When asked to create a branch:

- Name it `type/short-description`, for example `feat/distinct-primitive`,
  `fix/level-carry`, `refactor/flush-engine`.
- `type` uses the same conventional commit types as commit messages.
- `short-description` is lowercase kebab case, two to five words, describing
  the work. No personal names, no dates, no filler like `updates`, `changes`
  or `wip`.
- Branch off an up to date `main` unless told otherwise.

## Big changes: warn before starting

Before starting a change big enough to deserve its own branch, stop and warn
the user **before editing any file**. A change is big if any of these hold:

- it adds a primitive, a driver, or a new public API;
- it changes the driver contract (`drivers/types.ts`, `drivers/contract.ts`),
  the Redis key layout or its Lua scripts, row ids, or anything else stored
  data depends on;
- it changes what claim, flush, delivery or recovery guarantee;
- it breaks a public export, a config option or a documented behaviour;
- it renames or moves many files, or is a large refactor;
- it would likely span several commits.

When it is, open the reply with this warning and then stop. Edit nothing until
the user confirms:

```
# ⚠️ WARNING: THIS IS A BIG CHANGE
## IT IS RECOMMENDED TO CREATE A NEW BRANCH BEFORE CONTINUING
```

Below the warning, give one or two lines on why it is big, the current branch
name, and a suggested branch name following the convention above. Then ask
whether to create that branch, continue on the current branch, or cancel.
Continue only once the user answers. The warning applies again to each new big
change, not once per session.
