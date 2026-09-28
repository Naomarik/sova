# §app/project-overseer — Project overseer
> Part of the Sova design spec · [overview](../design/overview.md)

Each project of an organization (§app/organizations) can have one **project overseer**: a special
session, like the Overseer (§app/overseer), that watches the project's decisions as people make
them in gathering sessions (§app/baton), infers what is still missing against the roster, and acts
on it at the autonomy level the operator grants: it starts gathering sessions, reconciles and
promotes decisions (§app/requirements), and starts ordinary coding sessions in the project. The
operator talks to it in the normal chat page under a head of its own (§app.project-overseer/page),
which is also its live view: its tool calls render as tool cards as they happen.

## §app.project-overseer/identity — One per project, in the workspace repo

- Created on the operator's first open (`POST /api/orgs/:id/projects/:pid/overseer`); `GET` answers
  `exists: false` until then. One current conversation per project; **Clear** (`POST …/overseer/clear`:
  its chat head's ⋯ Clear, or `/clear` typed in its composer, §app.project-overseer/page) starts a new
  one and keeps the previous ones (up to 20) as read-only history, opened from its chat head's
  History; older ones are archived (they stay in the workspace repo, like every workspace file).
  Settings, notes, ideas and to-dos stay.
- Its file lives in the org's workspace repo (`sessions/`), carries an invisible
  `sova-project-overseer` marker `{v:1, orgId, projectId}`, and its cwd is the **project root**.
  It is that project's overseer only when the marker is present, the file is in THAT org's
  workspace, and the project's `state.json` knows its id; a copy or a fork is an ordinary session.
  The session list marks it (`projectOverseer`, and `org`, §app.organizations/org-sessions); nothing (the Overseer's prompt route included)
  writes a message into it but the operator's own composer.
- Its state is in the workspace repo under `projects/<projectId>/overseer/`: `overseer.json`
  (autonomy, model, thinking, the coding sessions' model, thinking and mode, the limits, the pace,
  watch on/off, extra instructions; §app.project-overseer/limits), `state.json`,
  `notes.md`, `actions.jsonl` (every act, refused or not; an act that did only part of what was asked, a
  promotion with refusals, is logged `partial` with what was refused), `ideas/`, `todos.json`, `started.json`
  (the sessions it started; plus, as `operator-coding` rows that
  no cap counts, the ones the operator started with Start coding session; each coding row
  also names its worktree, §app.project-overseer/coding-worktrees); committed with the org's
  workspace commits (§app.organizations/workspace-repo). Only the counters (each message's and
  each day's) and the watch loop's timing and held items are host-local.
- **Loadout.** No pi-config extension, skill or prompt template loads (no mode; a mode switch is
  refused); the project's own context files do, and only those inside the project root: never the
  agent dir's or a folder's above the root (the home folder's `AGENTS.md`). Its tools
  (§app.project-overseer/tools) plus read-only `read`, `grep`, `find` and `ls` **confined to the
  project root**: every path, as written (`..`, `~`, absolute) and at its realpath (a symlink in the
  root that leads out), must be inside the root, and none may be inside an attached org's
  workspace (the roster's contacts, every project's transcripts) or pi's or Sova's state (the
  host's link store, every session), even when the root holds them. A path argument that fails is
  refused with the reason; a listing or search leaves such entries out; a secret file inside the
  root is still refused. No shell, no edit or write tool. Its prompt is Sova's
  (`server/project-overseer-prompt.md`), re-rendered at every run with the project, the level in
  force, the caps, the roster (name, role, decision areas; never contact details) and the project's main
  stakeholder ("Main stakeholder: {name}: decides every area of this project that no one else on
  the roster decides."), its ideas, the
  operator's open to-dos **in full** (oldest first, at most 20, each with its id and linked idea or
  session; the rest counted), its notes, the organization's About text (§app.organizations/about) and, last, the operator's extra instructions. Model and thinking from `overseer.json`, else the new-session
  defaults; the composer's picks are saved there.
- **Thinking levels a model doesn't offer.** A `PATCH …/overseer` naming a thinking level (its own,
  `codingThinking` or `gatheringThinking`) that the model it applies to doesn't offer is refused
  (400, "{model} offers thinking {levels}.") and writes nothing; the model it applies to is the
  pair's own model, else the overseer's, else the new-session default. A PATCH that changes only a
  model, leaving a saved level the new model lacks, moves that level to the one pi would run
  (pi's `clampThinkingLevel`: the nearest level the model offers above it, else the nearest below)
  and saves that, so `overseer.json` says what runs. A model Sova can't list
  is not judged.

## §app.project-overseer/page — Its chat page

The current conversation opens at `#/s/<path>` like any chat (the sidebar's eye on its project's
heading, §app.session-list/organizations, or the project page's Open Overseer, which carries the
same eye), but under a **head of
its own** in place of the session head, with its status in a short strip under it. A workspace pane
keeps the pane head. Everything else of the chat is unchanged: the thread is its live view, the
composer has no mode switch.

```html
<header class="session-head overseer-head po-head">
  <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">…</a>
  <div class="session-head-main">
    <h1 class="session-head-title">Overseer</h1>
    <p class="session-head-meta">
      <a href="#/orgs/<org>/projects/<pid>">Rakiba site</a> · Mamluk Arabia · Watching
      · <button …>3 started</button>   <!-- a menu of the sessions it started; omitted at 0 -->
    </p>
  </div>
  <span class="chip chip-accent"><i class="chip-dot live"></i>Working</span>   <!-- or the warn chip "L0 in force" -->
  …context gauge…
  <button class="button button-sm button-ghost po-level" aria-label="Level L1: Gather …. Change level">L1 ▾</button>
  <button class="button button-sm button-ghost po-run">Run Now</button>
  <button class="button button-icon button-ghost" aria-label="Overseer actions · Rakiba site">⋯</button>
  <button class="button button-icon button-ghost session-details-open" aria-label="Session details">ⓘ</button>
</header>
<section class="po-status" aria-label="Overseer status">
  <p>Last looked on its own 31m ago, after …. Waiting to look at 2 things.</p>   <!-- always -->
  <p>Today on its own: 2 of 6 gathering sessions.</p>                            <!-- only when used -->
  <p>Waiting until midnight: today's 6 gathering sessions are used.</p>          <!-- only when held -->
</section>
```

- **Line 1**: back to Sessions, the title **Overseer**, its state chip, the context gauge, the
  **level** button, **Run Now**, the **⋯** menu and Session details.
- **Meta line**: the project (a link to its page) · the org · "Watching" or "Not watching" · "{n}
  started", a menu of the sessions it started, newest first, each a link when its file is on this
  host, with its kind and state ("Gathering · open", "Coding · working"); omitted while it started
  none.
- **State chip**: **Working** (accent, the live dot) while its turn runs, whoever started it (the
  operator, a watch-loop look, Run Now); otherwise, while the **level in force** differs from the chosen
  one or an attach paused it (§app.project-overseer/autonomy-levels), a warn chip, dot and word, "L0 in
  force", its `title` the server's reason; otherwise none.
- **Level**: a menu button reading the chosen level ("L1"), named "Level {level}, {meaning}" (then
  " In force now: L0." while forced) and " Change level." Its rows are L0–L3, each with its meaning, the chosen one
  marked; picking one sets it (`PATCH …/overseer {autonomy}`), which also ends an attach's pause, and
  says "Level: {level}." Full settings (limits, models, coding mode, watch pace) stay on the project
  page (§app.project-overseer/limits).
- **Run Now** (`POST …/overseer/run`, §app.project-overseer/watch-loop): disabled while it works, with
  the reason "Working now"; done: "The overseer is looking now."; refused: the server's sentence.
- **⋯**: **Stop Watching** / **Start Watching** (`PATCH {watch}`: "Watching." / "Not watching."),
  **History…** (the earlier conversations, newest first, each its title — "No messages" for an
  untitled one — and its age, opening it; with none: "No earlier conversations yet."), **Clear**
  ("Start a new conversation. This one moves to History."), and **Project Page**. Below 480px the level
  and Run Now leave line 1 and are in ⋯ too (Run Now, and "Level…" with the same rows).
- **Status strip**, at most 3 lines, each only when it has something to say:
  1. **The last run**, in the project page's own words ("Last looked on its own {time}{how it went}."
     or "It hasn't looked on its own yet."), then "Waiting to look at {n} things." (1: "1 thing") while
     the watch loop has reasons waiting, the reasons in its `title`. **No time for the next look**: the
     loop's timing can't be promised from here. While the level in force is L0 by an attach, this line
     is the reason instead, with **Resume at {level}** (the chosen level; `PATCH {autonomy}`); forced by
     an empty roster, the reason alone.
  2. **Today's allowance used** (`allowanceLine`, §design.copy-deck/project-limits).
  3. **What waits** (`waitingLines`): the held items' sentences, joined.
  Below 480px only line 1 shows, with a **Details** toggle (`aria-expanded`) for the rest when there is any.
- **Reading its status**: `GET …/overseer` when the page opens, when its turn ends (the list's `busy`
  flips; a watch-loop run flips it too), and after each action — never on a timer: that read runs git
  on every coding worktree.
- **Clear**: ⋯ Clear and a bare `/clear` in its composer (the global Overseer's gesture,
  §app.overseer/identity-and-clear) both `POST …/overseer/clear` and open the new conversation in
  place of the old one, saying "Cleared. The previous conversation is in History."; nothing reaches the
  runtime, and a failed clear keeps the draft and says "Couldn't clear the overseer. {why}". Another
  tab that clears it moves this one to the new conversation too.
- **An earlier conversation** (a cleared one, opened from History) opens read only, under the head
  "Earlier Overseer Conversation", its meta "{title} · {age}", the back link going to the current
  conversation ("Back to the overseer"), and the read-only line "An earlier conversation. Read only."
  It has no level, Run Now, ⋯ or status strip.
- **Phone** (below 480px): line 1 keeps back, the title, the state chip, ⋯ and Session details; the
  meta line keeps only the project (the org and the watch word go; ⋯ says Stop or Start Watching),
  on a line of its own under line 1, lined up with the title, ending in "…" when it doesn't fit.

## §app.project-overseer/autonomy-levels — What it may do on its own

- Four levels, set per project (`PATCH …/overseer {autonomy}`), default **L1**:
  **L0 propose** (read, keep notes, file ideas, ask with a confirm card), **L1 gather** (+ start
  gathering sessions and offers, run the reconciler), **L2 reconcile** (+ promote drafted
  decisions, approve or decline referrals), **L3 build** (+ start and prompt coding sessions in the
  project, within its limits).
- The level in force is **L0 while the overseer is paused by an attach on this host**
  (§app.organizations/portability), until the operator sets its level here, and **L0 while the
  org's roster has no active person**, whatever the setting; the project page says why ("In force
  now: L0." and the reason, shown whenever it is paused, even with L0 chosen).
- The level binds only runs the operator did not start (a watch-loop look, Run Now). A message the
  operator sends from the UI makes that run theirs (decided by identity, as for the Overseer), and
  every tool may run in it, under the caps. Changing the operator's to-do list runs only in the
  operator's own turns.
- Enforced in the tools' wrapper at every call, never by the prompt: a tool above the level refuses
  with a sentence telling the model to file the gap as an idea or raise a confirm card instead, the
  refusal is logged, and nothing reaches the gathering, reconcile, promote or session code. A level
  change applies from the next tool call.
- **Limits** (§app.project-overseer/limits): what it may start or send per message the operator
  sends, per day on its own, and at once. Over a limit a tool refuses and takes nothing. There is
  no token or cost budget; what the project's sessions cost is shown to the operator only
  (§app/project-costs).

## §app.project-overseer/limits — Limits, per project

- **Two allowances.** *Each message you send* covers the turns the operator started: 3 gathering
  sessions or offers started, 20 decisions promoted, 2 coding sessions started, 5 prompts to them
  (`gatherPerTurn`, `promotePerTurn`, `createPerTurn`, `promptsPerTurn`); an operator message and
  Clear reset it. *On its own, each day* covers every run the operator did not start (a watch-loop
  look, Run Now): 6 gathering sessions or offers, 60 promotions, 4 coding sessions, 12 prompts
  (`gatherPerDay`, `promotePerDay`, `createPerDay`, `promptsPerDay`), reset at local midnight on
  this host. An operator message never refills what a run on its own may do, and a run on its own
  never uses the operator's message allowance. **Looks**: at most 12 unattended runs a day
  (`unattendedPerDay`).
- **At once**, for both kinds of turn: 5 of its gathering sessions open (0–20) and 2 of its coding
  sessions running (0–10).
- **No token budget.** The coding token budget is gone: nothing refuses on tokens or cost. A
  `tokenBudget` in an older `overseer.json` is ignored on read and dropped at the next save; a
  PATCH carrying one ignores it; a held `budget` item in the host-local watch memo is dropped on
  read, so no "Waiting for you" line outlives it. Past budget refusals stay in `actions.jsonl`.
  An older Sova on another host reads the missing key as its own default, stricter, never looser.
- **Unlimited** is `null` in `overseer.json` and in `PATCH …/overseer`: allowed for the eight
  allowances and the looks per day; **never for the two at-once limits**, which
  are what stop a burst ("Coding sessions running can't be Unlimited: it's what stops a burst.").
  Allowances are whole numbers from 0 to 1000. A PATCH with a
  bad value is refused (400) with the first problem as a sentence ("{Label} must be a whole number
  from 0 to 1000, or Unlimited.", "Coding sessions running must be a whole number from 0 to
  10.") and writes nothing. A hand-edited file is read tolerantly: a bad value falls back to its
  default, and an at-once value above its maximum is read as the maximum. An older Sova reads
  `null` as the default, so a project attached there is stricter, never looser.
- **Pace, per project**: it looks on its own at most every `watchGapMin` minutes (default 10; the
  page offers 2, 5, 10, 30 and 60; the server takes 1–1440), and after a reason to look soon at
  `soonLookSec` seconds (default 60; the page offers 30, 60, 120, 300 and Off; the server takes
  30–3600 or `null` = Off, when those reasons wait for the normal pace like any other).
- **Held, then retried.** A refusal for an allowance or the looks per day records a
  *held* item in the host-local watch memo (one per limit, at most 10) with a retry time: the next
  local midnight for a daily allowance or the looks; at once for the message allowance (a later
  look of its own may go on, at the normal pace, within today's allowance). Every tick, a held item whose time has come becomes a reason to
  look ("Today's allowance is back: it may start gathering sessions again (refused {time})."),
  soon (unless Off) except the message allowance's, which waits for the normal pace. A PATCH that
  raises a limit or sets it Unlimited releases its held items at once ("You raised the limit on
  {what}."). The at-once limits hold nothing: a gathering session finishing or closing, and a
  coding session finishing its turn, are already reasons to look.
- **Refusal wording.** A refusal has a sentence for the operator, logged in `actions.jsonl` and
  shown in the page's activity list, and a tail for the model only, never logged: a daily
  allowance, "Today's allowance is used: {n} of {max} {what} on its own. It looks again at
  midnight." + "Nothing starts before then. Tell the operator what is waiting; don't promise an
  earlier look."; the message allowance, "This message's allowance is used: {n} of {max} {what}
  per message you send." + "Stop here and tell the operator what is done and what is left, or ask
  with sova_confirm."; an at-once limit, "{n} of its gathering sessions are
  open, and the limit is {max} at once." (or coding sessions running) + "One finishing is a reason
  to look again; don't promise when." The prompt says never to promise a look "next time" unless
  a tool result says when it comes, and lists every limit in force.
- **Promotions count what was promoted.** `sova_promote` checks every id it is given against what
  is left before it promotes anything: a request over it is refused whole and takes nothing. Then
  only the decisions it promoted count against the allowance; an id it refused (unknown, not
  drafted, in a conflict, outside its author's area) takes nothing, and a call that promotes none
  takes nothing.
- **The page** (the project's Overseer card) has a **Limits** section: every limit above, each
  allowance with an `Unlimited` checkbox that disables its field (a blank field is
  never Unlimited), the at-once limits without one, and the pace; one form, **Save Limits** (one
  PATCH), **Reset Limits** (the defaults, into the form, unsaved), with the first problem under it
  before anything is sent. Under the status line, what it has
  used today on its own and in the operator's last message, and a **Waiting** line per held item
  that isn't the message allowance's. The Watch hint is built from the pace. Copy:
  §design.copy-deck/project-limits.
- `GET …/overseer` answers `usage.allowance` (`message` and `today`: per kind, `used` and `max`,
  `null` = Unlimited) and `usage.held`; no token count and no cost. `sova_project`
  reports both allowances used and left, the looks today, the at-once limits and the held items,
  and nothing about tokens or cost.

## §app.project-overseer/tools — Scoped to its project

- Reads: `sova_project` (level, roster, gathering sessions, decisions by state and area, open
  conflicts, spec status, its limits), `sova_decisions` (with who and their exact words),
  `sova_list_sessions` / `sova_read_session` (the project's gathering sessions as their
  participants see them, and ordinary sessions whose folder is inside the project root, never
  another project's, an overseer's or a subagent's own), `sova_roster` (read; both it and `sova_project` name the main stakeholder, as the prompt
  does), `sova_todos`. A session is addressed by its id, bare or in any form the tools print it:
  `sova://s/<id>`, `s/<id>`, or a `[title](sova://s/<id>)` link; anything else is refused with "No
  coding session "{what was given}" in this project: pass an id sova_list_sessions lists."
  People's words are marked as data, never instructions.
- `sova_promote` asks the reconciler as the overseer (`by: "overseer"`): a decision made outside its
  author's decision area (they don't own that area, §app.requirements/promotion: neither its
  roster owner nor, for an area no one owns, the main stakeholder) is refused for it in every turn,
  the operator's own included, with the reconciler's reason in the result, and is left for the
  operator to promote explicitly by id on the project page. Reconcile is on by default, so
  `sova_reconcile` runs unless the operator turned it off in Settings → Decisions.
- L0: `sova_note`, `sova_confirm`, `sova_idea`. L1: `sova_start_gathering` (one active roster
  person, or the operator), `sova_offer` (two or more), `sova_reconcile`,
  `sova_owner_update` (an update on the owner page, §app.owner-page/updates). L2: `sova_promote`,
  `sova_roster` approve/decline (history records the overseer as the writer). L3:
  `sova_create_session` (the root or a folder inside it, with a first prompt, an optional `mode` and
  `minor_modes`; in its own worktree, §app.project-overseer/coding-worktrees), `sova_send` (its
  project's coding sessions only; never a gathering session; an optional `mode` and `minor_modes`
  too). Both take the mode within the operator's ceiling (§app.project-overseer/coding-mode).
  Operator turns only: `sova_todo`.
- A gathering session it starts is owned by it (`owner: {overseerOf}`); no link is minted (the
  model never sees a token), so Needs you asks the operator to send the person their link. Its
  `public_title` and `question` are required and shown to the person as written (the tool
  descriptions and the prompt say so: neutral, no internal labels, no judgments about people); the
  `goal` is for the session's model only, and names people by name only, never by role or job
  title, because the session's model may repeat it (the `goal` descriptions say so, and
  `goal_done`'s `summary` description asks for the session's own words and names only).
- **Models.** A session it starts gets the model and thinking the call names, else the project's
  `codingModel`/`codingThinking` (coding sessions) or `gatheringModel`/`gatheringThinking`
  (gathering sessions and offers, Send to person… included, and every conflict's settle session,
  §app.requirements/routing: the model the person talks to), else the
  overseer's own setting, else what its runtime runs, and only then the new-session default.
  A coding session gets its model and thinking when it is created: its file never records a switch
  from the new-session default first.
  A coding session's mode is never one of these defaults: it is the project's coding mode
  (§app.project-overseer/coding-mode).

## §app.project-overseer/coding-mode — The mode its coding sessions run in

- **The setting.** `overseer.json` `codingMode` is `{mode, minorModes}` (`mode` `normal` or
  `delegate`, `minorModes` `[]` or `["spec"]`), or `null`: **Automatic**. Set on the project page
  (`PATCH …/overseer {codingMode}`); an unknown name or `align` refuses the patch (400), and a
  file with a bad value reads as Automatic.
- **Automatic** is `normal`, with `spec` on when `<project root>/.sova/spec/manifest.json` exists
  when the session starts, and no minor modes otherwise. It never gives `delegate` or `align`, and
  it never reads the host's default mode (`mode.json`). `GET …/overseer` answers what a session
  started now would get (`codingModeNow`).
- **Every coding session the project starts gets it**: the overseer's `sova_create_session` and the
  operator's Start coding session alike. The mode is applied, and written into the session file as
  its `mode` entry (§chat/mode-menu), before the first prompt, even when it equals the host's
  default, so the session's first turn runs in it and a later change to `mode.json` never moves
  it. A mode that can't be applied (the session is held elsewhere, the mode extension is missing)
  sends no prompt: the session stays, listed and counted, and the tool result (or the page's
  error) says "Started, but not prompted: its mode could not be set." Start coding session has no
  mode picker; the chat's own mode menu can switch it afterwards, like any chat.
- **The overseer's `mode` and `minor_modes`**, on `sova_create_session` and on `sova_send`, change
  the project's mode for that one session, within a ceiling only the operator's setting raises:
  - `delegate` only when `codingMode.mode` is `delegate`: "Delegate is off for this project's coding
    sessions; the operator can allow it on the project page." Automatic never allows it.
  - `align` never: "Align needs someone to answer its questions, and nobody answers a coding
    session's."
  - `spec` may be turned on; it may not be turned off while the project's mode (or Automatic)
    has it on: "Spec is on for this project's coding sessions; only the operator can turn it off
    on the project page."
  - `normal` always.
  An unknown name refuses too. Each refusal happens before anything else: no session is created,
  nothing is sent, and no cap or counter is taken, attended or not.
- **`sova_send` with a mode** sets it on that session first, then sends the text. Mid-turn, the mode
  applies from the session's next turn, and the result says so. A terminal-owned session is
  refused, as today.
- `strict` is never set or offered; a session keeps the strict flag it started with.
- A gathering session is unchanged: it loads no extensions, so it has no mode (§app/baton).

## §app.project-overseer/coding-worktrees — Each coding session in its own worktree

- **Always, in a Git project.** Every coding session the project starts (the overseer's
  `sova_create_session` or the operator's Start coding session) runs in a new git worktree on a
  new branch, cut from the commit the project root's checkout has checked out (`HEAD`), whose
  branch is the one it merges back into. The project root's checkout is never switched, and the
  session's cwd is the worktree (or, for a folder inside the root, the same folder inside the
  worktree).
- **Told to commit.** Such a session's first prompt ends with a paragraph Sova adds: "You work in
  your own git worktree on the branch {branch}. Commit your work on this branch before you end
  your turn: uncommitted changes can't be merged. Before you end your turn, also merge {target}
  into your branch and resolve any conflicts." A session run in the project root (no worktree)
  gets no such paragraph.
- **Names.** Branch `sova/<name>`, worktree `<parent of the repo's top level>/.worktrees/<repo
  folder name>-<name>`, outside the project root, as the `worktree` tool places its own
  (§chat.worktrees/tool). `<name>` is a slug of the session's title (the item's title, or the
  call's `title`, else the first prompt's first words; lower case, letters, digits and hyphens, at
  most 40 characters) and 6 random hex digits (`sova/payroll-export-3f9a1c`), so two hosts sharing
  the client repo never pick the same branch. The `sova/` prefix tells Sova's branches from the
  owner's.
- **Where it can't.** A project root that isn't inside a Git work tree, a repository with no commit
  yet, or a root checkout on a detached `HEAD` runs the session in the project root, as before.
  The page says why above the list ("Coding sessions run in the project root: it isn't a Git
  repository." / "…: the repository has no commits yet." / "…: its checkout is on a detached
  HEAD."), and so does each such session's row ("In the project root: …"). A worktree that
  can't be made in a Git project (git refuses) starts no session: "No session was started: its
  worktree could not be made ({git's first line}).".
- **Recorded with the session.** The session's `started.json` row (kind `coding` or
  `operator-coding`) carries `worktree: {branch, base, target, path}` (`base` the commit it was
  cut from, `target` the branch it merges into) and its later `merged: {at, commit}` (the last
  Merge Branch: history, not the branch's state) or `removed: at`, or `inRoot` (the reason it runs
  in the root). A worktree folder deleted by hand shows as missing ("Worktree folder missing");
  its branch can still be merged. The tool result and the Start coding session answer name the branch and the path.
  `path` is this host's, like the row's session path: on a host where it doesn't exist the row
  shows the branch only, and no gesture acts on it ("On another host: its worktree is there.").
  Each row records a title when its session starts (the title given, else the first prompt's
  first line); the list shows a title given on this host first (a rename), else that one. A row
  whose session is not on this host is on another host, whatever its worktree path: it shows that
  title, not as a link, and "On another host: its worktree is there.", never "Worktree folder
  missing".
- **The project page lists them.** "Coding sessions" lists every coding session the project started
  (the overseer's and the operator's), newest first: title (a link on this host), who started it,
  state, and its branch in mono, then **Merge Branch** and **Remove Worktree**; "Sessions it
  started" keeps its gathering sessions and offers. Copy: §design.copy-deck/project-coding.
- **Merge Branch** is the operator's gesture; the overseer has no tool for it. It merges
  `sova/<name>` into `target` in the project root's checkout, which must have `target` checked
  out, no tracked changes and no merge, rebase or cherry-pick in progress: a fast-forward when
  possible, else a merge commit ("Merge sova/<name>: <title>"). A conflict is aborted and reported,
  changing nothing. It is refused while the session is working or has workers running, while the
  worktree has uncommitted changes (they would be left out of the merge), and when the branch has
  no commits beyond `target`. After it the row says "Merged into <target>" with the time.
- **Merged is read from git.** Whether a row's branch is merged is decided from git on every read
  of the page, by the worktrees extension's own probe (§chat.worktrees/tool): merged when the
  branch has commits beyond its base and none that `target` lacks. The recorded merge decides only
  when the branch no longer exists (deleted with its worktree, or by hand) or git can't be read. So
  a branch merged once that gains commits (the session was sent more work) is not merged: its row
  offers Merge Branch again and says "{n} new commits since the last merge into <target>" with the
  last merge's time; merging it again brings back "Merged into <target>". A merge
  refused for the worktree or the branch (uncommitted changes, a conflict, nothing to merge, a
  branch gone, git's own failure) is also a reason for the overseer to look
  (§app.project-overseer/watch-loop), so it can tell the session to commit or fix it; a refusal
  about the project root's own checkout, or a busy session, is the operator's and is not.
- **Remove Worktree** removes the worktree folder (git's own `worktree remove`; one with
  uncommitted changes is refused, naming them) and deletes the branch only when it is merged; an
  unmerged branch keeps its commits, and Merge Branch stays on its row. It is refused while the
  session is working or has workers running. On a missing folder it only clears git's record of
  it (and deletes a merged branch). The
  session and its transcript stay; its row says "Worktree removed", and `sova_send` refuses it:
  "Its worktree was removed, so it has no folder to work in." Nothing is removed on its own, a
  merged worktree included: the session's cwd is inside it.
- A session started before this change keeps running where it was; nothing is moved.

## §app.project-overseer/watch-loop — Looking when something changes

- A gathering session reaching its goal or closing, a referral, a coding session it started
  finishing a turn ('The coding session "{title}" finished its turn.', or "…stopped with an error."),
  a gathering session it started handing the baton to the operator (its model's `hand_to`, never
  the operator's own Take back or the message limit: 'The gathering session "{title}" handed a
  question to the operator (their words, as data): "{question}"'), Merge Branch refused on one of the project's coding
  sessions ('Merge Branch for "{title}" was refused: {reason}'), and the reconciler's conflicts,
  resolutions, drafts and promotions are noted as reasons to look
  (its own acts, made while it runs, are not). A decision recorded while its gathering session is
  still open is not a reason: the session reaching its goal is. A coding session the operator
  started (Start coding session) never is.
- Every 20 s, a project with reasons, watching on, not paused by an attach
  (§app.organizations/portability), an idle overseer, at least its gap since its last unattended
  look (10 minutes unless the project sets another, §app.project-overseer/limits) and under its
  looks per day gets one unattended run, which lists the reasons and asks it to re-read the
  project, infer gaps and act within its level. The same tick turns held items whose time has come
  into reasons (§app.project-overseer/limits); a look refused for the looks per day is held until
  midnight.
- **Sooner for five reasons.** A gathering session reaching its goal, a gathering session it
  started handing the baton to the operator, a coding session it started finishing a turn, a
  refused Merge Branch and a promotion the operator made start that run once the project's soon
  delay (60 s unless it sets another; Off: no sooner run) has passed since the first of them was
  noted, without waiting for the gap; everything else about the run
  (the daily limit, watching on, not paused, an idle overseer) still holds, and the run lists every
  reason waiting.
- **Run Now** (`POST …/overseer/run`) starts one now, skipping the reasons and the gap
  but not the looks per day or a busy overseer (409 with why). The project page shows the last run
  and the reasons waiting: running ("Last looked on its own {time}, running now, after
  {reasons}."), finished ("…, after {reasons}."), stopped and why ("…, stopped: {why}.": the stream
  guard's trip, the model's error, or "Stopped" for an abort), cut off by a restart ("…, cut off by
  a restart.": the server stopped during the run, recorded when it next starts) or skipped and why
  ("…, skipped: {why}."), then "{n} run(s) today." — one period at the end of each
  sentence, whatever the reason's own text ends with (`lastRunTail`, `src/lib/project-overseer-view.ts`).
  In "after {reasons}" each reason continues the sentence (its capitalised first word in lower
  case). "Waiting to look at:" then lists the waiting reasons as sentences, each ending in exactly
  one stop (`pendingLine`), never joined with commas under an added period.
- An unattended run's message says how many of the operator's to-dos are open and that they are
  listed in full in its prompt, to work on too.

## §app.project-overseer/gaps — Gaps against the roster

- A gap is a decision the project needs that nobody has made. It files each as an idea with id
  `§gap/<name>`, the tag `gap` (always added) and `area-<areaKey>` when known, and names in its text
  who should answer: the roster person whose decision areas cover it, else the project's main
  stakeholder, else the operator. At L1+ it may start a gathering session with that person.

## §app.project-overseer/ideas-and-todos — The operator's items

- Ideas (the overseer's and the operator's, `POST …/overseer/ideas`) and to-dos use the Overseer's
  stores and shapes at the project's paths, so the same panels show them. The project page adds
  either from its list: **Add Item** (a to-do) and **Add Idea** (a title; its id is
  `§idea/<the title's words>`, numbered when taken).
- An idea or a to-do the operator adds is a reason to look ("The operator added an idea." / "The
  operator queued a to-do item."), so the next unattended look comes for it; the item itself
  reaches the model through its prompt.
- Each item offers **Send to person…** (`POST …/overseer/items/send`): a gathering session owned by
  the operator (one person, the operator, or an offer to several), with the public title and first
  question the operator writes (both required, 400 without them, and never taken from the item: they
  are shown to the person as written) and the item as its goal; its links are shown once; and **Start coding session** (`…/items/code`): an ordinary session in the
  project, in its own worktree (§app.project-overseer/coding-worktrees) and the project's coding
  mode (§app.project-overseer/coding-mode), with the item as its first prompt. Either links the item to the session it started.
