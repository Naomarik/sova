# Subagents for Pi

Background workers with separate sessions, plus a monitor at `/agents`
(`/subagents` alias). Spawning returns immediately; waiting is an explicit operation.
Pi is the default backend. The separate [Claude Code extension](../claude-code/README.md)
adds `backend: "claude-code"` to the same tools and monitor; mixed batches are supported.
Options below describe Pi unless stated otherwise.

Installed globally through this symlink:

```text
~/.pi/agent/extensions/subagents -> ~/pi-config/extensions/subagents
```

Run `/reload` to load changes. **Reload, session replacement, and quitting stop
this extension's workers.** Their Pi session files remain available, but live
workers are not reattached after reload. Agent/run ID sequences are restored from
the parent session so old references cannot target unrelated new workers.

## Tools
| Tool               | Behavior                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| `agent_models`     | Discover loaded backends and exact model IDs using the active registry/CLI.    |
| `agent_spawn`      | Start a batch and return agent/run IDs without waiting for tasks.              |
| `agent_list`       | Show workers grouped by run, including model, status, task outcome, and usage. |
| `agent_transcript` | Read current-task output, whole, paged by `offset`/`limit`; while busy, bounded recent activity; `full: true` for retained history. |
| `agent_steer`      | Send new instructions; wait for RPC acceptance, not task completion.           |
| `agent_kill`       | Stop one worker, a run, or all workers; await process termination.             |
| `agent_wait`       | Wait for selected tasks to settle; report failures and timeouts explicitly.    |
| `agent_resume`     | Bring a restored worker back idle in its own backend session (see below).      |
| `team_create`      | Create an explicit coordinated team with unique roles and advisory ownership.   |
| `team_add`         | Add members to a live session team; history teams remain read-only.             |
| `team_list`        | Inspect teams, actual member state, declared scope, and bounded actions.         |
| `team_eject`       | Release an ended member's seat in a session team (parent only; see below).       |

