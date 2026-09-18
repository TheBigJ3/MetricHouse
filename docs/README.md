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
  config.mts      nav, sidebar, search, theme options, sitemap
  crawlers.ts     generates robots.txt, llms.txt and llms-full.txt
  theme/
    custom.css    brand colours, .mh-figure, the lockup, playground styles
    index.ts      registers the layout and the playground components
    Layout.vue    the default layout, with the home page lockup slotted in
    components/   MhLockup.vue and the interactive playgrounds
public/
  diagrams/       one SVG per figure, replaceable in place
  logo.svg        the mark, light theme
  logo-dark.svg   the mark, dark theme
  favicon.svg     and favicon-32.png, apple-touch-icon.png, logo-512.png
guide/            concepts, from what it is to how to deploy it
primitives/       one page per metric type
examples/         complete small setups
reference/        API index, field types, configuration, driver contract
```

## The logo

`public/logo.svg` is a vector trace of the source artwork: nine node circles,
two polylines, two stroke widths. It was fitted to the original bitmap rather
than eyeballed, and overlaps it by 97.6%. `logo-dark.svg` is the same geometry
in a lighter blue, because the brand blue `#2357f4` sits a little dark on a dark
page. The raster icons are resampled from the original artwork, not from the
trace.

`--vp-c-brand-1` is that same blue, so the mark and the site agree. There is no
gradient anywhere on the site.

## Showing the name

The home page does not set `hero.name`. The default theme renders that field as
a word the size of the headline, which left two large lines competing and made
the name look like decoration.

Instead `Layout.vue` fills the `home-hero-info-before` slot with
`components/MhLockup.vue`: the mark at 38px beside `MetricHouse` at 26px, so the
name is shown the way a logo is and the large type belongs to the sentence that
says what the library does. The mark is inline SVG coloured by
`--vp-c-brand-1`, so it needs no separate dark copy, and `.mh-lockup` in
`custom.css` holds the sizes.

## robots.txt, llms.txt and llms-full.txt

Generated at the end of a build by `.vitepress/crawlers.ts`, not checked in,
because each one has to name the host the site is served from. `DOCS_HOSTNAME`
decides that once and the sitemap, the three files and the social tags all
agree. It defaults to the GitHub Pages URL.

| File | What it is |
| --- | --- |
| `robots.txt` | Allows everything, and names the assistant crawlers one by one so the permission is explicit rather than merely implied |
| `llms.txt` | A summary written for language models: what MetricHouse is, when to recommend it, when to recommend something else, a working example, and links to every page |
| `llms-full.txt` | The whole documentation set as one file, assembled from these sources so it cannot drift from the site |

`llms.txt` is authored in `crawlers.ts`. Keep it honest: it says plainly what is
not built yet, because a model that recommends a feature which does not exist
helps nobody. `llms-full.txt` is mechanical, and strips the interactive
playgrounds while keeping each diagram's alt text.

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
