---
name: fold-ai-dev-design
description: Use when designing, implementing, modifying, or reviewing this project's
  interfaces, components, prototypes, product copy, design-system code, or visual assets.
  Provides visual, voice, accessibility, and implementation guidance.
user-invocable: true
---

**Version.** 1.8.0 · **Locale.** en-US

This file is the design system: how a surface looks, reads and behaves. It says nothing about
what the product does — `spec/` owns that, and duplicating it here is how the two
drift apart.

**Precedence.** For how a component is built — its classes, variants, states — the file in
`reference/components/` wins. For anything that crosses components, this file wins. When they
disagree one of them is stale; fix it.

If invoked without other guidance, ask what to build, ask a handful of focused questions, and
act as an expert designer producing HTML artifacts or production code.

## How to use

Link two stylesheets, in this order:

```html
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="fold-ai-dev.css">
```

`tokens.css` must come first — `fold-ai-dev.css` consumes its custom properties and renders
unstyled without it. Both are plain CSS: no build step, no network requests, fonts resolve from
`fonts/` relative to `tokens.css`.

**Theme.** Nothing to do for system-following. To force one: `<html data-theme="dark">` or
`<html data-theme="light">`.

**Look before you build.** `site/index.html` links all 34 pages — 7 foundations, 2 brand topics,
25 components — rendered in both themes. A screenshot answers questions a table can't. Then load
`reference/<category>/<page>.md` for the section you're actually rendering.

## Layout

```
fold-ai-dev-design/
├── SKILL.md                    # this file — the whole system in prose
├── tokens.css                  # every decision as a custom property + @font-face
├── fold-ai-dev.css             # 25 components + utilities; loads after tokens
├── fonts/                      # Inter + JetBrains Mono, variable, latin, SIL OFL 1.1
├── assets/
│   ├── logos/                  # symbol in 3 colorways + a currentColor source
│   └── icons/functional/       # 37 line icons, shipped locally — never a library reference
├── reference/
│   ├── foundations/            # colors typography spacing radius shadow grid-composition motion
│   ├── brand/                  # logo iconography
│   └── components/             # one file per component in the inventory
├── site/                       # rendered reference site — open site/index.html
│   └── docs.css                # site chrome only; never merged into fold-ai-dev.css
└── .build/                     # generates reference/ and site/ from one content model
```

| Entry | Purpose |
|---|---|
| `tokens.css` | The system's only source of raw values. Load first. |
| `fold-ai-dev.css` | Components and utilities. Consumes tokens; loads second. |
| `fonts/` | Real font files. The system works offline; nothing is fetched. |
| `assets/` | Logos and icons, as files you can copy. |
| `reference/` | Per-topic detail. Component files are authoritative for implementation. |
| `site/` | The same system, rendered, in both themes. |
| `.build/` | `node .build/build.mjs` regenerates `reference/**.md` and `site/**.html` from `.build/content.mjs` + `.build/components.mjs`. **Edit the model, not the output.** |

## Voice

Four pillars. They are **not modes** — every message is all four at once. A calm message that
says nothing concrete has failed; so has a concrete one that reads like a stack trace.

| Pillar | Means | In practice |
|---|---|---|
| **Calm** | The interface never raises its voice. | "3 runs waiting on you." Not "⚠️ 3 RUNS BLOCKED!" |
| **Concrete** | Name the thing, the count, the file. | "Changed 7 files in `src/api`." Not "Made some updates." |
| **Warm** | Talks like a person who's on your side. | "We'll put anything that wants a decision right here." Not "No pending items." |
| **Candid** | States the rule and the failure it prevents. Bad news arrives straight. | "This run failed at step 4 and stopped. Nothing was merged." |

**Calm carries the surfaces; warm carries the words.** The UI stays quiet and low-chroma; the
copy sounds human. Warmth never arrives as bright color on a status surface — a failure is
stated plainly, never softened.

### Grammar · en-US

