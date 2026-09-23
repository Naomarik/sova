# Breadcrumb

## Purpose

Where you are, and the way back up. The last item is the current page and is never a link — a link that reloads the page you are on is a small betrayal of trust.

Rendered: `site/components/breadcrumb.html#anatomy`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.breadcrumb` | Wrapping trail | 12.5px muted |
| `.breadcrumb-sep` | Slash separator | Border-strong color |
| `.breadcrumb-current` | Current page | Not a link |

## Tokens used

- `--fs-caption` — 12.5px trail.
- `--color-ink-muted / --color-ink` — Ancestors vs current.

## Variants & states

### Breadcrumb

```html
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/projects">Projects</a><span class="breadcrumb-sep">/</span>
  <span class="breadcrumb-current" aria-current="page">run_8f21c4</span>
</nav>
```


## DO / DON'T

- **DO** Mark the last item `aria-current="page"` — it is the only item that is not navigation.
- **DO** Let it wrap at folded width — truncated ancestors defeat the purpose.
- **DO** Use the run ID as the leaf — it is the thing the user can copy.
- **DON'T** Link the current page — it does nothing and looks broken.
- **DON'T** Replace the trail with a back button — back is history, breadcrumbs are hierarchy.
- **DON'T** Show more than three levels at folded width — collapse the middle instead.
