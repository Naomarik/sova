# Template — SKILL.md

**This is the only prose document the skill ships.** There is no `README.md` beside it and no
`CHANGELOG.md`. Everything a designer or an implementer needs that isn't specific to one
component lives here; component specifics live in `reference/components/<name>.md`.

Written **last** (phase 05, final step — after `site/` and `reference/` exist, so the counts
in it are counts of real files). Target ~350–450
lines — long enough to be the whole system, short enough that an agent loads it before
working. Written **in the brand's own voice**: the document demonstrates what it prescribes.

## Structure

```markdown
---
name: <brand>-design-skill
description: Use when designing, implementing, modifying, or reviewing this project's
  interfaces, components, prototypes, product copy, design-system code, or visual assets.
  Provides visual, voice, accessibility, and implementation guidance.
user-invocable: true
---

**Version.** <x.y.z> · **Locale.** <lang>

<One paragraph: this file is the design system — how a surface looks, reads and behaves. Name
where the product itself is specified, and say that duplicating it here is how the two drift.>

**Precedence.** For how a component is built — its classes, variants, states — the file in
`reference/components/` wins. For anything that crosses components, this file wins. When they
disagree one of them is stale; fix it.

<One line: if invoked without other guidance, ask what to build, ask a handful of focused
questions, and act as an expert designer.>

## How to use
<Link order (tokens first, why), theme override, and a "look at site/index.html before you
build" line with the exact page count broken down: N foundations + N brand + N components.>

## Layout
<Directory tree with a one-line purpose per entry. No second Entry | Purpose table — it
restates the tree — and **no line counts**: they are stale one edit later. If the skill has a
generator, say so here and say "edit the model, not the output".>

## Voice
<Pillars table — Pillar | Means | In practice. State that they are not modes: every message
is all of them at once.>
### Grammar · <locale>
<Rule | What it means | Example. Address form, first person, CTA casing, numerals, dates,
currency, punctuation, errors, apology stance.>
### Microcopy patterns
<Context | Pattern | Notes. Primary/secondary/destructive CTA, cancel, empty state,
confirmation, timestamp, error, success, loading.>

## Color
<Palette table: Name | Light | Dark | Role. Then the usage ratio with its rationale, the
muted-text rule, the status table with soft backgrounds, and the never-rules.>

## Type
<Faces and what each is for. Permitted weights. Full scale table: Step | Size | Line height |
Usage. Any per-theme adjustment.>

## Shape & space
<Radius scale, per-element assignment table with a "why" column, stroke values, the spacing
scale with the density stance, elevation steps, and the canonical page layouts.>

## Responsive
<Breakpoint table: name | width | what actually changes. Container-vs-media stance. Touch
minimum, restated as a rule with its failure.>

## Focus & motion
<Focus ring spec. Duration/easing token table. What never animates, and the named exceptions.
`prefers-reduced-motion` behaviour.>

## Dark mode
<The stance. If shipped: how elevation works differently, and the tightest contrast pair —
the number that constrains the next palette move.>

## Accessibility
<Policy list: contrast (every documented pair measured, thresholds named), touch, focus,
status-never-hue-alone, reduced motion, labels.>

## Icons
<Count, grid, stroke, caps, color inheritance. The full name list. How to add one. Why the
set ships as local files rather than a library reference.>

## Marks
<Variants table with files and uses, clear space, minimum size, misuse list. Placeholder
disclosure here if the logo was generated.>

## Components
<One row per component: Component | Variants | Sizes | Key rule. Matches
`reference/components/` and `site/` one-to-one.>

## Class index
<Component | Selectors. Dense and greppable — this is the lookup that saves reading the
whole stylesheet.>

## Tokens by group
<Group | Tokens. Wildcards and ranges are expected — `--fs-*`, `--space-1 … --space-13` —
not an enumeration of every property; the full list is `tokens.css`, and reproducing it here
is a second copy that goes stale. Name the raw layer beneath the semantic one and say to
consume the semantic tokens only.>

## Licensing
<Asset | Source | License | Redistribution. A few lines. Anything non-open gets its
redistribution terms named.>
```

## Rules

- **The frontmatter description is a routing rule.** Cover the actions and artifact types that
  should trigger the skill. Keep the brand/product name, the synopsis, the voice pillars, the
  colors, the typefaces, the inventory and every count *out* of it — `name` already identifies
  the skill, and a description that lists contents goes stale on the first change.
- **No product definition in the body either.** No "<Brand> is a…" paragraph, no audience
  description, no positioning, no taglines. You need that context to do the work — it lives in
  the ledger and shapes the voice, the palette and the inventory — but it does not ship as
  prose. A design system that also describes the product becomes the second place the product
  is described, and the second place is always the stale one.
- **Illustrative microcopy stays.** "3 runs waiting on you" as an example of the calm pillar is
  teaching the rule, not describing the product. The test: remove the line and ask whether a
  rule became unusable. If yes it belongs; if it only told you what the product does, cut it.
- **Every count in the body matches the shipped files**, and phase 06 checks it mechanically.
- **State the rule, then name the failure it prevents.** "Status is never hue alone — 1 in 12
  men can't separate your red from your green" beats "prefer accessible status colors". A rule
  with no failure attached reads as a preference and gets skipped.