| Rule | What it means | Example |
|---|---|---|
| Address | Second person, informal. Contractions welcome. | "You're reviewing 7 files." |
| First person | "We" for the product acting. Never "I". Workers are named or "it". | "We'll surface it here." |
| CTA casing | **Title Case** on buttons. Sentence case everywhere else. | `Review Changes` / "Nothing to decide yet." |
| Verb + object | A CTA names its object when the object isn't obvious. | `Discard Run`, not `Discard`. |
| Numerals | Digits always, including 1–9. | "3 runs", never "three runs". |
| Dates & time | Relative under 7 days, then `Mar 4`. 24-hour clock in logs. | "2h ago" · "yesterday" · `14:06` |
| Currency | Symbol first, comma thousands, period decimal. | `$1,240.00` |
| Punctuation | Serial comma. Em dash unspaced. **No exclamation marks in product UI.** | "Read, changed, and stopped." |
| Errors | What happened · what it means for your work · what to do. | "Failed at step 4. Nothing was merged. Retry or discard." |
| Apology | None. Don't apologize for machine behavior; explain it. | Not "Sorry, something went wrong." |

### Microcopy patterns

| Context | Pattern | Notes |
|---|---|---|
| Primary CTA | `Approve` | One per view. The decision the user came to make. |
| Secondary CTA | `Review Changes` | Neutral. Never competes visually with primary. |
| Destructive CTA | `Discard Run` | Names its object. Outlined, never filled. |
| Cancel | `Cancel` | Ghost. Never "Nevermind", never "Go Back". |
| Empty state | Live fact, then the absence. | "4 runs working. Nothing to decide yet." **Never** "Nothing needs you right now" — an absence alone is not information. |
| Confirmation | What goes away, then what doesn't. | "The worker's 7 changed files go away. Nothing was merged, so nothing else changes." |
| Timestamp | Relative, then absolute in mono. | "2h ago" in lists; `14:06` in logs. |
| Error | Three beats, no blame. | "Failed at step 4 and stopped. Nothing was merged. Retry or discard." |
| Success | State the fact; don't celebrate. | "Merged to main." Not "Nice work! 🎉" |
| Loading | Say what's happening, with a count when you have one. | "Running tests · 38 of 214" |

### Copy length

A screen is transparent and uncluttered. Say what the user needs to know, in the smallest
form that carries it. Work down this ladder and stop at the first row that fits.

| Where a fact goes | When | Limit | Example |
|---|---|---|---|
| A value, chip, or column | The fact belongs to one item. | A word or a figure. | The node in a `Node` column. `Not reported` in a memory slot. |
| A control's reason | The fact is why a control is disabled, refused, or does something non-obvious. | One line, on hover, press, or the disabled state. | Disabled `Archive`, reason "Turn active". |
| A tooltip | A term or figure worth defining once. Never the only place a fact lives. | One sentence. | `Free memory` with "Inside this machine's share, latest reading." |
| One sentence on the page | The fact is about the whole list or screen and no row or control can carry it. | One sentence under a title. Empty and error states may take two, per the patterns above. | "Sorted by free memory, most first." |
| A short paragraph | A form or a destructive act, where the user is choosing. | Two or three sentences, only what changes the choice. A confirmation says what survives, then what doesn't. | "The checkout, sessions, and transcripts stay. Installs inside the cell don't." |

**Facts, not rationale.** State what is so. Why the product behaves this way stays out unless
the user's choice depends on it.

**No spec quotation.** A sentence copied from `spec/` is a defect unless the spec says the
screen says it.

**The user is capable.** Define a product noun once, where it is first met, then use it.
Don't re-explain it on every screen.

## Color

| Name | Light | Dark | Role |
|---|---|---|---|
| Fold Indigo | `#4A43D8` | `#8E88FF` | The one saturated color. Primary action, live-run indicator, links. |
| Indigo hover | `#3A34B4` | `#A6A1FF` | Pressed and hovered accent. Note it *lightens* in dark. |
| Indigo tint | `#E8E6FA` | `#2B2650` | Selected rows, active nav, user message bubbles. |
| Ink | `#17171C` | `#F2F2F6` | Body text, headings. |
| Ink-2 | `#4A4A57` | `#B8B8C6` | Secondary prose. |
| Muted | `#656572` | `#9A9AA8` | Metadata, captions, placeholders. |
| Paper | `#F2F2F7` | `#1E1E26` | Page background. |
| Surface | `#FFFFFF` | `#2C2C38` | Cards, sheets, raised things. |
| Sunken | `#E9E9F0` | `#26262F` | Headers, gutters, hover fills. |
| Border | `#E3E3E9` | `#3B3B49` | Dividers. Decorative — never the only signal. |
| Border strong | `#86868F` | `#7E7E93` | Control borders. Meets the 3:1 UI threshold. |

