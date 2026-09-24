# Claude Code workers for Pi

A separate extension supplies the `claude-code` backend to the existing
`subagents` extension. The parent can use any Pi model (including Astra); workers
run the locally installed Claude Code CLI with its own tools and authentication.
No Claude SDK, terminal automation, or duplicate agent manager is used.

## Install

Both extensions must load:

```sh
ln -s ~/pi-config/extensions/claude-code ~/.pi/agent/extensions/claude-code
# subagents is already linked on this machine; install.sh links both on new hosts.
```

Run `/reload` after existing workers have finished (reload stops owned workers).
`claude` must be installed and authenticated. The runner invokes the executable
directly, never a shell alias. No credentials are copied into configuration.

## Discover models

Use `agent_models` with `backend: "claude-code"`, or `/subagents models opus`.
Choices and effort levels come from the installed CLI's initialize response,
without a model request. Only model metadata is returned, never account details.
Successful discovery is cached for 60 seconds; errors are surfaced explicitly.
A discovery call returns within 15 seconds, and immediately when cancelled. The
discovery process is still stopped (EOF, then SIGTERM, then SIGKILL) afterward,
and reload/shutdown waits for it to close.

## Delegate

```json
{
  "backend": "claude-code",
  "name": "implementor",
  "cwd": "~/webapps/example",
  "model": "sonnet",
  "prompt": "Implement the agreed change. Run focused tests and report results."
}
```

Use this with `agent_spawn`. Existing calls without `backend` still use Pi.
Prompts and steering messages are limited to 262,144 characters; an oversized
`prompt` is rejected before any batch member starts. `systemPrompt` is passed
through a private temporary file (`--append-system-prompt-file`, mode 0600 in a
0700 directory), not the command line, so it is not visible in the process list
and is not limited by argument size. The file is deleted once the CLI has
initialized (it reads the file at startup), or when startup fails.
Mixed Pi/Claude entries work in the same `agents` batch and share the manager's
8-per-call / 12-live-worker limits. `agent_list`, `agent_transcript`, `agent_wait`,
and `agent_kill` work for both backends. Completion wakes the parent by default;
set `wake: false` to queue the result for its next turn instead.

Claude defaults:

- Model: `sonnet` (CLI alias); effort: `medium`. These do not inherit a non-Claude
  parent's model or Pi reasoning settings.
