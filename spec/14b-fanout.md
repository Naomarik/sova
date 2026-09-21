# 14b · Fanout
> Part of the pi-web design spec · [overview](overview.md)

Fanout makes a whole workspace (§14) in one gesture: the same starting point, N ways. Either
**fork this session** — N copies of the conversation you are in, branched at the message you are
looking at, each one free to run a different model — or **start fresh** — N new sessions in one
folder from one prompt, sharing nothing but the prompt.

It is a creation gesture, not a mode. What it produces is an ordinary group of ordinary sessions:
every one of them opens at `#/s/`, appears in the sidebar, archives, and outlives the workspace.

## Two sources

| Source | What each member is | Shares |
|---|---|---|
| **Fork at the current leaf** | A branch of this session, taken at its active leaf: the whole conversation so far, then nothing | Every token before the fork point. Members diverge from the first reply |
| **Fresh prompt** | A new session in one folder, given the same first message | The prompt text, and nothing else. No shared root, no shared history, no shared id |

Fork is the comparison ("given everything we've said, what do three models do next?"). Fresh is
the race ("three independent attempts at this task"). They produce the same kind of group, and
the fork-point marker (below) is the only thing that tells them apart afterwards.

## Entry points

- **The composer flyout** (§4, the `plus` menu panel), a row after Session info: `Fan Out…`. It
  opens the dialog with **Fork at the current leaf** selected and this session as the source.
  Absent when the session has no assistant reply yet — there is nothing to fork — and absent for
  a watch view, where pi-web holds no runtime.
- **The sidebar's Groups region** (§2), a row beside `New group`: `New fanout`. It opens the same
  dialog with **Fresh prompt** selected and no source.
- **A workspace's `Add Members`** (§14), the last row of its popover: `Fan Out…`, with the
  workspace's group pre-chosen as the destination, so the new members land beside the ones
  already there.

## The dialog

The skill's modal, `.modal-wide` (§7's settings precedent: two columns of numbers have to fit
beside each other), a bottom sheet under 768px.

```html
<div class="modal modal-wide fanout" role="dialog" aria-modal="true" aria-labelledby="fanout-title">
  <header class="modal-head"><h2 class="modal-title" id="fanout-title">Fan out</h2>…close…</header>
  <div class="modal-body">

    <div class="field">
      <span class="field-label" id="fanout-source">Start from</span>
      <div role="radiogroup" aria-labelledby="fanout-source" class="fanout-source">
        <label><input type="radio" name="src" checked> Fork “Retry with jitter” at its latest message</label>
        <label><input type="radio" name="src"> A fresh prompt</label>
      </div>
      <p class="field-hint fanout-source-note">Each member gets the whole conversation up to
        message 34, then goes its own way.</p>
    </div>

    <!-- fresh prompt only -->
    <div class="field">…folder picker (§5), then a .textarea for the first message…</div>

    <div class="field">
      <span class="field-label" id="fanout-models">Members</span>
      <ul class="fanout-rows" aria-labelledby="fanout-models">
        <li class="fanout-row">
          <span class="fanout-row-model text-mono">anthropic/claude-opus-5</span>
          <span class="fanout-row-fill context-meta">48k of 1M · 4%</span>
          <div class="fanout-count">
            <button class="button button-icon button-ghost button-sm" aria-label="One fewer claude-opus-5">−</button>
            <span class="text-num" aria-live="off">2</span>
            <button class="button button-icon button-ghost button-sm" aria-label="One more claude-opus-5">+</button>
          </div>
          <button class="button button-sm button-ghost" aria-label="Remove claude-opus-5">…close…</button>
        </li>
        …
      </ul>
      <button type="button" class="button button-sm button-ghost fanout-add">…plus… Add a Model</button>
    </div>

    <div class="field">
      <label class="field-label" for="fanout-name">Group name</label>
      <input class="input" id="fanout-name" maxlength="60" value="Fanout · retry backoff">
    </div>

    <div class="fanout-preview">…see "Cost preview"…</div>
  </div>
  <footer class="modal-foot">
    <span class="modal-spacer"></span>
    <button class="button button-ghost">Cancel</button>
    <button class="button button-primary">Create 5 Members</button>
  </footer>
</div>
```

