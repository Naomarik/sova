# §teams/defaults — Team defaults
> Part of the Sova design spec · [overview](../design/overview.md)

A team created with `team_create` (pi-config's subagents extension, in the TUI or in a runtime
Sova hosts) can get two standing members from its parent chat's effective subagent profile
(§chat.subagent-profiles/resolution), instead of from the calling model's arguments: a **coordinator** that does no implementation and is the only member that talks to the
main thread, and a **monitor** that watches the team's context and provider usage on a timer.
Settings → Subagents edits these choices together with a members default; it is their only
editor (§chat.subagent-profiles/settings). Nothing here depends on Sova running.
`team-defaults.json` remains the legacy seeding/fallback input. Off configures neither standing
role nor members default; it does not remove workers already running.

## §teams.defaults/file — The file, and what absent or malformed means

- **Where.** The effective team's section comes from the parent chat's current subagent profile,
  resolved by `subagent-profiles.ts` (§chat.subagent-profiles/resolution). The legacy input is
  `<agent dir>/team-defaults.json`, with `PI_CODING_AGENT_DIR` when set (a leading `~` expanded),
  else `~/.pi/agent`. The session stores an ID pick, not a settings snapshot; profile edits reach
  later team actions. Explicit member/call tuple choices are stored separately for succession.
- **Shape (version 1).** `coordinator {enabled, role, primary, fallback, instructions}`,
  `monitor {enabled, role, primary, fallback, contextPct, everyMinutes, usage {enabled, pausePct,
  resumeMarginMinutes}, instructions}`, `handover {retireTimeoutMinutes}`. A worker tuple is
  `{backend, model, effort?}`; `fallback` is a tuple or `null`. A key the file leaves out takes
  the built-in default (coordinator `claude-code`/`claude-opus-5-5`/`medium`, monitor
  `pi`/`ollama-cloud/deepseek-v4.1-flash` with fallback `claude-code`/`claude-sonnet-5-5`/`low`,
  each Claude model its family's current one in Sova's catalog, §app.claude-code-provider/catalog; context 60 %,
  every 10 minutes, pause at 90 %, resume margin 5 minutes, retire after 10 minutes); a key it
  states must be valid.
- **Strict.** Anything else is **malformed**: unparseable JSON, a version other than 1, an
  unknown key, a wrong type, a backend other than `pi` or `claude-code` (only those load member
  tools), a pi model not in `provider/id` form, an effort outside
  `off|minimal|low|medium|high|xhigh|max`, a role that is blank, over 64 characters, multi-line,
  shaped like a worker ID, or equal (case-insensitively) to the other role, a percentage outside
  1–100, `everyMinutes` or `retireTimeoutMinutes` outside 1–1440, `resumeMarginMinutes` outside
  0–1440, or instructions over 4,000 characters. The reader returns every error, not the first.
