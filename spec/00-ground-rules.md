# 00 · Ground rules
> Part of the pi-web design spec · [overview](overview.md)

## Theme

Dark is the default. `<html>` with no attribute renders dark; `<html data-theme="light">` renders
the full light set. MVP ships no theme toggle. If one is added later, persist it in
`localStorage` and set the attribute before first paint.

## Icons

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
| `pi-web-mark.svg` | Brand mark in the sidebar head (accent colored). pi-web's own mark, drawn on the system grid |
| `plus.svg` | New Session |
| `search.svg` | Search field glyph; tool card for `grep` / `find` / `ls` |
| `close.svg` | Clear search, close dialog |
| `chevron-left.svg` | Back to list (folded width only) |
| `chevron-right.svg` | Disclosure twist (rotates 90° when open) |
| `chevron-down.svg` | Jump to Latest, the mode trigger |
| `terminal.svg` | The tool card for `bash`, and the "Ran `/cmd`" info row |
| `file.svg` | Tool card for `read` / `write` / `edit` |
| `more.svg` | Tool card for any other tool |
| `copy.svg` | Copy Session Path, Copy Output |
| `archive.svg` | Archive Session / Unarchive Session (session head, web sessions only, §2 "Archiving"): a lidded box. New, drawn on the system grid |
| `chevron-left.svg` / `chevron-right.svg` | Also: lightbox Previous Image / Next Image |
| `check.svg` | The copy button's icon for 1.5s after a copy; the current-model mark |
| `folder.svg` | Folder picker rows, cwd group label |
| `info.svg` | Info rows, info banners |
| `alert-circle.svg` | Error banners, warn banners |
| `attention.svg` | Composer reason when the session is read only |
| `clock.svg` | "Reconnecting" reason; the outline strip's Open Timeline button (§13) |
| `bell.svg` | The wake-nudge card in the transcript (§3) |
| `refresh.svg` | Refresh Usage / Refresh Agents: the icon button in the insights head (§10). While a refresh it started is in flight it's `aria-disabled` and `aria-busy`. The session list has no refresh button: it updates live |
| `arrow-right.svg` | Send |
| `stop.svg` | Stop (composer): a rounded square |
| `chat.svg` | Empty-state mark (no session selected) |
| `attach.svg` | Attach Images (composer). New, drawn on the system grid |
| `command.svg` | Commands button (composer, §4d): a `/` in a rounded square. New, drawn on the system grid |
| `image.svg` | Tool-card image count, drop overlay. New, drawn on the system grid |
| `pencil.svg` | Draft rows (§2): the lead of line 2, before the draft's preview. A pen at 45° with a nib, legible at `.icon-sm`. New, drawn on the system grid |
| `gauge.svg` | Usage: the sidebar foot's Usage row. pi-web's own, drawn on the system grid |
| `sliders.svg` | Mode: the mode trigger at the right end of the composer foot (§4g). Three tracks with an offset handle each. New, drawn on the system grid |
| `worker.svg` | Agents: the sidebar foot's Agents row, plus the Teams and Subagents section heads (from the skill's set) |
| `settings.svg` | Settings: the gear at the right end of the sidebar foot's Agents row, and the Settings dialog's tab rail. A cog on the system grid (the skill ships a sun-burst under this name)
| `check-circle.svg`, `x-circle.svg`, `external.svg`, `menu.svg`, `branch.svg` | Reserved. Shipped but unused in the MVP |

`/favicon.svg` is the mark on dark paper. Link it from `index.html`:
`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`.

## Voice (fold-ai-dev, en-US)

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

## Color budget

Spend `--color-accent` on only three things:

1. The one primary button in view (Send, or Create Session inside the dialog).
2. The live indicator (`.chip-live` and `.live-dot`), and every TUI mark — the sidebar row's
   rail pill, the head's `TUI` chip, the `N TUI` count — all of which are accent but **static**
   (see Motion).
3. Focus rings and links.

Selected rows and user bubbles take `--color-accent-tint`. Anything else that "needs color" is a
status (`--status-*`), and always pairs a dot or icon with a word.

## Motion

State changes use `--dur-fast` and `--ease-standard`. The modal, scrim, toast, and Jump to Latest
fade in over `--dur-base`. Only two things loop:

- The `live-pulse` on `.chip-live .chip-dot` and `.live-dot`. It means work is happening now.
  In the sidebar's row rail that is `.session-rail-state.chip-live .session-rail-dot` (Busy) and
  `.session-rail-count-live .icon`, at most one of them per row.
- The skeleton sweep.

**TUI never pulses — Busy and running tools own the pulse.** This holds on every surface: the
sidebar row's rail pill (§2), the session head's `TUI` chip (§3), and the `N TUI` count under
search all take `.chip-accent` **without** `.chip-live`. A TUI holding a file open is
*ownership*, and a count of them is a tally; neither is work in flight. What moves is our own
run: Busy in a row, the composer's `.run-status` live dot, a Running tool card, and a
live-sourced Working chip. This inverts the rule this file used to state ("the pulse belongs to
Live alone"), and it is the reason the pulse now means something: it stops when the work does.

No typing cursor blinks, and streamed text simply appears. `tokens.css` turns off every animation
under `prefers-reduced-motion`.

---

