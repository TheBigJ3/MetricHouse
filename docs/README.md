# docs/

The documentation site. Built with [VitePress](https://vitepress.dev).

## Running it

```bash
pnpm install
pnpm --filter @metrichouse/docs dev       # http://localhost:5173
pnpm --filter @metrichouse/docs build     # static output in .vitepress/dist
pnpm --filter @metrichouse/docs preview
```

## Structure

```
.vitepress/
  config.mts      nav, sidebar, search, theme options
  theme/
    custom.css    brand colours, .mh-figure, playground styles
    index.ts      registers the playground components globally
    components/   the interactive playgrounds
public/
  diagrams/       one SVG per figure, replaceable in place
guide/            concepts, from what it is to how to deploy it
primitives/       one page per metric type
examples/         complete small setups
reference/        API index, field types, configuration, driver contract
```

## Interactive playgrounds

Four Vue components let a reader drag the settings and watch the consequence.
They are registered globally, so a page drops one in with a single tag.

| Component | Controls | Used on |
| --- | --- | --- |
| `MhBucketExplorer` | resolution, flush, grace, label combinations | counter, gauge, timer, Buckets and time |
| `MhFoldExplorer` | the observations in one bucket, and which aggregates are stored | gauge, timer |
| `MhEventFlow` | stage, rate, sample, flush, batch size and age | event, log |
| `MhLogFilter` | minLevel, bytes per line, volume at each level | log |

```md
<MhBucketExplorer metric="http_requests" kind="counter" resolution="10s" flush="1m" :series="12" />
<MhFoldExplorer metric="http_latency" kind="timer" unit="ms" :start="[34, 12, 128, 3400]" :max="4000" />
<MhEventFlow metric="checkout_attempted" kind="event" />
<MhLogFilter />
```

Three rules keep them working:

- **They are rendered on the server first.** Nothing may read `window` during
  setup, and nothing may be random. `noise()` in `components/duration.ts` is a
  seeded stand in, so the server and the browser draw the same bars.
- **Their arithmetic has to match the library.** The resolution and flush
  sliders reject exactly the pairs `assertResolution` rejects, and show the same
  error text. There is a check for this in the verification script.
- **Biome cannot see a Vue template**, so `noUnusedVariables` and
  `noUnusedImports` are turned off for `.vue` in `biome.json`. Every other rule
  still applies.

## Writing rules

These are house style for this site, and worth keeping.

- **Plain language.** A second year undergraduate should follow every page
  without a glossary. If a sentence needs a term of art, define it in the same
  sentence.
- **No dashes as punctuation.** Use a full stop or a comma. This applies to
  hyphenated compounds in prose too, wherever a rewrite avoids one.
- **Every feature gets two snippets.** One minimal, showing the shape. One
  production shaped, showing what you would really ship, with the reasoning in
  comments.
- **Every claim comes from the source.** If the code does not do it, the docs do
  not say it. Check `packages/metrichouse/src/`.
- **Say what is missing.** A feature that does not exist yet is named as not
  existing, not left for someone to discover.

## Diagrams

Every figure is a plain SVG in `public/diagrams/`, generated as a placeholder so
nothing is broken while the real artwork is made.

[DIAGRAMS.md](./DIAGRAMS.md) is the brief for a designer: one section per image,
with the size, the palette, the exact labels and the point the image has to make.

To replace one, save the finished file over the placeholder keeping the same
filename. Nothing else changes.

Figures are written as raw HTML so they can carry a caption:

```html
<figure class="mh-figure">
  <img src="/diagrams/pipeline.svg" alt="..." />
  <figcaption>...</figcaption>
</figure>
```

## Deploying

The site is static. `pnpm --filter @metrichouse/docs build` writes
`docs/.vitepress/dist`, which any static host will serve.

**GitHub Pages** is wired up in `.github/workflows/docs.yml`. It builds on every
push to `main` that touches `docs/`, and sets `DOCS_BASE=/MetricHouse/` so asset
paths resolve under the repository sub path. Enable it once under Settings,
Pages, Source, GitHub Actions.

**Netlify, Vercel or Cloudflare Pages** serve from the root, so leave `DOCS_BASE`
unset.

| Setting | Value |
| --- | --- |
| Build command | `pnpm install && pnpm --filter @metrichouse/docs build` |
| Output directory | `docs/.vitepress/dist` |
| Node version | 20 or newer |
