# Phase 03 — Shape & components

Goal: everything for `SKILL.md`'s Shape & space, Responsive and Components sections, and the
component inventory that drives `<brand>.css`, `reference/components/`, and `site/`.

## Must be decided by end of phase

1. **Radii scale** — named steps `none → full` with px values and per-element assignments
   (inputs, buttons, chips, cards, pills). You derive this from the identity's shape feel;
   show it, don't ask for numbers.
2. **Strokes** — divider weight, icon/active-outline weight (typically two values, e.g.
   a thin divider and a slightly heavier icon/outline stroke).
3. **Spacing scale** — a numbered scale (`--space-1 … --space-N`, base unit stated) and the
   density stance (compact ops tool vs airy marketing).
4. **Shadow scale** — 2–4 named elevations; color/tint rule consistent with the palette rules
   (e.g. no tinted shadows if that was a "never").
5. **Grid & composition** — page max-width, column model, breakpoints, and 2–3 canonical
   layout patterns (app shell, marketing hero, form page).
6. **Focus & motion** — focus-ring spec (color, width, offset); motion as a real foundation,
   not an afterthought: duration + easing tokens, what animates (interactive state changes)
   vs what never does (decorative), and a `prefers-reduced-motion` rule. "No decorative
   motion" is a fine stance — but it must be written down, or every consumer invents their
   own transitions.
7. **Responsive** — breakpoint tokens, per-component collapse behavior (how nav-bars, cards,
   lists, and tables degrade at each breakpoint), and a touch-target minimum. One sentence
   about a grid is not a responsive story; if the product is used on phones, this foundation
   carries real weight.
8. **Dark mode stance** — required now, prepared-for-later (semantic tokens structured so a
   scheme can be added), or never. Any answer is valid; the ledger must record one, and
   `SKILL.md` must state it.
9. **Component inventory** — default inventory: buttons, chips, inputs, controls,
   toggles, cards, banners, nav-bars, overlays, menus (popover), lists, tables, charts. Ask one question:
   "here's my proposed inventory — anything your product needs added or dropped?" (min 8).
   Then probe the domain yourself: a data-heavy product likely needs tables front and
   center; most products need empty states, loading/skeleton patterns, toasts (distinct
   from in-flow banners), and pagination — propose the ones the product description clearly
   implies rather than waiting to be asked. For each component you (not the user) define
   variants, sizes, and the full state set (default/hover/focus/active/disabled), plus the
   one-line usage rule ("one primary per view", etc.). Write the usage rule in the words a
   builder searches with, naming the task, not just the component: menus (popover) is "every
   menu, dropdown, ⋯ overflow and picker", so a grep for any of those lands on it.

   **Menus (popover)** is its own inventory line, not part of overlays: it is the one row
   component every menu, dropdown, ⋯ overflow and flyout uses. Define a one-line row
   (a verb or a value, centered on the row's center line), a label + description variant (a
   mode, a profile, a row that says why it can't run, with its icon on the first line), a
   checked state with a check slot (`menuitemradio` / `menuitemcheckbox` + `aria-checked`),
   disabled with its reason shown, an icon slot, a section label and a separator. Use it when
   something opens from a trigger and closes on a pick; use a select or combobox when the user
   types to filter. Every row-like component (a list row, a menu row, an option) gets the same
   set: one-line, label + description, checked or selected, disabled with a reason, icon slot.

## User questions worth asking (pick ≤4)

- Sharp vs rounded vs pill — shown as three rendered button/card strips to pick from.
- Dense-data product or content-first product?
- Any component your product lives and dies by (tables? charts? wizard flows?)?
- Dark mode: required, later, or never? (Affects token structure now even if shipped later;
  the answer is recorded either way — no silent default.)

## Checkpoint (mode 1 only)

One self-contained HTML page: radius/spacing/shadow ramps rendered, plus one real component
(buttons — all variants × states grid) fully styled with the identity from phase 02. Sign-off
here locks the system; phases 04–06 are production, not design.
