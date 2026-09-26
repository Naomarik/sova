# §teams/defaults — Team defaults
> Part of the Sova design spec · [overview](../design/overview.md)

A team created with `team_create` (pi-config's subagents extension, in the TUI or in a runtime
Sova hosts) can get two standing members from one global file instead of from the calling model's
arguments: a **coordinator** that does no implementation and is the only member that talks to the
main thread, and a **monitor** that watches the team's context and provider usage on a timer.
The file is written by Sova's Settings (§app.settings-dialog/teams, a separate draft) and read by
the extension; nothing here depends on Sova running. Without the file, teams behave exactly as
they did before this surface existed.

## §teams.defaults/file — The file, and what absent or malformed means

- **Where.** `<agent dir>/team-defaults.json`, the agent dir being `PI_CODING_AGENT_DIR` when set
  (a leading `~` expanded), else `~/.pi/agent`. Global: never snapshotted into a session or a team.
- **Shape (version 1).** `coordinator {enabled, role, primary, fallback, instructions}`,
  `monitor {enabled, role, primary, fallback, contextPct, everyMinutes, usage {enabled, pausePct,
  resumeMarginMinutes}, instructions}`, `handover {retireTimeoutMinutes}`. A worker tuple is
  `{backend, model, effort?}`; `fallback` is a tuple or `null`. A key the file leaves out takes
  the built-in default (coordinator `claude-code`/`opus[1m]`/`medium`, monitor
  `claude-code`/`haiku`/`medium`, context 60 %, every 10 minutes, pause at 90 %, resume margin 5
  minutes, retire after 10 minutes); a key it states must be valid.
- **Strict.** Anything else is **malformed**: unparseable JSON, a version other than 1, an
  unknown key, a wrong type, a backend other than `pi` or `claude-code` (only those load member
  tools), a pi model not in `provider/id` form, an effort outside
  `off|minimal|low|medium|high|xhigh|max`, a role that is blank, over 64 characters, multi-line,
  shaped like a worker ID, or equal (case-insensitively) to the other role, a percentage outside
  1–100, `everyMinutes` or `retireTimeoutMinutes` outside 1–1440, `resumeMarginMinutes` outside
  0–1440, or instructions over 4,000 characters. The reader returns every error, not the first.
