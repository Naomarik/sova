# §workspace/groups — 14 · Group workspaces
> Part of the Sova design spec · [overview](../design/overview.md)

A group stops being only a section in the sidebar and becomes a place you can open. The
**workspace** is a second view over the groups that already exist (§2 "Groups"): every member of
one group side by side, each one a whole chat — its own transcript, its own composer, its own
socket — plus one composer at the foot that writes to all of them at once.

It answers the question the sidebar can't: *what did all of these say to the same prompt?*
Fanout (§14b) is how a group full of members gets made in one gesture; this file is the surface
they land in, and it works exactly the same for a group you filed by hand.

**One registry, not two.** The workspace reads and writes `~/.pi/agent/sova/session-groups.json`
through the routes §2 already names. There is no second grouping concept, no workspace that isn't
a group, and no group that can't be opened as a workspace.

## §workspace.groups/decisions — Decisions

| Decision | What it means here |
|---|---|
| The registry is the existing group store, extended | `SessionGroup` gains `members` (display order, optional label) and an optional `seed`. Nothing new is invented, and a hand-made group opens as a workspace with no migration |
| Lineage is the session header, and it is never rewritten | `parentSession` in the file says where a fork came from; `SessionSummary.parent` carries it to the client. Sova reads it and never writes over it. `seed` is Sova's own note about a fanout it performed, not a claim about the session file |
| One group per session | The `assignments` map already enforces it. A session is in one workspace or none, so "which workspace am I looking at" is never ambiguous |
| Split is one horizontal row that scrolls | No grid, no tiling, no cap on how many members a group holds. A pane never goes under 440px |
| Every pane stays mounted, including hidden tabs | A member that streams while you read another one must not lose its turn. Tabs hide, they don't unmount |
| One group composer, all members, all-or-nothing | A shared follow-up is a single server-side batch. If one member can't take it, none of them do, and the refusal names each one |
| The pre-check is also what makes this surface testable for nothing | A refused batch has no side effects, so the whole refusal path — parsing, the banner, every member named in Sova's words, `Send to the Rest`, the draft surviving — can be exercised against a real server with **zero model calls**, e.g. by a group whose members are all TUI-live. A transactional design would have something to undo on every run. Noted beside the decision because it is a property of it, not a testing trick |
| All-or-nothing is a **pre-check**, not a transaction | The server checks every member before it prompts any of them, so the refusal is complete and nothing is half-sent by our own doing. A member lost *between* the check and the send (a TUI grabs it in the same second) makes the batch partial, and we say so — a prompt a model is already answering cannot be recalled, and claiming otherwise would be the one lie this surface can't afford |
| Promote removes from the group; Eliminate removes and archives | Neither deletes a transcript. Both are the group's writes, never the session file's |
| A group that a fanout created dissolves when its last member leaves | See "Emptying a group". A hand-made group survives empty, as §2 already says |
| Announcements and DOM ids are pane-scoped | Three panes finishing in the same second must read as three facts, each naming its member |

## §workspace.groups/rejected — Rejected

| Not doing | Why |
|---|---|
| Collapsing the shared prefix of forked members | The prefix is what you are comparing against; folding it away hides the control in a controlled comparison, and a fold that has to re-open on every diverging token is worse than scrolling |
| Drag-to-resize and drag-to-reorder panes | The first cut ships `Wider` / `Narrower` and `Move Left` / `Move Right`, which are keyboard-reachable and need no pointer capture over live transcripts. §1's own resizer already documents the gap a drag-only control leaves |
| A session in more than one group | One assignment is the whole reason "this session's workspace" is a fact rather than a list |
| Group-level rewind | Rewinding is a write into each session file with its own guards (§13). One button that writes into 5 files, some of which may refuse, is 5 outcomes wearing one label |
| A member-versus-member diff view | Diffing model prose is a different product. The panes are side by side; reading them is the comparison |
| Fanout onto a remote target | Every member would open a runtime on the same host at once. The connection surfaces (§1) are per session for a reason, and N of them is a new failure mode we have no words for yet |

## §workspace.groups/data — Data

The store keeps its shape (`{version, groups, assignments}`) and the assignment map stays the
one source of membership. `SessionGroup` carries the presentation on top of it:

```ts
interface GroupMember { id: string; label?: string }   // id = SessionSummary.id, not a path

interface SessionGroup {
  id: string; name: string; createdAt: string;
  /** The group's sessions in display order, reconciled against the assignments on every read. */
  members?: GroupMember[];
  /** Recorded only when Sova itself forked or fanned this group out (§14b). Absent for a
      group made by hand, and never written from a session file's own lineage. */
  seed?: { parentSessionPath: string; leafId: string };
}
```

- **Order is array position**, not a number on the member, so there is no second ordering to keep
  in sync and no gaps to renumber. `Move Left` / `Move Right` send the whole order:
  `PATCH /api/session-groups/{id} {order: [id, id, …]}`.
- **`label`** is the user's word for a member ("control", "the cheap one"). Trimmed, 1–40
  characters (`GROUP_LABEL_MAX`), optional, and it never replaces the title: the pane head shows
  the label first and the title under it. A member with no label shows the title alone. A label
  survives a move between groups, because it describes the session, not the group.
- **A field this build doesn't know is kept, not dropped.** The store preserves unrecognized keys
  on a group through a rename or a reassign, so a `seed` written by a newer Sova survives an
  older one touching the same group. Without that, the fork markers and `Align to Fork` of a
  fanout would quietly disappear the first time an older build renamed the group — the kind of
  loss nobody would connect to its cause.
- **Membership is still the assignments map.** `members` is reconciled against it on read: an id
  that left the group drops out, an id the array never learned about is appended. A workspace
  therefore cannot show a member that isn't assigned, whatever the store says.
- **`seed.leafId`** is the entry every member was forked from. It is what the fork-point marker
  and `Align to Fork` (§14b) point at, and it is the one thing that makes a fanout group
  different from a folder of unrelated chats.
- **`SessionSummary.parent` and `parentId`** are the session header's `parentSession`, as a
  canonical path and as the session id, set together or not at all. Read-only lineage: they
  survive a promote, a dissolve and a rename, because Sova never writes the header. Use
  `parent` to link or open (routes take paths), `parentId` to match against `GroupMember.id` and
  the assignments, which are id-keyed.
- **Two identifier vocabularies, on purpose.** Lineage is **paths** (`seed.parentSessionPath`,
  `SessionSummary.parent`) because a path is what the session header stores and what the routes
  open. Membership is **ids** (`members[].id`, the assignments map, `SessionSummary.parentId`)
  because an id is what the store keys on. Neither is converted on the way in: a value is used in
  the vocabulary it arrives in, and the two are paired on the summary so nothing has to look one
  up from the other.
- **Lineage says *that*; `seed` says *where*.** `parentId` can tell you two members of a
  hand-made group came from one session; it cannot tell you which entry they diverged at, and
  without that there is no row to draw and nothing to align to. So the fork marker and
  `Align to Fork` (§14b) are `seed` features, and a group Sova didn't fan out has neither —
  even when every member is visibly a fork. A marker placed at a guessed position would be worse
  than no marker.

## §workspace.groups/routes — Routes

| Route | Shows |
|---|---|
| `#/g/{id}` | The workspace, split: every member in one scrolling row |
| `#/g/{id}/{encodeURIComponent(path)}` | The workspace, focused on one member: that pane fills the main column, and the others stay mounted behind the tab strip |
| `#/g/{unknown id}` | The sidebar, and a toast: "That group is gone." Routing never renders an empty frame for a group that isn't there |

