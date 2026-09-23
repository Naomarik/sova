# Parity manifest

The generated `<brand>-skill/` must ship every artifact below, feature-complete. This is the
binding checklist for phase 06. Counts marked *scale* adapt to the brand's inventory but may
not fall below the minimum.

## Files

- [ ] `SKILL.md` — YAML frontmatter (`name: <brand>-design-skill`, a brand-neutral routing
      `description`, and `user-invocable: true`). The description covers the actions and
      artifact types that trigger the skill, with no repeated brand/product name, product
      synopsis, design decisions, inventory, or counts. The body is **the whole system in
      prose**, in this order: version + locale line · precedence rule (reference file wins
      for component detail, this file wins for anything cross-cutting) · How to use (load
      order, theme, where to look) · Layout (tree + one-line-purpose table) · Voice (pillars,
      grammar table, microcopy patterns) · Color · Type · Shape & space · Responsive ·
      Focus & motion · Dark mode · Accessibility · Icons · Marks · Components · Class index ·
      Tokens by group · Licensing. Headings match `templates/skill-md.md` exactly. Every count
      in it matches the shipped files.
- [ ] **No `README.md` and no `CHANGELOG.md`.** `SKILL.md` is the only prose document. Two of
      them split every cross-cutting rule across files that then disagree, and a changelog
      with one entry is a file nobody appends to.
- [ ] **No product definition anywhere in the skill** — no synopsis, audience description,
      positioning paragraph, or taglines. **Do not grep for the brand name as a sentence
      subject**: "<Brand> is warm paper, dark ink, and one deep green" is a color rule, and
      that pattern returns dozens of legitimate design statements and no real hits. Grep for
      what actually leaks — audience nouns ("teams", "users who", "designed for"),
      positioning verbs ("helps you", "lets you", "makes it easy"), and taglines — then apply
      the removal test: cut the sentence and ask whether a rule became unusable. If yes it
      stays; if it only told you what the product does, it goes.
- [ ] `tokens.css` — every design decision as a custom property: brand colors, semantic
      colors, muted-text value (flattened per theme, not alpha — see
      `templates/tokens-css.md`), type scale (`--fs-*`), font stacks, weights, spacing scale
      (`--space-*`), radii (`--r-*`), strokes, shadows, focus ring; plus `@font-face` blocks
      pointing at `fonts/`, and element defaults (html/body/headings).
- [ ] `<brand>.css` — compiled component + utility CSS, sibling of `tokens.css`, consuming
      only tokens (no raw hex outside tokens.css except where documented). Covers every
      component in the inventory with variants, sizes, and state classes.
- [ ] `fonts/` — every file referenced by `@font-face` physically present (*scale*: min 2
      families or 1 family in ≥2 weights).
- [ ] `assets/logos/` — logo SVGs in each approved colorway (*scale*: min 3 — primary, dark,
      light — across the logo variants defined in phase 02).
- [ ] `assets/icons/` — **one** icon system, shipped locally as files in
      `assets/icons/functional/` (*scale*: 24–40 icons covering nav, interface, forms,
      status, and the product's domain). Naming an external library without shipping files is
      a network dependency and fails this item. Do not ship a second, "expressive" set for
      marketing surfaces: it is used on no screen the skill documents, and a set that never
      appears beside the one it must never be mixed with is a rule with no failure mode.

## Reference docs (`reference/`)

- [ ] `foundations/` — exactly these six: `colors.md`, `typography.md`, `spacing.md`,
      `radius.md`, `shadow.md`, `grid-composition.md`.
- [ ] `brand/` — exactly these two: `logo.md`, `iconography.md`. No `photography.md`: art
      direction for imagery is not how a UI gets produced, and a page whose entire content is
      "we don't use photos" earns nothing.
- [ ] `components/` — one MD per inventory component (*scale*: min 8; default inventory is
      buttons, chips, inputs, controls, toggles, cards, banners, nav-bars, overlays, lists,
      tables, charts, unless the interview changes it — plus empty states, loading/skeleton,
      toasts, and pagination where the product implies them).
- [ ] Every reference MD follows `templates/reference-page.md`: Purpose · Rendered (the page
      path) · Styles (class table) · Tokens used · then **Variants & states** with copy-paste
      HTML snippets (components) or **Scale & spec** (foundations and brand topics) · DO /
      DON'T. Exactly one of those two sections, never neither. **No line ranges into the
      rendered HTML** — they are stale the next time anything regenerates, and they answer a
      question nobody asked.

## Rendered site (`site/`)

- [ ] `site/index.html` — root hub linking every page.
- [ ] One page per foundation (6), per brand topic (2), per component (matches inventory).
- [ ] Pages share the skill's own CSS (`tokens.css` + `<brand>.css`, copied or relatively
      linked), render every variant/state documented in the matching reference MD, and work
      offline via relative links only.
- [ ] Site chrome (sidebar, nav, demo scaffolding) lives in `site/docs.css`, separate from
      `<brand>.css` — the system CSS contains nothing that exists only to render the site.
- [ ] Every `href`, `src`, and CSS `url()` in the skill resolves to a shipped file —
      verified mechanically, not by reading the docs. **The script alone is not sufficient:** a
      `url()` passed through a CSS custom property resolves against the stylesheet that
      consumes the `var()`, not the file that declares it, so the audit checks the wrong
      directory and passes. Keep `url()` on the element or in the stylesheet that owns it, and
      confirm in the browser.
- [ ] Every major site-page section carries a stable `id` anchor, and every reference MD
      names a page that exists on disk.

## Cross-cutting

- [ ] Color usage ratio defined once, in `SKILL.md`, and matching what `tokens.css` and any
      generator that draws swatches actually use. **A generator that disagrees with
      `tokens.css` silently reverts the docs on the next rebuild** — assert the shared hexes
      mechanically, across the CSS, the prose, and the generator alike.
- [ ] Muted-text formula, focus-ring spec, and "never" rules (e.g. no hue-only status)
      present in `SKILL.md`.
- [ ] **Contrast computed for every documented fg/bg pairing**, every failure fixed or
      explicitly excepted with rationale. `SKILL.md` carries the *policy* and the tightest
      surviving pair — the number that constrains the next palette move — not the full table.
- [ ] **Stated stances, even if negative:** dark mode · motion (durations/easing +
      `prefers-reduced-motion`) · responsive (breakpoint tokens + per-component collapse
      behavior + touch-target minimum). Each has a section; "not supported, because…" counts.
- [ ] **Licensing** of every font and icon set recorded in `SKILL.md` (redistribution terms
      noted for anything non-open). A few lines, not an appendix.
- [ ] Locale grammar rules table adapted to the brand's language.
- [ ] No CDN/external URLs anywhere the skill *loads from* — no remote `href`, `src`, `url()`,
      or `@import`. A URL inside a shipped license or attribution file is text, not a
      dependency, and passes.
- [ ] **No working artifacts left in the skill directory** — checkpoint HTML, exploration
      pages, scratch previews. They are inputs to the run, not outputs of it, and a stray
      checkpoint page reads as reference to whoever opens it next.
- [ ] `.ledger.md` contains no **silently** unconfirmed load-bearing defaults: each is either
      user-confirmed or marked `AI-default-final` and named in the handoff. Delete it at
      handoff.
