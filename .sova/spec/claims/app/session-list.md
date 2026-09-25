# §app/session-list — Session list (sidebar)
> Part of the Sova design spec · [overview](../design/overview.md)

## §app.session-list/anatomy — Anatomy

```html
<aside class="app-sidebar" aria-label="Sessions">
  <div class="sidebar-head">
    <a class="brand" href="#/"><svg class="icon" aria-hidden="true">…sova-mark…</svg>sova</a>
    <span class="sidebar-spacer"></span>
    <button class="button" type="button"><svg class="icon" aria-hidden="true">…plus…</svg>New Session</button>
    <!-- unfolded (≥768) only: collapses the pane into the spine (§app.session-list/spine) -->
    <button class="button button-icon sidebar-spine-toggle" type="button" aria-expanded="true"
            aria-label="Collapse sessions pane" title="Collapse sessions pane · Ctrl/⌘+B">
      <svg class="icon" aria-hidden="true">…panel-collapse…</svg></button>
  </div>

  <div class="sidebar-search" role="search">
    <label class="visually-hidden" for="session-search">Search sessions</label>
    <div class="search">
      <svg class="icon" aria-hidden="true">…search…</svg>
      <input class="input" id="session-search" type="search" placeholder="Title, folder, or tag"
             aria-describedby="session-count" autocomplete="off" spellcheck="false">
      <!-- only when the query is non-empty -->
      <button class="button button-icon" type="button" aria-label="Clear Search">…close…</button>
    </div>
    <div class="spread">
      <p class="search-count" id="session-count" aria-live="polite">12 of 48 sessions</p>
      <span class="chip chip-accent chip-count" title="Sessions open in a TUI">
        <i class="chip-dot"></i>2 TUI</span>           <!-- only when ≥1 live; static, no pulse -->
    </div>
  </div>

  <nav class="sidebar-list pane" aria-label="Session list">
    <!-- First region: Recent (§app.session-list/recent). Second: the user's own groups (§app.session-list/groups).
         Both omitted here for length. -->
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
             it (below: the unread dot, then the needs-you mark). Lines 2 and 3 each carry
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
            <!-- only when n > 0; .session-rail-count-live pulses the icon, never the figure -->
            <button type="button" tabindex="-1"
                    class="session-rail-item session-rail-count session-rail-count-live"
                    aria-label="3 subagents working now" title="3 subagents working now">
              <span class="text-num">3</span><span class="icon icon-sm"
                    style="--icon:url(/icons/worker.svg)"></span>
            </button>
          </div>
          <a class="list-row list-row-interactive session-row" href="#/s/…" aria-current="page">
            <div class="list-main">
              <!-- line 1 may lead with inline marks, each aria-hidden with its words in a hidden span:
                   the unread dot (§app.overseer/seen), then at most ONE needs-you mark
                   (§app.decisions/attention-signals), the most urgent kind first:
                     task-failed  alert-circle, --status-error   "Task failed. "     (a subagent's: "A subagent failed. ")
                     asks-you     chat,         --color-accent   "Asks you. "
                     looping      refresh,      --status-warn    "May be looping. "  (a subagent's: "A subagent may be stuck. ")
                   The kind comes from the server (the session's `signals.kinds`, and its subagents'
                   `workerSignals` counts); kind precedence first, then the session's own signal over
                   its subagents'. The glyph sits in a span whose `title` says the fact in one sentence
                   ("The last reply asks you something.", "The last turn looks like it failed.", "The
                   last turn looks like it went in circles.", "A subagent finished without doing the
                   task.", "A subagent looks stuck.").
                   Kinds differ in glyph as well as tone. The session's own mark is gone once the session
                   is seen after it was classified, and no mark shows while this tab runs a turn there.
                   Both marks are hidden on the open session,
                   so this row (the open one) has neither; on another row line 1 reads:
                   <p class="list-title"><span class="session-unread" aria-hidden="true"></span><span
                     class="visually-hidden">New activity. </span><span class="session-signal-wrap"
                     title="The last reply asks you something."><span class="icon icon-sm session-signal
                     session-signal-asks" style="--icon:url(/icons/chat.svg)" aria-hidden="true"></span></span><span
                     class="visually-hidden">Asks you. </span>{title}</p>
                   The subagent marks come only from `workerSignals`, which the server sends only while
                   they apply. -->
              <p class="list-title">Add a watch endpoint for TUI sessions</p>
              <!-- line 2: the "now" line, then the outline's topic count -->
              <div class="list-line list-summary-row">
                <p class="list-summary" title="…">Wiring /ws/watch to the session tailer</p>
                <span class="chip chip-count session-topics" title="7 topics in this session">
                  <span class="text-num">7</span></span>
              </div>
              <!-- line 3: time, the tag's status word when there is one (§app.decisions/session-tags:
                   done, in progress, abandoned, blocked — lowercase, the meta's own muted voice, no
                   tone), and model, then the context ring. A tagged row's `.list-meta` has the `title`
                   "Topic: bug fix · status: in progress (tagged automatically)" ("Status: done (tagged
                   automatically)" without a topic); the topic shows nowhere else on the row. A remote row opens the line with its
                   own mark (§app/session-list "Remote sessions"): one 6px muted dot before the time. Local rows
                   open with the time, as here. -->
              <div class="list-line list-meta-row">
                <p class="list-meta">2h ago · <span class="session-status-word">in progress</span> · <span class="text-mono" title="anthropic/claude-opus-5">claude-opus-5</span></p>
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
      <!-- the Overseer entry button (§app.overseer/entry-button), with its badges -->
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
    <!-- omitted when both regions are empty -->
    <div class="spine-regions">
      <button class="button button-icon spine-item spine-region" type="button"
              aria-label="Live &amp; web · 12 sessions" title="Live &amp; web · 12 sessions">…chat…<span class="spine-count">12</span></button>
      <button class="button button-icon spine-item spine-region" type="button"
              aria-label="Archive · 40 sessions" title="Archive · 40 sessions">…archive…<span class="spine-count">40</span></button>
    </div>
    <!-- omitted when both tallies are 0 -->
    <div class="spine-stats">
      <button class="button button-icon spine-item spine-stat" type="button"
              aria-label="3 subagents working now" title="3 subagents working now">…worker…<span class="spine-count">3</span></button>
      <button class="button button-icon spine-item spine-stat" type="button"
              aria-label="2 sessions open in a TUI" title="2 sessions open in a TUI">…terminal…<span class="spine-count">2</span></button>
    </div>
    <div class="spine-foot">
      <a class="button button-icon spine-item" href="#/usage"
         aria-label="{the usage glance sentence, else Usage}" title="{the same}">…gauge…</a>
      <a class="button button-icon spine-item" href="#/agents"
         aria-label="{the agents sentence, else Agents}" title="{the same}">…worker…</a>
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
  on `<html>`, and `.app` carries `data-spine="on"` (absent when expanded). The grid, the Subagents
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
- **Region counts.** Live & web and the Archive, each an icon over its count and named
  "{Region} · {n} sessions" in its `title` and `aria-label`. **A button is shown exactly when its
  region is on screen in the expanded pane**, and `n` is the count that region shows now: with no
  search, the plain totals ("60 sessions", "321 sessions"); with a search on, each region's hit
  count — "22 sessions" while the Live & web head reads "22 of 60", "5 sessions" while the
  Archive's reads "5 of 321". One rule decides both the region and its button (`showTop` /
  `showArchive` in `Sidebar.tsx`); a button derived from anything else, such as the Archive's
  total, is a door onto a region a no-hit search has removed. When neither region is on screen
  the whole `.spine-regions` box is omitted, not only its buttons — an empty box still draws its
  divider. Pressing a button expands the pane, scrolls that region into view, and moves focus to
  its first row: Live & web's first folder head or link, the Archive's own `<summary>`. The
  Archive's open state is **left to the user** — it is their stored choice, and the button never
  forces it open. If the region is gone by the time the pane has expanded, focus goes to the
  head's collapse toggle.
- **Live tallies.** "{n} subagents working now" — `activeAgentCounts(…).agents`: subagents
  working right now in fresh host sessions, idle and waiting workers counting 0, the same figure
  the expanded foot's Agents row shows — and
  "{n} sessions open in a TUI" (the same count as the `N TUI` chip under the search), each only at
  n ≥ 1, with `.spine-stats` omitted when both are 0. They are **facts, not doorways**: nothing
  opens. Pointer users get the sentence as the `title`; a tap raises the same sentence as a toast,
  the rail's precedent (§app.session-list/accessibility — there is no hover on touch).
- **The foot** — Usage (`#/usage`), Agents (`#/agents`) and Settings, the expanded foot's three
  doorways. The glance sentences are not dropped at 64px, only unprinted: Usage's `title` and
  `aria-label` are the usage glance in full words (`glanceText()`), and Agents' are the agents
  sentence (`agentsSentence()`, e.g. "3 active agents in 2 sessions, 1 team"). Each falls back to
  "Usage" / "Agents" only when its sentence is empty — no usage cache to read, no live agents.
  What has no room is the printed text, not the fact.
  A doorway to the page on screen carries `aria-current="page"` and the tint.
