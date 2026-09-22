# 02 · Session list (sidebar)
> Part of the pi-web design spec · [overview](overview.md)

## Anatomy

```html
<aside class="app-sidebar" aria-label="Sessions">
  <div class="sidebar-head">
    <a class="brand" href="#/"><svg class="icon" aria-hidden="true">…pi-web-mark…</svg>pi-web</a>
    <span class="sidebar-spacer"></span>
    <button class="button button-icon button-ghost" type="button" aria-label="Refresh Sessions">…refresh…</button>
    <button class="button" type="button"><svg class="icon" aria-hidden="true">…plus…</svg>New Session</button>
  </div>

  <div class="sidebar-search" role="search">
    <label class="visually-hidden" for="session-search">Search sessions</label>
    <div class="search">
      <svg class="icon" aria-hidden="true">…search…</svg>
      <input class="input" id="session-search" type="search" placeholder="Title, folder, or model"
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
    <!-- First region: the user's own groups (§2 "Groups"), omitted here for length. -->
    <section class="session-group" aria-labelledby="g-1">
      <h2 class="list-group-label" id="g-1" title="/home/user/webapps/pi-web">
        <svg class="icon icon-sm" aria-hidden="true">…folder…</svg>
        <span class="session-group-path"><bdi>~/webapps/pi-web</bdi></span>
        <span class="text-num">4</span>
      </h2>
      <ul class="list">
        <!-- The rail is the row's state, on the LEFT, wordless. Every row has one, even
             an empty one, so every title starts on the same edge:

               [=] ~/webapps/pi-web                              4
             ( o )  Add a watch endpoint for TUI sessions
              3 ⚙   Wiring /ws/watch to the session tailer       (7)
                    2h ago · claude-opus-5                        ◔
            2├──30px──┤2├───────── 270 at a 320px sidebar ─────────┤

             Line 1 is the title and nothing else — the rail exists because
             chips beside the title cost it width. Lines 2 and 3 each carry
             ONE indicator on a shared right edge: the topic count on the
             "now" line, the context ring on the meta line.
        -->
        <li class="session-row-shell session-row-shell-current">
          <div class="session-rail">
            <!-- at most one state pill: TUI (accent, static) or Busy (info, pulsing) -->
            <button type="button" tabindex="-1"
                    class="session-rail-item session-rail-state chip chip-accent"
                    aria-label="Open in a TUI" title="Open in a TUI · pid 8124 · working">
              <span class="session-rail-dot"></span>
            </button>
            <!-- only when n > 0; .session-rail-count-live pulses the icon, never the figure -->
            <button type="button" tabindex="-1"
                    class="session-rail-item session-rail-count session-rail-count-live"
                    aria-label="3 subagents working" title="3 subagents working now">
              <span class="text-num">3</span><span class="icon icon-sm"
                    style="--icon:url(/icons/worker.svg)"></span>
            </button>
          </div>
          <a class="list-row list-row-interactive session-row" href="#/s/…" aria-current="page">
            <div class="list-main">
              <p class="list-title">Add a watch endpoint for TUI sessions</p>
              <!-- line 2: the "now" line, then the outline's topic count -->
              <div class="list-line list-summary-row">
                <p class="list-summary" title="…">Wiring /ws/watch to the session tailer</p>
                <span class="chip chip-count session-topics" title="7 topics in this session">
                  <span class="text-num">7</span></span>
              </div>
              <!-- line 3: time and model, then the context ring. A remote row opens the line with its
                   own mark (§2 "Remote sessions"): one 6px muted dot before the time, a second 4px
                   one when the session is mounted. Local rows open with the time, as here. -->
              <div class="list-line list-meta-row">
                <p class="list-meta">2h ago · <span class="text-mono" title="anthropic/claude-opus-5">claude-opus-5</span></p>
                <span class="context-ring {context-warn|context-error}" title="{the head's exact sentence}">
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <circle class="context-ring-track" cx="6" cy="6" r="5" fill="none"/>
                    <circle class="context-ring-fill" cx="6" cy="6" r="5" fill="none"
                            transform="rotate(-90 6 6)" style="stroke-dasharray:…;stroke-dashoffset:…"/>
                  </svg>
                </span>
              </div>
            </div>
            <span class="visually-hidden">, open in a TUI, 3 subagents working</span>
          </a>
        </li>
      </ul>
    </section>
  </nav>
</aside>
```

## Content rules