`#/s/{path}` keeps meaning exactly what it means now — one session, alone, whether or not it is in
a group. Opening a grouped session from the sidebar row still goes to `#/s/`, because the row is a
session; the workspace is reached from the group (§2 "Groups", the group menu's `Open workspace`).
A member's pane head links to `#/s/{path}` so one member can always be pulled out to full width
without leaving the group.

**Split and focused are the same mount.** Moving between `#/g/{id}` and `#/g/{id}/{path}` changes
layout, not lifetime: no socket closes, no transcript reloads, and a turn in flight in a pane you
just left keeps arriving.

## §workspace.groups/shell — Shell

The workspace is a third value of `.app`'s `data-view`, and it takes the whole main column: no
`.session-head`, no single-session composer.

```html
<a class="button skip-link" href="#group-composer">Skip to Group Composer</a>
<div class="app" data-view="workspace">
  <aside class="app-sidebar" aria-label="Sessions">…§2…</aside>
  <main class="workspace" aria-label="Workspace: Fanout · retry backoff">
    <header class="workspace-head">
      <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…chevron-left…</a>
      <div class="workspace-head-main">
        <h1 class="workspace-title" tabindex="-1">Fanout · retry backoff</h1>
        <p class="workspace-meta">
          <span class="workspace-count">4 members</span>
          <span aria-hidden="true">·</span>
          <span class="text-mono" title="/home/user/webapps/pi-web">~/webapps/pi-web</span>
        </p>
      </div>
      <!-- only while a session that was in this group is still on screen; see "Promote" -->
      <span class="chip chip-count workspace-promoted">Promoted: Retry with jitter
        <button type="button" class="button button-sm button-ghost">Add Back</button></span>
      <button type="button" class="button button-sm button-ghost" aria-pressed="false">Tabs</button>
      <button type="button" class="button button-sm button-ghost workspace-align">…branch… Align to Fork</button>
      <button type="button" class="button button-sm button-ghost">Add Members</button>
      <button type="button" class="button button-sm button-ghost">Dissolve</button>
    </header>

    <!-- tabs mode, and every width under 768: one strip, one pane visible -->
    <div class="workspace-tabs" role="tablist" aria-label="Members">
      <button class="workspace-tab" role="tab" aria-selected="true" id="ws-tab-p1" aria-controls="pane-p1">
        <span class="workspace-tab-title">control</span>
        <span class="live-dot"></span>            <!-- only while that member is mid-turn -->
      </button>
      …
    </div>

    <div class="workspace-row" aria-label="Members">
      <section class="workspace-pane" id="pane-p1" role="region" aria-labelledby="pane-p1-name" tabindex="-1">
        <header class="workspace-pane-head">
          <span class="workspace-pane-name" id="pane-p1-name">control · claude-opus-5</span>
          <span class="context-gauge" title="…">…§4f…</span>
          <span class="chip chip-accent"><i class="chip-dot"></i>TUI</span>   <!-- state chips, see below -->
          <button class="button button-icon button-ghost workspace-pane-tools"
                  aria-haspopup="menu" aria-label="Pane actions · control · claude-opus-5">…more…</button>
        </header>
        <div class="workspace-pane-body">…§3 transcript, with pane-scoped ids…</div>
        <footer class="composer workspace-pane-composer" data-collapsed="true">…§4, collapsed…</footer>
      </section>
      …one per member…
    </div>

    <footer class="composer group-composer" id="group-composer">…"The group composer" below…</footer>
  </main>
</div>
<div class="visually-hidden" role="status" aria-live="polite"><!-- one region, every pane, prefixed --></div>
```

- **`.workspace` replaces `.app-main`** in the grid's second column, at the same width and
  with the same floor. The sidebar, the resizer (§1) and the portals are untouched; the subagents
  pane (§11) is **not** available in a workspace, because it is a per-session surface and there
  are N sessions here. A member's own `/agents` opens `#/agents`, which is cross-session already.
- **The head is 56px**, like `.session-head` and `.subagents-head`, so the band across the window
  still reads as one. Under 640px of head width the four tool buttons collapse into one
  `More Actions` ghost icon button opening the skill's plain action menu, in the order above.
- **The meta line is the workspace's one roll-up**: `{n} members`, then the cwd every member
  shares (or `{n} folders` when they don't — the one fact that says "these are not the same
  task"), then — after a shared send — the completion count `{r} of {t} replied`, with
  `· {w} still working` while any of them runs and `· {e} errored` whenever a member's turn
  failed. The roll-up is anchored to the last ACCEPTED shared send (a box send replaces the
  watched set; a partial banner's retry unions it, so the straggler is counted with the ones
  already answering), reads `busy`/workers live off the list plus each pane's turn-error state,
  and **never counts an errored member as replied** — "3 of 5 replied" must not be able to hide
  a broken member, which is the whole reason the count exists. It is memory-only: a reload does
  not know about the last send and shows nothing rather than a guess.
- **Nothing here pulses except work.** The tab's `.live-dot` is a running turn. A member open in
  a TUI takes `.chip-accent` with no `.chip-live`, exactly as §0 requires.

## §workspace.groups/layout-split — Layout: split

`.workspace-row` is one horizontal flex row, and the row is the scroll container.

| Property | Value | Why |
|---|---|---|
| Direction | `flex-direction: row`, `overflow-x: auto`, `overflow-y: hidden` | One axis of overflow. A pane never wraps to a second row, so "left of" and "right of" stay true |
| Pane width | `flex: 0 0 var(--workspace-pane-w)` — a pane nobody has stepped takes the row's own share (`max(--workspace-pane-width, row ÷ panes)`, `autoPaneWidth`; `--workspace-pane-width` is `clamp(440px, 34vw, 720px)`), floor `--workspace-pane-min` (440px) and ceiling `PANE_MAX_WIDTH` (1040px, in code; there is no CSS token for it) | 440 is `--main-min`, the transcript's floor, for the same reason: under it the reading column stops being one. 34vw is a guess at a comfortable column made without knowing the row; when it leaves the row half empty the measured share wins, because an empty strip to the right of the last pane is a workspace that isn't using the screen it was given — up to the ceiling, past which a wider reading column is not the answer |
| Count | Uncapped | A fanout of 9 is a legitimate thing to ask for, and the row already scrolls. What protects the layout is the floor, not a cap |
| Snap | `scroll-snap-type: x proximity` on the row, `scroll-snap-align: start` on each pane | Proximity, not mandatory: you must be able to park two panes half-and-half to read them together |
| Gap and seam | No gap; each pane has a left border (`--color-border`), the first none | Panes are columns of one surface, not cards on a canvas. A gap here would read as N windows |
| Scrollbar | The row's own, always at the foot of the panes and above the group composer | The one place a horizontal scrollbar is allowed in this product |

- **A pane nobody has stepped fills the row.** Its width is the leftover space — the row's own
  measured width minus the panes the user has stepped — divided among the panes still on their
  default, floored, never below the 34vw posture and never past 1040px. It is derived on every
  render, never stored, so it follows the window and the sidebar. While the row's share is under
  the ceiling, no empty strip is left to the right of the last pane; past it (one member in any
  row wider than 1040px, two past 2080px) the panes stop at 1040 and the strip stays. A row with
  nothing left to divide (the share lands under 34vw) keeps the 34vw posture: the panes overflow
  and the row scrolls, as they did before this existed. So `Wider` on a row the auto-fit filled can
  bring the scrollbar back — the pane beside it holds its floor rather than shrinking to make room
  for the step. An **auto-fit only ever widens**
  a pane; it never squeezes one, which is why it cannot be the thing that makes a 4-way fanout
  unreadable. A pane the user has stepped is out of the calculation entirely: a chosen width is a
  posture, and filling the row by rewriting one is the bug §14 already paid for once (the `gid`
  memo in GroupView.tsx).
- **`Wider` and `Narrower`** step that one pane's width by 120px between 440 and 1040, written to
  a per-pane `--workspace-pane-w` and kept in memory only. The step starts from the number on
  screen, so the first press on an auto-fitted 560px pane lands on 680 — not on 34vw. Like §1's
  sessions pane, nothing is persisted: a width is a posture for the task in front of you.
- **`Fit All`** (split only, 2+ members) sets EVERY pane to the one width at which they stand in
  the row with no scrollbar: the row's measured width (its content box, watched by a
  `ResizeObserver`, never `clientWidth`) divided by the pane count (panes are `border-box` and the
  seam is a pane's own border, so nothing is subtracted; floored, never rounded; and capped at the
  1040 ceiling every width here keeps, `PANE_MAX_WIDTH`). The press stores the posture, not the
  number, so that width is re-derived every time the row changes. That width
  is **allowed below the 440 floor, and Fit is the only thing that is** — the floor's own words are
  "a pane narrower than this can't hold a transcript and a composer", and that is true: comparison
  wins here because the user asked for exactly it, and the alternative is that a 4-way fanout fits
  no viewport at all (4×440 = 1760). A fitted pane under 440px carries an inline `min-width: 0`
  beside the width, because the stylesheet's floor would otherwise quietly re-apply. **A fitted
  pane is a posture, not a number**: it keeps taking the row's share when the row changes (the row shrinks, the panes shrink together, still with no
  scrollbar), where a pane stepped to a number keeps that number through the same resize. While any
  pane in the row is fitted, a member added to the group — or one that comes back — joins the fit
  instead of standing at the auto width beside it, so the row stays without a scrollbar. On a row
  nobody has stepped the press usually changes no width at all — the auto-fit is already the fit
  width — and it still means something: it leaves the panes fitted, and it is the way back from
  stepped widths. Leaving a fit is deliberate: `Wider` from below the floor
  lands on 440, the first stepped width; `Narrower` below the floor does nothing — a button that
  says "narrower" while raising the pane to 440 would be the announcement lying about the click.
  The number is said out loud (the announcement, and what a later step starts from), and it is
  memory-only like every width. At the audit's live measurement: row 1120 → Fit 2 = 560, Fit 3 =
  373, Fit 4 = 280; at 1600 → 800 / 533 / 400.