- **Layout.** Five groups top to bottom — head, tiles, regions, tallies, foot — each a column
  of 44px items centred with `--space-1` between and `--space-2` above and below, split by
  `--color-border` rules. The tiles are the scroll region (`.pane`) and take the height that's
  left; the other four are pinned. They cost 529px with every item shown, so the tiles keep a
  floor of one tile (60px), and on a window shorter than that the whole spine scrolls instead.
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
  `Untitled` renders in `--color-ink-muted`.
- **Draft rows.** An empty husk — a session whose file holds no user message anywhere — is never
  listed, with one exception: **a husk with a stored draft is** (§chat.composer/behavior, Drafts). The server sends it
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
  to `outlineNow`, the rolling "now" line, so those rows keep the line they had. Rendered only when
  present: `--fs-micro` in `--color-ink-2`, one line truncated with an ellipsis. `title=` carries
  the full line, and the "now" line under a `Now: ` label when it says something else — the latest
  activity is one hover away, never in the row. Sessions without any outline (older sessions, or
  topic-outline off) omit the line entirely — the row is then title over meta, as before.

  The line also carries the session's **topic count**, at its right end: a
  `.chip.chip-count.session-topics` holding a bare figure, `title` "{n} topics in this session",
  shown only when the count is ≥ 1. It comes from the **same outline snapshot** as the line it sits
  beside (`readTailOutline` returns gist, "now" and count from the accepted entry), so the sentence
  and the figure can never disagree. No count, no chip — and no chip without a summary line either,
  since the line is what it rides on.
