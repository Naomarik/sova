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
  member's model window, not the source's. That denominator is **`ModelInfo.contextWindow` from
  `GET /api/models`**, **absent** when no catalog knows the model — the field is optional, the
  same convention `ContextInfo.window` states, and an older server that never sends it looks the
  same as a newer one that doesn't know this model. Both render as tokens alone. It has to come from the models
  list because the client is asking about models no session here has ever run: `ContextInfo.window`
  only ever describes a session's *current* model, so it can say nothing about a candidate. Without
  a per-model window the preview loses the one comparison it exists to make — that the same 48k is
  4% of one window and 24% of another — and degrades to a column of identical token counts. The same 48k is 4% of one window and 24% of another,
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
  turn as close to together as the server can accept them, and they go to the same provider; some
  will be refused with 429 and will say so in their own pane. We do not stagger the starts on
  purpose, and a preview that hid that would be promising an ordering we don't implement.
  "As close to together as the server can accept them" is the honest form, and it carries a
  requirement: **the acceptance phase is concurrent, not a loop.** Accepting members one after
  another means the batch costs the *sum* of N runtime opens — seconds, on cold members — before
  the composer clears, and it staggers the starts by that same sum. Neither is a rate-limit
  warning's problem; both are the user's.

## The route

One request, one response, and the client navigates to the new workspace. Nothing here is a
second round trip: the group, its members and their assignments are one write, because a fanout
that half-exists is a sidebar section the user has to clean up.

```ts
POST /api/session-groups/fanout
{
  name?: string;                              // new group's name, 1–60 (GROUP_NAME_MAX); XOR groupId
  members: { ref: string; count: number }[];  // `ref` is ModelInfo.ref ("provider/id"); count 1–9.
                                              // Array order is pane order; repeats are the count.
  source?: { path: string; leafId: string };  // fork mode
  cwd?: string;                               // fresh mode
  text?: string;                              // fresh mode: the first message every member gets
}
-> 201 { group: SessionGroup; created: SessionSummary[]; failed: BatchRefusal[] }
```

- **`groupId` (optional) fans out INTO an existing group** instead of making one. It is what
  the workspace's `Add Members → Fan Out…` sends. **Exactly one of `name` and `groupId`**, the
  same shape as `source` XOR `cwd` above: `name` alone creates a group and pi-web owns it
  (`autoDissolve` set); `groupId` alone lands in that group, which keeps its own name; **both or
  neither is a `400`**. Both is not a harmless over-send — a client that supplies a name
  alongside a group id has asked for a rename, and accepting it silently would do nothing while
  looking like it worked. Ignoring a field the client sent is the failure this feature has spent
  its whole length refusing. Three cases, decided by the seed:
  - **The group has no `seed`** (hand-made, or a fresh-mode fanout): it **adopts** this fork's
    seed, and its existing members simply have no marker — which §14b already renders as no row
    rather than a guess. Adoption is **pure lineage**: the group gains fork markers and changes
    in no other way. In particular it does not become auto-dissolving — that turns on whether
    pi-web named the group, not on whether it has a seed (§14 "Emptying a group") — so a
    hand-made group fanned into is still the user's, and the dialog says nothing about it
    because nothing happened worth saying.
  - **The group's `seed` matches this fork** (same `parentSessionPath` and `leafId`): the new
    members are **appended**. This is the case that makes "I want two more of these" work.
  - **The group's `seed` differs**: `400 seed-conflict`. **One group carries one seed**, because
    the fork marker and `Align to Fork` read exactly one leaf; a group holding two lineages would
    have to either mark members against a point they never diverged at, or pick one lineage and
    silently un-mark the rest. Both fabricate a fact the contract cannot carry — the same reason
    a marker's position is never inferred from `parent`/`parentId`. Fan out into a new group
    instead; the two groups can sit side by side.
- **`source` and `cwd` are exclusive**, and exactly one is required: a request with both, or
  neither, is a `400`. There is no third mode, and a fanout with no starting point is not a
  thing the dialog can produce.
- **The client sends the leaf it showed the user.** `source.leafId` is the entry the dialog named
  ("up to message 34"), not a request for the server to find the current one.