- **`Move Left` / `Move Right`** swap the member with its neighbour and write the whole order
  (`PATCH /api/session-groups/{id} {order}`). The pane keeps focus and is scrolled back into view, so the
  thing you moved is the thing you are still looking at. Disabled at the ends, with
  `aria-disabled` and no reason text.
- **Scrolling a pane into view** is `scrollIntoView({inline:"nearest", block:"nearest"})` on the
  row only — never on the page, and never smooth while `prefers-reduced-motion` is set.

## §workspace.groups/layout-tabs — Layout: tabs

`Tabs` is a pressed-state ghost button in the head (`aria-pressed`), remembered in
`sessionStorage["pi-web:group-view-{id}"]` for the browser session. In tabs mode
`.workspace-row` shows exactly one pane at full width and the strip above names the rest.

- **Hidden panes stay mounted and keep streaming.** They are `hidden` (not removed), their sockets
  stay open, and their transcripts keep appending. Coming back to a tab shows the turn that
  happened while you were away, already scrolled to the end if you had not scrolled up.
- **A hidden pane that finishes a turn** still announces, through the shared live region and with
  its member prefix, and its tab's `.live-dot` goes out. That is the whole point of keeping it
  mounted.
- **The strip** is a `role="tablist"` of `role="tab"` buttons; the panes are the tabpanels, so in
  tabs mode each `.workspace-pane` takes `role="tabpanel"` and `aria-labelledby` its tab. In split mode
  they are `role="region"` instead, named the same way, and the strip is not rendered. The role
  swap is deliberate: a tablist that names 4 panels, only one of which exists, would be a lie.
- **Below 768px of viewport width the workspace is tabs-only.** The `Tabs` button is hidden
  (there is nothing to toggle), a split preference in storage is ignored rather than cleared, and
  crossing 768 upward restores it. 440px of pane does not fit beside anything on a phone, and a
  one-pane split and a tab are the same picture with one of them lying about the mode.

## §workspace.groups/a-pane — A pane

A pane is a whole `ChatView` for a member Sova can write to, and a whole `WatchView`
(read-only, §2 "Live sessions") for a member open in a TUI. Nothing about the transcript, the
composer, the model menu or the mode menu changes inside a pane — §3, §4 and their sub-sections
apply verbatim. What changes is scoping and chrome:

- **Pane head, 40px**, sunken, under the 56px workspace head: the member name, the context gauge
  (§4f, the percent-only step — a pane is never a 720px head), its state chips, and the tools.
  The name is `{label} · {model}` when a label exists, else `{title} · {model}` — and for
  members that share a title with no label (the canonical `opus ×3` fanout) the model with its
  `#n` ALONE: `claude-opus-5 #2`. The suffix is numbered in member order and is **the same rule
  the tab strip reads** (`paneNames` in `session-groups.ts`, one implementation), because the tab
  strip and the pane head naming the same member differently — or the pane names omitting the
  suffix while the tabs kept it, which is where this was caught — makes `#2` mean two things at
  once. The model is never said twice: a name that already is the model takes no `· {model}`
  half. The name's `title` is the full string, then the cwd, then the session's whole spend
  (`SessionUsage.total`, the same field the Session-info dialog tallies) — "which answer won"
  includes cost, and this puts it one hover from the comparison instead of a dialog deep in each
  pane. A `Working` chip (live dot) sits in the head while the member is mid-turn: in split mode
  there is no single place that says who is still running, and the tab strip's dot only covers
  tabs mode.
- **The accessible name of the pane is that same string, in both modes.** The pane carries
  `aria-label="{label or title} · {model}"` whether it is a `region` or a `tabpanel` — it is not
  labelled by its tab. Pointing a tabpanel at its tab is the usual convention, and here it breaks
  something that matters more: the live region's prefix **is** the pane's accessible name
  (Announcements), so a name assembled differently in tabs than in split makes the prefix
  byte-for-byte right in one mode and merely similar in the other. `aria-controls` on the tab
  already ties the two together. Three regions called "Transcript" would be useless; "control ·
  claude-opus-5" is what the user is actually distinguishing.
- **A tab's visible text has to distinguish it inside this group**, which the title alone often
  won't: every member of a fork **shares** the source's title, so a strip of 5 tabs reading
  "Retry with jitter" five times names nothing. The rule is the first of these that tells members
  apart — the `label` if one is set, else the model with its repeat suffix (`glm-5.3 #2`) when
  members share a title, else the title. The tab's accessible name stays the full
  `{label or title}, {model}` (§9) at every width.
- **Every id inside a pane is scoped by a pane id**: `composer-input-p2`, `composer-reason-p2`,
  `context-desc-p2`, `composer-flyout-p2`, and the pane and its tab as `pane-p2` / `ws-tab-p2`.
  `aria-controls`, `aria-describedby`, `aria-labelledby` and every `for` follow. Duplicated ids
  across panes would hand AT the first pane's composer reason for all of them.
- **The pane id is per session, not per position.** It is issued once per path (`p1`, `p2`, …)
  and kept, so `Move Left` doesn't renumber every id in the view and a member that leaves and
  comes back finds its own ids again. A positional id would be stable only until the first
  reorder, which is a gesture this surface ships. The path itself can't be the id: it is long and
  full of characters an id shouldn't carry.
- **Outside a workspace there is no scope and no suffix.** A session opened at `#/s/` renders the
  same view with bare ids, exactly as it does today, because there is nothing to disambiguate
  from. The scope is what a pane adds, not something the session view carries everywhere.
