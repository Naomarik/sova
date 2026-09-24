# §design/ground-rules — Ground rules
> Part of the Sova design spec · [overview](overview.md)

## §design.ground-rules/theme — Theme

Dark is the default. `<html>` with no attribute renders dark; `<html data-theme="light">` renders
the full light set. Those two blocks in `src/design/tokens.css` are the bases every theme stands
on.

A theme is one JSON file: `themes/<id>.json` for the ones shipped with the app,
`~/.pi/agent/sova/themes/<id>.json` for the ones you drop in. It carries
`"$schema": "sova-theme/v1"`, a `name`, an `extends` of `dark` or `light`, an optional `vars`
map of named values its own later keys can reference as `"$name"`, a `colors` map keyed by the
semantic tokens without their `--color-` / `--status-` / `--diff-` prefix, and an optional
`typography` map (`font-body`, `font-display`, `font-mono`, `fs-*`, `lh-*`, `fw-*`, `ls-*` — a
theme that swaps the face can adjust its tracking to match). Every key is optional: what a theme
omits comes from the base it extends, so a three-key file is a valid theme. Values land verbatim
on the custom property they name — the authored string, never a re-serialized one.

**Every value is validated against what is allowed, never against a list of what isn't.**
`shared/theme.ts` holds the executable definition and is the only canonical copy; this is the rule
it implements, and nothing anywhere enumerates rejected spellings — a list of those is one CSS
function behind the next thing that learns to fetch.

