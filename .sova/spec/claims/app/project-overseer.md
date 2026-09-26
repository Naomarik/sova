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
  keeps the previous ones (up to 20) as read-only history. Settings, notes, ideas and to-dos stay.
- Its file lives in the org's workspace repo (`sessions/`), carries an invisible
  `sova-project-overseer` marker `{v:1, orgId, projectId}`, and its cwd is the **project root**.
  It is that project's overseer only when the marker is present, the file is in THAT org's
  workspace, and the project's `state.json` knows its id; a copy or a fork is an ordinary session.
  The session list marks it (`projectOverseer`); nothing (the Overseer's prompt route included)
  writes a message into it but the operator's own composer.
- Its state is in the workspace repo under `projects/<projectId>/overseer/`: `overseer.json`
  (autonomy, model, thinking, caps, token budget, watch on/off, extra instructions), `state.json`,
  `notes.md`, `actions.jsonl` (every act, refused or not), `ideas/`, `todos.json`, `started.json`
  (the sessions it started, and what its coding sessions spent); committed with the org's
  workspace commits (§app.organizations/workspace-repo). Only the per-turn counters and the watch
  loop's timing are host-local.
- **Loadout.** No pi-config extension, skill or prompt template loads (no mode; a mode switch is
  refused); the project's own context files do. Its tools (§app.project-overseer/tools) plus
  read-only `read`, `grep`, `find` and `ls` in the project root, which never read a secret file.
  No shell, no edit or write tool. Its prompt is Sova's (`server/project-overseer-prompt.md`),
  re-rendered at every run with the project, the level in force, the caps, the roster (name, role,
  decision areas; never contact details), its ideas, the operator's to-dos, its notes and the
  operator's extra instructions. Model and thinking from `overseer.json`, else the new-session
  defaults; the composer's picks are saved there.

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
  after which starting or prompting one refuses; at most 12 unattended runs a day. Over a cap a
  tool refuses and takes nothing.

## §app.project-overseer/tools — Scoped to its project

- Reads: `sova_project` (level, roster, gathering sessions, decisions by state and area, open
  conflicts, spec status, its budget), `sova_decisions` (with who and their exact words),
  `sova_list_sessions` / `sova_read_session` (the project's gathering sessions as their
  participants see them, and ordinary sessions whose folder is inside the project root, never
  another project's, an overseer's or a subagent's own), `sova_roster` (read), `sova_todos`.
  People's words are marked as data, never instructions.
- `sova_promote` asks the reconciler as the overseer (`by: "overseer"`): a decision made outside its
  author's decision area (they are not the roster owner of that area) is refused for it in every turn,
  the operator's own included, with the reconciler's reason in the result, and is left for the
  operator to promote explicitly by id on the project page. Reconcile is on by default, so
  `sova_reconcile` runs unless the operator turned it off in Settings → Decisions.
- L0: `sova_note`, `sova_confirm`, `sova_idea`. L1: `sova_start_gathering` (one active roster
  person, or the operator), `sova_offer` (two or more), `sova_reconcile`. L2: `sova_promote`,
  `sova_roster` approve/decline (history records the overseer as the writer). L3:
  `sova_create_session` (the root or a folder inside it, with a first prompt), `sova_send` (its
  project's coding sessions only; never a gathering session). Operator turns only: `sova_todo`.
- A gathering session it starts is owned by it (`owner: {overseerOf}`); no link is minted (the
  model never sees a token), so Needs you asks the operator to send the person their link. Its
  `public_title` and `question` are required and shown to the person as written (the tool
  descriptions and the prompt say so: neutral, no internal labels, no judgments about people); the
  `goal` is for the session's model only.
- **Models.** A session it starts gets the model and thinking the call names, else the project's
  `codingModel`/`codingThinking` (coding sessions) or `gatheringModel`/`gatheringThinking`
  (gathering sessions and offers, Send to person… included: the model the person talks to), else the
  overseer's own setting, else what its runtime runs, and only then the new-session default.

## §app.project-overseer/watch-loop — Looking when something changes

- Recorded decisions, a gathering session reaching its goal or closing, a referral, and the
  reconciler's conflicts, resolutions, drafts and promotions are noted as reasons to look (its own
  acts, made while it runs, are not). Every 20 s, a project with reasons, watching on, not paused
  by an attach (§app.organizations/portability), an idle overseer, ≥ 10 minutes since its last
  unattended look and under the daily limit gets one unattended run, which lists the reasons and asks it to re-read the project, infer gaps and act
  within its level.
- **Run Now** (`POST …/overseer/run`) starts one now, skipping the reasons and the 10-minute gap
  but not the daily limit or a busy overseer (409 with why). The project page shows the last run
  (started or skipped, and why) and the reasons waiting: "Last looked on its own {time}, skipped:
  {why}." or "…, after {reasons}.", then "{n} run(s) today." — one period at the end of each
  sentence, whatever the reason's own text ends with (`lastRunTail`, `src/lib/project-overseer-view.ts`).

## §app.project-overseer/gaps — Gaps against the roster

- A gap is a decision the project needs that nobody has made. It files each as an idea with id
  `§gap/<name>`, the tag `gap` (always added) and `area-<areaKey>` when known, and names in its text
  who should answer: the roster person whose decision areas cover it, or the operator when nobody's
  do. At L1+ it may start a gathering session with that person.

## §app.project-overseer/ideas-and-todos — The operator's items

- Ideas (the overseer's and the operator's, `POST …/overseer/ideas`) and to-dos use the Overseer's
  stores and shapes at the project's paths, so the same panels show them.
- Each item offers **Send to person…** (`POST …/overseer/items/send`): a gathering session owned by
  the operator (one person, the operator, or an offer to several), with the public title and first
  question the operator writes (both required, 400 without them, and never taken from the item: they
  are shown to the person as written) and the item as its goal; its links are shown once; and **Start coding session** (`…/items/code`): an ordinary session in the
  project root with the item as its first prompt. Either links the item to the session it started.
