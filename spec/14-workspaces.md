# 14 · Group workspaces
> Part of the pi-web design spec · [overview](overview.md)

A group stops being only a section in the sidebar and becomes a place you can open. The
**workspace** is a second view over the groups that already exist (§2 "Groups"): every member of
one group side by side, each one a whole chat — its own transcript, its own composer, its own
socket — plus one composer at the foot that writes to all of them at once.

It answers the question the sidebar can't: *what did all of these say to the same prompt?*
Fanout (§14b) is how a group full of members gets made in one gesture; this file is the surface
they land in, and it works exactly the same for a group you filed by hand.

**One registry, not two.** The workspace reads and writes `~/.pi/agent/pi-web/session-groups.json`
through the routes §2 already names. There is no second grouping concept, no workspace that isn't
a group, and no group that can't be opened as a workspace.

## Decisions

| Decision | What it means here |
|---|---|
| The registry is the existing group store, extended | `SessionGroup` gains `members` (display order, optional label) and an optional `seed`. Nothing new is invented, and a hand-made group opens as a workspace with no migration |
| Lineage is the session header, and it is never rewritten | `parentSession` in the file says where a fork came from; `SessionSummary.parent` carries it to the client. pi-web reads it and never writes over it. `seed` is pi-web's own note about a fanout it performed, not a claim about the session file |
| One group per session | The `assignments` map already enforces it. A session is in one workspace or none, so "which workspace am I looking at" is never ambiguous |
| Split is one horizontal row that scrolls | No grid, no tiling, no cap on how many members a group holds. A pane never goes under 440px |
| Every pane stays mounted, including hidden tabs | A member that streams while you read another one must not lose its turn. Tabs hide, they don't unmount |
| One group composer, all members, all-or-nothing | A shared follow-up is a single server-side batch. If one member can't take it, none of them do, and the refusal names each one |
| All-or-nothing is a **pre-check**, not a transaction | The server checks every member before it prompts any of them, so the refusal is complete and nothing is half-sent by our own doing. A member lost *between* the check and the send (a TUI grabs it in the same second) makes the batch partial, and we say so — a prompt a model is already answering cannot be recalled, and claiming otherwise would be the one lie this surface can't afford |
| Promote removes from the group; Eliminate removes and archives | Neither deletes a transcript. Both are the group's writes, never the session file's |
| A group that a fanout created dissolves when its last member leaves | See "Emptying a group". A hand-made group survives empty, as §2 already says |
| Announcements and DOM ids are pane-scoped | Three panes finishing in the same second must read as three facts, each naming its member |

## Rejected

| Not doing | Why |
|---|---|
| Collapsing the shared prefix of forked members | The prefix is what you are comparing against; folding it away hides the control in a controlled comparison, and a fold that has to re-open on every diverging token is worse than scrolling |
| Drag-to-resize and drag-to-reorder panes | The first cut ships `Wider` / `Narrower` and `Move Left` / `Move Right`, which are keyboard-reachable and need no pointer capture over live transcripts. §1's own resizer already documents the gap a drag-only control leaves |
| A session in more than one group | One assignment is the whole reason "this session's workspace" is a fact rather than a list |
| Group-level rewind | Rewinding is a write into each session file with its own guards (§13). One button that writes into 5 files, some of which may refuse, is 5 outcomes wearing one label |
| A member-versus-member diff view | Diffing model prose is a different product. The panes are side by side; reading them is the comparison |
| Fanout onto a remote target | Every member would open a runtime on the same host at once. The mount and connection surfaces (§1) are per session for a reason, and N of them is a new failure mode we have no words for yet |

## Data

The store keeps its shape (`{version, groups, assignments}`) and the assignment map stays the
one source of membership. `SessionGroup` carries the presentation on top of it:

```ts
interface GroupMember { id: string; label?: string }   // id = SessionSummary.id, not a path

interface SessionGroup {
  id: string; name: string; createdAt: string;
  /** The group's sessions in display order, reconciled against the assignments on every read. */
  members?: GroupMember[];
  /** Recorded only when pi-web itself forked or fanned this group out (§14b). Absent for a
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
  on a group through a rename or a reassign, so a `seed` written by a newer pi-web survives an
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
  survive a promote, a dissolve and a rename, because pi-web never writes the header. Use
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
  `Align to Fork` (§14b) are `seed` features, and a group pi-web didn't fan out has neither —
  even when every member is visibly a fork. A marker placed at a guessed position would be worse
  than no marker.

## Routes

| Route | Shows |
|---|---|
| `#/g/{id}` | The workspace, split: every member in one scrolling row |
| `#/g/{id}/{encodeURIComponent(path)}` | The workspace, focused on one member: that pane fills the main column, and the others stay mounted behind the tab strip |
| `#/g/{unknown id}` | The sidebar, and a toast: "That group is gone." Routing never renders an empty frame for a group that isn't there |