- **The tools are one menu, not a row.** Seven controls do not fit beside a name at a 440px
  pane, and a row that sheds controls as it narrows would hide different ones at different pane
  widths in the same view. One `Pane actions` trigger, the skill's plain action menu, named for
  the pane it acts on (`Pane actions · {pane name}`) so three of them on screen are three
  different menus to AT. The labels inside are the ones below, unabbreviated.
- **`Rename…` is the comparison's naming act** (§14b "Member labels"). The useful name — "the
  one that read the tests", "control" — is only known AFTER reading output, which is why the
  fanout dialog sets no label and this gesture lives in the pane that output is read in: a field
  in the pane's own menu, one write (`PATCH {labels}`), and every surface that names the member
  (head, tab, aria-label, announcements) moves in the same breath because they read one rule.
  Empty clears the label; the pane shows the title — or the repeat suffix — again. `Move Left`
  and `Move Right` carry the workspace's one keyboard hint in their `title`s, because they are
  the rows whose gesture most invites it, and it lived nowhere else.
- **Three ways a member leaves, and each word does one thing.** `Promote` removes it and takes
  you to it. `Remove From Group` removes it and leaves you here. `Eliminate` removes it and
  archives it. All three are offered for a session Sova started; for one it didn't,
  `Eliminate` is absent rather than relabelled, because the archive half isn't available (§2
  "Archiving") and a word that only sometimes archives is the lie this set exists to avoid.
  `Remove From Group` is what a member you want out but not archived has always needed — without
  it the only remove-and-stay gesture would be `Promote`, which doesn't stay.
- **`Open`** is a link to `#/s/{path}`: the member alone, at full width, out of the workspace but
  still in the group.
- **Scroll** is the pane's own `.pane`. Jump to Latest (§3) is per pane and sits inside it.

## §workspace.groups/member-states — Member states

