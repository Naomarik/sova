# Claude Code for Pi

This extension exposes the locally installed Claude Code CLI as pi models (provider
`claude-code-cli`, below) and owns what every `claude` process Sova starts shares: the model
catalog, the logins and their failover, and the one executable. A Claude Code **worker**
(`agent_spawn` with `backend: "claude-code"`) is a pi worker on this provider: the subagents
extension maps the spawn (`subagents/claude-workers.ts`) and its README's "Claude Code workers"
says how. No Claude SDK, terminal automation, or duplicate agent manager is used.

## Install

Both extensions must load:

```sh
ln -s ~/pi-config/extensions/claude-code ~/.pi/agent/extensions/claude-code
# subagents is already linked on this machine; install.sh links both on new hosts.
```

`claude` must be installed and authenticated. Every spawn runs the executable
directly, never a shell alias, and the same one from every folder (`claude-executable.ts`):
the first `claude` in an absolute directory of the host's own `PATH` (a mise shim there
resolved once with `mise which claude` from the host's cwd, then this extension's own
directory), else `~/.local/bin/claude`, as an absolute path; a chat's or worker's cwd never
picks it. With none found, the launch fails with "Claude program not found" and where it
looked. No credentials are copied into configuration.

## Discover models

Use `agent_models` with `backend: "claude-code"`. The models are Sova's own Claude catalog
(`catalog.ts`): one entry per real model, by the CLI's catalog id (`claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-5-5`) and name ("Opus 5.5"), with its
window, output cap and efforts. No aliases and no `[1m]` forms: an old id typed into `agent_spawn`
or `team_create` (`opus[1m]`, `claude-opus-5-5[1m]`) quietly runs as its catalog id, and an id the
catalog doesn't know still runs, with a note. Every `--model` is a catalog id; an old id from a file (`opus[1m]`) is read through the
catalog's frozen legacy table. No CLI process runs to list them. `models.ts`'s initialize-only
discovery (no model request, account details never kept) is used by Sova only to report drift;
`pnpm run claude:catalog` (in Sova) diffs the catalog against an installed CLI's own table.

## Logins

Every `claude` process this extension starts (the chat provider's children, a
Claude Code worker's included, and model discovery) runs on one Claude login, chosen by `accounts.ts`:

- A login is one Claude Code config directory with its own `.credentials.json`.
  Claude Code's own directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR`) is the
  implicit login `default` — except an inherited `$CLAUDE_CONFIG_DIR` that names
  an added login's directory (a process started under a `claude` on one, such
  as a pi in a worker's shell): then `default` is `~/.claude`, and its spawns
  drop that variable. Added logins live in
  `<agent dir>/claude-accounts/<id>/` (0700), with `projects/`, `settings.json`,
  `CLAUDE.md`, `agents`, `commands`, `skills` and `plugins` symlinked to
  `default`'s, so every login writes its session records into one `projects/`.
  The registry is `<agent dir>/claude-accounts.json`; Sova's Settings → Accounts
  writes it (adding a login runs `claude auth login` for a new directory).
- A spawn uses this host's first usable login in its device's order (enabled,
  and neither limited nor needing a new sign-in), by setting `CLAUDE_CONFIG_DIR`.
  A chat session keeps the login it recorded in its `claude-login` entry while
  that login is usable.
- The transport classifies a turn's account failure: a usage **limit** (a
  rejected `rate_limit_event`, an assistant error `rate_limit`/`billing_error`,
  "usage limit reached") or an **auth** failure (`authentication_failed`,
  repeated 401 retries, "Not logged in"). The failure is recorded for the host in
  `<agent dir>/claude-accounts-state.json`: a limit puts every login of that
  account out until `resetsAt`, an auth failure puts the login out until its
  credentials file changes. A failing login is never run to see if it recovered.