**Paper is a real step off surface, in both directions.** Light paper sits *below* white; dark
paper sits *above* black. A page background within 1% of the cards standing on it reads as one
flat sheet — every card edge then has to be carried by a 1px border, which disappears in a
screenshot, on a phone in sunlight, and for anyone who turns contrast down.

The neutral ladder is monotone in both themes, and every step is visible. In L*:

| | Light | | Dark | |
|---|---|---|---|---|
| Surface (raised) | `#FFFFFF` | 100.0 | `#2C2C38` | 18.5 |
| Sunken (recessed) | `#E9E9F0` | 92.4 | `#26262F` | 15.5 |
| Paper (page) | `#F2F2F7` | 95.6 | `#1E1E26` | 11.6 |

Dark inverts the *direction* of "sunken", not the idea: elevation is surface lightness, so a
recessed fill sits between paper and surface rather than below both.

**Usage ratio — 60 / 25 / 10 / 5.** 60% paper, 25% ink, 10% tint, 5% full-strength indigo. That
last 5% is the primary action and the live-run indicator, and nothing else. Spend indigo on
decoration and "this needs you" stops meaning anything — which is the only thing the accent is
for.

**Muted text is a discrete token, not an alpha of ink.** Alpha over an unknown surface loses
contrast unpredictably. A token can be measured; `rgba(ink, .65)` over an arbitrary background
cannot.

**Status colors.**

| Status | Light | Dark | Soft bg (light / dark) |
|---|---|---|---|
| Success | `#15704A` | `#4FC98D` | `#E7F4ED` / `#1B4936` |
| Warn | `#8A5A00` | `#E3A63A` | `#FBF1DE` / `#45351C` |
| Error | `#B8302B` | `#FF7A70` | `#FBEAE9` / `#4E2823` |
| Info | `#2A5FA8` | `#78ADF2` | `#E9F0FA` / `#1F3555` |

**Status is never conveyed by hue alone.** Every status chip carries a dot *and* the word.
Roughly 1 in 12 men can't separate your red from your green, and nobody can in direct sunlight
on a phone — which is exactly where this gets used.

**Never rules.** No gradients. No glassmorphism or backdrop blur. No tinted or colored shadows.
No color-only state changes. No decorative use of the accent. Each of these is a way of making a
dense product feel designed while making it harder to read.

## Type

**Inter** for everything a person reads. **JetBrains Mono** for machine facts — run IDs, file
paths, diffs, timestamps, counts in logs. Both variable, latin subset, shipped locally.
Permitted weights: 400 regular, 530 medium, 600 semibold, 640 display. Nothing else is
on-system.

| Step | Size | Line height | Usage |
|---|---|---|---|
| `display-xl` | 40px | 1.05 | Page title. One per page. |
| `display-l` | 29px | 1.12 | Section opener. |
| `heading-m` | 20px | 1.25 | Card group heading, modal title. |
| `heading-s` | 16px | 1.35 | Card title, list section header. |
| `body` | 14.5px | 1.55 | Everything else. |
| `caption` | 12.5px | 1.45 | Metadata, hints, timestamps. |
| `mono` | 12.5px | 1.5 | IDs, paths, diffs, counts. |
| `micro` | 11px | 1.3 | Eyebrow labels and chips only. Never a sentence. |

Sizes are px, not rem: this is a dense product UI, and rem drift across nested containers costs
more than it buys. **In dark, body weight drops one step** — light text on a dark ground bleeds
heavier — but sizes never change.

**Reading measure is 72ch, and it is opt-in.** `.measure` caps one element; `.prose` caps the
running text inside a block. **Changed at 1.6.0:** a bare `<p>` used to carry the cap as an
element default and no longer does. In a dense ops UI `<p>` is the right element for a one-line
status strip far more often than it is a paragraph of prose, and a strip capped at 72ch stops
short while still rendering — the mistake is invisible, which is the worst kind. Consumers had
already voted: 12 of 16 screens in one kit run, and the prototype hub itself, shipped a
`max-width: none` to undo it. Apply the measure where there is running text to read.

## Shape & space

