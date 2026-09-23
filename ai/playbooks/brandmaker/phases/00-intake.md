# Phase 00 — Intake (only when the user supplied context)

Goal: mine everything the user gave you so later phases skip already-answered questions.

## Ingest

Accept anything: brand name, elevator pitch, screenshots, logo files, existing sites/URLs,
style guides, CSS files, font files, mood boards, competitor references, "make it feel like X".

- Images: view them (respect any repo image-size rules) and extract palette, type feel,
  shape language, density.
- URLs: fetch and read; extract palette from CSS, fonts from `@font-face`/font-family,
  voice from copy.
- Files (CSS/tokens/guides): parse directly — these are the highest-authority source.
- Font/logo files supplied now: stage them immediately into `<brand>-skill/fonts/` and
  `<brand>-skill/assets/logos/` and record them in the ledger.

## Extraction checklist → ledger

For each item below, if the context answers it, write a ledger entry with source
`mined-from-context`; note ambiguity rather than guessing silently.

- Brand name, what the company does, audience, market/locale, language. **Ledger only** —
  this is what you design *from*, never what the skill ships as prose.
- Voice adjectives / personality.
- Colors (exact hex if available; otherwise described) and any evident usage hierarchy.
- Typefaces (display vs body), weights in use.
- Logo variants and colorways present.
- Shape language: radii, borders, shadows, density.
- Iconography style.
- Existing component patterns worth preserving.

## Exit

Summarize to the user in a short paragraph: "Here's what I learned from what you gave me,
and here's what's still open." Then enter the mode they chose, asking **only** the open
questions.