- **"The leaf" means the last entry pi-web would render ON THE ACTIVE BRANCH** — the branch the
  transcript is showing, which after a rewind is **not** the file's tail. Both halves are load
  bearing, and the branch half is the one a fanout meets most: you rewind to the point you want
  to branch at, then fork, so a rewound source is the *likely* source rather than an exotic one.
  After a rewind the file holds `[… u1, a1, marker]` with the marker parented on `u1` (the
  rewind target), so the active branch ends at `u1` while the file ends at `a1` — an entry the
  transcript is no longer showing. Reading the file backwards finds `a1`; the user was shown
  `u1`. The branch has to be walked by `parentId` from the file's last entry, the same rule
  `activeBranch` already applies, and a tail window cannot stand in for it: after a rewind the
  chain leaves the window immediately. **Named, so it cannot be paraphrased into a tail walk:**
  `readActiveBranch(path)` (`server/transcript.ts:349`, which is `activeBranch` at `:35` over the
  parsed file), then the last entry on it with `normalizeEntry(entry).length > 0`. Both halves
  are required and neither substitutes for the other — the filter alone returns the abandoned
  branch's last *visible* message, which is an ordinary reply and passes any hidden-entry test.
- **The rendered half, separately.** Even on a session nobody has rewound, the last *line* and
  the last *rendered* entry are routinely different, and comparing against the raw last line
  turns this check into a false refusal. The transcript hides several entry kinds — top-level `usage` rows (cache warming
  writes them and is **on by default**, so a source can easily end with one), `message` entries
  with `role:"system"`, and pi-web's own invisible `pi-web-rewind` marker, which by construction
  is the last line of every rewound session. In each case the file's last line carries an id the
  dialog never displayed and the user never saw, so a raw comparison refuses a fork that is
  perfectly current. The failure is worse than a spurious error: `stale-leaf`'s copy tells the
  user to reopen and fork from the new last message, and reopening shows them the same last
  message it showed before. An instruction that cannot be followed is the one thing a refusal
  must never be. If it no longer is
  the source's leaf, the server refuses. The other refusals make this nearly unreachable — the
  leaf can only move if something wrote, and every writer is already grounds to refuse — but
  "nearly" is doing real work: a turn can start and finish between the dialog opening and Create.
  Forking from a point the user didn't approve would break the fork marker's only promise, which
  is that everything above it is what they saw shared.
- **A member that was never created is named by `ref`, not by `id` or `path`.** `BatchRefusal`
  carries an optional `ref` (`ModelInfo.ref`) used **only** on this route: a member whose
  creation failed has no session, so `id` and `path` are both empty and the model is the only
  handle on it. The partial-creation banner composes from it — `{shortModel(ref)} couldn't
  start: {message}` — so the words stay pi-web's and the client never parses prose to find a
  model name. Consequently `message` here is the **reason alone**, never prefixed with the ref;
  prefixing would render the model twice. It is still never empty, and it is §9's verbatim case:
  the server's own reason, which pi-web has no word for.
- **Two different empty ids on this route, and they are not the same case.** A **refusal**
  (`409`) names the *source*, which is a member of nothing — `ref` is absent there. A **failure**
  inside a `201`'s `failed` names a member that never came into being — `ref` is present there.
  Neither carries an id, for different reasons, and nothing should build a lookup on either.
- **The refusal's `id` is empty here, and that is correct.** `BatchRefusal.id` exists to join
  against `GroupMember.id` and the assignments; a fanout's single refusal names the **source**,
  which is not a member of anything — the group does not exist yet. So the field has nothing to
  carry, the client renders from `code` plus the source's own title, and **nothing should build
  a lookup on it**. Written down because an empty string in a required field reads as a bug to
  the next person who meets it.
- **Refusals reuse the batch vocabulary**: `409 {refused: [BatchRefusal]}` with exactly one
  entry, the source, so the client renders it with the same code-to-sentence table the group
  composer uses (§14). The codes are the source states above — `tui-live`, `mid-turn`, `busy`
  (an unidentified recent writer), plus two this route adds: **`old-format`** for a source whose
  header version isn't current, and **`stale-leaf`** for the check above. A source path that
  doesn't resolve to a session at all is a `404`, not a refusal: the subject of the request
  doesn't exist, which is a different kind of wrong from "exists but not right now".
