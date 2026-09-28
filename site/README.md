# Sova landing page

A static [Astro](https://astro.build) site for Sova, styled with the app's own design system:
`src/styles/tokens.css` is a copy of `src/design/tokens.css`, and `src/styles/components.css` is a
subset of `.claude/skills/fold-ai-dev-design/fold-ai-dev.css`. The product screens on the page are
CSS mock-ups built from those classes, not screenshots; replace them with real captures from a
hermetic agent directory before launch.

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

## What to update

- **A new release:** `release` in `src/data/site.ts` sets the install command, the version pill
  and the footer. Re-check every claim on the page against that tag, then update `verified`
  (the revision and date the footer names).
- **The design tokens:** re-copy `src/design/tokens.css` into `src/styles/tokens.css`; don't edit
  values here.

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
