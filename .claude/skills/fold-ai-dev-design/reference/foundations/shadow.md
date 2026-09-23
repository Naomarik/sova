# Elevation

## Purpose

Three steps and a flat default, in neutral black only. The rule people get wrong: in dark, elevation is carried by surface lightness, not a heavier shadow — a black shadow on a near-black background is invisible.

Rendered: `site/foundations/shadow.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.card` | Resting elevation | `--shadow-1` |
| `.card-raised` | Raised card | `--shadow-2` |
| `.toast / .popover` | Floating surface | `--shadow-2` |
| `.modal` | Highest surface | `--shadow-3` |

## Tokens used

- `--shadow-1` — Resting card. Barely there by design.
- `--shadow-2` — Anything that floats above the page.
- `--shadow-3` — Modal only. If everything is elevated, nothing is.

## Scale & spec

| Token | Light | Dark | Used by |
|---|---|---|---|
| `--shadow-1` | `0 1px 2px rgba(23, 23, 28, .06)` | `0 1px 2px rgba(0, 0, 0, .5)` | Resting card |
| `--shadow-2` | `0 1px 2px rgba(23, 23, 28, .06), 0 8px 24px -12px rgba(23, 23, 28, .18)` | `0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px -12px rgba(0, 0, 0, .75)` | Popover, sheet, toast, raised card |
| `--shadow-3` | `0 2px 4px rgba(23, 23, 28, .08), 0 18px 44px -16px rgba(23, 23, 28, .26)` | `0 2px 4px rgba(0, 0, 0, .6), 0 18px 44px -16px rgba(0, 0, 0, .85)` | Modal only |

**Neutral black only** — no tinted or colored shadows. Every shadow is paired with a border, because shadows vanish on some displays and borders do not.

**In dark, elevation is surface lightness, not a heavier shadow.** The dark values are heavier only so they register at all; the step you see is paper → sunken → surface getting lighter.

## DO / DON'T

- **DO** Reserve `--shadow-3` for the modal — a single highest surface is what makes "highest" mean something.
- **DO** In dark, raise the surface color to signal elevation — that is the only mechanism that reads on near-black.
- **DO** Pair every shadow with a border — shadows vanish on some displays; borders do not.
- **DON'T** Tint a shadow with the accent — colored shadows are a documented never-rule.
- **DON'T** Stack a heavier shadow in dark to compensate — it will not appear; use surface lightness.
- **DON'T** Use elevation to indicate state — elevation is about layering, not about status.
