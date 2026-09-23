# Phase 05 — Reference docs & rendered site

Two coupled deliverables: `site/` (rendered HTML) and `reference/` (per-section MDs naming the
page they document). **Build each site page first, then its reference MD**, so the page it
names is real.

**Generate both from one content model if you can.** A single model emitting the HTML and the
markdown makes it impossible for a doc to disagree with the page it documents — and if you do
build a generator, it is now a third place the palette is written down. Assert in phase 06
that the generator, `tokens.css` and `SKILL.md` state the same hexes: a generator holding
superseded values reverts the docs the next time anyone rebuilds, and nothing in the shipped
output shows it.

**Have the generator parse `tokens.css` rather than restate it.** Then it cannot hold a stale
hex, and the phase 06 assertion is true by construction instead of being one more thing to
keep in sync. Written the other way, the recommended path manufactures the exact problem the
next phase makes you audit.

## Site (`site/`)

Pages live in **category subdirectories** — `site/foundations/`, `site/brand/`,
`site/components/` — with `index.html` and `docs.css` at the root of `site/`. Fix this before
writing a single page: it decides whether every page links `../tokens.css` or
`../../tokens.css`, and changing it later rewrites every reference in the skill.

- `site/index.html` — hub page: brand header, grouped links to every page (foundations /
  brand / components), built with the skill's own CSS.
- Foundations pages (6): colors, typography, spacing, radius, shadow, grid-composition.
  Each renders the actual ramp/scale from tokens with values labeled.
- Brand pages (2): logo (all variants × colorways, clear-space, misuse) and iconography (the
  full set rendered at real size, plus the spec).
- Component pages (one per inventory item): anatomy → variants → full state matrix → sizes →
  icon usage where relevant → DO/DON'T usage section. All demo copy in the brand's language
  and voice, using the microcopy patterns from the ledger.
- Every page: `lang` attribute set, relative links to `tokens.css` + `<brand>.css` (place
  copies or the originals so `site/` opens standalone), consistent shared page chrome
  (header, back-to-index link).
- **Site chrome is quarantined**: sidebar, nav, page scaffolding, and demo-only layout live
  in `site/docs.css`, linked after the system CSS. Nothing goes into `<brand>.css` that
  exists only to render the site.

Give every major section of every page a stable `id` (e.g. `id="variants"`, `id="states"`).
The anchor survives edits and is the whole handle a reader needs.

## Reference MDs (`reference/`)

One MD per site page (minus index), per `templates/reference-page.md`:
Purpose · Rendered (the page path) · Styles (class table with role + notable tokens) ·
Tokens used (every custom property the page depends on, with what it does there) ·
**Variants & states** for components (copy-paste HTML snippets, one per variant) or
**Scale & spec** for foundations and brand topics (the ramp/matrix plus the prose a builder
cannot derive from it) · DO / DON'T.

**Do not cite line ranges into the rendered HTML.** They are wrong the next time anything
regenerates a page, they answer a question nobody building a component asks, and across every
foundation, brand topic and component they add up to the longest stretch of prose in the skill
that no reader has ever needed.

## Exit check

- **Mechanical link audit**: extract every `href`, `src`, and CSS `url()` under `site/` and
  verify each resolves to a shipped file (a short script, not a read-through). This is the
  single most common way a "self-contained" skill ships broken.
- Spot-open 3 pages (one per group) **in a real browser, in every theme the brand ships**
  (both, unless the dark-mode stance is "never"), and confirm rendering. A theme that was
  never opened is a theme that ships broken.
- Open one of them **at a phone width** as well. Collapse behavior is the part of the system
  no page-level check sees: a table that clips instead of scrolling reports no overflow and
  is still missing two columns.
- Count check: 6 foundations + 2 brand + N components in both `site/` and `reference/`,
  N = inventory size.

## Last step of this phase — `SKILL.md`

Now that every page and reference file exists, write `SKILL.md` per `templates/skill-md.md`.
It is the only prose artifact and the longest (~350–450 lines); write it in the brand's own
voice — the document *demonstrates* the voice it prescribes. Every count in it is a count of
files that now exist. The frontmatter description stays a concise routing rule with no
inventory, and the body carries no product definition.