- **Grouping.** Group by `cwd`. Groups are ordered by their most recent `lastActiveAt`. Rows
  within a group are ordered by `lastActiveAt`, newest first. Each group label shows three
  things:
  - the path with `$HOME` shown as `~` (mono, and case is preserved),
  - the full path in `title`,
  - a count of the rows currently visible.

  Long paths truncate **from the left**, because the leaf folder is what people scan for. The
  `rtl` + `<bdi>` pair in `.session-group-path` handles this. Labels stick to the top while their
  group scrolls.
- **Remote sessions.** A session on a remote target (`SessionSummary.target`/`remoteCwd`, else a
  `cwd` under `~/.pi/agent/pi-web/targets/<target>/…`, which mirrors the remote folder) never shows
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
  with local ones beside them. A mounted session (`SessionSummary.mounted`) adds a second,
  smaller dot beside it, 4px and 3px away: one dot says "this runs on another host", two say
  "…and its files are the local mount". `mounted` is only ever what the summary says — never
  inferred from the target or from a cwd inside a mount point. `title` is
  `Remote: name (host):/remote/path.` for a remote row, and adds "Mounted: the session's files
  are the local mount, at <cwd>." for a mounted one. The mark never pulses and can't be taken for
  the live dot, for the same three reasons the connection dot can't: it lives in the meta line,
  not a row's rail, it is smaller, and it never pulses. It sits at the line's left edge, so the
  right-edge column — topic chip, context ring — is untouched. Like the topic chip and the ring
  it is inert (`title` and nothing else), with one difference: the row link's accessible name ends
  with a short hidden clause (", remote on {target}", plus ", mounted"), because which rows are
  remote is a fact a session is picked by, not a number watched one at a time.

  **Connection dot.** While a chat on that target is open in this tab, a 6px `.chip-dot` sits
  right after the target's label, before the `·`: success tone for `connected`, error tone for
  `unreachable`, the label's own muted ink for `last ok`, `checking…` and `no status` — the same
  reading as the head chip (spec/01 "Remote session chips"), from the freshest report among
  this tab's open chats on that target. It is `role="img"` with `aria-label="connection: <word>"`
  and a `title` starting `Connection: <word>` then the chip's hover text. It can't be taken for
  the live-session dot: it lives in the group label, not a row's rail, it is smaller, and it never
  pulses. With no chat open on the target there's no dot, since nothing is reporting. The
  always-on remote chip (spec/01 "Remote session chips") lives in the session head and Session
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
  listed, with one exception: **a husk with a stored draft is** (§4 Drafts). The server sends it
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
- **Row line 2.** `SessionSummary.outlineNow`, the session's rolling "now" line from its latest
  `topic-outline` snapshot. Rendered only when present: `--fs-micro` in `--color-ink-2`, one line
  truncated with an ellipsis, the full text in `title=`. Sessions without one (older sessions, or
  topic-outline off) omit the line entirely — the row is then title over meta, as before.

  The line also carries the session's **topic count**, at its right end: a
  `.chip.chip-count.session-topics` holding a bare figure, `title` "{n} topics in this session",
  shown only when the count is ≥ 1. It comes from the **same outline snapshot** as the "now" line
  it sits beside (`readTailOutline` returns both from the accepted entry), so the sentence and the
  figure can never disagree. No count, no chip — and no chip without a "now" line either, since
  the line is what it rides on.
- **Row line 3.** Relative `lastActiveAt` ("just now", "4m ago", "2h ago", "yesterday", "Mar 4"),
  then ` · `, then the model in mono. Show only the part after the first `/` and put the full
  `provider/model` in `title`. If `model` is null, omit the separator and the model. A remote row
  opens the line with its remote mark ("Remote sessions" above); the time follows the line's own
  gap.

  The line ends with the **context ring** (§4f): a 12px ring whose arc is the share of the window
  the last reply left filled, `.context-warn` at ≥80% and `.context-error` at ≥95% — the same
  `contextStep` the head's gauge uses, so a row and the session it opens step together. Its
  `title` is the head's exact sentence. It is the one place in the product where the context fill
  is a shape instead of a number, and §4f writes that exception down.
- **Lines 2 and 3 are `.list-line`.** Each is a flex wrapper: the text block flexes and truncates,
  the indicator is `flex: none`. That puts the chip and the ring on **one right edge** down the
  whole list, which is the entire point — a ring that slid left and right with the text beside it
  would be decoration, not a column you can scan. Line 1 gets no wrapper and no indicator, ever:
  the right-hand chips that used to squeeze the title are why the rail exists.