Team members additionally get `team_msg`, `team_inbox`, `team_ask`, and for an
orchestrator member `team_roster` and `team_steer`: Pi members through a
restricted member extension (`member.ts`), Claude Code members through a stdio
MCP server (`member-mcp.ts`, tools named `mcp__team__<tool>`). See
[Team messaging](#team-messaging-orchestrators-and-operator-questions).

Find models without guessing IDs or invoking a separate Pi CLI:

```json
{ "query": "deepseek 4.1 flash" }
```

Pass this to `agent_models`; optionally set `backend: "pi"` or `"claude-code"`
and `limit` (default 30, maximum 100). Pi uses the current session registry,
including extension/cloud providers. Claude asks its CLI's initialization endpoint
for models/effort choices without submitting a model task. Discovery failures are
reported per backend, not silently converted into an empty model list.

`/subagents models [search]` (or `/agents models [search]`) opens a model picker;
selecting a choice prefills a delegation request with the exact backend and ID.
It does not start a worker until you supply and send the task.

Spawn one worker:

```json
{
	"prompt": "Review the authentication code. Do not edit files.",
	"name": "reviewer",
	"tools": ["read", "grep", "find", "ls"]
}
```

Spawn a batch:

```json
{
	"groupLabel": "Independent reviews",
	"agents": [
		{ "name": "security", "prompt": "Review authentication security.", "tools": ["read", "grep", "find", "ls"] },
		{ "name": "tests", "prompt": "Review authentication test coverage.", "tools": ["read", "grep", "find", "ls"] }
	]
}
```

Agent options work both inside `agents` and in the single-worker shorthand:

- `count`: positive integer; default 1. At most 8 workers per call and 12 live
  workers overall. Idle, steerable workers still consume a live slot.
- `backend`: default `pi`; `claude-code` requires the separate extension. Backend-specific
  defaults and validation apply; Claude does not inherit Pi model/tools/effort.
- `backendOptions`: options owned by the selected backend (unsupported for Pi).
- `model`: exact `provider/model` ID. Defaults to the parent's current model,
  not the model saved in global settings. A named definition can override it.
- `effort`: Pi reasoning level; defaults to the parent's current level. Pi clamps
  it to the chosen model's capabilities.
- `tools`: built-in tool-name allowlist. Omitted inherits the parent's active
  built-in tool names; `[]` disables all tools.
- `cwd`: directory, relative to the parent's cwd or absolute; `~/` is supported. In a remote session (below) it is a path on the target, absolute or relative to the session's far cwd; `~` is refused there.
  A leading `@` is treated as Pi's path-mention syntax. Use `./@name` for a
  directory whose actual name begins with `@`.
- `systemPrompt`: additional system instructions.
- `agentType`: existing `~/.pi/agent/agents/<name>.md`; its body supplies additional
  system instructions and optional YAML frontmatter `model:` supplies a default.
  Missing or unreadable definitions fail rather than silently being ignored.
- `wake`: default `true`. When the worker settles while the parent is idle, the
  completion message starts a parent turn, so the main agent can act on the
  result without the user typing. `false` only queues the result for the next
  turn. A worker the parent killed never wakes it. The message quotes the first
  4,000 characters of the report; a longer one adds a line with the final
  answer's size and a private `/tmp/pi-subagents-report-*/<id>-final-answer.md`
  holding it verbatim, before the closing `[Use agent_transcript for more.]`
  (Sova parses that trailer as the last line). Team members are told to write
  reports longer than about 3,500 characters to a file and end with its path.
- `extensions`: extension sources the child loads with `-e` on top of
  `--no-extensions`: a path, `npm:name` or `git:host/owner/repo`. Packages Pi has
  already installed for the user (`~/.pi/agent/npm/node_modules/<name>`,
  `~/.pi/agent/git/<host>/<path>`) are passed as their installed directory, so
  the child does not reinstall them. An exact npm version pin is reused only
  when the installed package version matches; ranges/tags and git ref pins are
  passed through to Pi rather than silently replaced by another installed copy.
  Other uninstalled remote sources are installed into Pi's temporary scope on
  every start. A directory source loads the whole
  package manifest, ignoring any per-extension filter in `settings.json`. Local
  paths must exist. This extension's own directory is refused, so children still
  cannot spawn children. With `extensions` set, the `tools` allowlist restricts
  only built-in tools (Pi's `--tools` would also strip the extension's tools);
  every tool the listed extensions register stays enabled.
- `fork`: default `false`. `true` starts the child from a copy of the parent's
  session file (`pi --fork`), so it sees this conversation's full history. The
  parent's file is never written by the child; the copy records it as
  `parentSession`. The parent's in-flight `agent_spawn` call has no result yet
  in the copy; Pi inserts a synthetic empty result for it. Requires a persisted
  parent session; an ephemeral (`--no-session`) parent cannot fork.

Do not mix `agents` with shorthand options. The whole batch is validated before
any child starts (including backend checks such as Claude's prompt-size limit).
If a factory throws during creation, already-created batch members are stopped;
no partial run or completion wake is published. The failed `agent_spawn` waits
at most 10 seconds for their termination and returns at once if cancelled.
Workers still terminating stay owned: they count toward the live cap and are
stopped at shutdown until their process closure is confirmed, even if a
backend's `kill()` resolved earlier. Startup and model failures can still
happen asynchronously; inspect worker status rather than treating a spawn
acknowledgment as success.

Use IDs when names are duplicated:

```json
{ "id": "ag_01", "message": "Focus on credential expiry instead." }
```

Optional `mode: "followUp"` queues instructions after current work. `mode: "redirect"`
uses Pi's normal steering, or Claude's interrupt-then-replacement protocol. Omitting
mode preserves existing Pi steering and defaults to redirect for Claude. A queued
acknowledgment is not task completion. Claude follow-ups do not automatically
continue after a task errors or aborts, but follow-ups queued before or during a
redirect survive the abort that redirect itself requested and run after the
replacement. Claude redirects require both an interrupt control response and
settlement correlated to the interrupted request; the control response may be
negative if that request has settled.

Pi itself continues queued messages after a failed run (its own queue, not
this extension's). The runner cannot reliably prevent that, so it reports it: the
failed run is recorded in the transcript, and the task that finally settles is
reported with outcome `error` and an error naming the earlier failure, even if
the queued continuation succeeded. Automatic retries and overflow-compaction
retries are not treated as failures.

A Pi steer's task (and its `finalOutput`) begins at Pi's next run start, or at
the steer's user message when Pi delivers it inside the running run. Pi expands
`/skill:` commands and prompt templates, and input extensions may transform text,
before queueing, so the runner follows Pi's `queue_update` events: the entry Pi
appends while a steer awaits acceptance is taken as that steer, and its removal
marks the next user message with that text as the delivery. If an earlier steer
starts while a later one awaits acceptance and the later one is rejected, the
earlier steer's task stands from its start. Pi's RPC has no per-message IDs, so
this correlation is best-effort:

- An entry that an extension or another client adds to Pi's queue while a steer
  awaits acceptance can be mistaken for that steer.
- Identical texts are told apart only by queue order and per-queue counts. When
  several identical entries (in the steering and follow-up queues, or in one
  queue) leave in the same update, the first matching user message counts.
- Clearing Pi's queue (for example on abort) looks like a dequeue, so a later user
  message with the same text may be taken as the delivery.
- Without a `queue_update` for the steer, only an exact match of the raw steer
  text marks in-run delivery; an expanded steer then starts its task at the next
  run start.

A new Pi worker must answer its first `get_state` within 120 seconds (startup
and extension loading); the task prompt is sent only after that, so slow startup
does not use up the prompt's acceptance deadline. Pi command acceptance has a
15-second response deadline. Pi accepts a prompt only after its preflight, which
can compact the session (for example a large `fork`) before accepting. While
compaction events show progress and Pi still answers `get_state`, the wait is
extended one 15-second window at a time, up to 10 minutes in total. Without
that progress, or if Pi stops answering, the normal deadline applies. The prompt
is never resent, and an acknowledgment that arrives after the runner gave up is
ignored (the worker has already been stopped as delivery unknown). Compaction
events are not tied to a particular prompt: a running task's own compaction can
also extend a queued steer's wait, still within the 10-minute cap. While a steer
awaits acceptance, its `queue_update` and even its delivery may arrive before the
acknowledgment; the task boundary moves at delivery either way. A longer wait
also widens the window in which another client's or an extension's queue entry
can be mistaken for the steer (see above). Claude allows 15 seconds
for interrupt response plus correlated settlement, and 30 seconds for
message-delivery acknowledgment. If delivery or interruption remains ambiguous
at these deadlines, the worker is stopped and an error is reported, subject to the
cancellation behavior below. One Claude exception: if the interrupted task has
already settled and only the interrupt response is missing, the redirect is
rejected and the idle worker is kept. No new turn starts until that interrupt is
answered; if it stays unanswered through the 30-second control deadline, the
worker is stopped so a delayed interrupt cannot abort later work. Replacement instructions are not silently assumed
to have run. Strict protocol parsing and fail-closed handling are intentional
safeguards.

Cancelling `agent_steer` **only cancels the acceptance wait, not the worker**.
Instructions already sent may still execute: the cancellation reports delivery
unknown rather than claiming rejection or task completion. For Pi, late
acknowledgments and task events continue updating the worker; cancelling does
not cause a delayed acceptance-timeout kill. If the acknowledgment never arrives,
the runner asks Pi for its state (`get_state`): when two consecutive readings show
no active or queued run, the worker returns to `waiting` with outcome `error`
("acceptance unknown"), not success; if Pi does not answer, the worker stays
`running` with an error diagnostic and must be stopped explicitly. For Claude, an in-flight bounded
redirect transaction continues after the caller stops waiting; its normal
protocol deadlines and failure handling still apply. Inspect `agent_list` /
`agent_transcript` before retrying to avoid duplicate work. Use `agent_kill`
explicitly to stop a worker.

Wait for selected workers or a whole run:

```json
{ "ids": ["ag_01", "ag_02"], "timeoutSeconds": 120 }
```

```json
{ "group": "run_01" }
```

With neither selector, `agent_wait` selects currently unsettled workers. The
regular timeout is 600 seconds; `0` performs an immediate check. Cancelling or
timing out a wait **does not kill its workers**. Use `agent_kill` with exactly one
of `id`, `group`, or `all: true` to stop them. `all: true` targets published
workers; unpublished workers from a failed spawn (whose IDs were never returned)
are already being stopped and are only reported as a count.

## Remote sessions

When the parent runs on a remote target (pi-config's `remote` extension, `--target`; Sova opens
such sessions in an empty local placeholder directory), every worker runs on the target as well —
no backend ever gets local tools against the placeholder:

- pi workers load the remote extension (`-e …/remote/index.ts --target <name>`; the runner's
  `flags` option), so their built-in tools are the remote ones under the same names. Tool
  allowlists keep working by name.
- claude-code workers start with `--tools ""` and the `remote` MCP server
  (`remote/mcp-server.ts`; tools `mcp__remote__remote_bash`, `remote_read`, `remote_write`,
  `remote_edit`, `remote_ls`, `remote_find`, `remote_grep`), plus `MCP_TOOL_TIMEOUT` in their own
  environment so a long remote command is not cut at claude's 60 s default. Team members get the
  `team` server beside it.
- other backends are refused in a remote session, as is any spawn while the session's target
  failed to load.

The session is recognised from the remote extension's `remote:session` event on `pi.events`, else
from the placeholder cwd (`<agentDir>/sova/targets/<name>/<far path>`). See the remote
extension's README ("Workers").

## Model policy

`~/.pi/agent/model-policy.json` (version 1) decides which models and providers
may be picked as workers — in every session, TUI and webapp alike:

```json
{
	"version": 1,
	"disabledProviders": ["anthropic"],
	"disabledModels": ["openai/gpt-5.2", "claude-code/opus"],
	"subagentDisabledProviders": ["zai"],
	"subagentDisabledModels": ["ollama/qwen3-coder"]
}
```

The bare keys are global — those providers and models may not be used anywhere,
by anyone — and the `subagent*` keys narrow what is still allowed down to what a
worker may be given. Workers obey both. The file, and everything else that reads
it, is documented in [`../model-policy/README.md`](../model-policy/README.md);
while it does not exist the pre-Models-tab file
`~/.pi/agent/subagents/settings.json` is read instead and its two lists are
treated as the subagent dimension, which is what they always meant.

A disabled provider blocks all of its models; `agent_models` and the
`/subagents models` picker stop listing blocked choices, and `agent_spawn`,
`team_create`, and `team_add` reject one with a reason — whether it was named
explicitly, taken from an agentType definition, or inherited from the parent
session's model. The reason says whether the model is off everywhere or only for
subagents, because those take different switches to undo. For non-pi backends the
backend id doubles as the provider (`claude-code` above), and a model-less spec on
a disabled backend is rejected too, since its default model is that provider's.
Sova's Settings → Models tab edits this file live; manual edits apply on the
next spawn or discovery, no reload needed. A missing or corrupt file disables
nothing.

## Status and task results

Process status and task outcome are separate:

- `starting` / `running`: startup or task execution.
- `waiting`: idle and steerable. **This does not imply task success.**
- `stopping`: termination is in progress.
- `done` / `error` / `killed`: normal exit, failure, or requested termination.

`taskOutcome` reports `success`, `error`, or `aborted` for settled work. An idle
worker can be steered again after a failed task. New instructions clear stale
output and errors; earlier work remains in its transcript/session history.

In TUI and RPC parent sessions, completion produces a notification and a short
follow-up message. With `wake` (the default) that message starts a turn when the
parent is idle; with `wake: false` it waits for the next turn. The message is
sent even if the UI notification fails. Print/JSON parents use tool results
instead of injected notifications.

## Monitor

Three panes show runs, workers, and the selected transcript. Long run/worker
lists scroll to keep the selection visible. Small terminals use a reduced view
instead of rendering lines wider than the terminal.

- `Tab` / `Left` / `Right`: switch run/worker selection scope.
- `Up` / `Down` / `j` / `k`: select.
- `PageUp` / `PageDown`: scroll transcript; `Home` jumps to its start.
- `End`: resume following new transcript output.
- `o`: expand or collapse folded code (see below).
- `x`, then `x` again: stop the selected worker or run. Any other key cancels
  the confirmation; it also expires automatically.
- `r`: open an editor to redirect the selected live worker.
- `f`: open an editor to queue a follow-up for the selected live worker.
- `Escape` / `q`: close.

The monitor supports steering and stopping workers; the main conversation can use
the same controls through `agent_steer` and `agent_kill`. It shows completed assistant messages and tool activity, not
a token-by-token copy of the child's editor.

Code-heavy transcript items are folded by default. `write`/`edit` calls show one
line such as `✎ write ~/src/member.ts  +212` or `✎ edit ~/src/teams.ts  +34 −12`
(counts ignore shared leading/trailing lines of each replacement). Other tool,
result, system, and thinking items longer than 6 lines or 300 characters collapse
to the same band the main thread uses (`../codefold/fold.ts`), labelled with the
tool name (or `text`) and the first meaningful line:
`▕ bash ▕ npm test ▕ 42 lines ▕ o ▕`. This includes Claude tool input, which
arrives as JSON with escaped newlines. Assistant prose stays visible and only
column-0 fenced code blocks longer than 6 lines fold, to a band showing the fence
language and signature. Task, instruction, and error items never fold.
`o` expands or collapses everything in the monitor and in `/team`. Folding only
changes what the monitor displays: `agent_transcript` returns the full text.

## Teams

The same manager supports **session-scoped coordinated teams**: named groups of
background workers with one unique role each, declared advisory ownership, and a native
workspace. Use `team_create` / `team_add` / `team_list` for model-facing coordination;
open `/team` for a roster/member activity view, direct follow-up or redirect editors,
exact-member stop (`x`, then `x` again), and the monitor's `o` code-fold toggle. A compact status widget appears above the
parent editor while any team has a member that has not been stopped (killed members drop out of it;
`team_list` and `/team` keep them).

Teams reuse `agent_spawn`'s caps, validation, rollback, permission prompts, wake
behavior, retention, and shutdown. There is no separate process manager, and
ownership is not a filesystem lock. Members can message each other and ask the
operator questions, but only through this extension: there is no direct
process-to-process channel (next section). `/team <objective>` sends one
extension-origin planning message and starts a parent turn if idle; bare `/team` only
opens the workspace. See [../../docs/native-teams.md](../../docs/native-teams.md).

### Seats and `team_eject`

A team seats 24 members. Every recorded member holds a seat, finished ones
included, until it is **ejected**; pending additions count too. When a
`team_add` would pass 24 it is refused, and the error names the members that
have ended (and so can be ejected).

`team_eject { team, member }` (`member` = exact `ag_NN` or role) is a parent
tool only: members and orchestrators never get it. It works on a team restored
from this session's history after a reload too (the eject lands on the same
branch and folds back with the team; `team_list` marks such a team `history,
read-only but team_eject`, and `team_add` still refuses it). It refuses an
unknown team or member, a
member already ejected, a member mid-handover in a coordinated team (the
predecessor or successor of a `team_succeed` not yet confirmed or timed out;
the refusal says the seat is released automatically), and a member whose worker
is still working, idle or stopping (stop it with `agent_kill` first). It persists
`{ version: 1, op: "eject", teamId, workerId, at }` in the same
`subagents-team-v1` entry stream before marking the member, and records one
`eject` action (source `parent`). A handover ejects on its own, with source
`system` and the same entry: the member it retires (on `team_ready` or at the
retire timeout, once the kill succeeds), and a member that had already ended
when its successor started (nothing to retire), right after that successor
starts. The restore fold replays it, and counts only
seated members against the cap, so a member added after an eject survives a
reload or restart.

An ejected member keeps its role reserved (roles stay unique for the team's
life), its worker ID, transcript and action history. It no longer counts in the
team's state counts (`team_list` and `team_roster` show a separate `N ejected`
and mark its line `· ejected <time>`), is left out of "Other members" in new
members' headers, is skipped by a `team_msg` to `all`, and a direct `team_msg`
or `team_steer` to it fails saying it was ejected. `agent_resume` refuses it.
The `/team` widget hides it like a stopped member; the workspace roster marks
it `· ejected`. Sova's Agents page and subagents pane show an `Ejected` chip.

### Team messaging, orchestrators and operator questions

Every team member's prompt starts with a fixed header (team, objective, role,
declared ownership, the other roles with orchestrators marked, the advisory
ownership rule) followed by a coordination paragraph that states exactly which
team tools that member really has and how they are named. Every member gets a
parent-issued identity (`PI_SUBAGENTS_TEAM_MEMBER`, JSON: team, worker ID,
role, orchestrator flag, private mailbox directory) and a private mailbox
directory before its process starts; how the tools reach the worker depends on
the backend:

