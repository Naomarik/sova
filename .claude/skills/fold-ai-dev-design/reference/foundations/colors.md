# Color

## Purpose

One saturated color, spent carefully. Fold Indigo marks the primary action and the live run; everything else is ink, paper, and four status hues. The rule that matters: full-strength indigo is 5% of any composition — spend it on decoration and "this needs you" stops meaning anything.

Rendered: `site/foundations/colors.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.chip-success|warn|error|info|accent` | Status color on a chip | Sets `color`; the dot inherits it |
| `.banner-success|warn|error|info` | Soft status background | Uses `--status-*-bg` |
| `.text-accent|success|warn|error` | Status color on text | Never the only signal |

## Tokens used

- `--color-accent` — The one saturated color. Primary action, live run, and text selection.
- `--color-accent-tint` — Selected rows and active nav. 10% of a composition.
- `--color-ink / -2 / -muted` — Three text weights. Muted is a discrete token, not an alpha.
- `--color-bg / -surface / -sunken` — Page, raised, recessed.
- `--color-border / -border-strong` — Dividers vs control boundaries. Only the latter meets 3:1.
- `--status-*` — Four hues, per theme. Always paired with a word.

## DO / DON'T

- **DO** Spend indigo on the one decision the user came to make — the accent is the product's only way to say "here".
- **DO** Pair every status hue with a word and a dot — 1 in 12 men can't separate red from green, and nobody can in sunlight.
- **DO** Use `--color-border-strong` for anything a user can click — it is the only border value that meets the 3:1 UI threshold.
- **DON'T** Tint a shadow with the accent — use `--shadow-1..3`, which are neutral black by policy.
- **DON'T** Express muted text as `rgba(ink, .65)` — use `--color-ink-muted`, which is measured against every documented surface.
- **DON'T** Invert the light palette to make dark — the accent lifts and elevation changes mechanism — see the dark column above.