Radii: `none` 0 · `xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `full` 999.

| Element | Radius | Why |
|---|---|---|
| Button, input, select | `md` 8 | 4px disappears on a 44px-tall control. |
| Card, panel | `lg` 12 | One step above its contents, so nesting reads as nesting. |
| Chip, badge, avatar | `full` | **Status is round; actions are not.** |
| Sheet, modal, drawer | `xl` 16 | Reads as a surface arriving, not a card growing. |
| Code block, diff hunk | `sm` 6 | Round corners fight monospace grids. |
| Focus ring, checkbox | `xs` 4 | 8px on a 16px box is a circle. |

**Strokes.** Dividers 1px (`--color-border`). Control borders and active outlines 1.5px
(`--color-border-strong`). Icons 1.5px, round caps and joins.

**Space.** 4px base — `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 24 · `6` 32 · `7` 48 · `8`
64 · `9` 96. This is a compact ops tool: **surfaces live in `space-2`–`space-5`**. A list row is
44px tall with 12px padding — the target grew, the row didn't. `space-7` and up appear only
where there is one idea on the screen, such as an empty state.

**Elevation.** `--shadow-1` resting card · `--shadow-2` popover, sheet, toast · `--shadow-3`
modal. Neutral black only, per the never-rules. **In dark, elevation is surface lightness, not a
heavier shadow** — a black shadow on a near-black background is invisible.

**Layout.** Page max-width 1280px (`.page`). Reading measure 72ch, opt-in via `.measure` or
`.prose`. Two canonical shells:

- **App shell** — rail (or bottom bar) + list + detail. Panes are independent scroll regions.
- **Review layout** — detail pane with a sticky approval bar at the bottom edge.

**A pane is `.pane`** — an independent scroll region *and* a query container, which is how a
component inside it can be at folded width while the window is wide. See **Responsive**.

## Responsive

**This is the single source of truth for the bands.** Every other file — the spec, the prototype
workspace, `kit/` — cites these names and never restates the numbers.

| Breakpoint | Width | Device | What changes |
|---|---|---|---|
| `folded` | < 768 | the cover screen, ~475 | Single column. Bottom nav. Tables become stacked cards. Approval bar pinned to the bottom, inside the thumb arc. Unified diff only. |
| `unfolded` | ≥ 768 | the main screen, ~933 landscape | **Sidebar left, main pane right.** Approval bar returns inline. Side-by-side diff available. |
| `desktop` | ≥ 1120 | an external display | Three panes: rail + list + detail. |

**The bands are the device, not a screen-size ladder.** This product is designed first for a
folded phone, so the threshold that matters is the one the phone itself crosses. The Galaxy Z
Fold8 reports **~475 CSS px folded** and **~933 unfolded**, its main display being landscape-first
— 768 is what separates them, and it is the only width the stylesheet branches on. Both device
numbers are derived from Samsung's panel resolutions at the Fold7's confirmed device pixel ratio
of 2.625; no source has published the Fold8's DPR yet. Treat them as the ground truth they are
aimed at, not as measurements.

**Unfolded means sidebar left, main pane right.** That is the shape, not a suggestion: unfolding
the phone turns it landscape, and landscape with a bottom nav wastes the width it just gained
while pushing the primary action away from both thumbs. A screen that answers unfolding by
growing one column has not used the second screen — it has stretched the first.

**`tablet` is retired as a band name.** It was 768, which is what `unfolded` now names. A tablet
at 1024 gets the unfolded composition because at that width the composition is the same thing.
Two names for one threshold let prose put the side rail in either band, and prose did.

**Use container queries, not media queries.** A pane can be at folded width inside a desktop
window, and it should look like it. Media queries ask the window; the component needs to ask its
own box.

**As of 1.6.0 the system's own components obey this**, and each one names the box it asks:

| Component | Asks | You must |
|---|---|---|
| `.table-stack` | its `.table-wrap` | wrap every stacking table — the wrapper *is* the container |
| `.diff-split` | its `.diff` | keep the split inside a `.diff`, as the anatomy shows |
| `.approvalbar` | the nearest `.pane` | put the review pane in a `.pane`; it owns no wrapper of its own |
| `.toast-stack` | the window, deliberately | nothing — a toast is app chrome and means the window |

