---
title: Build the {{name}} site and docs
description: Scaffolds a static Astro site in .sova/marketing/site/ with its own package.json, publishes the docs the user approves where they already are, and checks every page at three widths in both themes.
promptHint: Which of the project's docs to publish (you'll be shown a proposed list first), where the site will be hosted, and which pages beyond Home and Docs it needs.
---

# Build the {{name}} site and docs

One static site that is both the marketing page and the documentation. The project's
documentation is published from where it already is; the README then points at the site. A
reader who found the project should know in 30 seconds whether to use it. So the site has no
sign-up, pricing, testimonials, analytics or "get started free". It shows what the README's first
paragraph says, with more room.

Paths are relative to the project root (see `.sova/marketing/TOOLS.md`). This playbook's
directory holds `scaffold/` (the site's files), `inventory-docs.mjs` (the docs proposal) and
`check-site.mjs` (the pre-publish check). Read each file when a step names it.

## Rules the site keeps

- **Static output, nothing remote.** Astro builds plain HTML into `.sova/marketing/site/_site/`.
  No CDN, no web fonts from a font service, no analytics, no client-side framework. Fonts are
  the local files named in `brand.json`, copied in at build time.
- **Its own dependencies.** The site has its own `package.json` in `.sova/marketing/site/`.
  Never add Astro, or anything else, to the project's own `package.json` or lockfile.
- **`_site/`, never `dist/`.** `outDir` is pinned to `_site` in `astro.config.mjs`. Many
  projects' `.gitignore` match `dist/` at any depth, which would silently drop the site from
  git. Don't change it.
- **The brand's theme, not the reader's.** `visual.defaultTheme` decides. `dark` or `light` is
  written on every page as `<html data-theme="…">` and the reader's system setting changes
  nothing; `system` writes no attribute and follows `prefers-color-scheme`. Never both. Both
  palettes are in the page so either can be checked, but there is no theme toggle: that is a
  separate ask, and only if the user makes it.
- **It may not claim more than the README.** Every sentence on the site must be findable in the
  README, in `.sova/marketing/claims.md` with its revision, or in `brand.json`. If the site
  knows something the README doesn't, fix the README first (**Rewrite the {{name}} README**).
  That goes for every doc it publishes, too.
- **Research is never documentation.** Research, feasibility studies, wishlists, proposals,
  plans and notes describe what might be, not what is. They are never published as the
  project's docs, whatever folder they sit in. If the project ranks its sources (a
  truth-sources document), anything it ranks below the README is held to this rule.
- **Brand from `brand.json`, not copies.** The layout reads `../brand.json` at build time: the
  name, the one line, the paragraph, `defaultTheme`, each theme's five colours, the faces, the
  weights, the wordmark, the mark, the licence and the base path. Don't paste those into pages or
  CSS. Voice rules are in `.sova/marketing/BRAND.md`.
- **Checked before it goes up**, at 475, 933 and 1280 px in light and dark (step 6).

### Where each brand value lands

| `brand.json` | On the site |
|---|---|
| `visual.defaultTheme` | `<html data-theme>` (`dark`/`light`), or none and `prefers-color-scheme` (`system`). |
| `visual.palette.<theme>.bg`, `.ink`, `.muted` | The page, body text, and secondary text in that theme. |
| `visual.palette.<theme>.accent` | That theme's links and the fill of the one primary action. Never shared across themes. |
| `visual.palette.<theme>.accentInk` | Text on that theme's accent fill: the primary action's label. Never `bg` or white by assumption. |
| `visual.weights` | The only weights the site sets. Text takes the listed weight nearest 400, emphasis (headings, `strong`, `th`) the one nearest 600. Without the list, 400 and 600. |
| `visual.wordmark` | The header lockup's weight and tracking. Without it, **640 and `-0.03em`, the scaffold's defaults, not the brand's decision**; say so to the user. A wordmark weight outside `visual.weights` stops the build. |
| `mark.file` | Inlined in the header, so a `currentColor` mark takes the ink of either theme. |
| `mark.variants` | The favicon, where `currentColor` has nothing to inherit: `light` and `dark` follow the browser's tab strip, else `mono`, else `mark.file`. |
| `project.install`, `project.run`, `project.demoNotes` | Home's "Try it". A `run` list is shown as one command per terminal; `demoNotes` says which process listens where. |
| `facts.siteUrl` | The base path of every link. |

What does not come from `brand.json`: sizes, spacing, radii, the line length and the headings'
letter-spacing in `src/styles/site.css`. They are the scaffold's chrome, not brand decisions. If
the project has a `visual.designSystem` (and `visual.designSystemRefs`), take them from there
(step 1).