| Keys | What passes |
|---|---|
| The 27 color keys — `bg`, `surface`, `sunken`, `ink`, `ink-2`, `ink-muted`, `border`, `border-strong`, `accent`, `accent-hover`, `accent-tint`, `on-accent`, the four `status-*` and their four `-bg` fills, the five `diff-*`, **`scrim`, and `skeleton-sweep`** | One of two shapes. **A hex value** — `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — which carries no parentheses at all. Or **one call**: a name from `rgb`, `rgba`, `hsl`, `hsla`, `oklch`, `oklab`, `lab`, `lch`, `color-mix`, `color`, then `(`, then arguments, then `)`, with no second `(` anywhere in the value. Either shape: charset `A-Za-z0-9 #%(),./+-`, 120 characters |
| `shadow-1`…`shadow-3` | The same charset, 200 characters — a shadow is a list of lengths, an optional `inset`, and a color. `box-shadow` takes no image, so the open form is safe here and only here |
| `font-body`, `font-display`, `font-mono` | A stack: quotes and commas, **no parentheses at all**, 200 characters |
| `fs-*`, `ls-*` | A `px` or `em` length, or a bare `0` |
| `lh-*` | A unitless positive number |
| `fw-*` | An integer from 100 to 900 |

The point of the shape is what it excludes without naming it. A theme's `bg` reaches `background`
at 107 sites in `base.css`, and `background` takes an image, so a value that can spell `url(…)` is
an outbound request from the reader's browser with nothing broken and nothing escaped.

`scrim` is a color key for the same reason, and it is the one that isn't obvious: it paints
`background` at three sites (`base.css` 551, 2091, 2276), so an open charset would let it fetch
exactly as `bg` would. `skeleton-sweep` sits inside a `linear-gradient` color stop, where a `url()`
is invalid and couldn't fetch — it takes the color rule anyway, because every value it has ever
held is one `rgba()` call and a key that could be stricter should be.

Three clauses do that work and each stops something different. **The name list** is what refuses
`url`, `image-set`, `src`, and everything else that fetches — not the charset, which happily
spells `url(//host/x.png)`: a protocol-relative URL needs no colon and resolves against the
page's own scheme. **The single `(`** is what refuses nesting, and nesting is how `var()` would
otherwise reach a value defined outside the file — `rgb(var(--x))` has an allowed name and a legal
charset, and is a substitution. **The charset and the length** catch the rest. A check that keeps
only the last of the three is the plausible mistake, and it is the one that reopens `url()`.

Font stacks admit no parentheses because a stack has no use for them. A value that fails becomes a
broken row carrying its reason (§app/settings-dialog), and the theme it came from is not applied.

**The grammar checks shape, not arguments**, so a value can pass and still not be a color:
`rgb(0,0,0,0,0)` has an allowed name, one pair of parentheses, a legal charset and 15 characters.
What happens then is worth knowing rather than guarding against — the custom property is set, but
`var()` substituting it into a real property leaves that declaration invalid at computed-value
time, so the property renders `unset` rather than falling back to the base theme's value. One
malformed color costs one property, not the theme. Tightening the grammar to catch it would mean
parsing arguments the contract deliberately passes through verbatim.

The server does four things, in this order, when the file is read:

1. **Read the file.** A file that isn't JSON stops here and becomes a broken row (§app/settings-dialog).
2. **Resolve `$name`.** Every reference becomes the value it names. Nothing downstream sees a `$`.
3. **Validate**, every key family against the table above — allowed shapes, never rejected
   spellings.
4. **Emit**, the authored string onto the custom property it names.

**Step 3 cannot precede step 2.** It is the one order that's easy to write backwards and it fails
in a misleading direction: a `"$base"` is not a color, so every theme that uses `vars` dies at
once, with an error naming the color grammar while pointing at a value that was never a color.
16 of the 18 shipped themes use `vars` — all but `dark` and `light`, which name no palette.

Applying a theme is not the only thing that puts its strings on screen: the picker previews
every theme it found, painting swatches and a font sample from files nobody has selected (§app/settings-dialog).
Parse time is the one point upstream of all of them, so a file that fails becomes a broken row
and its values never reach a DOM node, selected or not.

`--focus-color` and `--focus-ring` are not theme keys and are never written. They resolve through
`var(--color-accent)` in `tokens.css`, which is how a theme's own accent reaches the focus ring;
emitting them would freeze the ring at the base theme's accent.

18 themes ship: `dark` and `light`, which reproduce the two token blocks exactly, and 16 palette
themes (Dracula, three Tokyo Nights, four Catppuccins, four Monokais, four Nords) which set
color only and keep Inter and JetBrains Mono. A user file whose id matches a built-in replaces
it.

The choice is made in Settings → Themes (§app/settings-dialog), persists in `localStorage` under `sova:theme`,
and is applied — custom properties written, `data-theme` set to the theme's base — before first
paint. An id that no longer resolves falls back to `dark`.

**A font pick sits over the theme.** Settings → Themes → Typography (§app/settings-dialog) lets this browser put
one of a closed list of bundled faces on `--font-body` + `--font-display` (Text) and `--font-mono`
(Code), persisted under `sova:typography` as catalogue ids — never a stack the user typed, so
nothing there is subject to the grammar above; the ids resolve in `src/lib/typography.ts`. The
precedence is pick, then the theme's own `typography`, then `tokens.css`: the pick is written
after the theme's tokens on every apply, so it survives a theme switch, and a kind left on Theme
default shows the theme's face. `?theme=default` clears both. Every face in the catalogue is
bundled under `public/fonts/` with its license and source (`public/fonts/README.md`); nothing is
fetched from a CDN.

## §design.ground-rules/icons — Icons

Inline the SVG markup. Don't use `<img>`, because an image can't pick up `currentColor` or the
theme. Add `class="icon"` (20px) or `class="icon icon-sm"` (16px) to the `<svg>`, and add
`aria-hidden="true"` whenever a text label sits next to it. An icon-only button gets its name from
`aria-label`, never from the SVG.

Two supported forms, both inheriting `currentColor`:

- **Mask span (used by the frontend):**
  `<span class="icon" style="--icon: url(/icons/copy.svg)" aria-hidden="true"></span>`. `base.css`
  turns the file into a mask over `currentColor`. `.icon-sm` and `.icon-twist` work the same way.
- **Inline `<svg class="icon">`**, with the markup copied from the file.

Either way, the icon only reaches the theme through `currentColor`, which is the rule the skill
cares about. Every icon uses a 24-unit viewBox, a 1.5 stroke, round caps and joins,
and `fill="none" stroke="currentColor"`.

| File (`/icons/…`) | Used for |
|---|---|
| `sova-mark.svg` | Brand mark in the sidebar head (accent colored). Astra's Fold, drawn on the system grid |
| `plus.svg` | New Session |
| `panel-collapse.svg` / `panel-expand.svg` | Collapse sessions pane (the head's last button) / Expand sessions pane (the spine's first item), §app.session-list/spine: a rounded square, a divider a third in, and a chevron in the wide side pointing left / right. One drawing, mirrored. New, drawn on the system grid |
| `search.svg` | Search field glyph; tool card for `grep` / `find` / `ls` |
| `close.svg` | Clear search, close dialog |
| `chevron-left.svg` | Back to list (folded width only) |
| `chevron-right.svg` | Disclosure twist (rotates 90° when open) |
| `chevron-down.svg` | Jump to Latest, the mode trigger |
| `terminal.svg` | The tool card for `bash`, and the "Ran `/cmd`" info row |
| `file.svg` | Tool card for `read` / `write` / `edit` |
| `more.svg` | Tool card for any other tool |
| `copy.svg` | Copy Session Path, Copy Output |
| `archive.svg` | Archive Session / Unarchive Session (session head, web sessions only, §app/session-list "Archiving"): a lidded box. New, drawn on the system grid |
| `chevron-left.svg` / `chevron-right.svg` | Also: lightbox Previous Image / Next Image |
| `check.svg` | The copy button's icon for 1.5s after a copy; the current-model mark |
| `folder.svg` | Folder picker rows, cwd group label |
| `info.svg` | Info rows, info banners |
| `alert-circle.svg` | Error banners, warn banners |
| `attention.svg` | Composer reason when the session is read only |
| `clock.svg` | "Reconnecting" reason; the outline strip's Open Timeline button (§chat/timeline) |
| `bell.svg` | The wake-nudge card in the transcript (§chat/transcript) |
| `refresh.svg` | Refresh Usage / Refresh Agents: the icon button in the insights head (§app/insights). While a refresh it started is in flight it's `aria-disabled` and `aria-busy`. The session list has no refresh button: it updates live |
| `arrow-right.svg` | Send |
| `stop.svg` | Stop (composer): a rounded square |
| `chat.svg` | Empty-state mark (no session selected) |
| `attach.svg` | Attach Images (composer). New, drawn on the system grid |
| `command.svg` | Commands button (composer, §chat/slash-commands): a `/` in a rounded square. New, drawn on the system grid |
| `image.svg` | Tool-card image count, drop overlay. New, drawn on the system grid |
| `pencil.svg` | Draft rows (§app/session-list): the lead of line 2, before the draft's preview. A pen at 45° with a nib, legible at `.icon-sm`. New, drawn on the system grid |
| `gauge.svg` | Usage: the sidebar foot's Usage row. Sova's own, drawn on the system grid |
| `sliders.svg` | Mode: the mode trigger at the right end of the composer foot (§chat/mode-menu). Three tracks with an offset handle each. New, drawn on the system grid |
| `worker.svg` | Agents: the sidebar foot's Agents row, plus the Teams and Subagents section heads (from the skill's set) |
| `settings.svg` | Settings: the gear at the right end of the sidebar foot's Agents row, and the Settings dialog's tab rail. A cog on the system grid (the skill ships a sun-burst under this name)
| `branch.svg` | The fork-point row in a forked member's transcript, the `Align to Fork` button, and the welcome screen's `Fan Out…` button (§workspace/groups, §workspace/fanout) |
| `check-circle.svg`, `x-circle.svg`, `external.svg`, `menu.svg` | Reserved. Shipped but unused in the MVP |

