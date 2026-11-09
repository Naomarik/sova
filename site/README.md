# Sova landing page

A static [Astro](https://astro.build) site for Sova, styled with the app's own design system:
`src/styles/tokens.css` is a copy of `src/design/tokens.css`, and `src/styles/components.css` is a
subset of `.agents/skills/fold-ai-dev-design/fold-ai-dev.css`. The home page's product screens
and its hero video are real Sova, captured on demo data (see Screens and video below); the
Mesh and Organizations pages, and the phone lock screen beside the Overseer, are CSS
illustrations built from those classes.

It ships static HTML and one stylesheet. The only JavaScript is two small inline scripts in
`src/layouts/Base.astro` (the theme toggle and the copy button) and the hero video's caption script in
`src/components/screens/VideoCaption.astro`: under the video, a chapter bar (each segment a button
that jumps to its chapter) and the chapter's name and caption say what it shows at that moment,
from the cue list the recorder writes, following the video's own clock. Without JavaScript, with
reduced motion or when the video can't play, the still shows with one fixed line and no bar;
screen readers get the scene list once. No UI framework, no analytics,
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

- **A new release:** set `release` in `src/data/site.ts` to the new numbered tag; it sets the
  version pill, its release-page link and the footer. The install command, URL and script link
  stay on `stable` (`installRef`), the tag each release moves to itself. Re-check every claim on
  the page against the release commit, then update `verified` (the revision and date the footer
  names). The repository's release playbook, `.sova/playbooks/release/PLAYBOOK.md`, does this
  in its release commit; the deploy below follows the release, as its own step.
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
  `manifest.json`), `pnpm run screens:video` (the hero video in `public/video/`, AV1
  with an H.264 fallback, checked before it replaces the old one; nothing but the pointer is drawn
  into it, its captions are page text from the cue list in the manifest; the phone section shows
  stills only) and
  `pnpm run screens:verify`. Videos are gitignored and live on disk only, in the main checkout's
  `public/video/`; never commit them. The deploy adds them to its export (Deploy below). A reworded caption or chapter needs only `pnpm run screens:video -- --cues`, no new
  recording. The video shows real provider and model names; the footer says the replies are
  scripted and Sova isn't affiliated with the model makers. Commit the story with what they wrote. The pages take each image's
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

Static output, no Functions and no adapter. The site is live at https://sova.naomarik.com/.

| Setting | Value |
| --- | --- |
| Framework preset | Astro (or None) |
| Root directory | `site` |
| Build command | `pnpm install --frozen-lockfile && pnpm run build` |
| Build output directory | `dist` (that is, `site/dist` from the repository root) |
| Environment variable | `NODE_VERSION` = `22.19.0` or later |

Leave Cloudflare Web Analytics off: the page promises no analytics.

The Pages project is not connected to Git: a push to master deploys nothing. The site is Sova's
deploy target `site` (`deploy.targets.site` in `.sova/project.json`): after a release is published,
the operator ships it with Plan Deploy on the project's Deploy card, which takes only a published,
not withdrawn, release's commit and keeps the deploy's log and Roll Back. Its recipe, in a fresh
checkout of that commit:

1. `video`: copies the hero videos (gitignored, so a checkout has none) from `$SOVA_SITE_VIDEO_DIR`
   (`site/scripts/screens/add-video.mjs`), one of the target's env credentials. When that value is
   unset the plan fails its credential check, and a folder that misses a video fails the step: a
   deploy never ships the site without its hero video.
2. `install` and `site`: `pnpm install --frozen-lockfile`, then the build with
   `SOVA_SITE_URL=https://sova.naomarik.com/` (so `og:image` is absolute); the build runs the docs
   leak check.
3. `pages`: `wrangler pages deploy site/dist --project-name <the Pages project> --branch main
   --commit-hash <sha>`. `--branch main` is the project's production branch; any other branch name
   makes a preview deploy.
4. Verify: the address answers 200.

What it needs on the deploying machine, set by the operator and never in the repository: wrangler
logged in (`wrangler whoami`), and in Sova's host values for the project `SOVA_SITE_PAGES_PROJECT`
(the Pages project's name) and `SOVA_SITE_VIDEO_DIR` (the main checkout's `site/public/video`).
Deploy check names what is missing without running anything. A deploy's steps get a fixed
environment (`PATH`, `HOME` and a few more) plus the target's env credentials, which is why the
video folder is declared as one. Then check the live pages: the landing names `/stable/scripts/install.sh`
and links `/releases/tag/vX.Y.Z`, and `/docs/install/` shows the `stable` command.
