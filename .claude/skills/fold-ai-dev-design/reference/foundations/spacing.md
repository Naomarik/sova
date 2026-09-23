# Spacing

## Purpose

A 4px base and nine steps. This is a compact ops tool: surfaces live in space-2 through space-5, and space-7 upward appears only where there is one idea on the screen. You're scanning a queue, not reading an article.

Rendered: `site/foundations/spacing.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.stack` | Vertical rhythm at `--space-4` | Default column gap |
| `.stack-2 / .stack-5` | Tighter / looser column | 8px / 24px |
| `.cluster` | Horizontal wrap at `--space-2` | Buttons, chips |
| `.spread` | Space-between row | Title + action |
| `.page` | Centered page box | `--page-max` + `--space-4` gutter |

## Tokens used

- `--space-1…9` — 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96.
- `--row-height` — 44px. The list row and the tap target are the same number.
- `--page-max` — 1280px page ceiling.

## Scale & spec

| Token | Value | Band |
|---|---|---|
| `--space-1` | `4px` | Inside a control: icon to label, chip padding |
| `--space-2` | `8px` | Product surfaces — gaps, padding, rows |
| `--space-3` | `12px` | Product surfaces — gaps, padding, rows |
| `--space-4` | `16px` | Product surfaces — gaps, padding, rows |
| `--space-5` | `24px` | Product surfaces — gaps, padding, rows |
| `--space-6` | `32px` | Section breaks (`hr` margin) |
| `--space-7` | `48px` | One idea on the screen only — an empty state |
| `--space-8` | `64px` | One idea on the screen only — an empty state |
| `--space-9` | `96px` | One idea on the screen only — an empty state |
| `--row-height` | `44px` | List row — the same number as the tap target |
| `--control-sm / -md / -lg` | `36px` · `44px` · `52px` | Control heights |
| `--page-max` | `1280px` | Page ceiling |

**4px base.** Surfaces live in `space-2` to `space-5`; that density is what lets a folded screen show more than four items. A list row reaches 44px through 12px padding — the target grew, the type did not.

**No value between steps.** A 10px gap is a decision nobody can repeat; pick the nearer step.

## DO / DON'T

- **DO** Keep product surfaces in space-2 to space-5 — density is what lets a folded screen show more than four items.
- **DO** Grow padding, not type, to reach 44px — bigger targets, same information.
- **DO** Use the stack/cluster helpers instead of ad-hoc margins — margins collapse and fight each other; gaps don't.
- **DON'T** Use space-7+ on a dense surface — it belongs where there is one idea per screen, such as an empty state.
- **DON'T** Inflate row heights on touch devices — the target is already 44px; taller rows just show less.
- **DON'T** Invent a value between steps — a 10px gap is a decision nobody can repeat.