- **Row line 3.** Relative `lastActiveAt` ("just now", "4m ago", "2h ago", "yesterday", "Mar 4"),
  then ` · `, then the model in mono. Show only the part after the first `/` and put the full
  `provider/model` in `title`. If `model` is null, omit the separator and the model. The line is
  `--fs-micro`, the model's mono included: two facts, never a sentence, under a title and a summary
  that carry the row (Tokens below). A remote row
  opens the line with its remote mark ("Remote sessions" above); the time follows the line's own
  gap.

  The line ends with the **context ring** (§chat/context-window): a 12px ring whose arc is the share of the window
  the last reply left filled, `.context-warn` at ≥80% and `.context-error` at ≥95% — the same
  `contextStep` the head's gauge uses, so a row and the session it opens step together. Its
  `title` is the head's exact sentence. It and the subagents pane's worker ring are the only
  places in the product where the context fill is a shape instead of a number, and
  §chat.context-window/sidebar-ring writes that exception down.
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
  chip the row happens to carry. The shell owns the divider, the hover
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
  `TUI` — the same word as the session head's `TUI` chip and the sidebar's `{n} TUI` count — and
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
  It doesn't count toward the "N TUI" chip either.
- **Live count.** `N TUI` as `.chip.chip-accent.chip-count`, shown only when N ≥ 1. It sits at
  the right end of the count row under search (`.spread`), not in the head: at 320px the head
  holds exactly brand and New Session. It always counts all live sessions, not just the
  filtered ones. **It does not pulse** — `.chip-live` came off it with the rail change. A count is
  a tally, not work in flight, and it was the one pulse on the screen that never stopped. The
  accent dot and the word `TUI` carry it.
- **Selection.** The row link for the open session gets `aria-current="page"`, and its shell gets
  `.session-row-shell-current`, which is what the stylesheet tints with `--color-accent-tint` —
  the tint has to cover the rail too, or the open row would read as two pieces. The tint is never
  the only signal, because the head of the main pane repeats the title.