| State | The pane shows | The group composer |
|---|---|---|
| Ready | The chat, the composer live | Included |
| Mid-turn | The chat, the run status row, `Steer` in its own composer (§4) | **Excluded**, reason "mid-turn". A shared prompt is not a steer |
| Open in a TUI | A **watch** pane: read-only transcript, the `TUI` chip (accent, static), and in place of a composer the `.composer-reason` "This session is open in a terminal, so Sova won't write to it." | Excluded, reason "open in a terminal" |
| Archived **while still a member** — archived from its own pane, or from anywhere else, without leaving the group | The chat, read normally, with a neutral `.chip` "Archived" in the pane head and its composer disabled, reason "This session is archived. Unarchive it to send." **Archiving is the close gesture**: the server disposes the held runtime, so this pane's `/ws/chat` closes from the server side while the pane is still mounted. That close is **expected** — the pane keeps rendering the transcript it has and shows the Archived chip, never the disconnected or busy banner a single-session view would show for the same event. This is the only state in which that happens; an **eliminated** session is not a member and has no pane (see Eliminate) | Excluded, reason "archived" |
| Config error | The §1 open-failure banner, in the pane's own banner slot, with its own actions (Reconnect · Archive, as appropriate to the diagnosis). The transcript area keeps whatever loaded | Excluded, reason "can't be opened" |
| Foreign-write busy | The `busy` banner the single-session view already shows, with its `Reconnect (force)` action, and the composer disabled | Excluded, reason "another program is writing to it" |
| Gone from disk (the session file, checked by shape plus one async stat — never a sync stat, and never the member's `cwd`) | The pane is replaced by an `.empty` inside the pane: **"This session's file is gone."** Its transcript was deleted outside Sova. Removing it from the group is all that's left. · button `Remove From Group` | Excluded, reason "the file is gone" |
**The gone member keeps its pane, its place and its name.** The `.empty` renders at the member's
position in the row and in its tab, called what this tab last saw it called (a `lastSeen` summary
cache), because a member that silently drops out between polls is exactly the loss this state
exists to prevent — the pane disappearing IS the bug, not the report of it. Detection reads the
WHOLE session list, never this group's filter: a member moved to another group out-of-band has no
row here but a live file, and "gone" would be a lie about a session that is merely elsewhere. It
also waits for one list load to land after the workspace opened, because the fanout dialog
refreshes the list and navigates in the same breath, and a just-created member is the one thing
"file is gone" must never be said about; before that load a member with no row is absent, the
same as it ever was.

**The assignment outlives the file on purpose.** `dropGroupAssignments` runs only from Archive
cleanup (ids it deleted itself), never on the listing pass — a prune there would race this pane's
own `Remove From Group`, and the member would vanish silently instead of rendering this state.
Removing the ghost is the user's gesture, **by session id** (`POST /api/session-groups/assign
{ id, groupId: null }` — there is no file left to resolve a path through; the id form is
removal-only), and it is what dissolves an emptied fanout group, exactly like any other
last-member removal. The group composer counts these members in its foot (`· 1 file gone`) so a
send the server refuses on one is a confirmation, not a discovery.

The assignment outlives the file **on purpose**: the server prunes a member's group assignment only from Archive cleanup (ids it deleted itself, inside Sova), never on the listing pass — a prune there would race this pane's own Remove From Group and the member would vanish silently instead of rendering this state. Removing the ghost is the user's gesture (`POST …/assign { id, groupId: null }`, the store keys on ids so no file is needed), and it is what dissolves an emptied fanout group. A reader tempted to "clean up" stale assignments in the lister owns re-deriving who else deletes members.

The excluded count is always visible in the group composer's foot, never discovered at send time.

## §workspace.groups/the-group-composer — The group composer

One composer at the foot of the workspace, full width of the main column, writing to every
member at once.

```html
<footer class="composer group-composer" id="group-composer">
  <form class="composer-inner" aria-label="Message every member">
    <div class="composer-row">
      <label class="visually-hidden" for="group-composer-input">Message every member</label>
      <textarea class="input textarea composer-input" id="group-composer-input" rows="1"
                placeholder="Ask all 4 members…—Enter sends, Shift+Enter adds a line"
                aria-describedby="group-composer-reason"></textarea>
      <div class="composer-actions">
        <button class="button button-primary" type="submit">
          <span class="icon" style="--icon: url(/icons/arrow-right.svg)" aria-hidden="true"></span>
          <span class="button-label">Send to All</span>
        </button>
      </div>
    </div>
    <div class="composer-foot">
      <span class="group-composer-targets">4 of 5 members · 1 mid-turn</span>
      <span class="composer-reason" id="group-composer-reason"></span>
    </div>
  </form>
</footer>
```

- **It is the workspace's one primary.** §0 allows one accent button in view, so while the
  workspace is open no pane composer's Send is `.button-primary`: a pane's Send becomes
  `.button` (secondary) with the same label and the same behavior. The accent says "this sends
  to all of them", which is the choice worth marking.
- **It sends one request**, `POST /api/session-groups/{id}/prompt {text, members?: string[]}`,
  and the server prompts each member. The client does not fan the request out itself: N sockets
  racing would give N outcomes and no way to be all-or-nothing about them. `members` is **session
  ids**, like everything else group-side, and it is only ever the subset the user chose (below);
  every id must be in the group. **The route carries no images field at all** — that is what "the
  `plus` trigger is absent rather than disabled" means on the wire, not just in the composer.
- **What comes back when it works**: `200 BatchPromptResult {sent: string[], failed: BatchRefusal[]}`.
- **`sent` means accepted, not answered, and the route does not wait for the turns.** It returns
  as soon as every member's prompt is queued, and **it accepts them concurrently.** Accepting in
  sequence would make a press of Send cost the sum of every member's runtime open before the
  composer clears — the one thing the acceptance semantics were meant to avoid, reintroduced a
  layer down. **And slowness is the mild failure.** A sequential `await` has no isolation: one
  member whose acceptance never resolves — a runtime open that stalls —
  blocks every member behind it *and* the response itself, so the composer waits forever on one
  bad member and the other four never start. Concurrent acceptance makes that member's failure
  its own: it lands in `failed`, the rest are accepted, and the batch returns.
- **One limit, stated rather than discovered later.** The response still waits for every
  acceptance to settle, so a member whose acceptance never resolves holds the *response* open and
  the group composer stays in flight. What it no longer holds is the other members: they were all
  started, their turns are running, and their panes are filling. The remaining exposure is a
  composer that doesn't clear, next to panes visibly working. We accept that rather than bound
  the wait, because a bound would have to guess how long a cold runtime may legitimately take,
  and cutting a member loose at the guess would report a failure for a turn that then starts
  anyway — a worse lie than a slow button. Waiting would contradict the two things this
  surface is built on: turns **start together** (§14b's rate-limit note exists because they do),
  and the group composer **clears once the server accepts**. A request that resolved only when
  five full turns had finished would hold the composer for minutes and serialize the very thing
  the workspace exists to run in parallel — member 2 would not start until member 1 was done.
- **So `failed` is about acceptance, not outcome.** A member that was accepted and then fails
  reports in **its own pane**, over its own socket, where every other turn failure already
  reports. This response never speaks for a turn it didn't wait for.
- **`sent` is never empty.** If not one member was accepted, that is not a partial send, it is a
  refusal: the server answers `409 {refused}` with those members instead. Otherwise the banner
  would have to say "Sent to 0 of 5 members", and then that the 0 are answering — a sentence with
  no meaning, and §9 deliberately has no copy for it.
  **Members are prompted in group order, not in the order the client happened to list them** — the
  order the panes are read in is the order the turns start in, so "the third one answered first"
  is about the models and not about us.
  `failed` carries only a member that broke *after* the pre-check passed, which is the partial
  send below; it is normally empty. Each entry is a full `BatchRefusal`, so the banner's
  `Send to {member}` is the same route again with `members: [id]` — no new endpoint, and the
  retry is the user's explicit subset like every other subset here.
- **The refusal body is machine-readable and human-readable both**:
  `409 {refused: [{id, path, code, message}]}`. `id` joins against `GroupMember.id` and the
  assignments with no lookup, `path` is what the pane routes and opens with — **empty for
  `missing`**, where there is no file left to name, so nothing may build a link from it — `code` is the closed
  set the state table above names (`mid-turn` · `tui-live` · `archived` · `config` · `busy` ·
  `missing`), plus `internal` for a failure that fits none of them, and `message` is the server's
  sentence, and **`message` is never empty** — a refusal whose underlying error carried no text
  falls back to that code's own sentence server-side. That guarantee is load-bearing rather than
  tidy: `message` is what an older client shows when it meets a code it doesn't know, so an empty
  one would drop the reason on the floor in exactly the case the fallback exists for.
  **The banner is composed from `code` and the member's own name** (§9), never by
  parsing prose — so the words on screen are Sova's and stay consistent with the rest of the
  product. `message` is shown verbatim in exactly two cases, and both are the same case really:
  when Sova has no sentence of its own to say. `internal` is one (the server knows something we
  have no word for, and inventing a calm generic sentence would be hiding it), and a `code` this
  client doesn't recognize is the other, which is how an older client stays honest about a newer
  server instead of dropping a reason on the floor.
- **Send stays enabled when the foot already names an exclusion, and that is deliberate.** The
  client's picture of who is available is a snapshot and can be stale in both directions — a
  member may have finished its turn, or a terminal may have grabbed one a second ago. The server
  is the only authority, so pressing Send is how you ask it. What the foot buys is that the
  refusal is a **confirmation rather than a discovery**: the count that comes back is the count
  that was already on screen. Send is `aria-disabled` only when the client knows there is nobody
  at all to send to.
- **The pre-check reads the group, not the disk.** It resolves members from the group's own
  membership and whatever index the server already keeps, never by scanning the sessions
  directory. This path is routine by design (below), and a directory walk per press of Send is a
  cost that grows with every session the user has ever made, to answer a question about five of
  them.
- **All-or-nothing is a pre-check, and it says so.** The server checks **every** member — not
  up to the first bad one — and that check completes before **any** member is prompted, so a
  refusal leaves zero prompts sent and the `409` can name every blocked member at once rather
  than one at a time. If a member fails *after* the
  pre-check passed (a TUI grabbed it in the same second), the batch is partial and the banner
  says exactly that — we do not roll back a prompt that a model is already answering, and we do
  not pretend it didn't land.
- **Attachments and slash commands are not in the group composer.** Images belong to a
  conversation (§4b) and a slash command is a per-runtime thing, half of them local (§4d). Both
  stay in the pane composers, where their target is one session. The `plus` trigger is absent
  here rather than present-and-disabled.
- **Sent text appears in every included pane at once**, optimistically, as that pane's user
  bubble — the same optimistic rule §4 gives.
- **The composer clears on a clean send, and keeps the text on a partial one.** "Clears once the
  server accepts" describes the ordinary case: `failed` empty, everyone got it, nothing left to
  do. When `failed` is non-empty the text stays in the box, because the banner offering the
  retry can be dismissed and the message must not go with it — k members have it and one
  doesn't, and that is the worst moment to make someone retype from memory.
- **But the retry sends the text as it was SENT, not as the box now reads.** `Send to {member}`
  re-sends the exact string captured at send time. This is the one rule that cannot bend: a
  group composer exists so that every member gets *the same message*, and a retry that picked up
  an edited box would hand the straggler a different one under a label promising the same. So
  the box is a convenience — visible, editable, and never the source of the retry. If the user
  edits it and presses Send to All instead, that is a new message to everyone, which is exactly
  what it looks like.
- **Enter sends, Shift+Enter adds a line**, the same keys, and the same IME rule.

### Refusal

A `409` renders one `.banner.banner-warn` above the composer row, inside `.group-composer`, with
the three beats §0 requires and one row per blocked member:

> **Nothing was sent.** 2 of 5 members can't take a message right now: **control** is mid-turn,
> **glm-5.3 #2** is open in a terminal. Wait for them, or send to the other 3.
>
> `Send to the Rest (3)` · `Cancel`

`Send to the Rest` re-sends the identical text with an explicit `members` array of session ids —
the subset is chosen by the user in one press, never inferred by the server on the first call. The draft is
kept until the send succeeds, so nothing is retyped. This banner is dismissed by `Cancel`, by
editing the text, or by a successful send — see the rule below for why editing dismisses this
one and not the partial.

### Banners that offer, and banners that report

**A banner offering to send what is in the box dies with the box. A banner reporting what
already happened does not.** The distinction decides dismissal everywhere on this surface:

| Banner | Kind | Editing the box |
|---|---|---|
| Refusal (`409`, nothing sent) | **Offer** — `Send to the Rest` sends what the box holds | Dismisses it. The offer was about that text, and that text just changed |
| Partial send (`200` with `failed`) | **Report** — k members have a message and one doesn't | **Persists.** It stays true however the box reads, and it is the only record of which member missed out. It clears on a send, not a keystroke |
| Partial creation (§14b) | **Report** — these members exist, these never started | Persists, for the same reason |

Getting this wrong is quiet: a keystroke that dismisses a report destroys the only notice that a
member is out of sync, and it looks like tidy-up rather than loss. Two consequences follow, and
both are rules rather than details:

- **Only the box's own send clears the box.** A retry from a banner must not wipe what is being
  typed — that would be the composer destroying work in order to report success.
- **Collapse follows the box, not the send.** Pane composers stay collapsed while the group
  composer still holds text, because the rule (§14 "Pane composers…") is about the box being
  non-empty, and a send that left text behind has not emptied it.

### Pane composers while the group composer is in use

The rule, exactly: **while the group composer is focused or holds text, every pane composer that
is neither focused nor holding its own draft collapses.** A pane with a draft never collapses —
its text must stay visible — and a focused pane composer never collapses under you.

| State | Height | What is in it |
|---|---|---|
| Expanded (the §4 composer) | 96px: 12 top padding + 44 row + 8 gap + 20 foot + 12 bottom | Everything §4 names |
| Collapsed | 68px: 12 + 44 + 12 | The same `.composer-row` — flyout trigger, textarea pinned to 1 line, Send. `.composer-foot` (model indicator, mode trigger, reason) and the attachments list are `hidden` |
| Collapsing / expanding | `height` over `--dur-fast`, `--ease-standard` | State change, §0's duration. Off under `prefers-reduced-motion` |

- **No control is removed, and no target shrinks.** The row keeps its 44px, so Send and the
  flyout trigger stay full-size tap targets and stay in the tab order. What goes is the foot —
  the model id, the mode switch and the reason line — which is reference, not action, and which
  the pane head's own chips and the flyout still carry.
- **The textarea is pinned to one line while collapsed** (`field-sizing` off, `rows="1"`, no
  auto-grow) and released the moment it takes focus, which expands the pane composer in the same
  frame. Typing is never done in a box that is deciding whether to grow.
- **A collapsed composer keeps its reason as an accessible description.** `.composer-reason` is
  hidden visually, not removed, so `aria-describedby="composer-reason-p2"` still reads "This
  session is open in a terminal, so Sova won't write to it." to AT. A disabled pane composer
  that collapses must not become a Send button with no explanation.
- **`data-collapsed="true"` is the only hook**, on `.composer`, so the state is one attribute and
  the styling is one rule.
- **Nothing is announced when composers collapse.** It is layout responding to where the caret
  is, and a live region that fires on every focus change is noise.

## §workspace.groups/group-lifecycle — Group lifecycle

All four are writes to the group registry. None of them touches a session's JSONL.

- **Promote** — `POST /api/session-groups/assign {path, groupId: null}`, then navigate to
  `#/s/{path}`. The member you picked is the answer; the workspace has done its job. The group
  header keeps a `Promoted: {title}` chip with `Add Back` for as long as the workspace stays
  mounted in this tab, so a promote made by mistake is one press from undone. The chip is not
  persisted: it is an undo for the gesture, not a record of it. **It carries the member's label
  and position**, because ungrouping drops the member entry: the pane comes back named what it
  was called and where it was. An undo that silently dropped the name you gave a member, or put
  it back in a different place, would not be one.
  - **One write, not two.** `Add Back` sends `assign {path, groupId, label, index}` — position
    included, `0` being first and anything at or past the end landing at the end — so the restore
    cannot half-succeed. `index` works here precisely because a promoted session has **left** the
    group: assign is a position no-op for a member already in its target, and moving one that is
    already there is `PATCH {order}`'s job, not assign's. One route changes membership, the other
    changes arrangement. This is the one gesture where atomicity is
    worth a field: it is the undo for Promote, and an undo that partly works is worse than one
    that fails cleanly and says so.
  - **Against a server that doesn't take `index`** the field is ignored and the member lands at
    the end of the group, which is exactly when §9's "It's at the end." is true. The fallback
    copy is for that case, not for a race.
  - **If a follow-up `PATCH {order}` is ever sent instead, it carries the WHOLE array.** `order`
    means "the listed ids first, in that order; everything left out keeps its relative order
    behind them", so `order: ["restored-id"]` puts the member **first** — a wrong answer that
    looks deliberate. Same rule as `Move Left` / `Move Right`: always the full order.
- **Eliminate** — the same assign-to-null, plus
  `POST /api/sessions/archive {path, archived:true}`. Two writes, one gesture, and **the second
  can refuse in three ways** (`archiveSession` in `server/sessions-index.ts`): the session
  is open in a TUI, it wasn't started in Sova, or it is mid-turn. Two of the three the pane
  already knows, so it says so **before** the press rather than half-succeeding: for a TUI-live
  or mid-turn member, Eliminate is `aria-disabled` with the reason ("This session is open in a
  terminal." · "It's mid-turn. Stop it or wait, then eliminate it."). Removed-but-not-archived is
  a worse outcome than a button that explains itself, and it is left for the genuine race — a
  turn that starts between the check and the write — where §9's "Removed **{title}** from
  “{name}”, but couldn't archive it." is the honest report. The non-web case is not a refusal to
  route around but a different gesture, below.
  - **The pane goes.** An eliminated session is no longer a member, so it leaves the workspace on
    the next list refresh. It does not linger greyed out: a pane is a member, and a view that
    kept showing one that isn't would be the workspace disagreeing with the group.
  - **What "reversible" means, exactly.** Nothing is destroyed: the transcript is intact, the
    session is readable at `#/s/{path}`, and it sits in the Archive. Getting it back is two
    deliberate gestures — Unarchive, then `Add Members` — and there is no undo chip, unlike
    Promote. Promote gets one because it also navigates you away, so a mis-click moves the ground
    under you; Eliminate leaves you exactly where you were, looking at the members you kept.

  The toast names both writes: "Removed **{title}** and archived it." For a session Sova did not start, the
  archive half is not available (§2 "Archiving" is web-origin only), the button reads
  `Remove From Group`, and its `title` says why: "This session wasn't started in Sova, so
  removing it is all we can do — nothing is archived." One word for two behaviors would be the
  lie here.
- **Dissolve** — `DELETE /api/session-groups/{id}`, the existing route, asked in place in the
  head: "Dissolve “{name}”? Its 4 sessions stay in the list." Then route to `#/`. Sessions are
  never touched, exactly as §2 already promises. **The word differs from the sidebar's on
  purpose:** there the control is `Delete group` and it removes a row from a list of groups; here
  it sits above 4 open transcripts, where "Delete" would read as deleting them. Same endpoint,
  same outcome, and both confirmations say the sessions stay.
- **Add Members** — the §2 popover radio list in reverse: a popover of ungrouped sessions,
  filtered by the same search, plus `Fan Out…` (§14b) at the end. Adding a session that is in
  another group moves it, and the row says so ("in “Home”"). **The same picker serves every
  width**: under 640px the narrow head's menu opens into this exact popover (search field
  included), not a truncated list of its own — a picker that silently caps at 40 rows and loses
  the search is a different picker wearing the same label. Its rows are keyboard-complete
  (Enter and Space activate), like every menuitem in the product. The empty state's and the
  partial-creation banner's `Add Members` buttons open it too, at any width — under 640 they
  flip the same open state the narrow head's menu answers, because a button that flips a signal
  nothing is listening to is a dead button. When the group carries a `seed`, the popover's
  `Fan Out…` hands the dialog that seed (§14b "Entry points": the append case).

### Emptying a group

**A group whose name is the user's work stands empty. Everything else here follows from that.**
Sova deletes a group it both created *and* named, on the write that removes its last member;
it never deletes one a person named — whether they typed the name when they made the group, or
typed it later over a generated one.

This is the one place the two kinds of group differ, and the reason is what they are. A hand-made
group is a name the user typed and a place they drag things into; §2 already specs it standing
empty, with "No sessions yet. Drag one here.", because empty is a state it is supposed to have.
A fanout group is scaffolding: it was born with its members in one gesture, its name was generated
from the prompt, and with no members left it holds nothing but a fork point nobody can reach. The
alternative — eliminating your way down to one winner, promoting it, and leaving a phantom section
in the sidebar forever — is litter the user has to notice and clean up.

**Only the assign gesture dissolves.** Two other paths can leave a fanout group empty, and
neither of them may delete it: archive cleanup, which removes session files in bulk, and the
listing pass itself, which prunes assignments whose file has gone (deleted by hand, or by a TUI).
Both are **bookkeeping about files that disappeared outside Sova**, there is no client waiting
on either to be told what happened, and a group vanishing during a background refresh is
unexplained loss — the exact thing this spec spends its words preventing. The rule is about the
gesture that empties a group, not about the group ever being empty. The prune already holds the
same instinct one level down — it is keyed on a file being gone, never on a summary failing, so
an unreadable file keeps its group — and this extends that caution upward: bookkeeping about
files may forget an assignment, but it may not delete something the user named. So an empty fanout group
**is** reachable, and the workspace renders it (below) rather than pretending it can't exist.

**`seed` is not the test, and never was a good proxy for one.** A seed says where a fork came
from — it is marker data, nothing more. Dissolution turns on a different question: *did anyone
type this name?* So the group carries an explicit flag, **`autoDissolve`**, set only when a
fanout creates a group and generates its name — Sova made it and named it, so Sova may
remove it — and **that flag is the one truth of dissolution**. Nothing else confers it.

**It is named for the behaviour, not the property, and that is the point.** This whole
correction exists because a field describing one thing (`seed`, lineage) was used to decide an
unrelated thing (deletion). A name like `scaffold` would describe a property again and invite
the same second use; `autoDissolve` says exactly what it controls and can proxy for nothing.
Do not re-derive dissolution from any other field, and do not use this one to mean anything
else.

**A rename revokes it.** `autoDissolve` says "Sova made this and named it", so a rename that
actually changes the name falsifies the second half and clears the flag. Renaming
"Fanout · retry backoff" to "Backoff experiments" is the plainest statement a user can make that
they mean to keep something, and it would be a poor reading of it to delete the group weeks
later. Renaming to the same string changes nothing, because nothing happened — and
**reorder and relabel never touch it**, even in the same `PATCH`. Only the name moves this
flag, because only the name is what it is about.

This is the property the flag's name was chosen for, generalised: **it is set and cleared by the
events that make it true or false, so nobody has to remember a rule.** The working method that
falls out of it, for the next field like this one: **`autoDissolve` encodes a claim — "Sova
owns this group" — so enumerate the events that transfer ownership, because each one is a defect
until it clears the field.** Four were found that way, each a separate round: adoption (the user's
group gains lineage), the legacy fallback (an adopted group is indistinguishable on disk from a
pre-flag fanout group), rename (the user names it themselves), and **the user typing the
dialog's name before Create** — the same transfer as rename, one moment earlier, and the only
one found by asking rather than by being hit.

**That enumeration is only half the method, and the missing half has its own failure.** Events
catch a claim that *drifts* — one that was true when written and outlived its conditions. It
cannot catch a claim that was **never true in one branch**: born half-false, and looking whole
because the other branch is the common one. For those, enumerate the **inputs**: *who can supply
this value?* For a group's name that list is short — `createGroup` (the user), `updateGroup` (the
user), and the fanout dialog's name field, which is **Sova's generated default OR the user's
typing**. One input, two cases, and a flag that only ever encoded the first — closed
by `FanoutRequest.named` (§14b), which is the client telling the server which of the
two it is. Run both enumerations when a field encodes a claim: the events that falsify it, and
the inputs that were never covered by it.

