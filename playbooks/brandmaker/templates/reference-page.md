# Template — reference/<category>/<page>.md

Every reference file — foundations, brand, and components alike — follows this shape.
Components use `Variants & states`; foundations and brand topics use `Scale & spec` in its
place. Both sections are defined below — pick one, and never ship a page with neither, which
is how a foundation loses the only prose that explained it.

```markdown
# <Page title>

## Purpose
2–3 sentences in the brand voice: what this element is for and its single most important
usage rule.

Rendered: `site/<category>/<page>.html`

## Styles
| Class | Role | Notes |
|-------|------|-------|
| `.x`  | Base — <one-line spec> | <key tokens> |
| …every selector this page's elements use, including demo-only helpers flagged as such

## Tokens used
- `--token` — what it does *on this page specifically*.
- …every custom property the page depends on.

## Variants & states          ← components
### <Variant name>
```html
<copy-paste-ready snippet, real brand microcopy, no lorem ipsum>
```
…one snippet per variant/size; a note on the state matrix and the demo-only state classes.

## Scale & spec               ← foundations and brand topics
<The table this foundation exists to carry — the ramp, the scale, the colorway matrix, the
icon spec — with every value labeled. Then the prose a builder needs and cannot derive from
the table: the rationale, the boundaries, and any placeholder disclosure this page owns
(phase 06 requires the typography page to carry the font-placeholder note).>

## DO / DON'T
- **DO** <rule> — <why, one clause>.
- **DON'T** <anti-pattern> — <what to do instead>.
(3–6 pairs, drawn from the site page's "Uso" section so docs and site agree.)
```

Rules: the `Rendered:` path must resolve to a shipped file — cite a specific part of the page
as `<page>.html#<section-id>`, using the `id`s phase 05 put on every major section; snippets
must render correctly when pasted into a page that links the two CSS files; all copy in the
brand's language and voice.

**No line ranges into the rendered HTML.** A `L64–L109` citation is stale the next time
anything regenerates the page, and it answers a question — "which lines of the demo page is
this?" — that nobody building a component asks. The path plus the section `id`s are the whole
useful reference; the line numbers are maintenance nobody signed up for. Multiply the block by
every foundation, brand topic and component and it is the single largest stretch of prose in
the skill that no reader has ever needed.
