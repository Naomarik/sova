# Grid & responsive

## Purpose

Three bands, and they are the device, not a screen-size ladder: folded is designed first, and 768 is the one threshold the stylesheet branches on. Components ask their own box with container queries rather than the window with media queries, because a pane can be at folded width inside a desktop window and should look like it.

Rendered: `site/foundations/grid-composition.html#spec`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.page` | Centered, max 1280 | Gutter is `--space-4` |
| `.pane` | Scroll region **and** query container | The box a component measures |
| `.measure` | 72ch reading cap, one element | Opt-in; a bare element is never capped |
| `.prose` | 72ch cap on the running text inside | Leaves strips and rows alone |
| `.table-stack` | Table collapses below 768 of its `.table-wrap` | Needs `data-label` per cell |

## Tokens used

- `--bp-unfolded / -desktop` — 768 / 1120. For JS and docs — custom properties do not work in `@media`.
- `--page-max` — 1280px.
- `--measure` — 72ch.
- `--tap-min` — 44px, every breakpoint.

## Scale & spec

| Band | Width | Device | Composition |
|---|---|---|---|
| `folded` | < 768 | cover screen, ~475 | Single column, bottom nav, stacked tables, approval bar pinned in the thumb arc, unified diff only |
| `unfolded` | ≥ 768 (`--bp-unfolded`) | main screen, ~933 landscape | Sidebar left, main pane right; approval bar inline; split diff available |
| `desktop` | ≥ 1120 (`--bp-desktop`) | external display | Three panes: rail + list + detail |
| `--page-max` | `1280px` | — | Page ceiling (`.page`) |
| `--measure` | `72ch` | — | Reading cap, opt-in via `.measure` / `.prose` |
| `--tap-min` | `44px` | — | Touch minimum at every band, desktop included |

**768 is the only width the stylesheet branches on.** The device widths are estimates derived from panel resolutions at an assumed pixel ratio, not measurements; they are what the bands aim at. There is no `tablet` band — a tablet at 1024 gets the unfolded composition.

**Components ask their own box, not the window.** `.table-stack` measures its `.table-wrap`, `.diff-split` its `.diff`, `.approvalbar` the nearest `.pane`; `.toast-stack` alone asks the window, because a toast is window chrome. A container query with no container never matches and the page still renders, so a rule that *contracts* at width keeps a `@media` floor beneath it — the argument is written beside the rule in `fold-ai-dev.css`.

**Containment has two costs.** A container is the containing block for `position: fixed` descendants, so render overlays at the screen root; and it has no intrinsic inline size, so a `.table-wrap` as a flex item measures 0px and a `.diff` in a grid `auto` track measures 2px. Give them width from the parent (`flex: 1`, `1fr`, `width: 100%`). The symptom is a blank region and no error.

**Name any container you declare yourself.** An unnamed `@container` binds to the nearest ancestor with containment, which may be a `.table-wrap` or a `.diff` rather than your screen root.

## DO / DON'T

- **DO** Write `@container` queries in components — the component should ask its own box, not the window.
- **DO** Give the box a `.pane` so the query has something to match — a container query with no container never matches and the page still renders.
- **DO** Name any container you declare yourself, and query it by name — an unnamed `@container` binds to the nearest one, which may be a `.table-wrap` or a `.diff` rather than your screen root.
- **DO** Duplicate every gesture with a visible control — swipe is an accelerator, never the door.
- **DO** Pin the primary decision to the bottom at folded width — that is where a thumb reaches one-handed.
- **DON'T** Let a table scroll horizontally on a phone — stack it — horizontal scroll is a defeat, not a fallback.
- **DON'T** Render a `.scrim` or `.modal` inside a `.pane` — containment makes the pane its containing block, so it covers the pane and not the screen.
- **DON'T** Let a container take its width from its own contents — `container-type: inline-size` resolves the box without them, so a `.table-wrap` as a flex item measures 0px and a `.diff` in an `auto` track measures 2px.
- **DON'T** Hide a control behind hover — a phone has no hover, so the control does not exist there.
- **DON'T** Treat folded as a degraded desktop — it is a first-class width, and the one drawn first.
