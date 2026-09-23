# Phase 01 — Discovery (identity, audience, voice)

Goal: everything needed for `SKILL.md`'s Voice section. Ask only what the ledger doesn't
already answer. 3–5 questions max per round, with recommended defaults.

**What you learn here shapes the system; most of it never ships as prose.** The product
description, the audience and the taglines are *inputs* — they tell you whether the voice is
calm or energetic, whether the surfaces are dense or airy, which components the inventory
needs. They stay in the ledger. `SKILL.md` gets the voice rules they produced, not the
paragraph they came in.

## Must be decided by end of phase

1. **Brand basics** — name; one-paragraph "what the brand is" (product, audience, what makes
   it humane/distinct). **Ledger only.** You need it to derive everything below; it is not
   an artifact.
2. **Language & locale** — e.g. `en-US`, `fr-FR`, `pt-BR`. Drives the grammar-rules table:
   formality register (T–V distinction where the language has one), first-person voice, CTA
   casing, number/currency/date formats, locale-specific typography rules (punctuation
   conventions, diacritics in caps, etc.). You author the
   table; confirm only formality and currency format with the user.
3. **Voice pillars** — exactly 3–5 named pillars, each with "means" + "in practice"
   (e.g. Approachable · Professional · Concrete · Warm). Offer a proposed set derived
   from the user's adjectives; let them edit.
4. **Microcopy seeds** — canonical CTA verbs (primary, secondary, destructive, cancel) in the
   brand's language. Draft them yourself from the product description; confirm in one question.

## Good question shapes

- "Who's the person using this at 9am on a Tuesday — and what do they call the product?"
- "Pick the 3–4 words your best customer would use to describe how the product *feels*."
- "Formal or informal address? (I recommend informal for X because…)"

## Checkpoint (mode 1 only)

Render a single self-contained HTML page: brand name set large, the pillars as a table, the
voice shown in situ (an empty state, an error, a confirmation), and sample microcopy buttons —
using neutral gray styling (identity isn't chosen yet). Get sign-off on the *words* before
touching visuals.

**Checkpoint pages are working artifacts.** Write them outside `<brand>-skill/`, or delete
them at handoff. A checkpoint left in the skill directory is read as reference by the next
person to open it, and it was never true past the phase that produced it.
