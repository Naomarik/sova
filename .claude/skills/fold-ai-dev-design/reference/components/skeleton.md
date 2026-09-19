# Skeleton

## Purpose

A placeholder shaped like the thing that's coming. If the skeleton doesn't match what lands, it's a lie the interface tells for half a second — and the layout shift that follows is the user's punishment for believing it.

Rendered: `site/components/skeleton.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.skeleton` | Base — sunken fill with a sweep | One of two sanctioned loops |
| `.skeleton-line` | 12px line | Vary the width |
| `.skeleton-title` | 18px, 40% width | Heading placeholder |
| `.skeleton-row` | 44px block | Full row placeholder |

## Tokens used

- `--color-sunken` — Base fill.
- `--ease-standard` — Sweep curve.
- `--r-sm` — 6px corner.

## Variants & states

### Loading card

```html
<div class="card"><div class="card-body">
  <div class="skeleton skeleton-title"></div>
  <div class="skeleton skeleton-line"></div>
  <div class="skeleton skeleton-line" style="width:78%"></div>
</div></div>
```

Every state is rendered together in the site page's state matrix. The `-hover`, `-focus`,
`-active` and `-disabled` helper classes are **documentation scaffolding only** — production
code uses the real pseudo-classes.

## DO / DON'T

- **DO** Match the skeleton to the real layout — no layout shift when the content lands.
- **DO** Vary line widths — uniform bars read as a progress bar, not as text.
- **DO** Use a count instead when you have one — "38 of 214" beats any animation.
- **DON'T** Show a skeleton for under ~300ms — a flash of placeholder is worse than a beat of nothing.
- **DON'T** Use a spinner as well — pick one loading language per surface.
- **DON'T** Skeleton a whole page — skeleton the region that is actually loading.