- **`400`** for both or neither of `name` and `groupId`, a bad name, an empty `members`, a
  `count` outside 1–9, a `ref` no provider knows,
  blank `text` in fresh mode, or `text`/`cwd` sent in fork mode.
- **`201`, and `created` is never empty.** If not one member could be made, nothing is created,
  the group is not written, and the response is the failure — a group with no members is not a
  result, it is debris. `failed` carries the members that couldn't start, in the batch's own
  refusal shape, and drives the partial-creation banner below.

## What creation does

- **Fork mode takes one fresh manager per member, and the source's own manager is never handed
  to any of them.** `createBranchedSession(leafId)` is not a factory: it **rebinds the manager it
  is called on** to the new file (`session-manager.js:1180-1184` sets `fileEntries`, `sessionId`
  and `sessionFile`). Two things follow, and both are invariants, not implementation notes:
  - **Called N times on one manager it makes a chain, not a fan.** Call 2 would branch from
    member 1, call 3 from member 2, and every member after the first would carry the previous
    one's history. Each member is branched on its own manager, sourced from the source file.
  - **It is never called on the manager pi-web holds for the source.** That call would silently
    repoint the live source runtime at a member's file, and the source's next persist would write
    the turn the user is sitting in into a member's transcript. This is a stronger rule than the
    one `open()` needs, and it binds the common case: the flyout fans out from a session pi-web
    is holding a runtime for.
- **The source file is read, never written, and only while nobody is writing it.** Sourcing N
  managers means reading that file N times, and the read is not itself free of side effects
  (`open()` appends a newline to a trailing partial line and may rewrite the file on a version
  migration). So fanout needs a quiet source: not TUI-live, not mid-turn here, and not inside the
  recent-write window an unidentified writer leaves (`RECENT_WRITE_MS`, `server/write-guard.ts`) —
  and **not written in an older session format**, because reading one migrates it, and a
  whole-file rewrite under a runtime we hold is the foreign write that locks the user out of
  their own session. Each of the four has its own words in States below, and none of them is a
  silent failure.
  **The checks that establish it add no synchronous fs call to the event loop**: a source's path
  is validated by shape alone (`sessionPathShape`, no syscalls) and its existence by one async
  stat on a local JSONL under the sessions directory. Nothing in this feature ever stats a
  session's `cwd`, which for a mounted target is a fuse path that can hang the whole server.
  **The cheap check is for looking, not for opening.** Shape validation contains by string, which
  a symlink inside the sessions directory can walk out of; fanout then *opens* the source file, so
  the path it opens is resolved the full way (`resolveSessionPath`) exactly as every other route
  that opens a session does. The two are not interchangeable: one decides what to report, the
  other decides what to read.
- **The source is not a member.** It is not modified, not rewound and not assigned to the group:
  it stays where it is, and `parentSession` in each member's header — the source's path, written
  by the SDK — is the only link back.
- **Fresh mode** is N × `POST /api/sessions`' own path: create in the chosen folder, write the
  header immediately, hand the first message to each independently. No branch, no parent, no
  shared id.
- **Every member is assigned to the new group** in the same write that creates it, in the
  dialog's order (rows top to bottom, repeats in sequence), and `seed` set to
  `{parentSessionPath, leafId}` in fork mode. Fresh mode writes no `seed`: there is no fork point
  to align to.
- **Members run with the topic outline off, by omission.** There is no disable flag to add, and
  none should be invented: the outline extension only summarizes in the TUI unless its host opts
  in, and a web chat gets one because `chat-manager` sets `topic-outline-headless: true` when it
  opens the runtime (`server/chat-manager.ts:876`). A fanout member is opened **without** that
  flag, so it lands in the extension's own default. The outline summarizer is a second model call per turn per session (§10), and N of them
  on a fanout is cost with no reader — the workspace is for reading the members against each
  other, and the strip is a single-session surface. It is off for the member's life, not just in
  the workspace, and the pane says so nowhere: an absent strip is not a state.
