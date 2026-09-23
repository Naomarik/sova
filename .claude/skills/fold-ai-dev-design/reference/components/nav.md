# Rail & bottom bar

## Purpose

One navigation, two placements: a bottom bar under 768px where the thumb is, a side rail above it. Never both at once — two navs in one view means neither is the answer to "where am I?"

Rendered: `site/components/nav.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.bottombar` | Full-width bar, 56px items | Under 768 only |
| `.rail` | Vertical column | 768 and up |
| `.navitem` | 44px minimum target | Shared by both |
| `.navitem-active` | Tinted current item | Pair with `aria-current="page"` |
| `.navitem-label` | The label, truncating | Wrap every label. Truncates with an ellipsis rather than eating the item padding |

## Tokens used

- `--tap-min` — 44px per item.
- `--color-accent-tint / --color-accent` — Active fill and label.
- `--bp-unfolded` — 768px — where the nav moves, from bottom bar to side rail.

## Variants & states

### Bottom bar

```html
<nav class="bottombar">
  <a class="navitem navitem-active" href="/queue" aria-current="page"><span class="navitem-label">Queue</span></a>
  <a class="navitem" href="/runs"><span class="navitem-label">Runs</span></a>
</nav>
```


## DO / DON'T

- **DO** Put the nav at the bottom under 768px — that is where a one-handed thumb reaches.
- **DO** Set `aria-current="page"` as well as the class — the tint is not announced.
- **DO** Size the nav by its longest label, not by a count — at 475px five items leave 71px for a label and six leave 55px; `Worktrees` measures 54.6, so six fit and a longer word does not.
- **DO** Wrap every label in `.navitem-label` — it truncates a label that will not fit; bare text in a `.navitem` spends the item padding instead and closes the gap to its neighbor.
- **DON'T** Show a rail and a bottom bar together — the user cannot tell which one is authoritative.
- **DON'T** Hide labels and ship icons alone — an unlabeled icon is a guess.
- **DON'T** Put a destructive action in the nav — navigation moves you; it should not change anything.
