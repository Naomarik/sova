# Astra · SOVA / TAVI

Four independently drawn, provisional explorations for Sova. No trademark, availability, or uniqueness claim; naming clearance is still required.

- `sova-vigil.svg` — cut-out eyes in a compact watchful silhouette.
- `sova-duet.svg` — paired open chambers; a softer, relational alternative (also reads as a split heart).
- `tavi-fork.svg` — a T with two stems and an open V counter; a subtle pi association.
- `tavi-channel.svg` — a T-shaped negative-space channel in an A-like body.

Each source has a 32×32 viewBox, transparent background, accessible name, and currentColor fill. Inline the mark to inherit a host color. Use at 16px or larger and preserve its square aspect ratio. Allow at least 8/32 of the mark width as external clear space.

## Comparison

Open `comparison.html` directly: embedded SVG geometry, embedded local Inter variable font, embedded design-system styles, no network or adjacent-file dependencies. Both themes, monochrome and indigo, and actual 16/24/32px previews appear together. Wordmarks use Inter 640 with −0.03em tracking. `comparison.png` is the visually reviewed 1280×1080 rendering.

## Validation and reproduction

- `python ai/branding/logos/astra/build.py` builds the masters and sheet; Python ElementTree parses all four SVGs as XML.
- Started a dedicated headless Chromium with the project's Playwright skill script. The CLI wrapper could not locate a project-local Playwright, so `render.mjs` used an already-installed npm-cache copy over that browser's isolated CDP port. No installation.
- `PW_PORT=<your isolated port> node ai/branding/logos/astra/render.mjs` captures the sheet and writes `validation.json`.
- Assertions: 1280px desktop and 390px mobile width, no horizontal overflow, distinct dark/light backgrounds, Inter loaded, 40 inline marks, zero external resource requests, zero browser page errors.
- Visually inspected the final PNG, including the small-size previews. The Duet center split and Channel counter remain open at 16px; Vigil is the most direct watchfulness direction.

`build.py` uses the repository's existing design skill and local Inter font (SIL OFL 1.1, per its documentation). `render.mjs` records the installed Playwright location used here; adjust that path if reproducing on another machine. No application integration or files outside this directory were changed.