- **`failed` is a list, and the banner reads like one.** A fanout of `opus ×3, glm ×2` can fail
  two or three ways at once, so the banner takes the same shape the group composer's refusal
  already uses — the count, then one line per failure naming its model and its reason. Two
  banners side by side in different grammars would read as an oversight rather than a
  distinction. Repeats that failed identically collapse with a count (`2 × claude-opus-5`); the
  same model failing two ways gets two lines, because the reasons are the information.
  **No member numbers.** `failed` carries no index into the plan, so which repeat of `opus ×3`
  failed is not knowable here — and `claude-opus-5 #2` would be a guess dressed as a fact.
- **Partial creation is reported, never swallowed.** If member 4 of 5 fails, the group exists with
  4, the workspace opens, and a `.banner.banner-warn` sits above the panes: **"4 of 5 members were
  created."** {model} couldn't start: {server message}. The 4 that exist are running; add another
  from Add Members. · `Add Members` · `Dismiss`. **No member that exists is rolled back** — three
  sessions that are already answering are not garbage to clean up, and unmaking one would throw
  away work the user can already read. What *is* cleaned up is the failed member's own debris:
  a creation that died part-way through leaves half-written files of its own, and those are
  unlinked, because a header with no session behind it is a row in the sidebar that opens onto
  nothing. The line is between *a member* and *the wreckage of one that never became a member*.
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

- **One leaf id locates the row in every member**, because branching **copies entries with their
  ids intact** — it re-parents the chain (`{...entry, parentId}`, `session-manager.js:1136-1141`)
  but never re-mints an id. So the entry `seed.leafId` names exists, with that id, in the source
  and in all N members, and `TranscriptItem.id` is what the client matches on. The whole marker
  rests on this; if branching ever re-minted ids, `seed.leafId` would be meaningless everywhere
  except the source, and the symptom would be markers silently vanishing rather than an error.
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
`seed`, because there is nothing to align to — and **present for one that adopted a seed later**
(`groupId`, above), which is the one visible trace adoption leaves. A hand-made group that has
been fanned into gains fork markers on the new members and this button; it keeps its name, its
members and everything else. That is the whole of what adoption does, and it is why the dialog
says nothing: the change is an added capability, not a changed rule. It is a scroll, not a state: nothing is pinned
afterwards, and the next incoming token scrolls a followed pane as usual.

## States

| State | Shows |
|---|---|
| Dialog opened with no models yet | The Members list is one line of hint text, "No members yet. Add a model, then set how many of it you want." Create is `aria-disabled` with the reason "Add at least 1 member." |
| Source has no assistant reply | `Fan Out…` is not in the flyout. Nothing to fork, and a disabled row would invite a question with no answer |
| Source mid-turn | The dialog **opens and is fully usable** — pick models, set counts, name the group — and Create is `aria-disabled` with the reason "“{title}” is mid-turn. We read the file to fork it, and we don't read it while it's being written. This enables itself when the turn finishes." It does enable itself, in place, with no re-open: setting a fanout up during the turn you are waiting on is the natural thing to do |
| Source has an unidentified writer | The same shape, reason "Another program wrote to “{title}” a moment ago. Forking waits until it stops." The same window `/ws/chat` refuses on (`RECENT_WRITE_MS`), for the same reason: we don't read a file mid-write |
| Source is in an older session format | Create is `aria-disabled`, reason "“{title}” is in an older session format. Forking reads the file, and reading it rewrites the whole thing — not something to do to a session that's open. Open it for chat here once to update it, then fan out." The header's `version` is already read to list the session, so this costs nothing to check and it is the one refusal the user can clear themselves in one gesture |
| The fork point moved while the dialog was open | Create is `aria-disabled`, reason "“{title}” answered while this dialog was open, so the fork point you picked isn't its latest message anymore. Reopen Fan out to fork from where it is now." The server refuses it too (`stale-leaf`), so a client that missed the change still can't fork from a point the user never saw |
| Source is TUI-live | `Fan Out…` is absent. Two reasons, either sufficient: pi-web never touches a file a terminal owns, and the leaf pi-web can see is not the one the terminal is about to write, so the fork would be from a stale point — a silently wrong comparison |
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
