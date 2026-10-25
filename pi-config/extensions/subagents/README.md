# Subagents for Pi

Background workers with separate sessions, plus a monitor at `/agents`
(`/subagents` alias). Spawning returns immediately; waiting is an explicit operation.
Pi is the default backend. `backend: "claude-code"` runs a Claude model on Sova's tools: the
worker is a pi worker whose model is the [Claude Code extension](../claude-code/README.md)'s
provider (`claude-code-cli/<catalog id>`), the path a Claude Code chat runs on
(`claude-workers.ts`, see [Claude Code workers](#claude-code-workers)). Mixed batches are
supported. Options below describe Pi unless stated otherwise.

Installed globally through this symlink:

```text
~/.pi/agent/extensions/subagents -> ~/pi-config/extensions/subagents
```

Every worker is a chat process of its own that Sova's server starts and keeps (its
`WorkerHost`, `worker-host.ts`; `chat-worker.ts` drives one). Without that host (the
pi TUI) spawns are refused: "needs Sova's chat runtime". **A reload, a session
replacement or the parent's crash never ends a worker**: the next manager of that
session reattaches to every live one, and a completion it missed is announced once.
Every chat, worker and team member runs in a process of its own, so a server restart
never ends a worker either. Agent/run ID sequences are restored from
the parent session so old references cannot target unrelated new workers.

## Tools
| Tool               | Behavior                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| `agent_models`     | Discover loaded backends and exact model IDs using the active registry/CLI.    |
| `agent_spawn`      | Start a batch and return agent/run IDs without waiting for tasks.              |
| `agent_list`       | Show workers grouped by run, including model, status, task outcome, and usage. |
| `agent_transcript` | Read current-task output, whole, paged by `offset`/`limit`; while busy, bounded recent activity; `full: true` for retained history. |
| `agent_steer`      | Send new instructions; wait for acceptance, not task completion.               |
| `agent_kill`       | Stop one worker, a run, or all workers; await process termination.             |
| `agent_wait`       | Wait for selected tasks to settle; report failures and timeouts explicitly.    |
| `agent_resume`     | Bring a restored worker back idle in its own backend session (see below).      |
| `team_create`      | Create an explicit coordinated team with unique roles and advisory ownership.   |
| `team_add`         | Add members to a live session team; history teams remain read-only.             |
| `team_list`        | Inspect teams, actual member state, declared scope, and bounded actions.         |
| `team_eject`       | Release an ended member's seat in a session team (parent only; see below).       |
| `team_succeed`     | Replace a team's ended coordinator or monitor, once none with that duty is live. |

Team members additionally get `team_msg`, `team_inbox`, `team_ask`, and for an
orchestrator member `team_roster` and `team_steer`, through a restricted member
extension (`member.ts`); a Claude Code member is a pi worker and loads it too. See
[Team messaging](#team-messaging-orchestrators-and-operator-questions).

Find models without guessing IDs or invoking a separate Pi CLI:

```json
{ "query": "deepseek 4.1 flash" }
```

Pass this to `agent_models`; optionally set `backend: "pi"` or `"claude-code"`
and `limit` (default 30, maximum 100). Pi uses the current session registry,
including extension/cloud providers. `claude-code` lists Sova's Claude catalog
(`claude-code/catalog.ts`) with each model's efforts, with no `claude` process. Discovery failures are
reported per backend, not silently converted into an empty model list.

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

- `count`: positive integer; default 1. There is no per-request limit; a chat runs at most
  24 workers at once. Idle, steerable workers and every team member (a team's coordinator
  and monitor included) still consume a live slot. A request that would pass 24 is refused
  before anything starts: the refusal says how many the request needs, how many are live,
  how many more fit and how many to stop with `agent_kill`, and names the idle workers.
  It is worded for the caller (`team_create` names the members asked for and the coordinator
  or monitor it adds; `team_add`, `agent_spawn`, a successor and a resume count only what
  they start). Nothing is ever stopped to make room.
- `backend`: default `pi`; `claude-code` runs a Claude model on Sova's tools (below). Its
  defaults and validation apply; it does not inherit the parent's model/tools/effort.
- `backendOptions`: options owned by the selected backend (unsupported for Pi; for
  `claude-code`, see below).
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
- `extensions`: extension sources the child loads on top of its fixed set
  (discovery stays off, so nothing else loads): a path, `npm:name` or
  `git:host/owner/repo`. Any of Sova's own extensions can be named and loads
  with no install step. Packages Pi has already installed for the
  user (`~/.pi/agent/npm/node_modules/<name>`, `~/.pi/agent/git/<host>/<path>`)
  are loaded from their installed directory. An exact npm version pin is used
  only when the installed package version matches. Nothing is installed at
  spawn: any other source (an uninstalled package, a range, tag or git ref pin
  the installed copy doesn't match) refuses the spawn with "<source> isn't
  installed: install it first (`pi install <source>`)". A directory source loads the whole
  package manifest, ignoring any per-extension filter in `settings.json`. Local
  paths must exist. This extension's own directory is refused, so children still
  cannot spawn children. With `extensions` set, the `tools` allowlist restricts
  only built-in tools; every tool the listed extensions register stays enabled.
- `fork`: default `false`. `true` starts the child from a copy of the parent's
  session file, so it sees this conversation's full history. The
  parent's file is never written by the child; the copy records it as
  `parentSession`. The parent's in-flight `agent_spawn` call has no result yet
  in the copy; Pi inserts a synthetic empty result for it. Requires a persisted
  parent session; an ephemeral (`--no-session`) parent cannot fork.

Beside `agents`, the settings `backend`, `model`, `effort`, `cwd`, `wake`, `tools`,
`systemPrompt`, `backendOptions`, `extensions` and `useWorktreeConfig` are shared: each
applies to every agent that leaves it out, and the call is refused (naming the setting and
the `agents[i]` that differ) if an agent sets a different value. A `prompt` beside `agents`
is every agent's prompt only when no agent has its own. `name`, `count`, `fork` and
`agentType` stay inside each agent and are refused beside `agents`. `agents` (and a team's
`members`) given as a JSON string of a list of objects is read as that list. These reads run
before pi's schema check (`prepareArguments`), and every refusal is a plain sentence naming
the setting, never the schema's own words. The whole batch is validated before
any child starts (including backend checks such as a Claude spawn's model, tools and options).
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
uses Pi's normal steering (a Claude Code worker is a pi worker and steers the same way).
Omitting mode preserves existing Pi steering. A queued acknowledgment is not task
completion.

Pi itself continues queued messages after a failed run (its own queue, not
this extension's). The manager cannot reliably prevent that, so it reports it: the
failed run is recorded in the transcript, and the task that finally settles is
reported with outcome `error` and an error naming the earlier failure, even if
the queued continuation succeeded. Automatic retries and overflow-compaction
retries are not treated as failures.

Every steer and follow-up is sent under a key of its own, and a worker whose chat
process names keys in its feed (its state's `keys`; every worker started on current
code) tags the user message Pi delivers with that key. Its task (and its
`finalOutput`) begins exactly at that message: never at another run's start, never
at another message with the same text, so two identical instructions are two tasks.
An accepted instruction whose turn never started (Stop pressed while it was queued,
the worker's process died, a turn that failed before it began) is reported plainly:
one transcript line, "This instruction was accepted but never ran: …", and the same
line in the error of the next completion; with nothing else running that completion
comes at once, as an error, so nothing waits for a delivery that can't come.

A worker still running code from before keys (it keeps its code through a parent's
reload) names none, and gets the older, best-effort correlation below. It and this
list go in a later follow-up, once no such worker runs.

There, a Pi steer's task (and its `finalOutput`) begins at Pi's next run start, or at
the steer's user message when Pi delivers it inside the running run. Pi expands
`/skill:` commands and prompt templates, and input extensions may transform text,
before queueing, so the manager follows Pi's `queue_update` events: the entry Pi
appends while a steer awaits acceptance is taken as that steer, and its removal
marks the next user message with that text as the delivery. If an earlier steer
starts while a later one awaits acceptance and the later one is rejected, the
earlier steer's task stands from its start. Pi's queue has no per-message IDs, so
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

A worker starts when its chat process has opened its session; the task is then sent
as a keyed message, never twice. A steer, follow-up or team message is accepted when the
worker's chat takes it (Sova's server answers for it). A worker that refuses it reports why,
and nothing changes. If Sova's server doesn't answer within a minute (an outage), the
delivery is **unknown**: the steer is undone as for a refusal, the transcript gets one
error line naming the message, `agent_steer`, `team_msg` and the team action report
delivery unknown, the worker is **never stopped**, and nothing is sent again. Should
the message land after all, its run shows as the worker's next task. While a steer
awaits acceptance, its `queue_update` and even its delivery may arrive first; the task
boundary moves at delivery either way. Replacement instructions are not silently assumed
to have run.

Cancelling `agent_steer` **only cancels the acceptance wait, not the worker**.
Instructions already sent may still execute: the cancellation reports delivery
unknown rather than claiming rejection or task completion, and the worker's
events keep updating it. Inspect `agent_list` / `agent_transcript` before
retrying to avoid duplicate work. Use `agent_kill` explicitly to stop a worker.

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

## Worktrees

A worker starts only in the session's cwd (or below it) or inside one of the session's active
tracked worktrees (the `worktrees` extension's `worktrees` entry, folded from the branch at every
spawn with `worktrees/state.ts`, so the gate holds whether or not that extension is loaded). Every
start goes through it: `agent_spawn`, `team_create`, `team_add`, a team successor and
`agent_resume`, pi and Claude Code alike. A remote session is not checked. A worker
reattached after a reload or restart with a cwd no longer allowed keeps running; `agent_list`
flags it "outside this session's worktrees".

Every worker start, pi or Claude Code, asks the sandbox extension's one `workerLaunch({cwd, root?,
backend, owner})`. A worker started inside a tracked worktree is confined to writing there
(`root` set: the parent's scope narrowed to the worktree while the parent's sandbox is on; a
write-only scope while it is off). Every worker is a pi worker and gets extension flags: the
sandbox confines each of its tool calls. This file only passes that data through and interprets
no policy. If the sandbox extension is not loaded, or refuses, the spawn is refused. A backend
registered by another extension is refused while the sandbox is on or the start is
worktree-confined, since nothing confines it.

`useWorktreeConfig: true` (agent_spawn, pi or claude-code, cwd inside an active tracked worktree with a
`.agent`) runs the worker on `<worktree>/.agent`: `PI_CODING_AGENT_DIR` set to it, its session
in the parent's sessions directory for that cwd (so Sova lists and watches it like any worker), the
tree's `extensions/mode` loaded by path with the flags `major normal` and `minor spec`, and the
project's files trusted as for every chat.
Discovery stays off and the model policy is the parent's. It is recorded in the launch spec, so
`agent_resume` applies it again. A worker never loads any copy of `subagents` or `worktrees`
through `extensions`. The tree's mode extension learns it runs in a worker from the worker marker
(`subagents:worker` on the child's bus, `mode/events.ts`): it ignores the parent's `mode`
snapshots a `fork` copied and offers no spec writer.

## The parent's modes

The mode extension announces what this session's workers get of its modes on the bus
(`mode:worker`, `mode/events.ts`; asked for at load with `mode:worker-discover`): the spec block
plus a worker note while spec is on, and the saved copy of each project mode that is on and marked
`workers: yes` (`projectModes`; see the mode extension's README), nothing otherwise. Every worker started from then on —
pi or Claude Code, plain, remote, sandboxed, team member or successor — gets that text
appended last to its system prompt (after its agent type, its brief and any remote instructions);
the text is never interpreted here. It is a snapshot: a later switch never reaches a running
worker, and `agent_resume` takes the session's current announcement (the launch spec keeps the raw
brief). Two exceptions get nothing: a team's monitor (it has no tools) and a `useWorktreeConfig`
worker (its tree's mode extension gives it spec itself). The minor modes given are recorded with
the worker (the manifest's `modes`, newest start winning; `[]` for none; project modes by id after
the built-in ones) and published in the workers snapshot (`modes`, absent for none), which Sova
shows on the worker's view head.

A project mode's tools follow only to a local pi worker that has `bash` and isn't a
`useWorktreeConfig` worker: the parent's copies are written to a file (`PROJECT_TOOLS_FILE_ENV`)
and the worker loads `mode/project-tools-worker.ts` with `-e`, which registers them from that
file and refuses a call once the mode's folder changed since approval. A read-only or remote
worker gets the instructions without the tools.

## Remote sessions

When the parent runs on a remote target (pi-config's `remote` extension, `--target`; Sova opens
such sessions in an empty local placeholder directory), every worker runs on the target as well —
no backend ever gets local tools against the placeholder:

- pi workers, a Claude Code worker included, load the remote extension (`remote/index.ts` with the flag
  `target <name>`), so their built-in tools are the remote ones
  under the same names. Tool allowlists keep working by name.
- other backends are refused in a remote session, as is any spawn while the session's target
  failed to load.

The session is recognised from the remote extension's `remote:session` event on `pi.events`, else
from the placeholder cwd (`<agentDir>/sova/targets/<name>/<far path>`). See the remote
extension's README ("Workers").

## Claude Code workers

`backend: "claude-code"` (agent_spawn, a team member, a coordinator or monitor, Delegate) is
mapped onto a pi worker by `claude-workers.ts` (`claudeOnPi`, inside `spawnBatch`) and recorded
with backend `pi`. Its loadout then includes the claude-code provider
(`claudeCodeProviderLoad`) with the model id in the `claude-code-model` flag, so a Claude id the
catalog doesn't list still runs (the result says "Not verified").

- `model`: a Claude catalog id (an old alias read as its catalog model), default the current
  Sonnet; it runs as `claude-code-cli/<id>`.
- `effort`: `low`, `medium` (default), `high`, `xhigh` or `max`, kept as the worker's thinking
  level after its model is set; the provider hands it to the CLI. Anything else is refused.
- `tools`: Claude's names map to Sova's (`Read`→`read`, `Bash`→`bash`, `Edit`→`edit`,
  `Write`→`write`, `Grep`→`grep`, `Glob`→`find`, `LS`→`ls`); Sova's names are accepted as they
  are; any other name is refused. Omitted: all seven.
- `backendOptions`: `permissionMode` `bypassPermissions` or `dontAsk` change nothing; `plan` keeps
  only `read`, `grep`, `find` and `ls`. `acceptEdits`, `manual`, `allowedTools` and
  `maxBudgetUsd` are refused with the reason (Sova's tools have no per-call approval and no spend
  ceiling); an unknown key is refused.

Team tools, the sandbox, remote targets, spec mode, restore/resume, the death message's last
output lines and login failover (the provider bridge's) are the pi worker's. A native Claude Code
worker recorded before this change stays readable through `adapters/`; resuming it continues on
Sova's tools in a new session (see "Restored workers and `agent_resume`").

## Spec mode

While the spawning session has the `spec` minor mode on (the mode extension announces its active
modes as `mode:state` on `pi.events`; `mode:discover` asks), every worker that can change code
(`bash`, `edit` or `write`, a Claude Code worker's included) gets the **worker spec brief** appended to its system prompt: `spec-brief.ts`,
whole sentences quoted from `mode/spec-mode.md` by anchor, with `$core` pinned to this pi-config's
`spec/core`. `spec-brief.test.ts` pins the generated text, so a change to a carried rule in
spec-mode.md fails there until the brief is reviewed. Ad hoc workers and team members alike;
remote workers and `useWorktreeConfig` workers (which load the spec mode itself) do not get it.

pi workers (a Claude Code worker included), which load only their listed extensions, also load
`../mode/spec-worker.ts` (the mode extension's census hook alone: a census digest after a
tool call that changes `git status`), under the same condition as the brief; it is plumbing, so
the spawn summary does not list it. No worker is given a spec ledger.

When such a worker settles, its summary (the completion message, `agent_wait`'s
result, a coordinator's copy) carries one line after its answer (after the preview when the answer is
cut, before the cut notice) naming the § its own changes landed in:
"Spec: this worker's changes landed in §a, §b (+N more); unclaimed: x". It is read from the
worker's census state (`readLandedLine`): the worker's `<agentDir>/spec-hooks/landed/<key>.json`, which its census writes to the path
`SOVA_SPEC_LANDED_FILE` names. What other processes changed between the worker's calls is not in it;
no line when nothing it changed is in the boundary or mapped.

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

A disabled provider blocks all of its models; `agent_models` stops listing
blocked choices, and `agent_spawn`,
`team_create`, and `team_add` reject one with a reason — whether it was named
explicitly, taken from an agentType definition, or inherited from the parent
session's model. The reason says whether the model is off everywhere or only for
subagents, because those take different switches to undo. For non-pi backends the
backend id doubles as the provider (`claude-code` above), and a model-less spec on
a disabled backend is rejected too, since its default model is that provider's. A
`claude-code` spawn is checked under `claude-code` first and then, as the pi worker it runs
as, under the `claude-code-cli` provider.
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
instead of injected notifications. A settle an `agent_wait` returns is not sent
again as a message: while the parent's agent run is in progress (or a wait
collects the worker) its message is held, and dropped if a wait in that run
returns the worker still settled (the result carries it), whether the worker
settled before or during the wait. A held message no wait returned, such as one a
queued steer moved past, is sent where the run would otherwise stop, with its
wake, so it continues the same run; a `wake: false` one reaches the context at the
next turn end. If the run is aborted, held messages go into the transcript without
starting a turn, so a Stop never wakes the parent.

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

A member takes `role`, `prompt`, `ownedPaths`, `orchestrator`, `backend`, `model`, `effort`,
`tools`, `systemPrompt`, `cwd`, `wake`, `backendOptions` and `extensions` (by `agent_spawn`'s
rules, loaded beside its team tools; a successor keeps them). `count`, `fork`, `agentType` and
unknown settings are refused, naming the setting; a missing role, prompt, team name or objective
is refused, never filled in. `team_create`'s result has a `Standing roles` line naming the
coordinator and monitor Sova added and each one turned off, and by what. A team created past 24
members, the added coordinator and monitor included, is refused before anything starts.

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
members' headers, is skipped by a `team_msg` to `all` (named on its info line), and
a direct `team_msg` or `team_steer` to it goes to its newest live successor, else
fails saying it was ejected. `agent_resume` refuses it.
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

- **Pi members** load `<this package>/member.ts` among their listed extensions
  and get the identity in their environment. `member.ts` registers nothing without
  that identity and never imports the manager, so a child still cannot spawn,
  list, steer by ID outside its team, or kill anything. The parent keeps
  refusing this package under the user-facing `extensions` option.
- **Claude Code members** are pi workers on the Claude Code provider, so they load
  `member.ts` the same way; the provider serves its tools to the model.

Member tools:

| Tool           | Who          | Behavior                                                                                         |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `team_msg`     | any member   | `{ to, message, subject?, urgent?, replyTo?, needsReply? }`; `replyTo` closes that item in your inbox, `needsReply` stores a question; `to` is a sibling role, worker ID, or `all`. Queues an inbox item per recipient and answers at once (`Queued for <role> (<id>): item i_N`). |
| `team_inbox`   | any member   | `{ action?: list \| open \| done \| sent, ids?, note?, limit? }`; the member's inbox, served by the parent. |
| `team_ask`     | any member   | `{ question, subject? }`; to the routing coordinator as a `question` item, else to the operator; the answer arrives later. |
| `team_roster`  | orchestrator | Live roster of the member's own team with states, ownership and recent actions.                  |
| `team_steer`   | orchestrator | `{ to, message, mode? }`; instructions for one sibling. Same acceptance semantics as `agent_steer`. |

Transport and delivery: each tool writes one request file into the member's own
directory under the parent session's mailbox root
(`<agent dir>/sova/teams/<session key>/mailbox/team_NN/ag_NN/requests`, beside the team's handover
notes, kept across reloads and restarts), then waits (up to 45 seconds)
for the parent's response file. The parent polls every 250ms while teams exist,
derives the sender from the directory (a request body is never trusted for
identity), validates scope against the team store, and performs the action
itself through the same `steerWorker` path the tools and workspaces use:

- A message becomes an **item** in each recipient's inbox (see "Team inbox"
  below) and the tool answers as soon as it is stored. `all` is one copy per live
  sibling, never the sender; stopped and ejected members are named on one
  `skipped (stopped): …` line, never reported as failures. A message to a member
  that was succeeded goes to its newest live successor (`forwarded to …`); one to
  a stopped member with no successor is refused, naming `agent_resume`.
- `team_steer` is accepted only from an orchestrator, only for one sibling of
  its own team (never itself, never `all`, never another team). The text is
  prefixed `[Instruction from orchestrator <role> (<id>), team_NN]` and the
  requested `mode` is passed through. It is a direct instruction: delivered in
  full on the recipient's delivery lane (below), with an `instruction` copy in
  its inbox as history.
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

### Team inbox

Every team message and every notice the parent sends a member (end-of-task
reports to the coordinator, handover notices, team additions, the monitor's
notices, `wake_nudge` fires) is an item in the recipient's inbox, so none is
refused because the member is busy, starting or asleep, and none is lost.

- **Storage** (`inbox.ts`, node builtins only): one append-only
  `<mailbox root>/team_NN/ag_NN/items.jsonl` per member; the parent is its only
  writer (a member's `team_inbox` is a mailbox request of type `inbox`). Ops:
  `add`, `status`, `listed`, `move`, `return`; the fold skips a torn line. Item
  ids `i_<base36>` are unique and increasing across the whole parent session
  (never reused, a hint file `inbox-seq.json` covers compaction). An item has a
  subject (≤120 chars, default its first line), the message (≤8,000), `urgent`,
  `replyTo`, kind (`message`, `question`, `report`, `handover`, `notice`,
  `instruction`) and status `new → read → addressed` with an optional note;
  an addressed item records `closedBy` (`member` for `done`, `reply` for a
  `replyTo` answer, `auto` for the safety net; absent = member, older lines).
  Compaction keeps every open item and the newest 2,000 others per member.
- **Delivery lane** (`delivery.ts`): every steer to a worker, the main thread's
  `agent_steer` and the `/team` workspace's included, runs on a serial lane per
  worker, so the worker's single-steer guard is never hit concurrently and
  "agent is still starting" is waited out while the worker is live; a redirect
  goes ahead of queued entries, never the one in flight.
- **Wakes**: an idle member's normal items are gathered for 3 s, then it gets one
  list (`[Team inbox: N new (k urgent) — …]`, at most 20 lines, urgent first,
  subjects only: a member must open an item to see it; a list of exactly one
  item shows it in full and counts as opening it; an item listed before and
  still unopened is marked `(unopened)`). It ends with a **Still open** block
  (≤5 lines: items opened and not closed, questions first) and the footer
  telling the member to close each item in the same step as the work. An
  urgent item wakes it at once. A busy member gets urgent items at its next step (a
  mid-turn steer) and normal ones when its turn ends. One wake is in flight per
  member; a failed wake is retried after 5 s, 15 s, 60 s, then every 5 min while
  the member is live (team action `wake retry`).
- **Inbox zero** (§app.teams/inbox-zero): opened items are tagged with the
  worker's task (`fold.ts` `inboxTurn()`; a wake's items with its steer number
  until that steer's run begins, `steerTask()`), so a wake accepted after a run
  ended but before its settle was handled belongs to the next turn. At each
  settle (before the routed report) the parent closes, `closedBy: "auto"`, every
  open non-question item seen in a task that has ended; never an unseen item,
  never one read with no turn record (before this change). `replyTo` closes an
  item of any kind; `team_msg` `needsReply: true` stores a `question`.
- **The gate** (§app.teams/inbox-gate): a wake that starts an idle member's turn
  and lists unopened items carries `[Open your inbox first: team_inbox open …]`;
  `member.ts` then refuses every tool but `team_inbox`, `team_msg` and
  `team_ask` (`tool_call` block) until an item is opened. A later user message
  that is not a wake (a direct instruction) lifts it for the turn.
- **Older member code**: `member.ts` writes `caps.json` (`{"inbox":1}`) into its
  directory at load. A member picked back up without it (or on a backend without
  team tools) gets each item in full on the lane, plus the legacy `inbox.jsonl`
  copy its old `team_inbox` reads. A new member whose parent is on older code
  falls back to that copy for `team_inbox list`.
- **Moving and returning** (`inbox-lifecycle.ts`): every end (stopped, failed, ejected, found
  ended after a reload, retired) counts as the end of the member's turn, so first every item it
  opened in a recorded turn that is not a question closes automatically (`closedBy: "auto"`); handled
  news is never returned as "not addressed" nor moved. Then: at retirement the old member's open items move
  to its successor (ids and senders kept, `movedFrom` recorded, listed to it); a member that ends
  with a live successor hands them on the same way. A member that ends with none (stopped, failed,
  ejected, or found ended after a reload) returns them: one "not addressed" notice per sender — a
  member sender gets a `notice` item, Sova's own items go to the routing coordinator, and the main
  thread's (or any whose sender has ended too) come back to the main chat as a displayed
  `team-notice` message that starts no turn. After a reload the parent folds every
  `items.jsonl`, returns the items of members found ended, and wakes each live member for items it
  was never listed.
- `team_roster` and `team_list` show each member's open count (`3 open items`), with its
  unanswered questions and the oldest one's wait (`3 open items (1 question unanswered 20 min)`),
  and one team line, `Inbox: N open · closed by members M · automatically A`; a queued answer
  notes a recipient with more than 50 open items.
- **Reports name what is left**: a member's report routed to its coordinator, and the
  coordinator's own completion to the parent, end with `[Left open: i_7 question from writer
  (opened); i_9 report (unopened)]` when items are still open after the turn-end safety net.

`orchestrator: true` is a per-member flag on `team_create` / `team_add`. It is
sibling-scoped coordination only: the orchestrator can see its team and steer
its siblings, and it must ask the operator (`team_ask`) to add or stop members.
It is accepted on the Pi and Claude Code backends (the only ones that load
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
 "monitor":{"enabled":true,"role":"monitor","primary":{"backend":"pi","model":"ollama-cloud/deepseek-v4.1-flash","effort":"low"},"fallback":{"backend":"claude-code","model":"sonnet","effort":"low"},"contextPct":60,"everyMinutes":10,"usage":{"enabled":true,"pausePct":90,"resumeMarginMinutes":5},"instructions":""},
 "handover":{"retireTimeoutMinutes":10}}
```

- **Coordinator, enforced.** `team_create` adds a member on `coordinator.role` with
  `orchestrator: true` on the first tuple that passes the spawn checks (backend loaded, model
  policy, pi registry / backend validation): primary, then fallback; neither → the team is not
  created. A single caller orchestrator becomes the coordinator instead; two are refused, as is a
  caller member on a synthesized role, and so is an orchestrator `team_add`ed to a team with a
  coordinator. The refusal says only the coordinator is the orchestrator, that it hands over with
  `team_succeed`, that a member that only watches needs no mark, and (when no coordinator is
  live) that the main chat can start a replacement. It does no implementation (its header says so) and gains
  `team_report` and `team_succeed`. It routes the work the main thread assigned and never invents
  tasks: its header quotes each teammate's prompt (first 1,500 chars, then a marker), and its
  `team_roster` lists every non-duty member's assignment with every main-thread steer to it (up to
  40, 2,000 chars each, older ones counted; the roster shows 500 chars of each). A successor
  inherits its predecessor's assignment and steers. Tasks and steers are also written to the
  session as `subagents-team-assignment-v1` entries (`task`, `steer`, `inherit`), which a reload
  folds back, so a resumed coordinator's roster still lists them. Members the main
  thread adds later with `team_add` are announced to it as a `notice` item with their tasks (the
  `team_add` result says it was queued, or that no coordinator is live to tell). Its header
  also says: the main thread's steers are assignments it must not countermand, and it never tells
  a member that main-thread work (a successor's inherited steers included) is not its work; the
  roster, the header and the handover message label every such steer as binding; succeed a flagged
  member unless its assigned work is verifiably finished; report pause and resume with
  `team_report`. `defaults: { coordinator: false }` opts one team out (no
  monitor either); `defaults: { monitor: false }` drops only the monitor. Coordination is fixed at
  creation; `team_add` never retrofits it.
- **Routing.** Everyone else is `wake: false`. Their completions go to the routing coordinator
  (the newest live member with the coordinator duty) as `report` items (urgent when the task
  failed; with no live coordinator left to take one, the parent gets it, woken), and their `team_ask`
  questions as `question` items; the parent sees neither. The coordinator's completion reaches the parent and
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
  pause when a provider is blocked, `wake_nudge` at the reset + margin, then resume). A login is
  out when a non-weekly window (`5h`) is at or over `pausePct` or a `7d…` window is at 100%; a 7d
  window below 100% is informational. A provider is blocked only when every login is out: Claude
  counts `claude` (the default login) and each `claudeAccounts` entry with a reading that is not
  `skipped: "auth"` (this host's only; the mesh pool is not consulted). The roster names each
  window's login when there are several, marks AT/OVER only the windows of a blocked provider, and
  says `headroom on N of M logins — not a reason to pause` when some are out. The parent enforces
  the wait: at a `pause` notice it records, per blocked provider, the blocking windows of the login
  that frees soonest (`blockingWindows`), and refuses a `resume` notice (delivering nothing,
  recording no event) until the latest of those resets plus `resumeMarginMinutes` (read at the
  resume) has passed; the refusal names the window and the time. A pause with no such window holds nothing, and the hold is in memory only
  (a pause restored after a reload has none). Its roster carries the
  thresholds read now and the usage-status windows of the providers the team's models spend
  from (`<agent dir>/cache/usage-status.json`); a window whose `resetsAt` has passed shows as
  reset (usage unknown), never AT/OVER, so a stale cache cannot keep a team paused. `wake_nudge` is served by the parent (a member
  cannot start its own turn): the wake-nudge extension's bounds (10 s – 24 h, `at` up to 60 s
  past clamps, 5 pending), a fire is an urgent `notice` item from Sova. **An idle team costs no monitor turns:** a
  nudge that comes due while no other member is working, and the team is not paused (a monitor
  `pause` notice not yet followed by `resume`), is held — one per monitor, later ones collapse into
  it, `list` shows it, `cancel` drops it — and delivered at the first refresh that sees a teammate
  working (every worker state change and accepted steer schedules one). A paused team's nudges
  fire on time, so the resume check runs; after 30 such fires with no teammate working,
  scheduling is refused until one works. Pending nudges are kept in the mailbox (`nudges.json`)
  and re-armed, held or not, by the next manager after a reload or restart. The pause is read
  back from the `pause`/`resume` events on the branch at `session_start`, and a paused team's
  monitor that rejoins (reattached, or `agent_resume`) is sent the resume check at once, as an
  urgent `notice` item.
- **Context column.** `team_roster` and `team_list` show `context 123k/200k (61%)` per live
  member: the worker's `contextTokens` over the spawned model's window (a Claude model: the
  catalog's, through the extension's `claudeContextWindow` — 1M for `[1m]` or a natively 1M
  model, else 200k; any other: the registry), rounded down.
- **Handovers.** Notes live in `<agent dir>/sova/teams/<parent session id>/<team_id>/handoffs/<role>.md`
  (team IDs restart in every session, so the session id keeps two sessions' `team_01` apart; a
  session without an id uses `unsaved-<pid>-<time>`), named in each worker's and the coordinator's
  header. The monitor has no file tools and no note: it briefs its successor over `team_msg`, and
  its successor's task is the monitor task ("you take over from <old>"), with `team_ready` like any
  successor (an ended monitor's successor is told nobody is left to ask). `team_succeed { role }`
  (routing coordinator only, itself included) starts
  `<base>-<n+1>` (`builder` → `builder-2` → `builder-3`) on the same backend, model, effort, tools,
  system prompt, cwd, backend options, extensions, ownership and duty. The main chat's own
  `team_succeed { team, role }` does the same for a coordinator or monitor only, only for the
  newest one with that duty and only while none with that duty is live (working, idle or
  stopping), so two coordinators are never live at once; the old member has ended, so the
  successor starts at once and the old member's seat is released (action source `parent`). **A live worker writes its note
  first:** it is told, as a redirect so the instruction lands ahead of anything queued for it, to
  finish its step, write the note and end its turn, and the successor starts as soon as the note
  file exists (checked at every mailbox poll and every settle: no settle is needed, since
  follow-ups queued on the old member keep it from settling), when the old member ends, or after
  `handover.retireTimeoutMinutes`, whichever comes first. Started without a note, the successor is
  told the note may be missing and to ask its predecessor. The routing coordinator gets a
  `handover` item naming the successor and the real reason it started, read from the note at that moment
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
  so) — or `handover.retireTimeoutMinutes` after the successor starts, whichever is first. Both
  handover instructions go on the old member's delivery lane: never refused because a delivery is
  in progress, a redirect lands after that one; the `team_succeed` result says the old member was
  told to brief its successor only when that delivery was taken, else that it could not be told.
- **Runtime fallback.** The primary/fallback choice is made again while the team runs. A member
  with the coordinator or monitor duty whose turn ends with a failed task moves to its fallback at
  once when the error says its model is out of usage (`../provider-limits/usage-out.ts`: usage,
  credits, quota, balance or billing ran out, a usage limit was reached — monthly, weekly or 5-hour
  included, such as Ollama's `429: {"message":"you (…) have reached your monthly usage limit, add
  usage credits: …"}` or the Claude Code bridge's `You've hit your limit · resets 3pm` once every
  login is out — or the sign-in no longer works), and otherwise on its 3rd failed turn in a row (a
  good turn resets the count); a single 429 rate limit keeps today's path. Only once per member,
  only while it runs its role's current primary, never while a handover involving it is pending.
  The member is stopped, its seat ejected first (source `system`, so a full team of 24 still gets
  it), and its successor starts at once on the fallback through the main chat's replacement path
  (no note asked for, nothing to retire): a monitor's runs its first check at once; a coordinator's
  is told its predecessor stopped without a note and why, and routes the team from its start. The
  failed turn's own completion goes nowhere; the routing coordinator gets one `handover` item when
  the monitor switched; the `handover` event's detail is `successor <role> (<ag_NN>) on
  <backend>/<model>; fallback: primary <tuple> <reason>`, with a `handover` action row (Sova shows
  it as "Monitor moved to its fallback <model>: <primary model> <reason>."). With no fallback that
  can run, a monitor is stopped (one `notice` item for the coordinator, one `team-notice` in the
  main chat) and a coordinator is reported to the main chat once (a `team-notice`), and keeps
  running. The model is marked out for an hour as a `subagents-dead-tuple-v1` entry (`{version: 1,
  backend, model, reason, at, teamId?, duty?}`), replayed from all of the session's entries at
  `session_start`: every tuple check (standing roles, the members default, successors) refuses it
  meanwhile, and a team whose duty switched stays on its fallback. A failed monitor turn that
  doesn't switch, with no pending or held `wake_nudge`, gets its next check scheduled by the parent
  (`everyMinutes`), so the monitor never goes silent.
- **Records.** Team actions gain `report`, `handover`, `retire`, `wrap-up`, `pause`, `resume`
  (sources `monitor`, `system`); handover, retire, wrap-up, pause and resume are also appended as
  `subagents-team-event-v1` entries (`{version, teamId, kind, workerId, role, at, detail?}`; a
  `wrap-up` names the member told to wrap up, with `detail` like `context 78% of 200k`, and is
  written for the coordinator only when it is itself over the threshold), and `subagents-team-v1`
  members carry `duty: "coordinator" | "monitor"` and, on a successor, `successorOf: "<ag_NN of
  the predecessor>"` (older readers ignore both).

## Isolation, retention, and shutdown

Unless the parent's sandbox is on, or the worker starts in a tracked worktree, these are **not
sandboxes**. Workers share the host filesystem and user permissions;
assign non-overlapping edits or use separate worktrees. The parent conversation
is not copied. Children load their own normal Pi context, skills, settings, and
credentials for their cwd.

A worker runs Sova's chat runtime on the server's own Bun (`server/chat-runtime/bun.ts`;
a server on Node starts no workers), never on a runtime picked from the worker's cwd. A worker whose process stops
unexpectedly carries the last 20 lines (2 KB) of its log in its error.

Children open with extension discovery off and only their listed extensions, so they
do not receive the `agent_*` tools for recursive delegation. Parent extension-provided tools, providers,
safety hooks, or overridden tool implementations are **not inherited** unless
their source is listed in `extensions`. Inheriting a tool name does not copy an
extension's implementation. Use only providers a worker's own process can load.
A forked child (`fork: true`) inherits the conversation, not the extensions.
Pi team members are the one exception with tools: they load `member.ts` from this package,
which registers only the mailbox-backed team tools described above (Claude Code members
included).

Every pi worker (plain, team member or remote) also loads
`worker-mark.ts` first, which registers nothing and writes one
`subagents-worker-session` custom entry into the worker's own session at birth
(at `session_start`: pi refuses writes while extensions load). The data is
`{ v: 1 }`, plus `workerId`, `teamId` and `role` when the child has a team
identity. The entry's name and shape are a contract with Sova, which reads it to
keep worker sessions out of its session list (`server/worker-sessions.ts`,
`SessionSummary.workerSession`). Claude Code workers, being pi workers, load it too.

### Restored workers and `agent_resume`

A worker's process outlives its manager: `/reload`, a session switch or the
parent's crash leaves it running, and the next manager reattaches. Every chat, worker
and team member runs in a process of its own, so a server restart leaves it running
too. Either way its
**durable record** survives: small `subagents-worker-manifest` custom entries in the
owner's session file (`registry.ts`, written for every worker of every backend). They
record publication (spec, team, the launch spec a resume needs), the backend
session identity (`ref`), each task start (`running`), each settle (`waiting`,
outcome and a usage snapshot), the ending, and each resume. The record type and
its one fold, `readWorkerManifests`, are the backend-neutral worker transcript
protocol in `worker-transcript.ts`, which Sova's server reads too; each backend's
own transcript is read through an adapter (`adapters/`, pi and claude-code; the claude-code
adapter reads the native Claude Code workers recorded before they became pi workers).

At `session_start` every recorded worker the host has no live chat for comes back as a
**restored** entry (`restored.ts`): no process, never counted as working or
toward the live cap, and it is never continued or re-reported on its own. A
worker that had ended keeps `done`/`error`/`killed`; one alive at the restart is
`restored`, marked interrupted when it died mid-turn. Its usage is read from its
own transcript, else the last snapshot (shown "as of" that time), else it is
unavailable, never 0. Records of every branch count toward the lifetime usage
total, once each; only the active branch's are listed (`agent_list`, `/agents`,
the live record Sova reads).

`agent_resume { id }` (and `/agent-resume ag_NN`, which Sova's Resume Worker
button calls) starts it again **idle** in its own backend session: a new chat
process reopening its session file, a Claude Code worker included. A native Claude Code worker
recorded before Claude Code workers became pi workers can't reopen its session: it continues on
Sova's tools under the same id, seat, cwd, model and effort, in a new pi session the parent seeds
with one message (`claude-workers.ts` `continuationMessage`: its old transcript's path, its task,
the last 2,000 characters of its last answer). Its Claude tool names map to Sova's (others are
dropped), only `permissionMode: plan` of its options is kept, and its record keeps the old session
as `continuedFrom`.
Nothing is sent to it and no completion is reported; `agent_steer` gives it its
next task. The session's current sandbox and remote state apply, exactly as at
spawn. A team member rejoins its team, which becomes live again, with its
mailbox and inbox as they were. Its earlier usage stays in its total.
Resume is refused for a live worker, an unknown ID, a backend that is not loaded,
and a backend whose transcript adapter declares `resume: "none"`; a failed
reopen leaves the restored entry as it was.

