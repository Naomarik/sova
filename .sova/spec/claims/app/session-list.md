# §app/session-list — Session list (sidebar)
> Part of the Sova design spec · [overview](../design/overview.md)

## §app.session-list/anatomy — Anatomy

```html
<aside class="app-sidebar" aria-label="Sessions">
  <div class="sidebar-head">
    <a class="brand" href="#/"><svg class="icon" aria-hidden="true">…sova-mark…</svg>sova</a>
    <!-- folded (<768) only: the overview (§app.shell/overview) -->
    <button class="button button-icon button-ghost sidebar-overview" type="button" aria-label="Overview"
            title="Overview"><svg class="icon" aria-hidden="true">…grid…</svg></button>
    <span class="sidebar-spacer"></span>
    <button class="button" type="button"><svg class="icon" aria-hidden="true">…plus…</svg>New Session</button>
    <!-- unfolded (≥768) only: collapses the pane into the spine (§app.session-list/spine) -->
    <button class="button button-icon sidebar-spine-toggle" type="button" aria-expanded="true"
            aria-label="Collapse sessions pane" title="Collapse sessions pane · Ctrl/⌘+B">
      <svg class="icon" aria-hidden="true">…panel-collapse…</svg></button>
  </div>

  <!-- The one toolbar line (§app.session-list/search), the same at every width. At rest: -->
  <div class="sidebar-search" role="search">
    <label class="visually-hidden" for="session-search">Search sessions</label>
    <div class="sidebar-toolbar">
      <!-- the count is never printed on the line: kept in the DOM, visually hidden, for the field's
           description and the live count -->
      <p class="search-count visually-hidden" id="session-count" aria-live="polite">48 sessions</p>
      <!-- not in selection mode (§app.session-list/selecting-several-sessions) -->
      <button class="button button-sm button-ghost sidebar-select-start" type="button">…check…Select</button>
      <button class="button button-icon button-ghost" type="button" aria-label="Search sessions"
              title="Search sessions · /">…search…</button>
      <!-- the Overseer entry button (§app.overseer/entry-button), with its unread badge -->
      <a class="button button-sm button-ghost overseer-entry" href="#/overseer" aria-label="Overseer"
         title="Overseer · Alt+O">…eye…Overseer</a>
    </div>
  </div>
  <!-- search open (the icon pressed, or a query in force): -->
  <div class="sidebar-search" role="search">
    <label class="visually-hidden" for="session-search">Search sessions</label>
    <div class="sidebar-toolbar">
      <div class="search">
        <svg class="icon" aria-hidden="true">…search…</svg>
        <input class="input" id="session-search" type="search" placeholder="Title, folder, or tag"
               aria-describedby="session-count" autocomplete="off" spellcheck="false">
        <!-- only when the query is non-empty -->
        <button class="button button-icon" type="button" aria-label="Clear Search">…close…</button>
      </div>
      <button class="button button-icon" type="button" aria-label="Close Search" title="Close Search">…close…</button>
      <p class="search-count visually-hidden" id="session-count" aria-live="polite">12 of 48 sessions</p>
    </div>
  </div>

  <nav class="sidebar-list pane" aria-label="Session list">
    <!-- First region: Needs you (§app.session-list/needs-you), only while a session is blocked on
         you. Then Recent (§app.session-list/recent), then the user's own groups (§app.session-list/groups),
         then Profiles (§app.session-list/profile-shelf), only while a session runs with a profile.
         All four omitted here for length. Live & web comes next (below); then Organizations
         (§app.session-list/organizations), then the Archive (§app.session-list/regions-top-and-archive). -->
    <details class="session-group" aria-labelledby="g-1" open>
      <summary class="session-group-head">
        <h3 class="list-group-label" id="g-1" title="/home/user/webapps/sova">
          <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
          <svg class="icon icon-sm" aria-hidden="true">…folder…</svg>
          <span class="session-group-path"><bdi>~/webapps/sova</bdi></span>
          <!-- only while an agent works in the folder: Busy's dot, pulsing (Content rules) -->
          <span class="session-group-active" title="An agent is working in this folder">
            <span class="session-rail-dot"></span><span class="visually-hidden">, an agent is working here</span></span>
          <span class="text-num">4</span>
        </h3>
      </summary>
      <ul class="list">
        <!-- The rail is the row's state, on the LEFT: the word TUI, or Busy's bare dot, then a
             worker count. Every row has one, even an empty one, so every title starts on the
             same edge:

               [=] ~/webapps/sova                              4
              TUI   Add a watch endpoint for TUI sessions
              3 ⚙   Wiring /ws/watch to the session tailer       (7)
                    2h ago · claude-opus-5                        ◔
            2├──30px──┤2├───────── 270 at a 320px sidebar ─────────┤

             Line 1 is the title and no indicator — the rail exists because
             chips beside the title cost it width. Only inline marks may lead
             it (below: the turn-error mark or the unread dot, then the needs-you mark). Lines 2 and 3 each carry
             ONE indicator on a shared right edge: the topic count on the
             "now" line, the context ring on the meta line.
        -->
        <li class="session-row-shell session-row-shell-current">
          <div class="session-rail">
            <!-- at most one state: the TUI word (accent, static) or, when nothing holds it in a
                 TUI, Busy — <button class="session-rail-item session-rail-state chip chip-info
                 chip-live"> holding one <span class="session-rail-dot"> and no word (info, pulsing) -->
            <button type="button" tabindex="-1"
                    class="session-rail-item session-rail-state session-rail-tui chip chip-accent"
                    aria-label="Open in a TUI. Pid 8124, status working."
                    title="Open in a TUI · pid 8124 · working">TUI</button>
            <!-- only when n > 0; a bare figure, no icon; .session-rail-count-live pulses the figure
                 unless Busy already pulses -->
            <button type="button" tabindex="-1"
                    class="session-rail-item session-rail-count session-rail-count-live"
                    aria-label="3 subagents working now" title="3 subagents working now">
              <span class="text-num">3</span>
            </button>
          </div>
          <a class="list-row list-row-interactive session-row" href="#/s/…" aria-current="page">
            <div class="list-main">
              <!-- line 1 may lead with inline marks, each aria-hidden with its words in a hidden span:
                   ONE leading state mark (§app.overseer/seen), in one slot:
                     turn error   alert-circle, --status-error   "Turn failed. "   when `turnError` is set:
                                  the last turn stopped with an error (pi's stopReason "error"), since
                                  you looked — even on a session Sova never stamped. Its span's `title`:
                                  "The last turn stopped with an error: {message}", or without a message
                                  "The last turn stopped with an error."
                     unread dot   7px accent dot                 "New activity. "  otherwise, when `unread` is set
                   The error takes the dot's place, never sits beside it: an errored reply since you
                   looked is new activity too. Both come from the server and clear on a visit alike.
                   Then at most ONE needs-you mark, the most urgent kind first:
                     questions    count alone, --color-accent    "3 open questions. "  (§chat.alignment/session-mark)
                     asks-you     chat,         --color-accent   "Asks you something. "  (§app.decisions/asks-user)
                     looping      refresh,      --status-warn    "May be looping. "  (a subagent's: "A subagent may be stuck. ")
                   Open questions come from the session's `align` counts; asks-you and looping from the server's
                   attention signals (the session's `signals.kinds`, and its subagents'
                   `workerSignals` counts, §app.decisions/attention-signals); kind precedence first,
                   then the session's own signal over its subagents'. The glyph sits in a span whose
                   `title` says the fact in one sentence ("3 open questions in 2 alignments", "The
                   last reply asks you something.", "The last turn looks like it went in circles.",
                   "A subagent looks stuck.").
                   Kinds differ in shape as well as tone: questions are the bare accent count, no glyph. The looping mark is gone once the session
                   is seen after it was classified; asks-you stays until the user answers (their next turn replaces it); open questions stay until they are answered, the user moves on, or align is turned off. No
                   mark shows while this tab runs a turn there.
                   Every line-1 mark is hidden on the open session,
                   so this row (the open one) has none; on another row line 1 reads:
                   <p class="list-title"><span class="session-unread" aria-hidden="true"></span><span
                     class="visually-hidden">New activity. </span><span class="session-signal-wrap"
                     title="3 open questions in 2 alignments"><span class="icon icon-sm session-signal
                     session-signal-questions" style="--icon:url(/icons/chat.svg)" aria-hidden="true"></span><span
                     class="session-signal-count text-num" aria-hidden="true">3</span></span><span
                     class="visually-hidden">3 open questions. </span>{title}</p>
                   The subagent marks come only from `workerSignals`, which the server sends only while
                   they apply. -->
              <p class="list-title">Add a watch endpoint for TUI sessions</p>
              <!-- line 2: the "now" line, then the outline's topic count -->
              <div class="list-line list-summary-row">
                <p class="list-summary" title="…">Wiring /ws/watch to the session tailer</p>
                <span class="session-topics text-num" title="7 topics in this session">7</span>
              </div>
              <!-- line 3: time, then the worktrees the session tracks, "2 of 3" merged of the ones
                   it owns (§chat.worktrees/readiness) — a 12px branch glyph and the bare figure in
                   the meta's own muted voice, both in success while one of them is ready to merge,
                   never wrapped and never grown, the digits aria-hidden with the words beside them
                   for AT:
                   <span class="session-worktrees session-worktrees-ready" title="feat/x: ready to merge, checks passed"><span class="icon icon-sm" style="--icon:url(/icons/branch.svg)" aria-hidden="true"></span><span class="text-num" aria-hidden="true">2 of 3</span><span class="visually-hidden">2 of 3 worktrees merged, one is ready to merge</span></span>
                   — then the muted readiness badge when there is one ("restart pending", "2
                   follow-ups" — lowercase, the meta's own muted voice, no tone, never wrapped; its
                   `title` the per-worktree lines), then model, then the context ring. A tagged row's
                   `.list-meta` has the `title` "Topic: bug fix (tagged automatically)"; the topic
                   shows nowhere else on the row. A remote row opens the line with its
                   own mark (§app/session-list "Remote sessions"): one 6px muted dot before the time. Local rows
                   open with the time, as here. -->
              <div class="list-line list-meta-row">
                <p class="list-meta">2h ago · <span class="session-worktrees session-worktrees-ready" title="feat/x: ready to merge, checks passed"><span class="icon icon-sm" style="--icon:url(/icons/branch.svg)" aria-hidden="true"></span><span class="text-num" aria-hidden="true">2 of 3</span><span class="visually-hidden">2 of 3 worktrees merged, one is ready to merge</span></span> · <span class="session-readiness" title="feat/c: merged, 19 commits ahead">2 follow-ups</span> · <span class="text-mono" title="anthropic/claude-opus-5">claude-opus-5</span></p>
                <span class="context-ring {context-warn|context-error}" title="{the head's exact sentence}">
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <circle class="context-ring-track" cx="6" cy="6" r="5" fill="none"/>
                    <circle class="context-ring-fill" cx="6" cy="6" r="5" fill="none"
                            transform="rotate(-90 6 6)" style="stroke-dasharray:…;stroke-dashoffset:…"/>
                  </svg>
                </span>
              </div>
            </div>
            <span class="visually-hidden">, open in a TUI</span><span class="visually-hidden">, 3 subagents working now</span>
          </a>
        </li>
      </ul>
    </details>
  </nav>
</aside>
```

This is the **expanded** pane. From 768px up the pane has a second, collapsed form — the spine,
§app.session-list/spine — which replaces the head, the search, the list and the foot inside the same
`aside`. The head's last item is the button that collapses it: an icon button to the **right** of
New Session, a rounded square with a divider and a chevron pointing left (`panel-collapse.svg`).
Below 768px the button is not rendered, because the pane there is the whole screen and has
nothing to collapse into.

The row does not display spec assessment observations or append them to readiness titles.
Its ordinary worktree count, readiness badge, and three-line anatomy remain as above.

## §app.session-list/spine — The spine

The sessions pane, collapsed. From 768px up the pane is either **expanded** (everything above) or
the **spine**: a 64px (`--spine-width`) column of 44px targets, in the same
`aside[aria-label="Sessions"]`. It is the same pane in a narrower form, not a navigation rail —
Sova still has one destination (§app/shell "No rail and no bottom bar") — so it carries the pane's own
things: New Session, search, the sessions that moved last, the region counts, the live tallies and
the foot's doorways. The code, the CSS and this spec call it the spine; the UI never does. Every
label a person reads says "sessions pane".

```html
<aside class="app-sidebar" aria-label="Sessions">
  <div class="spine">
    <div class="spine-head">
      <button class="button button-icon spine-item" type="button" aria-expanded="false"
              aria-label="Expand sessions pane" title="Expand sessions pane · Ctrl/⌘+B">…panel-expand…</button>
      <button class="button button-icon spine-item" type="button"
              aria-label="New Session" title="New Session">…plus…</button>
      <button class="button button-icon spine-item" type="button"
              aria-label="Search sessions" title="Search sessions · /">…search…</button>
      <!-- the Overseer entry button (§app.overseer/entry-button), with its unread count -->
      <a class="button button-icon spine-item" href="#/overseer"
         aria-label="Overseer" title="Overseer · Alt+O">…eye…</a>
    </div>
    <nav class="spine-tiles pane" aria-label="Recent sessions">
      <a class="spine-tile" href="#/s/…" aria-current="page"
         title="{title} · {folder} · {model}{the row link's state clauses}"
         aria-label="{the same string}">
        <span class="spine-monogram" aria-hidden="true">AW</span>
        <!-- at most one: -live (TUI) | -busy (pi is replying) | -working (subagents) -->
        <span class="spine-dot spine-dot-live" aria-hidden="true"></span>
      </a>
    </nav>
    <!-- omitted when all four regions are off screen -->
    <div class="spine-regions">
      <!-- exactly while the Needs you region is shown (§app.session-list/needs-you) -->
      <button class="button button-icon spine-item spine-region" type="button"
              aria-label="Needs you · 2 sessions" title="Needs you · 2 sessions">…alert-circle…<span class="spine-count">2</span></button>
      <button class="button button-icon spine-item spine-region" type="button"
              aria-label="Live &amp; web · 12 sessions" title="Live &amp; web · 12 sessions">…chat…<span class="spine-count">12</span></button>
      <!-- exactly while the Organizations region is shown (§app.session-list/organizations); the warn
           dot and the name's waiting clause only while an org session waits on you -->
      <button class="button button-icon spine-item spine-region" type="button"
              aria-label="Organizations · 12 sessions · 2 waiting on you"
              title="Organizations · 12 sessions · 2 waiting on you">…building…<span class="spine-count">12</span><span class="spine-dot spine-dot-warn" aria-hidden="true"></span></button>
      <button class="button button-icon spine-item spine-region" type="button"
              aria-label="Archive · 40 sessions" title="Archive · 40 sessions">…archive…<span class="spine-count">40</span></button>
    </div>
    <!-- omitted when both tallies are 0 (the LLM tally: only a complete 0) -->
    <div class="spine-stats">
      <button class="button button-icon spine-item spine-stat" type="button"
              aria-label="3 LLM calls running now" title="3 LLM calls running now">…worker…<span class="spine-count">3</span></button>
      <button class="button button-icon spine-item spine-stat" type="button"
              aria-label="2 sessions open in a TUI" title="2 sessions open in a TUI">…terminal…<span class="spine-count">2</span></button>
    </div>
    <div class="spine-foot">
      <a class="button button-icon spine-item" href="#/usage"
         aria-label="{the usage glance sentence, else Usage}" title="{the same}">…gauge…</a>
      <!-- §app.resource-monitor/entry-button -->
      <button class="button button-icon spine-item" type="button" aria-label="Resource monitor" title="Resource monitor">…activity…</button>
      <a class="button button-icon spine-item" href="#/agents"
         aria-label="{the Agents row's full sentence}" title="{the same}">…worker…</a>
      <!-- §app.session-share/shares-page -->
      <a class="button button-icon spine-item" href="#/shares" aria-label="Shares" title="Shares">…external…</a>
      <button class="button button-icon spine-item" type="button" aria-label="Settings" title="Settings">…settings…</button>
    </div>
  </div>
</aside>
```

- **Collapsing and expanding.** Three ways, all the same toggle: the head's
  `.sidebar-spine-toggle` (expanded), the spine's first item (collapsed), and **Ctrl+B** (⌘+B on
  macOS) from anywhere in the app, from 768px up. Below 768px Ctrl/⌘+B does nothing and the
  head's toggle is not rendered: collapse is a desktop affordance. Each button says what it will do — "Collapse sessions pane" /
  "Expand sessions pane" — in its `aria-label`, and the same words plus the shortcut in its
  `title`; `aria-expanded` is `true` on the head's button and `false` on the spine's. The glyphs
  are one drawing mirrored: a rounded square, a divider a third of the way in, and a chevron in
  the wide side pointing where the divider will go — left to collapse (`panel-collapse.svg`),
  right to expand (`panel-expand.svg`).
- **Remembered, per browser.** The state persists in `localStorage["sova:sidebar-collapsed"]`,
  `"1"` collapsed and `"0"` expanded, written through `writeKey` like every other `sova:` key. Anything else reads as expanded. This is the
  one thing about the pane's size that persists — the dragged width still doesn't (§app.shell/resizing-the-sessions-pane) — because collapsing is a standing choice about the screen, not a posture
  for one task, and a pane that springs back open on every reload undoes it.
- **What a toggle says and where focus goes.** Every toggle, by button or by key, announces
  "Sessions pane collapsed." or "Sessions pane expanded." through the one polite live region
  (`announce()`). The pressed button is unmounted by the swap, so focus moves to the toggle of the
  new state — Expand after collapsing, Collapse after expanding — **but only when focus was inside
  the pane at the moment of the toggle**. Ctrl/⌘+B pressed from the composer, or a click with
  focus elsewhere, leaves focus where it was: the toggle must not steal it.
- **The open session stays in sight.** When the spine appears, the open session's tile, if it is
  among the Recent rows, is scrolled into view with `block: "nearest"`.
- **Unfolded only.** Below 768px the stored value is ignored, not cleared: the pane renders
  expanded, as it always has, because folded it is the whole screen. Widen the window and the
  spine comes back.
- **One knob.** While collapsed the app writes `--spine-width` into the inline `--sidebar-width`
  on `<html>`, and `.app` carries `data-spine="on"` (absent when expanded). The grid, the session
  pane's width and `--measure` all read `--sidebar-width`, so they follow with no rule of their
  own, and `.pane-resizer` is not rendered while the stored choice is collapsed (§app.shell/spine-column).
- **The head** — Expand, New Session, and Search sessions. New Session opens the New Session
  dialog, exactly as the head's button does. Search sessions expands the pane and moves focus to
  the search field: a search needs the list to show its hits in. Its `title` is "Search sessions ·
  /", the app's hint style (like "Collapse sessions pane · Ctrl/⌘+B"); its accessible name stays
  "Search sessions". The `/` key does the same thing: while collapsed it expands the pane and
  focuses the field, and expanded it just focuses the field (never from inside a text field).
- **The tiles are Recent** (§app.session-list/recent): the same sessions, in the same order, as many as the
  Settings count says — flat, no folders. A tile is a link to its session, 44 × 44, with a
  two-letter **monogram** in `--font-mono`, computed by `monogram()` in `src/lib/spine.ts`: the
  first letters of the title's first two words, or the first two letters of a one-word title,
  uppercased in the string itself (in code points, so an emoji stays whole). A title with no
  words has no monogram, and the tile shows the `chat` icon instead. The monogram is a
  place-marker, not a name — two sessions can share one — so the tile's `title` and `aria-label`
  are **one string**: "{title} · {folder} · {model}", the folder and model given the row's own
  treatment (`~`-shortened path, or the remote placement; a session with no model drops that
  part), followed verbatim by the clauses the row link's accessible name carries (§app.session-list/accessibility) — ", open in a TUI", ", pi is replying in this session", ", {n} subagents
  working now", and the remote mark's suffix. The open session's tile carries
  `aria-current="page"` and the row's current tint.
  With no Recent sessions the `nav` is still rendered, empty, so the groups below it don't move.
