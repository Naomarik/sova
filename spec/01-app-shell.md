# 01 · App shell
> Part of the pi-web design spec · [overview](overview.md)

```
unfolded (≥768)                                  folded (<768)
┌──────────────┬───────────────────────────┐     ┌──────────────────┐
│ sidebar-head │ session-head              │     │ list  OR  session│
│ search       ├───────────────────────────┤     │ (data-view)      │
│ session list │ [error banner, sticky]    │     │                  │
│  (pane)      │ transcript (pane)         │     │                  │
│              ├───────────────────────────┤     │                  │
│              │ composer                  │     │                  │
└──────────────┴───────────────────────────┘     └──────────────────┘
```

```html
<a class="button skip-link" href="#transcript">Skip to Transcript</a>
<div class="app" data-view="list|session">
  <aside class="app-sidebar" aria-label="Sessions">…§2…</aside>
  <main class="app-main">…§3 head, transcript, composer…</main>
  <!-- ≥768 only; CSS hides it folded -->
  <div class="pane-resizer" role="separator" aria-orientation="vertical"
       aria-label="Resize the sessions pane" title="Drag to resize · Double-click to reset"></div>
</div>
<!-- Portals (render at the body, never inside a .pane): scrim + modal, .toast-stack, live region -->
```

- **Columns.** `.app` is `height: 100dvh`. At 768px and up the grid is `--sidebar-width` (320px)
  plus `1fr`, with a border between the columns. Below 768px it's one column, and `data-view`
  decides which one shows: `list` when no session is selected, `session` when one is. The shell
  is window chrome, so it uses `@media` rather than a container query, the same reasoning the
  skill gives for `.toast-stack`.
- **Scrolling.** The session list and the transcript each carry `.pane`, so each is an
  independent scroll region. The page itself never scrolls.
- **Routing.** Keep the selected session in the URL, e.g. `#/s/<encodeURIComponent(path)>`. That
  way reload and back work, and the folded back button is `history.back()` or a link to `#/`.
- **No rail and no bottom bar.** pi-web has one destination, so there's no nav to place. This is
  a deliberate departure from the skill's three-pane desktop shell: the ≥1120 `desktop` band adds
  nothing here.
- **Dialogs** follow the skill's modal pattern and become a bottom sheet under 768px
  automatically (`.modal` restyles itself).
- **Toasts** go in one `.toast-stack` portal. Use them only for "Copied path." / "Copied output."
  A toast is never the only record of a fact, so errors go in banners.

## Resizing the sessions pane

The divider between the two columns is draggable. `.pane-resizer` is a child of `.app` (the
sidebar is `overflow: hidden` and would clip it), absolutely positioned — which is why `.app`
takes `position: relative` from 768px up — and it writes `--sidebar-width` on
`document.documentElement`.

- **An invisible 12px hit strip.** `left: var(--sidebar-width)` with `margin-left: -6px`, so it
  straddles `.app-sidebar`'s `border-right` evenly, top to bottom. **Nothing is drawn at rest**:
  the sidebar's own 1px border is already the divider, and a second mark for a control nobody is
  touching is clutter. On `:hover`, and for as long as `html.is-resizing` is set, a 1px
  `--color-accent` hairline lights up down the centre of the strip, over `--dur-fast`. 12px is
  under the 44px touch minimum on purpose: it is an edge, the edge has no other target within
  44px in either direction, and every pixel it grows is a pixel stolen from a list row's
  target.
- **Unfolded only.** `display: none` below 768px. Folded is a single full-width column with no
  divider and nothing to divide, so there is no handle to find.
- **The drag.** Pointer events with pointer capture, mouse and touch alike; `touch-action: none`
  on the strip keeps a touch drag from scrolling the page. While a drag is live the root carries
  `is-resizing`, and `html.is-resizing, html.is-resizing *` force `cursor: col-resize` and
  `user-select: none` — the pointer leaves the 12px strip on the first move, so the cursor and
  the selection guard have to hold across the transcript it runs over.
- **Clamp.** `240 … min(560, viewport − 440 − the Subagents pane)`. 440 is `--main-min`, the
  transcript's floor; the Subagents term is its real width **only while it is a static third
  column** (≥1280px), because below that it overlays the main pane and reserves nothing. The
  clamp is re-applied on `resize` and `orientationchange`, so shrinking the window pulls an
  over-wide pane back rather than squeezing the transcript out.
- **Default 320px on every load, and nothing is persisted.** This is a decision, not an
  omission: a width is a posture for the task in front of you, not a preference, and a
  remembered one is a setting you have to notice and undo. Double-clicking the handle resets to
  320 for the same reason — the way back is always one gesture.
- **One knob, three consumers.** `--sidebar-width` feeds the `.app` grid's first column, the
  Subagents pane's `width: min(--subagents-width, 100% − --sidebar-width − --space-8)`, and
  `--measure`'s `clamp(72ch, 100vw − --sidebar-width − …, 110ch)` (§3 "Column width"). So
  dragging the pane reflows the transcript's line length **live**, under the pointer, and the
  reading column is never quietly wrong about how much room it has.
- **No keyboard path, and that is an accepted gap.** The handle has no `tabindex`, so it is not
  reachable by Tab, and it carries no `aria-valuenow`/`valuemin`/`valuemax` — the `role="separator"`
  is there to name the thing, not to make it a slider. **A keyboard-only user cannot resize the
  sessions pane at all.** It is a layout preference with no content behind it: everything the
  pane holds is fully readable at the 320px default, every row truncates rather than hides, and
  no fact is reachable only by widening. Nothing is lost but the adjustment itself. The right
  fix, if this is revisited, is `tabindex="0"` plus arrow keys and the three `aria-value*`
  attributes; until then this is written down rather than unnoticed.

---