## 0. Align

Read `.sova/marketing/BRAND.md`, and look for `.sova/marketing/claims.md`. Then inventory the
docs (the next section) and ask the user, in one message, and wait:

1. **The docs.** Show the mapping from the inventory: what you propose to publish, what stays
   where it is and why, and what is excluded and why. Nothing moves either way (step 2).
2. **Pages.** Home and Docs are built in. Anything else (a changelog, an about page) must have a
   source it derives from. Recommend none.
3. **Hosting.** Confirm `facts.hosting` and `facts.siteUrl` in `brand.json`. The site URL's path
   is the base path; a wrong one breaks every link once published. If they change, edit
   `brand.json` and re-run the generator.

If there is no `claims.md` yet, say that the README playbook produces it and that without it the
site can only publish what the README itself backs.

### Inventory the docs first

Never publish a docs folder wholesale. A `docs/` folder commonly holds three kinds of file, and
only one of them is documentation:

- **Documentation** of what the project does today: setup, usage, configuration.
- **Files other documents reference**: the images a README's header shows, a diagram a spec
  embeds. Moving one breaks that reference.
- **Research, feasibility, wishlist, proposals, plans, notes.** Ideas, never cited as shipped.

Run the inventory. It reads and prints; it moves, copies and writes nothing:

```sh
node .sova/marketing/playbooks/doc-site/inventory-docs.mjs --dir docs
```

It lists every file in the folder (not only markdown), who refers to each one from anywhere in
the project, and a proposed class: `publish?`, `referenced` (stays where it is), `exclude`
(research by name or heading, or notes describing referenced assets) or `leave`. It ends with a
proposed `docs.json`. Its classes are guesses from names, headings and references. Then:

1. **Read every `publish?` file.** Demote it to `exclude` if it is research or a plan that
   happens to have a plain name. Check each claim it makes against the README and `claims.md`,
   and list any claim neither backs. Such a doc is not published until the README says it, or the
   user edits the doc.
2. **Read the `exclude` files' openings** to confirm they are not documentation with an unlucky
   name; move one back only with a reason you tell the user.
3. **Tell the user, as a table**: each file, its class, why, and what happens to it. Name the
   excluded files and the unbacked claims explicitly, and name every doc another file links to.
4. **Wait for a yes.** Change nothing before it.

## 1. Scaffold (once)

If `.sova/marketing/site/` already exists, skip to step 2: it is the project's now, and the
scaffold is only a starting point. Otherwise:

```sh
cp -R .sova/marketing/playbooks/doc-site/scaffold .sova/marketing/site
mv .sova/marketing/site/gitignore .sova/marketing/site/.gitignore
```

What you just copied:

| File | Role |
|---|---|
| `package.json` | The site's own dependencies: `astro`, pinned to an exact version. |
| `astro.config.mjs` | Static output into `_site/`, base path from `facts.siteUrl`, no dev toolbar, no highlighter. |
| `docs.json` | The docs folder (relative to the project root) and the list of files in it the site publishes, in index order. Points at the two placeholders until step 2. |
| `scripts/sync-brand.mjs` | Runs before `dev` and `build`: copies the font files, the mark and its variants, and the screenshots named by `brand.json` and `assets/screenshots/manifest.json` into `public/brand/` (gitignored). |
| `src/content.config.mjs` | The `docs` collection: exactly the files `docs.json` lists, read where they are. Frontmatter is optional. |
| `src/lib/brand.mjs` | Reads `brand.json`: theme, per-theme colours, weights, wordmark, mark, run lines, and the revision for the footer. |
| `src/lib/docs.mjs` | Reads `docs.json`; doc titles, ordering, and rewriting `other.md#anchor` links to built URLs (a link to the root `README.md` goes to Home). |
| `src/layouts/Base.astro` | Header, footer, the theme from `defaultTheme`, both palettes, `@font-face` for local fonts. |
| `src/pages/index.astro` | Home: the one line and the paragraph verbatim, one screenshot, how to try it, what it is not. |
| `src/pages/docs/index.astro`, `src/pages/docs/[...slug].astro` | The docs index and one page per doc. |
| `src/styles/site.css` | Chrome. The accent is spent on links and the one primary action per page. |
| `src/content/docs/*.md` | Two placeholders. Delete them once `docs.json` names the real docs. |

Install and build it once before changing anything, so you know the scaffold works here:

```sh
cd .sova/marketing/site && npm install && npm run build
```

`npm install` writes `package-lock.json` in the site folder; keep it. If the project has a
`visual.designSystem`, read it now, and every path in `visual.designSystemRefs`, and bring its
chrome (spacing, radii, sizes) into `src/styles/site.css`; where its tokens differ from the
palette variables the design system wins, and `brand.json` should be corrected to match. If the
design system sets its theme with `data-theme` on `<html>`, the site already does the same.