`#/s/{path}` keeps meaning exactly what it means now — one session, alone, whether or not it is in
a group. Opening a grouped session from the sidebar row still goes to `#/s/`, because the row is a
session; the workspace is reached from the group (§2 "Groups", the tool row's `Open workspace`).
A member's pane head links to `#/s/{path}` so one member can always be pulled out to full width
without leaving the group.

**Split and focused are the same mount.** Moving between `#/g/{id}` and `#/g/{id}/{path}` changes
layout, not lifetime: no socket closes, no transcript reloads, and a turn in flight in a pane you
just left keeps arriving.

## Shell

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
          <div class="workspace-pane-tools">…Open, Wider, Narrower, Move Left, Move Right, Promote, Eliminate…</div>
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
- **Nothing here pulses except work.** The tab's `.live-dot` is a running turn. A member open in
  a TUI takes `.chip-accent` with no `.chip-live`, exactly as §0 requires.

## Layout: split

`.workspace-row` is one horizontal flex row, and the row is the scroll container.

| Property | Value | Why |
|---|---|---|
| Direction | `flex-direction: row`, `overflow-x: auto`, `overflow-y: hidden` | One axis of overflow. A pane never wraps to a second row, so "left of" and "right of" stay true |
| Pane width | `flex: 0 0 var(--workspace-pane-width)` (`clamp(440px, 34vw, 720px)`), floor `--workspace-pane-min` (440px) | 440 is `--main-min`, the transcript's floor, for the same reason: under it the reading column stops being one |
| Count | Uncapped | A fanout of 9 is a legitimate thing to ask for, and the row already scrolls. What protects the layout is the floor, not a cap |
| Snap | `scroll-snap-type: x proximity` on the row, `scroll-snap-align: start` on each pane | Proximity, not mandatory: you must be able to park two panes half-and-half to read them together |
| Gap and seam | No gap; each pane has a left border (`--color-border`), the first none | Panes are columns of one surface, not cards on a canvas. A gap here would read as N windows |
| Scrollbar | The row's own, always at the foot of the panes and above the group composer | The one place a horizontal scrollbar is allowed in this product |

- **`Wider` and `Narrower`** step that one pane's width by 120px between 440 and 1040, written to
  a per-pane `--workspace-pane-w` and kept in memory only. Like §1's sessions pane, nothing is persisted:
  a width is a posture for the task in front of you.
- **`Move Left` / `Move Right`** swap the member with its neighbour and write the whole order
  (`PATCH /api/session-groups/{id} {order}`). The pane keeps focus and is scrolled back into view, so the
  thing you moved is the thing you are still looking at. Disabled at the ends, with
  `aria-disabled` and no reason text.
- **Scrolling a pane into view** is `scrollIntoView({inline:"nearest", block:"nearest"})` on the
  row only — never on the page, and never smooth while `prefers-reduced-motion` is set.

## Layout: tabs

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

## A pane

A pane is a whole `ChatView` for a member pi-web can write to, and a whole `WatchView`
(read-only, §2 "Live sessions") for a member open in a TUI. Nothing about the transcript, the
composer, the model menu or the mode menu changes inside a pane — §3, §4 and their sub-sections
apply verbatim. What changes is scoping and chrome:

- **Pane head, 40px**, sunken, under the 56px workspace head: the member name, the context gauge
  (§4f, the percent-only step — a pane is never a 720px head), its state chip, and the tools.
  The name is `{label} · {model}` when a label exists, else `{title} · {model}`, truncated, with
  the full string in `title`.
- **The accessible name of the pane is that same string**, through `aria-labelledby`. Three
  regions called "Transcript" would be useless; "control · claude-opus-5" is what the user is
  actually distinguishing.
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
- **`Open`** is a link to `#/s/{path}`: the member alone, at full width, out of the workspace but
  still in the group.
- **Scroll** is the pane's own `.pane`. Jump to Latest (§3) is per pane and sits inside it.

## Member states

| State | The pane shows | The group composer |
|---|---|---|
| Ready | The chat, the composer live | Included |
| Mid-turn | The chat, the run status row, `Steer` in its own composer (§4) | **Excluded**, reason "mid-turn". A shared prompt is not a steer |
| Open in a TUI | A **watch** pane: read-only transcript, the `TUI` chip (accent, static), and in place of a composer the `.composer-reason` "This session is open in a terminal, so pi-web won't write to it." | Excluded, reason "open in a terminal" |
| Archived | The chat, read normally, with a neutral `.chip` "Archived" in the pane head and its composer disabled, reason "This session is archived. Unarchive it to send." **Archiving is the close gesture**: the server disposes the held runtime, so the pane's `/ws/chat` closes from the server side moments after Eliminate. That close is **expected** — the pane keeps rendering the transcript it has and shows the Archived chip, never the disconnected or busy banner a single-session view would show for the same event | Excluded, reason "archived". An eliminated member stays visible and readable — that is what makes elimination reversible |
| Config error | The §1 open-failure banner, in the pane's own banner slot, with its own actions (Mount and reconnect · Reconnect · Archive). The transcript area keeps whatever loaded | Excluded, reason "can't be opened" |
| Foreign-write busy | The `busy` banner the single-session view already shows, with its `Reconnect (force)` action, and the composer disabled | Excluded, reason "another program is writing to it" |
| Gone from disk (the session file, checked by shape plus one async stat — never a sync stat, and never the member's `cwd`) | The pane is replaced by an `.empty` inside the pane: **"This session's file is gone."** Its transcript was deleted outside pi-web. Removing it from the group is all that's left. · button `Remove From Group` | Excluded, reason "the file is gone" |

The excluded count is always visible in the group composer's foot, never discovered at send time.

## The group composer

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
  `sent` is the ids that were prompted and is never empty, because a refusal is a `409` instead.
  **Members are prompted in group order, not in the order the client happened to list them** — the
  order the panes are read in is the order the turns start in, so "the third one answered first"
  is about the models and not about us.
  `failed` carries only a member that broke *after* the pre-check passed, which is the partial
  send below; it is normally empty. Each entry is a full `BatchRefusal`, so the banner's
  `Send to {member}` is the same route again with `members: [id]` — no new endpoint, and the
  retry is the user's explicit subset like every other subset here.
- **The refusal body is machine-readable and human-readable both**:
  `409 {refused: [{id, path, code, message}]}`. `id` joins against `GroupMember.id` and the
  assignments with no lookup, `path` is what the pane routes and opens with, `code` is the closed
  set the state table above names (`mid-turn` · `tui-live` · `archived` · `config` · `busy` ·
  `missing`), plus `internal` for a failure that fits none of them, and `message` is the server's
  sentence. **The banner is composed from `code` and the member's own name** (§9), never by
  parsing prose — so the words on screen are pi-web's and stay consistent with the rest of the
  product. `message` is shown verbatim in exactly two cases, and both are the same case really:
  when pi-web has no sentence of its own to say. `internal` is one (the server knows something we
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
  bubble — the same optimistic rule §4 gives. The group composer clears once the server accepts.
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
kept until the send succeeds, so nothing is retyped. The banner is dismissed by `Cancel`, by
editing the text, or by a successful send.

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
  hidden visually, not removed, so `aria-describedby="w2-composer-reason"` still reads "This
  session is open in a terminal, so pi-web won't write to it." to AT. A disabled pane composer
  that collapses must not become a Send button with no explanation.
- **`data-collapsed="true"` is the only hook**, on `.composer`, so the state is one attribute and
  the styling is one rule.
- **Nothing is announced when composers collapse.** It is layout responding to where the caret
  is, and a live region that fires on every focus change is noise.

## Group lifecycle

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
    included — so the restore cannot half-succeed. This is the one gesture where atomicity is
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
  can refuse in three ways** (`archiveSession`, `server/sessions-index.ts:558-564`): the session
  is open in a TUI, it wasn't started in pi-web, or it is mid-turn. Two of the three the pane
  already knows, so it says so **before** the press rather than half-succeeding: for a TUI-live
  or mid-turn member, Eliminate is `aria-disabled` with the reason ("This session is open in a
  terminal." · "It's mid-turn. Stop it or wait, then eliminate it."). Removed-but-not-archived is
  a worse outcome than a button that explains itself, and it is left for the genuine race — a
  turn that starts between the check and the write — where §9's "Removed **{title}** from
  “{name}”, but couldn't archive it." is the honest report. The non-web case is not a refusal to
  route around but a different gesture, below. The toast names both writes: "Removed **{title}** and archived it." For a session pi-web did not start, the
  archive half is not available (§2 "Archiving" is web-origin only), the button reads
  `Remove From Group`, and its `title` says why: "This session wasn't started in pi-web, so
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
  another group moves it, and the row says so ("in “Home”").

### Emptying a group

**A group that pi-web's own fanout created (`seed` present) is deleted by the write that removes
its last member. A group made by hand is not.**

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
Both are **bookkeeping about files that disappeared outside pi-web**, there is no client waiting
on either to be told what happened, and a group vanishing during a background refresh is
unexplained loss — the exact thing this spec spends its words preventing. The rule is about the
gesture that empties a group, not about the group ever being empty. So an empty fanout group
**is** reachable, and the workspace renders it (below) rather than pretending it can't exist.

The delete happens server-side, in the same write, so no second request can fail halfway — and
**the response has to say so**, because the client cannot infer it from a member count it just
changed: `POST /api/session-groups/assign` answers `{ok: true, dissolved?: true}`, with
`dissolved` set only on the write that removed the last member of a `seed` group. This is a
behavioural change to a route the frontend already calls, so it is announced like any other. The
toast says what happened to both things at once: "Removed **{title}** and archived it. Dissolved
“{name}” — nothing was left in it." Routing then leaves for `#/`, because the route you were on
no longer names anything.

### One member, and none

| Case | The workspace |
|---|---|
| 1 member | Renders normally: one pane at its width, the row not scrolling, the group composer reading "1 member" and sending to that one. **It does not silently become `#/s/`** — you are one `Add Members` away from a comparison, and a view that redirects out from under you can't be built on |
| 0 members, hand-made | `.empty` in the pane area: **"“{name}” has no sessions yet."** Add some here, or drag a row onto the group in the sidebar. · buttons `Add Members` · `Fan Out…`. The group composer is not rendered — there is nothing to send to |
| 0 members, fanout group | Reachable, but only the long way round: every member's file was deleted outside pi-web, so no assign ever emptied it. The pane area is an `.empty`: **"Every session in “{name}” is gone."** Their files were deleted outside pi-web. The group is all that's left of the fanout. · button `Dissolve`. No `Add Members`: a fanout group's fork point points at sessions that no longer exist, and filling it with unrelated chats would make it lie about what it is |

## Announcements

**One polite live region for the whole workspace**, at the body like every other portal, and
**every message names its member first**:

- "control · claude-opus-5 — replied."
- "glm-5.3 #2 — working."
- "haiku-4.5 #3 — stopped by you."
- Group-level facts have no prefix: "Sent to 4 members." · "Nothing was sent. 2 members can't
  take a message right now."

N live regions racing produce interleaved half-sentences, and AT gives no guarantee about their
order. One region with a mandatory prefix is a queue that reads in the order things happened, and
the prefix is the only part that makes three finishes distinguishable. The prefix is the pane's
accessible name, byte for byte, so what AT says matches what the pane is called.

## Keyboard

| Keys | Does |
|---|---|
| `Ctrl+Alt+Left` / `Ctrl+Alt+Right` | Move focus to the previous / next pane: focus its `.workspace-pane` (`tabindex="-1"`), scroll it into view, and in tabs mode select its tab. Stops at the ends, no wrap |
| `Tab` | Walks into the pane and through its controls in visual order, then out to the next pane. No focus trap anywhere |
| `Left` / `Right` in the tab strip | The tablist's own roving tabindex, as the skill's tabs specify |
| `Esc` | Nothing new. It does not leave the workspace and it does not abort a turn (§4) |

`Ctrl+Alt+Arrow` is chosen because `Alt+Arrow` is browser history and `Ctrl+Arrow` is
word-navigation in every textarea on screen — and there are N textareas on screen. The binding is
registered on the workspace only, so it exists nowhere else in the product.

## Accessibility

- `.workspace` is the `main`, labelled "Workspace: {name}". Its `h1` is the group name.
- Panes are `role="region"` in split and `role="tabpanel"` in tabs, always named "{label or
  title} · {model}", always in DOM order = `members` order.
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

## Classes

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

## Tokens

`--workspace-pane-min` (440px, the same floor and the same reason as `--main-min`), `--workspace-pane-width`
(`clamp(440px, 34vw, 720px)`), plus `--color-border`, `--color-surface`, `--color-sunken`,
`--space-2`, `--space-3`, `--space-4`, `--dur-fast`, `--ease-standard`, `--fs-caption`,
`--control-md`, `--tap-min`, and the chip and status tokens the member states use.

**All user-facing strings are in §9 · Copy deck.**

---