- **Pi members** are launched with `--no-extensions -e <this package>/member.ts`
  and the identity in their environment. `member.ts` registers nothing without
  that identity and never imports the manager, so a child still cannot spawn,
  list, steer by ID outside its team, or kill anything. The parent keeps
  refusing this package under the user-facing `extensions` option.
- **Claude Code members** cannot load Pi extensions, so the same tools are served
  by `member-mcp.ts`, a dependency-free stdio MCP server (hand-rolled JSON-RPC:
  `initialize`, `ping`, `tools/list`, `tools/call`) run under the parent's own
  runtime (`process.execPath member-mcp.ts`; Node runs the `.ts` file directly).
  The Claude runner writes a per-worker `mcp.json` (mode 0600, beside the
  system-prompt file, removed when the process closes) and passes it with
  `--mcp-config` under the existing `--strict-mcp-config`; the identity travels
  in that server entry's `env`, so the CLI process itself never sees it. The
  server name is `team`, so Claude calls `mcp__team__team_msg`,
  `mcp__team__team_inbox`, `mcp__team__team_ask` (and for orchestrators
  `mcp__team__team_roster`, `mcp__team__team_steer`); the header spells these
  names out. Outside the default `bypassPermissions` mode the runner appends an
  `mcp__team` rule to `--allowedTools` so the member's own tools never prompt
  (or get denied under `dontAsk`); the operator's own `allowedTools` rules are
  kept first. `member-mcp.ts` exits without serving anything if the identity is
  missing or malformed, and it never imports the manager.