**A container query with no container never matches, and the page still renders.** That is the
failure mode to design against, and it decides which query a rule gets. A rule that *expands* at
width (`min-width`) is safe to leave as a container query alone: failing to match leaves the
folded composition, which fits everywhere. A rule that *contracts* at width (`max-width`) is not
— `.table-stack` failing to match would leave a five-column table on a 475px phone — so that one
keeps a `@media` floor underneath and the two act as a union. Both queries are load-bearing.
**The union is not free**: it can stack a wide `.table-wrap` inside a narrow window, which is a
table stacking when it had the room not to. That is a legible result where the failure it
prevents is an invisible one, and `fold-ai-dev.css` argues it out where the two rules are
written.

**`.pane` is the only layout primitive, and it is opt-in.** It makes an element an independent
scroll region and a query container in one line. It is new at 1.6.0 — the composition is not, but
every screen used to spell it out for itself.

**`container-type: inline-size` costs two things, and both are why nothing applies it for you.**
It is on `.pane`, `.table-wrap` and `.diff`, so all three carry both:

- **Containing block.** A container is the containing block for `position: fixed` descendants, so
  a `.scrim` or `.modal` rendered inside one covers that box rather than the viewport. Render
  overlays at the screen root.
- **No intrinsic inline size.** A container is sized without consulting its contents, so wherever
  a parent asks the child how wide it wants to be, the answer is now 0. A `.table-wrap` as a flex
  item measures **0px**; a `.diff` in a grid `auto` track, or set `inline-block`, measures **2px**
  — its own borders. Both sized to content before 1.6.0. Put them where the width comes from the
  parent: `flex: 1`, a grid `1fr`, `width: 100%` — never `flex: none` or a grid `auto` track.
  **The symptom is a blank region and no error**, which is the reason this is written down at all.

**Name the containers you declare yourself.** An unnamed `@container` binds to the nearest
ancestor with containment, and since 1.6.0 that may be a `.table-wrap` or a `.diff` rather than the
box you meant — a screen writing a bare `@container (min-width: 768px)` inside a table wrapper is
measuring the wrapper. One extra declaration fixes it, and a named query skips every container
that does not carry the name, so a component that grows containment later cannot capture it:

```css
.myscreen { container-type: inline-size; container-name: myscreen; }
@container myscreen (min-width: 768px) { … }
```

The system's own container queries stay unnamed on purpose — each wants the nearest box, and the
nearest box is the component it belongs to.

**Touch minimum is 44×44px at every breakpoint, desktop included.** Hover never hides or reveals
the only control. Every gesture has a visible equivalent — swipe is an accelerator, never the
door. Destructive actions keep an 8px gap and never sit adjacent to the primary action in a
thumb arc. **Bigger targets, same information.**

## Focus & motion

Focus ring: 2px solid accent, 2px offset, `:focus-visible` only. **Never removed, never replaced
by a color change alone** — a keyboard user who can't see focus can't use the product at all.

| Token | Value | Applies to |
|---|---|---|
| `--dur-fast` | 120ms | Hover, focus, press, tooltip. |
| `--dur-base` | 200ms | Popover, toast, sheet entering. |
| `--dur-slow` | 320ms | Full-screen transitions only. |
| `--ease-standard` | `cubic-bezier(.2,0,0,1)` | Everything. One curve, no bounce, no spring. |

**What never animates:** decoration. Nothing loops, drifts, or pulses, with exactly two
exceptions — the live-run indicator and the skeleton sweep, both of which report that work is
happening. Under `prefers-reduced-motion`, durations collapse to zero and transforms are
removed; opacity fades stay, because they carry meaning rather than delight.

## Dark mode

**Required, shipped, and equal.** Neither theme is the default: the system follows
`prefers-color-scheme` and honors a `data-theme` override in both directions. Both themes have
full token sets and rendered site pages. A component never knows which theme it's in.

**Dark is not inverted light.** The accent lifts, and elevation is surface lightness rather than
a heavier shadow, so **dark paper is a dark grey (L\* 11.6), never a near-black**: a page with no
headroom above it has nothing to carry elevation with, and the screen reads as switched off
rather than designed.

**Dark paper cannot go much above L\* 12 without moving the accent.** At page `#25252F` the
existing Fold Indigo dark (`#8E88FF`) falls to 4.22 on surface and the soft status fills stop
clearing AA. Accent-on-surface in dark is 4.67 — the tightest pair in the system, and the one
that constrains any future move.

## Accessibility

Policy, not vibes:

- **Contrast.** Every documented foreground/background pair meets WCAG AA or better in both
  themes, with no exceptions. Add a pair, measure it — text needs 4.5, UI boundaries need 3.0.