## 2. Publish the approved docs, in place

Do what the user approved in step 0, and only that. Publishing is an edit to `docs.json`, not
a move:

```json
{ "dir": "docs", "publish": ["getting-started.md", "configuration.md"] }
```

`dir` is relative to the project root. `publish` names each file by its path inside `dir`, one
by one (no wildcards), in the order the docs index shows them. The site reads them where they
are, so there is still one copy, and every link and image into that folder, from the README or
anywhere else, keeps working. A file not on the list is never published, whatever sits beside
it. Then delete the placeholders:

```sh
rm -r .sova/marketing/site/src/content/docs
```

- Don't edit the docs to suit the site. Frontmatter is optional: a doc without a `title` is
  titled by its first `# ` heading.
- Links between published docs stay as relative `.md` paths, as they read on GitHub; the site
  rewrites them (`other.md#heading` and `../other.md` both work), and a link to the root
  `README.md` goes to Home. A link to a doc that isn't published stays as written and the check
  fails on it: ask the user whether to publish that doc too or to drop the link.
- A relative image in a published doc is built from where it is. An image the README also uses
  stays where it is; never move or copy it to suit the site.
- **Moving** a doc into the site is only for a doc nothing else refers to (the inventory shows
  none), when the user asks for it, with `git mv` of that one file. Never move a file another
  document references: that breaks the reference. Check that git keeps the destination first:

  ```sh
  git check-ignore -v .sova/marketing/site/src/content/docs/x.md && echo "IGNORED"
  ```

  If that prints `IGNORED`, stop and tell the user.

## 3. Home

`src/pages/index.astro` already pulls the one line, the paragraph, the install and run commands,
the demo notes and "what it is not" from `brand.json`. When `project.run` is a list, Home shows
each command as its own block, to run in its own terminal; `project.demoNotes` should say which
process listens where. Add only what the README also says. For the screenshot, run **Capture
{{name}} screenshots** first. Home uses the shot marked `"hero": true` in
`.sova/marketing/assets/screenshots/manifest.json`, or else the first one. It must be the real app
at a named revision, never a mockup.

## 4. Build

```sh
cd .sova/marketing/site && npm run build
```

`build` runs `sync-brand.mjs` first and prints what it copied. The output is in `_site/`. A build
that stops on `docs.json` names the file it could not find; one that stops on the wordmark
weight means `visual.wordmark` or `visual.weights` in `brand.json` needs fixing.

## 5. Look at it

Serve it (`npm run preview` in the site folder prints a local URL) and read every page yourself
in a browser before running the check. The preview serves the built site alone; the project
itself doesn't need to be running. Then stop the preview.

## 6. Check

Start your own browser (see `.sova/marketing/TOOLS.md`), then from the project root:

```sh
PW_PORT=<your port> node .sova/marketing/playbooks/doc-site/check-site.mjs
```

It serves `_site/` under the base path and follows every internal link. It rejects any
stylesheet, script, image or font from another origin, and any page whose `<html data-theme>`
isn't `defaultTheme` (none for `system`). It checks each theme's contrast (ink, muted and accent
on `bg`, `accentInk` on `accent`) and, when `visual.weights` is set, that the built CSS sets no
other weight. Then it renders every page at 475, 933 and 1280 px in light and dark. With a fixed
theme it first proves the page is the brand's theme under either system setting, then sets
`data-theme` to render the other palette too. Each render must have no horizontal overflow, that
theme's `bg`, the primary action in that theme's `accentInk` on its `accent`, only allowed
weights, no page errors and no requests leaving the site. Screenshots land in
`.sova/marketing/site/_check/`. **Open a few of them**: at least home and one doc page, at 475
dark and 1280 light. The check proves the page loaded; only looking proves it reads.

Fix every failure and re-run until `failures` is empty.

## 7. Hand off

- Report the pages, the check's summary (paste `failures: []` and the page list), and which
  screenshots you looked at.
- List the docs published (from `docs.json`), the files excluded and why, and any link you
  changed with the user's yes.
- If the wordmark used the scaffold's defaults (no `visual.wordmark`), say so.
- Publishing is the user's step. Say what to upload (`_site/`, built at the revision in its
  footer) and to where (`facts.hosting`). Don't set up CI or deploy unless asked.
- Before it goes up: every command on the site was run at the revision in the footer (each
  `project.run` line in its own terminal), and nothing on it says "team", "cloud", "hosted",
  "sign in" or "plan" unless the product is one.