- **Refreshing** (polling or a WS nudge). Update rows in place and never re-show the skeleton.
  Keep scroll position and focus. If the focused row moves, it stays focused.

## §app.session-list/recent — Recent

The top of the list, above Groups: the few sessions that moved last, said once more so the one you
want back is the first thing on screen. With 48 sessions across 11 folders, the session you closed
five minutes ago is three collapsed sections down — and it is the single most likely thing you came
for.

Recent is a **shortcut, not a place a session lives.** Every row in it is still in Live & web or
the Archive underneath, exactly as a grouped session keeps its row in its region (§app.session-list/groups):
nothing is moved, nothing is hidden, and closing the gap between two copies of one row is not
something the user has to think about. It follows from that that Recent has **no actions of its
own** — no drag target, no remove, no count control. Every gesture a row has, it has where it
lives.

```html
<!-- First in .sidebar-list, above the Groups region. -->
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
- **Who is eligible.** Not archived (`archived !== true`) — and deliberately **not** the pane rule
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

Groups are the user's **own** sections, above every other region: named folders they make and file
sessions into by dragging a row onto one. They live server-side in
`~/.pi/agent/sova/session-groups.json` (`server/session-groups.ts`), keyed by session id like the
archive, so every tab and every Sova server sees the same groups and clearing browser storage
loses nothing. `GET /api/session-groups` lists them; the other routes are in `shared/protocol.ts`.

**A group is additive.** It never moves a session out of its region or out of its own place in the
list: a grouped session still shows under Live & web (or in the Archive), so the same row can
appear in a group and below it at once. A session belongs to **at most one** group.

### Anatomy

```html
<details class="sidebar-region sidebar-groups" aria-labelledby="r-groups">
  <!-- The head is the twist: the <summary> toggles, the <h2> inside it is what the outline and
       `aria-labelledby` read (the folder-head pattern, not the Archive's bare <summary>). -->
  <summary class="sidebar-groups-summary">
    <h2 class="sidebar-region-head" id="r-groups">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      Groups <span class="sidebar-region-count">· 2</span>
      <!-- The region's one action, at the head's right end: there with the region shut, and
           hidden while searching. Click and keydown stop here, as a group's `⋯` does, or they
           would toggle the region. Fanout is NOT here — it creates sessions rather than curating
           them, and its front door is the welcome screen beside New Session (§workspace.fanout/entry-points). -->
      <button type="button" class="button button-icon button-ghost group-new-toggle"
              aria-label="New group" title="New group">
        <svg class="icon icon-sm" aria-hidden="true">…plus…</svg>
      </button>
    </h2>
  </summary>

  <!-- While a new group's name is being typed: the field opens where the region's rows start,
       hidden while searching. -->
  <div class="group-field-row">
    <form class="group-field" aria-label="New group name">
      <input class="input" type="text" maxlength="60" placeholder="Group name" aria-label="New group name">
      <button type="submit" class="button button-sm">Save</button>
    </form>
  </div>

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

  <!-- A group with no sessions: the note, and still a drop target. -->
  <p class="sidebar-region-note">No sessions yet. Drag one here.</p>

  <!-- Only while a grouped row is in flight. -->
  <div class="group-remove"><svg class="icon icon-sm" aria-hidden="true">…close…</svg> Remove from “Work”</div>
</details>
```

- **Placement.** Above Live & web, below the search field. The region is always rendered — with no
groups it holds its head, with the `+` that makes a group, and the note "No groups yet. Make one,
then drag a session into it." — because that `+` is the feature's front door, the way the top
region keeps its head when it is empty.
- **Order.** Groups keep their creation order, so a rename or a new group never shuffles the list.
Within a group, rows and folder groups follow the usual rule (newest `lastActiveAt` first), and
the folder labels are `h4`, one level under the group's own label.
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
(a matching group must not hide its hits), while a grouped row is being dragged (the group
sections and the "Remove from …" target it needs are inside the region), and while the new-group
name field is showing (it opens in the region's body, and a shut region would hide the field the
user just asked for). When the field closes the choice answers again, so a region the user never
opened is shut again.
- **A group inside it is a `<details>` too**, like an Archive date section, and collapsed by
default on the same terms: memory only, no storage key, reopened by hand each page.
- **Empty.** An empty group stays visible with `0` and "No sessions yet. Drag one here.": it is
what a group is when the user makes it, and a drop target is what fills it. While a search is on,
a group with no matching session is left out entirely. A **fanout** group never reaches this
state: it dissolves itself on the write that empties it (§workspace/groups "Emptying a group").
- **Creating.** The region's one action is a `+` at the right end of its head
(`.button-icon.button-ghost`, `aria-label` and `title` "New group"), not a row: a row read as one
of the things it makes and sat inside the list it adds to. On the head it is there with the region
shut, and at the end the name and count keep their place. It is quiet like a group's `⋯` — the
count's muted ink, coming up to full ink when the head is hovered or the `+` has focus — with the
standard 44px target, hung into the head's right padding so its glyph lines up with the `⋯` of the
groups below. It stops its own click and keydown, as the `⋯` does, so a press on it is not also a
press on the summary; and it is hidden while searching, with the field it opens. Pressing it opens
the name field (focused) where the region's rows start, forcing the region open if it was shut.
The field saves on Enter, saves what is there when it loses focus, and cancels on Escape or when
empty. However it closes, focus goes back to the `+`, because the field is gone and the caret
would otherwise drop to `<body>` — unless the blur that closed it already moved focus somewhere
focusable, checked a frame later. `POST /api/session-groups`, then the group appears empty at the
end of the region — collapsed like every other, with its `0` showing; the region it lands in is
open, because the user is standing in it.
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
Dropping a dragged row on the summary still files it into the group, and still doesn't open the
section.
- **Opening it as a workspace.** `Open workspace` is the menu's first row, a link to `#/g/{id}` —
the group's members side by side, each a whole chat, with one composer that writes to all of them
(§workspace/groups). An empty group can't be opened as one: the row is `aria-disabled` with its reason under the
label ("Nothing is in it yet. Drag a session here first."), said before the press rather than
discovered as a blank workspace. The
section is still the place you file sessions into; the workspace is the place you read them in.
While that workspace is open, the group's `<summary>` takes `aria-current="true"` and its name
takes the selected row's tint, so the sidebar says which group you are inside.
- **Fanning out is not entered from here.** The Groups region's one action is making an empty
group to curate; a fanout — which makes the group AND its members in one gesture — is a
creation action and lives beside `New Session` on the welcome screen (§workspace.fanout/entry-points).
A group made that way is an ordinary group here all the same: it holds ordinary sessions, and
the only difference is that it dissolves itself when its last member leaves (§workspace/groups "Emptying a
group"), because its name and its fork point mean nothing without them.
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
- **Dragging.** A session row is a drag source (the link inside is not — a browser drags links
natively, and that drag carries a URL). Dropping it on a group's label or body files it there;
dropping it on another group moves it; a drop on the group it is already in does nothing. While a
**grouped** row is in flight, one dashed `Remove from “Work”` row appears at the end of the region
to drop it out. The source row dims for the length of the drag. A drop says what happened through
`.toast` and the polite region: "Added to “Work”." · "Moved to “Home”." · "Removed from “Home”."
- **Without a pointer**, and on touch, drag is not available: the session pane's `Move into group`
control (§chat/transcript, the Session tab and the info modal) is the same change, as a popover radio list
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
head's `+` is a named button (`aria-label` "New group") inside its `<summary>`, and it keeps the
region's gestures the same way: it stops click and keydown, so Enter or Space on it opens the name
field and does not also toggle the region. When the field closes it hands focus back to the `+`. The
`Remove from …` row is a drop target only, not a control: the popover path is what a keyboard
uses. Contrast is the region head's (ink-2 on sunken, 7.65 dark / 7.22 light); the drop state adds
the accent tint and a dashed accent edge, never a pulse.

## §app.session-list/selecting-several-sessions — Selecting several sessions

One session at a time is the sidebar's whole grammar: one row, one click, one transcript. Three
gestures are not about one session though — renaming, filing into a group, archiving — and doing
them to eight sessions one row at a time is eight round trips through a pane the user did not want
to open. So the list itself can be picked from.

**The way in is a press held on a row**, ~500ms, mouse or thumb alike: that row is selected and
the sidebar enters **selection mode**. Press-and-hold is the accelerator; the **Select** button
beside the session count is the door, for a keyboard and for anyone who has never held a row in
their life. There is never only one way in.

**What a press is, and what it stops being.** A press becomes a hold only if it stays within 10px
of where it started and nothing interrupts it. Moving further is a drag (rows still drag into
groups, exactly as before) or a scroll; a `pointercancel` — what touch sends the moment the list
starts moving under a still finger — ends it too, and so does a wheel scroll under a held mouse.
A native drag can begin before the 10px tolerance is reached (the browser's own threshold is
smaller), so a `dragstart` ends the press too, as do the pointer leaving the row, capture being
lost, and the window losing focus — every path where the `pointerup` may never arrive.

A hold that DID fire swallows what it leaves behind: the `click` the pointerup produces and, on
touch, the `contextmenu` that arrives before it. Neither may reach the row's link, or the session
would open on top of the selection that was just made. **That suppression lasts for the whole
press and for a second after it is RELEASED** — never a second after the hold fired. A press may be
held for as long as the user likes, and a window measured from the hold would have run out under a
3-second press, letting the click through to toggle the row straight back off. The rules live in
`src/lib/hold-select.ts`.

**In selection mode**, a click on a row toggles it instead of opening it, each row's rail carries a
44px checkbox, and the rail — 30px of gutter everywhere else — widens to 44px to hold it. Outside
selection mode nothing changes: a click is a click. **The selection is keyed by session path**, so
the same session shown in Recent, in a group and in Live & web is ONE selection with three checked
boxes, and it is module state (`src/lib/session-selection.ts`), like the open groups and the drag —
the list refreshes every few seconds and rebuilds every row, and a selection that a poll could
clear would be unusable. A poll may do exactly one thing to it: drop a session that is no longer in
the list.

**The toolbar sits inside the sidebar, above the list**, never floating over the rows it acts on:
the count, `Cancel`, and the actions.

- **Rename** appears at **exactly one** selected session and is gone at two — one field cannot
  mean two titles. It opens an inline field: Enter saves, Escape cancels, and an **empty field
  clears** the user's title so the derived one (the session's first message) comes back. Changing
  the selection closes the field rather than leaving a stale one over another row's title.
- **Move to group** files every selected session at once, with `No group` first and `New group…`
  last — the one-session menu's own rows (§app.session-list/groups), in a menu that says how many it will move.
- **Archive** points one way for the whole selection. All archived → `Unarchive`. None archived →
  `Archive`. **A mix is a disabled control** that says what it found ("2 of these 3 are archived
  and the rest aren't. Select one kind, or the other."): guessing which half was meant is how a
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

**Accessibility.** `Escape` leaves selection mode from anywhere outside a text field (inside one it
belongs to the field: search clears, the rename field cancels). "Text field" means a caret, not
merely an `<input>`: a row's checkbox is an input too, and Escape pressed on one — the likeliest
place for a keyboard to be in this mode — leaves the mode like Escape anywhere else
(`isTextEntry`). Every checkbox is a real
`<input type="checkbox">` inside its label, named "Select {title}". The toolbar is a `role="group"`
labelled "Selected sessions", its count is a polite live region, and every disabled control carries
the reason it is disabled before it is pressed, never after. Every target in the mode is 44px.

## §app.session-list/regions-top-and-archive — Regions: top and Archive

`SessionSummary.origin` and `archived` divide the sessions into two regions (`isTopSession` in
`src/lib/regions.ts`):

- **Top region:** sessions where `live !== null || (origin === "web" && !archived)`, meaning
  the ones running in a TUI right now, or started from Sova and not archived by the user.
- **Archive:** every other session. A server that sends no `archived` counts as not archived.
- **Neither:** an Overseer file (`SessionSummary.overseer`, §app.overseer/identity-and-clear) is in
  no region, like a worker's own session: not in either region, the Groups region, Recent, search,
  the spine or the cleanup count.

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

**Ordering.** The top region comes first and the Archive last. Inside each region, groups and
rows are ordered by the rules above. A session moves between regions in place on refresh, for
example when its TUI closes and `live` becomes null. If it's the selected row, it keeps
`aria-current`, and case 2 keeps the archive open.

**Archiving.** Sessions started from Sova (`origin === "web"`) can be archived by hand, so
the top region doesn't keep every one of them forever.

- **Where.** An Archive Session icon button (`archive.svg`) last in the session head (§chat/transcript), only
  on web sessions. Rows are links, so it can't live in them: a button inside `<a>` is invalid and
  splits the row's single target. It's the only archive control in the app, so it stays at every
  head width (§chat/transcript, §chat/context-window "Width budget").
- **What it does.** `POST /api/sessions/archive { path, archived }`, then a list refresh. The id
  goes into `~/.pi/agent/sova/archived-sessions.json`; the session file is never written.
  Toast: "Archived. Find it under Archive." The row moves to the Archive, and case 2 keeps it
  visible while it's open.
- **Undo.** On an archived session the same button is Unarchive Session. Toast: "Moved back to
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
  what it protects. The UI shows its numbers and never counts on its own.
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
row per archived, not-live session — newest first, titled with the session's own title, its meta
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
  `refused: [{ path, reason }]` (absent for age and husks), one entry per refused path.
- **Flow.** The same dry-run-then-confirm flow as the bulk actions, through the same dialog: for
  one path the scope line reads "One archived session: “{title}”." and the irreversibility line is
  singular — "This permanently deletes its transcript file — this can't be undone." Refusals show
  as muted captions (`“{title}”: {reason}`), and the toast appends their reasons; with 0 candidates
  and a refusal the body says "Nothing was deleted."
- **After.** The list refreshes like the bulk path, and the open session's deletion navigates to
  `#/` for the same reason (a transcript that can no longer load).

## §app.session-list/search — Search

- **Matching.** Case-insensitive substring match on `title`, `cwd`, `model`, and the session's
  tags (§app.decisions/session-tags: its topic and status, as stored and as displayed — `bugfix`
  and "bug fix", `in_progress` and "in progress" — and its manual tags), filtered on the client as
  the user types (no debounce needed for fewer than 2k rows). Without tags, a row matches as before.
- **Empty groups.** A group with no matching rows is hidden, and so is a region with none.
- **Both regions.** The query filters the top region and the Archive alike. While the query is
  non-empty, the Archive is forced open so matches are never hidden in a collapsed region.
  Clearing the query restores the stored open/closed choice. The count row
  (`{visible} of {total} sessions`) covers both regions, and each region head shows its own
  filtered count.
- **Count.** `.search-count` always shows `{visible} of {total} sessions`, and just
  `{total} sessions` when the query is empty. It lives beside the filter it answers to,
  following the filter-bar rule.
- **Overseer button.** The search row also holds the Overseer entry button (§app.overseer/entry-button).
  While the filter is focused or has a query, the button is removed (not just hidden) and the
  field takes the full row; blur with an empty query brings it back.
- **Keys.** `/` anywhere, while focus isn't in a text field, focuses search. `Esc` inside search
  clears the query first, then blurs on a second press. Clear Search returns focus to the input.

## §app.session-list/states — States

| State | What renders |
|---|---|
| Loading (first fetch, after 300ms) | 6 × `<div class="skeleton skeleton-row">` inside `.sidebar-list`, separated by `--space-2`. Put `aria-busy="true"` on the `nav`. Nothing appears before 300ms |
| Error | `.banner.banner-error` at `--space-3` inset, with `alert-circle`. Title: "Couldn't read your sessions." Body: "`~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry." `.banner-action`: `<button class="button button-sm">Retry</button>`. If rows loaded earlier, keep them visible below the banner |
| Empty (0 sessions on disk) | `.empty`. Title: "0 sessions in `~/.pi/agent/sessions`." Body: "Start one here, or run `pi` in a terminal. It'll show up in this list." One `.empty-action`: `New Session` (secondary) |
| No matches | `.empty`. Title: "0 of 48 match “{query}”." Body: "We search titles, folders, models, and tags." Action: `<button class="button">Clear Search</button>` |

## §app.session-list/tokens — Tokens

Sidebar ground `--color-surface`. Row hover and `:focus-within` `--color-sunken`, both on
`.session-row-shell`; open row `--color-accent-tint` on `.session-row-shell-current`.
Title `--color-ink`, `--fw-medium`, `--fs-body`. Summary `--fs-micro`, `--lh-micro`,
`--color-ink-2`. Meta (line 3) `--color-ink-muted`, `--fs-micro`, `--lh-micro`, scoped to
`.session-row .list-meta`; the model's `.text-mono` inherits that size rather than keeping its
own. `.list-meta` elsewhere stays caption.

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