- **When it is read.** Fresh at every `team_create` and `team_add`, at every `team_roster` answer
  to a coordinator or monitor (the monitor's thresholds), at `team_succeed` (the retire timeout),
  and for `/team defaults` and `/team <objective>` planning. A change applies to the next of these, never to a member already
  running.
- **Absent = off.** No file: no coordinator, no monitor, no routing — today's behaviour exactly.
- **Malformed = off, visibly.** The team is created as if the file were absent, and the
  `team_create`/`team_add` result carries a warning line naming the file and its errors. The
  extension never writes, repairs or overwrites the file.
- **One reader.** `pi-config/extensions/subagents/team-defaults.ts` holds the types, the
  defaults, the strict parser, the reader and an atomic writer (temp file + rename, refusing a
  value that does not parse); it imports only Node built-ins, so Sova's server can import it.

## §teams.defaults/coordinator — The coordinator is enforced in code

- **When.** At `team_create`, when the file is valid, `coordinator.enabled` is true and the call
  does not pass `defaults.coordinator: false` (the per-team escape hatch; `defaults.coordinator`
  and `defaults.monitor` must be booleans, anything else is refused before any worker starts).
- **An orchestrator the caller named is the coordinator.** If exactly one member has
  `orchestrator: true`, it becomes the team's coordinator and nothing is synthesized. More than one
  orchestrator in a coordinated team is refused.
- **Otherwise one is synthesized**: a member with role `coordinator.role`, `orchestrator: true`,
  on the first tuple that passes the same checks a spawn applies — the backend is loaded, the
  model policy (`model-policy.json`, subagent dimension included) allows it, and the pi model is
  in the session's registry or the backend's own validation accepts it. The primary is tried, then
  the fallback. If neither passes, **the team is not created**: the error names both tuples and
  their reasons, and suggests fixing Settings or passing `defaults.coordinator: false`. A caller
  member that takes the coordinator's role without being the orchestrator is refused the same way.
- **What the result says.** One line per synthesized member: role, backend/model/effort, and
  whether it is the primary or the fallback (with the primary's denial).
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
  teams at `session_start`, so once a member of such a team is back (re-adopted or
  `agent_resume`d) the roster and any later successor still have them. Where none was recorded,
  the roster says the assignment is not known and to ask the member.
  When the main thread adds members with `team_add`, the routing coordinator is sent a follow-up
  naming each new member and its assignment, and the `team_add` result says it was told (or that
  it could not be).
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
  others. At most 8 members start per call, synthesized ones included; the refusal says so.

## §teams.defaults/routing — Only the coordinator talks to the main thread

In a coordinated team the **routing coordinator** is the newest live member with the coordinator
duty (a successor takes over from its predecessor the moment it starts).

- **Wake.** Every member except the coordinator is spawned with `wake: false`.
- **Completions.** When any other member settles, its completion (the same summary the parent
  would get) is delivered to the routing coordinator as a follow-up, not to the parent. A killed
  member's completion goes nowhere. The monitor's own settles go nowhere (it settles after every
  check); only a failed monitor task is reported to the coordinator.
- **Questions.** Another member's `team_ask` is delivered to the routing coordinator as a
  `[Team question … routed to you as coordinator]` message it answers with `team_msg`; the member
  is told it went to the coordinator. The monitor has no `team_ask`.
- **The coordinator's own completion** goes to the parent as `subagent-complete`, starting a
  parent turn only when no other member (the monitor aside) is working — an interim "waiting on
  the builder" does not wake the parent; a quiescent team does.
- **No live coordinator.** If the team's coordinator has ended and no successor is live, routing
  falls back to the parent: completions and questions reach it as before, and a completion then
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

- **When.** In a coordinated team whose file has `monitor.enabled` and whose `team_create` did not
  pass `defaults.monitor: false`. It is synthesized with role `monitor.role` on the first tuple
  that passes the spawn checks (primary, then fallback); if neither passes, the team is not
  created. An uncoordinated team gets no monitor, and the result says why.
- **Tools.** `team_msg` (with an optional `notice`: `wrap-up`, `pause` or `resume`), `team_inbox`,
  `team_roster` (read-only) and **`wake_nudge`** — for a pi monitor through the member extension,
  for a claude-code monitor through the member MCP server. No other member has `wake_nudge`; the
  monitor has no `team_ask`, `team_steer`, `team_report` or built-in tools, and it can never reach
  the parent.
- **Standing instruction** (its header, with the file's thresholds): at each wake, read
  `team_roster`; a member whose context is at or above `contextPct` % of its window is told
  (`notice: wrap-up`) to finish its current step, write its handover note, and end its turn, and
  the coordinator is told too so it can start a successor. When usage checking is on and any provider window a team member
  uses is at or above `pausePct` %, it tells the coordinator (`notice: pause`) to have the whole
  team wrap up and go idle, then schedules `wake_nudge` for that window's reset plus
  `resumeMarginMinutes` (at most 24 h ahead, re-checking if the reset is later); on that wake,
  once that window's reset plus `resumeMarginMinutes` has passed, it tells the coordinator
  (`notice: resume`) to resume the team.
- **An early resume is refused.** The parent does not trust the monitor's clock reading: at a
  `pause` notice it records the windows of the team's providers that are then at or over
  `pausePct` and have a reset time, and until the latest of those resets plus
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
  `subagents-team-event-v1` entry. A pause or resume event names the monitor. A `wrap-up` event is
  written once per member the notice was delivered to and names that member (not the monitor),
  with `detail` like `context 78% of 200k` (or the tokens alone when the window is unknown, or
  `context unknown`). The monitor also sends `wrap-up` to the coordinator about each flagged
  member; that delivery is an event about the coordinator only when the coordinator's own context
  is at or above `contextPct` %.

## §teams.defaults/wake-nudge — The monitor's timer is held by the parent

A member cannot start its own turn, so `wake_nudge` is a mailbox request the parent serves, with
the wake-nudge extension's semantics: `schedule` (`delay` like `30s`, `5m`, `1h30m`, or an ISO
`at`), `list`, `cancel {id}`; at least 10 s and at most 24 h ahead, `at` up to 60 s in the past is
clamped to 10 s, at most 5 pending. At fire time the parent delivers `[wake_nudge nN] Scheduled
wakeup fired … Reason: …` to the monitor as a follow-up, which starts a task if it is idle.

**An idle team costs no monitor turns.** A nudge that comes due while no other member is working
and the team is not paused (a monitor `pause` notice not yet followed by `resume`) is **held**, not
delivered: one per monitor (later ones collapse into it), shown by `list`, droppable by `cancel`.
It is delivered — marked as held and released — at the parent's first refresh that sees a teammate
working again; every worker state change and every accepted steer schedules one, so the main
thread steering a member or a member starting a task resumes the checks. A paused team's nudges
always fire on time, so the resume check runs while everyone is idle; those fires are bounded:
after 30 consecutive fires with no other member working, scheduling is refused until some member
works again. Pending nudges die with the parent process (and with the monitor); they
are not rebuilt after a reload. The pause itself survives one: a team whose last `pause`/`resume`
event on the active branch is `pause` is paused again at `session_start`, and when its monitor
rejoins (re-adopted or `agent_resume`d) it is sent its resume check at once in place of its lost
nudges (run `team_roster`; resume if the window is back under the threshold or has reset,
otherwise schedule the check); the `agent_resume` result says so instead of "nothing was sent to
it". No other resumed member is sent anything.

## §teams.defaults/roster-context — Context size in the roster

`team_roster` and `team_list` show each live member's context: `context 123k/200k (61%)` — the
last reply's context tokens as the runner counts them, over the window of the model it was spawned
with (a pi model: the session's model registry; claude-code: 1,000,000 for a `[1m]` model, else
200,000), rounded down to a whole percent. Unknown parts say so: `context —` before the first
reply, `context 64k/?` without a known window. For a monitor or coordinator, `team_roster` also
carries the file's current thresholds and, from `<agent dir>/cache/usage-status.json`, each
provider window the team's members use (percent and reset time, and the cache's age). A window
whose reset time has passed is shown as reset with its usage unknown (the cached percent predates
the reset) and is never marked at or over the pause threshold, so a stale cache cannot keep a team
paused. A coordinator's roster also lists the assignments (§teams.defaults/coordinator).

## §teams.defaults/handover — Successors, handover notes and retirement

- **Where notes go.** `<agent dir>/sova/teams/<session>/<team_id>/handoffs/<role>.md`, where
  `<session>` is the parent session's id (reduced to `[A-Za-z0-9._-]`; a session without an id uses
  a key unique to that parent process) and the role is reduced to `[A-Za-z0-9._-]`. Team IDs
  restart at `team_01` in every parent session, so the session id is what keeps two sessions'
  notes apart. The directory is created with the coordinated team; every member's header but the
  monitor's names its own path. The monitor has no file tools and no note.
