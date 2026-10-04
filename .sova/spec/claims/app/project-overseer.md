# §app/project-overseer — Project overseer
> Part of the Sova design spec · [overview](../design/overview.md)

Each project of an organization (§app/organizations) can have one **project overseer**: a special
session, like the Overseer (§app/overseer), that watches the project's decisions as people make
them in gathering sessions (§app/baton), infers what is still missing against the roster, and acts
on it at the autonomy level the operator grants: it starts gathering sessions, reconciles and
promotes decisions (§app/requirements), and starts ordinary coding sessions in the project. The
operator talks to it in the normal chat page under a head of its own (§app.project-overseer/page),
which is also its live view: its tool calls render as tool cards as they happen.

## §app.project-overseer/identity — One per project, in its engine's dir

- Created on the operator's first open (`POST /api/projects/:pid/overseer`); `GET` answers
  `exists: false` until then. One current conversation per project; **Clear** (`POST …/overseer/clear`:
  its chat head's ⋯ Clear, or `/clear` typed in its composer, §app.project-overseer/page) starts a new
  one and keeps the previous ones (up to 20) as read-only history, opened from its chat head's
  History; older ones are archived (they stay in the workspace repo, like every workspace file).
  Settings, notes, ideas and to-dos stay.
- Its file lives in the `sessions/` of the engine that holds the project (the org's workspace repo
  while placed, `<stateRoot>/projects/<pid>/` while standalone, §app.projects/standalone), carries an
  invisible `sova-project-overseer` marker `{v:1, projectId}` (an `orgId` in an older marker is
  ignored), and its cwd is the **project root**. It is that project's overseer only when the marker
  is present, the file is in THAT engine's `sessions/`, and the project's statechart knows its id; a
  copy or a fork is an ordinary session.
  The session list marks it (`projectOverseer`, and `org`, §app.organizations/org-sessions).
- **Two writers, each by its own route.** Only two things write a message into it: the operator's
  own composer, and the global Overseer, through its one message route and only in a turn the
  operator started (§app.overseer/org-project-overseers), which marks each message as the
  Overseer's. Nothing else: the Overseer's prompt route (`sova_send`, `POST
  /api/sessions/prompt`) still refuses it (409), and the message route refuses any caller without
  the server's sender secret (403). A message from either is the operator's to its model and to its
  limits (§app.project-overseer/autonomy-levels).
- Its settings and working files are in its engine's dir under `projects/<projectId>/overseer/`:
  `overseer.json` (autonomy, model, thinking, the coding sessions' model, thinking and mode, the
  limits, the pace, the hold, watch on/off, extra instructions; §app.project-overseer/limits),
  `notes.md`, `ideas/` and `todos.json`, committed with the org's workspace commits
  (§app.organizations/workspace-repo). Its conversation and history, the sessions it started (and,
  as `operator-coding` sessions that no cap counts, the ones the operator started with Start Coding
  Session or New Coding Session, each with its worktree, §app.project-overseer/coding-worktrees),
  its gaps and every act it made are the project's statecharts (§app.project-overseer/statecharts). Its
  activity — every act, refused or not; an act that did only part of what was asked, a promotion
  with refusals, is `partial` with what was refused — is read from the transition log. Only the
  counters (each message's and each day's) and the watch loop's timing and held items are
  host-local, in its watch statechart.
- **Loadout.** No pi-config extension, skill or prompt template loads (no mode; a mode switch is
  refused); the project's own context files do, and only those inside the project root: never the
  agent dir's or a folder's above the root (the home folder's `AGENTS.md`). Its tools
  (§app.project-overseer/tools) plus read-only `read`, `grep`, `find` and `ls` **confined to the
  project root**: every path, as written (`..`, `~`, absolute) and at its realpath (a symlink in the
  root that leads out), must be inside the root, and none may be inside an attached org's
  workspace (the roster's contacts, every project's transcripts) or pi's or Sova's state (the
  host's link store, every session), even when the root holds them. A path argument that fails is
  refused with the reason; a listing or search leaves such entries out; a secret file inside the
  root is still refused. One folder outside the root is open to `read` alone: this conversation's
  own attachments folder (`<stateRoot>/attachments/<its session id>/`, where an image the
  operator pastes into its composer is saved, §chat/images), so it sees what the operator attaches, an image as
  an image. A path there must be inside that folder both as written and at its realpath (a symlink
  in it that leads elsewhere is refused); another conversation's attachments and the rest of Sova's
  state stay refused, and `grep`, `find` and `ls` never reach it. The prompt says so. No shell, no
  edit or write tool. Its prompt is Sova's
  (`server/project-overseer-prompt.md`), re-rendered at every run with the project, the level in
  force (a standalone project's with the standalone level meanings, and only its coding-session, prompt
  and look limits; gathering sessions and promotions appear only while placed), the caps, while placed
  the organization's sections (the roster: each active person's name, id, role, language, decision
  areas, skills and voice, so it knows how to address and write to each of them (greeting,
  language, register), never contact details; the project's main stakeholder, "Main stakeholder: {name}: decides every
  area of this project that no one else on the roster decides."; the gap guidance), its ideas, a line saying the operator's to-dos are the operator's own
  list (never their text: it reads them with `sova_todos` when the operator asks,
  §app.project-overseer/ideas-and-todos), its notes, while placed the organization's About text (§app.organizations/about) and, last, the operator's extra instructions. Model and thinking from `overseer.json`, else the new-session
  defaults; the composer's picks are saved there.
- **Extra instructions.** The project page's Settings tab has an **Extra instructions** field, after
  the coding sessions' mode and before Limits: the hint "Added last to this overseer's prompt, after
  the organization's About text, and they win over it. It reads them at its next run.", a textarea
  (at most 8,000 characters) with a live `{n} / 8,000` counter, and **Save** and **Cancel**, both
  disabled until the text differs from what is saved (Cancel puts the saved text back). Save sends
  only `extraSystemPrompt` (`PATCH …/overseer`, one PATCH); a blank save removes them; a longer text
  is refused (400) and the reason shows under the field. Secrets in them are redacted when they are
  put into the prompt. The global Overseer reads and sets them too (`sova_org_project`,
  `sova_project_overseer` `settings`). Copy: §design.copy-deck/overseer-orgs.
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
composer has no mode switch. A message the global Overseer sent it (§app.overseer/org-project-overseers)
is a user row carrying the **Overseer** tag, live and on reload, and while it waits in the queue
its row reads **Overseer** (§app.overseer/sent-marker); Rewind and Regenerate work on it as on any
user row.

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
     the organization's ceiling (an empty roster), the reason alone.
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
- **Phone** (below 480px): line 1 keeps back, the title, the state chip, the context readout
  (§chat.context-window/width-budget: its ring and "222k"), ⋯ and Session details; the
  meta line keeps only the project (the org and the watch word go; ⋯ says Stop or Start Watching),
  on a line of its own under line 1, lined up with the title, ending in "…" when it doesn't fit.
  Below 420px, while the state chip shows, the row's gaps close to 2px and its side padding to
  4px, and nothing on line 1 wraps. Below 380px, while the state chip shows, the word "Overseer"
  would not fit beside the widest chip ("L3 in force") and the context readout, so the title is
  the overseer's eye icon instead (the one the sidebar's Overseer button uses, 16px, never
  cut): the heading keeps "Overseer" as its text for AT, visually hidden, the icon is
  `aria-hidden`, and hovering it shows "Overseer · {project}". From 380px up, and without a
  state chip at any width, the title is the word, as before.

## §app.project-overseer/autonomy-levels — What it may do on its own

- Four levels, set per project (`PATCH …/overseer {autonomy}`), default **L1**:
  **L0 propose** (read, keep notes, file ideas, ask with a confirm card, stop the project's
  running instances, §app.project-services/callers), **L1 gather** (+ start
  gathering sessions and offers, share its running copies, run the reconciler, publish preview links of its coding
  sessions' apps, §app.project-overseer/previews), **L2 reconcile** (+ promote drafted
  decisions, approve or decline referrals), **L3 build** (+ start and prompt coding sessions in the
  project, within its limits, and create, start, reload, reset, tear down and conform the
  project's running instances).
- The level in force is **L0 while the overseer is paused by an attach on this host**
  (§app.organizations/portability), until the operator sets its level here, then under the
  **ceiling** the organization sets while placed: **L0 while the org's roster has no active
  person**, whatever the setting. A standalone project has no ceiling and runs at its setting. The project page says why ("In force
  now: L0." and the reason, shown whenever it is paused, even with L0 chosen).
- The level binds only runs the operator did not start (a watch-loop look, Run Now). A message the
  operator sends from the UI makes that run theirs (decided by identity, as for the Overseer), and
  so does a message the global Overseer sends through its route in a turn the operator started
  (§app.overseer/org-project-overseers); every tool may run in it, under the caps. Changing or
  reading the operator's to-do list runs only in the operator's own turns.
- Enforced by the statecharts' guards at every call, never by the prompt: each tool call is an event
  of the statechart it acts on, tried first; the level is checked first, then the call's own arguments,
  then whether the statechart can take it now, then the limits, each refusal with today's sentence. A
  tool above the level refuses with a sentence telling the model to file it as an idea or
  raise a confirm card instead, the refusal is logged, and nothing starts. A level change applies
  from the next tool call; the level, the limits and the pause a guard reads can't change between
  the check and the act (§app.project-overseer/statecharts). The same guards bind what the statecharts
  start on their own (§app.project-overseer/drive).
- **What waits for its approval.** Beside the level, the project page has the checklist of the
  kinds of held act that go ahead only once the overseer approves them
  (§app.project-overseer/reviews).
- **Limits** (§app.project-overseer/limits): what it may start or send per message the operator
  sends, per day on its own, and at once. Over a limit a tool refuses and takes nothing. There is
  no token or cost budget; what the project's sessions cost is shown to the operator only
  (§app/project-costs).

## §app.project-overseer/limits — Limits, per project

- **Two allowances.** *Each message you send* covers the turns the operator started: 3 gathering
  sessions or offers started, 20 decisions promoted, 2 coding sessions started, 5 prompts to them
  (`gatherPerTurn`, `promotePerTurn`, `createPerTurn`, `promptsPerTurn`); an operator message
  (the global Overseer's message included, §app.overseer/org-project-overseers) and Clear reset it. *On its own, each day* covers every run the operator did not start (a watch-loop
  look, Run Now) and every act the project's statecharts start on their own
  (§app.project-overseer/drive): 6 gathering sessions or offers, 60 promotions, 4 coding sessions, 12 prompts
  (`gatherPerDay`, `promotePerDay`, `createPerDay`, `promptsPerDay`), reset at local midnight on
  this host. An operator message never refills what a run on its own may do, and a run on its own
  never uses the operator's message allowance. **Looks**: at most 12 unattended runs a day
  (`unattendedPerDay`).
- **At once**, for both kinds of turn: 5 of its gathering sessions open (0–20) and 2 of its coding
  sessions running (0–10).
- **No token budget.** The coding token budget is gone: nothing refuses on tokens or cost. A
  `tokenBudget` in an older `overseer.json` is ignored on read and dropped at the next save; a
  PATCH carrying one ignores it. An older Sova on another host reads the missing key as its own
  default, stricter, never looser.
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
- **The hold, per project**, in the page's Pace group: "Hold before it reaches people or the code",
  a select of No hold, 2 min, 5 min, 10 min, 30 min and 1 hour (and the saved value when it is
  another), with the hint "What it starts on its own that reaches a person or the code goes ahead at
  once." at No hold, else "What it starts on its own that reaches a person or the code waits {n min |
  1 hour} in Needs you, where you can cancel it." It is saved with the limits (`holdMin`,
  §app.project-overseer/holds); Reset Limits puts 10.
- **Held, then retried.** A refusal for an allowance or the looks per day records a
  *held* item in the project's host-local watch statechart (one per limit, at most 10; the first
  refusal's time is kept) with a retry time: the next local midnight for a daily allowance or the
  looks; at once for the message allowance (a later look of its own may go on, at the normal pace,
  within today's allowance). When its time comes (a statechart timer; the message allowance's in the
  refusal's own step), a held item becomes a reason to look ("Today's allowance is back: it may start gathering sessions again (refused {time})."),
  soon (unless Off) except the message allowance's, which waits for the normal pace. A PATCH that
  raises a limit or sets it Unlimited releases its held items at once ("You raised the limit on
  {what}."). The at-once limits hold nothing: a gathering session finishing or closing, and a
  coding session finishing its turn, are already reasons to look.
- **Refusal wording.** A refusal has a sentence for the operator, logged in the transition log and
  shown in the page's activity list, and a tail for the model only, never logged: a daily
  allowance, "Today's allowance is used: {n} of {max} {what} on its own. It looks again at
  midnight." + "Nothing starts before then. Tell the operator what is waiting; don't promise an
  earlier look."; the message allowance, "This message's allowance is used: {n} of {max} {what}
  per message you send." + "Stop here and tell the operator what is done and what is left, or ask
  with sova_card."; an at-once limit, "{n} of its gathering sessions are
  open, and the limit is {max} at once." (or coding sessions running) + "One finishing is a reason
  to look again; don't promise when." The prompt says never to promise a look "next time" unless
  a tool result says when it comes, and lists every limit in force. A coding session's turn,
  whoever prompts it, reaches its build: the Pipeline shows it working and the at-once limit counts
  it while it runs.
- **Promotions count what was promoted.** `sova_promote` checks every id it is given against what
  is left before it promotes anything: a request over it is refused whole and takes nothing. Then
  only the decisions it promoted count against the allowance; an id it refused (unknown, not
  drafted, in a conflict, outside its author's area) takes nothing, and a call that promotes none
  takes nothing.
- **The page** (the project page's Settings tab) has a **Limits** section, read-only until
  **Edit**: one table, a row per limit (Gathering sessions started, Decisions promoted, Coding
  sessions started, Prompts to coding sessions, Looks, Gathering sessions open, Coding sessions
  running) and a column each for Per message, Per day and At once, a cell `—` where the limit
  doesn't exist and `∞` (named "Unlimited") for Unlimited; under it one hint ("Per day resets at
  midnight on {host}. At once never goes Unlimited: it's what stops a burst."), then the pace in
  one line. **Edit Limits** turns
  the cells into fields, each allowance with an `∞` toggle ("Unlimited", pressed or not) that
  disables its field (a blank field is never Unlimited), the at-once limits without one, and the
  pace selects; one form, **Save Limits** (one PATCH; saved, the table is read-only again),
  **Reset Limits** (the defaults, into the form, unsaved) and **Cancel** (the saved values back,
  read-only), with the first problem under it before anything is sent. Under 560px of pane width
  each row stacks, every figure under its column's name. Under the status line, what it has
  used today on its own and in the operator's last message, and a **Waiting** line per held item
  that isn't the message allowance's. The Watch hint is built from the pace. Copy:
  §design.copy-deck/project-limits.
- `GET …/overseer` answers `usage.allowance` (`message` and `today`: per kind, `used` and `max`,
  `null` = Unlimited) and `usage.held`; no token count and no cost. `sova_project`
  reports both allowances used and left, the looks today, the at-once limits and the held items,
  and nothing about tokens or cost.

## §app.project-overseer/tools — Scoped to its project

- Reads: `sova_project` (level, roster, gathering sessions, decisions by state and area, open
  conflicts, spec status, its builds, its limits, and a Software block: the registry's standing in
  words, each service as name · kind · scope · isolation with its live state, approval, proof, the
  drifted paths and the playbook run, §app.project-runtime/registry), `sova_decisions` (with who, their exact words and each
  decision's owner area), `sova_list_sessions` / `sova_read_session` (the project's gathering sessions as their
  participants see them; the project's coding sessions, every one its statecharts record, the
  overseer's and the operator's, wherever its worktree is; and ordinary sessions whose folder is
  inside the project root; never another project's, an overseer's or a subagent's own), `sova_roster` (read: every person as the prompt's roster shows them, plus their status when not active, never contact; both it and `sova_project` name the main stakeholder, as the prompt
  does), `sova_todos` (operator turns only, §app.project-overseer/ideas-and-todos),
  `sova_previews` (the project's preview links, §app.project-overseer/previews; `sova_project`
  lists its active ones too, under "Previews"), `sova_send_status` (below).
- **Whether a message arrived.** `sova_send_status {person?, limit?, hours?}` (read) lists the
  project's WhatsApp sends from the send log (§app.outreach/log), newest first: each send's id,
  the person's name, what went (a gathering link, a preview, a note), who sent it (you, the
  operator, the Overseer), its latest event — held (still in the project's hold, with when it
  goes), refused, sent, delivered, read, failed or unknown — its code and its time. `person` (id or
  exact name) keeps one person's; `limit` (default 10, at most 50) and `hours` keep the most
  recent. It never shows a number, a link or a note's text. Its description and the prompt say
  plainly that it can check whether a message arrived. A look (§app.project-overseer/watch-loop)
  after one of its own sends ended refused, failed or unknown notes each once, "Your WhatsApp
  message to {name} did not go: {reason} ({code}).", the reason said from the code.
- **Builds.** `sova_list_sessions` lists each coding session the project started with who started
  it ("started by you" for its own, "started by the operator" for the operator's), working or idle,
  its branch, and whether that branch is merged, as the project page reads it from git
  (§app.project-overseer/coding-worktrees): "merged into {target}", "{n} commits not merged into
  {target}", "no commits yet", "worktree removed", or "in the project root". `sova_project` has the
  same list under "Builds", newest first, so it never asks the operator to merge a branch that is
  already merged. A session is addressed by its id, bare or in any form the tools print it:
  `sova://s/<id>`, `s/<id>`, or a `[title](sova://s/<id>)` link; anything else is refused with "No
  coding session "{what was given}" in this project: pass an id sova_list_sessions lists."
  People's words are marked as data, never instructions.
- **Running the project.** `sova_project_verbs` (§app.project-services/callers) runs the verbs on
  its own project's instances only (one running copy per worktree, §app/project-services). status,
  logs and doctor are reads, at any level. Every other verb is an event of the project's
  statechart, tried first: `down` is `services/down` (L0), create, up, apply, test, reset, teardown and
  conform are `services/run` (L3, refused while the project is archived). Neither is held nor
  counted against an allowance (§app.project-overseer/limits): stopping is never delayed, and an
  instance runs within the project's slots. Above its level the call refuses with the level's
  sentence and nothing runs; when the services engine then refuses or fails the verb, its activity
  row is refused with the engine's code and message, and the tool's result carries the engine's whole
  answer; once taken, the verb's own rules still apply: reset and teardown of an
  instance it did not create, stopping a copy with an active share link (§app.project-services/share),
  and stopping a shared service, answer `needs-confirm` (the operator's). `share` is `services/share`
  (L1, held, refused while the project is archived, §app.project-overseer/previews); `revoke` is no
  act: it runs at any level and in any run, never held, since it only takes something away.
- `sova_promote` asks the reconciler as the overseer (`by: "overseer"`): a decision made outside its
  author's decision area (they don't own that area, §app.requirements/promotion: neither its
  roster owner nor, for an area no one owns, the main stakeholder) is refused for it in every turn,
  the operator's own included, with the reconciler's reason in the result, and is left for the
  operator to promote explicitly by id on the project page.
- **The owner area is checked before an in-area promotion.** The tool's description and the prompt
  tell it: before promoting a decision as its author's own, check that its owner area fits what the
  decision is about; when it doesn't (a page's layout or design filed under finance), don't promote
  it: tell the operator which decision it is and why the area looks wrong (they set it on the
  project page), or ask with `sova_card`. `sova_decisions` shows each decision's owner area and
  whether its author owns it, so the check has what it needs. Reconcile is on by default, so
  `sova_reconcile` runs unless the operator turned it off in Settings → Decisions.
- L0: `sova_note`, `sova_card`, `sova_idea`. L1: `sova_start_gathering` (one active roster
  person, or the operator), `sova_offer` (two or more), `sova_reconcile`,
  `sova_owner_update` (an update on the owner page, §app.owner-page/updates),
  `sova_send_to_person` (L1: a WhatsApp message to a roster person — their gathering link, a preview
  link, a note, or a link with a note; §app.outreach/decisions),
  `sova_close_gathering`; `sova_start_gathering` and `sova_offer` take an optional `abilities`
  within the project's ceiling (§app.baton/abilities) and a required `why`; `sova_preview` start
  (a preview link of a coding session's app; its `off` runs at any level,
  §app.project-overseer/previews). L2: `sova_promote`,
  `sova_roster` approve/decline (history records the overseer as the writer). L3:
  `sova_create_session` (the root or a folder inside it, with a first prompt, an optional `mode` and
  `minor_modes`; in its own worktree, §app.project-overseer/coding-worktrees), `sova_send` (its
  project's coding sessions only, and an ordinary session whose folder is inside the project root,
  which is the project's own act: L3, counted as a prompt, held like one, kind `prompt`; never a
  gathering session; an optional `mode` and `minor_modes` too). Both take the mode within the operator's ceiling (§app.project-overseer/coding-mode).
  L3 also: `sova_project_verbs` create, up, apply, test, reset, teardown and conform (L0: its `down`;
  L1: its `share`, held; `revoke` at any level; status, logs and doctor are reads; below), and its `onboard {why}`, the project's `verbs/onboard`
  act, which starts the Project verbs playbook (§app.project-runtime/onboard): counted and held like
  a coding session's start, and refused for an unattended overseer while the project's software is
  registered and current. The overseer may start it when the Software standing is unregistered,
  stale or failed; below L3 it raises a card instead; it never approves a definition or merges.
  Operator turns only: `sova_todo`.
- **Every start names its gap.** `sova_start_gathering` and `sova_offer` take a required `gap`: a
  `§gap/…` idea of the project (the session becomes that gap's, §app.project-overseer/gaps), or
  `"none"` for a question that serves no gap. Without it: 'Say which gap this is for: gap
  "§gap/<name>" (sova_idea lists them) or "none".'; naming a gap the project doesn't have: 'No gap
  §gap/x in this project: file it first (sova_idea add §gap/<name>), or say gap "none".'. With
  `plan: true`, at any level from L0, the gathering is filed on the gap as a plan, which the gap's
  statechart starts once the level in force reaches L1 (§app.project-overseer/drive); a plan must name a
  gap ('A planned gathering belongs to a gap: name it (gap "§gap/<name>").'). `sova_create_session`
  takes `gap` too, with the same refusals, and optional
  `decisions`: the gap's promoted decisions it builds, all of them not built yet when omitted;
  naming another is refused: "{id} is not a promoted, not yet built decision of {gap}: a build
  rests only on its gap's promoted decisions." **Nothing is built that no one agreed on**: in a run
  the operator did not start, a coding session must name a gap with promoted decisions and builds
  only those (gaps exist only while placed); a coding session tied to no gap starts only in a turn
  the operator started, at every level and in a standalone project too, else: "A coding session
  starts only in a turn the operator started: ask with sova_card." The gathering tools, `gap` and
  `decisions` and everything about gaps here are the organization's, offered only while placed. Each refusal
  changes nothing. The operator's own Start Coding Session and New
  Coding Session never need a gap. The operator's Start Coding Session on a `§gap/…` idea whose gap
  has promoted decisions not built yet is the gap's own build (on its Pipeline row; still the
  operator's, never on the overseer's limits); otherwise it is a coding session linked to the
  idea, as before.
- A gathering session it starts is owned by it (`owner: {overseerOf}`); no link is minted (the
  model never sees a token), so Needs you asks the operator to send the person their link. Its
  `public_title` and `question` are required and shown to the person as written (the tool
  descriptions and the prompt say so: neutral, no internal labels, no judgments about people); the
  `goal` is for the session's model only, and names people by name only, never by role or job
  title, and never says how its decisions will be recorded or under which owner area ("as finance
  decisions"), because the session's model may repeat it (the `goal` descriptions say so, and
  `goal_done`'s `summary` description asks for the session's own words and names only). Its `why`
  is for the operator: one or two sentences saying why it starts this session, recorded on the
  session's statechart (a plan keeps it until the statechart starts it) and shown on the strip and in What
  It's Told (§app.baton/told), never to the person and never to the session's model. Without it:
  "Say why you start it (why): one or two sentences for the operator, never shown to the person.".
  A `public_title`, `question`, `goal` or `why` that holds a kept preview link is refused
  (§app.project-overseer/previews).
- **Closing its own.** `sova_close_gathering` (a session and a required `reason`) closes a
  gathering session or offer it started that nobody it went to has written in yet (`wroteAt`
  unset), the same way the operator's Close does (the wrap-up is scheduled, the share page
  refreshed); the reason is the action's note in its activity. It refuses anything else, and never
  closes a settle session (a conflict ends by being settled or re-routed) or the operator's: "Not
  one of your gathering sessions.", "That is a settle session: the conflict ends when it is
  settled.", "Someone it went to has already written in it.", "It is already {done|closed}.". The prompt tells
  it: when a newer gathering covers one nobody has answered, close the old one, so it no longer
  counts against its limit or waits in Needs you.
- **What is built.** `sova_decisions` shows each promoted decision as built or not built yet, and
  edited in the spec since it was promoted (§app.requirements/decisions); `sova_project`'s spec
  line counts them as the Requirements card does ("· 4 built, 9 not built yet"), so it can tell
  what is left to build.
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
- **Every coding session the project starts gets it**: the overseer's `sova_create_session`, the
  operator's Start Coding Session and New Coding Session, and one a gap's statechart starts by itself at
  L3 (§app.project-overseer/drive), which also gets the project's coding model, as Start Coding
  Session does, before its first prompt. The mode is applied, and written into the session file as
  its `mode` entry (§chat/mode-menu), before the first prompt, even when it equals the host's
  default, so the session's first turn runs in it and a later change to `mode.json` never moves
  it. A mode that can't be applied (the session is held elsewhere, the mode extension is missing)
  sends no prompt: the session stays, listed and counted, and the tool result (or the page's
  error) says "Started, but not prompted: its mode could not be set." New Coding Session sends no
  prompt anyway; its page error says "Started, but its mode could not be set. Set it from the chat's
  mode menu before you send." Neither has a mode picker; the chat's own mode menu can switch it
  afterwards, like any chat.
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
- A gathering session loads no extensions, so it has no mode; what it can do is the project's
  gathering abilities (§app.baton/abilities).

## §app.project-overseer/coding-worktrees — Each coding session in its own worktree

- **Always, in a Git project.** Every coding session the project starts (the overseer's
  `sova_create_session`, or the operator's Start Coding Session or New Coding Session) runs in a new git worktree on a
  new branch, cut from the commit the project root's checkout has checked out (`HEAD`), whose
  branch is the one it merges back into. The project root's checkout is never switched, and the
  session's cwd is the worktree (or, for a folder inside the root, the same folder inside the
  worktree).
- **A Project verbs run.** The coding session the Project verbs playbook runs in
  (§app.project-runtime/onboard) is listed with the others, by who really started it ("Started by
  the overseer" or "Started by you"), and labelled "Project verbs playbook run".
- **Told to commit.** Such a session's first prompt ends with a paragraph Sova adds: "You work in
  your own git worktree on the branch {branch}. Commit your work on this branch before you end
  your turn: uncommitted changes can't be merged. Before you end your turn, also merge {target}
  into your branch and resolve any conflicts." A session started with no prompt (New Coding
  Session, §app.project-overseer/new-coding-session) gets the same paragraph as a note before
  anything is sent: a `sova-coding-worktree` message in its transcript, shown in the chat and part
  of its model's context from the first message the operator sends. A session run in the project
  root (no worktree) gets no such paragraph.
- **Names.** Branch `sova/<name>`, worktree `<parent of the repo's top level>/.worktrees/<repo
  folder name>-<name>`, outside the project root, as the `worktree` tool places its own
  (§chat.worktrees/tool). `<name>` is a slug of the session's title (the item's title, which names
  the gap, for one a gap's statechart starts by itself: `sova/build-gap-<name>-<6 hex>`; else the
  call's `title`, else the first prompt's first words, else `coding` when there's neither: New
  Coding Session; lower case, letters, digits and hyphens, at
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
- **Recorded with the session.** The coding session's statechart (kind `coding` or `operator-coding`,
  §app.project-overseer/statecharts; its gap and the decisions it builds when it has them) carries `worktree: {branch, base, target, path}` (`base` the commit it was
  cut from, `target` the branch it merges into) and its later `merged: {at, commit}` (the last
  Merge Branch: history, not the branch's state) or `removed: at`, or `inRoot` (the reason it runs
  in the root). A worktree folder deleted by hand shows as missing ("Worktree folder missing");
  its branch can still be merged. The tool result and the Start Coding Session and New Coding Session answers name the branch and the path.
  `path` is this host's, like the row's session path: on a host where it doesn't exist the row
  shows the branch only, and no gesture acts on it ("On another host: its worktree is there.").
  Each row records a title when its session starts (the title given, else the first prompt's
  first line; New Coding Session records none); the list shows a title given on this host first
  (a rename), else that one, else the session's own (its first message), else "Untitled coding
  session". A row
  whose session is not on this host is on another host, whatever its worktree path: it shows that
  title, not as a link, and "On another host: its worktree is there.", never "Worktree folder
  missing".
- **At most 200, never a live one.** A project keeps one ordered list of every session it or its
  gaps started, gathering and coding, at most 200. Past 200, the oldest *settled* one is retired
  from it: a gathering session closed or done whose wrap-up has ended (done or skipped; a failed one
  may still be retried), or a coding session merged or removed with no turn running, or retired. A
  live one (a coding session working, a gathering session open or needing you) is never retired, so the list is longer than 200 only while more than 200 are live, and trims back as they
  settle. A retired session is no longer organizational (§app.organizations/org-sessions); its
  transcript and its cost stay.
- **The project page lists them.** "Coding sessions" lists every coding session the project started
  (the overseer's and the operator's), newest first: title (a link on this host), who started it
  (the overseer, you, or you via the Overseer: an `operator-coding` row marked `via: "overseer"`,
  §app.overseer/org-project-overseers),
  state, age and its branch in mono (one line, cut with an ellipsis, the whole branch as its
  `title`), then a **⋯** menu ("Actions · {title}") holding **Merge Branch** and **Remove
  Worktree…** (each disabled with its reason, and absent when the row doesn't offer it); the
  Remove confirmation opens under the row. "Sessions it started" keeps its gathering sessions and
  offers. Copy: §design.copy-deck/project-coding.
- **Merge Branch** is the operator's gesture; the overseer has no tool for it. It merges
  `sova/<name>` into `target` in the project root's checkout, which must have `target` checked
  out, no tracked changes and no merge, rebase or cherry-pick in progress: a fast-forward when
  possible, else a merge commit ("Merge sova/<name>: <title>"). A conflict is aborted and reported,
  changing nothing. It is refused while the session is working or has workers running, while the
  worktree has uncommitted changes (they would be left out of the merge), and when the branch has
  no commits beyond `target`. After it the row says "Merged into <target>" with the time, and the
  merge is a reason for the overseer to look (§app.project-overseer/watch-loop), so it learns the
  branch reached `target` without being told.
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
  session is working or has workers running. When the worktree has a running copy of the project
  (an instance, §app.project-services/instances), Remove Worktree first tears that copy down
  (§app.project-services/teardown, as the operator), which also ends its share links; if the teardown
  fails, nothing is removed and the refusal says why ("Its running copy could not be torn down:
  …"). Merge Branch never touches the copy: it keeps running, with its links, until it is stopped or
  torn down, or its worktree is removed. Merge Branch also reloads the main copy's onMerge services
  at once (§app.project-services/on-merge). On a missing folder it only clears git's record of
  it (and deletes a merged branch). The
  session and its transcript stay; its row says "Worktree removed", and `sova_send` refuses it:
  "Its worktree was removed, so it has no folder to work in." Nothing is removed on its own, a
  merged worktree included: the session's cwd is inside it.
- A session started before this change keeps running where it was; nothing is moved.

## §app.project-overseer/previews — Showing a coding session's app to a stakeholder

- **What they are for.** A preview link (§mesh.public/preview) shows one of the project's coding
  sessions' running apps to a stakeholder, the whole site at its own public address, until it is
  deleted or expires. The prompt has a **Previews** section, and the two tools' descriptions
  say the same: what previews are for, that a link reaches anyone who has it, to make one only
  for a stakeholder who should see the app now, to check it answers, that the overseer never sees
  a link, that a preview reaches a person with `sova_send_to_person` and its `preview` id (they get
  their own link to it, §app.outreach/links) or through the operator, who has the link on the
  project page, and to delete it once it has served its purpose, which is for good (every link
  sent from it stops working with it, and nothing brings one back). If the app went down, whoever runs it (the coding session, prompted with
  `sova_send`) starts it again: Sova never starts an app for a preview. A running copy's link is the
  one exception: the operator may Start its stopped copy from the Previews card
  (§mesh.public/preview-card); a visit never starts anything.
- **See.** `sova_previews` (read, any level) lists the project's previews, active ones first:
  each one's id, whether the operator has its link ("link kept for the operator", or "no link
  kept for the operator (shown only when it was made)", then "send it by its id"), what it serves ("port {n}", or "folder {path}" relative to its
  worktree), its coding session and branch, its purpose, who made it (you or the operator), its
  expiry and its state ("active, app is running", "active, nothing on port {n}", "active, not
  serving the folder", "turned off", "expired"). `sova_project` lists the active ones under
  "Previews" the same way.
- **Make.** `sova_preview {op: "start", session, port | folder, purpose, days?}`. `session` is one
  of the project's coding sessions with a worktree on this host (addressed as the other tools
  address one). `folder` is a folder inside that worktree (relative to it, or absolute), served by
  Sova (§mesh.public/preview-serve). `port` is one the session already serves: the process
  listening on it must run from inside that session's worktree (its working folder, read from
  the system); nothing listening, a process elsewhere, or a host where Sova can't tell which
  process listens is refused, naming why, and so is a port of Sova's own. `purpose` (required, one
  line, at most 200 characters) says what it shows and to whom. `days` is 1 to 30, default 1.
  Every preview rule holds (§mesh.public/preview): loopback only, never Sova's own ports, a
  preview address needed. The link is kept for the operator (§mesh.public/preview); the result
  names the preview by its id and never carries the link.
- **Guarded as the people-facing act it is.** A start is the project statechart's `preview/start`
  act: L1 (§app.project-overseer/autonomy-levels), confirm kind `preview`
  (§app.project-overseer/reviews), held (§app.project-overseer/holds). In a turn the operator
  started it goes ahead at once; in a run the operator did not start it needs L1 in force, then
  waits in the hold ("A preview link: {purpose}"), cancellable from Needs you and the Pipeline, and,
  while `preview` is a confirm kind, until the overseer approves it. The session, target and port
  rules are checked at the call (a refusal is logged and holds nothing) and again when it goes
  ahead: a listener that moved or a folder that went away drops it with the reason. It counts
  against no allowance. The act's payload and its effect's result carry no link, so the
  transition log never does.
- **A running copy, shared.** A link can also show one of the project's running copies, an endpoint
  its definition declares for sharing (§app.project-services/share): `sova_project_verbs {verb:
  "share", instance, endpoint, days?}`. Once the services engine's own checks pass it is the project
  statechart's `services/share` act, guarded as `preview/start` is: L1, people-facing, confirm kind
  `preview`, held ("A preview link: {endpoint} of a running copy ({branch})"), refused while the
  project is archived, counted against no allowance; its effect mints the link once it goes ahead,
  checked again then, and its payload and result carry the link's id, never the link. The tool's
  result names the link by its id, endpoint, expiry and state, never its URL. `sova_previews` lists
  these links too, each with its id, endpoint, the copy's branch ("main" for the main checkout),
  its expiry and its state, never the link. `revoke {link | instance}` takes them away at any level
  and in any run, never held. Who gets the link: in a standalone project it is only for the
  operator, who sees it in Sova; in an organization's project the overseer may then send it to a
  roster person with `sova_send_to_person` and its `preview` id. The prompt's Previews section
  and the tool descriptions say so.
- **Seeing and stopping what runs.** The prompt also says how to see and stop any running copy of
  the project at will: `sova_project_verbs status` lists every copy (main and each worktree's) with
  its state, and `down` stops one at any level from L0, never held; a copy with an active share link
  answers `needs-confirm` to it (§app.project-services/share), so the prompt says to revoke its links
  first (`revoke {instance}`), then stop it.
- **Delete.** `sova_preview {op: "off", id}` deletes one of this project's previews at once and for
  good, at any level and in any run, never held and never waiting for a review: it only takes
  something away. It is the card's Delete (`POST /api/previews/<id>/off`); its result says
  "Deleted {id}: its link answers "no longer active" for good.", and it is logged in the
  overseer's activity as "Deleted a preview link" (with its purpose).
- **One shape for what comes next.** Both tools put each preview in their result's `details` in one
  fixed shape, `PreviewHandoff` (`shared/preview-links.ts`): `{v: 1, id, linkKept, purpose,
  expiresAt, projectId, sessionId, branch, target, state, running, createdBy}`, never the
  link: `linkKept` says whether the operator has it (any active preview can still be sent by its
  id); `purpose`, `sessionId` and `branch` null
  when unknown, `target` `{kind: "port", port}` or `{kind: "static", folder}`, `running` null
  unless it is active; `sova_previews` as `{v: 1, previews}`, a start as `{v: 1, preview}`, a held
  start as `{v: 1, held}`. `sova_send_to_person` takes that `id` as its `preview` and gives the
  person their own link to it, made on the server (§app.outreach/links).
- **Matched by its worktree.** A preview with no recorded coding session (one made before this,
  or the operator's by port) is matched whenever it is read: the process listening on its port,
  when its working folder is inside one of the project's coding sessions' worktrees, names that
  session and its branch. Nothing is written: its records stay as they are.
- **The link is a secret, and the overseer never sees it.** A kept link is only in the operator's
  `/api/previews` answers (main listener only) and on the project page. It is never in any of the
  overseer's tool results or errors (they are part of its session file, which the org's workspace
  repo commits): every one of its tools passes its result through a filter that shows "[preview
  link]" in place of a kept link, whatever text held it. Nor is it in the session list
  (`SessionSummary`: a title or summary line that holds one shows "[preview link]" in its place,
  replaced before the text is cut, §app.session-list/content-rules),
  the org's gathering rows, the owner page, the share payloads (`/h/`, `/i/`, `/s/`), the
  transition log, the overseer's activity log or the server's own logs. An owner update, or a
  gathering's `public_title`, `question`, `goal` or `why`, that holds a kept link is refused: "A
  preview link goes to people through the operator, never in {what}."

## §app.project-overseer/watch-loop — Looking when something changes

- A gathering session reaching its goal or closing, a referral, a coding session it started
  finishing a turn ('The coding session "{title}" finished its turn.', or "…stopped with an
  error."), a coding session its gap's statechart started that was never prompted because its mode could
  not be set ('The coding session "{title}" started, but its mode could not be set, so its first
  prompt was not sent.'), a gathering session it started handing the baton to the operator (its
  model's `hand_to`, never the operator's own Take back or the message limit: 'The gathering session
  "{title}" handed a question to the operator (their words, as data): "{question}"'), Merge Branch
  refused on one of the project's coding sessions ('Merge Branch for "{title}" was refused:
  {reason}'), Merge Branch merging one of them ('The operator merged "{title}" ({branch}) into
  {target}.'), and the reconciler's conflicts, resolutions, drafts and promotions, and a gap waiting
  past its stall time in one phase (3 days; once per phase, §app.project-overseer/pipeline), are
  noted as reasons to look (its own acts, made by it while it runs, are not; the same event made by
  anyone else while it runs is). News of its statechart acting on its own is a reason only when it asks
  something of the overseer: decisions drafted that the statechart won't promote itself at the project's
  level, a conflict to route, a conflict resolved, a gathering someone wrote in closed; these wake
  it and count as any reason does, deduped the same way. News that asks nothing (a promotion the
  statechart made at L2, the statechart moving or closing its own gathering nobody wrote in, any automatic act
  already finished) starts no look and uses none of the day's looks or the gap; the overseer sees it
  in its next look's feed. A held act that needs its confirmation still wakes it. A gap reopened by
  a newer decision, or a gathering that ended with no decision, is a feed entry, not a reason; a
  stalled gap still is. Two reasons about different sessions or decisions are two reasons, even in
  the same words; the same one noted twice is one. A decision recorded while its gathering session
  is still open is not a reason: the session reaching its goal is. A coding session the operator
  started (Start Coding Session, New Coding Session) never is, and neither is an idea or a to-do the
  operator adds or changes: they are the operator's own list
  (§app.project-overseer/ideas-and-todos).
- Every 20 s, a project with reasons, watching on, not paused by an attach
  (§app.organizations/portability), not archived (§app.organizations/archive), an idle overseer, at least its gap since its last unattended
  look (10 minutes unless the project sets another, §app.project-overseer/limits) and under its
  looks per day gets one unattended run, which lists the reasons and asks it to re-read the
  project and act within its level; while placed, the organization's look hint (infer gaps against
  the roster's decision areas) comes right after the ask to re-read the project, so the text reads
  as before. Held items whose time has come become reasons
  (§app.project-overseer/limits); a look refused for the looks per day is held until midnight. A
  look that stops, fails to start or is cut off by a restart puts the reasons it was given back in
  front of the queue, so none is lost. At most 50 reasons wait (the oldest go first), and a look
  lists the last 20.
- **Sooner for six reasons.** A gathering session reaching its goal, a gathering session it
  started handing the baton to the operator, a coding session it started finishing a turn, a
  refused Merge Branch, a merged one and a promotion the operator made start that run once the project's soon
  delay (60 s unless it sets another; Off: no sooner run) has passed since the first of them was
  noted, without waiting for the gap; everything else about the run
  (the daily limit, watching on, not paused, an idle overseer) still holds, and the run lists every
  reason waiting.
- **Run Now** (`POST …/overseer/run`) starts one now, skipping the reasons and the gap
  but not the looks per day, a busy overseer or an archived project (409 with why). The project page shows the last run
  and the reasons waiting: running ("Last looked on its own {time}, running now, after
  {reasons}."), finished ("…, after {reasons}."), stopped and why ("…, stopped: {why}.": the stream
  guard's trip, the model's error, or "Stopped" for an abort), cut off by a restart ("…, cut off by
  a restart.": the server stopped during the run, recorded when it next starts) or skipped and why
  ("…, skipped: {why}."), then "{n} run(s) today." — one period at the end of each
  sentence, whatever the reason's own text ends with (`lastRunTail`, `src/lib/project-overseer-view.ts`).
  In "after {reasons}" each reason continues the sentence (its capitalised first word in lower
  case). "Waiting to look at:" then lists the waiting reasons as sentences, each ending in exactly
  one stop (`pendingLine`), never joined with commas under an added period.
- An unattended run's message never points it at the operator's to-dos or ideas: it lists the
  reasons and asks it to re-read the project and act within its level (plus the look hint while placed).

## §app.project-overseer/gaps — Gaps against the roster

- A gap is a decision the project needs that nobody has made. It files each as an idea with id
  `§gap/<name>`, the tag `gap` (always added) and `area-<areaKey>` when known, and names in its text
  who should answer: the roster person whose decision areas cover it, else the project's main
  stakeholder, else the operator. At L1+ it may start a gathering session with that person.
- **Each gap it files is a statechart** (§app.project-overseer/statecharts), its item, with a stable id
  of its own (`g_` + 8 characters) that survives the idea's rename or move. The item follows the
  gap through its phases — not asked yet, asking, deciding (its decisions compared, in conflict,
  ready to promote), promoted, building, done — from what its own gathering sessions, decisions and
  coding sessions do, never from words: a gap may have any number of each. It is done when a
  coding session of it is merged and every promoted decision of it is built. A gap has at most one
  open build: starting another while one is open is refused ('§gap/x already has an open build
  ("{title}"): merge it or remove its worktree first; a decision promoted since is built after.'). When a decision of
  the gap is superseded, the gap follows the decision that superseded it: its phase moves with the
  winner's (ready to promote, then waiting for a build once promoted). Dropping the idea
  (by the operator, or `sova_idea` status `dropped`) drops the item, and dropping the item sets the
  idea `dropped`; the idea's `done` stays list data. An idea the operator adds is never an item
  until the overseer files it: `sova_idea add` on a `§gap/…` idea already on the list files it as
  a gap, keeping its text ('Filed §gap/x as a gap (the idea was already on the list; its text is
  unchanged).'); a dropped one is refused until its status is set.

## §app.project-overseer/ideas-and-todos — The operator's items

- Ideas (the overseer's and the operator's, `POST …/overseer/ideas`) and to-dos use the Overseer's
  stores and shapes at the project's paths, so the same panels show them. The project page adds
  either from its list, its form opened by **+** on the list's heading (for ideas, also **+ Idea**
  on the Requirements tab's counts line): **Add Item** (a to-do) and **Add Idea** (a title; its id is
  `§idea/<the title's words>`, numbered when taken).
- **The operator's list, not the overseer's work queue.** An idea or a to-do the operator adds or
  changes is not a reason to look, and the overseer's prompt does not list the to-dos: it says
  they are the operator's own list, read with `sova_todos` (operator turns only) when the operator
  asks. It reads or acts on one of the operator's to-dos or ideas only when the operator asks it to
  in their own message. It never starts a coding session because an item exists: it starts one
  when the operator asks, or, at L3 on its own, to build on a gap's decisions promoted into the
  spec (§app.project-overseer/tools), which its statechart may also start on its own
  (§app.project-overseer/drive). The
  gaps it files itself (`§gap/…`) stay its own working list for gathering
  (§app.project-overseer/gaps).
- Each item offers **Send to person…** (`POST …/overseer/items/send`): a gathering session owned by
  the operator (one person, the operator, or an offer to several), with the public title and first
  question the operator writes (both required, 400 without them, and never taken from the item: they
  are shown to the person as written) and the item as its goal; its links are shown once; and **Start coding session** (`…/items/code`): an ordinary session in the
  project, in its own worktree (§app.project-overseer/coding-worktrees) and the project's coding
  mode (§app.project-overseer/coding-mode), with the item as its first prompt. Either links the item to the session it started.
- The to-do field takes at most 200 characters (`TODO_TEXT_MAX`), the same limit the server
  enforces. A longer first prompt goes through New Coding Session and the composer
  (§app.project-overseer/new-coding-session).

## §app.project-overseer/new-coding-session — A coding session tied to no item

- **New Coding Session** (secondary, terminal icon) sits on the project page's "Coding sessions"
  heading, which is always shown, with "None yet. Yours and the overseer's are listed here." while
  the list is empty. It needs no overseer: it works before Start Overseer.
- `POST /api/projects/:pid/overseer/coding` `{title?, model?, thinking?}` answers 201
  `{path, sessionId, worktree?, note?, modeNotSet?}` (404 for an unknown project). It starts the
  same kind of session Start Coding Session does: in its own worktree and branch
  (§app.project-overseer/coding-worktrees; `sova/coding-<hex>` with no title), on the project's
  coding model and thinking, in the project's coding mode, pinned
  (§app.project-overseer/coding-mode), recorded as an `operator-coding` row (listed under Coding
  sessions as "Started by you", in the sidebar's Builds and the Cost card, never counted by the
  overseer's caps). It links no to-do or idea.
- **No first prompt.** Nothing is sent: the page toasts "Coding session started on sova/{name}."
  (in the root: "Coding session started in the project root.") and opens the session, where the
  operator writes the first message in the composer, with no length limit. A worktree session gets
  Sova's commit paragraph as a note first. Until that message, the session is untitled: its row
  reads "Untitled coding session", and, like any new empty session, only the tab that started it
  lists it; the row's link opens it from any tab. A body carrying `prompt` is refused with 400
  "This starts a session with no first prompt. To send one, start it from a to-do or idea
  (items/code)." and no session is started.
- A mode that can't be set leaves the session started and listed; the page stays and says, under
  the heading, "Started, but its mode could not be set. Set it from the chat's mode menu before you
  send." A refusal (a worktree git refuses, the session not created) says why under the heading,
  ending "No session was started."
- **Not a reason to look.** The overseer is not woken; it sees the session when it next looks,
  through `sova_list_sessions`, labelled "started by the operator".
- **Never swept as an empty husk.** Clean Up's empty-husk sweep skips every session a project's
  statecharts record, so an empty coding session and its row stay until the operator archives it.

## §app.project-overseer/statecharts — The org statecharts: where every lifecycle lives

- **The statecharts are the state.** Every lifecycle and every link of an organization's work is a
  statechart session, and nothing else stores it: the org (its owner), each person (proposed,
  active, left, and a referral), each project (archived, its overseer, its main stakeholder, its
  owner updates, and every WhatsApp send to its people, `outreach/send`, §app.outreach/send), each gathering session (holder, hand-offs, offers and leases, the message
  budget, the reply running, the wrap-up), each decision, each conflict, each project's
  reconciler, each gap (§app.project-overseer/gaps), and each coding session with its worktree and
  branch; and, host-local, this host's hold on the org (attach and commits), each project's
  watch loop (looks, allowances, held items, the pause) and each project's software registry
  (`runtime/<p>`, §app.project-runtime/registry). Routes, pages, the overseers' tools and
  the owner page read the statecharts in memory and answer in the same shapes as before; no route
  reads a state file.
- **Links are set when they are made, never inferred.** A gathering session knows its gap, its
  conflict, the session it came from and who started it (`started {by, overseerId?, why?}` in its
  start data, §app.baton/goal-and-loadout, kept by a gap's gathering and a planned one too); a decision knows its gathering session and its gap; a
  coding session knows its gap and the decisions it builds. Nothing is matched from words.
- **One engine per attached org and per standalone project, one queue each** (§app.projects/standalone).
  The project's statecharts are `project/<p>`, `watch/<p>` and `build/<p>/<s>`, with no org in their
  ids or data; the org's are its own plus `placement/<o>/<p>` (§app.projects/placement, §app.projects/seam).
  Every event for an engine (an operator's act, a tool
  call, a person's message, a timer, an effect's result) is taken one at a time, in order, so what
  a guard reads can't change between the check and the act. A move that reaches other statecharts (a
  person leaving clears the owner, the stakeholder, and moves every baton they hold) is one step:
  all of it happens, or none of it. Timers are part of the statecharts (a lease, a stall, midnight, the
  next look, a hold, the 24 hours between owner updates, the 2-second settle debounce, a wrap-up
  running too long), so a restart loses none of them; one that came due while the server was down
  fires when it starts, in the order they were due. A gathering or coding session whose turn was
  running when the server stopped reads as idle once it starts again, never as still working.
- **In the workspace repo.** The portable statecharts' snapshots are files under `statecharts/` in the org's
  workspace repo, and the transition log is `statecharts/log/<yyyy-mm>.jsonl` there, committed with the
  workspace commits (§app.organizations/workspace-repo); the host-local statecharts live under
  `<stateRoot>/statecharts/<org>/`. One step's snapshots and log rows are written together, through
  a journal, so a crash never leaves half a step. Sova writes no `baton.json`, `decisions.json`,
  `conflicts.json`, `started.json`, `roster.json`, `projects.json`, `org.json`, overseer
  `state.json` or `holder.json`, and no pause list in the attach index.
- **A statechart file that doesn't load** (a hand edit, conflict markers after a pull, an unknown
  version) is a workspace problem, shown as the others are (§app.organizations/org-page: the banner
  and the Workspace tab's dot) as "{file} can't be read: {why}"; so is a journal or a log file that
  doesn't parse; the rest of the org loads, nothing overwrites
  the file, and every act that would reach that session is refused whole with "The workspace repo
  has a problem: {file} can't be read. Fix or restore it, then reload." until **Reload** on the
  problem's banner loads it. People on a share page get the page's usual busy answer, never that
  sentence. So is a session whose snapshot loads but can't resume when the org opens: the rest
  of the org resumes and its past-due timers fire. Reload retries every session with a problem, so
  one that couldn't resume because another session's file was broken clears once that file is
  restored, with no restart. A session whose file can't be read never makes another one a
  problem: an organization whose person's file is broken still opens and acts; that person misses
  the organization's news meanwhile, and after Reload it is caught up. So is a session whose timer fails each time it comes
  due: its timers wait while every other session's fire and every act goes through, until one of
  its own steps succeeds, or Reload gives them another go. A link notification to a session that exists
  nowhere (a host-local watch a clone doesn't carry, a deleted session) is dropped and that session
  is taken off the watchers, never failing the step; an explicit send to one is still refused.
- **The transition log is the history.** One row per event a statechart took or refused: when, which
  session, the event, who (`operator`, `overseer`, `system`, `model`, `person`, and `via:
  "overseer"` for the global Overseer acting for the operator), the configuration before and after,
  what changed, and for a refusal its sentence. It never holds a link token or hash, a contact
  value (`[contact]`), the About text (its hash and length only) or anything a person wrote. The
  overseer's activity list, the Pipeline's timelines (§app.project-overseer/pipeline) and each
  "Last looked" line are read from it.
- **Versions and recovery.** Each statechart carries a version, and a snapshot saved by an older
  version is migrated when it loads, through each version's migration in turn; a statechart change never
  starts sessions fresh. A lost or broken snapshot is recovered from the workspace repo's history,
  never rebuilt from the log (the log is redacted); checking the log against the snapshots is
  §app.project-overseer/log-verify's, and restores nothing.
- **The engine.** `statecharts/` is a ClojureScript project on com.fulcrologic/statecharts: the
  statecharts, and an engine around them (spawning a session from a step, link notifications to the
  sessions that watch another, host invocations for a look, a reply, a wrap-up and a reconcile
  run, effects with results, each run at most once by its key, held effects
  (§app.project-overseer/holds), declared corrections and a free set-state
  (§app.project-overseer/corrections), a durable delayed-event queue, a side-effect-free trial,
  enabled events with the sentence a refused one would get, dump and load with migrations, and at
  most `maxMicrosteps` microsteps per event, else a typed step-limit error and the whole call
  rolled back). Every call is atomic: it changes nothing, or it commits. Before an outside event,
  every timer due at or before it fires first. Its contract is
  `statecharts/src/sova/statecharts/engine/API.md`; the TS host that runs one engine per org is
  `server/org-host/`.
- **The bundle.** `server/vendor/statecharts.js` is its one-file ESM release build, vendored. Only
  `node scripts/build-statecharts.mjs` rebuilds it (a JVM and the Clojure CLI; it refuses
  uncommitted statechart sources, the build is byte-reproducible, `--check` compares a fresh build with
  the vendored file, `--test` runs the CLJS tests). `pnpm build` and `pnpm test` never build it and
  need no JVM. `server/statecharts.ts` types the bundle's API; a step limit surfaces as
  `StatechartsStepLimitError`.
- **The replay.** `server/statecharts-replay.ts` replays traces (`server/fixtures/statecharts/`:
  real ones from the lab, anonymized, and synthetic edge cases) through the shipped statecharts on a
  virtual clock, and its test requires zero unexplained divergences. The transition log is now the
  record a trace is taken from; the old miner is gone.
- **Tested by enumeration.** Each statechart's tests send every act event in every reachable
  configuration under every kind of caller (the operator, an attended turn, L0–L3, paused, an empty
  roster, archived, each limit reached, the global Overseer with and without a confirm card), and
  check that an event is taken exactly when the trial says it would be, and that each refusal is
  one of the documented sentences.

## §app.project-overseer/log-verify — Checking the log against the snapshots

- **Checking the log against the snapshots.** `pnpm statecharts rebuild --verify <org>` replays
  each session's transition log from its start on the current statecharts, in a scratch engine where
  every other session only takes events. It lists each session whose replayed states, links (its
  links and watchers), timers or holds differ from its snapshot, with the first step where the
  replay went another way. A session whose log doesn't reach back to its start is listed too, as
  is one with log rows but no snapshot, or a snapshot but no log rows. It restores nothing and writes nothing; it exits 1 when any
  session is listed.
- The log holds no message text, contact values or About text, so a difference can come from a
  guard that read them: the check is a diagnostic, never a restore. To make the replay possible, a
  log row also carries (scrubbed like the rest) the start data of a session the host started, the
  run a report answers, a set-state's patch, and the engine's own time when `at` was moved on to
  keep it unique.

## §app.project-overseer/drive — What the statecharts start on their own

- **What can be decided from facts and timers, the statechart does.** An act the statechart can decide from
  what its sessions record and from its timers is a transition of the statechart, taken when its facts
  hold, at the project's level in force (§app.project-overseer/autonomy-levels) and never above it,
  never while the project is archived or paused by an attach, and never for a gap on hold
  (§app.project-overseer/pipeline). The model's judgment is kept for what needs it: which gaps
  exist, whom to ask and in what words, what a person meant, an owner area's fit, an update's text.
- **What it starts:**
  - **L1, reconcile**: when a gathering session of a gap ends (done or closed) with at least one
    decision recorded, the project's reconciler is asked to run (§app.requirements/reconciler).
    With Reconcile decisions off, nothing runs and the run's error says why. It reaches no person
    and no code, so it is not held.
  - **L1, a planned gathering**: at L0 the overseer may file a gathering on a gap as a plan (to
    whom, the public title, the question, the goal: `sova_start_gathering` or `sova_offer` with
    `plan: true`), kept on the gap's item; the statechart starts it once the level in force reaches L1. It is
    never started again to the same people after an attempt that ended with no decisions.
  - **L1, closing a superseded gathering**: once a newer gathering session on the same gap to the
    same person is open, the statechart closes its own older one that nobody wrote in.
  - **L2, promotion**: a gap's drafted decisions whose authors own their owner area are promoted
    (§app.requirements/promotion); one out of its author's area is never, and waits for the
    operator.
  - **L3, a build**: when every live decision of a gap is promoted, none is built, and no coding
    session of the gap is working, starting or held, the statechart starts one
    (§app.project-overseer/coding-worktrees) with a first prompt composed without a model: the
    decisions' record ids and statements, and the commit paragraph.
- **It also keeps doing what Sova did on its own before**, at any level: a person leaving and what
  follows, clearing the owner and a main stakeholder who left, a lease lapsing, the message limit
  handing a session to the operator, a wrap-up and its time limit, a settle session's decision
  reconciled after 2 seconds, re-routing closing the old settle session, held items released,
  stall reasons, looks, commits and pushes. These are never held.
- **Counted like the overseer's own.** A statechart-started act counts on the same day's allowance as
  the overseer's runs on its own and stops at the same at-once limits
  (§app.project-overseer/limits): refused, or held, the same way, and logged. A promotion counts
  promotions, a build a coding session started (and the coding sessions running), a planned
  gathering a gathering session started (and the gathering sessions open); a reconcile request and
  closing a superseded gathering count nothing.
- **Held first.** Of these, the acts that reach a person or the client's code (a gathering started
  or closed, a promotion, a build) wait in a hold first (§app.project-overseer/holds).
- **Merge stays the operator's.** No statechart and no model merges a branch or removes a worktree
  (§app.project-overseer/coding-worktrees).

## §app.project-overseer/holds — Acts that reach people or the code wait first

- **What is held.** An act that reaches a person or the client's code — starting a gathering
  session or an offer, closing one, promoting decisions, starting a coding session or sending one
  a prompt, posting an owner update, messaging a person on WhatsApp (§app.outreach/send),
  approving or declining a referral, publishing a preview link (§app.project-overseer/previews) —
  waits in a **hold**
  before it is done, when a statechart starts it on its own (§app.project-overseer/drive) or the
  overseer's own tool call makes it in a run the operator did not start
  (§app.project-overseer/autonomy-levels). Never held: acts in a turn the operator started, the
  operator's own clicks, and what Sova did on its own before (a person leaving and what follows, a
  lease lapsing, the message limit, a re-route closing the old settle session, a wrap-up). A
  reconcile run reaches nobody and is not held, and neither is turning a preview link off, which
  only takes something away.
- **Checked when held, and again when it goes.** An act is held only if it passes every guard then
  (the level in force, archived, paused, whether the statechart can take it, the at-once limits, the
  allowance left); refused then, it is refused at once and nothing is held. When the hold ends it
  goes ahead unless it was cancelled, or, for a kind the overseer must confirm, keeps waiting
  until it does (§app.project-overseer/reviews); it goes through every guard again with what holds at that moment: one
  now refused (the level lowered, the project archived, the gap put on hold, a limit reached) is
  dropped and logged with its sentence. An act counts against its allowance only when it is taken;
  a cancelled or dropped hold counts nothing. What the act then did is its own outcome, not the
  release's: a WhatsApp message that is refused or fails when it goes is "not sent", with its reason,
  to the overseer's `sova_hold` approval, its feed and Needs you (§app.outreach/send).
- **How long.** `holdMin` in the project's `overseer.json`: a whole number of minutes from 0 to
  1440, default 10; 0 means nothing is held and each act goes ahead at once. `PATCH …/overseer
  {holdMin}` refuses any other value whole, 400, "The hold must be a whole number of minutes from 0
  to 1440 (0: no hold)."; a hand-edited bad value reads as 10, one over 1440 as 1440. `GET` and
  `PATCH …/overseer` answer it in `settings.holdMin`. A change applies to acts held from then on;
  an act already held keeps the time it was given. The hold is a statechart timer: a restart neither
  loses nor extends it.
- **Seen and cancelled by the operator.** Each held act is an act-tier item in Needs you
  (§app.overseer/attention-digest), kind `held-act`, with no phone notification: "{what} starts in
  {n} min unless you cancel it." (`what` names the act, whom it reaches and about what, never a gap's id: "A gathering with Sam
  Okafor: Pricing tier names", "A gathering with you: …", "An offer to 3 people: …", "A coding
  session for {gap title}"; an act that reaches no one keeps the statechart's own words). The Organizations region's Needs you lists them first, soonest
  on top, each a row naming the project, the sentence recounted as time passes and the org, opening
  the project page, with **Cancel** beside it; the project page's Pipeline card lists the
  project's held acts first, under "Waiting to start", soonest first, the go-ahead time as each
  one's title ("Goes ahead at {stamp}."), each with **Cancel** ("Cancel: {what}"); the operator's Cancel needs no reason. Once its time is up and until it has
  gone, a held act's row reads "{what} is starting now." instead. Cancel (`POST /api/projects/:pid/held/:holdId/cancel`)
  drops it and it never runs; it says "Cancelled. {what} won't happen.", or the server's sentence
  when it can't (404 for an unknown hold; 409 once it already went ahead), and Needs you is read
  again at once. A held act's id is its session's id and the statechart's hold id (`<session>:<hold>`),
  so two acts held with the same statechart hold id in different sessions are told apart: the Pipeline
  and Needs you list both, and Cancel cancels only the one it names. The overseer's `sova_hold`
  takes that id; it also takes a bare statechart hold id while that id names one held act of the
  project, and otherwise refuses (409, "Several held acts are {id}: name one by its id from
  sova_pipeline ({full ids})."; 404, "No held act {id} in this project: sova_pipeline lists
  them."). The item goes when the act goes ahead, is dropped or is cancelled. The org card's
  Needs-you line counts them ("{n} held act(s)"), and so does the org page's Projects tab dot.
- **Seen and cancelled by the overseer.** Every look lists the acts held for its project, and a
  tool reads them (§app.project-overseer/statechart-tools). The overseer may cancel one with a reason (a
  declared correction, §app.project-overseer/corrections); the reason is logged and shown on the
  gap's timeline.
- **Merging a branch** is never held and never started by a statechart or a model: it stays the
  operator's (§app.project-overseer/coding-worktrees).

## §app.project-overseer/reviews — The overseer's feed, and the acts it must confirm

- **The feed.** Every move of a statechart session of the project (a gathering, a decision, a
  conflict, the reconciler, a gap, a coding session, the project itself) that changes where
  something stands or reaches a person or the code, and every refusal, correction and held act,
  reaches its overseer as a typed feed entry: when, which session, the event, who moved it, the states before and after, and
  the effects it asked for, redacted exactly as the transition log is (no contact value, no link,
  no About text, nothing a person wrote; §app.project-overseer/statecharts). Its next look lists the
  entries since the one before, as data, never instructions, after the project's held acts (those
  waiting for its approval first), and `sova_pipeline` reads them. Every transition of every statechart
  declares whether it is fed or quiet; quiet ones (a timer re-armed, a lease renewed, a stall clock,
  the reconciler's own steps, the hourly commits and pushes, bookkeeping) are logged all the same,
  and `sova_pipeline` returns them too, marked quiet. A move alone never wakes the overseer.
- **The acts it must confirm.** The project's overseer settings, next to the level,
  carry a checklist of the kinds of act that need the overseer's confirmation (`confirmKinds` in
  `overseer.json`): starting, offering or closing a gathering session,
  promoting, starting or prompting a coding session, an owner update, messaging a person on
  WhatsApp, approving or declining a referral, publishing a preview link (`gather`, `offer`,
  `close`, `promote`, `build`, `prompt`, `owner-update`, `send`, `roster-approve`,
  `roster-decline`, `preview`, in that order). Every kind is on by default. `PATCH …/overseer
  {confirmKinds}` refuses anything but a list of those kinds (400, "confirmKinds must list act
  kinds from: gather, offer, …"); a hand-edited value that can't be read reads as the default, and
  an unknown kind in it is dropped. The file also records the kinds that existed when the list was
  saved (`confirmKindsKnown`); a kind added since is on, as every kind is by default, so a list
  saved earlier never leaves a new kind unconfirmed: a list with no `confirmKindsKnown` could
  choose every kind but `preview`, so `preview` is on for it and the rest (`send` included) read as
  saved. Nothing is rewritten to do this: the file keeps what was saved until the next save. The
  list is stamped on every act of the project, as read at that moment.
  On the page, right after the level picker, it is "Waits for the overseer's approval": a summary
  line ("All {n} wait for its approval." · "{k} of {n} wait for its approval: {labels}." · "None
  waits for its approval.") with **Edit**, which opens the hint "When one of these is held, it goes
  ahead only once the overseer approves it; you can cancel it in Needs you. The rest go ahead when
  their hold ends." and one toggle per kind (**Done** closes it), in the server's order: Starting a gathering, Offering a gathering, Closing a
  gathering, Promoting decisions, Starting a coding session, Prompting a coding session, Owner
  updates, Approving a proposed person, Declining a proposed person, Publishing a preview link. Each tick saves at once
  (`PATCH …/overseer {confirmKinds}`) and says "{label}: waits for the overseer's approval once its
  hold ends." or "{label}: goes ahead when its hold ends."; a refusal shows the server's sentence.
- **Waiting for it.** A held act (§app.project-overseer/holds) of a kind on the list raises a
  typed review reason in the watch loop, due inside the hold, naming the held act by its full id
  (`<session>:<hold>`), so the overseer looks
  (§app.project-overseer/watch-loop). The look lists it with the statechart's next automatic moves and
  when they are due, and every held act of the project. The overseer approves it — a declared
  correction, with a reason, that releases it now through every guard, as if its time had come —
  or cancels it with a reason. Unanswered, it does not go ahead when its hold ends: it keeps
  waiting in Needs you, with a clock of how long it has waited since then, until the overseer
  answers or someone cancels it: "{what} is waiting for the overseer's review, for {how
  long}. It goes ahead only when the overseer approves it; you can cancel it." The operator's own control
  there is Cancel. An act of a kind not on the list goes ahead when its hold ends,
  with no review.
- The declared corrections stay the overseer's at any time (§app.project-overseer/corrections).

## §app.project-overseer/corrections — The overseer corrects a statechart, within declared bounds

- **Declared corrections.** Each statechart declares the corrections it accepts, each with its own
  guard, the level it needs and a required reason. A held act is cancelled or approved (released
  now) with `sova_hold` (L0; §app.project-overseer/holds, /reviews); every other correction goes
  through `sova_correct {session, correction, reason, …}`, on this project's sessions only:
  - reopen a done gap (back to deciding; L1);
  - skip a stall: a gap stalled while starting a gathering or a build goes back to where it came
    from (L1);
  - re-link a gathering or coding session to another gap of the same project (L1);
  - record a coding session's branch as merged by a given commit, when git can't be read (L2);
  - clear the reconciler's failed run so it can run again (L1).
  A correction without a reason is refused with "A correction needs a reason: say why."; one its
  guard or the level refuses changes nothing and says why. Taken or refused, it is logged with its
  reason, and the gap's timeline shows it (§app.project-overseer/pipeline).
- **Free corrections only in the operator's turn.** Setting a statechart session to any configuration
  it has (its states and data, running what leaving and entering them runs) is `sova_set_state
  {session, states, reason}`, allowed only to the project overseer in a turn the operator started
  (§app.project-overseer/autonomy-levels), with a reason, logged; never to the global Overseer.
  Anyone else is refused: "Setting a statechart's state directly is allowed only to the project overseer
  in a turn the operator started. Use one of its declared corrections." A run on its own may use only the declared corrections, and the operator's page
  has no such control.

## §app.project-overseer/statechart-tools — The overseer reads its project's statecharts

- `sova_pipeline` (read) lists the project's gaps — each one's phase, time in that phase, whether
  it has stalled, and its gathering sessions, decisions and coding sessions — its held acts, and
  the project's feed (§app.project-overseer/reviews; the quiet moves too, on request); and, for one
  statechart session, its configuration, the events it would take now with, for each it wouldn't, the
  sentence that would refuse it, and the corrections it declares. These
  tools read only; they never show a contact value, a link or
  the About text.
- It may start a statechart session its level allows (a gap's item, for a gap it files), and correct
  one (§app.project-overseer/corrections).

## §app.project-overseer/pipeline — The project page's Pipeline

- **A card on the Requirements tab.** The project page has a **Pipeline** card on its
  Requirements tab (§app.organizations/project-page), shown while it has a row or a held act: one row for each gap the overseer filed (§app.project-overseer/gaps), from the
  gaps' statecharts (`GET /api/orgs/:id/projects/:pid/pipeline`, while placed), re-read every 10 seconds while the tab
  shows and reconciled in place, so an open timeline and focus survive. The project's held acts
  come first, under "Waiting to start" (§app.project-overseer/holds). A line under the title counts
  the rows: "{n} gap(s) open · {n} stalled · {n} on hold · {n} done.", leaving out parts that are
  zero. With no gap and no held act the card is left out and the tab's counts line names it.
- **Each row**: the gap's title; its stage as a chip (Open, Gathering, Deciding, Promoted, Done,
  On hold), warn when its state needs the operator, is in conflict or was edited in the spec, error
  when its build failed, accent with the live dot while a build works; beside it the state in
  words: Nobody asked yet, Starting a gathering, Asking, Needs you, Not compared yet, In conflict,
  Ready to promote, Edited in the spec, Waiting for a build, Starting a build, Building, Built, not
  merged, Build failed, Merged, not yet verified, Built and verified, On hold (a state it doesn't
  know reads as its own words). A gap reads Needs you only while one of its gatherings waits on the
  operator (it is with them and they haven't replied); once they reply it is back to Asking, and
  the Needs-you stall clock stops. Then a line "{state} · for {duration} · §gap/<name>" ("just now" under a
  minute); a **Stalled** warn chip once it waited past the stall time in one state (3 days, not a
  setting), titled "Waiting past its stall time: {state} for {duration}. The overseer was asked to
  look." (without "for {duration}" under a minute); and, while on hold, "Resume puts it back where it was: {state}."; while a follow-up gathering on the
  gap runs, "A follow-up gathering is asking." or, in warn, "A follow-up gathering needs you."
- **Order**: what waits on the operator or failed first, then stalled ones, then in pipeline
  order, on hold after, done and dropped last; ties, the longest in its state first, then title.
- **Its sessions**, each a row of at least 44px: every gathering session of the gap (Gathering,
  "With {holder}", Open, Needs you, Done or Closed), every coding session (Build: Working, Last turn
  failed, No commits yet, Not merged, Merged, New commits since merge or Idle; one whose mode could
  not be set, and so was never prompted, shows "Started, but not prompted: its mode could not be
  set." under its link, in warn), each a link, or its
  words with no link, titled "On another host", when it is on another host; and its decisions as
  one disclosure ("Decision" or "{n} decisions", with "{n} promoted, {n} drafted…" in the Decisions
  card's words) listing each statement with its state, a press bringing that decision's row on the
  Decisions card into view and focusing it.
- **Hold Gap / Resume Gap** ("Hold {title}" / "Resume {title}"; the operator's, shown only when the
  gap's statechart would take it, `POST …/pipeline/:itemId/hold` or `…/resume`): on hold, nothing starts
  for the gap, on its own or by the overseer, until Resume puts it back in the state it was in.
  Done, it says "{title} is on hold. Nothing starts for it until you resume it." or "{title} is
  back where it was: {state}."; refused, the server's sentence (409) under the title: "{gap} is already on
  hold.", "{gap} is not on hold.", or, for a dropped gap, "This idea was dropped; dropped is final.
  File a new idea instead."
- **Timeline** (a toggle on each row, `GET …/pipeline/:itemId/timeline`, `?quiet=1` adding the quiet moves): every move of the gap
  and of its sessions that its overseer's feed carries (quiet ones are left out,
  §app.project-overseer/reviews), from the transition log (§app.project-overseer/statecharts), newest
  first,
  each with its time ("14:06" today, "Mar 4 14:06" before, with the year when it isn't this year),
  what happened as a sentence (each statechart event has its own: "The overseer filed this gap.", "A held
  act waits for the overseer's review.", "A person was sent a WhatsApp message.", "The session was retired: the project keeps the 200
  sessions it started most recently, and this one was finished."; the project's running copies
  (§app.project-services/callers) have two, `services/down` "A running copy of the project was
  stopped." and `services/run` "A running copy of the project was started or changed.", and its
  shares one, `services/share` "A running copy of the project was shared."; a move with no sentence is
  quiet, never a raw event name), who (You, You via the Overseer, Overseer, Sova, or a person's name), the
  move ("{from} → {to}"), and "Reason: …" for a correction or a cancel, "Refused: …" for a refusal.
  With none: "Nothing has moved yet."