- On a failure the work moves to the next usable login (for a limit, skipping
  logins of the same account). A chat turn that has not streamed anything yet is
  restarted on the new login the way a model change restarts it (history
  folded) and sent again; the session gets a `claude-login` entry whose `text`
  is the notice (`Claude: switched A → B (5h limit, resets 15:00)`). A Claude Code
  worker is such a session, so its turn moves the same way. With no usable login
  left, the failure ends the turn or task as before.
- `default` always comes last in a device's order: Claude Code's own login is
  the last resort.
- **A preferred login, handed over by the host.** A process started with
  `SOVA_CLAUDE_LOGIN_CONTEXT` set (JSON `{prefer?: {login, source: "project" |
  "org", name}, saved?: [ids]}`, read by `loginContextFromEnv`) passes it to the
  chat provider's choices (`select`, `acquire`, `failover`, `failoverAsync`),
  as their own input beside the session's current login. `prefer` comes first in
  the walk, `saved` (logins kept for other work) after every other added login
  and before `default` (`orderWithContext`). The session's current (recorded or
  picked) login still wins while usable. A first start that can't use `prefer`
  records a `claude-login` entry with `reason: "moved"`, `from` the preferred
  login and the text `Claude: using B (project Acme's login A is limited until
  15:00)`; with the pool on, a preferred login free at the keeper is borrowed by
  name first (`take`). Without the variable (a terminal session) nothing
  changes, and model discovery and the topic summarizer never read it. Sova sets
  it per chat process from the chat's folder; a plain copy of this directory
  never sees it.

**The pool (mesh on).** When `<agent dir>/sova/peers.json` lists a peer, Sova's
server pools the added logins of every device (`server/claude-pool/`): a login
is on one device at a time, and a registry login's `device` is the device that
holds it (`null`: kept here for lending, never run). This extension honours the
pool's marks at every spawn:

- `<login dir>/.sova-leaving`: the login is on its way to another device. It is
  never chosen; an idle chat child on it (a worker's included) is torn down, a
  busy one as soon as its turn ends.
- `<login dir>/.sova-leases/<pid>.json`: which processes of this host still run
  `claude` on the login (`LoginUsers`, rewritten every 5 s), so the server
  hands a login over only once none does.
- A spawn with nothing but `default` usable writes a borrow request
  (`<agent dir>/claude-pool/wants/`) and waits up to 30 s for the server to
  borrow one (`acquire`), but only while the server's heartbeat
  (`claude-pool/agent.json`) is fresh. On a failure, `failoverAsync` marks the
  login leaving (the server returns it to the keeper with its standing) and
  moves on to the next login held here, else a borrowed one (not of the same
  account on a limit), else `default`.

Development switch: with `SOVA_CLAUDE_ACCOUNTS_DEV=1`,
`<agent dir>/claude-accounts-dev.json` (`{"forceLimit": [ids], "forceAuth": [ids]}`)
makes those logins answer every message with a synthetic failure instead of
sending it to Claude. The classifier's fixtures (`tests/fixtures/failures/`) are
shaped after CLI 2.1.282's own schema (read from the binary), not recorded from
a real limit.

## Claude Code workers

A worker started with `backend: "claude-code"` runs as a pi worker whose model is this provider's
(`claude-code-cli/<catalog id>`, Sonnet by default), with an effort of `low`..`max` (default
`medium`), on Sova's tools (`Read`→`read`, `Bash`→`bash`, `Edit`→`edit`, `Write`→`write`,
`Grep`→`grep`, `Glob`→`find`, `LS`→`ls`). The subagents extension maps the spawn
(`subagents/claude-workers.ts`) and loads this extension into the child with `--claude-code-model
<id>`, which makes a Claude id the catalog doesn't list available too. Its transcript, restore,
resume, team tools, sandbox, remote target, spec census and death message are a pi worker's; login
failover is this provider's (above). See the subagents README, "Claude Code workers", for the
`backendOptions` it accepts and refuses.