- **Touch.** 44×44px minimum, every breakpoint.
- **Focus.** Visible on every interactive element, always.
- **Status.** Never hue alone; dot plus word.
- **Motion.** `prefers-reduced-motion` honored globally in `tokens.css`.
- **Labels.** Anything you can't address by accessible name is a bug, not a style choice.

## Icons

**37 line icons** in `assets/icons/functional/`, covering nav, interface, forms, status, and the
product's domain. 24px grid, 1.5px stroke, round caps and joins, `fill="none"`,
`stroke="currentColor"` so they inherit color from context. **The stroke does not thin in dark** —
compensating for glow is what makes icons vanish on a phone outdoors.

`home` `runs` `attention` `projects` `settings` `search` `menu` `close` `chevron-right`
`chevron-down` `chevron-left` `arrow-right` `more` `external` `copy` `filter` `check` `plus`
`minus` `edit` `trash` `check-circle` `alert-circle` `x-circle` `clock` `info` `pause` `diff`
`branch` `file` `folder` `terminal` `worker` `chat` `undo` `approve` `deploy`

**Inline the SVG** so `currentColor` and the theme reach it; an `<img>` cannot follow either.
**Adding one:** copy the nearest existing file, keep the 24 viewBox, the 1.5 stroke, and
`currentColor`; draw on whole or half pixels; ship it here. **Never point a consumer at an
external library** — a network dependency isn't a shipped system, and the set stops being
coherent the moment half of it comes from somewhere else.

## Logo

**Placeholder disclosure.** The mark shipped here was generated for this system, not designed by
a human brand studio. It's deliberately simple and **swappable**: replace the four files in
`assets/logos/` and nothing else in the system changes.

The symbol is two panels hinged at a center crease — the device seen from above. One color plus
one opacity, which is what lets it survive a favicon and a 16px sidebar.

| Variant | File | Use |
|---|---|---|
| Symbol, inherit | `assets/logos/fold-symbol.svg` | `currentColor` — the source of truth. |
| Symbol, accent | `assets/logos/fold-symbol-accent.svg` | Default app bar. |
| Symbol, ink | `assets/logos/fold-symbol-ink.svg` | Monochrome documents, print. |
| Symbol, inverse | `assets/logos/fold-symbol-inverse.svg` | On indigo. |
| Wordmark | Symbol + "Fold" set in Inter 640, -0.03em | Composed in markup; no separate file needed. |

**Clear space:** one panel width on all sides. **Minimum size:** 16px for the symbol, 80px wide
for the lockup. **Misuse:** never rotate it, gradient it, re-set the wordmark in another face,
add a drop shadow, or stretch it to fill a non-square box.

## Components

25 components. Each has a file in `reference/components/` and a section in `fold-ai-dev.css`.

| Component | Variants | Sizes | Key rule |
|---|---|---|---|
| Button | primary, secondary, destructive, ghost, icon | sm 36 · md 44 · lg 52 | One primary per view. Destructive outlined, never filled. |
| Chip | success, warn, error, info, accent, solid, count | one | Status is round. A dot *and* the word — never hue alone. |
| Input | text, textarea, mono, invalid | md 44 | Label always present; placeholder is never the label. A field is a column unless you say `.field-row`. |
| Select | select, combobox | md 44 | Options are 44px targets too. |
| Toggle | checkbox, radio, switch | 18px box / 40px switch | The label row is the target, not the 18px box. |
| Card | resting, raised, interactive | — | Interactive cards need a focus ring, not just a hover. |
| App bar | — | 56px | Brand, context, and status. Never actions that belong to content. |
| Rail & bottom bar | rail, bottombar | 44px items | One or the other, never both. Bottom under 768px. |
| Tabs | — | 44px | Tabs switch views; they never submit. State goes in the URL. |
| Breadcrumb | — | — | Last item is current and not a link. |
| Banner | success, warn, error, info | — | In-flow and persistent. Carries the fact itself. |
| Toast | with action | — | Transient. **Never the only copy of a fact.** |
| Empty state | — | — | Live fact first, absence second. |
| Skeleton | line, title, row | — | Matches the shape of what's loading, or it's a lie. |
| List & row | interactive, selected, group label | 44px row | Whole row is the target. |
| Tree | branch, leaf, selected | 44px row | One 12px indent step per level — depth is the guide rule's job, never width the name pays for. A branch is a `<details>`, so it collapses with no script. |
| Table | stacked below 768 | — | Below tablet a table is not a table. **Always inside a `.table-wrap`** — that is the box it measures. |
| Filter bar | filter, set, order, count | md 44 | The count lives in the bar with the filters it answers to. A set filter says its value in words, never by tint alone. |
| Meter | measure, ghost | 6px track | Number first, bar second, **never a bar alone**. The third term is context, not the denominator. |
| Modal | — | ≤520px | Becomes a sheet at folded width. |
| Sheet | — | ≤85vh | Arrives inside the thumb arc. |
| Popover | — | ≥200px | Items are 44px. Never the only path to an action. |
| Tooltip | on a term, on a figure, start · end aligned | ≤32ch | One sentence, on hover and keyboard focus. **Never the only place a fact lives.** |
| Run timeline | done, running, waiting, failed | — | Every step says what happened; a failure says what it did *not* touch. |
| Diff viewer | unified, split ≥768 | — | Added/removed carry a gutter sign as well as a color. Split measures its `.diff`, not the window. |
| Approval bar | — | — | Sticky at folded width, inline from tablet — measured on its `.pane`. Destructive apart from primary. |
| Chat thread | worker, user, tool | — | Tool turns are mono and visually quieter than either speaker. |