`/favicon.svg` is the mark on dark paper. Link it from `index.html`:
`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`.

## §design.ground-rules/voice — Voice (fold-ai-dev, en-US)

Four pillars, all at once: calm, concrete, warm, and candid. The rules that matter most here:

- Buttons use **Title Case** and name their object: `New Session`, `Create Session`, `Stop`,
  `Copy Session Path`. All other text is sentence case.
- Use digits, never spelled-out numbers ("3 sessions"). Relative time in lists ("2h ago",
  "yesterday", then "Mar 4"). A 24-hour clock in mono inside the transcript (`14:06`).
- No exclamation marks, no apologies, no "Oops". An error has three beats: what happened · what it
  means for your work · what to do next.
- "We" means the product. Refer to the agent by its model id (for example `claude-opus-5`), and
  to the user as "you".
- An empty state leads with a live fact and states the absence second.

## §design.ground-rules/color-budget — Color budget

Spend `--color-accent` on only three things:

1. The one primary button in view (Send, or Create Session inside the dialog).
2. The live indicator (`.chip-live` and `.live-dot`), and every TUI mark — the sidebar row's
   rail `TUI` chip (`.session-rail-tui`, the word, no dot), the spine tile's `.spine-dot-live`,
   the session head's `TUI` chip (`.chip.chip-accent`, dot and word) and the `{n} TUI` count
   under search (`.chip.chip-accent.chip-count`, dot and count) — all of which are accent but
   **static** (see Motion).
3. Focus rings and links.

Selected rows and user bubbles take `--color-accent-tint`. Anything else that "needs color" is a
status (`--status-*`), and always pairs a dot or icon with a word.

## §design.ground-rules/motion — Motion

State changes use `--dur-fast` and `--ease-standard`. The modal, scrim, toast, and Jump to Latest
fade in over `--dur-base`. Only two things loop:

- The `live-pulse` on `.chip-live .chip-dot` and `.live-dot`. It means work is happening now.
  In the sidebar's row rail that is `.session-rail-state.chip-live .session-rail-dot` (Busy) and
  `.session-rail-count-live .icon`, at most one of them per row; a folder head holding an agent
  at work pulses the same dot (`.session-group-active .session-rail-dot`). In the collapsed pane
  (the spine, §app/session-list) it is `.spine-dot-busy` and `.spine-dot-working`, one dot per tile, and nothing
  else in the spine moves.
- The skeleton sweep.

**TUI never pulses — Busy and running tools own the pulse.** This holds on every surface: the
sidebar row's rail `TUI` chip (§app/session-list), the spine's `.spine-dot-live`, the session head's `TUI` chip
(§chat/transcript), and the `{n} TUI` count under search. The three chips take `.chip-accent` **without**
`.chip-live`. A TUI holding a file open is
*ownership*, and a count of them is a tally; neither is work in flight. What moves is our own
run: Busy in a row, the composer's `.run-status` live dot, a Running tool card, and a
live-sourced Working chip. This inverts the rule this file used to state ("the pulse belongs to
Live alone"), and it is the reason the pulse now means something: it stops when the work does.

No typing cursor blinks, and streamed text simply appears. `tokens.css` turns off every animation
under `prefers-reduced-motion`.

---