**With that input closed the enumeration is complete, and completeness is the point.** Who can
supply a group's name? `createGroup` — the user, no claim made. `updateGroup` — the user, and it
clears the claim. The fanout dialog — Sova's generated default *or* the user's typing, now
distinguished by `FanoutRequest.named` (§14b). There is no fourth supplier, so
"Sova may remove what it both made and named" is **literally** true rather than nearly true.
Every round of this family lived in the gap between those two words.

**The dangerous state must be the one a check has to ASSERT**, because absence is the state you
do not control — an older client, an older record, a field nobody set. Two ways to satisfy that,
depending on shape: **polarise a boolean so its falsehood is safe**, and **compare an enum
positively** (`x === "dangerous"`) rather than negatively (`x !== "safe"`). Both shapes fail the
same way under the negative form, which is why the rule is about the check and not only about
the type — and why a spec that names a field's absence rule should name its **check** too.
**Read it exactly, never by truthiness:** a JSON body is not a typed value, and `"false"`,
`"yes"`, `1` and `{}` are all truthy, so `if (flag)` claims the dangerous state for four inputs
that never asserted it. `=== true` for a boolean, `=== "the-dangerous-value"` for an enum. An
absence rule alone does not cover this, because absence and `"false"` take different paths
through the same careless check. Two fields
can carry identical information and fail in opposite directions — had `named` been a boolean, the
pair shows it exactly: `nameIsGenerated` absent reads as *the user named it*, and the group
survives; `nameEdited` absent reads as *untouched*, so Sova claims the name and deletes it.
Same fact, same size, one of them safe by construction.
The name that reads most naturally is not reliably the one that fails safe, so choose the
polarity first and the wording second.