- **One status dot per tile**, top-right, from the row rail's own states and tones:
  `.spine-dot-live` (a TUI has it — `--color-accent`, static), `.spine-dot-busy` (pi is replying —
  `--status-info`, pulsing), `.spine-dot-working` (≥1 subagent working — a hollow
  `--color-ink-muted` ring, pulsing). The row can show a TUI pill and a worker count at once; a
  tile has room for one mark, so it shows the first that holds of **TUI, Busy, working** — the
  rail's own "TUI wins" order, then the aggregate last. The tile's name still says all of them.
- **Region counts.** Needs you, Live & web, Organizations and the Archive, each an icon over its count and named
  "{Region} · {n} sessions" in its `title` and `aria-label` (Organizations adds " · {k} waiting on you"
  and a warn dot at its corner while an org session waits, §app.session-list/organizations). **A button is shown exactly when its
  region is on screen in the expanded pane**, and `n` is the count that region shows now: with no
  search, the plain totals ("60 sessions", "321 sessions"); with a search on, each region's hit
  count — "22 sessions" while the Live & web head reads "22 of 60", "5 sessions" while the
  Archive's reads "5 of 321". Needs you's count is its rows, search or not. One rule decides both
  the region and its button (`showNeedsYou` / `showTop` / `showOrgs` / `showArchive` in `Sidebar.tsx`); a button derived from anything else, such as the Archive's
  total, is a door onto a region a no-hit search has removed. When neither region is on screen
  the whole `.spine-regions` box is omitted, not only its buttons — an empty box still draws its
  divider. Pressing a button expands the pane, scrolls that region into view, and moves focus to
  its first row: Live & web's first folder head or link, the Archive's, Organizations' and Needs you's own
  `<summary>`. The Archive's, Organizations' and Needs you's open state is **left to the user** — it is their stored choice, and the button never
  forces one open. If the region is gone by the time the pane has expanded, focus goes to the
  head's collapse toggle.
- **Live tallies.** The LLM calls in flight (§app.insights/llm-inflight) — the expanded foot's
  Agents row's own figure (the bare `{n}` whenever known, partial too, `–` while unknown) and its sentence, "3
  LLM calls running now" — shown unless the count is a complete 0; and
  "{n} sessions open in a TUI" (every live session, whatever the search filters), only at
  n ≥ 1, with `.spine-stats` omitted when both are left out. They are **facts, not doorways**: nothing
  opens. Pointer users get the sentence as the `title`; a tap raises the same sentence as a toast,
  the rail's precedent (§app.session-list/accessibility — there is no hover on touch).
- **The foot** — Usage (`#/usage`), Resource monitor, Agents (`#/agents`) and Settings, the
  expanded foot's two doorways and two buttons, in that order: the monitor sits right after the
  gauge, as it sits beside the Usage glance. Resource monitor opens the monitor modal, exactly as
  the foot's button does (§app.resource-monitor/entry-button). The glance sentences are not dropped at 64px, only unprinted: Usage's `title` and
  `aria-label` are the usage glance in full words (`glanceText()`), and Agents' are the Agents
  row's own sentence (§app.insights/sidebar-foot, e.g. "Agents: 3 LLM calls running now. On this
  host, subagents are working in 2 sessions and 1 team."). Usage
  falls back to "Usage" only when its sentence is empty — no usage cache to read.
  What has no room is the printed text, not the fact.
  A doorway to the page on screen carries `aria-current="page"` and the tint.
- **Layout.** Five groups top to bottom — head, tiles, regions, tallies, foot — each a column
  of 44px items centred with `--space-1` between and `--space-2` above and below, split by
  `--color-border` rules. The tiles are the scroll region (`.pane`) and take the height that's
  left; the other four are pinned. They cost 721px with every item shown (each of the four region doors, two tallies and four foot items is a 44px
  item and its 4px gap; 625px measured at 1400×1000 with three doors and three foot items, plus one door's 48px and the monitor item's 48px), so the tiles keep a floor of one tile (60px), and on a window shorter than that the whole spine scrolls instead.
  Neither scrollbar is drawn: a 10px bar in a 64px column pushes every item off the shared axis.
  **The cost:** nothing shows that the tiles scroll, beyond the tile cut at the edge. Recent is 5
  by default and 20 at most, and every tile is also a row in the expanded pane.

## §app.session-list/content-rules — Content rules

- **Grouping.** Group by `cwd`. Groups are ordered by their most recent `lastActiveAt`. Rows
  within a group are ordered by `lastActiveAt`, newest first. Each group label shows three
  things:
  - the path with `$HOME` shown as `~` (mono, and case is preserved),
  - the full path in `title`,
  - a count of the rows currently visible.

  Long paths truncate **from the left**, because the leaf folder is what people scan for. The
  `rtl` + `<bdi>` pair in `.session-group-path` handles this. Labels stick to the top while their
  group scrolls.
- **Folder open/closed state.** Every folder is a `<details>` and its label a `<summary>`, in
  every region alike: Live & web, inside a user group, and inside an Archive date section. The
  whole label toggles it and the chevron rotates 90° when open, as the Archive's sections do, and
  like them a folder is **collapsed by default**: whatever is active already shows in Recent, so a
  folder starts as one line and opening it is how its rows are reached.
  - A folder holding an agent at work — a row pi is replying in (this tab's own run first, then the
    list's `busy`), a TUI session whose status is `Running…`, or a row with subagents working —
    shows one pulsing Busy dot on its head, before the count (`folderActive`), so a collapsed
    folder still says something is running inside it. Its name gains ", an agent is working here".
  - The user's choice per folder lives in `sessionStorage["sova:folder-open-{idPrefix}-{cwd}"]`
    (`"1"`/`"0"`, `folderOpenKey` in `src/lib/folder-open.ts`, written through `writeKey`) for the
    browser session. The region
    prefix is part of the key, so the same folder under Live & web and inside a group are two
    separate choices — they are two sections, and one holds rows the other doesn't.
  - It opens **without** changing the stored choice while a search query is non-empty (every hit
    has to be visible); when the search ends it goes back to the stored choice (`folderOpen`).
    Unlike an Archive date section, holding the selected session does NOT force it open: an active
    session is already in Recent, and the folder keeps the user's choice.
  - A folder builds its rows only once it is first open (by the user, a stored choice or a
    search), and keeps them after it closes again. A folder never opened holds its head and count
    but no rows, so the browser's own find-in-page does not reach them; the sidebar search does,
    since it opens every folder with a hit.
  - The heading keeps its element, its level and its `id`: it sits inside the `<summary>`, which
    is what toggles, and `aria-labelledby` on the `<details>` still points at it. The sticky
    behaviour moves to the `<summary>` — a sticky heading inside a summary has nothing to stick in.
- **Remote sessions.** A session on a remote target (`SessionSummary.target`/`remoteCwd`, else a
  `cwd` under `~/.pi/agent/sova/targets/<target>/…`, which mirrors the remote folder) never shows
  that local placeholder. Its group label reads `terminal` icon, the target's `label` (else its
  name) and `·`, then the remote folder as-is: the target's `$HOME` isn't ours, so no `~` — but
  only while every row in the group runs at that one target and folder (`groupRemotePlaceOf` in
  `src/lib/remote-mark.ts`). A mixed group keeps the plain folder label — the `cwd` itself, `title`
  and all — and claims nothing about its rows, whose own marks say where each one runs. The target
  part never truncates; the folder truncates from the left like a local path. `title` is
  `name (host):/remote/path`. Labels come from `GET /api/targets`, fetched only when the list
  holds remote sessions and again when the set of targets it uses changes; if that fails, the name
  stands in. Search matches the target's name, label and remote folder instead of the placeholder.

  **Row remote mark.** Every remote row carries its own mark on line 3, at the left edge before
  the time: a 6px `.chip-dot` in the meta line's own muted ink — the connection dot's idiom
  without its tones, since remote-ness is a property of the row (`SessionSummary.target`/
  `remoteCwd`, per session), not of its group's first row, and a user group can mix remote rows
  with local ones beside them. The dot says "this runs on another host". `title` is
  `Remote: name (host):/remote/path.`. The mark never pulses and can't be taken for
  the live dot, for the same three reasons the connection dot can't: it lives in the meta line,
  not a row's rail, it is smaller, and it never pulses. It sits at the line's left edge, so the
  right-edge column — topic chip, context ring — is untouched. Like the topic chip and the ring
  it is inert (`title` and nothing else), with one difference: the row link's accessible name ends
  with a short hidden clause (", remote on {target}"), because which rows are
  remote is a fact a session is picked by, not a number watched one at a time.

  **Connection dot.** While a chat on that target is open in this tab, a 6px `.chip-dot` sits
  right after the target's label, before the `·`: success tone for `connected`, error tone for
  `unreachable`, the label's own muted ink for `last ok`, `checking…` and `no status` — the same
  reading as the head chip (§app.shell/remote-session-chips), from the freshest report among
  this tab's open chats on that target. It is `role="img"` with `aria-label="connection: <word>"`
  and a `title` starting `Connection: <word>` then the chip's hover text. It can't be taken for
  the live-session dot: it lives in the group label, not a row's rail, it is smaller, and it never
  pulses. With no chat open on the target there's no dot, since nothing is reporting. The
  always-on remote chip (§app.shell/remote-session-chips) lives in the session head and Session
  detail, not here: a uniform group's label and every remote row's own mark already say what and
  where, so the connection dot stays the sidebar's one mark that needs a live report.

  ```html
  <h3 class="list-group-label" id="t-2" title="acme-prod (192.0.2.10):/home/deploy/acme-site">
    …terminal, icon-sm… <span>acme prod</span>
    <span class="chip-dot chip-success" role="img" aria-label="connection: connected" title="Connection: connected …"></span>
    <span aria-hidden="true">·</span>
    <span class="session-group-path"><bdi>/home/deploy/acme-site</bdi></span>
    <span class="text-num">2</span>
  </h3>
  ```
- **Row line 1.** `SessionSummary.title`, truncated to one line; the full title goes in `title=`.
  The server shows "[preview link]" in place of a preview link this host keeps
  (§app.project-overseer/previews) in every title, `originalTitle`, summary line, draft preview
  and reply error, before it cuts any of them, so no part of one is ever listed.
  `Untitled` renders in `--color-ink-muted`. A session with a profile has its icon just before the
  title, in accent ink, with "Profile: {label}" as its `title` (§chat.profiles/after-first-message).
- **Draft rows.** An empty husk — a session whose file holds no user message anywhere — is never
  listed, with two exceptions: **a husk with a stored draft is** (§chat.composer/behavior, Drafts),
  and so is a husk that carries a profile (§chat.profiles/singleton), as an ordinary `Untitled` row. The server sends it
  with `SessionSummary.draftPreview`, the draft's first non-empty line cut to about 80 characters.
  A draft holding only images counts too, and its preview is the count: `1 image`, `2 images`.
  The row keeps its `Untitled` title in `--color-ink-muted`. Line 2 leads with the `pencil` icon,
  then the preview, in place of a "now" line (a husk has no outline, so there is no topic count
  beside it). The icon is decorative; the word "draft" is in the text, so the row's accessible
  name and the preview's `title` both say it's a draft: `Draft: {preview}`. That is what keeps a new session you started typing in from vanishing
  on reload. Send the draft and it becomes an ordinary row; clear it and the husk drops out of the
  list again.

  ```html
  <li class="session-row-shell">
    <div class="session-rail"><!-- empty: nothing is live, nothing is running --></div>
    <a class="list-row list-row-interactive session-row" href="#/s/…">
      <div class="list-main">
        <p class="list-title list-title-muted" title="Untitled">Untitled</p>
        <!-- line 2 is the draft's own first line; no topic count, no "now" line -->
        <div class="list-line list-summary-row">
          <span class="icon icon-sm" style="--icon: url(/icons/pencil.svg)" aria-hidden="true"></span>
          <p class="list-summary" title="Draft: Refactor the auth module before the trip"><span class="visually-hidden">Draft: </span>Refactor the auth module before the trip</p>
        </div>
        <!-- an image-only draft: the same line reads "✎ 2 images" -->
        <div class="list-line list-meta-row">…line 3, as always…</div>
      </div>
    </a>
  </li>
  ```

  The pencil is pinned to the line box (`--fs-micro` × `--lh-micro` square, not `.icon-sm`'s
  16px), never shrinks, and takes `--color-ink-muted`, so a draft row is exactly as tall as its
  neighbours and the icon stays quieter than the preview beside it.
- **Row line 2.** `SessionSummary.outlineGist`, the outline's "overall" line from the session's
  latest `topic-outline` snapshot: **what the session is for**, not what the agent is doing this
  second. The line truncates after a few words in a narrow rail, so what stands there has to be the
  thing that makes this session recognizable — "Sova theming: palette, fonts, Themes tab", never
  "The round is committed as dc63576 with …". Snapshots written before the gist existed fall back
  to `outlineNow`, the rolling "now" line, so those rows keep the line they had. The snapshot is
  the last one in the file however far back it lies — the same one the thread's Current goal strip
  opens with (§app/insights) — not only one near the end: the server reads back from the end until
  it finds one, once per file, and after that reads only what is appended. Rendered only when
  present: `--fs-micro` in `--color-ink-2`, one line truncated with an ellipsis. `title=` carries
  the full line, and the "now" line under a `Now: ` label when it says something else — the latest
  activity is one hover away, never in the row. Sessions without any outline (older sessions, or
  topic-outline off) omit the line entirely — the row is then title over meta, as before. So does
  every row while Settings → General's **Summary line** switch is off
  (§app.settings-dialog/general): this browser then draws no summary line on any row. A draft
  row's preview, which is not a summary, stays, and so does a Needs you row's reason
  (§app.session-list/needs-you).

  The line also carries the session's **topic count**, at its right end: a
  `.chip.chip-count.session-topics` holding a bare figure, `title` "{n} topics in this session",
  shown only when the count is ≥ 1. It comes from the **same outline snapshot** as the line it sits
  beside (`readTailOutline` returns gist, "now" and count from the accepted entry), so the sentence
  and the figure can never disagree. No count, no chip — and no chip without a summary line either,
  since the line is what it rides on: a hidden line hides its count.
- **Row line 3.** The worktrees the session tracks **lead the facts after the time**, when the
  server has read at least one (§chat.worktrees/readiness): a 12px `branch` glyph and a bare figure,
  "{merged} of {total}" — "0 of 1", "2 of 3" — over the session's own, non-dropped worktrees, in
  the meta's own muted voice, {merged} counting each one git finds merged into its base, clean or
  not (a merged tree with uncommitted changes counts though its state reads stale or in progress,
  §chat.worktrees/readiness "The row's count"), `white-space: nowrap`, its `title` each worktree's state and reason.
  Both the glyph and the figure take `--status-success` while **one or more** of those worktrees is
  ready to merge, which includes one waiting for your OK: the light is the row's whole word for it,
  so the row that can be merged is the row that glows — no check, no phrase. No worktrees, or none
  the server has read yet, means no count at all, never "0 of 0". The digits are `aria-hidden` and
  the row's accessible name carries the words ("2 of 3 worktrees merged, one is ready to merge").
  The muted readiness badge follows it when there is one: "restart pending", or the follow-up count
  ("1 follow-up", "2 follow-ups") — never the word "merged", which the count already says — and a
  leftover worktree is only in the `title`, never counted. The line truncates from its end, so the
  model's name gives way first, then the badge, then the count, the time last — at a 280px desktop
  sidebar and on a 390px phone alike. Then relative `lastActiveAt` ("just now", "4m ago", "2h
  ago", "yesterday", "Mar 4"), then ` · `, then the model in mono. Show only the part after the first
  `/` and put the full
  `provider/model` in `title`. If `model` is null, omit the separator and the model. The line is
  `--fs-micro`, the model's mono included: two facts, never a sentence, under a title and a summary
  that carry the row (Tokens below). A remote row
  opens the line with its remote mark ("Remote sessions" above); the time follows the line's own
  gap.

  The line ends with the **context ring** (§chat/context-window): a 12px ring whose arc is the share of the window
  the last reply left filled, `.context-warn` at ≥80% and `.context-error` at ≥95% — the same
  `contextStep` the head's gauge uses, so a row and the session it opens step together. Its
  `title` is the head's exact sentence. It and the session pane's worker ring are the only
  places in the product where the context fill is a shape instead of a number, and
  §chat.context-window/sidebar-ring writes that exception down.
- **No assessment line.** Session rows display no spec assessment observations; the ordinary
  row anatomy and geometry apply without an assessment-line exception.
- **Lines 2 and 3 are `.list-line`.** Each is a flex wrapper: the text block flexes and truncates,
  the indicator is `flex: none`. That puts the chip and the ring on **one right edge** down the
  whole list, which is the entire point — a ring that slid left and right with the text beside it
  would be decoration, not a column you can scan. Line 1 gets no wrapper and no indicator, ever:
  the right-hand chips that used to squeeze the title are why the rail exists.
- **Row state lives in a left rail.** Every row is a `li.session-row-shell`: a 30px
  `.session-rail` column with a **2px horizontal margin** of its own, then the row link — a 34px
  gutter in all. The margin is where the breathing room lives: not padding inside the rail, and
  not a margin on an item, so the rail's box (x=2…32) stays symmetrical and everything in it
  centres on one axis, x=17. Busy's 26px box therefore sits **4px** off the panel edge — the 2px
  margin plus 2px of centring slack — and the TUI chip and the count, each as wide as its own
  content, centre on that same axis (measured: 16.99 for both).
  The rail is deliberately **outboard** of the
  list's 16px text inset: it is a gutter the eye skips, not a column of content, and the titles
  start a bare 2px right of where the old rows' text did. The rail is reserved on **every** row, including the ones
  with nothing to say, so 278 titles start on one left edge instead of jittering with whatever
  chip the row happens to carry. Every folder, in every list (Live & web, the Archive, each
  group), wraps its head and rows in one guide rule: a 2px `--color-border` rule flush with the
  pane edge, then 2px of padding, so the folder's content sits 4px in and reads as one block. The
  rule sits outside the rows' 34px rail, whose hover and open-row fills start after it; a sticky
  folder head keeps its own surface. The shell owns the divider, the hover
  (`--color-sunken`) and the open-row tint (`--color-accent-tint`, via
  `.session-row-shell-current`), so the rail is skin, not a dead zone. Rail items are
  `<button type="button" tabindex="-1">` — pointer and AT affordances, never tab stops
  (Accessibility below).
- **One word, one dot.** The rail carries at most two things, stacked: a state, then a worker
  count. TUI ships its word, `TUI`, in a chip narrower than the rail's slot, so it costs no title.
  Busy stays a wordless dot, and with the spine's tile dots it is one of the two sanctioned
  wordless statuses; the trade is written down under Accessibility.
- **Each item sits on the title's first line.** The rail starts at the row link's own top padding,
  and the title's first line is a `--lh-body` box (22.475px at `--fs-body`), so each item is
  placed by that line box rather than by a literal: Busy's box *is* the line's height, and the
  16px TUI chip and a lone 16px count each take `calc((--fs-body × --lh-body − 16px) / 2)`
  (3.24px) above them. Measured at HEAD: the TUI chip's centre, a lone count's and Busy's dot's
  are each on the first line's centre (delta 0.00, 0.01 and 0.01px).
- **TUI chip.** Shown when `live !== null`:
  `.session-rail-item.session-rail-state.session-rail-tui.chip.chip-accent` holding the text
  `TUI` — the same word as the session head's `TUI` chip — and
  no dot. It is a `--color-surface` plate with **no outline at rest**: its 1px border is
  transparent and turns `--color-border-strong` on hover (`.session-rail-tui:hover`), the rail's
  only hover outline. It measures **20.2 × 16**: the word (16.2px at 9px mono, untracked) plus
  1px of padding and a 1px border each side. Its width is the word's (`width: auto`, no fixed
  `width` or `height`, `min-height: 16px`), so a raised minimum font size widens the chip rather
  than clipping the word. `aria-label` "Open in a TUI. Pid {pid}, status {status}.", `title`
  "Open in a TUI · pid {pid} · {status}".

  - **Static. No `.chip-live`**, here and in the session head's `TUI` chip alike (§design.ground-rules/motion,
    §chat/transcript). This inverts the precedent this file used to state — *"the pulse
    belongs to Live alone"*. A TUI holding the file open is **ownership**, not work in flight,
    and a row that pulses all day while nothing moves teaches people that the pulse means
    nothing. The pulse now means exactly "work in flight", which is Busy.
  - **Hue.** Accent, unchanged: the accent's meaning is still "a TUI has this".
