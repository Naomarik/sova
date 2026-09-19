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
| `.page` | Centred page box | `--page-max` + `--space-4` gutter |

## Tokens used

- `--space-1…9` — 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96.
- `--row-height` — 44px. The list row and the tap target are the same number.
- `--page-max` — 1280px page ceiling.

## DO / DON'T

- **DO** Keep product surfaces in space-2 to space-5 — density is what lets a folded screen show more than four items.
- **DO** Grow padding, not type, to reach 44px — bigger targets, same information.
- **DO** Use the stack/cluster helpers instead of ad-hoc margins — margins collapse and fight each other; gaps don't.
- **DON'T** Use space-7+ on a dense surface — it belongs where there is one idea per screen, such as an empty state.
- **DON'T** Inflate row heights on touch devices — the target is already 44px; taller rows just show less.
- **DON'T** Invent a value between steps — a 10px gap is a decision nobody can repeat.