Every instruction to a worker carries a key, so one re-sent across a server
restart is delivered once. Failed tasks, rejected sends, and a process that
stopped unexpectedly are distinguished from successful completion.

The manager retains at most 50 finished workers, plus all live workers (including
idle, steerable workers). Oldest finished workers and empty runs are evicted from
the monitor and tool listings; `agent_list` reports cumulative eviction counts.
An evicted worker ID is never reassigned. Native session history on disk is not
deleted; retain its path/ID if you need to inspect it later.

The manager bounds each worker's retained transcript and individual items. Older or oversized
content is marked as omitted; the child's `sessionFile` is the canonical history.
Tool text is capped at 47,000 bytes/2000 lines plus a truncation notice, under
the 50,000 characters above which the Claude Code CLI replaces an MCP tool result
with a 2 KB preview (a Claude Code worker's tools reach its CLI over MCP). Oversized tool results include a private
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

The manager's shutdown only detaches from its workers; it stops none. `agent_kill`,
team teardown and a spawn rollback stop the worker's chat through the host, which
resolves once its process is gone. Archiving or deleting the parent session stops
all of its workers. A unit's whole cgroup goes with it; a child's grandchildren and
independently launched services may survive: this is not process-container
isolation.

## The shared fork core (`fork/`)

One owner of every fork's prompt-cache logic, used by Sova's "Fork from here" (a new
visible session, built by the server) and by background forks (a hidden worker chat that
works in a copy of the conversation and reports back: /explain's worker today). It is a
library, not an extension: pi loads nothing from `fork/` by itself.

| File | What it owns |
| --- | --- |
| `fork/cache.ts` | A fork's cache identity: the inherited key and its `sova-fork-cache` entry, the `prompt_cache_key` hook, Codex `session-id` affinity in a hosted session (`applyForkCacheRouting`, SSE) and in a fork's own process (`routeProcessForkCache`, its own fetch and WebSocket). Runtime builtins only: Sova's server imports it |
| `fork/claude.ts` | A UI fork of a Claude Code chat: seed it with the source's live CLI session (`seedClaudeFork`). Builtins only: the server imports it |
| `fork/copy.ts` | `forkable`, `copyForFork` (complete lines only, plus the cache entry), `sweepStale` |
| `fork/mirror.ts` | The request mirror (replayed sections and tool declarations), the run's `ForkPolicy` and the per-call gate |
| `fork/child.ts` | The extension loaded last into a background fork's child: wires the mirror, the gate and the cache identity |
| `fork/background.ts` | `startBackgroundFork(spec, {onSettled})` → `{stop, model, sessionId, sessionFile}`; `claudeForkPointFor` |

A background fork's policy is `{label, web?, writeDir?, writeHint?}`: every child reads
(`read`, `grep`, `find`, `ls`) and runs one read-only shell command line; web tools and
`write`/`edit` inside one directory only when named. The child declares the parent's tools
and prompt exactly as the parent did, whatever the policy, so the policy never costs the
prefix. `{label}` alone is a read-only fork that writes nothing; its result is
`onSettled`'s `finalOutput`.

The live proof (`tests/fork-cache-live.mjs`, opt-in, small model calls): a throwaway parent
whose first message carries a block no other request ever sent (so a hit on it can only be
the parent's own cache entry), then one background fork; it compares the parent's last
request with the fork's first, from the two session files.

```sh
PI_CODING_AGENT_DIR=<hermetic agent dir> node tests/fork-cache-live.mjs --model zai/glm-5.3
```

## Verification

Offline regression tests (no model requests; `fork/*.test.ts` included):

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

Source ownership: `index.ts` owns tools and session integration; `chat-worker.ts` and `fold.ts` own
a worker's lifecycle and its event fold; `modal.ts` owns rendering and keyboard behavior;
`teams.ts` owns team state and prompt headers; `mailbox.ts` owns the file
transport shared by the parent and the child-side member tools (`member.ts`);
`claude-workers.ts` maps a `claude-code` spawn onto a pi worker. Each has adjacent regression
tests.
