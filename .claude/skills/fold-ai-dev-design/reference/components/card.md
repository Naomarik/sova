# Card

## Purpose

A bounded surface with an optional head and foot. Cards get one radius step more than their contents so nesting reads as nesting, and an interactive card needs a focus ring — not just a hover, which half your users never see.

Rendered: `site/components/card.html#variants`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.card` | Base — 12px radius, border, `--shadow-1` | Clips its contents |
| `.card-head` | Sunken header strip | Title and status |
| `.card-title` | 16px semibold | Inside the head |
| `.card-body` | 16px padding | Content |
| `.card-foot` | Action row | Top border |
| `.card-raised` | `--shadow-2` | Floating context |
| `.card-interactive` | Hover + focus affordance | Needs `tabindex` or a link |

## Tokens used

- `--r-lg` — 12px — one step above its contents.
- `--color-surface / --color-sunken` — Body and head.
- `--shadow-1 / -2` — Resting and raised.

## Variants & states

### Card with head and foot

```html
<div class="card">
  <div class="card-head"><h4 class="card-title">Run 8f21c4</h4></div>
  <div class="card-body">Changed 7 files in src/api. Nothing merged yet.</div>
  <div class="card-foot"><button class="button button-sm button-primary">Approve</button></div>
</div>
```


## DO / DON'T

- **DO** Give an interactive card a focus style — keyboard users get no hover.
- **DO** Keep the head for context, the foot for actions — a card whose actions float in the body is hard to scan.
- **DO** Use `.card-raised` only when the card floats — elevation should mean layering.
- **DON'T** Nest a card inside a card — use a list or a bordered block instead.
- **DON'T** Put the primary page action in a card foot — it belongs in the approval bar.
- **DON'T** Add a shadow and no border — shadows disappear on some displays.
