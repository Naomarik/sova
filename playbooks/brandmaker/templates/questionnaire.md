# Template — one-pass questionnaire (mode 2)

Deliver as a single message the user answers inline. Skip any item already in the ledger
from intake. Every question carries a recommended default in parentheses — unanswered items
fall back to the default, and say so up front. Keep it to ~20 questions; the user answers in
plain language, you translate to system values.

## A. Brand & voice
1. Brand name, and one sentence on what it does and for whom.
2. Language & locale for all product copy. (default: en-US)
3. Formal or informal address to the user? (recommend informal, with reason)
4. 3–5 adjectives for how the product should *feel*.
5. Canonical primary action of your product (e.g. "Create project", "Send order")?

## B. Color & type
6. Brand colors you already own (hex if known), or references/moods to derive from.
7. One thing color should *never* do in your product (or "you decide").
8. Font files you can supply (attach), fonts you already use, or "pick for me".
9. Display personality: closer to editorial-serif, geometric-sans, humanist-sans, or techy-mono?

## C. Marks
10. Logo SVGs you can supply (attach), or "generate a placeholder wordmark".
11. Any brand you'd point to and say "that, but for us"?

## D. Shape & product
12. Sharp, rounded, or pill-shaped? (I'll show, you can veto later.)
13. Data-dense ops tool or content-first surfaces?
14. Component inventory — default is buttons, chips, inputs, controls, toggles, cards,
    banners, nav-bars, overlays, lists, tables, charts (plus empty states, loading/skeleton,
    toasts, and pagination where the product implies them). Add/drop anything?
15. Dark mode: required now, later, or never? (default: later — tokens prepared)
16. The component your product lives or dies by, if any.
17. Anything I haven't asked that a designer must know?

## After answers arrive

Write every answer (and every applied default, flagged as such) to the ledger, present one
consolidated "here is the system I will build" summary — palette with hexes, faces, ratio,
shape stance, inventory — get a single confirmation, then run phases 04 → 05 → 06 without
further checkpoints.