## Status vocabulary

**Some domain words appear on many surfaces, and the chip they take is fixed here so it cannot be
two things.** The words themselves, and what each one means, belong to `spec/` — this table only
assigns the color, which is the part that crosses components.

### Model availability

Four words, owned by `spec/control-plane/settings.md` → `§control-plane.settings/models`, and
read by every model picker.

| Word | Chip | Why this severity |
|---|---|---|
| `available` | `.chip-success` | Working, inside its allowance. |
| `degraded` | `.chip-info` | Works now, worse than usual. A caveat, not a wait. |
| `rate-limited` | `.chip-warn` | Not right now, and it returns on its own. A wait. |
| `quota-exhausted` | `.chip-error` | Not until the subscription resets. A switch. |

**The order is monotonic with how far the model is from running the turn you are about to
start**, and that is the whole reason it is written down. It is the spec's own *"What the user
does next"* column in the same order — choose it · choose it knowing that · wait or choose
another · choose another. `degraded` sits below `rate-limited` because a degraded model answers
now and a rate-limited one does not; coloring `degraded` above a state that makes you wait tells
a user to avoid a model that works. Two screens in one kit run assigned the two the opposite way
round to each other; both defended the choice, and the picker that got it backwards was steering
people off a working model.

**Severity is not selectability, and this table decides neither.** Three of the four are
selectable — `spec/control-plane/settings.md` marks only `quota-exhausted` **No** — so the chip is
never the reason a row is disabled, and a warn or info chip must not be drawn as one. Read the
spec's Selectable column for that.

**Every one of these carries a dot and the word** — never the hue alone, per **Accessibility**.
That includes `available`: a row with no chip is neither a dot nor a word, so "no chip means
fine" is not a state a reader can see. A screen wanting less green on an eight-row picker has a
composition problem to solve in its own layout, not a fifth meaning to give to absence.

## Class index