- **When it is read.** The parent branch's effective profile is resolved fresh at every `team_create` and `team_add`, at every `team_roster` answer
  to a coordinator or monitor (the monitor's thresholds), at `team_succeed` (the retire timeout),
  and for `/team defaults` and `/team <objective>` planning. A change applies to the next of these, never to a member already
  running.
- **No effective teams section = off.** Off or a profile with `teams: null` adds no coordinator
  or monitor. Only when resolution uses the legacy files does an absent `team-defaults.json`
  determine this; an absent library seeds from the legacy values first.
- **Malformed legacy defaults = off, visibly.** When resolution falls to a malformed legacy
  file, the team is created as if that file were absent, and the
  `team_create`/`team_add` result carries a warning line naming the file and its errors. The
  extension never writes, repairs or overwrites the file.
- **One reader.** `pi-config/extensions/subagents/team-defaults.ts` holds the types, the
  defaults, the strict parser, the reader and an atomic writer (temp file + rename, refusing a
  value that does not parse); it imports only Node built-ins, so Sova's server can import it.

## §teams.defaults/coordinator — The coordinator is enforced in code

- **When.** At `team_create`, when the chat's effective teams section is valid,
  `coordinator.enabled` is true and the call
  does not pass `defaults.coordinator: false` (the per-team escape hatch; `defaults.coordinator`
  and `defaults.monitor` must be booleans, anything else is refused before any worker starts).
- **An orchestrator the caller named is the coordinator.** If exactly one member has
  `orchestrator: true`, it becomes the team's coordinator and nothing is synthesized. More than one
  orchestrator in a coordinated team is refused, at `team_create` and at a `team_add` to a team
  that has a coordinator, and never turned into a plain member silently. The refusal says that
  only the coordinator is the orchestrator, that it hands a member (itself included) over to a
  successor with `team_succeed`, that a member that only watches the team needs no orchestrator
  mark, and that the main chat can start a replacement coordinator once none is live
  (§teams.defaults/handover).
- **Otherwise one is synthesized**: a member with role `coordinator.role`, `orchestrator: true`,
  on the first tuple that passes the same checks a spawn applies — the backend is loaded, the
  model policy (`model-policy.json`, subagent dimension included) allows it, and the pi model is
  in the session's registry or the backend's own validation accepts it. The primary is tried, then
  the fallback; a primary that ran out of usage within the hour fails the checks
  (§teams.defaults/runtime-fallback), and a coordinator whose primary fails at runtime moves to
  the fallback there. If neither passes, **the team is not created**: the error names both tuples and
  their reasons, and suggests fixing Settings or passing `defaults.coordinator: false`. A caller
  member that takes the coordinator's role without being the orchestrator is refused the same way.
- **What the result says.** One line per synthesized member: role, backend/model/effort, and
  whether it is the primary or the fallback (with the primary's denial). One line names the
  standing roles Sova added to the team (or that it added none) and each one turned off, and by
  what: the chat's settings, or the call's `defaults.coordinator` / `defaults.monitor: false`.
- **It does no implementation.** Its header says so: it routes and unblocks the work the main
  thread assigned, verifies and reports, and never edits files itself. It keeps
  `team_roster`/`team_steer` and gains `team_report` and `team_succeed`; it still cannot add or
  stop arbitrary members.
- **It sees every teammate's assignment.** Its header lists each other member (the monitor aside)
  with the task the main thread gave it — the member's prompt, cut after 1,500 characters with a
  marker giving the remaining length and telling it to ask that member for the rest — and its
  `team_roster` repeats them with every steer or follow-up the main thread sent that member,
  newest last: up to 40 are kept (each up to 2,000 characters; past 40 the oldest are dropped and
  counted), and the roster shows the first 500 characters of each. A successor inherits its
  predecessor's assignment and all of those steers; a coordinator's successor sees every
  assignment in its own header. **Across a reload:** each assignment (up to 8,000 characters),
  each kept steer and each successor's inheritance are also appended to the parent session as
  `subagents-team-assignment-v1` custom entries and replayed, in order, onto the branch's recorded
  teams at `session_start`, so once a member of such a team is back (picked back up or `agent_resume`d) the roster and any later successor still have them. Where none was recorded,
  the roster says the assignment is not known and to ask the member.
  When the main thread adds members with `team_add`, the routing coordinator is sent a `notice`
  item (§app.teams/inbox) naming each new member and its assignment, and the `team_add` result
  says it was queued for the coordinator (or, with no live coordinator, that it could not be).
- **It does not invent or countermand work.** Its header and task say: never invent tasks, never
  reassign or cancel a teammate's assigned work, never tell a teammate its task was not assigned;
  the main thread's steers and follow-ups to members are legitimate assignments, and it never
  tells a member that work from the main thread is not its work — a successor's inherited
  instructions included, which are the successor's assignment — and checks `team_roster` before
  telling a member what not to do. Wherever it reads a member's main-thread steers (its header,
  `team_roster`, and the handover message naming a successor, which lists the inherited ones
  unasked) they sit under one label: "Later instructions from the main thread (binding: part of
  <role>'s assignment[, including any inherited from <old role> (<ag_NN>)]; never tell <role>
  they are not its work), newest last"; direct a
  teammate only where it is blocked or its assignment leaves a gap, and ask the operator with
  `team_ask` when the objective seems to need work nobody was given.