- **`team_succeed { role }`** — the routing coordinator only. It starts the successor of that
  member (itself included) through the same spawn path: role `<base>-<n+1>` where an existing
  `-N` suffix is stripped first (`builder` → `builder-2` → `builder-3`; the first free number
  wins), on the **same** backend, model and effort, with the same tools, system prompt, cwd,
  backend options, ownership and duty.
- **The note comes first.** For a live worker or coordinator, `team_succeed` starts nothing at
  once: the old member is told — as a redirect, so it lands ahead of anything already queued for
  it (or, when the coordinator succeeds itself, in the tool result) — to finish its step, write or
  update its note, do no new work and end its turn, and the coordinator's result says the
  successor will follow. The successor starts as soon as the note file exists, whether or not the
  old member has ended a turn (follow-ups queued on it would keep it from ever settling), or when
  the old member ends, or when `handover.retireTimeoutMinutes` (read at `team_succeed`) pass —
  whichever is first. The routing coordinator is then sent a follow-up naming the successor and
  the true reason it started, judged from whether the note exists at that moment: the note is
  written; the member ended after, or without, writing it; the wait timed out; or the wait ran out
  just as the note appeared. The old member is told, again as a redirect, that its successor has
  started, to stop any work in progress, and to answer its questions. A member already ended when
  `team_succeed` is called, and a monitor, are succeeded at once.
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
  <old>" (ask it over `team_msg`, call `team_ready`), and the old monitor is told to brief it over
  `team_msg` — its pending nudges, notices sent, whether a pause is in force — and to run no
  further checks; no note is involved. One pending handover per member, and a member still
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
  action's source `system`. A member that had already ended when its successor started — ended
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

## §teams.defaults/command — `/team defaults`

`/team defaults` prints the effective defaults read from the file now — both roles, their tuples,
thresholds and the retire timeout — or `off (no file)` with the path, or the malformed reason. It
writes nothing and starts no turn.