- **`Add a Model`** opens the §4c model picker, unchanged, as its own panel. Picking a model that
  is already listed **increments that row** rather than adding a second one — the count is the
  repeat.
- **Repeats are the point.** `claude-opus-5 ×3` is three members of one model, which is how you
  see the spread of one model rather than the difference between two. The count field goes 1–9
  per row; `−` at 1 removes the row, and its `aria-label` says `Remove {model}` there.
- **Member labels** are not set here. They are the group's per-member `label` (§14) and are
  edited in the pane head afterwards, because the useful name ("the one that read the tests")
  isn't known until you've read some output. Until then members of one model are distinguished by
  a suffix in the pane name: `claude-opus-5 #1`, `#2`, `#3`, numbered in member order.
- **The group name** defaults to `Fanout · {first 6 words of the source's title, or of the fresh
  prompt}`, trimmed to 60. It is a plain text field, duplicates allowed, exactly as §2's rename.
- **The primary counts what it will do**: `Create 5 Members`, `Creating…` while in flight, and
  `aria-disabled` with a reason when the total is 0 or a row can't fit (below).

## Cost preview

Two facts, stated plainly, because the whole gesture multiplies both: how full each member starts,
and what every shared turn costs from then on.

```
claude-opus-5 ×2      48k of 1M · 4%
glm-5.3 ×2            48k of 200k · 24%
haiku-4.5             48k of 200k · 24%

5 members × ~48k tokens re-sent every shared turn.
Turns start together, so one provider may answer some members with 429. pi-web doesn't stagger them.
```

- **Per member, against that model's own window.** The starting fill is the source's context at
  the fork point — `ContextInfo.tokens` for the branch (§4f) — and the denominator is the
  member's model window, not the source's. The same 48k is 4% of one window and 24% of another,
  and that difference is most of what the preview is for. The number formats and the 80% / 95%
  steps are §4f's, class for class (`.context-warn`, `.context-error`).
- **A member that cannot fit** takes `.context-error` and a line of its own: "This model's
  window is smaller than the fork." The row stays, the count stays, and **Create is disabled**
  with the reason in `.field-error` — over-window is not a warning to click through, it is a
  session that fails on its first turn.
- **Window unknown** shows tokens alone ("48k, window unknown") and no percent, no step, exactly
  as §4f's readout does. It never blocks Create: we don't know that it doesn't fit.
- **The shared-turn line** is `{n} members × ~{tokens} tokens re-sent every shared turn.` It is
  the running cost of the group composer (§14): one message you type, N contexts re-sent. `~`
  because the number is the fork-point fill, and it grows with every turn.
- **Fresh prompt has no fill**, so the per-model rows show `new session` instead of a fraction and
  the shared-turn line reads "5 members, each starting empty. Every shared turn is re-sent 5
  times as they grow."
- **The rate-limit line is always shown**, not just when it is likely. Members start their first
  turn at the same instant and go to the same provider; some of them will be refused with 429 and
  will say so in their own pane. We do not stagger the starts, and a preview that hid that would
  be promising an ordering we don't implement.

## What creation does

`POST /api/session-groups/fanout` — one request, one response, and the client navigates to the
new workspace.

- **Fork mode** branches from the source's **current leaf** with
  `SessionManager.createBranchedSession`, once per member, then opens each new file with its own
  `SessionManager.open`. `open()` mutates the manager it is called on, so it is **never** run
  against the runtime pi-web is holding for the source session — each member gets a fresh manager,
  and the source keeps its own, untouched. The source session is not modified, not rewound, and
  not made a member: it stays where it is, and `parentSession` in each member's header is the only
  link back.
- **Fresh mode** is N × `POST /api/sessions`' own path: create in the chosen folder, write the
  header immediately, hand the first message to each independently. No branch, no parent, no
  shared id.
- **Every member is assigned to the new group** in the same write that creates it, in the
  dialog's order (rows top to bottom, repeats in sequence), and `seed` set to
  `{parentSessionPath, leafId}` in fork mode. Fresh mode writes no `seed`: there is no fork point
  to align to.
- **Members run with the topic outline off.** The server passes the flag when it opens each
  runtime. The outline summarizer is a second model call per turn per session (§10), and N of them
  on a fanout is cost with no reader — the workspace is for reading the members against each
  other, and the strip is a single-session surface. It is off for the member's life, not just in
  the workspace, and the pane says so nowhere: an absent strip is not a state.