Member tools (same names and semantics on both backends):

| Tool           | Who          | Behavior                                                                                         |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `team_msg`     | any member   | `{ to, message }`; `to` is a sibling role, worker ID, or `all`. Returns per-recipient acceptance. |
| `team_inbox`   | any member   | `{ limit? }`; re-reads messages and orchestrator instructions delivered to this member.           |
| `team_ask`     | any member   | `{ question }`; surfaces the question to the operator; the answer arrives as a later message.     |
| `team_roster`  | orchestrator | Live roster of the member's own team with states, ownership and recent actions.                  |
| `team_steer`   | orchestrator | `{ to, message, mode? }`; instructions for one sibling. Same acceptance semantics as `agent_steer`. |

Transport and delivery: each tool writes one request file into the member's own
directory under a private temporary root the parent created
(`pi-subagents-teams-*/team_NN/ag_NN/requests`), then waits (up to 45 seconds)
for the parent's response file. The parent polls every 250ms while teams exist,
derives the sender from the directory (a request body is never trusted for
identity), validates scope against the team store, and performs the action
itself through the same `steerWorker` path the tools and workspaces use:

- A message becomes a steer to the recipient prefixed
  `[Team message from <role> (<id>), team_NN]` with a reply hint that names the
  recipient's real tool (`team_msg` for Pi, `mcp__team__team_msg` for Claude).
  Pi recipients get the backend's normal steering (seen at their next step, or
  a fresh task if idle, which is the wake-up); Claude recipients get
  `mode: "followUp"` (a redirect on Claude would interrupt their current task).
  `all` reaches every live sibling, never the sender; partial failures are
  reported per recipient. Every recipient also gets a copy in its inbox file.
