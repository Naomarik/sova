# Phase 02 — Identity (color, type, marks, icons)

Goal: everything for `SKILL.md`'s Color, Type, Icons and Marks sections — and the assets
themselves.

**Read `PARITY.md` before you start.** It is the phase 06 checklist, but it fixes inputs this
phase spends real work on: the minimum logo colorways, the icon-count floor, the exact
foundation and brand file sets, and `SKILL.md`'s heading order. Assets are *built* here, so
meeting those numbers for the first time at the final audit means redrawing, not auditing.

## Must be decided by end of phase

1. **Color system** — 3–6 named brand colors (typically a hero accent, a near-black ink, a
   mid gray, an off-white surface). You propose
   exact hex values from the user's direction; every color gets a human name. Then define:
   - **Usage ratio** across any composition (e.g. 60/25/10/5, dominant → accent). You set
     it; show it.
   - Muted-text formula (e.g. primary-ink at 65% alpha).
   - Status colors (success/warn/error/info) harmonized with the palette, plus the rule that
     status is never conveyed by hue alone.
   - "Never" rules (gradients? glassmorphism? tinted shadows?) — propose, confirm.
2. **Typography** — display face + body face, exact weights permitted per face (e.g. a
   single weight only for display; a 300–900 range for body). Ask the user for font files.
   Fallback: pick open-licensed faces matching the feel, download real files into `fonts/`,
   and mark as swappable placeholders. Define the full type scale (`display-xl … caption`)
   yourself.
3. **Logos** — ask for SVGs. Determine variants (symbol/monogram, logotype, wordmark) and
   colorways (min: primary, dark, light). If none supplied: generate a clean typographic
   wordmark SVG in the display face (text converted to paths or documented as font-dependent),
   in each colorway, and mark as placeholder. Define clear-space and misuse rules.
4. **Iconography** — **one** system: a functional line-icon set for product UI (stroke weight,
   caps, `currentColor`, sizing grid — you spec it). **Ship it locally**: a curated subset
   (~24–40 SVGs covering nav, interface, forms, status, and the product's domain) into
   `assets/icons/functional/` — naming a library the consumer must go fetch is a network
   dependency, not a shipped system.

   **Do not draw a second, "expressive" set for marketing surfaces.** It is used on no screen
   the skill documents, so nothing checks it, nothing renders it beside the set it must never
   be mixed with, and the "never mix the two systems" rule guards a collision that cannot
   happen. If the brand genuinely needs marketing marks, that is a separate deliverable with
   its own surfaces — not a folder in the design system.
5. **Licensing** — record the license of every font and icon set in the ledger (ask when the
   user supplies files; note the terms yourself for open-licensed fallbacks). Non-open assets
   get a redistribution warning that phase 04 surfaces in `SKILL.md`.
6. **Accessibility check, now not later** — compute WCAG contrast for the proposed palette's
   key pairings (body text, muted text, primary-button label, accent-as-text) while the
   palette is still cheap to adjust. If a pairing fails AA, either tune the value (e.g. a
   darker ink-variant of the accent for text/fill contexts) or record an explicit exception
   with rationale in the ledger. Do not let a failing pairing ship undocumented.

## Question discipline

The user answers in *feelings and references* ("warmer", "like Stripe but friendlier",
"our blue is #1B4FD8"). You answer in *systems*. Never ask "what radius do you want" —
that's phase 03's job for you, not them.

## Checkpoint (mode 1 only)

One self-contained HTML page: palette swatches with names + ratio bar, the type scale
rendered in the real fonts, logos on light/dark, the functional icon set, and a mini mock
(header + card + a decision) that combines everything. Iterate here until sign-off — this is
the highest-leverage checkpoint of the run. Write it outside `<brand>-skill/`, or delete it
at handoff.