- Tools: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`. Use native Claude names;
  `tools: []` disables tools. Native recursive delegation is not enabled by default.
- Permission mode: `bypassPermissions`. Workers skip permission checks and do
  not prompt for approval. Explicit restrictive modes remain available via
  `backendOptions.permissionMode`. With `manual` or `acceptEdits`, operations
  requiring approval are presented through Pi confirmation dialogs (file edits
  may proceed without prompting in `acceptEdits`). Each dialog names the
  requesting worker and its ID (instances of one `count` spec are distinct).
  Prompts are serialized across workers. Each displayed dialog gets a
  full 60-second response window; time waiting behind another dialog does not
  count. Queued prompts are bounded and cancelled on worker interruption or
  shutdown. The prompt displays the resolved worker directory. Unavailable UI,
  rejection, or a displayed-dialog timeout denies the operation.
- User/project/local settings and ambient MCP configuration are not inherited
  (`--setting-sources ""`, `--strict-mcp-config`). Normal Claude project
  instructions remain available. These workers are **not sandboxes** and share
  host filesystem permissions.
- MCP servers: the manager may pass `mcpServers` (team members get the
  subagents `team` server, see the subagents README). The runner writes them to
  a private 0600 `mcp.json` beside the system-prompt file, passes it with
  `--mcp-config`, and removes it when the worker closes; server `env` entries
  never appear in the CLI's own environment or argv. Outside
  `bypassPermissions`, an `mcp__<name>` rule is appended to `--allowedTools`
  after any operator rules so the configured server's tools do not prompt or
  get denied. Names are restricted to `[A-Za-z0-9_-]` and commands/args/env to
  plain strings; anything else fails the worker before launch. A configured
  server that does not connect fails the worker: Claude only marks it `failed`
  in its startup event and would otherwise run the turn without those tools.
- `env` adds variables to Claude's own process, merged over the inherited
  environment after the nested-session markers are dropped. It is for settings
  the CLI reads only from its environment: `MCP_TOOL_TIMEOUT` (milliseconds)
  bounds every MCP tool call, and a per-server `env` in `mcp.json` reaches that
  server, not Claude. Names and values are validated like server `env`.

Optional policy is explicit and validated before starting any batch member:

```json
{
  "backend": "claude-code",
  "prompt": "Run the existing tests and summarize failures.",
  "backendOptions": {
    "permissionMode": "manual",
    "allowedTools": ["Bash(npm test *)"],
    "maxBudgetUsd": 1
  }
}
```

Supported permission modes: `bypassPermissions` (default), `acceptEdits`,
`manual`, `dontAsk`, `plan`. Explicit modes are preserved even without an
interactive approval callback; unavailable approval is denied rather than bypassed.
`allowedTools` contains native Claude permission rules, distinct from the
available `tools` list. Broad rules such as `Bash` grant unprompted shell access;
these options can be requested by the coordinating model and are not a sandbox
or a separate human authorization boundary. User/project Claude deny rules and
hooks are not inherited (`--setting-sources ""`); choose conservative allow rules
or `manual` mode when you want per-operation approval. In the default
`bypassPermissions` mode, permission rules do not provide an approval boundary;
the available `tools` list still controls which tools are exposed.
`maxBudgetUsd` is Claude's reported cost ceiling, not a guarantee about how a
subscription account is billed. Permissions are enforced by Claude, not by
Pi's parent tool hooks.

Pi-specific `extensions`, `agentType`, and `fork: true` are rejected for Claude.
Provide additional role instructions with `systemPrompt` and a concise context
handoff in `prompt`; a Pi conversation file cannot be loaded as a Claude session.

## Inspect and steer

`/agents` and `/subagents` open the same monitor. The header identifies the
selected backend. Select a live worker and press:

- `r`: redirect with new instructions (editor opens).
- `f`: queue a follow-up (editor opens).
- `x`, then `x`: stop the selected worker/run.

The model-facing equivalent:

```json
{ "id": "ag_01", "message": "Stop that approach; implement the smaller fix.", "mode": "redirect" }
```

```json
{ "id": "ag_01", "message": "Afterward, review the test coverage.", "mode": "followUp" }
```

These are `agent_steer` arguments. Claude's default is redirect. Redirect waits
for interrupt acknowledgment **and task settlement** before delivering the
replacement. The interrupt/settlement deadline is 15 seconds; a message-delivery
acknowledgment has a 30-second deadline. A timeout fails closed: the worker is
stopped, an error is returned, and replacement execution is not assumed. Malformed
stream-json output also fails closed rather than masking protocol corruption.
Follow-ups are held by the extension until the current task settles; raw mid-turn
Claude stdin input is not a reliable separate-task queue. A follow-up sent to an
idle worker starts immediately. Queued follow-ups survive the abort a redirect
requests and run after the replacement; a genuine error or unrequested abort
drops them and records how many were dropped. Stopping or failure also records
dropped follow-ups. If the CLI exits on its own with follow-ups still queued,
the worker ends in `error`, not `done`.

If the interrupted task settles but its interrupt response is missing, the
redirect is rejected and the worker is kept idle rather than stopped. No new
turn starts until that interrupt is answered; one unanswered through the
30-second control deadline stops the worker, so a delayed interrupt cannot abort
later work. CLI 2.1.277 answers interrupts promptly, even when idle, so this is
a defensive path.

The parent is notified when the worker becomes idle, not for an intermediate
aborted turn during redirect or before a queued follow-up starts.

The CLI can also start a turn on its own after a task settled — it backgrounds a
Bash command that passes its 120-second timeout and reports the real result once
the command finishes. That turn's text still updates the transcript and the
worker's final output, and its uncorrelated successful `result` notifies the
parent a second time with the new answer (once per turn; an uncorrelated failure
while idle announces nothing).

Task completion and process exit are separate: an idle worker remains steerable,
even after a failed task. Requested interruption is recorded as aborted, not as
successful completion (the CLI's `aborted_tools` / `aborted_streaming` terminal
reasons). Permission denials can accompany an otherwise completed
Claude turn, so inspect the transcript/result rather than assuming all requested
operations occurred.

## Lifecycle and scope

Workers stay in one owned CLI process across turns. Shutdown interrupts active
work, closes stdin, waits for process closure, and escalates against the owned
process group if necessary. After group escalation and an observed leader `exit`,
output pipes get a 250ms drain before our handles are released. A detached process
holding inherited pipes therefore cannot hang cleanup after the CLI has exited.
A timeout/SIGKILL attempt alone never proves death; an unkillable leader still
leaves shutdown pending. Tests cover foreground cleanup and detached pipe holders,
but detached services remain outside containment. Use worktrees or non-overlapping
assignments for concurrent edits.

Reload, session replacement and quit stop workers. Automatic live reattachment,
arbitrary external Claude-session adoption, and cross-harness conversation forks
are not implemented. Claude retains its native session history on disk.

Output is bounded in memory and through the manager's existing tool truncation.
Usage comes from terminal results without repeatedly summing cumulative cost.
Protocol behavior is version-sensitive; live probes used Claude Code 2.1.276 and
2.1.277.
See [docs/protocol-probes.md](docs/protocol-probes.md).

## Claude Code as pi models (experimental provider)

The same extension can also expose the installed Claude Code CLI as ordinary pi
models — provider `claude-code-cli`, models `claude-fable-5-1[1m]`, `opus[1m]`,
`sonnet` and `haiku` — selectable in `/model` and in Sova's picker, streaming,
and running **pi's own tools**. It is opt-in and off by default:

- TUI: `pi --claude-code-provider`.
- Sova: Settings → Experimental → "Claude Code models" (stored in the agent
  dir's `sova/settings.json`; the server passes the extension flag to every
  session opened after the change). Off means nothing is registered anywhere.

The flag is read at `session_start` (pi applies caller-supplied flag values
after extension factories run), so no CLI process starts at load, and a
runtime shared by several Sova sessions keeps the provider once registered.

### How a turn runs

One long-lived `claude -p --input-format stream-json --output-format stream-json`
process per pi session, held in a process-global map keyed by the pi session id
(`provider/session-bridge.ts`), launched with `--tools "" --setting-sources ""
--strict-mcp-config --permission-mode dontAsk --permission-prompts none
--allowedTools mcp__sova`. Its `initialize` names one SDK-hosted MCP server, `sova`,
that the extension answers in-process over the control channel
(`provider/mcp-host.ts`): `tools/list` is built from the tools pi hands to
`streamSimple` each turn, so the model sees `mcp__sova__read`, `mcp__sova__bash`,
etc. When the model calls one, the CLI's `tools/call` is **held open**; the
provider ends pi's assistant message with `stopReason: "toolUse"`, pi executes
the tool with its own permissions and hooks, and the next `streamSimple` call
carries the result, which resolves the held call (text and images, `isError`
for tool failures). The CLI never runs a tool itself: `--tools ""` plus
`--strict-mcp-config` leave it nothing but `mcp__sova__*`, and the `--allowedTools`
rule is what stops don't-ask mode from auto-denying them.

`stream_event` frames map onto pi's `text_*`/`thinking_*`/`toolcall_*` events
(`provider/stream.ts`); usage comes from each API call's own `usage` (never the
`result` frame's `usage`, a sum over the turn's tool steps, unless the message
carried none; never the cumulative `total_cost_usd`). Esc / abort sends the CLI an `interrupt`. A model,
effort, system-prompt or tool-set change between turns restarts the CLI process
(`set_model` is probe-verified but v1 restarts for everything, see
`provider/DESIGN-bridge.md`). Thinking levels map onto the CLI's effort ladder
(`low`/`medium`/`high`/`xhigh`/`max`); `haiku` reports no efforts, so it has
no thinking levels. The child gets `MCP_TOOL_TIMEOUT=86400000` so a held call
outlives any pi tool (the CLI's own default is ~27.8 h; a stray value in the
user's shell would otherwise truncate long tools with a synthetic timeout
result).

### Rebuild on divergence

The bridge fingerprints the transcript prefix it has already sent. When pi's
next context does not extend it — rewind, branch, compaction, a changed system
prompt or tool set — the CLI process is restarted and the prior history is folded
into one user message. Prior tool calls and results are flattened to prose in
that fold: the CLI never pairs a replayed `tool_result` to a `tool_use`
(investigation invariant 1). Compaction summaries, which pi requests through the
same `streamSimple` without tools, count as a divergence too: they restart the
session's process, and the next real turn restarts it again.

### Limitations (read before relying on it)

These match the user's earlier investigation in
`../claude-cli/docs/investigation/INVESTIGATION.md` (CLI 2.1.278) unless a
divergence is stated, and are confirmed by `docs/protocol-probes.md`.

- **System prompt.** pi's system prompt REPLACES Claude Code's own preamble
  (`initialize.systemPrompt`, with `systemPromptSnapshot: false` so every turn
  carries the current prompt). The investigation measured that the `--system-prompt`
  flag disables prompt caching; through the initialize field, live turns still
  reported cache reads on a fresh process, so the cleaner prompt was kept.
  `--setting-sources ""` means the repo's `CLAUDE.md` is **not** read (pi supplies
  the context) — a deliberate difference from running `claude` in the same
  directory.
- **Thinking text is redacted** under subscription auth: thinking blocks arrive
  empty with a signature. pi shows no reasoning text for these models, and
  thinking cannot be turned off (the lowest effort still thinks).
- **No sampling control.** Temperature, top-p, max tokens and stop sequences do
  not exist on the CLI; pi's settings for them are ignored.
- **Cost shows as $0.** Subscription turns have no per-token price; the CLI's
  own `total_cost_usd` is a list-price estimate and is not surfaced.
- **Rebuild on divergence is lossy and cache-cold** (see above); a turn right
  after a rewind or compaction pays a full re-send.
- **Policy drift.** The control protocol is undocumented and version-sensitive;
  probes cover 2.1.276–2.1.278 only. A CLI update can change frame shapes or
  the permission handling that `--allowedTools mcp__sova` relies on; the bridge
  fails loud rather than guessing.
- Two retry layers (CLI-internal and pi) exist; rate limits surface as errors.
- **Process lifetime.** One CLI process per pi session lives until the session
  is archived / shut down (`session_shutdown`), the host exits (children are
  SIGKILLed on `exit`), or a divergence restarts it. An aborted turn keeps the
  process; the next turn restarts it if the transcript no longer extends what
  the CLI saw. A host that embeds the SDK directly and calls
  `AgentSession.dispose()` rather than disposing through `AgentSessionRuntime`
  never emits `session_shutdown`, so that session's CLI child lives until the
  host process exits — dispose through the runtime (pi's TUI and Sova both
  do).
- Divergences from the investigation, consciously: it proposed
  `--permission-mode manual --permission-prompts host` and answering
  `can_use_tool` for every SDK tool; this build uses `dontAsk` + `--allowedTools
  mcp__sova` so one round trip per tool call instead of two (pi's own permission
  hooks already gate execution). It proposed `set_model` for model switches; v1
  restarts instead, which is deterministic and shares the fold path. It proposed
  the temp-file `--append-system-prompt-file`; this build passes
  `initialize.systemPrompt` (replace), probe-verified after the investigation.

### Testing the provider

Offline: `node ~/pi-config/extensions/claude-code/tests/run.mjs` (includes
`provider/*.test.ts` on recorded frames; no CLI). The live protocol probes and
their scripts are in `docs/protocol-probes.md` and `tests/spike/`; they cost
quota and are never run by the test loader. Sova's hermetic end-to-end check:
`pnpm run dev:hermetic` (PORT 4810, `PI_CODING_AGENT_DIR=<repo>/.agent`) and
`PI_WEB_PORT=4810 pnpm run dev:web`, then switch the toggle on in Settings →
Experimental and open a new session on `claude-code-cli/sonnet`. Verified
2026-09-22 on CLI 2.1.278: a turn through pi's `read` tool, abort during a
running `bash` tool, an image returned by `read` (PNG) described by the model,
one `opus[1m]` turn, and archive killing the session's CLI child.

## Tests

```sh
node ~/pi-config/extensions/subagents/tests/run.mjs
node ~/pi-config/extensions/claude-code/tests/run.mjs
node ~/pi-config/extensions/claude-code/tests/smoke.mjs
node ~/pi-config/extensions/claude-code/tests/ui-permissions.mjs
# Opt-in: small live Claude requests using configured CLI credentials
node ~/pi-config/extensions/claude-code/tests/smoke.mjs --live
node ~/pi-config/extensions/claude-code/tests/live-controls.mjs --live
node ~/pi-config/extensions/claude-code/tests/live-manager.mjs --live
```

Offline tests use the already-installed Pi runtime through the existing test
loader; no second package installation is needed.