- **Busy dot.** Shown when pi is replying in the session — this tab's own run first, then the
  list's `busy` — and nothing holds it in a TUI:
  `.session-rail-item.session-rail-state.chip.chip-info.chip-live` holding one 7px info
  `.session-rail-dot`, **pulsing**, and no word. The dot is bare: no ring and no plate. Its
  button is an invisible 26px-wide box exactly as tall as the title's first line
  (`calc(--fs-body × --lh-body)`, 22.475px), so the dot centres on that line with no nudge and
  costs the rail no more height than the line beside it; the width keeps a comfortable hit area.
  It has no hover outline. `aria-label` and `title` both "pi is replying in this session".

  - **The pulse is Busy's now.** `.chip-live` lands here, and only here, in a session row. It is
    real work in flight, and it ends when the turn does.
  - **Hue.** Info (`--status-info`), not the accent. Busy is our own run; the accent stays
    reserved for "a TUI has this".
  - **At most one state.** TUI and Busy never co-occur — Sova never holds a TUI-owned session —
    and if both ever arrive, **TUI wins** and Busy is hidden (`sessionBusy` is false for a row
    with `live`): the TUI owns the file, so our view of busy is stale.
  - **What tells the two apart.** Tone (accent vs info); form — a 20.2 × 16 plate reading `TUI`
    against a bare 7px dot; and static vs pulsing. Form is the channel that survives both a
    reader who can't separate the hues and `prefers-reduced-motion`, which stops the pulse. The
    full list of carriers is tone, form and word, motion, `title`, `aria-label`, and the row
    link's hidden suffix.
- **Worker count.** `.session-rail-item.session-rail-count`, under the state, only when
  `live?.workers?.working ≥ 1`: a tabular `--fs-micro` figure and an 11px `worker` icon in
  `--color-ink-muted`, 16px tall, no pill and no border — it is an aggregate, not a state, and it
  must not read as a second status. `aria-label` and `title` both "{n} subagents working now". `.session-rail-count-live` pulses **the icon only**, never the figure: a moving
  numeral can't be read. Still at most **one** moving thing per row, so the count pulses only on
  rows without Busy, and a Busy row's count sits still. Alone in the rail, the count centres on
  the title's first line like the TUI chip; under a state it takes `−--space-1` of margin, which
  cancels the rail's gap, so it tucks up against the state.
- **320px budget.** The rail costs a **34px** gutter (2px margin + 30px column + 2px margin) and
  gives back the whole right end of the row. Busy's 26px box runs from x=4 to x=30 and the TUI
  chip, centred on the same axis, from about x=6.9 to x=27.1; the title block starts **34px** in
  on every row and runs
  **320 − 34 − 16 = 270px** — against the old worst case of about **150px**, when
  `2 working` (~64) + `TUI` (~48) + two 12px gaps sat to the right of the title. That is +120px,
  about **80% more title**, and it is the same 270px on every row: a stateless row no longer
  reads wider than a live one.

  The title column moved 2px right when the rail got its breathing room, and that is the trade as
  accepted: 2px of gutter buys a state that isn't touching the panel edge, and 2px off a 270px
  column is invisible where the rail's margin is not.

  **Re-checked with the topic chip and the context ring** (measured in Chromium over the real
  stylesheets, at a 320px viewport and at 1280 with the sidebar at its 320px default):

  - **The title column is untouched.** `.list-title` still starts at **x=34** and still spans the
    full **270px** nominal — the indicators are on lines 2 and 3 only, so line 1 measures exactly
    what it measured before them. (The 259px figure quoted above is that 270 less a real 10px
    scrollbar and the pane's 1px border; the harness draws overlay scrollbars, so it confirms the
    nominal number, not the 259.)
  - **The chip takes 17px** at one digit and **24px** at two, the ring **12px**, each plus one
    `--space-2` gap. Line 2's text therefore runs 245px and line 3's 250px at 320 — both still
    wider than the title column had in the worst case *before* the rail existed.
  - **The text truncates first, and it is the only thing that truncates.** The indicator is
    `flex: none` and the text block is `flex: 1; min-width: 0`, so a 96-character "now" line
    ellipses at the chip's left edge and a 30-character model id ellipses at the ring's. Nothing
    wraps (`flex-wrap: nowrap` on the wrapper, `white-space: nowrap` on the text), nothing clips,
    and the document never gains a horizontal scroll.
  - **The remote mark rides line 3's left edge.** A remote row's meta text starts after the 6px
    dot and the line's `--space-2` gap, so it runs ~236px at
    320 — still wider than the title column ever was before the rail. The mark is `flex: none`,
    the text still truncates first, and no row grows: the dot sits inside the meta line's own
    line box.
  - **No row grew.** The chip is pinned to the summary's own 14.3px line box and the 12px ring
    is shorter than the meta line's, which is a 14.3px micro line too. Measured at HEAD (1280
    viewport, 320px sidebar): a title + summary + meta row is **72.06px** (its link 71.06px) and
    a title + meta row **55.77px** (54.77px).

  Those are the nominal figures. A real pane also spends its 1px right border and a 10px
  scrollbar, so the title column in Chrome is about **259px** at a 1280 viewport and **250px** at
  a 320px viewport — the 261/252 measured before this change, less the 2px the gutter grew; they
  have not been re-measured. Both sides of the comparison are quoted without the scrollbar.

  **Row height.** The rail can set the row's height, because the shell is
  `align-items: flex-start` and the taller column wins. Measured at HEAD, the rail is 8px (its top
  padding) when empty, 27.24px with a TUI chip or a lone count (8 + 3.24 + 16), 30.47px with Busy
  (8 + 22.47), **43.24px** with TUI and a count (8 + 3.24 + 16 + 16, the count's negative margin
  cancelling the 4px gap) and **46.47px** with Busy and a count (8 + 22.47 + 16) — the tallest
  it gets. The link side of a title-plus-meta row is already **54.77px** (71.06px with a summary
  line), so the full rail fits inside the height the text already makes and **no row grows**.
  46.47px is the most the rail could impose, on a row that had lost its meta line — 2.5px over
  `--row-height` 44, and still one 44px-plus target. That is the acceptable trade: the rail is
  bounded by a number smaller than the row it sits in, and the alternative — squeezing the state
  or dropping the count — spends a readable state to save height we are not spending.
