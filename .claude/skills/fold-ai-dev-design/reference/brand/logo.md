# Logo

## Purpose

Two panels hinged at a center crease — the device seen from above. One color plus one opacity, which is what lets it survive a favicon and a 16px sidebar. It ships as a swappable placeholder: replace four files and nothing else in the system changes.

Rendered: `site/brand/logo.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `—` | The mark is an SVG file, not a CSS class | Inline it or `<img>` it from `assets/logos/` |

## Tokens used

- `--color-accent` — Default colorway in product chrome.
- `--color-ink` — Monochrome documents and print.
- `--color-on-accent` — The inverse colorway, on an indigo field.

## DO / DON'T

- **DO** Use the `currentColor` source and let context color it — one file, every colorway.
- **DO** Keep one panel-width of clear space — the mark stops reading when text crowds the crease.
- **DO** Replace it when a real mark exists — it is explicitly a placeholder.
- **DON'T** Rotate, stretch, or gradient it — all three destroy the one idea the mark carries.
- **DON'T** Re-set the wordmark in another face — it is Inter 640 at -0.03em, or it is not the wordmark.
- **DON'T** Treat it as a registered trademark — it is generated, unregistered, and yours to discard.
