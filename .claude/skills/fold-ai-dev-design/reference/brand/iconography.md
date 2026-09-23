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

## Scale & spec

| Property | Value | Measured on disk |
|---|---|---|
| Count | 37 files | `assets/icons/functional/*.svg` |
| Grid | `viewBox="0 0 24 24"` | 37 of 37 |
| Stroke | `stroke-width="1.5"` — the same in both themes | 37 of 37 |
| Caps | `stroke-linecap="round"` | 37 of 37 |
| Joins | `stroke-linejoin="round"` | 37 of 37 |
| Fill | `fill="none"` | 37 of 37 |
| Color | `stroke="currentColor"` | 37 of 37 |

**Inline the SVG** so `currentColor` and the theme reach it; an `<img>` cannot follow either.

**Adding one:** copy the nearest file, keep the 24 viewBox, the 1.5 stroke and `currentColor`, draw on whole or half pixels, and ship it here. The last column is computed from the files, so an icon that breaks the spec shows up on this page.

**Provenance is unrecorded.** Nothing in the skill or its history says who drew the set or under what terms; treat the license as unknown until the owner confirms it.

## DO / DON'T

- **DO** Inline the SVG so it inherits color — an `<img>` cannot follow `currentColor` or the theme.
- **DO** Copy the nearest icon when adding one — the set stays coherent only if the geometry matches.
- **DO** Ship every icon you document — a documented file that is not on disk is a broken system.
- **DON'T** Thin the stroke in dark to compensate for glow — it makes icons vanish on a phone outdoors.
- **DON'T** Point a consumer at an external icon library — a network dependency is not a shipped system.
- **DON'T** Draw off the pixel grid — a half-pixel stroke renders soft at 24px and muddy at 16.
