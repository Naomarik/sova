# Sova landing page

A static [Astro](https://astro.build) site for Sova, styled with the app's own design system:
`src/styles/tokens.css` is a copy of `src/design/tokens.css`, and `src/styles/components.css` is a
subset of `.claude/skills/fold-ai-dev-design/fold-ai-dev.css`. The home page's product screens
and its session video are real Sova, captured on demo data (see Screens and video below); the
Mesh and Organizations pages, and the phone lock screen beside the Overseer, are CSS
illustrations built from those classes.

It ships static HTML and one stylesheet. The only JavaScript is two small inline scripts in
`src/layouts/Base.astro` (the theme toggle and the copy button). No UI framework, no analytics,
no web fonts from a CDN: Inter and JetBrains Mono are served from `public/fonts/` with their
licenses.

`site/` is its own pnpm project, separate from the repository's root workspace (its own
`pnpm-workspace.yaml` and lockfile). Installing here never changes the root `package.json` or
`pnpm-lock.yaml`.

## Develop

```sh
cd site
pnpm install
pnpm run dev        # astro dev on port 4340 (Astro picks the next free port if it's taken)
```

## Build

```sh
cd site
pnpm run build      # writes site/dist/
pnpm run preview    # serves dist/ locally
```

The theme grid is read from the repository's `themes/*.json` at build time, so the build needs
the whole repository checked out, not only `site/`.

Set `SOVA_SITE_URL` to the address the site is served from so link previews get an absolute image URL.

## What to update

- **A new release:** `release` in `src/data/site.ts` sets the install command, the version pill
  and the footer. Re-check every claim on the page against that tag, then update `verified`
  (the revision and date the footer names).
- **The design tokens:** re-copy `src/design/tokens.css` into `src/styles/tokens.css`; don't edit
  values here.
- **The Vis page's examples:** after a change to an example (`scripts/vis-examples/examples.mjs`)
  or to the app's vis code or styles (the repository's `src/vis/`), run `pnpm run vis-examples`
  here and commit `src/generated/vis-examples.html`. It draws each example with the app's own
  components, server-side, into static HTML plus the vis styles scoped to the examples, and the
  docs page puts it where `vis.md` has its `<!-- vis-examples -->` line. It needs the repository's
  root packages (`pnpm install` at the root). It stops on an example that doesn't parse or draws
  with warnings, on a kind with no example, and when a View it hands a width to has changed. The
  build doesn't run it, so a stale file builds without complaint.
- **Screens and video:** after a change to a captured screen in the app (its layout, labels or
  styles) or to the demo data, run the capture again. All demo data and every scripted model
  reply are in one plain-JSON file, `scripts/screens/story.json`; edit only that, then:
  `pnpm run screens:check` (names each problem by line and column), `pnpm run screens` (the
  screenshots whose inputs changed, as lossless WebP masters in `src/assets/screens/` with their
  `manifest.json`), `pnpm run screens:video` (the session video in `public/video/`) and
  `pnpm run screens:verify`. Commit the story with what they wrote. The pages take each image's
  alt text and size from the manifest; the build turns the masters into AVIF and WebP and never
  runs the capture, so a stale image builds without complaint. The capture needs the
  repository's root install and build, the playwright skill's browser and, for the video,
  `ffmpeg`; it runs Sova in a throwaway directory with nothing from `~/.pi`.
  `scripts/screens/README.md` has the details and the privacy checks.

## The social card

`public/og-image.png` (1200×630) is rendered from `brand/og-image.svg`:

```sh
cd site/brand
rsvg-convert -w 1200 -h 630 og-image.svg -o ../public/og-image.png
```

Its text is outlined from `public/fonts/Inter-Variable.woff2`, so the render needs no installed
font; a comment in the SVG names the text, weights, sizes and tracking, for re-outlining a changed
line. `og:image` is absolute only when `astro.config.mjs` sets `site`; set it to the deployed
origin, or some crawlers ignore the image.

## Deploy: Cloudflare Pages

Static output, no Functions and no adapter.

| Setting | Value |
| --- | --- |
| Framework preset | Astro (or None) |
| Root directory | `site` |
| Build command | `pnpm install --frozen-lockfile && pnpm run build` |
| Build output directory | `dist` (that is, `site/dist` from the repository root) |
| Environment variable | `NODE_VERSION` = `22.19.0` or later |

Leave Cloudflare Web Analytics off: the page promises no analytics.
