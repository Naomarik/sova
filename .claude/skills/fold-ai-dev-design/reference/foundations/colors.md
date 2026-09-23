# Color

## Purpose

One saturated color, spent carefully. Fold Indigo marks the primary action and the live run; everything else is ink, paper, and four status hues. The rule that matters: full-strength indigo is 5% of any composition — spend it on decoration and "this needs you" stops meaning anything.

Rendered: `site/foundations/colors.html#spec`

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

## Scale & spec

| Token | Role | Light | Dark | Lowest contrast, light · dark |
|---|---|---|---|---|
| `--color-accent` | Primary action, live run, links, focus ring | `#4A43D8` | `#8E88FF` | 5.63 on sunken · 4.67 on surface |
| `--color-accent-hover` | Hovered and pressed accent | `#3A34B4` | `#A6A1FF` | — |
| `--color-accent-tint` | Selected rows, active nav, user bubbles | `#E8E6FA` | `#2B2650` | — |
| `--color-on-accent` | Text on a filled accent | `#FFFFFF` | `#1E1E26` | — |
| `--color-ink` | Body text, headings | `#17171C` | `#F2F2F6` | 14.78 on sunken · 12.34 on surface |
| `--color-ink-2` | Secondary prose | `#4A4A57` | `#B8B8C6` | 7.22 on sunken · 7.03 on surface |
| `--color-ink-muted` | Metadata, captions, placeholders | `#656572` | `#9A9AA8` | 4.75 on sunken · 4.96 on surface |
| `--color-bg` | Page (paper) | `#F2F2F7` | `#1E1E26` | — |
| `--color-surface` | Cards, sheets, raised things | `#FFFFFF` | `#2C2C38` | — |
| `--color-sunken` | Headers, gutters, hover fills | `#E9E9F0` | `#26262F` | — |
| `--color-border` | Dividers — decorative, never the only signal | `#E3E3E9` | `#3B3B49` | — |
| `--color-border-strong` | Control borders | `#86868F` | `#7E7E93` | 2.99 on sunken · 3.47 on surface |
| `--status-success` | Success text, dot, and border | `#15704A` | `#4FC98D` | 5.04 on sunken · 6.61 on surface |
| `--status-success-bg` | Soft success fill for banners and chips — never text | `#E7F4ED` | `#1B4936` | — |
| `--status-warn` | Warn text, dot, and border | `#8A5A00` | `#E3A63A` | 4.90 on sunken · 6.42 on surface |
| `--status-warn-bg` | Soft warn fill for banners and chips — never text | `#FBF1DE` | `#45351C` | — |
| `--status-error` | Error text, dot, and border | `#B8302B` | `#FF7A70` | 4.97 on sunken · 5.42 on surface |
| `--status-error-bg` | Soft error fill for banners and chips — never text | `#FBEAE9` | `#4E2823` | — |
| `--status-info` | Info text, dot, and border | `#2A5FA8` | `#78ADF2` | 5.27 on sunken · 5.94 on surface |
| `--status-info-bg` | Soft info fill for banners and chips — never text | `#E9F0FA` | `#1F3555` | — |

**Contrast is measured against paper, surface and sunken, and the column shows the lowest of the three.** Text needs 4.5 and UI boundaries 3.0 (WCAG 2.x). Every text token clears 4.5 on every ground in both themes; the tightest text pair is `--color-accent` on surface in dark.

**One boundary reads under 3.0:** `--color-border-strong` against light sunken, 2.99. A control that sits on a sunken fill (a filter bar) carries its own surface fill, and its border against that fill is 3.61 — so the border never has to separate a control from sunken on its own.

**Muted text is a discrete token, never an alpha of ink.** An alpha has a different ratio on every surface it lands on, so it cannot be measured; a token can.

**A status hue on its own soft fill is measured too** — the lowest of the eight is `--status-success` on its soft fill, dark, 4.91. The fills are for banners and chips only, never text of another color.

## DO / DON'T

- **DO** Spend indigo on the one decision the user came to make — the accent is the product's only way to say "here".
- **DO** Pair every status hue with a word and a dot — 1 in 12 men can't separate red from green, and nobody can in sunlight.
- **DO** Use `--color-border-strong` for anything a user can click — it is the only border value that meets the 3:1 UI threshold.
- **DON'T** Tint a shadow with the accent — use `--shadow-1..3`, which are neutral black by policy.
- **DON'T** Express muted text as `rgba(ink, .65)` — use `--color-ink-muted`, which is measured against every documented surface.
- **DON'T** Invert the light palette to make dark — the accent lifts and elevation changes mechanism — see the dark column above.