- `team_steer` is accepted only from an orchestrator, only for one sibling of
  its own team (never itself, never `all`, never another team). The text is
  prefixed `[Instruction from orchestrator <role> (<id>), team_NN]` and the
  requested `mode` is passed through.
- `team_ask` posts a `team-question` message into the parent session
  (`deliverAs: "followUp", triggerTurn: true`, so an idle parent starts a turn
  even for `wake: false` members) that names the worker ID and tells the parent
  to answer with `agent_steer { id, message }`. The member's tool returns at
  once; the member should continue independent work or end its turn, and the
  answer resumes it. In print/JSON parent modes the member is told to report
  the question in its final answer instead.
- Every mediated action is recorded in the team's bounded action history with
  source `member` or `orchestrator` and kind `message`, `question`, `steer`,
  `followUp` or `redirect`; failed deliveries (recipient gone, wrong scope) are
  recorded as `failed`. Acceptance never means execution.

`orchestrator: true` is a per-member flag on `team_create` / `team_add`. It is
sibling-scoped coordination only: the orchestrator can see its team and steer
its siblings, and it must ask the operator (`team_ask`) to add or stop members.
It is accepted on the Pi and Claude Code backends (the only ones that can load
the member tools) and rejected on any other. Depth stays capped: no member of
any kind can create workers.

Scope validation never depends on the member's process: the parent derives the
sender from the mailbox directory and applies the same checks (same team, not
itself, orchestrator-only powers) whichever transport wrote the request.

The mailbox root is removed at shutdown. Timeouts on the member side report
"may still be handled" rather than success; a request that was already queued
is still processed by the parent if it is alive.

### Team defaults: coordinator, monitor, handovers