**A safe absence default means the field cannot be migrated additively.** The property that
protects you from an old client — absence reads as the harmless answer — is the same property
that hides a half-finished migration. Add a replacement field beside the old one and the client
still sends the old; the server reads the new one, sees absence, applies the safe default, and
**the feature goes quietly inert**: nothing errors, nothing is destroyed, and the behaviour the
field existed to produce simply never happens. That is the failure shape hardest to notice,
because it looks like the system working. So a field with a safe absence default is replaced in
**one atomic change** — add, delete the old, update every reader and writer in the same window
— never additively, and never "deprecate and clean up later".

**A safe default does not remove a failure; it relocates one.** Everything else on this surface
fails toward **loss** — a name deleted, a group dissolved — and absence-means-safe exists to make
that impossible. What it produces in exchange is a failure toward **inertness**: the feature
quietly doing nothing. That trade is usually worth taking, because litter is recoverable and loss
is not, but it must be taken **knowingly**, because the second failure is the one the first rule
conceals. Whenever you choose a safe default, ask what now goes unnoticed — the answer is never
"nothing".

**And the build will not remind you.** Renaming this contract's field in a scratch tree produced
six errors in `server/` and **zero in `src/`**: TypeScript does not excess-property-check through
a spread, so a client assembling its body as `{ ...target, … }` keeps compiling while sending a
field the server no longer reads. The function's return annotation looks like protection and
isn't. So the atomicity rule is not a preference backed by a red build — **the red build only
appears on one side**, and the silent side is the one that decides whether the feature does
anything. The durable remedy is to make the client's construction excess-checked, which turns
this class of rename into a compile error at both ends; until then the rule is the only guard.

**Name the event, not the moment.** A rule anchored to a moment — "capture it at prefill" —
assumes the value is written once, which is true until some mode writes it repeatedly. Anchor
to the event instead: *whenever we write this field*. The moment form is the same mistake as
"the last line is the last rendered entry", true until a feature existed that rewrites the tail.
It reads as more concrete and is less durable. The alternative — a
renamed fanout group that still dissolves, "stated loudly" somewhere — is defensible on origin,
but it asks the user to carry a rule that only fires much later, at the moment of loss.

It is a **boolean, not a true-only flag**, because an explicit `false` has to be sayable: a
seeded group that must survive being emptied is the case this fixes, and absence now means
something else. **Absent** means "written before this field existed", and only then does `seed`
imply dissolution — those older groups are Sova's own fanouts, and **no adopted hand-made
group can be among them**: `seed` is written only by a fork-mode fanout, which until the
`groupId` path existed always created the group, and that path shipped in the same change as
the flag. There is no window, so the fallback cannot catch a group a user named. An explicit
value always wins.