- **Row state lives in a left rail.** Every row is a `li.session-row-shell`: a 30px
  `.session-rail` column with a **2px horizontal margin** of its own, then the row link — a 34px
  gutter in all. The margin is where the breathing room lives: not padding inside the rail, and
  not a margin on the pill, so the rail's box (x=2…32) stays symmetrical and everything in it
  centres on one axis. The 26px pill therefore sits **4px** off the panel edge — the 2px margin
  plus 2px of centring slack — and the count centres under it on that same axis.
  The rail is deliberately **outboard** of the
  list's 16px text inset: it is a gutter the eye skips, not a column of content, and the titles
  start a bare 2px right of where the old rows' text did. The rail is reserved on **every** row, including the ones
  with nothing to say, so 278 titles start on one left edge instead of jittering with whatever
  chip the row happens to carry. The shell owns the divider, the hover
  (`--color-sunken`) and the open-row tint (`--color-accent-tint`, via
  `.session-row-shell-current`), so the rail is skin, not a dead zone. Rail items are
  `<button type="button" tabindex="-1">` — pointer and AT affordances, never tab stops
  (Accessibility below).
- **The rail is wordless.** It carries at most two things, stacked: a 26px state pill, then a
  worker count. This is the one place in the product where a status ships without its word, and
  the trade is written down under Accessibility.
- **TUI pill.** Shown when `live !== null`: `.session-rail-item.session-rail-state.chip.chip-accent`
  holding one `.session-rail-dot` — a 7px accent dot in a 26px round bordered pill.
  `aria-label` "Open in a TUI. Pid {pid}, status {status}.", `title`
  "Open in a TUI · pid {pid} · {status}".

  - **Static. No `.chip-live`**, here and in the session head's `TUI` chip alike (§0 Motion,
    §3). This inverts the precedent this file used to state — *"the pulse
    belongs to Live alone"*. A TUI holding the file open is **ownership**, not work in flight,
    and a row that pulses all day while nothing moves teaches people that the pulse means
    nothing. The pulse now means exactly "work in flight", which is Busy.
  - **Hue.** Accent, unchanged: the accent's meaning is still "a TUI has this".