`<agent dir>/team-defaults.json` (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), written by
Sova's Settings and read by `team-defaults.ts` (Node built-ins only, so Sova's server imports
the same reader, parser and atomic writer). It is re-read at every `team_create` / `team_add`,
at each roster answer to a coordinator or monitor, at `team_succeed`, and by `/team defaults`
(which prints what is in effect). **No file: nothing changes.** A malformed file (every error is
listed; unknown keys are errors, missing keys take the built-in defaults) turns the feature off
for that call with a warning line in the result; the extension never writes the file.

```json
{"version":1,
 "coordinator":{"enabled":true,"role":"coordinator","primary":{"backend":"claude-code","model":"opus[1m]","effort":"medium"},"fallback":null,"instructions":""},
 "monitor":{"enabled":true,"role":"monitor","primary":{"backend":"claude-code","model":"haiku","effort":"medium"},"fallback":null,"contextPct":60,"everyMinutes":10,"usage":{"enabled":true,"pausePct":90,"resumeMarginMinutes":5},"instructions":""},
 "handover":{"retireTimeoutMinutes":10}}
```

- **Coordinator, enforced.** `team_create` adds a member on `coordinator.role` with
  `orchestrator: true` on the first tuple that passes the spawn checks (backend loaded, model
  policy, pi registry / backend validation): primary, then fallback; neither → the team is not
  created. A single caller orchestrator becomes the coordinator instead; two are refused, as is a
  caller member on a synthesized role. It does no implementation (its header says so) and gains
  `team_report` and `team_succeed`. It routes the work the main thread assigned and never invents
  tasks: its header quotes each teammate's prompt (first 1,500 chars, then a marker), and its
  `team_roster` lists every non-duty member's assignment with every main-thread steer to it (up to
  40, 2,000 chars each, older ones counted; the roster shows 500 chars of each). A successor
  inherits its predecessor's assignment and steers. Tasks and steers are also written to the
  session as `subagents-team-assignment-v1` entries (`task`, `steer`, `inherit`), which a reload
  folds back, so a resumed coordinator's roster still lists them. Members the main
  thread adds later with `team_add` are announced to it as a follow-up with their tasks. Its header
  also says: the main thread's steers are assignments it must not countermand, and it never tells
  a member that main-thread work (a successor's inherited steers included) is not its work; the
  roster, the header and the handover message label every such steer as binding; succeed a flagged
  member unless its assigned work is verifiably finished; report pause and resume with
  `team_report`. `defaults: { coordinator: false }` opts one team out (no
  monitor either); `defaults: { monitor: false }` drops only the monitor. Coordination is fixed at
  creation; `team_add` never retrofits it.
- **Routing.** Everyone else is `wake: false`. Their completions go to the routing coordinator
  (the newest live member with the coordinator duty) as a follow-up, and their `team_ask`
  questions too; the parent sees neither. The coordinator's completion reaches the parent and
  starts a turn only when no other member (monitor aside) is working. `team_report` shows the
  parent a `team-report` message (displayed, `triggerTurn: false`); `team_ask` from the
  coordinator stays a `team-question` (the `team_create` result and `team_list` say so instead of
  the generic question paragraph). `team_report { report, kind? }` takes `kind: milestone |
  concern`, shown in the header as `[Team report from coordinator <role> (<id>), <team> — <name>
  · <kind>]` (no kind, no suffix). The `team_create` result, `team_list` and the tool guidelines
  tell the main thread not to stop the coordinator or monitor while any member is still working.
  With no live coordinator, completions and questions fall
  back to the parent (a completion then wakes it). Killed members' completions go nowhere; the
  monitor's own settles go nowhere unless its task failed.
- **Monitor.** Added last, `tools: []`, with `team_msg` (plus `notice: wrap-up | pause |
  resume`), `team_inbox`, `team_roster` and `wake_nudge` — nothing else, on both backends. Its
  header is the standing instruction (roster every `everyMinutes`; wrap-up at `contextPct`;
  pause at `pausePct`, `wake_nudge` at the reset + margin, then resume). The parent enforces the
  wait: at a `pause` notice it records the team's windows then at or over `pausePct` with a reset
  time, and refuses a `resume` notice (delivering nothing, recording no event) until the latest of
  those resets plus `resumeMarginMinutes` (read at the resume) has passed; the refusal names the
  window and the time. A pause with no such window holds nothing, and the hold is in memory only
  (a pause restored after a reload has none). Its roster carries the
  thresholds read now and the usage-status windows of the providers the team's models spend
  from (`<agent dir>/cache/usage-status.json`); a window whose `resetsAt` has passed shows as
  reset (usage unknown), never AT/OVER, so a stale cache cannot keep a team paused. `wake_nudge` is served by the parent (a member
  cannot start its own turn): the wake-nudge extension's bounds (10 s – 24 h, `at` up to 60 s
  past clamps, 5 pending), a fire is a follow-up steer. **An idle team costs no monitor turns:** a
  nudge that comes due while no other member is working, and the team is not paused (a monitor
  `pause` notice not yet followed by `resume`), is held — one per monitor, later ones collapse into
  it, `list` shows it, `cancel` drops it — and delivered at the first refresh that sees a teammate
  working (every worker state change and accepted steer schedules one). A paused team's nudges
  fire on time, so the resume check runs; after 30 such fires with no teammate working,
  scheduling is refused until one works. Pending nudges die with the parent process. The pause
  itself survives it: it is read back from the `pause`/`resume` events on the branch at
  `session_start`, and a paused team's monitor that rejoins (re-adopted, or `agent_resume`) is
  sent the resume check at once, since its nudges are gone.