- **Succession and pauses.** When the monitor flags a member over its context threshold and that
  member's assigned work is not verifiably finished, the coordinator calls `team_succeed`; it
  declines only if the member has already completed its assigned task. On a monitor `pause` it
  has the working teammates wrap up and reports the pause to the main thread with `team_report`;
  on `resume` it restarts them and reports the resume the same way.
- **Scope.** A team's coordination is fixed at `team_create`. `team_add` never retrofits a
  coordinator onto an uncoordinated team; members added to a coordinated team are routed like the
  others. There is no per-call limit: a synthesized coordinator and monitor count only toward the
  chat's running limit (§app.teams/running-limit), whose refusal names them.

## §teams.defaults/routing — Only the coordinator talks to the main thread

In a coordinated team the **routing coordinator** is the newest live member with the coordinator
duty (a successor takes over from its predecessor the moment it starts).

- **Wake.** Every member except the coordinator is spawned with `wake: false`.
- **Completions.** When any other member settles, its completion (the same summary the parent
  would get) is queued for the routing coordinator as a `report` item in its inbox
  (§app.teams/inbox; urgent when the task failed), not sent to the parent. A killed
  member's completion goes nowhere. The monitor's own settles go nowhere (it settles after every
  check); only a failed monitor task is reported to the coordinator, except a failure that moves a
  standing member to its fallback or stops it, which is said once instead
  (§teams.defaults/runtime-fallback).
- **Questions.** Another member's `team_ask` is queued for the routing coordinator as a
  `question` item, which it answers with `team_msg` and `replyTo` set to that item; the member is
  told it was queued for the coordinator, with the item's id. The monitor has no `team_ask`.
- **The coordinator's own completion** goes to the parent as `subagent-complete`, starting a
  parent turn only when no other member (the monitor aside) is working — an interim "waiting on
  the builder" does not wake the parent; a quiescent team does.
- **No live coordinator.** If the team's coordinator has ended and no successor is live, routing
  falls back to the parent: completions and questions reach it in the main chat's own queue, as
  before, and a completion then
  starts a parent turn despite `wake: false`, so the team is never silently orphaned.
- **Headers.** Each non-coordinator member's header names the coordinator role and says its final
  answer and its questions go there, not to the operator.
- **What `team_create` and `team_list` tell the caller.** For a coordinated team neither carries
  the generic "questions arrive here as team-question messages" paragraph: they say members'
  `team_ask` questions go to the coordinator, and only the coordinator's `team_ask` (a
  `team-question`) and `team_report` reach the main thread. A `team_list` covering coordinated and
  uncoordinated teams gives both paragraphs, each labelled with the teams it applies to.
- **Keep the standing members while work runs.** The `team_create` result for a coordinated team,
  its `team_list` entry and the tool's guidelines tell the main thread not to stop (`agent_kill`)
  the coordinator or the monitor while any member is still working — even when the coordinator
  reports the objective complete — and that stopping them once no member is working is fine.

## §teams.defaults/team-report — Milestones reach the parent without asking for action