The native worker that ran the CLI's own tools (`runner.ts`, `confined-launch.ts`, `policy.ts`,
`permissions.ts`, `spec-hooks.ts`, the `team` and `remote` MCP servers) is gone. Workers it
recorded stay readable (`transcript-adapter.ts` reads their Claude session file); resuming one
continues it on Sova's tools in a new session whose first message hands its work over.

## Claude Code as pi models (experimental provider)

The same extension can also expose the installed Claude Code CLI as ordinary pi
models — provider `claude-code-cli`, the CLI's discovered models (offline:
`claude-fable-5-1[1m]`, `opus[1m]`, `sonnet` and `haiku`) — selectable in `/model` and in Sova's picker, streaming,
and running **pi's own tools**. It is behind the `--claude-code-provider` flag,
off by default:

- TUI: `pi --claude-code-provider`.
- Sova: always on. The server passes the flag to every hosted session that
  loads extensions, with no setting. Without the flag nothing is registered.

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
(`low`/`medium`/`high`/`xhigh`/`max`); Haiku 4.5 (and the old `haiku` alias, which
meant it) reports no efforts, so it has no thinking levels. The child gets `MCP_TOOL_TIMEOUT=86400000` so a held call
outlives any pi tool (the CLI's own default is ~27.8 h; a stray value in the
user's shell would otherwise truncate long tools with a synthetic timeout
result), and `DISABLE_AUTO_COMPACT=1`, because pi owns compaction (below).
A child that exits mid-turn, or fails its `initialize` handshake, ends the turn
with an error followed by the last lines it wrote on stderr (at most 20 lines and
2 KB, the newest kept), so the chat says why it died.

When the CLI retries inside one message because the model's tool input was
rejected as invalid, the provider marks that message: its `diagnostics` gains
`{ type: "measurement-invalid", timestamp, details: { reason: "invalid-tool-retry" } }`
(`MEASUREMENT_INVALID_DIAGNOSTIC` in `provider/stream.ts`). The message's timing
covers the failed attempt too, so a host that times replies, such as Sova,
records no measurement for it.

### Rebuild on divergence

The bridge fingerprints the transcript prefix it has already sent. When pi's
next context does not extend it — rewind, branch, compaction, a changed system
prompt or tool set — the CLI process is restarted and the prior history is folded
into one user message. Prior tool calls and results are flattened to prose in
that fold: the CLI never pairs a replayed `tool_result` to a `tool_use`
(investigation invariant 1). Tools are named in the fold as the CLI exposes them
(`mcp__sova__bash`, not `bash`): a model that copies a bare name from the
replay gets "No such tool available".

The fold is sized from the model's context window: the window, less pi's
compaction reserve (16,384), the system prompt, the tool declarations, the
CLI's overhead and the output cap, times 0.85, at 2.2 characters per token,
clamped to 64 KiB–2 MiB (`foldBudgetChars`). 2.2 (`FOLD_CHARS_PER_TOKEN`) is
measured, not the usual 4: a live restart sent a 524,682-character fold that cost
231,491 input tokens. With Sova's system prompt (~34–43K characters) and 19 tools
(~30K characters) that comes to about 155K–163K characters for a 200K model and
about 1.65M for a 1M one. Over budget, the OLDEST
messages go first: the last user message is always kept whole, the first
(usually the task) is kept if it is small, then the newest messages back from
the end, and the fold opens with `[N earlier message(s) omitted to fit the
context window]`.

A clean append sends every user message pi added since the last turn (steering
and queued follow-ups), in order, joined into one stream-json user message.