- **Context column.** `team_roster` and `team_list` show `context 123k/200k (61%)` per live
  member: the runner's `contextTokens` over the spawned model's window (claude-code: `[1m]` →
  1M, else 200k; pi: the registry), rounded down.
- **Handovers.** Notes live in `<agent dir>/sova/teams/<parent session id>/<team_id>/handoffs/<role>.md`
  (team IDs restart in every session, so the session id keeps two sessions' `team_01` apart; a
  session without an id uses `unsaved-<pid>-<time>`), named in each worker's and the coordinator's
  header. The monitor has no file tools and no note: it briefs its successor over `team_msg`, and
  its successor's task is the monitor task ("you take over from <old>"), with `team_ready` like any
  successor. `team_succeed { role }` (routing coordinator only, itself included) starts
  `<base>-<n+1>` (`builder` → `builder-2` → `builder-3`) on the same backend, model, effort, tools,
  system prompt, cwd, backend options, ownership and duty. **A live worker writes its note
  first:** it is told, as a redirect so the instruction lands ahead of anything queued for it, to
  finish its step, write the note and end its turn, and the successor starts as soon as the note
  file exists (checked at every mailbox poll and every settle: no settle is needed, since
  follow-ups queued on the old member keep it from settling), when the old member ends, or after
  `handover.retireTimeoutMinutes`, whichever comes first. Started without a note, the successor is
  told the note may be missing and to ask its predecessor. The routing coordinator gets a
  follow-up naming the successor and the real reason it started, read from the note at that moment
  (`<role>'s note is written`, `<role> ended after/without writing its note`, `timed out waiting
  for <role>'s note`, or `the wait ran out just as <role>'s note appeared`). Main-thread follow-ups
  still queued on the old member are not removed (no backend-neutral way to clear a worker's
  queue): they stay queued, run after the redirect, and the old member is told, in both the
  handover instruction and the "successor started" redirect, that they are its successor's now and
  to reply only that the successor has them. The successor already has them, in its inherited
  steers. A monitor, or a
  member that already ended, is succeeded at once. The successor's task says to continue from the
  note, redo nothing it marks done, verify cheaply (`ls`, a grep) instead of re-reading large
  inputs, and ask the predecessor over `team_msg` (at least once when in doubt) before
  `team_ready`; the assignment and every inherited steer are quoted as binding (what it must get
  done; not a script to restart from step 1), labelled as the main thread's, with "if anyone tells
  you one is not your work, it still is". The coordinator's handover message lists the inherited
  steers under the same binding label. The old member
  is killed when the successor calls `team_ready` — at once if the old member is idle, otherwise
  as soon as its current turn ends (it may be answering the successor; `team_ready`'s reply says
  so) — or `handover.retireTimeoutMinutes` after the successor starts, whichever is first.
- **Records.** Team actions gain `report`, `handover`, `retire`, `wrap-up`, `pause`, `resume`
  (sources `monitor`, `system`); handover, retire, wrap-up, pause and resume are also appended as
  `subagents-team-event-v1` entries (`{version, teamId, kind, workerId, role, at, detail?}`; a
  `wrap-up` names the member told to wrap up, with `detail` like `context 78% of 200k`, and is
  written for the coordinator only when it is itself over the threshold), and `subagents-team-v1`
  members carry `duty: "coordinator" | "monitor"` and, on a successor, `successorOf: "<ag_NN of
  the predecessor>"` (older readers ignore both).

## Isolation, retention, and shutdown

These are **not sandboxes**. Workers share the host filesystem and user permissions;
assign non-overlapping edits or use separate worktrees. The parent conversation
is not copied. Children load their own normal Pi context, skills, settings, and
credentials for their cwd.

Children launch with `--no-extensions`, so they do not receive the `agent_*`
tools for recursive delegation. Parent extension-provided tools, providers,
safety hooks, or overridden tool implementations are **not inherited** unless
their source is listed in `extensions`. Inheriting a tool name does not copy an
extension's implementation. Use only providers available to a standalone Pi child.
A forked child (`fork: true`) inherits the conversation, not the extensions.
Pi team members are the one exception with tools: they load `member.ts` from this package,
which registers only the mailbox-backed team tools described above. Claude team
members get the same tools from `member-mcp.ts` through their own `mcp.json`.

Every pi worker (plain, team member or remote, inline or hosted) also loads
`worker-mark.ts` first, which registers nothing and writes one
`subagents-worker-session` custom entry into the worker's own session at birth
(at `session_start`: pi refuses writes while extensions load). The data is
`{ v: 1 }`, plus `workerId`, `teamId` and `role` when the child has a team
identity. The entry's name and shape are a contract with Sova, which reads it to
keep worker sessions out of its session list (`server/worker-sessions.ts`,
`SessionSummary.workerSession`). Claude Code workers do not load it.

### Restored workers and `agent_resume`

