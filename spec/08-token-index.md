# 08 · Token index
> Part of the pi-web design spec · [overview](overview.md)

Every token `src/design/tokens.css` declares, except the `--brand-*` primitives. It used to list
only the ones these notes cite; it is now complete, because a theme author reads it to find out
what there is to set (§0), and an index that stops at what the prose happens to mention is one a
reader can't tell from a stale one.

- **Color:** `--color-bg`, `--color-surface`, `--color-sunken`, `--color-ink`, `--color-ink-2`,
  `--color-ink-muted`, `--color-border`, `--color-border-strong`, `--color-accent`,
  `--color-accent-hover`, `--color-accent-tint`, `--color-on-accent`, `--scrim`,
  `--skeleton-sweep`
- **Status:** `--status-success`, `--status-warn`, `--status-error`, `--status-info`,
  `--status-success-bg`, `--status-warn-bg`, `--status-error-bg`, `--status-info-bg`
- **Diff:** `--diff-add-bg`, `--diff-add-ink`, `--diff-del-bg`, `--diff-del-ink`, `--diff-gutter`
- **Type:** the whole family, because a theme may set any of it (§0). Faces: `--font-body`,
  `--font-display`, `--font-mono`. Weights: `--fw-regular`, `--fw-medium`, `--fw-semibold`,
  `--fw-display`. Size and line-height come in pairs, one per step — `--fs-display-xl` /
  `--lh-display-xl`, `--fs-display-l` / `--lh-display-l`, `--fs-heading-m` / `--lh-heading-m`,
  `--fs-heading-s` / `--lh-heading-s`, `--fs-body` / `--lh-body`, `--fs-caption` /
  `--lh-caption`, `--fs-mono` / `--lh-mono`, `--fs-micro` / `--lh-micro`. The `display-l` pair
  is defined and unused: the product has no section openers, and the step stays so the scale is
  whole. Tracking: `--ls-display`, `--ls-heading`, `--ls-heading-s`, `--ls-wordmark`,
  `--ls-body`, `--ls-mono-caps`, `--ls-eyebrow` — every letter-spacing in `base.css` is one of
  these except the 8 `letter-spacing: 0` resets, which undo inherited tracking rather than
  setting any
- **Space:** `--space-1`, `--space-2`, `--space-3`, `--space-4`, `--space-5`, `--space-6`,
  `--space-7`, `--space-8`, `--space-9` — product surfaces live in `--space-2`…`--space-5`;
  `--space-7` and up appear only where there is one idea on the screen
- **Radius:** `--r-none`, `--r-xs`, `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-full`
- **Stroke and size:** `--stroke-thin`, `--stroke-icon`, `--tap-min`, `--row-height`,
  `--control-sm`, `--control-md`, `--control-lg`, `--sidebar-width`, `--composer-max`, `--tool-output-max`,
  `--outline-max`, `--main-min`, `--subagents-width`, `--subagents-list-width`
- **Elevation:** `--shadow-1`, `--shadow-2`, `--shadow-3`
- **Focus and motion:** `--focus-ring`, `--focus-width`, `--focus-offset`, `--focus-color`,
  `--dur-fast`, `--dur-base`, `--dur-slow`, `--ease-standard`
- **Layout:** `--measure` (72ch at folded width; from unfolded up
  `clamp(72ch, 100vw − --sidebar-width − --space-9 − 2 × --space-8, 110ch)`, §3 "Column width"),
  `--bp-desktop`, `--page-max` (1280px — the cap on the landing page's card grid, §3, where the measure is the
  wrong cap), `--bp-unfolded`

The 38 `--brand-*` primitives are the one deliberate omission: they are raw values that only
`tokens.css` consumes, and a screen or a theme that reaches for one has gone around the semantic
layer.

A theme's `colors` map may set the 30 keys in the Color, Status, Diff and Elevation entries above
plus `--scrim` and `--skeleton-sweep`, and its `typography` map may name any `--font-*`, `--fs-*`,
`--lh-*`, `--fw-*` or `--ls-*` key listed here — whether these notes cite it elsewhere or not. §0
has the grammar each one accepts, and the names in a theme file drop the `--color-`, `--status-`
and `--diff-` prefixes.

---