- **Other placements.** None for v1. The open session already shows its own run state (the
  `.run-status` line and the author's `.live-dot`, §chat/transcript), so the session head doesn't repeat Busy.
- **No live count under the search.** The expanded pane has no `N TUI` tally: each live row
  carries its own rail `TUI`, and the collapsed spine keeps its "{n} sessions open in a TUI" fact.
- **Selection.** The row link for the open session gets `aria-current="page"`, and its shell gets
  `.session-row-shell-current`, which is what the stylesheet tints with `--color-accent-tint` —
  the tint has to cover the rail too, or the open row would read as two pieces. The tint is never
  the only signal, because the head of the main pane repeats the title.
- **Refreshing** (polling or a WS nudge). Update rows in place and never re-show the skeleton.
  Keep scroll position and focus. If the focused row moves, it stays focused.

## §app.session-list/profile-shelf — Profiles

Under Groups (§app.session-list/groups), above Live & web: the sessions that run with a profile
(§chat/profiles), grouped by profile. It is a **shortcut, not a place**: every row also keeps its
place in Live & web (and Groups), but a profile session is never a Recent row
(§app.session-list/recent).

```html
<details class="sidebar-region sidebar-profiles" open>
  <summary class="sidebar-region-head"><span>Profiles</span><span class="sidebar-region-count">· 3</span></summary>
  <!-- one sub-group per profile in use -->
  <div class="profile-shelf-group">
    <p class="profile-shelf-head">…icon… Read-only reviewer <span class="text-muted">2 live</span>
      <button class="button button-sm button-ghost">Run</button></p>
    <ul class="list">…session rows…</ul>
  </div>
  <!-- a One at a time profile run at least once, with no live session: one line; a project's
       profile names its project -->
  <p class="profile-shelf-slot">…icon… Release checker <span class="text-muted">· acme ·</span>
    <span class="text-muted">Not running</span>
    <button class="button button-sm">Start</button></p>
</details>
```

- **Rows**: every non-archived session on this host whose `SessionSummary.profile` is set, under
  its profile's sub-head, newest started first. Sub-groups are keyed by the profile's identity
  (§chat.profiles/projects), so the same id from two projects is two sub-groups; a custom pick is
  grouped by its label. A sub-head carries the profile's icon and label, a project profile's
  project name after it ("· {project}"), then "{n} live" and **Run**, or, for a One at a time
  profile, "One at a time" and no Run. The region's count is its rows.
- **One at a time slots.** A One at a time profile that has been run at least once keeps a one-line
  slot while none of its sessions is live: "{label} · Not running · Start". Once run it stays, for as
  long as the profile exists (a deleted profile loses its slot).
- **Shown** only while it has a row or a slot; hidden while searching.
- **Run / Start** make a new session with that profile picked and open it on its empty screen,
  where the picker, and a linked playbook's card, show it (§chat.profiles/picker). Nothing is sent.
  Run starts in the sub-group's newest session's folder, Start in the project's root for a
  project profile, else in the open session's folder. It is `POST /api/sessions` with `cwd` and
  `profile`. Start on a One at a time profile that is live answers with the picker's alert
  (§chat.profiles/singleton) as a toast with **Open the Running {Label}**.
- **New Session** is one button: the session it makes starts as Default, and its empty screen is
  where a profile is picked.

## §app.session-list/needs-you — Needs you

The top of the list, above Recent: the sessions blocked on you right now — a dialog open, an
errored turn, a subagent that ended in an error, an idle session with open alignment questions
whose branch is not merged (§chat.alignment/session-mark), and a baton hand-off (the baton is with you, or a person needs
their link, §app.baton/needs-you); a roster proposal stays a decide item. A reply that seems to ask you (§app.decisions/asks-user) and
a team gone quiet (§app.decisions/team-stall) are not blockers: each is a quiet mark on its row,
never a row here. Neither is a worktree ready to merge or waiting for your OK: that is the row's
worktree count, lit (§chat.worktrees/readiness). A stuck subagent is not one either: it is its parent session's decide item. They are the attention digest's **act** tier (§app.overseer/attention-digest), read
from `GET /api/overseer/attention`, the list the Overseer's "{a} need you" counts — less the
organization sessions (§app.session-list/ordinary-surfaces), which wait in the Organizations
region's own Needs you (§app.session-list/organizations). **The Overseer's count still includes
them, deliberately**: the Overseer reads the whole digest, like the org and project pages, so its
"{a} need you" can be higher than this region's count by the org sessions waiting on you. The digest, not the
session list, is the source: a hosted pending dialog, a worker error and every detail sentence
reach only the digest.

Needs you is a **shortcut, not a place a session lives**, exactly like Recent: every row is still in
Recent (when it moved lately), Live & web or the Archive, and its group. An organization session is
never a row here. Nothing is moved or hidden,
and the region has **no actions of its own** beyond its twist: nothing puts a row away but the
thing it waits on being done.

```html
<!-- First in .sidebar-list, above Recent. Only while it has rows and proactivity is not Off. -->
<details class="sidebar-region sidebar-needs-you" aria-labelledby="r-needs-you" open>
  <!-- The Groups head's pattern: the <summary> toggles, the <h2> is what the outline reads. -->
  <summary class="sidebar-needs-you-summary">
    <h2 class="sidebar-region-head" id="r-needs-you" title="The 2 sessions waiting on you, newest first.">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      Needs you <span class="sidebar-region-count">· 2</span>
    </h2>
  </summary>
  <ul class="list">…session rows, with line 2 replaced by the digest's sentence…</ul>
  <!-- only when the digest's 30-item cap dropped act items -->
  <p class="sidebar-region-note">Some sessions may not be listed: this list stops at the 30 most urgent items.</p>
</details>
```

- **Which sessions.** Every session with at least one act item in the digest, **one row per
  session** however many act items it has, joined by path to the sidebar's search-hit list. So the
  search and the host filter narrow it like every other region, and a digest session the list
  doesn't carry is not listed. **The count in the head is the rows**, and the region never lists a
  row the rest of the pane hides.
- **Order: newest first**, by each session's newest act item (`since`); ties break on path.
- **A project's deploy items** (`deploy-failed`, `deploy-request`, §app.project-services/deploy-status) belong
  to no session, so they list under the session rows as rows of their own, newest first, narrowed by the
  search (project, folder or sentence): the project's name, the digest's sentence and the folder, each
  opening the project page (its Deploy panel). The head's count and the spine's door count them too, and
  the head's title says how many are deploy items ("The 2 sessions waiting on you, newest first, and 1
  deploy item." / "1 deploy item waiting on you.").
- **Rows** are the same `SessionRow` as everywhere else — rail, marks, meta line, accessible name —
  with one difference: **line 2 is the digest's sentence** for the session's newest act item
  ("3 open questions in al_3 Autonomy settings", "Waiting on a dialog.", "429 rate limited", "1 subagent ended in an error."), in place of the gist
  or the draft preview, and shown even with summaries hidden in Settings › General. Its `title` is
  every act sentence the session has, newest first. An act item with no sentence leaves line 2 as
  the row draws it elsewhere. The rules live in `src/lib/needs-you.ts`.
- **No row menu, no put-away.** A Needs you row carries no button of its own and no menu, except
  a session whose act item is a proposed playbook run (`playbook-review`,
  §app.project-runtime/review): under its row, **Approve & Merge** (or **Merge Branch**), which acts
  at once and says a refusal's reason under it. Otherwise: a press
  held on it and let go selects it (§app.session-list/selecting-several-sessions), one that moves
  opens the drop overlay (§app.session-list/drop-overlay), and a right-click is the browser's, as
  on every other row.
- **The open session stays listed**, drawn with the current tint like any row: the count is the
  digest's, and a number must match its list.
- **Open by default, collapsible.** The head is a twist (`<details>`, the Groups head's
  summary-wrapping-`<h2>` form). A user's collapse is remembered for the browser tab in
  `sessionStorage["sova:needs-you-open"]`, `"1"` open and `"0"` collapsed, through `writeKey`;
  only `"0"` reads as collapsed. **Forced open while a search is on**, without changing the stored
  choice, so every hit is visible.
- **Omitted entirely** when it has no rows — an empty "Needs you · 0" is a standing alarm at rest —
  and while Overseer proactivity is **Off** (§app.overseer/proactivity), or not yet read. The
  region appearing and going is the signal; Recent's divider moves up with it.
- **Freshness.** App reads the digest once for the page, on the Overseer entry button's 10-second
  cadence (paused while the tab is hidden, again on window focus, and at once when a view's action
  asks for the session list — a baton strip's Get Link, hand-off, Take Back or Approve), and hands
  that read to this region. The server keeps a digest for 3 seconds; an org or baton write that lands drops it, so the read right
  after one says what it changed.
- **The spine** carries its door, "Needs you · {n} sessions", shown exactly when the region is
  (§app.session-list/spine).

## §app.session-list/recent — Recent

Near the top of the list, under Needs you (§app.session-list/needs-you) when it shows, above Groups: the few sessions that moved last, said once more so the one you
want back is the first thing on screen. With 48 sessions across 11 folders, the session you closed
five minutes ago is three collapsed sections down — and it is the single most likely thing you came
for.

Recent is a **shortcut, not a place a session lives.** Every row in it is still in Live & web or
the Archive underneath (organization sessions are never eligible), exactly as a grouped session keeps its row in its region (§app.session-list/groups):
nothing is moved, nothing is hidden, and closing the gap between two copies of one row is not
something the user has to think about. It follows from that that Recent has **no actions of its
own** — no drag target, no remove, no count control. Every gesture a row has, it has where it
lives.

```html
<!-- First in .sidebar-list after the Needs you region, above the Groups region. -->
<section class="sidebar-region sidebar-recent" aria-labelledby="r-recent">
  <h2 class="sidebar-region-head" id="r-recent"
      title="The 5 sessions that moved last. Change how many in Settings, under General.">
    Recent <span class="sidebar-region-count">· 5</span>
  </h2>
  <ul class="list">…session rows, exactly as every other region draws them…</ul>
</section>
```

- **Flat, no folders.** The only region without `<details class="session-group">` heads. At five
rows a folder head per row would BE the region, and the folder is already on each row's own meta
line. Rows are the same `SessionRow` as everywhere else, with the same rail, summary line, remote
mark, menu and accessible name.
- **Not collapsible, and nothing persisted about it.** It is five rows; a twist would be a control
that saves four.
- **Who is eligible.** An ordinary session (§app.session-list/ordinary-surfaces: never an Overseer file
or an organization session, in any state — live, busy, unread or just replied), not archived
(`archived !== true`), and not a profile session (`SessionSummary.profile` set): Profiles lists those
(§app.session-list/profile-shelf) — and deliberately **not** the pane rule
`isTopSession`. A session you ran in a TUI last week and closed is exactly what this region is
for, and the pane rule files that under the Archive. Archiving is the user saying "done with
this", so an archived session never reappears here; that is the one gesture Recent has to honour,
or the archive gesture doesn't work.
- **Order: most recently active first**, by `SessionSummary.lastActiveAt`. **That field is the
session file's mtime** and the list carries no other activity signal, so it moves for anything that
writes to the session — a reply, a tool result, an outline snapshot, a background subagent's turn.
It is the honest answer to "what moved last" and NOT an answer to "where was I last", and the
region is named for the former. Ties break on `createdAt` (newer first), then on `id`, so the top
of the sidebar has one order and does not shuffle between polls.
- **The search narrows it** with everything else: Recent is built from the same hit list as the
regions below, so it can never show a row the query has ruled out, and the region disappears when
nothing matches. The rule lives in `src/lib/recent.ts`; the sidebar passes its hits in.
- **How many rows** is a preference — 5 by default, 3 at the fewest, 20 at the most — set in
**Settings › General and nowhere else** (§app.settings-dialog/general). It persists in
`localStorage["sova:recent-count"]`, so it is this browser's, like the theme. A stored value that
is not a whole number in range is the default; a number out of range is clamped.
- **Empty.** The region is omitted entirely — with 0 sessions the sidebar's own empty state is
already saying it, and "0 recent" above "0 sessions" says it twice.

## §app.session-list/groups — Groups

Groups are the user's **own** sections, below Needs you and Recent and above every other region: named folders they make and file
sessions into by dragging a row and dropping it on one (§app.session-list/drop-overlay). They live server-side in
`~/.pi/agent/sova/session-groups.json` (`server/session-groups.ts`), keyed by session id like the
archive, so every tab and every Sova server sees the same groups and clearing browser storage
loses nothing. `GET /api/session-groups` lists them; the other routes are in `shared/protocol.ts`.

**A group is additive.** It never moves a session out of its region or out of its own place in the
list: a grouped session still shows under Live & web (or in the Archive), so the same row can
appear in a group and below it at once. A session belongs to **at most one** group.

**Organization sessions are never grouped**, like the Overseer's files (§app.session-list/ordinary-surfaces):
the Groups region never draws one, and the drop overlay's group tiles, the session pane's `Move into group` and
the server (`POST /api/session-groups/assign`, 400) all refuse it with "Organization sessions stay
with their project." — on the disabled control, as its reason, before the press. An assignment made
before this rule is kept on the server and not drawn; a group left holding only organization
sessions shows as empty.

### Anatomy

```html
<details class="sidebar-region sidebar-groups" aria-labelledby="r-groups">
  <!-- The head is the twist: the <summary> toggles, the <h2> inside it is what the outline and
       `aria-labelledby` read (the folder-head pattern, not the Archive's bare <summary>). -->
  <summary class="sidebar-groups-summary">
    <h2 class="sidebar-region-head" id="r-groups">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      Groups <span class="sidebar-region-count">· 2</span>
      <!-- The region's one action, at the head's right end: there with the region shut. It opens
           the group picker (§app.session-list/group-picker) and makes nothing. Click and keydown
           stop here, as a group's `⋯` does, or they would toggle the region. -->
      <button type="button" class="button button-icon button-ghost group-picker-open"
              aria-haspopup="dialog" aria-label="Open Groups" title="Open Groups">
        <svg class="icon icon-sm" aria-hidden="true">…external…</svg>
      </button>
    </h2>
  </summary>

  <!-- One group: a <details>, like an Archive date section, and collapsed like one too. -->
  <details class="group-section">
    <!-- The twist, the name, the count, the actions — and NO folder icon: a group is the user's
         own name for a set of sessions, not a folder on disk. The cwd heads inside it keep theirs. -->
    <summary class="list-group-label group-label" title="Work">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <span class="group-name"><bdi>Work</bdi></span>
      <span class="text-num">4</span>
      <!-- The group's own actions, on its own name row. Always shown, muted until the row is
           hovered or focused. Click and keydown stop here, or they would toggle the section. -->
      <button type="button" class="button button-icon button-ghost group-actions"
              aria-haspopup="menu" aria-expanded="false" aria-label="Group actions · Work"
              title="Group actions">…more…</button>
    </summary>
    <!-- The panel is portaled to <body>, NOT left inside the summary: see "The actions menu". -->
    <!-- `.action-menu`: the model menu's shell at a menu's own width, placed by measuring the
         rendered panel and clamping it inside the window (both axes, both directions). -->
    <div class="model-menu action-menu" popover="auto">
      <div class="model-menu-list" role="menu" aria-label="Group actions · Work">
        <a class="mode-option group-option" role="menuitem" tabindex="0" href="#/g/…"
           aria-label="Open “Work” as a workspace">…external…<span class="mode-option-text">
           <span class="mode-option-id">Open workspace</span></span></a>
        <div class="mode-option group-option" role="menuitem" tabindex="0"
             aria-label="Rename “Work”">…pencil… Rename…</div>
        <div class="mode-option group-option" role="menuitem" tabindex="0"
             aria-label="Delete “Work”">…close… Delete group…</div>
      </div>
      <!-- Rename… and Delete group… each swap the rows for one screen inside this same menu:
           the name field (§ Renaming), or the question with Delete group + Cancel (§ Deleting). -->
    </div>
    <details class="session-group" aria-labelledby="g-…" open>
      <summary class="session-group-head">
        <h4 class="list-group-label" id="g-…">…twist, folder, path, count…</h4>
      </summary>
      <ul class="list">…session rows, exactly as everywhere else…</ul>
    </details>
  </details>

  <!-- A group with no sessions: the note. -->
  <p class="sidebar-region-note">No sessions yet. Drag a session to file it here.</p>
</details>
```

- **Placement.** Above Live & web, below the search field. The region is always rendered — with no
groups it holds its head, with its `Open Groups` button, and the note "No groups yet. Drag a
session to start one." — because dragging a row is the feature's front door (its overlay's
`+ New group` makes the first group), the way the top region keeps its head when it is empty.
- **Order.** Groups keep their creation order, so a rename or a new group never shuffles the list.
Within a group, rows and folder groups follow the usual rule (newest `lastActiveAt` first), and
the folder labels are `h4`, one level under the group's own label.
- **Indent.** A group's folders carry the same guide rule as every other folder
(§app.session-list/content-rules). Under a group name that rule is what tells its folders apart as
the group's contents rather than siblings of its name.
- **The name row.** Twist, name, count, actions — and no folder icon. A group is the user's own
name for a set of sessions, not a folder on disk, and the icon read as a claim about the file
system directly above the `cwd` heads that really are one. Those keep their folder (or `terminal`)
icon; it is what tells the two kinds of head apart at a glance.
- **Count.** The region head counts **groups**. Within Groups only, a group's own session count
and each nested folder's count appear only while that particular section is collapsed; expanded
sections show their rows instead of repeating the numbers. Live & web and Archive folder counts
remain visible whether expanded or collapsed. (Those regions count sessions, not groups.) While
searching the Groups region head reads `· {matching groups} of {all groups}`.
- **The region is a `<details>`**, and it is **collapsed on every page load**. The Groups region
is the user's own curation sitting above the whole list, and it grows without bound as they file
more away; starting it closed keeps the top of the sidebar the same height however many groups
exist, and Live & web — the sessions they came for — stays in view. The twist is the whole head
row, keyboard-reachable like the Archive's.
- **The choice is never persisted.** Not `sessionStorage`, not `localStorage`, not the server:
opening the region lasts as long as the page does and no longer, so a reload always starts closed.
This is the deliberate exception to the Archive's rule (§app/session-list "Regions"), and there is no storage key
to read — `src/lib/group-open.ts` is the whole rule, inputs only.
- **Forced open** — without changing the choice, exactly as the Archive is — while a search is on
(a matching group must not hide its hits). When the search clears the choice answers again, so
a region the user never opened is shut again.
- **A group inside it is a `<details>` too**, like an Archive date section, and collapsed by
default on the same terms: memory only, no storage key, reopened by hand each page.
- **Empty.** An empty group stays visible with `0` and "No sessions yet. Drag a session to file it
here.": it is what a group is when the user makes it, and its tile in the drop overlay is what fills it. While a search is on,
a group with no matching session is left out entirely. Every group reaches this state when its
last member leaves, an older build's `autoDissolve` group included (§workspace.groups/legacy-groups).
- **Creating.** The region makes no group: it has no `+` and no name field. A group is made
where a session is being filed: the drop overlay's `+ New group` (§app.session-list/drop-overlay),
`New group…` in the session pane's `Move into group` and in the selection toolbar's Move to group,
and the Overseer. `POST /api/session-groups`, then the group appears at the end of the region in
creation order.
- **Open Groups.** The region's one action is `Open Groups` at the right end of its head
(`.button-icon.button-ghost` with the `external` glyph, as `Open workspace` has, `aria-label` and `title` "Open Groups",
`aria-haspopup="dialog"`), not a row: a row read as one of the groups and sat inside the list.
On the head it is there with the region shut and while searching, and at the end the name and
count keep their place. It is quiet like a group's `⋯` — the count's muted ink, coming up to full
ink when the head is hovered or it has focus — with the standard 44px target, hung into the head's
right padding so its glyph lines up with the `⋯` of the groups below. It stops its own click and
keydown, as the `⋯` does, so a press on it is not also a press on the summary, and it never opens
or shuts the region. Pressing it opens the group picker (§app.session-list/group-picker). With no
groups it is `aria-disabled` with the reason "No groups yet. Drag a session to start one." as its
`title`, and a press only says that reason through the polite region.
- **The actions menu.** A group's three actions live behind one `⋯` trigger on the group's own
name row, in the `<summary>` after the count — not in a tool row under the section, which cost
every group three buttons' worth of height whether or not anyone wanted them. The trigger is
`.button-icon.button-ghost`, ALWAYS drawn — a hover-revealed one is invisible to a touch user and
a guess to everyone else — in the count's muted ink, coming up to full ink on hover, on
focus-within and while its menu is open. Its 44px target is the standard one; only the glyph is a
step smaller (16px), and the box hangs into the sidebar's right gutter so the dots sit on the edge. It opens the same `popover="auto"` menu §chat/mode-menu and §workspace/groups use: `Open workspace`, `Rename…`,
`Delete group…`. **A control inside a `<summary>` costs two things.** The trigger stops its own
click and keydown, so a press on it is not also a press on the summary. And the menu's panel is
rendered OUT of the summary's subtree (a portal to `<body>`): a popover paints in the top layer
but stays where it is in the DOM, and a `<details>` toggles for a click on anything inside its
summary that has no activation behaviour of its own — which is exactly what a `role="menuitem"`
row is. Measured before the panel moved: pressing `Rename…` collapsed the group under the menu.
- **Opening it as a workspace.** `Open workspace` is the menu's first row, a link to `#/g/{id}` —
the group's members side by side, each a whole chat, with one composer that writes to all of them
(§workspace/groups). An empty group can't be opened as one: the row is `aria-disabled` with its reason under the
label ("Nothing is in it yet. Drag a session into it first."), said before the press rather than
discovered as a blank workspace. The head's `Open Groups` picker
(§app.session-list/group-picker) opens the same `#/g/{id}`, with the same refusal for an empty
group. The section is still the place you file sessions into; the workspace is the place you read
them in.
- **This is where membership changes.** The Groups region, the selection toolbar and the
session details' `Move into group` are where a person puts a session into a group; the workspace
takes members out but adds none (§workspace.groups/group-lifecycle).
- **Renaming.** `Rename…` swaps the menu's rows for the same field, pre-filled, without closing
the menu — one question at a time, and nothing in the list below moves while it is answered. The
name is trimmed, 1–60 characters, and duplicates are allowed (nothing keys on a name).
`PATCH /api/session-groups/:id`.
- **Deleting.** `Delete group…` swaps the menu's rows for the question — "Delete “Work”? Its 4
sessions stay in the list." (empty: "Delete “Work”? Nothing is in it.") — with `Delete group`
(destructive, outlined) and `Cancel`. `Cancel` and Escape both close the whole menu: cancelling a
destructive ask means the gesture is off, not that it should be re-offered. It
removes the group and its assignments and never touches a session file. `DELETE
/api/session-groups/:id`; toast: "Deleted “Work”. Its 4 sessions are ungrouped."
- **Dragging.** Dragging a session row, with a mouse or a thumb, opens the drop
overlay (§app.session-list/drop-overlay). Dropping the row on a group's tile files it there,
dropping it on another group's tile moves it, and the group it is already in is marked `Current`
and does nothing. A grouped row also gets a `Remove from “Work”` tile. A drop says what happened
through `.toast` and the polite region: "Added to “Work”." · "Moved to “Home”." · "Removed from
“Home”." The list's own group sections are not drop targets.
- **Without a pointer** there is no drag: the session pane's `Move into group`
control (the session pane's Session tab, §app.subagents-pane/tabs) is the same change, as a popover radio list
(`role="menuitemradio"`, one row per group plus `No group`) with `New group…` at the end, which
creates the group and moves the session in one step. The Identity list shows the current group.
- **Search.** Groups are filtered by the same query as everything else, over the whole list rather
than one region's slice, and the region disappears when no group matches.

**Accessibility.** The region is a `section` labelled by its `h2`. The group label is a
`<summary>` and deliberately **not** a heading: headings inside `<summary>` are exposed
inconsistently (the same rule the Archive's summary follows), so the folder labels inside a group
are `h4` and the outline reads region → folder with one level deliberately skipped rather than a
heading nobody can rely on. The label is a `<summary>`, so Enter or
Space opens and closes the section and AT announces expanded or collapsed. The `⋯` trigger inside
it keeps the section's own gestures: it stops click and keydown, so Enter or Space on the trigger
opens the menu and does not also toggle the section, and Tab reaches the trigger after the
summary. Escape closes the menu (and any screen it is showing) and returns focus to it. The region
head's `Open Groups` is a named button inside its `<summary>`, and it keeps the region's gestures
the same way: it stops click and keydown, so Enter or Space on it opens the picker and does not
also toggle the region. When the picker closes it hands focus back to `Open Groups`.
Dragging is a pointer gesture only (§app.session-list/drop-overlay): the popover path is what a
keyboard uses. Contrast is the region head's (ink-2 on sunken, 7.65 dark / 7.22 light).

## §app.session-list/group-picker — Open Groups: the group picker

The Groups head's `Open Groups` (§app.session-list/groups) opens a **group picker**: every group as
a tile, in one panel sized to its list, and a press on a tile opens that group's
workspace (`#/g/{id}`, §workspace.groups/routes). It is the drop overlay's shell and tiles
(§app.session-list/drop-overlay) with nothing in flight: no floating card, no target under the
pointer, no `+ New group`, no `Remove from …`, no Archive and no Cancel bar. It makes, moves,
archives and removes nothing; it only opens. The overlay is `src/components/GroupPicker.tsx`; its
tiles keep the drop overlay's row size (`DROP_LIST_FIT` in `src/lib/drag-overlay.ts`).

```html
<!-- Portalled to <body>, position fixed, inset 0, over everything. Only while the picker is open. -->
<div class="drop-overlay group-picker" role="dialog" aria-modal="true" aria-labelledby="group-picker-title">
  <!-- As big as the list, never the window: the drop overlay's own dropListLayout, written
       inline — one 260–320px column, then 2 and 3, then shorter rows, then a scroll. -->
  <div class="drop-overlay-panel" style="--drop-list-w: 320px; --pick-row-h: 52px; --pick-gap: 4px">
    <div class="drop-overlay-head group-picker-head">
      <div class="group-picker-head-text">
        <h2 class="drop-overlay-title" id="group-picker-title">Groups</h2>
        <p class="drop-overlay-hint">Open one as a workspace.</p>
      </div>
      <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close">…close…</button>
    </div>
    <!-- Row by row across the layout's columns (one full-width column when folded); the grid
         scrolls when the list outgrows the window. -->
    <div class="drop-overlay-grid group-picker-grid">
      <a class="drop-tile group-picker-tile" href="#/g/g1" title="Work">…folder… Work · 4 sessions</a>
      <!-- An empty group: shown, never a link: an `Empty` chip by the name, and its reason
           under it, wrapped and read whole. -->
      <a class="drop-tile group-picker-tile" role="link" tabindex="0" aria-disabled="true"
         title="Nothing is in it yet. Drag a session into it first.">…folder… Home
         <span class="chip drop-tile-chip">Empty</span> · Nothing is in it yet. Drag a session into it first.</a>
    </div>
  </div>
</div>
```

- **The tiles.** One per group, in creation order, each the drop overlay's group tile: a folder
  icon, the name on the first line, and its session count on the second ("1 session", "4
  sessions"), counted as the drop overlay counts them, over the whole list and not the search's
  slice. Every group is shown whatever the sidebar's search, and the region need not be open. With
  no group (the last one deleted elsewhere while it is open) the head's note reads "No groups yet.
  Drag a session to start one."
- **Opening one.** A populated tile is a link to `#/g/{id}`. A press closes the picker and the
  route opens the workspace, split. A modified click (a new tab or window) is the browser's and
  leaves the picker open.
- **An empty group can't be opened**, exactly as the group menu's `Open workspace` refuses it: the
  tile is shown, `aria-disabled`, in the drop overlay's disabled look, with an `Empty` chip after
  its name (the drop overlay's chip, where `Current` sits) and "Nothing is in it yet. Drag a
  session into it first." under it as its title and its second line. That line is never cut to an
  ellipsis: it wraps at any width and the tile grows to hold it, so the reason is on screen, not
  only in a tooltip. A press on it does nothing but say that reason through the polite region.
- **Nothing is being dragged.** The tiles never take the drop overlay's under-the-pointer look
  (accent tint and outline, drop words). Hover and keyboard focus are the plain affordance: the
  sunken fill under the pointer and the standard focus ring. The overlay keeps a normal cursor,
  scrolls its list with a finger or a wheel, and leaves text selectable.
- **Layout: the list's own size.** The drop overlay's shell (fixed to the window under `--scrim`,
  `--color-bg` panel, the head at body size with the hint in caption) — the scrim still fills the
  window, dimming the list the picker opened from — but the panel takes the **list's own size and
  no more**, measured by the drop overlay's own `dropListLayout` (`src/lib/drag-overlay.ts`,
  written inline by GroupPicker): one column of session-row tiles, a second and a third when the
  window's height won't hold it, rows shortened toward the 44px floor, then a scroll inside the
  panel (wheel, finger or keyboard) while the head stays put. So a few groups are a compact panel
  centred on the scrim, like the drop overlay itself, and it grows toward the window only as the
  list does — never a full screen holding one strip of rows. The tiles keep a session row's size,
  never stretched into cards: 52px tall at rest, filled **row by row** across the layout's columns,
  which share the panel's width evenly. An empty group's tile grows only as tall as its wrapped
  reason. Under 768px it is the shell's bottom sheet — the window's full width, one column, as
  tall as its list and no taller. The head carries the close control at its right end, a 44px
  `.button-icon.button-ghost` named "Close".
- **Closing.** The close control, Escape, and a press on the scrim outside the panel close it, and
  nothing changes. Opening a workspace closes it too. However it closes, focus returns to
  `Open Groups`.
- **The drop overlay is unchanged.** Dragging a row still opens it with every one of its targets
  and rules, at its own compact size; the picker only shares its shell, tile look and row size.

**Accessibility.** The picker is a modal `role="dialog"` labelled by its title. Opening it moves
focus to the first populated tile (else the first tile, else the close control), Tab and Shift+Tab
stay inside it (`trapFocus`), and Escape closes it from anywhere inside. A populated tile is a
link named by its own words, the group's name and count, under the hint that says what a link
does, so Enter opens it. An empty tile is still in the Tab
order, `role="link"` and `aria-disabled`, so its reason is read before any press.

## §app.session-list/drop-overlay — Dragging a row: the drop overlay

Dragging a session row doesn't aim at a target in the list. It opens a **drop overlay**: one
compact panel that holds every place the row can go, a target per group, `+ New group`, and
Archive. In the list a group or the Archive region is usually off screen or scrolled away; the
overlay puts every target in view at once, each the size of a session row, as a list the eye
can read without travelling across the window. It grows with the number of groups toward
filling the window, and only then do its rows get shorter. A copy of the dragged row floats over
it under the pointer, so what is being dropped is never out of sight. It
is the same gesture with a mouse and a thumb: one Pointer Events path. The pure rules live in
`src/lib/drag-overlay.ts`, the overlay in `src/components/DropOverlay.tsx`, and the drop in
`Sidebar.tsx`.

```html
<!-- Portalled to <body>, position fixed, inset 0, over everything, toasts included. Only while a row is in flight. -->
<div class="drop-overlay" role="dialog" aria-modal="true" aria-labelledby="drop-overlay-title">
  <div class="drop-overlay-panel" style="--drop-list-w: 320px">   <!-- centred; a bottom sheet when folded -->
  <div class="drop-overlay-head">
    <h2 class="drop-overlay-title" id="drop-overlay-title">Move “<bdi>Fix the build</bdi>”</h2>
    <p class="drop-overlay-hint">Drop it on a group or on Archive. Let go anywhere else to cancel.</p>
    <!-- Only when the row can't join a group: the one reason, once, not on every tile. -->
    <p class="drop-overlay-note">Organization sessions stay with their project.</p>
  </div>
  <!-- Its own size, never stretched (dropListLayout): columns, rows and row height inline. Column-major:
       a column fills top to bottom before the next begins. Scrolls only at the 44px floor; auto-scrolls near its edges. -->
  <div class="drop-overlay-grid" style="grid-template-columns: repeat(1, minmax(0, 1fr)); grid-template-rows: repeat(4, 52px)">
    <div class="drop-tile drop-tile-new" data-drop-tile="new">…plus… New group</div>
    <div class="drop-tile drop-tile-remove" data-drop-tile="remove">…close… Remove from “Work”</div>   <!-- grouped rows only -->
    <div class="drop-tile drop-tile-current" data-drop-tile="g1" aria-disabled="true">…folder… Work <span class="chip">Current</span> · 1 session</div>
    <div class="drop-tile" data-drop-tile="g2">…folder… <bdi>Home</bdi> · 3 sessions</div>
  </div>
  <div class="drop-overlay-bar">
    <button type="button" class="drop-tile drop-tile-cancel" data-drop-tile="cancel">…close… Cancel</button>
    <div class="drop-tile drop-tile-archive" data-drop-tile="archive">…archive… Archive</div>
  </div>
  </div>
  <!-- The floating card. pointer-events: none; placed with a transform on every move. -->
  <div class="drop-ghost" aria-hidden="true">
    <ul class="drop-ghost-card"><li class="session-row-shell">…a copy of the dragged row…</li></ul>
    <p class="drop-ghost-target">…arrow-right… Move to “Home”</p>
  </div>
</div>
```

- **Starting it.** With a mouse, pressing a row and moving it about 6px opens the overlay at once,
  with no hold. With a thumb (and a pen), a press held still ~500ms **lifts** the row: it rises
  (surface fill, `--shadow-2`) and the phone buzzes briefly where it can (`navigator.vibrate`).
  Moving the lifted row more than 10px opens the overlay. A touch that moves before the lift is a
  scroll or a tap, exactly as before. Letting go of a lifted row without moving it selects it
  (§app.session-list/selecting-several-sessions), and a still mouse held 500ms does the same. In
  selection mode a row doesn't drag at all.
- **Layout.** Fixed to the window, `inset: 0`, above the toasts (z-index 65; a toast from the
  last drop would otherwise cover `Cancel`). The page stays in view behind it under `--scrim`,
  as behind a dialog, with no blur: the panel is small, and the dimmed list still shows where the
  row came from. On it sits **one panel** (`--color-bg`, a thin border, `--shadow-3`, `r-lg`):
  centred in the window from 768px, and under 768px a bottom sheet the window's width, where a
  thumb rests. It holds a head ("Move “{title}”" at body size, one line, truncated, and the hint
  in caption), the list of targets, and a bar. The panel is as wide as the list and never
  narrower than 400px (folded: the sheet's width, the list filling it).
  **The targets are shaped like session rows**, not tiles: a 52px row, a 16px icon, the name on
  the first line and what it holds (or, under the pointer, what a drop does) on the second, both
  left-aligned, one line each and truncated, with the full name as the row's title.
  `dropListLayout` places them: **one column** the sessions pane's width (320px) while the rows fit
  the height the window leaves; when they don't, they continue in a **2nd, then a 3rd column**
  (column-major, like the list continuing), each at least 260px, so a narrow window, a phone
  included, stays one column and a phone on its side may take more; once 3 columns (or as many as
  fit) are full, **the rows get shorter**, down to 44px; only past that does the list scroll. So
  at 1440×900 a few groups are a short single column in the middle of the window, 20 are 2
  columns, and 40 are 3 columns of 46px rows without scrolling; on a 390×844 phone 20 groups
  scroll a single column of 44px rows. `+ New group` comes first, with a dashed edge and an
  accent `+`. With no groups yet its second line reads "No groups yet. Drop here to start one."
  `Remove from “{name}”` comes next, for a grouped row only, dashed with a close mark. The
  groups follow in their creation order, each with a folder icon and its session count. **The
  bar** holds `Cancel` (three fifths, first) and then, 12px away at the far end, Archive, both
  48px tall with the icon and label centred. Archive is outlined in the error colour with an
  error-coloured icon, as a destructive button is, and never filled; its reason, when it can't
  archive, wraps under the label and is read whole. The bar is part of the panel, so it is
  always in view: only the list scrolls. Near the list's top or bottom edge (56px) the list
  scrolls under a still pointer, faster the nearer the edge.
- **The floating card.** While the overlay is open, a copy of the dragged row, taken when the
  drag starts and looking as it does in the list, floats over everything. It has the surface
  fill, a 1.5px accent edge, `--shadow-3`, and sits 2% larger. With a mouse it trails the
  pointer, 16px right of and 20px below its tip, flipping left or up at the window's edge. With a
  finger or pen it is centred 32px above the touch, so the finger never hides it, or below the
  touch when there is no room above. It is 340px wide at most (300px with a finger) and always
  stays inside the window. Under it one line says where a drop now would put the row:
  "Move to “{name}”" (a grouped row) / "Add to “{name}”" · "Remove from “{name}”" · "Into a new
  group" · "Archive" · "Cancel", with an arrow, or with a close mark "Already in “{name}”"
  (its own group), "Can't drop here" (a refused group or New group), "Can't archive", and "Let
  go to cancel" over nothing. The card has `pointer-events: none`, and hit-testing reads the
  tiles' own rectangles at the pointer, so the card never stands between the pointer and a tile.
  The tile hit is the one under the pointer, never the one under the card's centre.
- **The target under the pointer** takes the accent tint, an accent border and a 1.5px accent outline, and its second
  line changes to what a drop does ("Drop to move here", "Drop to add here", "Drop to remove",
  "Drop to name a new group"). Hue is never the only sign of it. Archive under the pointer is
  outlined in error with the error tint and reads "Drop to archive"; `Cancel` reads "Drop to cancel".
- **The row's current group** is marked `Current` and inert: a drop there does nothing.
- **Tiles that can't take the row are disabled, and say why in words.** The overlay always
  opens. An organization session can't join a group: the new-group and group tiles are disabled,
  and the head's note says "Organization sessions stay with their project." once. A peer's
  session gets "Groups hold this host's sessions only. That one lives on {host}." in the same
  way (a peer's own groups aren't this host's, so it gets no `Current` or `Remove` tile). Taking
  an organization session out of a group still works. Archive, when it can't archive, says why
  under its label: "Can't archive: {reason}" in `archiveBlockReason`'s words (open in a TUI, not
  started in Sova, mid-turn, with subagents working). A row that is already archived says
  "Already archived.", and an external row the Archive already lists says "Already in the
  Archive." A drop on a disabled tile does nothing but say its reason, as a toast and through
  the polite region.
- **Dropping.** On a group, the row goes into it (`setSessionGroup`) with the group toasts: "Added
  to “{name}”." · "Moved to “{name}”." · "Removed from “{name}”.". On Archive, the row is archived:
  `POST /api/sessions/archive`, then "Archived. Find it under Archive." with `Undo`, whose toast is
  "Moved back to Live & web.". An organization session goes to its project's Done list instead
  (§app.session-list/organizations), and an empty husk is deleted without an Undo
  (§app.session-list/regions-top-and-archive). On `+ New group`, the overlay closes and the New
  group dialog opens (below). On `Cancel`, on empty space, or on Escape, a `pointercancel` or the
  window losing focus, the overlay closes and nothing happens. The drop's `click` never reaches
  the row: nothing opens underneath.
- **New group dialog.** The standard `.modal` (a sheet at folded width), titled "New group", with
  "“{title}” moves into it." above one name field (placeholder `Group name`, 60 characters). The
  foot has ghost `Cancel` and primary `Create and Move`, which is disabled while the field is empty
  ("Type a name first."). Enter creates, Escape, the scrim and `Cancel` close it, and nothing is
  created. `Create and Move` is `POST /api/session-groups`, then the assign, then "Added to
  “{name}”." (or "Moved to …" for a grouped row). Focus is trapped in the dialog and returns
  where it was.
- **While it is open** the list under it doesn't scroll (a non-passive `touchmove` is refused
  while the row is lifted or in flight), iframes let the pointer through
  (`[data-row-drag] iframe`), and the row's text can't be selected or called out by a long press.
- **Reduced motion.** The overlay, the lift and the card's rise appear without a transition. The
  card still follows the pointer, since that is position rather than animation.

**Accessibility.** Opening it announces "Moving “{title}”. Drop it on a group, Archive, New
group, or Cancel." through the polite region. Escape cancels. Every tile carries its words, and
disabled tiles carry `aria-disabled` and their reason. The overlay is a pointer gesture: a
keyboard files a session with the session pane's `Move into group` and the selection toolbar,
which do the same changes.

## §app.session-list/selecting-several-sessions — Selecting several sessions

One session at a time is the sidebar's whole grammar: one row, one click, one transcript. Three
gestures are not about one session though — renaming, filing into a group, archiving — and doing
them to eight sessions one row at a time is eight round trips through a pane the user did not want
to open. So the list itself can be picked from.

**The way in is a press held on a row**, ~500ms, mouse or thumb alike, and let go without moving:
the hold lifts the row (§app.session-list/drop-overlay), and the release selects it and puts the
sidebar in **selection mode**, on a Needs you row as on any other. The selection commits on the
release, never at the hold, because a lifted row that moves is a drag. Press-and-hold is the accelerator; the **Select** button
beside the session count is the door, for a keyboard and for anyone who has never held a row in
their life — it shares the pane's one toolbar line with the count and the search icon
(§app.session-list/search), and leaves it while the search is open. There is never only one way in.

**What a press is, and what it stops being.** A press becomes a hold only if it stays within 10px
of where it started and nothing interrupts it. Before the hold, a mouse that moves 6px opens the
drop overlay, and a thumb that moves 10px is a scroll. After the hold, moving 10px opens the drop
overlay and the release selects nothing. A `pointercancel` (what touch sends the moment the list
starts moving under a still finger) ends the press too, and so does a wheel scroll under a held
mouse, the pointer leaving the row before the hold, capture being lost, and the window losing
focus: every path where the `pointerup` may never arrive. A press that ends any of these ways
selects nothing.

A hold that DID fire, and a drag, swallow what they leave behind: the `click` the pointerup
produces and, on touch, the `contextmenu` that arrives before it. Neither may reach the row's link, or the session
would open on top of the selection that was just made. **That suppression lasts for the whole
press and for a second after it is RELEASED** — never a second after the hold fired. A press may be
held for as long as the user likes, and a window measured from the hold would have run out under a
3-second press, letting the click through to toggle the row straight back off. The rules live in
`src/lib/hold-select.ts` and `src/lib/drag-overlay.ts`.

**In selection mode**, a click on a row toggles it instead of opening it, each row's rail carries a
44px checkbox, and the rail — 30px of gutter everywhere else — widens to 44px to hold it. Outside
selection mode nothing changes: a click is a click. **The selection is keyed by session path**, so
the same session shown in Recent, in a group and in Live & web is ONE selection with three checked
boxes, and it is module state (`src/lib/session-selection.ts`), like the open groups and the drag —
the list refreshes every few seconds and rebuilds every row, and a selection that a poll could
clear would be unusable. A poll may do exactly one thing to it: drop a session that is no longer in
the list.

**The toolbar sits inside the sidebar, above the list**, never floating over the rows it acts on —
**one row**: the count ("**{n} selected**", a polite live region) leads at the left and takes the
leftover width (it may ellipsize; the controls never shrink); the actions are one cluster at the
right end — **Move** as a word, **Rename** and **Archive** as icons, the normal control gap apart
— and `Cancel` ends them after a wider step, so it reads as the way out, not a fifth action. The
rename field, while open, takes its own row below with its hint — that row is not the actions row.

- **Rename** appears at **exactly one** selected session and is gone at two — one field cannot
  mean two titles. It opens an inline field: Enter saves, Escape cancels, and an **empty field
  clears** the user's title so the derived one (the session's first message) comes back. Changing
  the selection closes the field rather than leaving a stale one over another row's title.
- **Move to group** files every selected session at once, with `No group` first and `New group…`
  last — the one-session menu's own rows (§app.session-list/groups), in a menu that says how many it will move.
  Organization sessions are skipped and said once: "Skipped 1: an organization session stays with
  its project." / "Skipped {n}: organization sessions stay with their project."
- **Archive**, on organization sessions, moves them to their group's Done list in their project
  (§app.session-list/organizations), and the run's sentence says so: "Archived 2 sessions. 1 went to
  its project's Done list." ({n} > 1: "{n} went to their projects' Done lists.")
- **Archive** points one way for the whole selection. All archived → `Unarchive`. None archived →
  `Archive`. **A mix is a disabled control**; what it found ("2 of these 3 are archived
  and the rest aren't. Select one kind, or the other.") lives in the control's `title` and
  **accessible name** — the bar is one row and there is no note line, so the reason can't exist
  in a tooltip alone. Guessing which half was meant is how a
  bulk gesture loses work. Only eligible sessions are written — the single Archive button's own
  four rules, in one place (`archiveBlockReason`): open in a TUI, not started in Sova, mid-turn,
  or holding working subagents (archiving closes the runtime, so they would stop). The rest are
  skipped, and what was skipped or failed is said **once, in one sentence, for the whole run**
  ("Archived 2 sessions. Skipped 1: 1 open in a TUI.") and **stays selected**, so what is left is
  on screen rather than in a toast that has gone.

**One action at a time, and it owns the tab.** Archive, Move to group and Rename are each several
requests long. While one is in flight the selection is locked: rows don't toggle, `Cancel` and
`Escape` are refused (each saying so), and the toolbar's own controls are disabled — and the run
applies its leftovers through a token that says whether the tab is still the one it started on. A
run that comes back to a tab whose selection has moved on — cancelled, re-entered, picked again —
writes **nothing**, neither the leftovers nor the busy flag. "New group…" is ONE action across both
of its requests, and the sessions it moves are the ones that were selected when the row was
pressed, snapshotted before the group is created rather than re-read after it.

**Renaming is Sova's, and only Sova's.** A title set here is stored by session id in
`~/.pi/agent/sova/session-titles.json` (`POST /api/sessions/title`, `server/session-titles.ts`)
and **not one byte is written into the session's `.jsonl`** — which is what lets a session open in
a TUI be renamed at all (the webapp must never write a file a TUI owns). Every summary the server
hands out carries the override as `title` and the derived one as `originalTitle`, so the rename is
the same everywhere a session is named, and clearing it has something to go back to. Titles are
capped at `SESSION_TITLE_MAX` (80, the derived title's own cap), trimmed, whitespace collapsed to
one line; a deleted session's title is forgotten with its file.

**Every stored title says who set it.** The store is version 2: `titles[id]` is either a bare
string, a title from before provenance existed, or `{title, by, at}` with `by` one of `user`,
`overseer` or `auto` and `at` the ms epoch it was set. The route takes an optional `source`
(`user` or `overseer`, anything else is a 400): the UI sends none, so `user`, and the Overseer's
`sova_create_session` and `sova_set_session` send `overseer`, on this host and on a peer (an older
peer ignores the field and stores a `user` title, which protects it just the same). Nobody but
the automatic namer (§app.session-list/auto-titles) writes `auto`. **A title is explicit when a
user or the Overseer set it, and every bare string counts as explicit** — so every title stored
before this rule is protected, whoever really set it. Every summary carries the stored title's
provenance as `titleBy` (`user`, `overseer` or `auto`; a bare string reads `user`), present
whenever a title is stored for the session, even one that equals the derived title. Clearing
deletes the entry whatever set it; nothing remembers that a title was cleared, so a cleared session
is unnamed again, and the automatic namer may name it.

**Accessibility.** `Escape` leaves selection mode from anywhere outside a text field (inside one it
belongs to the field: search clears, the rename field cancels). "Text field" means a caret, not
merely an `<input>`: a row's checkbox is an input too, and Escape pressed on one — the likeliest
place for a keyboard to be in this mode — leaves the mode like Escape anywhere else
(`isTextEntry`). Every checkbox is a real
`<input type="checkbox">` inside its label, named "Select {title}". The toolbar is a `role="group"`
labelled "Selected sessions", its count is a polite live region, and every disabled control carries
the reason it is disabled in its `title` and accessible name, before it is pressed, never after. Every target in the mode is 44px.

## §app.session-list/auto-titles — Automatic session titles

A session is named by its first message until someone renames it, and a first message is a
question or an instruction, not a name. So Sova can name sessions itself, the way the Overseer does
when asked: one short title per session from what the session became, written into Sova's own
title store (§app.session-list/selecting-several-sessions) as an `auto` title. Never into the
`.jsonl`, and **never over an explicit title**: a title a user or the Overseer set, or any title
stored before provenance existed, is never replaced, by the sweep or by the button.

**Two ways in.** A background **sweep**, off by default and switched on in Settings → Summaries
(§app.settings-dialog/summaries), names sessions as they settle. A **Name sessions** button on
section heads names a section's unnamed rows on demand, whether the sweep is on or not. Both use
the same title call and the same writer (`server/session-autotitle.ts`).

**The title call.** One model call per session, with a primary and an optional fallback from
Settings (one attempt each, in order, no retry loop), each obeying the model policy's global switch
like the summary line: a model turned off in Settings → Models is skipped. The system prompt is
the title rules alone (2 to 7 words, at most 60 characters, sentence case, name the work rather
than the process, never name the app); **no Sova or agent system prompt goes with it**, and the
user message holds only:

- the session's first user message, whitespace collapsed, at most 600 characters (a wake nudge,
  a partner's link message or a topic batch, §chat.topics/row, is not one, as for the derived title);
- its summary line (the last topic-outline snapshot's `overall`) and that snapshot's topic
  headings, each with at most 2 of its bullets;
- or, with no summary line (the button only), its first 3 user messages instead.

**The session's current title is never in it**, whatever set it. On pi the call is
`completeSimple` with that system prompt and one user message, temperature 0 and no reasoning
unless the row's effort asks for it; on Claude Code it is `claude -p` in an empty temporary
folder with `--system-prompt`, no tools, no setting sources, no MCP servers, no session
persistence and no JSON schema, on this host's Claude login. The reply is one JSON object
`{"title": "…"}`; the title is kept only if, cleaned like a typed title (trimmed, one line), it is
2 to 9 words and at most 60 characters, with a trailing period or wrapping quotes dropped.
Anything else leaves the session as it was.

**The write is race-safe.** A title is written as `{title, by: "auto", at}` only if, on a fresh
read of the store at write time, the session still has no explicit title. A title the user or the
Overseer set while the call was out wins, and the model's answer is dropped.

**The sweep** runs on this host, for this host's sessions, while its switch is on:

- **When.** Every *interval* (default 5 minutes), and also shortly after a session's summary line
  changes (a nudge, scheduled for when that session will have been quiet long enough). Turning the
  switch on starts a run at once.
- **Which.** A session with no stored title at all, with a summary line, quiet for the *quiet
  period* (default 5 minutes, by its file's modification time), and none of: archived by hand, an
  empty husk, a subagent's or team member's own session, an Overseer or project overseer file. A
  group member is swept like any session, in a group an older build made included
  (§workspace.groups/legacy-groups). Most recently active first.
- **How much.** At most 10 sessions per run, 2 at a time. Existing unnamed sessions are backfilled
  the same way, 10 per run, until none is left.
- **Once.** A session the sweep named has a stored title, so no later run looks at it again, and a
  later change to its summary line does not rename it. A session the models answered with no usable
  title, or failed on for any other reason, is not tried again until its summary line changes
  (remembered by this server process).
- **Backoff.** When every model tried fails for quota, a rate limit or auth, the run stops, and
  the sweep waits 30 minutes before its next one. When no model can run at all, the run stops.
- **Silent.** The sweep shows nothing but the titles themselves: no toast, no notification. An
  open sidebar picks them up through the session feed, which counts a changed title as a changed
  row (§app.decisions/push).

**The button.** On the heads of Live & web, each user group, Organizations and the Archive, a
quiet 44px ghost icon button (`pencil`) at the head's right end, before a group's `⋯`, shown only
while that section holds at least 1 **nameable** row: a row with no stored title (no `titleBy`,
no `originalTitle`) that is not a draft-only row. Its `aria-label` and `title` are "Name {n}
sessions" ("Name 1 session"), counting the section's rows as the search shows them, each session
once. A press sends exactly those rows; while it runs the button is disabled, `aria-busy`, and
titled "Naming {n} sessions…". When it returns the list is fetched again and the rows show their
new titles. **No toast, no undo**: a title the user doesn't like is renamed or cleared like any
other (§app.session-list/selecting-several-sessions). A click or keypress on the button inside a
`<summary>` never toggles its section. A row the model failed on stays nameable, so a second press
tries it again.

`POST /api/sessions/auto-title {paths, dryRun?}` (at most 200 paths) answers
`{results: [{path, outcome, title?, reason?}]}` in request order, 4 sessions at a time: `named`
with the title, `would-name` on a dry run, or `skipped` with a reason — `explicit` (it has a title
a user or the Overseer set), `not-found`, `not-listed` (a husk, a worker's session, an Overseer
file), `no-input` (nothing to name it from), `no-model` (no title model can run) or `failed` (the
models failed, or answered with no usable title). The route may name an archived session and one
with no summary line, and **may redo an `auto` title**, never an explicit one; the button itself
sends only unnamed rows.

**Mesh.** Each host names its own sessions, with its own settings, models and keys. The button
splits a section's rows by host and sends each peer's rows to that peer
(`/peer/<id>/api/sessions/auto-title`, the usual routing); a peer whose Sova predates the route
answers 404, and its rows are skipped silently. Each host's sweep follows that host's own switch.

## §app.session-list/regions-top-and-archive — Regions: top and Archive

`SessionSummary.origin` and `archived` divide the sessions into two regions (`isTopSession` in
`src/lib/regions.ts`):

- **Top region:** sessions where `live !== null || (origin === "web" && !archived)`, meaning
  the ones running in a TUI right now, or started from Sova and not archived by the user.
- **Archive:** every other session. A server that sends no `archived` counts as not archived.
- **Neither:** the special sessions (§app.session-list/ordinary-surfaces). An Overseer file
  (`SessionSummary.overseer`, §app.overseer/identity-and-clear) is in no region, like a worker's own
  session. An organization session (`SessionSummary.org`) is in neither of these two whatever its
  `live`, `origin` or `archived`: it lives only in the Organizations region
  (§app.session-list/organizations), between the top region and the Archive.

Both regions use exactly the same folder groups and rows described above. Each region groups by
`cwd` independently, so one folder can appear in both. The Groups region above them is a third
region that cuts across these two: a session in a group keeps its row here as well, so a folder —
and a session — can appear in all three at once.

### What orders a region

Each region sorts for the question it answers, and they are not the same question:

- **Live & web** orders by **`createdAt`, newest first** — when the session was STARTED. Folder
sections sit where their newest session puts them, and rows inside a folder are newest-created
first. `createdAt` is written once, in the JSONL header, and nothing an agent does moves it: a
folder does not jump to the top because a background subagent wrote a line in it, and a session
you started an hour ago is still an hour old however much output it has produced since. This is
the region you scan to find the session you started, so the stable fact is the one to sort on.
Ties break on `id`, and folder ties on `cwd` — uuidv7 ids and folder names are unique, so two
sessions sharing a millisecond still have one order, and it is the same order on the next poll.
- **The Archive and its date sections** order by **`lastActiveAt`, newest first** — unchanged. The
Archive is a place you look back from, and the last thing that happened is the handle you reach
for. **Recent** reads the same field for the same reason (§app.session-list/recent).
- **A user's group** orders by `lastActiveAt` too, inside the folder sections it draws.

Both rules live in `src/lib/session-order.ts` (`groupByCreation`, `groupByActivity`); the sidebar
picks one per region and the folder markup is shared.

```html
<nav class="sidebar-list pane" aria-label="Session list">
  <!-- Top region. With 0 rows and no query, keep the head ("Live & web · 0") and replace the
       groups with <p class="sidebar-region-note">0 sessions open in a TUI, or started here and not archived. The archive below has the rest.</p>.
       With 0 rows while searching, omit the region. -->
  <section class="sidebar-region" aria-labelledby="r-top">
    <h2 class="sidebar-region-head" id="r-top">
      Live &amp; web <span class="sidebar-region-count">· 5</span>
    </h2>
    <details class="session-group" aria-labelledby="g-1" open>
      <summary class="session-group-head">
        <h3 class="list-group-label" id="g-1" title="/home/user/webapps/sova">…same as above…</h3>
      </summary>
      <ul class="list">…session rows…</ul>
    </details>
  </section>

  <!-- Archive: omitted entirely when it has 0 rows -->
  <details class="sidebar-region sidebar-archive" open={archiveOpen()} onToggle={…}>
    <summary class="sidebar-region-head">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <span>Archive</span>
      <span class="sidebar-region-count">· 43</span>
    </summary>
    <details class="session-group" aria-labelledby="ga-1" open>
      <summary class="session-group-head">
        <h3 class="list-group-label" id="ga-1" title="/home/user">…</h3>
      </summary>
      <ul class="list">…session rows…</ul>
    </details>
  </details>
</nav>
```

**Separation.** Each region opens with a 44px `.sidebar-region-head` strip on `--color-sunken`.
The label is mono, micro, and uppercase, in `--color-ink-2`, and the count is in
`--color-ink-muted`. Regions are divided by a `--color-border` rule. The strip is a ground change
from the `--color-surface` sidebar, not a color accent, so it stays inside the color budget.
Folder labels keep sticking to the top of the pane as you scroll. Region heads don't stick.

**Labels.** The top region is "Live & web · {n}" and the archive is "Archive · {n}". While a
search is active, each shows "· {hits} of {total}" for that region.

**Empty top region.** With no query, the head stays ("Live & web · 0") and the groups are
replaced by `.sidebar-region-note`: "0 sessions open in
a TUI, or started here and not archived. The archive below has the rest." The archive is also
forced open (case 1 below).

**Archive open/closed state.**

- It's a native `<details>`, **collapsed by default**. The whole 44px summary row toggles it,
  and the chevron rotates 90° when open.
- Remember the user's choice in `sessionStorage["sova:archive-open"]` (`"1"`/`"0"`), read on
  load and written on `toggle`. It lasts for the browser session, not across restarts.
- It opens automatically, **without** changing the stored choice, when:
  1. the top region is empty (otherwise the sidebar would show nothing but a closed strip);
  2. the selected session (from the URL) is in the archive, so its `aria-current` row is
     visible;
  3. a search query is non-empty (see Search).

  When the condition ends, it goes back to the stored choice. Case 2 is the exception: it doesn't
  close under the user while they're on that session.

**Ordering.** The top region comes first and the Archive last, with Organizations between them;
above them all sit the shortcut regions, Needs you first; Profiles, under Groups (§app.session-list/profile-shelf). Inside each region, groups and
rows are ordered by the rules above. A session moves between regions in place on refresh, for
example when its TUI closes and `live` becomes null. If it's the selected row, it keeps
`aria-current`, and case 2 keeps the archive open.

**Archiving.** Sessions started from Sova (`origin === "web"`) can be archived by hand, so
the top region doesn't keep every one of them forever.

- **Where.** An Archive Session button, a small red trash icon (`trash.svg`) with no words, at the
  right end of the Session tab's Path heading row (§app.subagents-pane/tabs), only on web sessions. Rows are links, so it can't live in them: a button inside `<a>` is invalid and
  splits the row's single target. Dragging a row to the drop overlay's Archive tile
  (§app.session-list/drop-overlay) does the same, with an `Undo` on its toast.
- **What it does.** `POST /api/sessions/archive { path, archived }`, then a list refresh. The id
  goes into `~/.pi/agent/sova/archived-sessions.json`; the session file is never written, except
  that an empty husk outside any organization's workspace is deleted instead
  (§app.session-list/archive-org-guard): the server's answer says so (`deleted: true`), and the
  toast is "Deleted. It had no messages, so there was nothing to archive." with no Undo.
  Otherwise the toast is "Archived. Find it under Archive." The row moves to the Archive, and case 2 keeps it
  visible while it's open.
- **Undo.** On an archived session the same button, not red and with the undo icon
  (`undo.svg`), is Unarchive Session. Toast: "Moved back to
  Live & web."
- **Live.** A live session stays on top whether archived or not, and still shows its TUI rail
  pill.
  Archiving one is refused: the button is `aria-disabled`, and its `title` says "Open in a TUI.
  It stays on top while live." Unarchiving a live session works.
- **Failure.** Toast: "Couldn't archive this session. {server message}". Nothing moves.
- An archived session opens, chats, and searches exactly like any other row.

**Accessibility.**

- The top region is a `section` labelled by its `h2`. Folder labels become `h3`, since they're
  now nested one level deeper. A folder is a `<details>` (see Folder open/closed state) and its
  `h3` sits inside the `<summary>`: the heading and its level stay, `aria-labelledby` on the
  `<details>` still names the section, and `<details>` announces expanded or collapsed on its own.
- For the Archive, `<summary>` is what AT announces ("Archive · 43, collapsed"). Use a plain
  `<span>`, not a heading, inside it, because headings inside `<summary>` are exposed
  inconsistently. `<details>` announces expanded or collapsed on its own.
- Keyboard: Tab reaches the summary, and Enter or Space toggles it. Rows inside a closed archive
  aren't focusable, which is native `<details>` behavior.
- Contrast: ink-2 on sunken is 7.65 (dark) and 7.22 (light). Muted on sunken is 5.40 and 4.75.
- Touch: the summary is `--row-height`, 44px. At 320px the strip holds a 16px twist, the word,
  and the count, well inside the 288px of usable width.

## §app.session-list/ordinary-surfaces — Ordinary surfaces and the sessions they leave out

Most of the pane is **ordinary surfaces**: they list the operator's own sessions, and every one of
them reads the same predicate, so no surface can drift from the others. Two kinds of session are
**special** and never appear on any of them:

- **Overseer files** (`SessionSummary.overseer`, §app.overseer/identity-and-clear) — reached only through
  the Overseer's own door (the eye button, Alt+O, `#/overseer`). Unlike an organization session, an
  Overseer file is in no search and no region at all.
- **Organization sessions** (`SessionSummary.org`, §app.organizations/org-sessions) — reached only through
  the Organizations region (§app.session-list/organizations), which is built from the same search hits as
  every other region, so they stay searchable there.

Worker sessions are left out of every region too (they are reached through their owner's row), and
for the same reason: something other than the operator runs them.

**The ordinary surfaces**, each of which leaves both special kinds out:

- the global **Needs you** region (§app.session-list/needs-you) and its spine door;
- **Recent** (§app.session-list/recent), the spine's tiles, and the overview's `Last active` / `Resume`
  (§chat.transcript/landing-page) — enforced in Recent's own eligibility rule, so every caller gets it;
  these also leave out profile sessions (`SessionSummary.profile` set), which Profiles lists
  (§app.session-list/profile-shelf);
- **Live & web** and the **Archive** with its date sections, their counts and their spine doors
  (§app.session-list/regions-top-and-archive), and the overview's `{live} live` count;
- the **Archive cleanup**: its counts, its sweeps and its one-session list (§app.session-list/archive-cleanup;
  the server's guard is §app.session-list/cleanup-org-guard);
- the **Groups** region and every way into a group (§app.session-list/groups);
- the **recent folders** offered for a new session (`GET /api/cwds`, the New Session dialog's Recent
  folders, `sova_list_folders`): never the Overseer's folder
  (`<stateRoot>/overseer/`), never an attached org's workspace dir, and never a folder only an org's
  own conversations (a hand-off, a project overseer) ran in. A project root is still offered once an
  ordinary or coding session has run there: the operator codes there.

The rule is one predicate on the client, `isOrdinarySession` in `src/lib/regions.ts`: a main thread
(not a worker, not an Overseer file) with no `org`. It is deliberately **not** folded into
`isMainThread`, which the Organizations region, the Overseer page and the Agents board still read.
A server or mesh peer that sends no `org` leaves the session ordinary, exactly as it is listed today.

The toolbar's hidden count (`{n} sessions`, `{visible} of {total} sessions`) counts every session the pane
draws once — org sessions included, the Overseer's never — so the number always matches the list.

## §app.session-list/organizations — Organizations

The organizations' sessions, in one region of their own: the **last region before the Archive**, so
the pane reads Needs you → Recent → Groups → Live & web → **Organizations** → Archive. It is the only
place in the pane that lists an organization session (§app.session-list/ordinary-surfaces): hand-offs
and gathering sessions, offers, and the coding sessions a project started; each project's current
overseer is not a row but an **eye on its project's heading**, and its cleared conversations are in
no region (they are in the overseer's own History, §app.project-overseer/page). Shape: its own
**Needs you** list first, then **organization → project**, each project's rows in three groups:
**Conversations** and **Conflicts to settle** (each split Not started / In progress / Done) and
**Builds** (running or waiting, then Done), every Done collapsed.

Standalone projects (§app.projects/standalone) have a **Projects** region of their own, right
before Organizations and shaped like it with no organization level: each project's heading with its
overseer's eye, then its Builds (§app.projects/list). A standalone project's overseer
conversations and coding sessions are listed there and on no ordinary surface, as an
organization's are here.

```html
<!-- Omitted entirely when it has no row and no eye (with a query: 0 hits), like the Archive. -->
<details class="sidebar-region sidebar-orgs" aria-labelledby="r-orgs" open>
  <!-- The Needs you head's pattern: the <summary> toggles, the <h2> is what the outline reads. -->
  <summary class="sidebar-orgs-summary">
   <h2 class="sidebar-region-head" id="r-orgs"
       title="Hand-offs, project overseers, and the coding sessions they started, by organization and project.">
    <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
    Organizations <span class="sidebar-region-count">· 12</span>
    <!-- only while ≥1 org session waits on you; open or collapsed -->
    <span class="chip chip-warn org-waiting" title="2 sessions waiting on you."><i class="chip-dot"></i>2 waiting</span>
    <!-- only while collapsed and an agent works in one of its sessions: Busy's dot, pulsing -->
    <span class="session-group-active" title="An agent is working in one of these sessions">
      <span class="session-rail-dot"></span><span class="visually-hidden">, an agent is working here</span></span>
   </h2>
  </summary>

  <!-- 1. Its own Needs you: only while it has rows. Not collapsible. -->
  <section class="org-needs-you" aria-labelledby="r-orgs-needs">
    <h3 class="list-group-label" id="r-orgs-needs"
        title="The 2 organization sessions waiting on you, newest first."><span class="org-needs-dot" aria-hidden="true"></span>Needs you <span class="text-num">2</span></h3>
    <ul class="list">…session rows: line 2 = what it waits on, line 3 = "{time} · {org} · {project}"…</ul>
  </section>

  <!-- 2. One per org, by name A→Z, ties on id. Open by default, memory only. -->
  <details class="session-group org-section" open>
    <!-- no folder or building icon: an org is not a folder on disk (the group head's rule) -->
    <summary class="list-group-label group-label org-label" title="5 sessions in Mamluk Arabia. 1 waiting on you.">
        <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
        <span class="group-name"><bdi>Mamluk Arabia</bdi></span>
        <span class="org-needs-dot" aria-hidden="true"></span><span class="visually-hidden">, 1 waiting on you</span>
        <span class="session-group-active">…</span>
        <span class="text-num">5</span>
      <a class="button button-icon button-ghost org-link" href="#/orgs/org_…"
         aria-label="Open the Mamluk Arabia page" title="Open the Mamluk Arabia page">…arrow-right…</a>
    </summary>
    <!-- one per project, by name; Other last -->
    <!-- the sticky project heading: the h4 is the outline's name, the eye sits beside it -->
    <div class="org-project-head">
      <h4 class="list-group-label org-project-label" title="~/webapps/rakiba-site">Rakiba site <span class="text-num">6</span></h4>
      <!-- only while the project has a current overseer; hung into the right gutter -->
      <a class="button button-icon button-ghost org-overseer" href="#/s/<its path>"
         aria-label="Open the Rakiba site overseer · working" title="Open the Rakiba site overseer · working"
         aria-current="page"><!-- only while its conversation is open -->
        …eye…
        <!-- at most one mark: Busy's pulsing dot (working), else the turn-error mark, else the unread dot -->
      </a>
    </div>
    <!-- the project's groups, in this order; a group with no row is omitted -->
    <section class="org-group" aria-labelledby="…">
      <h5 class="org-group-label" title="Gathering sessions and offers sent to people.">Conversations <span class="text-num">5</span></h5>
      <!-- each state only while it has rows; rows by lastActiveAt, newest first -->
      <h6 class="org-state-label">Not started <span class="text-num">1</span></h6>
      <ul class="list">…rows; line 2 is the hint: "Link not sent yet" / "Not opened yet" / "Opened, no reply yet"…</ul>
      <h6 class="org-state-label">In progress <span class="text-num">2</span></h6>
      <ul class="list">…</ul>
      <!-- collapsed, memory only -->
      <details class="archive-date org-done">
        <summary class="list-group-label archive-date-label" title="Done or closed, and the ones you archived.">
          <svg class="icon icon-sm icon-twist" aria-hidden="true">…</svg> Done <span class="text-num">2</span></summary>
        <ul class="list">…</ul>
      </details>
    </section>
    <section class="org-group">
      <h5 class="org-group-label" title="Sessions asking someone to settle two decisions that disagree.">Conflicts to settle <span class="text-num">1</span></h5>
      …the same three states; each row's line 2 names what is in conflict: "In conflict: invoicing"…
    </section>
    <section class="org-group">
      <h5 class="org-group-label" title="Coding sessions this project started.">Builds <span class="text-num">3</span></h5>
      <ul class="list">…running or waiting…</ul>
      <details class="archive-date org-done">…Done: merged (per git) or archived…</details>
    </section>
  </details>
</details>
```

- **Which sessions.** Every search hit with `SessionSummary.org` (§app.organizations/org-sessions) — the
  same hit list every region reads, after the host filter and the query. `org` wins over every other
  field: a TUI-live org coding session, a web one, an archived one all live here and nowhere else in
  the pane — except a cleared overseer conversation, which no region lists. Rows are the unchanged `SessionRow` — rail (a TUI word included), unread dot, turn-error
  mark, needs-you mark, baton holder suffix, context ring — and open `#/s/<path>`.
- **An archived project is left out** (§app.organizations/archive): a session whose `org` carries
  `projectArchived` is in no org → project list, its project has no heading and no eye, and it is
  not in the region's count (nor its org's). Only while it waits on the operator is it shown, in the
  region's own Needs you. An org whose every project is archived and none waiting has no section; a
  region with nothing else left is omitted, as with no rows.
- **Its Needs you.** The region's first block, above the organizations: every org session **waiting on
  the operator**, one row per session, labelled with its place. A session waits on you when it isn't
  finished and its `baton`
  carries `needsYou` (a person's question, a limit reached), `sendLink` (a link to send) or at least
  one of `proposals` (a referral to approve) — read from the session list, so it holds whatever
  Overseer proactivity is — or when the attention digest has an **act** item for it (a dialog open, an
  errored turn, a worker error; §app.overseer/attention-digest). **Line 2** is the sentence of its newest
  waiting item: the digest's, verbatim, else the same words built from the baton — "{from} → you:
  {question}", "Send {to} their link: {question}", "Approve {name} ({role}) proposed by {by}?" — with
  every sentence, newest first, in its `title`. **Line 3** reads "{time} · {org} · {project}" in place of
  the model (no project: "{time} · {org}"). Order: newest waiting item first (`since`), ties on path.
  Like the global Needs you, it is a **shortcut, not a place a session lives**: each row is still under
  its project. Not collapsible (the region's own twist collapses it); omitted when it has no rows. The
  global Needs you never lists these sessions (§app.session-list/needs-you). Like a global Needs you
  row, a row here has no button or menu of its own: it leaves when what it waits on is answered.
- **A project's items, too.** The same block lists the digest's items that belong to a project
  rather than a session, each a row opening the project page with the digest's sentence: first each
  held act (§app.project-overseer/holds), the one going ahead soonest on top, its sentence recounted
  on the list's clock and **Cancel** beside the row; then, newest first, each conflict for the
  operator to settle (`conflict-to-operator`, §app.requirements/routing) and each project whose main
  stakeholder left (§app.organizations/stakeholder), and each overseer's WhatsApp message that was
  not sent (`outreach-not-sent`, §app.outreach/send), which opens the person's page instead. Line 3
  names the org. The block, and the
  region, show while only such items wait.
- **Organization → project → rows, always.** The org level is drawn even with one org, so the shape
  doesn't change when a second is attached. There are no `cwd` folder heads: every gathering session
  shares the workspace folder, which means nothing to the operator. Orgs sort by name, then id; projects
  by name. A project the org's statecharts no longer know is "Unknown project"; a workspace file with
  no project is "Other", which sorts last.
- **The project level is a sticky label, not a section** (an `h4`, sticking like a folder label). Its
  `title` is the project root, `~`-shortened, read from the project overseer's folder when the region
  holds one; otherwise the project's name (the list carries no project root). At
  folded width only project labels stick; org summaries don't, so two sticky levels don't eat the screen.
- **Order inside a project.** Rows by `lastActiveAt`, newest first, ties on `createdAt` then `id`
  (`src/lib/session-order.ts`'s activity comparator): the question here is who replied.
- **The project overseer's eye.** The project's current overseer (`org.kind` `overseer`, not
  finished) is never a row: it is a 44px ghost **eye** link at the end of its project's heading, hung
  into the right gutter like the org link, opening `#/s/<its path>` (a plain link: nothing is
  written). A project with no overseer yet has no eye; its project page's Start Overseer is the way
  in. The eye reads only the session list, so nothing more is fetched, and carries at most one mark,
  in this order: **working** (the row's Busy: Busy's pulsing dot, the one sanctioned animation),
  **last turn failed** (the row's turn-error mark), **new reply** (the row's unread dot). Its name
  says the same: "Open the {project} overseer", plus " · working", " · last turn failed" or " · new
  reply". While its conversation is open the eye is tinted selected with `aria-current="page"`, like
  the global Overseer's eye on `#/overseer`, and shows no failed or new-reply mark (you are looking at
  it). Level and pause are not shown here: they are its chat head's (§app.project-overseer/page).
  Should a project ever list two current overseers, the newest is the eye and the other stays a row.
- **The project's groups**, in this order, each omitted while it has no row (a project with only an
  overseer is its heading and eye):
  - **Conversations**: its gathering sessions and offers (`org.kind` `gathering`/`offer`) that are not
    settle sessions.
  - **Conflicts to settle**: its settle sessions (`baton.settle`, §app.organizations/org-sessions),
    whoever started them — the operator's Reconcile or re-route, a project overseer's reconcile, or
    the run Sova starts itself after a resolution. Each row's line 2 names what is in conflict:
    "In conflict: {area}".
  - **Builds**: its coding sessions (`org.kind` `coding`: the overseer's, Start Coding Session's and New Coding Session's).
  - A workspace file no project claims (`other`) is a plain row under its project ("Other"), with no
    group.
- **The three states** of a conversation or a settle session, each a label with its count, shown only
  while it has rows: **Not started** — nobody it was sent to has written yet (`baton.written` absent),
  even if a link was opened; **In progress** — someone has written and it isn't done or closed;
  **Done** — `done` or `closed` (`org.finished`), or archived. A Not started row's line 2 is a hint:
  "Link not sent yet" (no live link), "Opened, no reply yet" (a person opened a link, `baton.opened`),
  else "Not opened yet"; one the operator holds (Needs you says it) has none. On a settle row the hint
  follows the conflict: "In conflict: {area} · Opened, no reply yet".
- **Builds** list the running and waiting ones (the row's own rail says which); a build **merged**
  (per git, `org.finished`) or archived is in the group's Done.
- **Done** is a collapsed tail in each group (memory only, like the Archive's date sections), omitted
  when empty; it replaces the old per-project Finished list. A **cleared overseer conversation** (an
  `overseer` session that is finished) is listed nowhere in the pane: its overseer's History opens it.
- **Counts are sessions.** The region head counts every row it holds once, Done included (a Needs
  you row is not counted twice); while searching it reads "· {hits} of {total}". The eye is not a row
  and is not counted, and neither is a cleared overseer conversation. Each org's count stays visible
  open or closed, like a folder's in Live & web; each project counts all its rows, Done included, and
  each group, state and Done counts its own.
- **Nothing waits unseen.** While any org session waits on you, the region head carries a warn chip —
  dot and word, "{k} waiting" — open or collapsed, and so does the spine door (below). Each org summary
  carries a wordless warn dot with its hidden clause (", {k} waiting on you") and the count in its
  `title`. A collapsed region head, and an org head open or closed, carry Busy's pulsing dot while an
  agent works in any of its sessions (the folder head's mark, §app.session-list/content-rules).
- **Open by default; a collapse is remembered for the tab** in `sessionStorage["sova:orgs-open"]`
  through `writeKey`, `"0"` collapsed and anything else open (the Needs you pattern). Orgs open by
  default and every Done stays closed, both in memory only. **Forced open**, without changing the stored
  choice: while a search is on (with every org and Done that holds a hit); and while the selected
  session (from the URL) is inside — then its org and, if needed, its Done are forced open too, so
  its `aria-current` row, or its project's `aria-current` eye, is visible (the Archive's case 2: it
  doesn't close under the operator while they're on that session).
- **The org link.** Each org summary ends with a 44px ghost icon link to `#/orgs/<id>`, hung into the
  right gutter like a group's `⋯`; it stops its own click and keydown so it doesn't also toggle the org.
  Names truncate with an ellipsis, the full name in `title`.
- **Archiving.** Org sessions are web sessions, so the session head's Archive button and the drop
  overlay's Archive tile (§app.session-list/drop-overlay) still work (§app.session-list/regions-top-and-archive "Archiving"). The row moves to its
  group's **Done** in its project, never to the Archive; Unarchive moves it back. A workspace file is never
  deleted by archiving, even empty (§app.session-list/archive-org-guard); an org coding session
  nothing was ever sent in is a husk like any other and is deleted. Toasts: "Archived. Find it in
  {project}, under Done." and "Moved back to {project}." (no project: "Archived. Find it in {org},
  under Done." / "Moved back to {org}."; a project with no name left: "its project").
- **Never grouped.** An org session can't be put in a group (§app.session-list/groups).
- **Search** matches an org row on the org's name, the project's name and the baton holder's name, on
  top of the usual fields, and a settle session on its conflict's area, so "rakiba", a person's name
  or "invoicing" finds it (§app.session-list/search). A
  search that hits a project's current overseer and nothing else there shows that project's heading
  and eye with no rows.
- **The spine** carries a door for the region, shown exactly when the region is on screen: the
  `building` icon over the region head's count, named "Organizations · {n} sessions" in its `title`
  and `aria-label`, plus " · {k} waiting on you" and a warn dot at its corner while any org session
  waits (§app.session-list/spine). Pressing it expands the pane, scrolls the region into view and
  focuses its `<summary>`; the stored open state is left alone.
- **Accessibility.** The region head is the Needs you region's form, a `<summary>` wrapping the `h2`
  the outline reads; org heads and Done are `<summary>` with plain spans (headings inside a
  summary are exposed inconsistently — the Archive's rule); the Needs you label is an `h3`, project
  labels `h4`, group labels `h5` and state labels `h6`, and a project's eye is a real link beside its `h4`, never inside it. The warn and
  working dots carry hidden words. Enter or Space toggles; the org link and the eye are real links
  with a name.

## §app.session-list/archive-by-date — Archive by date

The Archive (only; the top region is unchanged) splits into date sections first, then into the
usual folder groups inside each section. Sections, newest first, keyed on `lastActiveAt` by
**local calendar day** in the browser's time zone (`archiveGroupOf` in `src/lib/archive.ts`):

| Section | `lastActiveAt` is |
|---|---|
| Today | today (a future time from clock skew counts as today) |
| Yesterday | the previous calendar day |
| Last 7 days | 2–7 calendar days ago |
| Last 30 days | 8–30 calendar days ago |
| Older | more than 30 days ago, or unparseable |

```html
<details class="sidebar-region sidebar-archive" open>
  <summary class="sidebar-region-head">…Archive · 43…</summary>
  <details class="archive-date" open={dateOpen(d)} onToggle={…}>
    <summary class="list-group-label archive-date-label">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <span class="archive-date-name">Today</span><span class="text-num">4</span>
    </summary>
    <details class="session-group" aria-labelledby="a-today-0" open>
      <summary class="session-group-head">
        <h3 class="list-group-label" id="a-today-0" title="/home/user">…folder, path, count…</h3>
      </summary>
      <ul class="list">…session rows…</ul>
    </details>
  </details>
  <div class="archive-tools">…Clean Up…, see Archive cleanup…</div>
</details>
```

- **Order.** Rows keep the `lastActiveAt`-descending order; folder groups inside a section follow
  the usual rule (their newest row first), so one folder can appear in several sections.
- **Empty sections** are omitted, including while a search filters the list. The count is the
  rows visible in that section.
- **Collapsed by default.** Each section is a native `<details>`, so an open Archive first reads
  as five short lines (label + count), not a wall of rows. The whole 44px summary toggles it, and
  the chevron rotates 90° when open, like the Archive head. Folder groups inside an open section
  collapse on the same rule as everywhere else, and are collapsed by default too (see Folder
  open/closed state), so opening a date section shows its folders, each one line.
- **Open/closed state** follows the Archive's rule: the user's choice per section lives in
  `sessionStorage["sova:archive-date-open-{id}"]` (`id` is `today`, `yesterday`, `week`,
  `month`, `older`; `"1"`/`"0"`), read on load and written on `toggle`. A section opens
  **without** changing its stored choice while a search query is non-empty (so every hit is
  visible) or while it holds the selected session.
- **Look.** The summary is the `.list-group-label` eyebrow (mono, micro, uppercase, muted), plus
  semibold, at `--row-height`: a 16px twist in the folder icon's column, the name, and the count
  at the right. Hover inks it. It doesn't stick; the folder labels under it keep sticking. A
  `--color-border` rule separates sections and sits under an open section's summary. No new
  colors.
- **Accessibility.** AT reads the summary ("Today 4, collapsed"); it holds spans, not a heading,
  for the reason given under Regions. Folder labels inside stay `h3`, each inside its own folder
  `<summary>`. Tab reaches each summary,
  Enter or Space toggles it, and rows in a closed section aren't focusable.
- **Row time vs section.** Row line 2 still uses `relativeTime`, which counts 24-hour spans, so
  just after midnight a row can read "3h ago" under Yesterday, or "yesterday" under Last 7 days.
  Accepted: the section answers "which day", and the row answers "how long ago".

## §app.session-list/archive-cleanup — Archive cleanup

One quiet button at the end of the open Archive, after the date sections, deletes old or empty
sessions in bulk. It uses `POST /api/sessions/cleanup` (`cleanupSessions` in `src/lib/api.ts`).

```html
<div class="archive-tools">
  <button class="button button-sm button-ghost" aria-haspopup="dialog">Clean Up…</button>
</div>
```

- **Why one button.** Three delete buttons inline read as a toolbar competing with the date
  labels. One ghost `button-sm`, right-aligned in its own row under a `--color-border` rule, sits
  where a list's footer action would. The ellipsis says a dialog comes first.
- **Picker.** Clean Up… opens a `.modal` (`role="dialog"`, focus trapped, focus starting on the
  first action): title "Clean Up Archive", the line "Pick what to delete. You'll see how many
  sessions match before anything is deleted.", then the three actions as `.list-row` buttons in a
  bordered `.cleanup-choices` box (`--r-lg`). Each row shows the label (`.list-title`), its scope
  (`.list-meta`, the same `cleanupScope` text as the confirm dialog), and a chevron. Accessible
  names stay "Delete Sessions Older Than 7 Days", "… 30 Days", "Delete Empty Sessions", with the
  scope as the description. Foot: spacer · `Cancel`. Esc and the scrim cancel.

```html
<ul class="list cleanup-choices">
  <li><button class="list-row list-row-interactive cleanup-choice" aria-label="Delete Sessions Older Than 7 Days" aria-describedby="cleanup-pick-0">
    <span class="list-main"><span class="list-title">Older Than 7 Days</span>
      <span class="list-meta" id="cleanup-pick-0">Sessions last active more than 7 days ago.</span></span>
    <svg class="icon icon-sm">…chevron-right…</svg>
  </button></li>
  …Older Than 30 Days, Empty Sessions…
</ul>
```

- **Actions.** `{ mode: "age", minAgeDays: 7 }`, `{ mode: "age", minAgeDays: 30 }`, and
  `{ mode: "husks" }` (sessions nothing was ever sent in — drafted ones included, and deleting
  one drops its stored draft too). The server decides what matches and
  what it protects. The UI shows its numbers and never counts on its own. None of them ever
  matches a session in an attached organization's workspace `sessions/` (baton transcripts,
  project-overseer conversations), however old or empty; those are left out silently and are not
  in `skipped`. See §app.session-list/cleanup-org-guard.
- **Never an organization session in the picker** (§app.session-list/ordinary-surfaces): they are
  never in the Archive, so the one-session list below never offers one.
- **Hidden while searching.** Cleanup ignores the search, so a Clean Up… button under a
  filtered list would suggest it only acts on the matches.
- **Flow.**
  1. Pick an action: its row's meta line reads "Checking…" and every row and Cancel are
     `aria-disabled` while `dryRun: true` runs (Esc and the scrim do nothing then). When it
     answers, the picker closes and focus goes back to Clean Up…, so later dialogs return focus
     there too. On failure, the picker closes and a toast says "Couldn't check what to delete.
     Nothing was deleted. {server message}".
  2. The confirm dialog (`.modal` with `role="alertdialog"`, focus trapped, and focus starting on
     **Cancel**) shows the dry run's count, which is `deletedIds.length`, or `deletedCount` when no
     ids are sent:
     - Title "Delete {n} sessions?", then the scope ("Sessions last active more than 7 days
       ago." or "Empty sessions: nothing was ever sent in them."), then "This permanently deletes
       their transcript files — this can't be undone."
     - If any were skipped, a muted caption: "{n} skipped: {a} open in a TUI, {b} mid-turn, {c}
       just written. They stay as they are." It lists only the nonzero reasons.
     - Foot: `Delete {n} Sessions` (`.button-destructive`, "Deleting…" while pending) · spacer ·
       `Cancel`. Esc and the scrim cancel, except while deleting.
     - With 0 to delete, the title is "0 sessions to delete." and the body adds "Nothing matches
       right now, so nothing was changed.". The foot has only `Close`.
  3. Confirm: `dryRun: false`, then toast and announce "Deleted {n} sessions." (with the skipped
     sentence appended when nonzero) and refresh the list. If the open session's id is in
     `deletedIds`, go to `#/`.
  4. On failure: toast "Couldn't delete sessions. Some may be gone; the list is refreshed. {server
     message}", then close the dialog and refresh anyway.
- **Lenient responses.** Missing or malformed fields read as 0, or as no ids
  (`parseCleanupResult`), and never throw. A server without the endpoint (404) goes down the
  failure path in step 1.
- **Width.** One button fits any sidebar width. At 320px the picker is the usual bottom sheet
  and the scope lines wrap rather than ellipsize, since the cut-off part ("30 days") is the point.

### Deleting one session

The bulk actions never name a row, so one bad session would sit in the Archive forever. The
picker's second half fixes that: below the three bulk actions, when any session carries the
archive mark, the line "Or pick one archived session to delete for good." and one `.cleanup-choice`
row per archived, not-live, ordinary session — newest first, titled with the session's own title, its meta
the relative time, its accessible name `Delete “{title}”`. The bulk actions stay the first focus.
Hidden while the Archive holds no archived row (the operator's order: archive first, delete
after).

- **Request.** `{ mode: "paths", paths: string[] }` — 1 to 100 paths, each validated exactly like
  the archive route's `path` (`resolveSessionPath`), so a path outside the sessions dir is a 400
  before anything runs. The UI always sends exactly one.
- **Guard.** Only sessions carrying the archive mark are deletable this way; that's the order of
  operations (§app/session-list "Archiving"), and it's what stops a mis-click from destroying live work. An
  unarchived session is refused with the reason "Not archived — archive it first, then delete it."
  The bulk rules apply unchanged: live, mid-turn and just-written sessions are skipped and counted
  in `skipped`, and a file whose header doesn't parse, one that's already gone, or a path outside
  the sessions dir is refused rather than deleted. Refusals come back in the response's additive
  `refused: [{ path, reason }]` (absent for age and husks), one entry per refused path. A
  session in an attached organization's workspace is refused even when archived, with the reason
  "Belongs to an organization's workspace — Clean Up never deletes it." See
  §app.session-list/cleanup-org-guard.
- **Flow.** The same dry-run-then-confirm flow as the bulk actions, through the same dialog: for
  one path the scope line reads "One archived session: “{title}”." and the irreversibility line is
  singular — "This permanently deletes its transcript file — this can't be undone." Refusals show
  as muted captions (`“{title}”: {reason}`), and the toast appends their reasons; with 0 candidates
  and a refusal the body says "Nothing was deleted."
- **After.** The list refreshes like the bulk path, and the open session's deletion navigates to
  `#/` for the same reason (a transcript that can no longer load).

## §app.session-list/cleanup-org-guard — Cleanup never deletes organization sessions

Every session file inside an attached organization's workspace `sessions/` folder (baton
transcripts, project-overseer conversations, anything else started there) is out of reach of
`POST /api/sessions/cleanup`, in every mode. That folder belongs to the organization, and its
statecharts point at those files by name, so deleting one leaves a record whose
transcript is gone.

- **Older Than 7 / 30 Days, Empty Sessions.** An organization file never matches, however long it
  has been idle and whether or not anything was ever sent in it (a fresh baton waiting on its first
  link is a husk by shape). It is left out silently, like the Overseer's files, and is not counted
  in `skipped`.
- **Dry run = real run.** The count the confirm dialog shows comes from the same rule, so it never
  includes a file the delete would then refuse.
- **One archived session (`paths`).** Even archived and named, an organization file is refused with
  the reason "Belongs to an organization's workspace — Clean Up never deletes it."
- **Which folder.** The server's own mapping from a session path to its attached organization
  decides membership. Ordinary sessions, and a folder no longer attached, follow the usual rules.

## §app.session-list/archive-org-guard — Archiving never deletes organization sessions

Archiving an empty husk (a session nothing was ever sent in, with no stored draft) deletes its
file, since the list never shows a husk and an archive mark on it could never render. A session
file inside an attached organization's workspace `sessions/` is the exception: `POST
/api/sessions/archive` never deletes one. A fresh baton still waiting on its first link is a husk
by shape, and the organization's statecharts name those files, so deleting one leaves a
record whose transcript is gone.

- **Archived instead.** Such a session is archived like any other: it gets the archive mark and
  its runtime is closed, and its file, its web origin, draft, title, tags, attachments and group
  stay as they were.
- **Which folder.** The same mapping as §app.session-list/cleanup-org-guard decides membership.
  Ordinary husks, and a folder no longer attached, are still deleted on archive.

## §app.session-list/search — Search

- **Matching.** Case-insensitive substring match on `title`, `cwd`, `model`, and the session's
  tags (§app.decisions/session-tags: its topic, as stored and as displayed — `bugfix` and
  "bug fix" — and its manual tags), filtered on the client as
  the user types (no debounce needed for fewer than 2k rows). Without tags, a row matches as before.
- **Empty groups.** A group with no matching rows is hidden, and so is a region with none.
- **Organization rows** also match on the org's name, the project's name and the baton holder's
  name (§app.session-list/organizations).
- **Every region.** The query filters the top region, Organizations and the Archive alike. While the query is
  non-empty, the Archive is forced open so matches are never hidden in a collapsed region.
  Clearing the query restores the stored open/closed choice. The count row
  (`{visible} of {total} sessions`) covers both regions, and each region head shows its own
  filtered count.
- **Count.** `.search-count` always says `{visible} of {total} sessions`, and just
  `{total} sessions` when the query is empty, but it is **never printed**: it stays in the DOM,
  visually hidden at rest and while searching alike, as the field's `aria-describedby` and the
  polite live region that speaks the filtered count. The line shows no resting session total.
- **One toolbar line, every width.** Below the brand row the pane carries exactly one toolbar
  row, unfolded and folded alike — the desktop's separate search row and count row are gone.
  Left to right it holds: `Select` (while not in selection mode,
  §app.session-list/selecting-several-sessions), then a wordless **search icon button**, and at
  the right end the Overseer entry button (§app.overseer/entry-button), a labelled button with
  its unread badge. The field is not on screen until that icon is pressed; then it opens **in
  the same line**, focused at once, and the line holds only the field (with its Clear Search `×`
  while there is a query) and a **Close Search** button — `Select`, the search icon
  and the Overseer button are gone from it. The hidden count stays in the DOM, so the
  field's description and the live count still speak. The line stays open while there is a
  query, and blur never closes it: leaving the field and coming back finds it as it was left.
  **Close Search** clears the query and folds the line back, and focus returns to the search
  icon.
- **Keys.** `/` anywhere, while focus isn't in a text field, focuses search — on the closed line
  it opens the line first, at every width (from the spine, the pane expands first,
  §app.session-list/spine). `Esc` inside search clears the query first; a second press closes
  the line, as Close Search does. Clear Search returns focus to the input.

## §app.session-list/states — States

| State | What renders |
|---|---|
| Loading (first fetch, after 300ms) | 6 × `<div class="skeleton skeleton-row">` inside `.sidebar-list`, separated by `--space-2`. Put `aria-busy="true"` on the `nav`. Nothing appears before 300ms |
| Error | `.banner.banner-error` at `--space-3` inset, with `alert-circle`. Title: "Couldn't read your sessions." Body: "`~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry." `.banner-action`: `<button class="button button-sm">Retry</button>`. If rows loaded earlier, keep them visible below the banner |
| Empty (0 sessions on disk) | `.empty`. Title: "0 sessions in `{dir}`.", `{dir}` the sessions folder of the server's own agent dir (`GET /api/sessions/dir`), with the home folder as `~` (`~/.pi/agent/sessions` on a default host); until the server has said, "0 sessions yet." Body: "Start one here, or run `pi` in a terminal. It'll show up in this list." One `.empty-action`: `New Session` (secondary) |
| No matches | `.empty`. Title: "0 of 48 match “{query}”." Body: "We search titles, folders, models, and tags." Action: `<button class="button">Clear Search</button>` |

## §app.session-list/tokens — Tokens

Sidebar ground `--color-surface`. Row hover and `:focus-within` `--color-sunken`, both on
`.session-row-shell`; open row `--color-accent-tint` on `.session-row-shell-current`.
Title `--color-ink`, `--fw-medium`, `--fs-body`. Summary `--fs-micro`, `--lh-micro`,
`--color-ink-2`. Meta (line 3) `--color-ink-muted`, `--fs-micro`, `--lh-micro`, scoped to
`.session-row .list-meta`; the model's `.text-mono` inherits that size rather than keeping its
own, which would set it larger than the time beside it. Micro here is a recorded exception
(§design/deviations): the line is two facts, never a sentence. `.list-meta` elsewhere stays
caption.

**The rail** (a session row's status column, inside the expanded pane — not the spine, which is
the whole pane collapsed). A 30px column with `margin: 0 2px` — a 34px gutter, title 34px from the
panel edge. Rail padding is `--space-2` on **top only**, matching the row link: the horizontal
breathing room is the margin, so the 30px box stays symmetrical and every item centres on its
x=17 axis. Items stack centred with `--space-1`.
`.session-rail-state` (Busy) is `width: 26px`, `height: calc(--fs-body × --lh-body)`, padding 0,
a `--stroke-thin` transparent border and no background, holding a 7px `--r-full`
`currentColor` `.session-rail-dot`; tone `.chip-info`. `.session-rail-tui`, declared after it so
it wins at equal specificity, turns that box into the word chip: `width: auto`, `height: auto`,
`min-height: 16px`, padding `0 1px`, `margin-top: calc((--fs-body × --lh-body − 16px) / 2)`,
the border still transparent (`--color-border-strong` on `:hover`), `--color-surface` behind it
— on a hovered or current row the row is `--color-accent-tint`, and accent ink needs a plate to
hold its contrast — tone `.chip-accent`, and its own type: `--fw-semibold` `--font-mono` at
**9px**, line-height 1, `letter-spacing: 0`, uppercase. It sets its own type because
`.session-rail-item`'s `font: inherit` out-cascades `.chip`'s. The 9px is an **off-scale size
for this one chip**, at the user's request: the scale bottoms out at `--fs-micro` (11px), and a
token below it would be a system-wide claim rather than a local one; the button's `aria-label`
and `title` carry the meaning, not the glyph size. The count is
borderless, 16px tall, `--font-mono` `--fs-micro` tabular in `--color-ink-muted`
(`--color-ink` on hover), with an 11px `worker` icon; as the rail's first item it takes the TUI
chip's `margin-top`, and after a state `margin-top: −--space-1`. `live-pulse` runs on the Busy
dot and on `.session-rail-count-live .icon`, nothing else in the row; the folder head's
`.session-group-active` (`--status-info`, inline-flex, `flex: none`) pulses the same
`.session-rail-dot`.

**The spine.** `--spine-width` 64px, `.app-sidebar`'s `border-right` kept; 44px items leave 9.5px
either side of the 63px content box, so a focus ring (2px offset + 2px width) clears the edge.
`.spine` is a flex column; `.spine-head`, `.spine-regions`, `.spine-stats` and `.spine-foot` are
`flex: none` columns, gap `--space-1`, padding `--space-2` 0, each after the head with a
`--stroke-thin` `--color-border` top rule; `.spine-head`'s top padding is `(56px − --tap-min) / 2`,
so Expand centres where the head's Collapse did. `.spine-tiles` is `.pane` with `flex: 1`, the same
gap, padding and rule, and `min-height: --tap-min + 2 × --space-2`. `.spine-item` is a ghost
`.button-icon`: transparent border and ground, `--color-ink-muted`; hover and press
`--color-sunken` with `--color-ink`; `[aria-current="page"]` `--color-accent-tint` with
`--color-ink`. `.spine-region` / `.spine-stat` stack the 16px icon over `.spine-count`, 2px apart;
the count is `--font-mono` `--fs-micro` tabular, line-height 1, `--color-ink-muted` (`inherit` on
hover). `.spine-tile` is 44 × 44, `--r-md`, `--color-ink-2` monogram in `--font-mono`
`--fs-mono` `--fw-medium` (the capitals are in the string, from `monogram()`; the tile's
`text-transform: uppercase` is redundant, not the mechanism); hover `--color-sunken` / `--color-ink`, current
`--color-accent-tint` / `--color-ink`, focus the standard ring. `.spine-dot` is 8px, `--r-full`,
`--space-1` in from the tile's top-right corner: `-live` `--color-accent` fill, `-busy`
`--status-info` fill, `-working` a `--stroke-icon` `--color-ink-muted` ring with no fill.
`live-pulse` runs on `-busy` and `-working` and on nothing else in the spine.

**Lines 2 and 3.** `.list-line` is `display: flex`, `align-items: center`, gap `--space-2`,
`min-width: 0`, `flex-wrap: nowrap`. The line's `2px` top margin moves off `.list-summary` /
`.list-meta` and onto `.list-summary-row` / `.list-meta-row`, so the rhythm is the one the row
already had and the margin can't collapse against the indicator; inside the wrapper the text is
`flex: 1; min-width: 0; margin: 0` and keeps its own ellipsis, and the indicator is `flex: none`.
`.session-topics` is a `.chip.chip-count` with `background: none` (so it reads as part of the
row's ground, not a white pill on hover or on the current row's tint), `--color-ink-muted`,
padding `0 --space-1`, `line-height: 1`, and a height pinned to
`calc(--fs-micro * --lh-micro)` = 14.3px — the summary's own line box, which is what keeps it
from growing the row. `.context-ring` is a 12 × 12 `inline-flex`, `flex: none`, holding a 12 × 12
`svg` (`overflow: visible`); `.context-ring-track` is `--color-border` at `1.5`,
`.context-ring-fill` is `--color-ink-muted` at `2` with `stroke-linecap: butt`, and
`.context-warn` / `.context-error` swap the fill to `--status-warn` / `--status-error`. No
animation and no transition on either; the fill's colour is never `currentColor`.

Chips elsewhere take the compact chip box: padding 1px / `--space-2`, gap `--space-1`, 5px dot,
line-height 1.2 (font stays `--fs-micro` mono, uppercase); an icon inside a `.chip-count` is
12px. Group
label `--font-mono`, `--fs-mono`, `--color-ink-muted`, padding `--space-3` `--space-4`
`--space-2`; a collapsed folder's label takes `--space-3` at the bottom too, so its padding is
even, and the folder after a collapsed one drops the `--space-4` top margin that otherwise
separates an open folder's last row from the next divider. Row link padding `--space-2` `--space-4`
`--space-2` 0 (the rail replaces its left padding), `min-height: --row-height`. Head
`min-height: 56px`, border `--color-border`. Brand is
`--fw-display`, letter-spacing −.03em, and `--fs-heading-s`. The mark takes `--color-accent`; the
word never does.

## §app.session-list/accessibility — Accessibility

- **Landmarks.** `aside[aria-label="Sessions"]` > `nav[aria-label="Session list"]`. Each folder is
  a `<details>` labelled (`aria-labelledby`) by the heading in its `<summary>`: an `h3`, or an `h4`
  inside a user group. Rows are plain links in a `ul`, so the browser provides
  Tab/Enter behavior with no roving tabindex. Collapsed, the `aside` keeps its name and holds
  `nav[aria-label="Recent sessions"]` instead; every spine item is a real tab stop in reading
  order, with an `aria-label` and a `title` — the skill's rule, "an unlabeled icon is a guess",
  applied to every one. The spine's toggle carries `aria-expanded`, and Ctrl/⌘+B does the same
  as pressing it.
- **Selected row.** Mark the link with `aria-current="page"` and the shell with
  `.session-row-shell-current`.
- **Busy in the rail and the spine's tile dots are the two sanctioned wordless statuses in the
  system.** Everywhere else, status is a dot **and** the word. Busy in a session row is the first
  exception, and it is a deliberate one: at 320px its word costs more title than it buys. The
  folder head's Busy dot is the same mark carried up to a collapsed folder, not a third status;
  it has its `title` ("An agent is working in this folder") and its hidden clause (", an agent is
  working here"). The TUI state is not an exception: it ships its word, `TUI`, in a chip narrower
  than the rail's slot. What carries the rail's state:
  1. **Tone** — accent for TUI, on a `--color-surface` plate so the word holds its contrast on a
     tinted row; info for Busy's bare dot.
  2. **Form and word** — a 20.2 × 16 plate reading `TUI` against a bare 7px dot. This separates
     the two without hue and without motion, so they stay apart for a reader who can't separate
     the hues, under `prefers-reduced-motion`.
  3. **Static vs pulsing** — the channel reduced motion removes.
  4. **`title`** on each rail button — "Open in a TUI · pid {pid} · {status}", "pi is replying in
     this session", "{n} subagents working now".
  5. **`aria-label`** on each rail button, so the state has a real accessible name and isn't a
     nameless button. On the TUI chip it also keeps the visible `TUI` from being read twice: an
     `aria-label` replaces the element's text content in its accessible name rather than adding
     to it, so the button's name is exactly "Open in a TUI. Pid {pid}, status {status}."
  6. **The row link's own name repeats the state** in a `.visually-hidden` span (", open in a
     TUI", ", pi is replying in this session", ", {n} subagents working now"). A screen-reader
     user hears the state while arrowing the list, without ever reaching the rail buttons.
- **The spine's dot is the second, and it is argued, not inherited.** A 44px tile holding a
  two-letter monogram has no room for a word — the rail's 9px `TUI` chip would cover the monogram
  it marks — and the spine exists to be narrow. What carries the state instead:
  1. **Shape and motion, not hue alone.** TUI is a filled static dot, Busy a filled pulsing dot,
     working a hollow pulsing ring: motion separates TUI from the other two, and fill separates
     Busy from working. The rail says `TUI` in words where the tile can only mark it.
  2. **The tile's `aria-label` is the row link's accessible name**, state suffix and all, so a
     screen-reader user hears exactly what they hear on the row.
  3. **The `title`** names the session and folder; the state words are one gesture away in the
     session itself, which is where the tile goes — unlike the rail's buttons, the tile IS the link,
     so a tap opens the session rather than raising a toast.
  4. **It is opt-in.** The spine is a state the user chose, and the rail, with its tallies and
     words, is one Ctrl/⌘+B away.

  **The cost, plainly:** a sighted user sees a dot and no word, and under
  `prefers-reduced-motion` the pulse stops on its end state, so TUI and Busy — both filled — differ
  by hue alone (working keeps its ring). The rail doesn't share that limit: its TUI is a word. A TUI session that is also
  running subagents shows only its TUI dot; the tile's name still carries both.
- **Rail buttons are `tabindex="-1"` on purpose.** They are affordances, not destinations: two
  extra tab stops per row would add hundreds to a 278-row list, and the same facts are already in
  the row link's name. They stay real buttons so pointer users get a `title` and AT can address
  them directly.
- **Touch.** There is no hover on touch, so tapping a rail button raises its sentence as a toast
  — the same text as its `title`. The button sits outside the row link, so the tap doesn't open
  the session. Each rail button is under the 44px target minimum (Busy's box is 26 × 22.47, the
  TUI chip 20.2 × 16, the count about 20 × 16): it is an optional affordance for
  a fact the row already carries in its name, not a control, and the 44px target is the row
  itself.
- **The topic chip and the context ring are inert, and AT gets nothing from them.** Both carry a
  `title` and nothing else: no tab stop, no `role`, no `visually-hidden` sentence in the row
  link's name. That is a decision, not an oversight — the link's accessible name is read on every
  arrow-down through 279 rows, and it already ends with the rail's state suffix; two more clauses
  ("7 topics in this session, context 237,412 of 1,048,576 tokens (24%)") would roughly double it
  and bury the title the user is actually listening for. **The cost, plainly: a screen-reader user
  gets no context fill and no topic count from the list at all.** They have to open the session,
  where the head's gauge states both the sentence and, through `#context-desc`, the number
  (§chat/context-window) — and the outline strip (§app/insights) names the topics. A sighted pointer user gets the same
  sentence on hover; a touch user gets it on long-press, the platform's own `title` gesture. The
  rail's own precedent applies here too: this is the sidebar, and nowhere else. The row's remote
  mark follows the same precedent with one exception, stated under "Remote sessions": its fact
  rides the row link's accessible name as a short clause, so a screen-reader user hears which
  rows are remote — the one fact the list is scanned for once a group mixes them.
- **The cost, stated.** On a Busy row a sighted touch user still sees a coloured dot and no word
  until they tap it or open the session (§chat/transcript's `.run-status` and the head say which it is); a TUI
  row says `TUI`. The toast is a second
  gesture and it isn't discoverable — nothing on the row says the dot can be tapped. We accept
  that for the sessions pane — its rows and, collapsed, its tiles — and nowhere else. The
  spine's dot was argued against this bullet above, not waved through it; a third wordless status
  has two precedents to argue against, and neither is a licence.
- **Contrast.** Ink on surface is 12.34 (dark) and 17.86 (light). Muted on surface is 4.96 and
  5.74. Muted on tint is 5.06 and 4.68. Accent on surface is 4.67 and 6.81. Accent on tint is
  4.76 and 5.55. All clear AA 4.5.
- **Folded width.** Opening a row sets `data-view="session"`. Move focus to the session head
  title (`tabindex="-1"`) so screen readers announce the new context.

---


## §app.session-list/listing-reuse — One listing, shared for a second

The server builds the session list once for every caller that asks while a build is running, and
hands a finished list to further callers for up to **1 second** after its build started: the
session feed's comparison, the attention scan, the Overseer, the profile, schedule and share routes
and `GET /api/sessions` all read the same list then. A change made outside this server (a TUI writing
a session, another server's stores) therefore reaches a listing up to 1 second later.

A change a caller makes through this server is never missed that way. Any request other than a
read (a REST call that is not `GET` or `HEAD`, a peer's included, before it runs and again when it
answers), any message a chat socket sends, every write this server makes to a session file, a
hosted chat's turn starting or settling and each of its tool calls ending (the Overseer's tools
write in process), and every write to the stores a row reads (archived, titles, seen and the open
panes, drafts, groups, tags, attention signals, Sova's own sessions, the Decisions settings, the
organizations registry, the Overseer's and project overseers' state, kept preview links) start the
next listing afresh: no caller joins or reuses a list built before them. So a caller that archives,
renames, creates a session or gives one a One at a time profile sees that change in the very next
listing it asks for, and so does the One at a time check that follows it.