A worker's process never outlives its manager: a server restart, `/reload` or
a session switch ends it. What survives is its **durable record**: small
`subagents-worker-manifest` custom entries in the owner's session file
(`registry.ts`, written for every worker of every backend and transport). They
record publication (spec, team, the launch spec a resume needs), the backend
session identity (`ref`), each task start (`running`), each settle (`waiting`,
outcome and a usage snapshot), the ending, and each resume. The record type and
its one fold, `readWorkerManifests`, are the backend-neutral worker transcript
protocol in `worker-transcript.ts`, which Sova's server reads too; each backend's
own transcript is read through an adapter (`adapters/`, pi and claude-code).

At `session_start` every recorded worker that is not live comes back as a
**restored** entry (`restored.ts`): no process, never counted as working or
toward the live cap, and it is never continued or re-reported on its own. A
worker that had ended keeps `done`/`error`/`killed`; one alive at the restart is
`restored`, marked interrupted when it died mid-turn. Its usage is read from its
own transcript, else the last snapshot (shown "as of" that time), else it is
unavailable, never 0. Records of every branch count toward the lifetime usage
total, once each; only the active branch's are listed (`agent_list`, `/agents`,
the live record Sova reads).

`agent_resume { id }` (and `/agent-resume ag_NN`, which Sova's Resume Worker
button calls) starts it again **idle** in its own backend session: pi with
`--session <its session file>`, Claude Code with `--resume <session id>` (never
`--session-id`) and the same system prompt, MCP servers and permission mode.
Nothing is sent to it and no completion is reported; `agent_steer` gives it its
next task. The session's current sandbox and remote state apply, exactly as at
spawn. A team member rejoins its team, which becomes live again, with a fresh
mailbox (earlier inbox contents are gone). Its earlier usage stays in its total.
Resume is refused for a live worker, an unknown ID, a backend that is not loaded,
and a backend whose transcript adapter declares `resume: "none"`; a failed
reopen leaves the restored entry as it was.

RPC commands are correlated with acknowledgments and have deadlines. Output uses
UTF-8-safe JSONL decoding. Failed tasks, broken pipes, rejected commands, and
signal exits are distinguished from successful completion.

The manager retains at most 50 finished workers, plus all live workers (including
idle, steerable workers). Oldest finished workers and empty runs are evicted from
the monitor and tool listings; `agent_list` reports cumulative eviction counts.
An evicted worker ID is never reassigned. Native session history on disk is not
deleted; retain its path/ID if you need to inspect it later.

The runner bounds its retained transcript and individual items. Older or oversized
content is marked as omitted; the child's `sessionFile` is the canonical history.
Tool text is capped at 47,000 bytes/2000 lines plus a truncation notice, under
the 50,000 characters above which the Claude Code CLI replaces an MCP tool result
with a 2 KB preview. Oversized tool results include a private
`/tmp/pi-subagents-output-*/output.txt` snapshot that the `read` tool can open.
This applies to all subagent tools. Snapshots remain until removed or system
temporary-file cleanup.

`agent_transcript` returns the current task's final answer whole instead: in
pages of at most 40,000 characters (`limit`, default and maximum), starting at
`offset` (default 0). A page that is not the whole answer, or any call that
passes `offset`/`limit`, carries a line such as
`[Final answer: 60,000 chars; this page is chars 0–40,000; next page: agent_transcript {"id":"ag_01","offset":40000}.]`
and `details.finalAnswer` (`total`, `offset`, `end`, `nextOffset`). With
`full: true` the snapshot line comes first, then the final answer (when it fits
in one page; otherwise a pointer to paging), then as many retained items as fit.

Shutdown first asks Pi to abort so it can clean up active tools, then escalates to
SIGTERM and finally SIGKILL if needed. Only the tracked child is signalled; no
process-name matching is used. Kill/shutdown await confirmed child exit/closure.
After an observed child `exit`, inherited output pipes get a 250ms drain before
our pipe handles are released; detached descendants holding those pipes cannot
hang reload forever after the worker has exited. A timeout or attempted SIGKILL
alone is never treated as proof of death: an actually unkillable worker remains
pending. Forced SIGKILL cannot guarantee cleanup of grandchildren or independently
launched services; this is not process-container isolation.

## Verification

Offline regression tests (no model requests):

```sh
cd ~/pi-config/extensions/subagents
node tests/run.mjs
```

Real Pi extension loading and process shutdown, without a model request:

```sh
node tests/smoke.mjs
```

Optional live test: makes two small requests using configured credentials, checks
completion, idle steering, fresh output, session identity, and process termination:

```sh
node tests/smoke.mjs --live zai/glm-5.2
```

The test harness uses the globally installed Pi packages through its TypeScript
loader. Set `PI_PACKAGE_DIR` to the coding-agent package directory for another
installation. No second Pi installation or local dependency tree is required.

Source ownership: `index.ts` owns tools and session integration; `runner.ts` owns
RPC workers and lifecycle; `modal.ts` owns rendering and keyboard behavior;
`teams.ts` owns team state and prompt headers; `mailbox.ts` owns the file
transport shared by the parent and the child-side member tools (`member.ts` for
Pi children, `member-mcp.ts` for Claude children). Each has adjacent regression
tests.
