# Iconography

## Purpose

37 line icons on a 24px grid, shipped as local files. They inherit color from context via `currentColor`, which is what lets one file serve both themes and every surface it lands on.

Rendered: `site/brand/iconography.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `—` | Icons are files, not classes | Inline the SVG so `currentColor` works |

## Tokens used

- `--stroke-icon` — 1.5px — the icon stroke, in both themes.

## DO / DON'T

- **DO** Inline the SVG so it inherits color — an `<img>` cannot follow `currentColor` or the theme.
- **DO** Copy the nearest icon when adding one — the set stays coherent only if the geometry matches.
- **DO** Ship every icon you document — a documented file that is not on disk is a broken system.
- **DON'T** Thin the stroke in dark to compensate for glow — it makes icons vanish on a phone outdoors.
- **DON'T** Point a consumer at an external icon library — a network dependency is not a shipped system.
- **DON'T** Draw off the pixel grid — a half-pixel stroke renders soft at 24px and muddy at 16.
