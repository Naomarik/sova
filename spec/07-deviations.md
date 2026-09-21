# 07 · Deviations from, and extensions to, fold-ai-dev
> Part of the pi-web design spec · [overview](overview.md)

| What | Why |
|---|---|
| Dark by default instead of following `prefers-color-scheme` | Requested for this dev tool. Light is still complete and equal, via `data-theme="light"` |
| App shell uses `@media`, not a container query | The shell is the window. It's the same exception the skill makes for `.toast-stack` |
| No rail and no bottom bar, and no three-pane desktop band | pi-web has one destination. The skill's "sidebar left, main right" at ≥768 is kept |
| `.modal` restyles itself into a sheet under 768 | The skill requires a sheet at folded width. Doing it in CSS means the frontend writes one markup |
| New product components: `.app`, `.sidebar-*`, `.search`, `.session-*`, `.transcript*`, `.disclosure*`, `.toolcard*`, `.info-row`, `.run-status`, `.jump-latest`, `.composer*`, `.folder-list`, `.folder-field*`, `.folder-picker*`, `.folder-crumb*`, `.brand`, `.live-dot`, `.chip-live`, `.icon`, `.skip-link`, `.truncate`, `.banner-main/-action`, `.message-time/-text`, `.modal-spacer`, `.timeline*`, `.settings-*`, `.sidebar-foot-row`, and the skill's `.sheet-grip` and `.toggle*` switch brought in (selectors `~`, so the box can sit at the row's right end) | Built only from system tokens and patterns. The tool card is the skill's tool-turn chat style (sunken, mono) turned into a disclosure so arguments and output fit. `.chip-live` applies the skill's run-pulse to a chip |
| Settings modal is wider: `.modal-wide` grows the sheet to 760px (the skill caps modals at 520px) | A left tab rail and a panel must fit beside each other (§12); under 768px it collapses to the skill's sheet with the rail as a horizontal row |
| Insights components: `.sidebar-foot`, `.insights*`, `.usage-*`, `.team-*`, `.agent-card`, `.member-*`, `.outline*`, `.compaction*`; the skill's `.card-*` and `.meter*` families brought in | Built from system tokens and the skill's card, meter, list, chip, and disclosure patterns (§10) |
| `.meter-fill` is `--color-ink-muted`, not `--color-accent` | pi-web's accent is reserved for primary, live, and focus (§0). At ≥80% the fill turns `--status-warn`, at ≥100% `--status-error`, always under a chip that says the word |
| Subagents pane (§11): `.run-status-link`, `.app-subagents`, `.subagents-*`, `.subagent-row*`, and a third `.app` column from 1280px | A fourth window width the shell branches on, besides 768. It's where the session pane can keep `--main-min` beside the pane; below it the pane is a drawer. Built from the list, chip, empty, banner, and chat patterns |
| New tokens: `--sidebar-width`, `--composer-max`, `--tool-output-max`, `--outline-max`, `--scrim`, `--skeleton-sweep`, `--main-min`, `--subagents-width`, `--subagents-list-width` | Layout sizes, plus the two alpha values the skill already hard-codes inline (scrim, skeleton sweep), lifted into tokens so they theme correctly |
| Brand: `pi-web-mark.svg` (a stroked π) and the wordmark "pi-web" set in Inter 640 at −.03em | The Fold symbol is not used. It's a placeholder mark on the system's icon grid, and swappable |
| Composer buttons go icon-only under 480px of composer width (`.button-label` visually hidden) | Keeps the textarea usable at 320px while streaming. Each button keeps its accessible name, and Send stays the filled primary |
| Lightbox is a native `<dialog>` rather than the skill's `.scrim` + `.modal` | Top layer, inert page, and native Esc handling. It's full-bleed because it shows content rather than asking a question |
| Model picker is a `[popover]` + combobox + listbox (the skill's `.popover` is a plain action menu) | Choosing one value from a set is a listbox. The popover gives top layer and light dismiss. Rows keep the 44px target and hover/active never hide an action |
| `Ctrl+P` is taken over in chat sessions | Mirrors pi's TUI palette. It's bound only where a model can change, so print still works everywhere else |
| `.button-sm` used for Retry, Copy Output, and Open for Chat | Always inside an already-reached context (a banner or a card), never the sole action on a surface, which the skill allows |
| A mono clock is the Timeline tab's primary time (§13), with the relative form in `title` | §0 prescribes relative time in lists and the mono 24-hour clock in the transcript. An axis is a list that claims an order, and "2d ago" on forty rows can't be read against itself; tabular digits down one column can. Both forms ship on every row — the clock visible, the absolute and relative pair in the `title` |
| The outline strip (§10) light-dismisses: a `pointerdown` outside it, or Esc from inside, closes it | The product's first click-away dismissal, and the only disclosure with one. The strip is in flow and spends up to `--outline-max` of the transcript, so it behaves like a menu rather than a section: it is never persisted, it closes on nav, and it gives the reading column back on the first press elsewhere. Its Esc never calls `preventDefault`, so no other Esc in the product changes |
| A workspace is N full chats in one view (§14), with one horizontal scroller of panes | The skill has no multi-conversation surface. Each pane is the skill's chat pattern unchanged; what is new is the row that holds them, and the 440px floor it enforces is `--main-min`, the same number the session pane already defends |
| Horizontal scrolling and scroll snapping in `.workspace-row` | The product's only horizontal scroller. An uncapped member count has to overflow on some axis, and one row keeps "left of" and "right of" true for the keyboard move controls; snapping is `proximity`, so two panes can still be parked half-and-half |
| Two composers on screen, one of them the only accent (§14) | §0 allows one primary in view, so a pane's Send drops to secondary while a workspace is open. The accent marks the choice worth marking: the message that goes to all of them |
| A collapsed composer state (`.composer[data-collapsed]`) that keeps every control at 44px | The skill has no dense composer. It sheds the foot (model, mode, reason — reference, not action) and pins the textarea to one line; nothing leaves the tab order and nothing goes under the tap minimum, so it is a height change rather than a reduced control set |
| One live region for N panes, with a mandatory member prefix | The skill's per-surface region assumes one stream of events. N regions interleave with no ordering guarantee; one queue plus a prefix is the only way three finishes in the same second read as three facts |
| `Ctrl+Alt+Left` / `Ctrl+Alt+Right` move pane focus | The product's second key takeover after `Ctrl+P`. `Alt+Arrow` is history and `Ctrl+Arrow` is word navigation in the N textareas on screen, so the third modifier is the only free one. Bound in the workspace only |
| New components: `.workspace`, `.workspace-*`, `.workspace-pane*`, `.group-composer*`, `.fanout-*`, `.fork-marker`; new tokens `--workspace-pane-min`, `--workspace-pane-width` | Built from the skill's chat, tabs, list, chip, banner, modal, and empty patterns and from system tokens only |
| `branch.svg` leaves the reserved set (§0) | It marks the fork point in a forked member's transcript (§14b) and the `New fanout` row, which is the first thing in the product that is about lineage |
| `--measure` grows from 72ch to a 110ch cap with the pane from unfolded up (the skill fixes it at 72ch) | Requested: the chat column was too narrow on desktop. A transcript is mostly code, diffs, and tool output rather than running prose, and they wrap badly at 72ch. Folded width keeps 72ch exactly (§3 "Column width") |

Everything the skill forbids stays forbidden: no gradients (except the skeleton sweep the skill
documents), no blur, no tinted shadows, no color-only state, no decorative accent, no exclamation
marks, no weights outside 400/530/600/640, no icon library, and no looping animation except the
live pulse and the skeleton.

---