The coordinator's `team_report { report, kind? }` sends the parent a custom message of type
**`team-report`** (displayed, delivered as a follow-up, **no turn started**), beside the existing
`team-question` (which starts one). `kind` is optional and is `milestone` or `concern`; anything
else is refused (on both backends). The text's first line is `[Team report from coordinator <role>
(<ag_NN>), <team_NN> — <team name>]`, with ` · <kind>` before the closing bracket when a kind was
given; then the report; then a blank line and `(Informational: no action is requested. The
coordinator asks questions as team-question messages.)`. Only a member with the coordinator duty
has the tool; the parent refuses it from anyone else. Each report is a team action row
(`report`).

## §teams.defaults/monitor — A monitor member on a timer

- **When.** In a coordinated team whose chat's effective teams section has `monitor.enabled` and whose `team_create` did not
  pass `defaults.monitor: false`. It is synthesized with role `monitor.role` on the first tuple
  that passes the spawn checks (primary, then fallback; a primary that ran out of usage within the
  hour fails them); if neither passes, the team is not created. An uncoordinated team gets no
  monitor, and the result says why. A monitor whose primary fails at runtime moves to the
  fallback, or is stopped when none can run, and a failed check that doesn't move it has its next
  check scheduled by the parent (§teams.defaults/runtime-fallback).
- **Tools.** `team_msg` (with an optional `notice`: `wrap-up`, `pause` or `resume`), `team_inbox`,
  `team_roster` (read-only) and **`wake_nudge`**, through the member extension (a claude-code monitor is a pi worker on
  the Claude Code provider, so the same). No other member has `wake_nudge`; the
  monitor has no `team_ask`, `team_steer`, `team_report` or built-in tools, and it can never reach
  the parent.
- **Standing instruction** (its header, with the effective thresholds at spawn; subsequent
  roster answers and pause/resume checks resolve the chat's current profile): at each wake, read
  `team_roster`; a member whose context is at or above `contextPct` % of its window is told
  (`notice: wrap-up`) to finish its current step, write its handover note, and end its turn, and
  the coordinator is told too so it can start a successor. When usage checking is on and a
  provider a team member uses is blocked, it tells the coordinator (`notice: pause`) to have the
  whole team wrap up and go idle, then schedules `wake_nudge` for that window's reset plus
  `resumeMarginMinutes` (at most 24 h ahead, re-checking if the reset is later); on that wake,
  once that window's reset plus `resumeMarginMinutes` has passed, it tells the coordinator
  (`notice: resume`) to resume the team. A login is out when one of its non-weekly windows (such
  as `5h`) is at or above `pausePct` % or one of its weekly windows (a label starting `7d`) is at
  100 %; a weekly window below 100 % is informational and never a reason to pause. A provider is
  blocked only when every one of its logins is out: Claude counts Claude Code's own login and each
  added login this host has a reading for (one needing sign-in is not counted), so while any of
  them has headroom the team keeps working; every other provider is one login.
- **An early resume is refused.** The parent does not trust the monitor's clock reading: at a
  `pause` notice it records, for each blocked provider of the team, the blocking windows of the
  login that frees soonest (the one whose latest blocking reset is earliest), and until the
  latest of those resets plus
  `resumeMarginMinutes` (read at the resume) has passed, a `resume` notice is refused — nothing is
  delivered and no event is written — with a reply naming the window, its reset, the time resume
  is allowed from and how long that is, and telling the monitor to schedule `wake_nudge` then. A
  pause recorded with no such window (no cache, no tracked provider) holds nothing. The hold is in
  memory only: a pause restored after a reload has none.
  Otherwise it schedules the next check in `everyMinutes` and ends its turn; it never sleeps in a
  shell. Extra `instructions` from the file follow.
- **No note of its own.** The monitor holds no file tools, so its header names no handover note:
  it hands over over `team_msg` (see §teams.defaults/handover).
- **Notices are records.** A `wrap-up`, `pause` or `resume` notice is recorded as a team action
  of that kind (source `monitor`), and each is also appended to the parent session as a
  `subagents-team-event-v1` entry. Each notice is an urgent `notice` item in its recipient's inbox
  (§app.teams/inbox), so it is never refused or lost. A pause or resume event names the monitor. A
  `wrap-up` event is written once per member the notice was queued for and names that member (not the monitor),
  with `detail` like `context 78% of 200k` (or the tokens alone when the window is unknown, or
  `context unknown`). The monitor also sends `wrap-up` to the coordinator about each flagged
  member; that delivery is an event about the coordinator only when the coordinator's own context
  is at or above `contextPct` %.

## §teams.defaults/wake-nudge — The monitor's timer is held by the parent

A member cannot start its own turn, so `wake_nudge` is a mailbox request the parent serves, with
the wake-nudge extension's semantics: `schedule` (`delay` like `30s`, `5m`, `1h30m`, or an ISO
`at`), `list`, `cancel {id}`; at least 10 s and at most 24 h ahead, `at` up to 60 s in the past is
clamped to 10 s, at most 5 pending. At fire time the parent queues `[wake_nudge nN] Scheduled
wakeup fired … Reason: …` for the monitor as an urgent `notice` item from Sova (§app.teams/inbox),
which wakes it at once if it is idle; a fire is never refused or lost, so no check chain ends
silently.

**An idle team costs no monitor turns.** A nudge that comes due while no other member is working
and the team is not paused (a monitor `pause` notice not yet followed by `resume`) is **held**, not
delivered: one per monitor (later ones collapse into it), shown by `list`, droppable by `cancel`.
It is delivered — marked as held and released — at the parent's first refresh that sees a teammate
working again; every worker state change and every accepted steer schedules one, so the main
thread steering a member or a member starting a task resumes the checks. A paused team's nudges
always fire on time, so the resume check runs while everyone is idle; those fires are bounded:
after 30 consecutive fires with no other member working, scheduling is refused until some member
works again. Pending nudges, held or not, are kept in the team's mailbox and armed again when the parent's session starts after a reload or a restart; a nudge that came due meanwhile fires then. The pause survives one too: a team whose last `pause`/`resume`
event on the active branch is `pause` is paused again at `session_start`, and when its monitor
rejoins (picked back up or `agent_resume`d) with no nudge pending it is sent its resume check at once, as an urgent `notice` item (run `team_roster`; resume if the window is back under the threshold or has reset,
otherwise schedule the check); the `agent_resume` result says so instead of "nothing was sent to
it". No other resumed member is sent anything.

## §teams.defaults/roster-context — Context size in the roster

`team_roster` and `team_list` show each live member's context: `context 123k/200k (61%)` — the
last reply's context tokens as the runner counts them, over the window of the model it was spawned
with (a pi model: the session's model registry; claude-code: its catalog model's window,
§app.claude-code-provider/catalog — 1,000,000 for a natively 1M model such as `claude-opus-5-5`,
200,000 for Haiku 4.5 — the same the session pane uses), rounded down to a whole percent. Unknown parts say so: `context —` before the first
reply, `context 64k/?` without a known window. For a monitor or coordinator, `team_roster` also
carries the parent chat's current effective profile thresholds and, from
`<agent dir>/cache/usage-status.json`, each
provider window the team's members use (percent and reset time, and the cache's age); for Claude
that is every window of every login counted on this host (§teams.defaults/monitor), each line
naming its login, weekly lines are marked informational below 100 %, only windows that block the
provider are marked at or over the pause threshold, and when some but not all logins are out a
line says how many still have headroom and that this is not a reason to pause. A window
whose reset time has passed is shown as reset with its usage unknown (the cached percent predates
the reset) and is never marked at or over the pause threshold, so a stale cache cannot keep a team
paused. A coordinator's roster also lists the assignments (§teams.defaults/coordinator). Each
member's line also carries its open-item count (`3 open items`, §app.teams/inbox) when it has any.

## §teams.defaults/handover — Successors, handover notes and retirement

- **Where notes go.** `<agent dir>/sova/teams/<session>/<team_id>/handoffs/<role>.md`, where
  `<session>` is the parent session's id (reduced to `[A-Za-z0-9._-]`; a session without an id uses
  a key unique to that parent process) and the role is reduced to `[A-Za-z0-9._-]`. Team IDs
  restart at `team_01` in every parent session, so the session id is what keeps two sessions'
  notes apart. The directory is created with the coordinated team; every member's header but the
  monitor's names its own path. The monitor has no file tools and no note.
- **`team_succeed { role }`** — the routing coordinator's tool for any member, and the main
  chat's (below) for a coordinator or monitor only. It starts the successor of that
  member (itself included) through the same spawn path: role `<base>-<n+1>` where an existing
  `-N` suffix is stripped first (`builder` → `builder-2` → `builder-3`; the first free number
  wins), with the same tools, system prompt, cwd, backend options, extensions, ownership and duty.
  Its backend/model/effort follow the chat's current profile at successor spawn, except that
  explicit member or per-call choices remain binding. A standing duty uses its current configured
  tuple: the primary, else the fallback, where a primary marked out of usage counts as refused and a
  team whose duty already moved to its fallback keeps it (§teams.defaults/runtime-fallback); an ordinary successor uses the current members default when applicable. With no usable
  applicable default it keeps the predecessor's tuple, and a denied default is reported as such
  (§chat.subagent-profiles/members-default). Running predecessors do not change model.
- **A replacement from the main chat.** The main chat's `team_succeed { team, role }` (`role` is a
  role or worker ID) starts a successor only for a member with the coordinator or monitor duty,
  only when no member of that team with that duty is live (working, idle or stopping), and only
  for the newest member with that duty; otherwise it is refused, saying why (a live coordinator
  hands over itself; other members are the coordinator's to succeed). So two coordinators are
  never live at once. It is the same successor path: the duty, `successorOf`, the predecessor's
  assignment and every inherited main-thread steer, and its handover note when there is one. The
  old member has ended, so the successor starts at once, the old member's seat is released, and
  the action's source is `parent`. A coordinator's successor routes the team as soon as it starts.
  A coordinator's successor that has no recorded assignment is told to ask the main thread with
  `team_ask`. A team restored from history is refused as `team_add` refuses it.
- **The note comes first.** For a live worker or coordinator, `team_succeed` starts nothing at
  once: the old member is told — as a redirect, so it lands ahead of anything already queued for
  it but never ahead of a delivery in progress, and is never refused because one is in progress
  (or, when the coordinator succeeds itself, in the tool result) — to finish its step, write or
  update its note, do no new work and end its turn, and the coordinator's result says the
  successor will follow. The successor starts as soon as the note file exists, whether or not the
  old member has ended a turn (follow-ups queued on it would keep it from ever settling), or when
  the old member ends, or when `handover.retireTimeoutMinutes` (read at `team_succeed`) pass —
  whichever is first. The routing coordinator is then sent a `handover` item (§app.teams/inbox)
  naming the successor and the true reason it started, judged from whether the note exists at that moment: the note is
  written; the member ended after, or without, writing it; the wait timed out; or the wait ran out
  just as the note appeared. The old member is told, again as a redirect, that its successor has
  started, to stop any work in progress, and to answer its questions. A member already ended when
  `team_succeed` is called, and a monitor, are succeeded at once.
- **A reload drops a handover still waiting.** A handover whose successor has not started yet
  (waiting for the note, for the old member to end, or for the retire timeout) is kept in the main
  chat's memory only, so a reload of the main chat drops it: no successor starts and nothing is
  sent. The old member keeps running and keeps its open inbox items (§app.teams/inbox); nothing on
  disk is lost, and the items move only when a later handover completes, or are returned when the
  member ends. Calling `team_succeed` again starts the handover over (the old member is told
  again); when its note is already written, the successor starts within a second.
  A handover whose successor has started but not yet called `team_ready` is dropped the same way:
  the old member is never retired by itself and keeps its seat, and the successor's `team_ready`
  is refused as having no handover pending. The successor link survives the reload (the
  successor's record keeps `successorOf`), so messages to the old member still reach it while it
  runs and are forwarded to the successor once it ends, and when it ends its open items move to
  the successor instead of returning to their senders. To finish such a handover, the main chat
  stops the old member with `agent_kill`, then releases its seat with `team_eject`.
- **Follow-ups still queued on the old member.** They are not removed: there is no
  backend-neutral way to clear a worker's queue, so they stay queued and run after the redirects.
  The successor already has every one of them among its inherited main-thread instructions, and
  the old member is told, in both redirects, that its assignment and every main-thread instruction,
  queued ones included, are its successor's now: not to act on them, and to reply only that its
  successor has them.
- **What the successor is told.** A worker's or coordinator's successor starts from the handover
  note: continue from the state it records, do not redo steps it marks done, verify them cheaply
  (`ls`, a quick grep, the tail of a file) instead of re-reading large inputs, and ask its
  predecessor over `team_msg` — at least once when in doubt — before `team_ready`, which retires
  it. Started without a note, it is told the note may be missing and why, and to ask its
  predecessor for its state first (or, if the predecessor has ended, to work it out from the files
  it owned). Its task quotes the old member's assignment and every inherited main-thread steer,
  oldest first, within 12,000 characters (the newest always; older ones counted), as binding —
  what it must get done, though not a script to restart from step 1. The steers are labelled as the
  main thread's, part of its assignment, which nobody on the team can cancel; if anyone tells it
  one is not its work, it still is: it replies that it came from the main thread and does it. **A monitor hands over by
  `team_msg` only**: its successor's task is the monitor task, prefixed with "you take over from
  <old>" (ask it over `team_msg`, call `team_ready`; when the old monitor has already ended, it is
  told so instead: nobody is left to ask and there is no `team_ready` to call), and the old monitor is told to brief it over
  `team_msg` — its pending nudges, notices sent, whether a pause is in force — and to run no
  further checks; no note is involved. That briefing request is a direct instruction on the old
  monitor's delivery lane, never refused for busyness; if it still could not be delivered (the old
  member is no longer live), the result says so instead of saying it was told. One pending handover per member, and a member still
  taking over cannot itself be succeeded until it has confirmed; the coordinator can start nothing
  else and stop no one. When the coordinator succeeds itself, routing moves to its successor at
  once, only the successor can start further successors, and the old coordinator runs until it is
  retired like any other member.
- **Retirement.** The old member is killed when its successor calls **`team_ready`** (only a
  successor has the tool; a monitor's successor has it too, on both backends), or when `handover.retireTimeoutMinutes` (read at `team_succeed`) pass
  after the successor started, first. **`team_ready` never cuts the old member off mid-turn:** if
  it is in a turn when the successor confirms (it may be answering the successor's question), the
  reply says so and the old member is retired as soon as that turn ends (it settles or exits); the
  retire timeout still applies if it never does. Either way the retirement is a team action row (`retire`),
  as is the start (`handover`). **The retired member's seat is released too:** once it has been
  killed, it is ejected exactly as `team_eject` would (the same persisted `eject` op), with the
  action's source `system`. **Its open inbox items move to the successor** (§app.teams/inbox),
  keeping their ids and senders, and are listed to it; a message sent to the old member after it
  is retired is forwarded to the successor, and the sender is told. A member that had already ended when its successor started — ended
  before `team_succeed`, or while the successor waited for its note — has nothing to retire and
  is ejected the same way as soon as the successor has started. While a handover is unfinished,
  `team_eject` refuses both of its members — the predecessor, whose successor has not started or
  not confirmed, and the successor that has not called `team_ready` — naming the handover and
  saying the predecessor's seat is released automatically.
- **The successor's record.** Its `subagents-team-v1` member record carries `successorOf`: the
  predecessor's worker ID (`ag_NN`). No other member has the key, and a record whose
  `successorOf` is not a worker ID is not adopted.
- **Events.** Handover, retire, wrap-up, pause and resume are also appended to the parent session
  as `subagents-team-event-v1` custom entries (`{version: 1, teamId, kind, workerId, role, at,
  detail?}`, `detail` at most 500 characters), which the team action history — in memory only —
  is not. A handover event is written when the successor starts, names the old member, and its
  detail is `successor <role> (<ag_NN>) on <backend>/<model>; retire on team_ready or after <N> min`.

## §teams.defaults/runtime-fallback — A standing role that fails at runtime moves to its fallback

The primary/fallback choice of §teams.defaults/coordinator and §teams.defaults/monitor is made
again while the team runs, not only when a coordinator or monitor starts.

- **Out of usage.** A failed turn is out of usage when its error says the provider's usage,
  credits, quota, balance or billing ran out, or that a usage limit was reached — a monthly,
  weekly or 5-hour one included — ("usage limit", "hit your limit", "out of usage", "limit will
  reset", quota, credit, billing, insufficient, balance, "monthly limit", "weekly limit"), or that
  its sign-in no longer works (401, 403, "not logged in", `/login`, an invalid API key, a failed
  sign-in or authentication). A plain 429 "rate limit" or "too many requests" is not, nor is a
  quota or limit over a short window — per minute, second or hour, RPM, TPM, "requests per",
  "tokens per" (such as "429 RESOURCE_EXHAUSTED: Quota exceeded for metric x, limit: 15 per
  minute") — while a monthly, weekly or 5-hour limit stays out of usage. Ollama's
  `429: {"message":"you (…) have reached your monthly usage limit, add usage credits: …"}` is. A
  Claude Code member's turn that fails once the bridge has tried every Claude login ends with the
  CLI's own text ("You've hit your limit · resets 3pm", "Claude AI usage limit reached|…", "Not
  logged in · Please run /login") or with "Claude usage limit reached" / "Claude sign-in failed";
  each is out of usage. One classifier decides this, shared with the provider-limits gate
  (§app.provider-limits/rate-limit).
- **When it switches.** A member with the coordinator or monitor duty, in a coordinated team of
  this session, whose turn ends with a failed task (an error; a stop or abort is not one) moves to
  its fallback **at once** when the failure is out of usage, and otherwise when it is its **3rd
  failed turn in a row** (a turn that succeeds starts the count again). A single rate limit or
  blip keeps today's path: its failure is routed as before. It switches only once per member, only
  while that member runs its role's current primary (the backend and model the chat's profile names
  now), and never while a handover involving it is pending; otherwise its failures are routed as
  before.
- **The switch.** The team's duty is recorded as moved to its fallback, and an out-of-usage
  primary is also marked out for the chat (below); the member is stopped and its seat
  released (the persisted `eject` op, source `system`) before its successor is added, so a team
  with all 24 seats taken still gets it. The successor starts at once through the main chat's
  replacement path (§teams.defaults/handover): role `<base>-<n+1>`, the same duty, the
  predecessor's assignment and every inherited main-thread steer, its open inbox items, on the
  fallback. No note is asked for, and there is nothing to retire and no retire timer. The failed
  turn's own completion goes nowhere. A monitor's successor runs its first check at once, then its
  normal timer. A coordinator's successor sees every teammate's assignment in its header, routes
  the team from the moment it starts, and is told its predecessor stopped without a handover note
  and why.
- **What is said.** A `handover` event (`subagents-team-event-v1`) names the old member, with
  detail `successor <role> (<ag_NN>) on <backend>/<model>; fallback: primary <tuple> <reason>`, and
  a `handover` team action row (source `system`) carries the same. When the monitor switched, the
  routing coordinator gets one `handover` item saying so; it gets no `failed` report for the turn.
  In Sova the event reads, in the main chat and the team panel, one line like "Monitor moved to its
  fallback claude-sonnet-5-5: deepseek-v4.1-flash hit its monthly usage limit." (the old member's
  role, capitalized; the models by their own names). In the TUI it is a warning toast.
- **No fallback.** When the role has no fallback, or the fallback fails the spawn checks, nothing
  is started. A monitor is stopped, so it no longer wakes the coordinator: the routing
  coordinator gets one `notice` item and the main chat one displayed `team-notice` message that
  starts no turn, both naming the primary, the reason and that no fallback could run. A
  coordinator is not stopped; the main chat gets one such `team-notice` naming `agent_kill` and
  `team_succeed`, and that turn's completion is not sent. Either is said once per member; later
  failures of that member are routed as before.
- **The out primary is remembered.** Only an out-of-usage failure of a standing member marks its
  running (backend, model) out for the chat — never a streak of other failures — with the reason
  and the time, appended to the parent session as a `subagents-dead-tuple-v1` custom entry (`{version: 1, backend, model, reason,
  at, teamId?, duty?}`) and replayed from all of the session's entries at `session_start`, so a
  reload keeps it. For 1 hour from that time every tuple check treats it as refused, saying it ran
  out and when it is tried again: a new team's coordinator and monitor, the members default at
  `team_create`, `team_add` and a successor, and every later successor's standing tuple. After the
  hour new teams try the primary again. A team whose duty switched, for any reason (a streak
  included), stays on the fallback for that duty: its later successors of that duty skip the
  primary even after the hour. That is the team's alone: a streak switch writes no mark and no
  `subagents-dead-tuple-v1` entry, so other teams, new teams, `team_add` and the members default
  still use the primary; a reload reads the team's switch back from its handover event's
  `fallback: primary <tuple>` detail.
- **A monitor never goes silent.** After a failed monitor turn that does not switch it, when the
  monitor has no pending or held `wake_nudge`, the parent schedules its next check itself, in
  `everyMinutes`.

## §teams.defaults/command — `/team defaults`

`/team defaults` prints the parent chat's effective defaults now — both roles, their tuples,
thresholds and the retire timeout — with profile/file provenance. Off or a profile with no teams
section says it configures nothing/none, never claims a missing legacy file. Legacy resolution
still says `off (no file)` with the path, or the malformed reason. It starts no turn and changes
no pick or default; like other profile readers, its first read may seed an absent library.
