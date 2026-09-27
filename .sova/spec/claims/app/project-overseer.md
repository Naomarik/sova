# §app/project-overseer — Project overseer
> Part of the Sova design spec · [overview](../design/overview.md)

Each project of an organization (§app/organizations) can have one **project overseer**: a special
session, like the Overseer (§app/overseer), that watches the project's decisions as people make
them in gathering sessions (§app/baton), infers what is still missing against the roster, and acts
on it at the autonomy level the operator grants: it starts gathering sessions, reconciles and
promotes decisions (§app/requirements), and starts ordinary coding sessions in the project. The
operator talks to it in the normal chat page, which is also its live view: its tool calls render as
tool cards as they happen.

## §app.project-overseer/identity — One per project, in the workspace repo

- Created on the operator's first open (`POST /api/orgs/:id/projects/:pid/overseer`); `GET` answers
  `exists: false` until then. One current conversation per project; **Clear** starts a new one and
  keeps the previous ones (up to 20) as read-only history; older ones are archived (they stay in
  the workspace repo, like every workspace file). Settings, notes, ideas and to-dos stay.
- Its file lives in the org's workspace repo (`sessions/`), carries an invisible
  `sova-project-overseer` marker `{v:1, orgId, projectId}`, and its cwd is the **project root**.
  It is that project's overseer only when the marker is present, the file is in THAT org's
  workspace, and the project's `state.json` knows its id; a copy or a fork is an ordinary session.
  The session list marks it (`projectOverseer`, and `org`, §app.organizations/org-sessions); nothing (the Overseer's prompt route included)
  writes a message into it but the operator's own composer.
- Its state is in the workspace repo under `projects/<projectId>/overseer/`: `overseer.json`
  (autonomy, model, thinking, the coding sessions' model, thinking and mode, caps, token budget,
  watch on/off, extra instructions), `state.json`,
  `notes.md`, `actions.jsonl` (every act, refused or not; an act that did only part of what was asked, a
  promotion with refusals, is logged `partial` with what was refused), `ideas/`, `todos.json`, `started.json`
  (the sessions it started, and what its coding sessions spent; plus, as `operator-coding` rows that
  no cap or budget counts, the ones the operator started with Start coding session; each coding row
  also names its worktree, §app.project-overseer/coding-worktrees); committed with the org's
  workspace commits (§app.organizations/workspace-repo). Only the per-turn counters and the watch
  loop's timing are host-local.
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
  session; the rest counted), its notes and the operator's extra instructions. Model and thinking from `overseer.json`, else the new-session
  defaults; the composer's picks are saved there.
- **Thinking levels a model doesn't offer.** A `PATCH …/overseer` naming a thinking level (its own,
  `codingThinking` or `gatheringThinking`) that the model it applies to doesn't offer is refused
  (400, "{model} offers thinking {levels}.") and writes nothing; the model it applies to is the
  pair's own model, else the overseer's, else the new-session default. A PATCH that changes only a
  model, leaving a saved level the new model lacks, moves that level to the one pi would run
  (pi's `clampThinkingLevel`: the nearest level the model offers above it, else the nearest below)
  and saves that, so `overseer.json` says what runs. A model Sova can't list
  is not judged.

## §app.project-overseer/autonomy-levels — What it may do on its own

- Four levels, set per project (`PATCH …/overseer {autonomy}`), default **L1**:
  **L0 propose** (read, keep notes, file ideas, ask with a confirm card), **L1 gather** (+ start
  gathering sessions and offers, run the reconciler), **L2 reconcile** (+ promote drafted
  decisions, approve or decline referrals), **L3 build** (+ start and prompt coding sessions in the
  project, within the token budget).
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
- **Caps**, per operator message (the watch loop's runs share the last one's): 3 gathering
  sessions or offers started, 20 decisions promoted, 2 coding sessions started, 5 prompts to them;
  at once, 5 of its gathering sessions open and 2 of its coding sessions running; a **token budget**
  (default 2,000,000) over everything its coding sessions have spent, counted from their files,
  **their workers included** (every worker and team member a coding session started, pi or Claude
  Code, at its lifetime total), after which starting or prompting one refuses; at most 12 unattended runs a day. Over a cap a
  tool refuses and takes nothing.

## §app.project-overseer/tools — Scoped to its project

- Reads: `sova_project` (level, roster, gathering sessions, decisions by state and area, open
  conflicts, spec status, its budget), `sova_decisions` (with who and their exact words),
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
  person, or the operator), `sova_offer` (two or more), `sova_reconcile`. L2: `sova_promote`,
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
  nothing is sent, and no cap, counter or budget is taken, attended or not.
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
  cut from, `target` the branch it merges into) and its later `merged: {at, commit}` or
  `removed: at`, or `inRoot` (the reason it runs in the root). A worktree folder deleted by hand shows as missing ("Worktree folder missing");
  its branch can still be merged. The tool result and the Start coding session answer name the branch and the path.
  `path` is this host's, like the row's session path: on a host where it doesn't exist the row
  shows the branch only, and no gesture acts on it ("On another host: its worktree is there.").
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
  and the reconciler's conflicts, resolutions, drafts and promotions are noted as reasons to look
  (its own acts, made while it runs, are not). A decision recorded while its gathering session is
  still open is not a reason: the session reaching its goal is. A coding session the operator
  started (Start coding session) never is.
- Every 20 s, a project with reasons, watching on, not paused by an attach
  (§app.organizations/portability), an idle overseer, ≥ 10 minutes since its last unattended look
  and under the daily limit gets one unattended run, which lists the reasons and asks it to
  re-read the project, infer gaps and act within its level.
- **Sooner for three reasons.** A gathering session reaching its goal, a coding session it started
  finishing a turn, and a promotion the operator made start that run once 60 s have passed since
  the first of them was noted, without waiting for the 10-minute gap; everything else about the run
  (the daily limit, watching on, not paused, an idle overseer) still holds, and the run lists every
  reason waiting.
- **Run Now** (`POST …/overseer/run`) starts one now, skipping the reasons and the 10-minute gap
  but not the daily limit or a busy overseer (409 with why). The project page shows the last run
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
