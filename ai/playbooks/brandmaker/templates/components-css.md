# Template — <brand>.css (compiled components + utilities)

Sibling of `tokens.css`; documented to load **after** it. One banner-commented section per
inventory component, in the inventory's order, then a utilities section.

Per component section:

- **Base class** (e.g. `.button`, `.card`, `.chip`) — layout, radius, stroke, type, all from
  tokens (`var(--…)` only; no raw hex).
- **Variant classes** — `.button-primary`, `.button-ghost`, … one per documented variant.
- **Size classes** — `.button-sm/-lg` etc. where the spec defines sizes.
- **Real states** — `:hover`, `:focus-visible` (uses focus tokens), `:active`, `:disabled`.
- **Static state helpers** — `.is-hover`, `.is-focus`, `.is-active`, `.is-disabled` mirroring
  the real states, with a comment: *demo/documentation only — production uses real
  pseudo-classes*. (The site's state matrices need these.) Keep them in the `is-` namespace,
  never `.button-hover`: that is the same shape as a variant class, so a reader cannot tell a
  fake state from a real variant and the class index has to explain the difference in prose.
- **Demo helpers** where the site needs them (`.button-row` etc.), commented as such.

Utilities section (small, curated — not a utility framework): text styles matching the type
scale (`.text-display-lg`, `.text-caption`…), muted text, surface/bg helpers, stack/cluster
spacing helpers, visually-hidden.

Rules:

- Class naming: `component`, `component-variant`, `component-size` — flat, hyphenated,
  consistent throughout. The reference MDs' class tables must list every selector
  shipped here.
- Every component in `SKILL.md`'s inventory has a section here; nothing here lacks a
  reference MD.
- Charts (if in inventory): style axes/gridlines/legend/tooltip classes and define the
  categorical series token order.
