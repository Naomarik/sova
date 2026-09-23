# App bar

## Purpose

Brand, context, and status — nothing else. Actions that belong to the content belong in the content; an app bar that collects them becomes a junk drawer the user has to search.

Rendered: `site/components/appbar.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.appbar` | 56px bar with bottom border | `--color-bg` |
| `.appbar-brand` | Symbol + wordmark link | Accent symbol, ink word |
| `.appbar-title` | Current context | 16px semibold |
| `.appbar-spacer` | Flexible gap | Pushes status right |

## Tokens used

- `--color-bg / --color-border` — Bar fill and its edge.
- `--color-accent` — The symbol only — not the wordmark.

## Variants & states

### App bar

```html
<div class="appbar">
  <a class="appbar-brand" href="/">…Fold</a>
  <span class="appbar-title">Attention</span>
  <span class="appbar-spacer"></span>
  <span class="chip chip-accent"><i class="chip-dot"></i>4 running</span>
</div>
```


## DO / DON'T

- **DO** Keep it to brand, context, and one status — it is a location indicator, not a toolbar.
- **DO** Show the live count here — it is the one number worth carrying on every screen.
- **DO** Keep the bar background at `--color-bg` — a raised bar competes with the content it frames.
- **DON'T** Collect content actions in the bar — they belong beside what they act on.
- **DON'T** Make the whole bar sticky at folded width — vertical space is the scarcest thing on a phone.
- **DON'T** Color the wordmark — only the symbol takes the accent.