- **Busy pill.** Shown when `busy === true`, meaning the server is mid-turn on a session pi-web
  holds: `.session-rail-item.session-rail-state.chip.chip-info.chip-live`, same 26px pill, info
  dot, **pulsing**. `aria-label` and `title` both "pi is replying in this session".

  - **The pulse is Busy's now.** `.chip-live` lands here, and only here, in a session row. It is
    real work in flight, and it ends when the turn does.
  - **Hue.** Info (`--status-info`, 5.94 dark / 6.36 light on the pill's surface), not the
    accent. Busy is our own run; the accent stays reserved for "a TUI has this".
  - **At most one pill.** TUI and Busy never co-occur — pi-web never holds a TUI-owned session —
    and if both ever arrive, **TUI wins** and Busy is hidden: the TUI owns the file, so our view
    of busy is stale.
  - **What tells the two apart.** Tone (accent vs info), and static vs pulsing. One dot glyph
    can't also carry a shape difference, so shape is not a third channel here; the honest list
    of carriers is tone, motion, `title`, `aria-label`, and the row link's hidden suffix.
- **Worker count.** `.session-rail-item.session-rail-count`, under the pill, only when
  `live?.workers?.working ≥ 1`: a tabular `--fs-micro` figure and an 11px `worker` icon in
  `--color-ink-muted`, 16px tall, no pill and no border — it is an aggregate, not a state, and it
  must not read as a second status. `aria-label` and `title` both "{n} subagents working now". `.session-rail-count-live` pulses **the icon only**, never the figure: a moving
  numeral can't be read. Still at most **one** moving thing per row, so the count pulses only on
  rows whose pill is static (TUI), and a Busy row's count sits still.
- **320px budget.** The rail costs a **34px** gutter (2px margin + 30px column + 2px margin) and
  gives back the whole right end of the row. The pill's left edge is **4px** in and its 26px box
  ends at x=30; the title block starts **34px** in on every row and runs
  **320 − 34 − 16 = 270px** — against the old worst case of about **150px**, when
  `2 working` (~64) + `TUI` (~48) + two 12px gaps sat to the right of the title. That is +120px,
  about **80% more title**, and it is the same 270px on every row: a stateless row no longer
  reads wider than a live one.

  The title column moved 2px right when the pill got its breathing room, and that is the trade as
  accepted: 2px of gutter buys a round button that isn't touching the panel edge, and 2px off a
  270px column is invisible where the pill's margin is not.

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
    dot and the line's `--space-2` gap (13px more with the mounted pair), so it runs ~236px at
    320 — still wider than the title column ever was before the rail. The mark is `flex: none`,
    the text still truncates first, and no row grows: the dot sits inside the meta line's own
    line box.
  - **No row grew.** A title + summary + meta row measures **77.14px** with the additions and
    **77.14px** without them, and `.list-main` is **60.14px** either way: the chip is pinned to
    the summary's own 14.3px line box and the 12px ring is shorter than the meta line's 19.38px.
    The rail's 54px floor is still the floor.

  Those are the nominal figures. A real pane also spends its 1px right border and a 10px
  scrollbar, so the title column in Chrome is about **259px** at a 1280 viewport and **250px** at
  a 320px viewport — the 261/252 measured before this change, less the 2px the gutter grew; they
  have not been re-measured. Both sides of the comparison are quoted without the scrollbar.

  **Row height.** The rail can set the row's height, because the shell is
  `align-items: flex-start` and the taller column wins. A row with **both** rail items stacks
  8 (top padding) + 26 (pill) + 4 (gap) + 16 (count) = **54px**. Measured at 320px, the link side
  of a title-plus-meta row is already **60px** (76px with a summary line), so the full rail fits
  inside the height the text already makes and **no row grows** — a both-items row and a bare row
  both measure 60px. The 54px figure is the floor the
  rail would impose if a row ever lost its meta line — still above `--row-height` 44, and still
  one 44px-plus target. That is the acceptable trade:
  the rail is bounded by a number smaller than the row it sits in, and the alternative —
  squeezing the pill or dropping the count — spends a readable state to save height we are not
  spending.
- **Other placements.** None for v1. The open session already shows its own run state (the
  `.run-status` line and the author's `.live-dot`, §3), so the session head doesn't repeat Busy.
  It doesn't count toward the "N TUI" chip either.
- **Live count.** `N TUI` as `.chip.chip-accent.chip-count`, shown only when N ≥ 1. It sits at
  the right end of the count row under search (`.spread`), not in the head: at 320px the head
  holds exactly brand, Refresh, and New Session. It always counts all live sessions, not just the
  filtered ones. **It does not pulse** — `.chip-live` came off it with the rail change. A count is
  a tally, not work in flight, and it was the one pulse on the screen that never stopped. The
  accent dot and the word `TUI` carry it.
- **Selection.** The row link for the open session gets `aria-current="page"`, and its shell gets
  `.session-row-shell-current`, which is what the stylesheet tints with `--color-accent-tint` —
  the tint has to cover the rail too, or the open row would read as two pieces. The tint is never
  the only signal, because the head of the main pane repeats the title.
- **Refreshing** (polling or a WS nudge). Update rows in place and never re-show the skeleton.
  Keep scroll position and focus. If the focused row moves, it stays focused.

## Groups

Groups are the user's **own** sections, above every other region: named folders they make and file
sessions into by dragging a row onto one. They live server-side in
`~/.pi/agent/pi-web/session-groups.json` (`server/session-groups.ts`), keyed by session id like the
archive, so every tab and every pi-web server sees the same groups and clearing browser storage
loses nothing. `GET /api/session-groups` lists them; the other routes are in `shared/protocol.ts`.

**A group is additive.** It never moves a session out of its region or out of its own place in the
list: a grouped session still shows under Live & web (or in the Archive), so the same row can
appear in a group and below it at once. A session belongs to **at most one** group.

### Anatomy

```html
<section class="sidebar-region sidebar-groups" aria-labelledby="r-groups">
  <h2 class="sidebar-region-head" id="r-groups">Groups <span class="sidebar-region-count">· 2</span></h2>

  <!-- The region's one action. It replaces nothing, so it never moves: hidden while searching.
       Fanout is NOT here — it creates sessions rather than curating them, and its front door is
       the welcome screen beside New Session (§14b "Entry points"). -->
  <button type="button" class="list-row list-row-interactive group-new">
    <svg class="icon icon-sm" aria-hidden="true">…plus…</svg>
    <span class="list-title">New group</span>
  </button>
  <!-- While it (or a Rename) is being typed: the field sits exactly where the row was. -->
  <div class="group-field-row">
    <form class="group-field" aria-label="New group name">
      <input class="input" type="text" maxlength="60" placeholder="Group name" aria-label="New group name">
      <button type="submit" class="button button-sm">Save</button>
    </form>
  </div>

  <!-- One group: a <details>, like an Archive date section. -->
  <details class="group-section" open>
    <summary class="list-group-label group-label" title="Work">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <svg class="icon icon-sm" aria-hidden="true">…folder…</svg>
      <span class="group-name"><bdi>Work</bdi></span>
      <span class="text-num">4</span>
    </summary>
    <section class="session-group" aria-labelledby="g-…">
      <h4 class="list-group-label" id="g-…">…folder, path, count…</h4>
      <ul class="list">…session rows, exactly as everywhere else…</ul>
    </section>
    <!-- The group's own controls, quiet and last, as the Archive's cleanup row is. -->
    <div class="group-tools">
      <a class="button button-sm button-ghost" href="#/g/…">Open workspace</a>
      <button class="button button-sm button-ghost" type="button">Rename</button>
      <button class="button button-sm button-ghost" type="button">Delete group</button>
    </div>
  </details>

  <!-- A group with no sessions: the note, and still a drop target. -->
  <p class="sidebar-region-note">No sessions yet. Drag one here.</p>

  <!-- Only while a grouped row is in flight. -->
  <div class="group-remove"><svg class="icon icon-sm" aria-hidden="true">…close…</svg> Remove from “Work”</div>
</section>
```

- **Placement.** Above Live & web, below the search field. The region is always rendered — with no
groups it holds the `New group` row and the note "No groups yet. Make one, then drag a session
into it." — because that row is the feature's front door, the way the top region keeps its head
when it is empty.
- **Order.** Groups keep their creation order, so a rename or a new group never shuffles the list.
Within a group, rows and folder groups follow the usual rule (newest `lastActiveAt` first), and
the folder labels are `h4`, one level under the group's own label.
- **Count.** The region head counts **groups**: each section's own count sits beside its name.
(Live & web and the Archive count sessions instead; those regions are lists of sessions, this one
is a list of groups.) While searching it reads `· {matching groups} of {all groups}`.
- **A group is a `<details>`**, like an Archive date section, but **open by default** — it is the
user's own curation, and a collapsed group would hide the sessions they just filed. The choice is
remembered in `sessionStorage["pi-web:group-open-{id}"]` for the browser session.
- **Empty.** An empty group stays visible with `0` and "No sessions yet. Drag one here.": it is
what a group is when the user makes it, and a drop target is what fills it. While a search is on,
a group with no matching session is left out entirely. A **fanout** group never reaches this
state: it dissolves itself on the write that empties it (§14 "Emptying a group").
- **Creating.** `New group` turns that row into the name field (focused), so the section never
moves. The field saves on Enter, saves what is there when it loses focus, and cancels on Escape or
when empty. `POST /api/session-groups`, then the group appears open and empty at the end.
- **Opening it as a workspace.** `Open workspace` is the first control in the tool row, and it
links to `#/g/{id}` — the group's members side by side, each a whole chat, with one composer that
writes to all of them (§14). It is in the tool row rather than on the label because the label is a
`<summary>`, and a link inside one fights the section's toggle exactly as a button does. The
section is still the place you file sessions into; the workspace is the place you read them in.
While that workspace is open, the group's `<summary>` takes `aria-current="true"` and its name
takes the selected row's tint, so the sidebar says which group you are inside.
- **Fanning out is not entered from here.** The Groups region's one action is making an empty
group to curate; a fanout — which makes the group AND its members in one gesture — is a
creation action and lives beside `New Session` on the welcome screen (§14b "Entry points").
A group made that way is an ordinary group here all the same: it holds ordinary sessions, and
the only difference is that it dissolves itself when its last member leaves (§14 "Emptying a
group"), because its name and its fork point mean nothing without them.
- **Renaming.** Rename in the group's tool row swaps that row for the same field, pre-filled. The
name is trimmed, 1–60 characters, and duplicates are allowed (nothing keys on a name).
`PATCH /api/session-groups/:id`.
- **Deleting.** Delete group asks in place, in the tool row — "Delete “Work”? Its 4 sessions stay
in the list." (empty: "Delete “Work”? Nothing is in it.") — with `Delete group` and `Cancel`. It
removes the group and its assignments and never touches a session file. `DELETE
/api/session-groups/:id`; toast: "Deleted “Work”. Its 4 sessions are ungrouped."
- **Dragging.** A session row is a drag source (the link inside is not — a browser drags links
natively, and that drag carries a URL). Dropping it on a group's label or body files it there;
dropping it on another group moves it; a drop on the group it is already in does nothing. While a
**grouped** row is in flight, one dashed `Remove from “Work”` row appears at the end of the region
to drop it out. The source row dims for the length of the drag. A drop says what happened through
`.toast` and the polite region: "Added to “Work”." · "Moved to “Home”." · "Removed from “Home”."
- **Without a pointer**, and on touch, drag is not available: the session pane's `Move into group`
control (§3, the Session tab and the info modal) is the same change, as a popover radio list
(`role="menuitemradio"`, one row per group plus `No group`) with `New group…` at the end, which
creates the group and moves the session in one step. The Identity list shows the current group.
- **Search.** Groups are filtered by the same query as everything else, over the whole list rather
than one region's slice, and the region disappears when no group matches.

**Accessibility.** The region is a `section` labelled by its `h2`. The group label is a
`<summary>` and deliberately **not** a heading: headings inside `<summary>` are exposed
inconsistently (the same rule the Archive's summary follows), so the folder labels inside a group
are `h4` and the outline reads region → folder with one level deliberately skipped rather than a
heading nobody can rely on. The label is a `<summary>`, so Enter or
Space opens and closes the section and AT announces expanded or collapsed; Rename and Delete live
in the tool row instead, because a button inside a `<summary>` fights the section's toggle. The
`Remove from …` row is a drop target only, not a control: the popover path is what a keyboard
uses. Contrast is the region head's (ink-2 on sunken, 7.65 dark / 7.22 light); the drop state adds
the accent tint and a dashed accent edge, never a pulse.

## Regions: top and Archive

`SessionSummary.origin` and `archived` divide the sessions into two regions (`isTopSession` in
`src/lib/regions.ts`):

- **Top region:** sessions where `live !== null || (origin === "web" && !archived)`, meaning
  the ones running in a TUI right now, or started from pi-web and not archived by the user.
- **Archive:** every other session. A server that sends no `archived` counts as not archived.

Both regions use exactly the same folder groups and rows described above. Each region groups by
`cwd` independently, so one folder can appear in both. The Groups region above them is a third
region that cuts across these two: a session in a group keeps its row here as well, so a folder —
and a session — can appear in all three at once.

```html
<nav class="sidebar-list pane" aria-label="Session list">
  <!-- Top region. With 0 rows and no query, keep the head ("Live & web · 0") and replace the
       groups with <p class="sidebar-region-note">0 sessions open in a TUI, or started here and not archived. The archive below has the rest.</p>.
       With 0 rows while searching, omit the region. -->
  <section class="sidebar-region" aria-labelledby="r-top">
    <h2 class="sidebar-region-head" id="r-top">
      Live &amp; web <span class="sidebar-region-count">· 5</span>
    </h2>
    <section class="session-group" aria-labelledby="g-1">
      <h3 class="list-group-label" id="g-1" title="/home/user/webapps/pi-web">…same as above…</h3>
      <ul class="list">…session rows…</ul>
    </section>
  </section>

  <!-- Archive: omitted entirely when it has 0 rows -->
  <details class="sidebar-region sidebar-archive" open={archiveOpen()} onToggle={…}>
    <summary class="sidebar-region-head">
      <svg class="icon icon-sm icon-twist" aria-hidden="true">…chevron-right…</svg>
      <span>Archive</span>
      <span class="sidebar-region-count">· 43</span>
    </summary>
    <section class="session-group" aria-labelledby="ga-1">
      <h3 class="list-group-label" id="ga-1" title="/home/user">…</h3>
      <ul class="list">…session rows…</ul>
    </section>
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
- Remember the user's choice in `sessionStorage["pi-web:archive-open"]` (`"1"`/`"0"`), read on
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

**Archiving.** Sessions started from pi-web (`origin === "web"`) can be archived by hand, so
the top region doesn't keep every one of them forever.

- **Where.** An Archive Session icon button (`archive.svg`) last in the session head (§3), only
  on web sessions. Rows are links, so it can't live in them: a button inside `<a>` is invalid and
  splits the row's single target. It's the only archive control in the app, so it stays at every
  head width (§3, §4f "Width budget").
- **What it does.** `POST /api/sessions/archive { path, archived }`, then a list refresh. The id
  goes into `~/.pi/agent/pi-web/archived-sessions.json`; the session file is never written.
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
  now nested one level deeper.
- For the Archive, `<summary>` is what AT announces ("Archive · 43, collapsed"). Use a plain
  `<span>`, not a heading, inside it, because headings inside `<summary>` are exposed
  inconsistently. `<details>` announces expanded or collapsed on its own.
- Keyboard: Tab reaches the summary, and Enter or Space toggles it. Rows inside a closed archive
  aren't focusable, which is native `<details>` behavior.
- Contrast: ink-2 on sunken is 7.65 (dark) and 7.22 (light). Muted on sunken is 5.40 and 4.75.
- Touch: the summary is `--row-height`, 44px. At 320px the strip holds a 16px twist, the word,
  and the count, well inside the 288px of usable width.

## Archive by date

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
    <section class="session-group" aria-labelledby="a-today-0">
      <h3 class="list-group-label" id="a-today-0" title="/home/user">…folder, path, count…</h3>
      <ul class="list">…session rows…</ul>
    </section>
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
  are unchanged.
- **Open/closed state** follows the Archive's rule: the user's choice per section lives in
  `sessionStorage["pi-web:archive-date-open-{id}"]` (`id` is `today`, `yesterday`, `week`,
  `month`, `older`; `"1"`/`"0"`), read on load and written on `toggle`. A section opens
  **without** changing its stored choice while a search query is non-empty (so every hit is
  visible) or while it holds the selected session.
- **Look.** The summary is the `.list-group-label` eyebrow (mono, micro, uppercase, muted), plus
  semibold, at `--row-height`: a 16px twist in the folder icon's column, the name, and the count
  at the right. Hover inks it. It doesn't stick; the folder labels under it keep sticking. A
  `--color-border` rule separates sections and sits under an open section's summary. No new
  colors.
- **Accessibility.** AT reads the summary ("Today 4, collapsed"); it holds spans, not a heading,
  for the reason given under Regions. Folder labels inside stay `h3`. Tab reaches each summary,
  Enter or Space toggles it, and rows in a closed section aren't focusable.
- **Row time vs section.** Row line 2 still uses `relativeTime`, which counts 24-hour spans, so
  just after midnight a row can read "3h ago" under Yesterday, or "yesterday" under Last 7 days.
  Accepted: the section answers "which day", and the row answers "how long ago".

## Archive cleanup

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
  operations (§2 "Archiving"), and it's what stops a mis-click from destroying live work. An
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

## Search

- **Matching.** Case-insensitive substring match on `title`, `cwd`, and `model`, filtered on the
  client as the user types (no debounce needed for fewer than 2k rows).
- **Empty groups.** A group with no matching rows is hidden, and so is a region with none.
- **Both regions.** The query filters the top region and the Archive alike. While the query is
  non-empty, the Archive is forced open so matches are never hidden in a collapsed region.
  Clearing the query restores the stored open/closed choice. The count row
  (`{visible} of {total} sessions`) covers both regions, and each region head shows its own
  filtered count.
- **Count.** `.search-count` always shows `{visible} of {total} sessions`, and just
  `{total} sessions` when the query is empty. It lives beside the filter it answers to,
  following the filter-bar rule.
- **Keys.** `/` anywhere, while focus isn't in a text field, focuses search. `Esc` inside search
  clears the query first, then blurs on a second press. Clear Search returns focus to the input.

## States

| State | What renders |
|---|---|
| Loading (first fetch, after 300ms) | 6 × `<div class="skeleton skeleton-row">` inside `.sidebar-list`, separated by `--space-2`. Put `aria-busy="true"` on the `nav`. Nothing appears before 300ms |
| Error | `.banner.banner-error` at `--space-3` inset, with `alert-circle`. Title: "Couldn't read your sessions." Body: "`~/.pi/agent/sessions` wasn't changed. Check the server is running, then retry." `.banner-action`: `<button class="button button-sm">Retry</button>`. If rows loaded earlier, keep them visible below the banner |
| Empty (0 sessions on disk) | `.empty`. Title: "0 sessions in `~/.pi/agent/sessions`." Body: "Start one here, or run `pi` in a terminal. It'll show up in this list." One `.empty-action`: `New Session` (secondary) |
| No matches | `.empty`. Title: "0 of 48 match “{query}”." Body: "We search titles, folders, and models." Action: `<button class="button">Clear Search</button>` |

## Tokens

Sidebar ground `--color-surface`. Row hover and `:focus-within` `--color-sunken`, both on
`.session-row-shell`; open row `--color-accent-tint` on `.session-row-shell-current`.
Title `--color-ink`, `--fw-medium`, `--fs-body`. Summary `--fs-micro`, `--lh-micro`,
`--color-ink-2`. Meta `--color-ink-muted`, `--fs-caption`.

**The rail.** A 30px column with `margin: 0 2px` — a 34px gutter, title 34px from the
panel edge. Rail padding is `--space-2` on **top only**, matching the row link: the horizontal
breathing room is the margin, so the 30px box stays symmetrical and the 26px pill centres in it
4px off the panel edge, with the count on the same axis. Items stack centred with `--space-1`.
The state pill is 26 × 26, `--r-full`, `--stroke-thin`
`--color-border` on `--color-surface` (`--color-border-strong` on hover), with a 7px
`currentColor` dot; its tone is `.chip-accent` (TUI) or `.chip-info` (Busy). The count is
borderless, 16px tall, `--font-mono` `--fs-micro` tabular in `--color-ink-muted`
(`--color-ink` on hover), with an 11px `worker` icon. `live-pulse` runs on the Busy dot and on
`.session-rail-count-live .icon`, nothing else in the row.

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
label `--font-mono`, `--fs-mono`, `--color-ink-muted`. Row link padding `--space-2` `--space-4`
`--space-2` 0 (the rail replaces its left padding), `min-height: --row-height`. Head
`min-height: 56px`, border `--color-border`. Brand is
`--fw-display`, letter-spacing −.03em, and `--fs-heading-s`. The mark takes `--color-accent`; the
word never does.

## Accessibility

- **Landmarks.** `aside[aria-label="Sessions"]` > `nav[aria-label="Session list"]`. Each group is
  a `section` labelled by its `h2`. Rows are plain links in a `ul`, so the browser provides
  Tab/Enter behavior with no roving tabindex.
- **Selected row.** Mark the link with `aria-current="page"` and the shell with
  `.session-row-shell-current`.
- **The rail is the one sanctioned wordless status in the system.** Everywhere else, status is a
  dot **and** the word. Session rows are the exception, and it is a deliberate one: at 320px the
  words cost more title than they buy. What carries the state instead:
  1. **The pill's border and tone** — a bordered 26px pill on `--color-surface`, accent for TUI
     and info for Busy, so the dot is never a bare hue floating in a row.
  2. **Static vs pulsing**, which separates TUI from Busy without depending on hue at all.
     Note the limit honestly: one dot glyph can't also differ in *shape*, so the two pills are
     the same silhouette. Motion, not form, is the non-color channel.
  3. **`title`** on each rail button — "Open in a TUI · pid {pid} · {status}", "pi is replying in
     this session", "{n} subagents working now".
  4. **`aria-label`** on each rail button, so the state has a real accessible name and isn't a
     nameless button.
  5. **The row link's own name repeats the state** in a `.visually-hidden` span (", open in a
     TUI", ", pi is replying in this session", ", {n} subagents working now"). A screen-reader
     user hears the state while arrowing the list, without ever reaching the rail buttons.
- **Rail buttons are `tabindex="-1"` on purpose.** They are affordances, not destinations: two
  extra tab stops per row would add hundreds to a 278-row list, and the same facts are already in
  the row link's name. They stay real buttons so pointer users get a `title` and AT can address
  them directly.
- **Touch.** There is no hover on touch, so tapping a rail button raises its sentence as a toast
  — the same text as its `title`. The button sits outside the row link, so the tap doesn't open
  the session. The pill is 26px, under the 44px target minimum: it is an optional affordance for
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
  (§4f) — and the outline strip (§10) names the topics. A sighted pointer user gets the same
  sentence on hover; a touch user gets it on long-press, the platform's own `title` gesture. The
  rail's own precedent applies here too: this is the sidebar, and nowhere else. The row's remote
  mark follows the same precedent with one exception, stated under "Remote sessions": its fact
  rides the row link's accessible name as a short clause, so a screen-reader user hears which
  rows are remote — the one fact the list is scanned for once a group mixes them.
- **The cost, stated.** A sighted touch user still sees a coloured dot and no word until they tap
  it or open the session (§3's `.run-status` and the head say which it is). The toast is a second
  gesture and it isn't discoverable — nothing on the row says the dot can be tapped. We accept
  that for the sidebar and nowhere else. If a second wordless status is ever proposed, this is
  the precedent to argue against, not with.
- **Contrast.** Ink on surface is 12.34 (dark) and 17.86 (light). Muted on surface is 4.96 and
  5.74. Muted on tint is 5.06 and 4.68. Accent on surface is 4.67 and 6.81. Accent on tint is
  4.76 and 5.55. All clear AA 4.5.
- **Folded width.** Opening a row sets `data-view="session"`. Move focus to the session head
  title (`tabindex="-1"`) so screen readers announce the new context.

---

