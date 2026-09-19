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
| `agent_transcript` | Read current-task output, or retained history with `full: true`.               |
| `agent_steer`      | Send new instructions; wait for RPC acceptance, not task completion.           |
| `agent_kill`       | Stop one worker, a run, or all workers; await process termination.             |
| `agent_wait`       | Wait for selected tasks to settle; report failures and timeouts explicitly.    |
| `team_create`      | Create an explicit coordinated team with unique roles and advisory ownership.   |
| `team_add`         | Add members to a live session team; history teams remain read-only.             |
| `team_list`        | Inspect teams, actual member state, declared scope, and bounded actions.         |

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
- `cwd`: directory, relative to the parent's cwd or absolute; `~/` is supported.
  A leading `@` is treated as Pi's path-mention syntax. Use `./@name` for a
  directory whose actual name begins with `@`.
- `systemPrompt`: additional system instructions.
- `agentType`: existing `~/.pi/agent/agents/<name>.md`; its body supplies additional
  system instructions and optional YAML frontmatter `model:` supplies a default.
  Missing or unreadable definitions fail rather than silently being ignored.
- `wake`: default `true`. When the worker settles while the parent is idle, the
  completion message starts a parent turn, so the main agent can act on the
  result without the user typing. `false` only queues the result for the next
  turn. A worker the parent killed never wakes it.
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
parent editor while any team exists.

Teams reuse `agent_spawn`'s caps, validation, rollback, permission prompts, wake
behavior, retention, and shutdown. There is no separate process manager, and
ownership is not a filesystem lock. Members can message each other and ask the
operator questions, but only through this extension: there is no direct
process-to-process channel (next section). `/team <objective>` sends one
extension-origin planning message and starts a parent turn if idle; bare `/team` only
opens the workspace. See [../../docs/native-teams.md](../../docs/native-teams.md).

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
Pi team members are the one exception: they load `member.ts` from this package,
which registers only the mailbox-backed team tools described above. Claude team
members get the same tools from `member-mcp.ts` through their own `mcp.json`.

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
Tool text is capped at 50KB/2000 lines plus a truncation notice. Oversized tool
results include a private `/tmp/pi-subagents-output-*/output.txt` snapshot that
the `read` tool can open. This applies to all subagent tools. Snapshots remain
until removed or system temporary-file cleanup.

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