- **Partial creation is reported, never swallowed.** If member 4 of 5 fails, the group exists with
  4, the workspace opens, and a `.banner.banner-warn` sits above the panes: **"4 of 5 members were
  created."** {model} couldn't start: {server message}. The 4 that exist are running; add another
  from Add Members. · `Add Members` · `Dismiss`. Nothing is rolled back — three sessions that are
  already answering are not garbage to clean up.
- **Total failure** keeps the dialog open with a `.field-error` and no group is created.

## The fork point in a transcript

Every member of a `seed` group gets one row in its transcript, at the entry the fork was taken
from, immediately after it:

```html
<p class="info-row fork-marker">
  <span class="icon icon-sm" style="--icon: url(/icons/branch.svg)" aria-hidden="true"></span>
  <span class="info-row-text">Forked from <a href="#/s/…">Retry with jitter</a> here · 14:06</span>
</p>
```

- **It is a rendered marker, not an entry.** Nothing is written into the session file for it: the
  client draws it at `seed.leafId` on every member. A marker that needed a write would need the
  write guards, and the fact it states is already in the group registry.
- **Above it is shared, below it is this member's own.** That is the sentence the row exists to
  make legible; it is the reading aid the rejected prefix-collapse (§14) was trying to be, at the
  cost of one row instead of a fold.
- **The parent link** goes to the source session, which may be archived, renamed or gone. A
  source whose file is missing renders the title as plain text with `title` "This session is no
  longer on disk."
- **A member with no marker** — the leaf id isn't on its branch anymore, because the member was
  rewound past it (§13) — simply has no row. We never guess at a position. The same holds for a forked
  session in a hand-made group: `SessionSummary.parentId` proves the lineage, but nothing records
  the leaf, and a marker in the wrong place is a false claim about what is shared.

**`Align to Fork`** in the workspace head scrolls **every** pane, split or tabs, so its fork
marker sits at the top of the pane's scroll region, and announces "Aligned 5 members to the fork
point." A pane with no marker is left where it is and is named in the announcement: "Aligned 4
members. control has no fork point on its branch." The button is absent for a group with no
`seed`, because there is nothing to align to. It is a scroll, not a state: nothing is pinned
afterwards, and the next incoming token scrolls a followed pane as usual.

## States

| State | Shows |
|---|---|
| Dialog opened with no models yet | The Members list is one line of hint text, "No members yet. Add a model, then set how many of it you want." Create is `aria-disabled` with the reason "Add at least 1 member." |
| Source has no assistant reply | `Fan Out…` is not in the flyout. Nothing to fork, and a disabled row would invite a question with no answer |
| Source mid-turn | The dialog opens and says which leaf it will use: "The fork is taken from message 34, the last one finished. The turn running now isn't included." Creating mid-turn is allowed — the branch point is already written |
| Source is TUI-live | `Fan Out…` is absent. Forking reads the file, but the leaf pi-web can see is not the one the terminal is about to write, and a fork from a stale leaf is a silently wrong comparison |
| A model has no window on record | Its row shows tokens alone; Create stays available |
| A model's window is smaller than the fork | `.context-error` on the row plus its own line; Create disabled until the row is removed or the count is 0 |
| Creating | `Creating…`, the dialog stays up and its fields disable. No progress bar: N creations finish in one response |

## Classes

| Need | Classes |
|---|---|
| Dialog | `.modal.modal-wide.fanout` (+ the §5 modal, field, and folder-picker families) |
| Source | `.fanout-source` `.fanout-source-note` |
| Member rows | `ul.fanout-rows` `li.fanout-row` `.fanout-row-model` `.fanout-row-fill` `.fanout-count` `.fanout-add` |
| Preview | `.fanout-preview` `.fanout-preview-row` `.fanout-note` (+ `.context-warn` `.context-error` from §4f) |
| Fork marker | `.info-row.fork-marker` (+ `.info-row-text`) |
| Align | `.workspace-align` (§14) |

## Tokens

No new ones. `--fs-caption`, `--fs-mono`, `--color-ink-2`, `--color-ink-muted`, `--status-warn`,
`--status-error`, `--space-2`, `--space-3`, `--space-4` — the §4f readout's set, plus the modal's.

**All user-facing strings are in §9 · Copy deck.**

---