| Component | Selectors |
|---|---|
| Button | `.button` `.button-primary` `.button-destructive` `.button-ghost` `.button-sm` `.button-lg` `.button-icon` `.button-row` · demo: `.button-hover` `.button-focus` `.button-active` `.button-disabled` |
| Chip | `.chip` `.chip-dot` `.chip-success` `.chip-warn` `.chip-error` `.chip-info` `.chip-accent` `.chip-solid` `.chip-count` |
| Input | `.field` `.field-row` `.field-label` `.field-hint` `.field-error` `.input` `.textarea` `.input-mono` `.input-invalid` · demo: `.input-hover` `.input-focus` `.input-disabled` |
| Select | `.select` `.select-wrap` `.select-caret` `.combobox-list` `.combobox-option` |
| Toggle | `.toggle` `.toggle-box` `.toggle-radio` `.toggle-switch` |
| Card | `.card` `.card-head` `.card-title` `.card-body` `.card-foot` `.card-raised` `.card-interactive` |
| App bar | `.appbar` `.appbar-brand` `.appbar-title` `.appbar-spacer` |
| Rail & bottom bar | `.rail` `.rail-collapsed` `.bottombar` `.navitem` `.navitem-active` `.navitem-label` |
| Tabs | `.tabs` `.tab` `.tab-active` |
| Breadcrumb | `.breadcrumb` `.breadcrumb-sep` `.breadcrumb-current` |
| Banner | `.banner` `.banner-title` `.banner-body` `.banner-icon` `.banner-success|warn|error|info` |
| Toast | `.toast` `.toast-body` `.toast-action` `.toast-stack` |
| Empty state | `.empty` `.empty-mark` `.empty-title` `.empty-body` `.empty-action` |
| Skeleton | `.skeleton` `.skeleton-line` `.skeleton-title` `.skeleton-row` |
| List | `.list` `.list-row` `.list-row-interactive` `.list-row-selected` `.list-main` `.list-title` `.list-meta` `.list-group-label` |
| Tree | `.tree` `.tree-branch` `.tree-row` `.tree-row-selected` `.tree-twist` `.tree-mark` `.tree-name` `.tree-meta` `.tree-children` |
| Table | `.table-wrap` `.table` `.table-stack` `.table-num` `.table-mono` |
| Filter bar | `.filterbar` `.filterbar-filters` `.filterbar-filter` `.filterbar-filter-on` `.filterbar-value` `.filterbar-order` `.filterbar-count` |
| Meter | `.meter` `.meter-head` `.meter-label` `.meter-value` `.meter-of` `.meter-track` `.meter-fill` `.meter-context` `.meter-ghost` |
| Overlay | `.scrim` `.modal` `.modal-head` `.modal-title` `.modal-body` `.modal-foot` `.sheet` `.sheet-grip` `.popover` `.popover-item` `.popover-sep` |
| Run timeline | `.timeline` `.timeline-step` `.timeline-marker` `.timeline-title` `.timeline-meta` `.timeline-body` `.timeline-done|running|waiting|failed` |
| Diff viewer | `.diff` `.diff-file` `.diff-stat-add` `.diff-stat-del` `.diff-hunk` `.diff-line` `.diff-gutter` `.diff-add` `.diff-del` `.diff-split` |
| Approval bar | `.approvalbar` `.approvalbar-summary` `.approvalbar-spacer` |
| Chat thread | `.thread` `.message` `.message-head` `.message-author` `.message-body` `.message-user` `.message-tool` |
| Utilities | `.text-display-xl|display-l|heading-m|heading-s|body|caption|mono|eyebrow` `.text-muted|accent|success|warn|error|num` `.surface` `.sunken` `.bordered` `.stack` `.stack-2` `.stack-5` `.cluster` `.spread` `.page` `.pane` `.measure` `.prose` `.visually-hidden` |

## Tokens by group

`tokens.css` is the only source of raw values; this is the map.

| Group | Tokens |
|---|---|
| Semantic color | `--color-bg` `--color-surface` `--color-sunken` `--color-ink` `--color-ink-2` `--color-ink-muted` `--color-border` `--color-border-strong` `--color-accent` `--color-accent-hover` `--color-accent-tint` `--color-on-accent` |
| Status | `--status-success|warn|error|info`, `--status-*-bg` |
| Diff | `--diff-add-bg` `--diff-add-ink` `--diff-del-bg` `--diff-del-ink` `--diff-gutter` |
| Type | `--font-display` `--font-body` `--font-mono`, `--fw-regular|medium|semibold|display`, `--fs-*` + `--lh-*` (8 steps), `--ls-display|heading|body|eyebrow` |
| Space | `--space-1` … `--space-9` |
| Radius | `--r-none` `--r-xs` `--r-sm` `--r-md` `--r-lg` `--r-xl` `--r-full` |
| Stroke | `--stroke-thin` `--stroke-icon` |
| Size | `--tap-min` `--row-height` `--control-sm|md|lg` |
| Shadow | `--shadow-1` `--shadow-2` `--shadow-3` |
| Focus | `--focus-width` `--focus-offset` `--focus-color` `--focus-ring` |
| Motion | `--dur-fast` `--dur-base` `--dur-slow` `--ease-standard` |
| Layout | `--bp-unfolded` `--bp-desktop` `--page-max` `--measure` |

The `--brand-*` layer beneath these holds the raw hex per theme. **Consume the semantic tokens,
never the brand layer** — a component that reads `--brand-indigo` directly stops following the
theme.
