# Subagents for Pi

Background workers with separate Pi sessions, plus a monitor at `/agents`
(`Ctrl+Alt+A`). Spawning returns immediately; waiting is an explicit operation.

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
| `agent_spawn`      | Start a batch and return agent/run IDs without waiting for tasks.              |
| `agent_list`       | Show workers grouped by run, including model, status, task outcome, and usage. |
| `agent_transcript` | Read current-task output, or retained history with `full: true`.               |
| `agent_steer`      | Send new instructions; wait for RPC acceptance, not task completion.           |
| `agent_kill`       | Stop one worker, a run, or all workers; await process termination.             |
| `agent_wait`       | Wait for selected tasks to settle; report failures and timeouts explicitly.    |

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
  the child does not reinstall them; an uninstalled remote source is installed
  into Pi's temporary scope on every start. A directory source loads the whole
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
any child starts. Startup and model failures can still happen asynchronously;
inspect worker status rather than treating a spawn acknowledgment as success.

Use IDs when names are duplicated:

```json
{ "id": "ag_01", "message": "Focus on credential expiry instead." }
```

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
of `id`, `group`, or `all: true` to stop them.

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
parent is idle; with `wake: false` it waits for the next turn. Print/JSON
parents use tool results instead of injected notifications.

## Monitor

Three panes show runs, workers, and the selected transcript. Long run/worker
lists scroll to keep the selection visible. Small terminals use a reduced view
instead of rendering lines wider than the terminal.

- `Tab` / `Left` / `Right`: switch run/worker selection scope.
- `Up` / `Down` / `j` / `k`: select.
- `PageUp` / `PageDown`: scroll transcript; `Home` jumps to its start.
- `End`: resume following new transcript output.
- `x`, then `x` again: stop the selected worker or run. Any other key cancels
  the confirmation; it also expires automatically.
- `Escape` / `q`: close.

The monitor is read-only except for stopping workers. Steering goes through the
main conversation. It shows completed assistant messages and tool activity, not
a token-by-token copy of the child's editor.

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

RPC commands are correlated with acknowledgments and have deadlines. Output uses
UTF-8-safe JSONL decoding. Failed tasks, broken pipes, rejected commands, and
signal exits are distinguished from successful completion.

The runner bounds its retained transcript and individual items. Older or oversized
content is marked as omitted; the child's `sessionFile` is the canonical history.
Tool text is capped at 50KB/2000 lines plus a truncation notice. Oversized tool
results include a private `/tmp/pi-subagents-output-*/output.txt` snapshot that
the `read` tool can open. This applies to all subagent tools. Snapshots remain
until removed or system temporary-file cleanup.

Shutdown first asks Pi to abort so it can clean up active tools, then escalates to
SIGTERM and finally SIGKILL if needed. Only the tracked child is signalled; no
process-name matching is used. Kill/shutdown await actual child closure. Forced
SIGKILL cannot guarantee cleanup of grandchildren or independently launched
services; this is not process-container isolation.

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
RPC workers and lifecycle; `modal.ts` owns rendering and keyboard behavior. Each
has adjacent regression tests.
