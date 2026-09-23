# Template — tokens.css

One file, organized in this order with a banner comment per group. Budget ~300–450 lines for a
single-theme system; **a shipped dark mode costs roughly 90 lines on top of that**, because
`@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` cannot share a rule in
plain CSS. Go over rather than reach for `light-dark()` — trading a line count for a browser
support floor is a bad trade in a file whose job is to work everywhere.

1. **`@font-face` blocks** — one per shipped font file, `font-display: swap`, relative
   `url("fonts/…")` paths. Only weights the system permits.
2. **`:root` custom properties**, grouped:
   - Brand colors: `--brand-<name>` per palette color, plus `--brand-white`/ink as needed.
   - Semantic colors: `--color-bg`, `--color-surface`, `--color-ink`, `--color-ink-muted`,
     `--color-border`, and status (`--status-success/warn/error/info` + their soft
     backgrounds). Ship muted text as a **flattened opaque value per theme**, not as
     `rgba(ink, .6)`. An alpha value has no contrast ratio — it has a different one on every
     surface it can land on, so `PLAYBOOK.md`'s "compute every documented pair" becomes
     unanswerable. If you keep alpha anyway, compute it against every surface underneath it
     and document the worst one.
   - Typography: `--font-display`, `--font-body` (full stacks with fallbacks);
     `--fw-*` permitted weights; type scale `--fs-display-xl … --fs-caption` with matching
     `--lh-*` line-heights.
   - Spacing: `--space-1 … --space-N` (state the base unit in a comment).
   - Radii: named steps from `--r-none` to `--r-full` (exact names and values per the
     ledger's radius scale; keep the named-steps idiom). On token *names*, `PARITY.md` wins —
     it fixes the prefixes (`--r-*`, `--fs-*`, `--space-*`); the ledger supplies the steps and
     the values, not the spelling.
   - Strokes: `--stroke-thin`, `--stroke-icon` (etc.).
   - Shadows: `--shadow-<level>` per elevation.
   - Focus: `--focus-ring` (color/width/offset pieces or a composed value — be consistent
     with how `<brand>.css` consumes it).
   - Motion: `--dur-*`, `--ease-*` — always present, even if the stance is "no decorative
     motion" (state changes still need one sanctioned duration). Include the
     `prefers-reduced-motion` override block here or in `<brand>.css`, per the ledger.
   - Breakpoints: the ledger's breakpoint values as custom properties (for reference/JS use)
     with a comment noting the literal px values to use in `@media` queries (custom
     properties don't work there).
   - Touch target: `--tap-min` (minimum interactive size from the ledger).
3. **Element defaults** — `html` (lang note in comment), `body` (bg, ink, body font/size/lh),
   headings (display face/weight, margins), `a`, `::selection`, `:focus-visible` using the
   focus tokens.

Rules: every value traces to a ledger decision; no magic numbers without a comment; this is
the **only** file allowed to contain raw hex values. If the dark-mode stance is
"prepared-for-later", structure semantic colors so a scheme can be added without renaming
tokens (brand primitives → semantic aliases; components consume only the aliases).
