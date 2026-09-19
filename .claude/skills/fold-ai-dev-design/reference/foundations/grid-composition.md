# Grid & responsive

## Purpose

The bands are the device, not a screen-size ladder. This product is designed first for a folded phone, so the threshold that matters is the one the phone itself crosses — the Galaxy Z Fold8 reports ~475 CSS px folded and ~933 unfolded, its main display being landscape-first, and 768 separates them. Container queries rather than media queries, because a pane can be at folded width inside a desktop window and should look like it.

Rendered: `site/foundations/grid-composition.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.page` | Centred, max 1280 | Gutter is `--space-4` |
| `.pane` | Scroll region **and** query container | The box a component measures |
| `.measure` | 72ch reading cap, one element | Opt-in since 1.6.0 |
| `.prose` | 72ch cap on the running text inside | Leaves strips and rows alone |
| `.table-stack` | Table collapses below 768 of its `.table-wrap` | Needs `data-label` per cell |

## Tokens used

- `--bp-unfolded / -desktop` — 768 / 1120. For JS and docs — custom properties do not work in `@media`. `--bp-tablet` is retired; it was 768, which `--bp-unfolded` now names.
- `--page-max` — 1280px.
- `--measure` — 72ch.
- `--tap-min` — 44px, every breakpoint.

## DO / DON'T

- **DO** Write `@container` queries in components — the component should ask its own box, not the window.
- **DO** Give the box a `.pane` so the query has something to match — a container query with no container never matches and the page still renders.
- **DO** Name any container you declare yourself, and query it by name — an unnamed `@container` binds to the nearest one, which since 1.6.0 may be a `.table-wrap` or a `.diff` rather than your screen root.
- **DO** Duplicate every gesture with a visible control — swipe is an accelerator, never the door.
- **DO** Pin the primary decision to the bottom at folded width — that is where a thumb reaches one-handed.
- **DON'T** Let a table scroll horizontally on a phone — stack it — horizontal scroll is a defeat, not a fallback.
- **DON'T** Render a `.scrim` or `.modal` inside a `.pane` — containment makes the pane its containing block, so it covers the pane and not the screen.
- **DON'T** Let a container take its width from its own contents — `container-type: inline-size` resolves the box without them, so a `.table-wrap` as a flex item measures 0px and a `.diff` in an `auto` track measures 2px.
- **DON'T** Hide a control behind hover — a phone has no hover, so the control does not exist there.
- **DON'T** Treat folded as a degraded desktop — it is a first-class width, and it is designed for first.
