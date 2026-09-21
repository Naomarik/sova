# 08 · Token index
> Part of the pi-web design spec · [overview](overview.md)

Every token these notes reference, all defined in `src/design/tokens.css`:

- **Color:** `--color-bg`, `--color-surface`, `--color-sunken`, `--color-ink`, `--color-ink-2`,
  `--color-ink-muted`, `--color-border`, `--color-border-strong`, `--color-accent`,
  `--color-accent-hover`, `--color-accent-tint`, `--color-on-accent`, `--scrim`,
  `--skeleton-sweep`
- **Status:** `--status-success`, `--status-warn`, `--status-error`, `--status-info`,
  `--status-success-bg`, `--status-warn-bg`, `--status-error-bg`, `--status-info-bg`
- **Type:** `--font-body`, `--font-display`, `--font-mono`, `--fw-regular`, `--fw-medium`,
  `--fw-semibold`, `--fw-display`, `--fs-heading-m`, `--fs-heading-s`, `--fs-body`,
  `--fs-caption`, `--fs-mono`, `--fs-micro`, `--lh-heading-m`, `--lh-heading-s`, `--lh-body`,
  `--lh-caption`, `--lh-mono`, `--ls-eyebrow`
- **Space:** `--space-1` through `--space-9` (the notes use `--space-2`, `--space-3`, `--space-4`,
  `--space-5`, `--space-6`, and `--space-8`)
- **Radius:** `--r-xs`, `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-full`
- **Stroke and size:** `--stroke-thin`, `--stroke-icon`, `--tap-min`, `--row-height`,
  `--control-sm`, `--control-md`, `--sidebar-width`, `--composer-max`, `--tool-output-max`,
  `--outline-max`, `--main-min`, `--subagents-width`, `--subagents-list-width`
- **Elevation:** `--shadow-1`, `--shadow-2`, `--shadow-3`
- **Focus and motion:** `--focus-ring`, `--focus-width`, `--focus-offset`, `--focus-color`,
  `--dur-fast`, `--dur-base`, `--ease-standard`
- **Layout:** `--measure` (72ch at folded width; from unfolded up
  `clamp(72ch, 100vw − --sidebar-width − --space-9 − 2 × --space-8, 110ch)`, §3 "Column width"),
  `--page-max` (1280px — the cap on the landing page's card grid, §3, where the measure is the
  wrong cap), `--bp-unfolded`

---