The proxy came apart at adoption. Fanning out into a hand-made group (§14b's `groupId`) writes
a seed into it so the new members get fork markers — and keying on seed presence would have made
that group auto-dissolving, destroying a name the user typed on the strength of an unrelated
later fanout. That name is the exact property this rule exists to protect, so the case that
breaks the proxy is also the case that matters most.

**Adoption therefore changes nothing about dissolution**, and needs no warning in the fanout
dialog: there is nothing to warn about. A hand-made group gains fork markers and keeps every
other property it had, which is what a user would assume without being told. A warning would be
the interface apologising for a rule we chose not to have.

The delete happens server-side, in the same write, so no second request can fail halfway — and
**the response has to say so**, because the client cannot infer it from a member count it just
changed: `POST /api/session-groups/assign` answers `{ok: true, dissolved?: true}`, with
`dissolved` set only on the write that removed the last member of a group that dissolves itself
(`SessionGroup.autoDissolve`). **Not a `seed` group** — that was the rule before the two were
decoupled, and it is precisely the case the decoupling exists for: a hand-made group that adopts
a fanout's seed must keep standing empty, because its name is the user's work whether they typed
it at creation or at rename. This is a
behavioural change to a route the frontend already calls, so it is announced like any other. The
toast says what happened to both things at once: "Removed **{title}** and archived it. Dissolved
“{name}” — nothing was left in it." Routing then leaves for `#/`, because the route you were on
no longer names anything.

### One member, and none

| Case | The workspace |
|---|---|
| 1 member | Renders normally: one pane at its width, the row not scrolling, the group composer reading "1 member" and sending to that one. **It does not silently become `#/s/`** — you are one `Add Members` away from a comparison, and a view that redirects out from under you can't be built on |
| 0 members, hand-made | `.empty` in the pane area: **"“{name}” has no sessions yet."** Add some here, or drag a row onto the group in the sidebar. · buttons `Add Members` · `Fan Out…`. The group composer is not rendered — there is nothing to send to |
| 0 members, fanout group | Reachable **two ways, and the group cannot tell them apart**: every member removed or promoted (a renamed fanout group carries `autoDissolve: false`, so it survives being emptied), or every member's file deleted outside Sova. The store holds `seed` and members, never a *reason*, so no rule can separate the causes and the copy must not name one — the same refusal as everywhere else on this surface: do not assert a datum the contract does not carry. The pane area is an `.empty` (§9), and there is no `Add Members`: the fork point aims at a branch these members left, so filling the group with unrelated chats would make it lie about what it is · button `Dissolve` |

## §workspace.groups/announcements — Announcements

**One polite live region for the whole workspace**, at the body like every other portal, and
**every message names its member first**. The prefix is **the pane's accessible name, the same
string its `aria-label` carries** — `{label or title} · {model}` — not the model alone and not
anything recomputed: a prefix naming something that isn't on screen is worse than no prefix,
because it sounds like a different pane. The separator between name and fact is **an em dash**,
not the `·` the name already contains, so "Retry with jitter · opus-5 — replied." reads as a
name and a fact rather than three things in a list:

- "control · claude-opus-5 — replied."
- "glm-5.3 #2 — working."
- "haiku-4.5 #3 — stopped by you."
- Group-level facts have no prefix: "Sent to 4 members." · "Nothing was sent. 2 members can't
  take a message right now."

N live regions racing produce interleaved half-sentences, and AT gives no guarantee about their
order. One region with a mandatory prefix is a queue that reads in the order things happened, and
the prefix is the only part that makes three finishes distinguishable. The prefix is the pane's
accessible name, byte for byte, so what AT says matches what the pane is called.

## §workspace.groups/keyboard — Keyboard

| Keys | Does |
|---|---|
| `Ctrl+Alt+Left` / `Ctrl+Alt+Right` | Move focus to the previous / next pane: focus its `.workspace-pane` (`tabindex="-1"`), scroll it into view, and in tabs mode select its tab. Stops at the ends, no wrap |
| `Tab` | Walks into the pane and through its controls in visual order, then out to the next pane. No focus trap anywhere |
| `Left` / `Right` in the tab strip | The tablist's own roving tabindex, as the skill's tabs specify |
| `Esc` | Nothing new. It does not leave the workspace and it does not abort a turn (§4) |

`Ctrl+Alt+Arrow` is chosen because `Alt+Arrow` is browser history and `Ctrl+Arrow` is
word-navigation in every textarea on screen — and there are N textareas on screen. The binding is
registered on the workspace only, so it exists nowhere else in the product.

## §workspace.groups/accessibility — Accessibility

- `.workspace` is the `main`, labelled "Workspace: {name}". Its `h1` is the group name.
- Panes are `role="region"` in split and `role="tabpanel"` in tabs, always named "{label or
  title} · {model}", always in DOM order = `members` order.
- **Before the group composer exists**, the skip link points at the focused pane's transcript
  and reads `Skip to Transcript`. The target and the name move together — a link that says
  "Group Composer" and lands on a transcript is worse than either, and dropping the skip link
  entirely would make the workspace the one view in the product without one. "One of N" isn't a
  problem here: focus picks it.
- The skip link points at the group composer, because that is the workspace's action; a skip link
  to "the transcript" would have to pick one of N.
- Contrast: the pane head is ink-2 on sunken, the sidebar region head's pair (7.65 dark / 7.22
  light). The pane seam is `--color-border`, decoration, and carries no meaning that isn't also
  in the pane's name.
- Every state in "Member states" pairs its color with a word or an icon. The `TUI` chip is
  accent and static; the tab's live dot is the only looping thing in the view, and only while a
  turn runs.
- A member whose composer is disabled keeps its reason readable to AT even when collapsed (see
  above).

## §workspace.groups/classes — Classes

| Need | Classes |
|---|---|
| Shell | `.app[data-view="workspace"]` `.workspace` |
| Head | `.workspace-head` `.workspace-head-main` `.workspace-title` `.workspace-meta` `.workspace-count` `.workspace-promoted` `.workspace-align` |
| Tabs | `.workspace-modes` (the Split/Tabs group) `.workspace-tabs[role=tablist]` `button.workspace-tab[role=tab]` `.workspace-tab-title` (+ `.live-dot`) |
| Panes | `.workspace-row` `.workspace-pane` (+ `.workspace-pane-focused`, and a per-pane width set inline) `.workspace-pane-head` `.workspace-pane-name` `.workspace-pane-tools` `.workspace-pane-body` `.workspace-pane-composer` |
| Group composer | `.composer.group-composer` `.group-composer-targets` · refusal: `.banner.banner-warn` with `.banner-action` |
| Collapsed pane composer | `.composer[data-collapsed="true"]` |

Everything else is reused as it stands: `.composer*`, `.transcript*`, `.chip*`, `.banner*`,
`.empty*`, `.context-gauge`, `.live-dot`, `.button*`, `.pane`.

## §workspace.groups/tokens — Tokens

`--workspace-pane-min` (440px, the same floor and the same reason as `--main-min`), `--workspace-pane-width`
(`clamp(440px, 34vw, 720px)`, the least a pane nobody has stepped stands at — it takes the row's
share above that, "Layout: split"), plus `--color-border`, `--color-surface`, `--color-sunken`,
`--space-2`, `--space-3`, `--space-4`, `--dur-fast`, `--ease-standard`, `--fs-caption`,
`--control-md`, `--tap-min`, and the chip and status tokens the member states use.

**All user-facing strings are in §9 · Copy deck.**

---