**A memory view** (Sova's memory minor mode, `provider/memory-view.ts`) is
the one context sent as written, never folded: a first user message of two
or three text blocks — the guide opening `# Memory`, the stable prefix
`<chat>…</chat>`, and optionally the newest lines `<chat> (continued: the
newest lines)…</chat>` — followed by the run's own messages. The guide and
the prefix go at the end of the system prompt the CLI is given (`initialize`),
past the CLI's own `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` element
(`SYSTEM_PROMPT_BOUNDARY`): on the first-party API, CLI 2.1.295 sends the
prompt before it and the view after it as two system blocks, each under one of
Claude Code's own one-hour cache marks (the agent line's mark moves to them),
so a rebase re-writes the view's block and reads Sova's prompt from the cache;
elsewhere it joins them into one block, as without it. Only the newest lines and the
run's messages go in the child's first user message, and the bridge adds no
cache mark of its own (the CLI already uses three or four of the four
allowed). Sova saves the prefix with the chat and changes it only when the
view rebases, so a new process starts from the same cached system prompt; a
changed prefix is a changed system prompt and restarts the child. Within a
run, the view stays the same for every request, and the tool loop appends as
usual.

### Compaction

pi owns compaction; the CLI child's own auto-compact is off
(`DISABLE_AUTO_COMPACT=1`, which CLI 2.1.282 reads as a boolean; not
`DISABLE_COMPACT`, which would also remove the manual `/compact`). If a child
compacts anyway (a literal `/compact` text reaching it), its
`system/compact_boundary` marks it out of step and the next turn restarts onto
pi's transcript.

pi's own threshold (`contextWindow - reserveTokens`, ~984K tokens on `[1m]`
models) sits far above what a restart can fold, so the provider also asks pi to
compact from `agent_settled` when the fold a restart would send exceeds the
budget above (`provider/auto-compact.ts`): once per session leaf, never mid-run
or with messages queued, and after a failure only once the history has grown
by a quarter. It hooks `agent_settled`, not `agent_end`: `ctx.compact()` aborts
the agent first, and at `agent_end` the run is still active, so that abort
would cancel pi's retry, queued follow-ups and its own compaction check. The
decision waits one tick and is dropped if a prompt has started since the settle
(counted from `input`, `before_agent_start` and `agent_start`, since `isIdle()` only
turns false late in `prompt()`), and a compaction of its own that a prompt
overtakes is cancelled at `session_before_compact`.

The summary itself (pi 0.87.1) arrives with a fresh uuid session id, no tools
and pi's summarizer prompt, so it runs on a one-shot child that is disposed as
soon as it answers; the conversation's child is untouched, and the next real
turn restarts once onto summary + kept messages. A message over the transport's
4 MiB stdin line limit, or a restart message that with the system prompt (at
2.2 characters per token) and the reply's `maxTokens` exceeds the model's window
less the 16,384 reserve, fails the turn at once with the sizes instead of waiting for an
answer the child never got; neither is ever shortened. pi's TUI has `/compact` built in (0.87.0 and
0.87.1), so the extension registers no command for it.

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
  after a rewind or compaction pays a full re-send. The fold budget is a
  2.2-characters-per-token estimate; with `PI_CLAUDE_CODE_DEBUG=1` each fold's size and budget are
  logged (`event: "fold"`, to `claude-code-debug.log` in the agent dir) to compare with the next call's input tokens, with
  the images kept and dropped to fit the 4 MiB stdin line and its final bytes.
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
`SOVA_PORT=4810 pnpm run dev:web`, then switch the toggle on in Settings →
Experimental and open a new session on `claude-code-cli/sonnet`. Verified
2026-09-22 on CLI 2.1.278: a turn through pi's `read` tool, abort during a
running `bash` tool, an image returned by `read` (PNG) described by the model,
one `opus[1m]` turn, and archive killing the session's CLI child.

## Tests

```sh
node ~/pi-config/extensions/subagents/tests/run.mjs
node ~/pi-config/extensions/claude-code/tests/run.mjs
node ~/pi-config/extensions/claude-code/tests/smoke.mjs
```

Offline tests use the already-installed Pi runtime through the existing test
loader; no second package installation is needed.
