# Claude-CLI First-Class Provider — Investigation Conclusions & Build Brief

Date: 2025-09-21 · CLI probed: Claude Code 2.1.278 (subscription/OAuth auth) · pi 0.86.1
Method: three-agent investigation (architecture, live CLI probes, parity audit); all
"impossible" claims below are backed by neutral-content live probes, not inference.
Evidence: `core-architect-notes.md` + `probes/` in this directory.

## Goal

Make Claude models first-class pi models — selectable in `/model`, streaming, running
pi-native tools — backed by the local `claude` CLI with its subscription auth (the same
CLI the sibling `claude-code` extension uses for subagent workers). That extension is NOT
superseded; it stays for bounded autonomous delegation.

## Verdict from investigation

- **Feasible as a pi extension. No fork, no upstream changes.** `pi.registerProvider(Provider)`
  with a custom api id + `streamSimple` is a genuine first-class hook (`/model`, `--list-models`,
  `ctx.modelRegistry`, models.json `modelOverrides` compose above it).
- **Full native parity is NOT achievable.** 5/16 rows full parity. Gaps below are structural
  or upstream; do not attempt to "fix" them in code — surface them loudly instead.

## Architecture (the only viable design)

One long-lived bidirectional CLI process per pi session, owned by the extension:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --model <id> --effort <level> \
  --append-system-prompt-file <tmpfile>   (see System prompt below) \
  --tools "" --setting-sources "" --strict-mcp-config \
  --permission-mode manual --permission-prompts host --allowedTools mcp__pi \
  --autocompact off? (verify flag name) --system-prompt-snapshot off \
  [--no-session-persistence for throwaway processes]
```

- **Tool loop = SDK-MCP loop-handoff (proven live, no timeout):** handshake
  `control_request {subtype:"initialize", sdkMcpServers:["pi"]}` serves pi's tools as an
  in-band MCP server over the SAME stdio pipe. When the CLI sends `mcp_message tools/call`
  (params carry `_meta.claudecode/toolUseId`), the extension emits a **native** pi
  `toolcall_*` event stream, ends the pi stream with stopReason `toolUse`; pi executes the
  tool through its own registry/permissions; on the next `streamSimple` call the extension
  answers the still-pending request with the result. The `tool_use` block arrives in the
  stream ~10ms BEFORE the MCP call (emit the pending toolcall from either). A 45-second
  hold completed cleanly — no timeout pressure.
- **Permissions:** with `--permission-prompts host` the CLI also sends `can_use_tool`
  (tagged `source:"sdk"`) before execution — answer allow immediately and rely on pi's own
  `tool_call` hooks. Exact reply shape required; malformed replies degrade to tool errors.
- **Streaming:** `stream_event` wraps raw Anthropic Messages SSE (`text_delta`,
  `thinking_delta` [empty], `input_json_delta`, usage in `message_start`/`message_delta`).
  Map 1:1 onto pi's `text_*` / `toolcall_*` events per `docs/custom-provider.md`.
- **Model/effort discovery:** `initialize` response `models[]`: `value`, `resolvedModel`,
  `displayName`, `description`, `supportedEffortLevels` (low/medium/high/xhigh/max — haiku
  reports NONE), `supportsAdaptiveThinking`, `supportsFastMode`. No `contextWindow` —
  hardcode a static table, optionally corrected from `result.modelUsage` (200000/32000
  observed). Per-model `thinkingLevelMap` (`off: null`, `minimal: null`).
- **Auth gating:** native Provider with apiKey auth whose `resolve()` returns empty auth
  (keyless pattern, `pi-ai/dist/models.d.ts:58`) so models appear in `/model`.
- **Abort:** `control_request {subtype:"interrupt"}` → `stopReason:"aborted"`; process
  survives. Model identity: `set_model` control request (model + optional system_prompt).
  `set_max_thinking_tokens` works mid-session (budget only; display modes all return empty).

## Hard invariants (probe-verified; design around them)

1. **The CLI owns the tool loop, unconditionally.** `stdin` accepts user AND assistant
   records (top-level `type` routes; role check only fires for `type:"user"` with wrong
   role — that is FATAL). Replayed assistant `tool_use` is admitted, but **no stdin
   `tool_result` ever pairs to it**. pi can never supply tool results via transcript
   replay → the SDK-MCP bridge is mandatory, and rehydration flattens tool history to prose.
2. **Thinking text is redacted under subscription auth** (haiku-4.5 + opus-5, all
   `thinking_display` modes): deltas arrive `{"thinking":""}`, signature present,
   `estimated_tokens` counts work. Render a token meter only. Cannot disable thinking
   (`--effort none` invalid; low still burns tokens).
3. **`--system-prompt` (replace) disables prompt caching for the ENTIRE request** — system
   prefix AND message history (3-turn probe: input ~3.0-3.3k uncached every turn, zero
   cache). `--append-system-prompt` caches normally (10 input tokens/turn) but reinstates
   Claude Code's ~6.5k preamble. → Default posture: `--append-system-prompt-file` (the
   existing claude-code extension's choice — validated by measurement). Short-lived/throwaway
   processes (compaction summarizer) may use `--system-prompt` + `--no-session-persistence`.
   FIRST TASK: a 12+ turn A/B (extend `probes/probe_cache.mjs`) to firm up the crossover.
4. **Sampling parameters do not exist** (no temperature/top_p/max_tokens/stop). Ignore pi
   `samplingParams`.
5. **Errors:** arrive as `subtype:"success"` + `is_error:true` + **exit code 0**, plus stray
   non-JSON stdout lines. Treat `is_error` as stream error; skip unparseable lines.
6. **`total_cost_usd` is cumulative per process** — diff consecutive `result` events.
   `usage` on each event is per-turn and includes cache read/write splits.

## Lossy transitions (warn-and-flatten, never silently degrade)

Compaction, `/tree`/branch, mid-session `/model` away-from/toward claude-cli, `fork:true`:
track the transcript prefix already sent to the CLI; when pi's incoming context no longer
extends it, restart the CLI process and reseed — either stdin replay of user+assistant
TEXT records, or synthesize `~/.claude/projects/<slug>/<uuid>.jsonl` + `--resume <uuid>`
(second path writes into CLI-owned dirs; prefer stdin replay). Tool history flattens to
prose; cache-cold; emit a loud warning entry. Overflow errors: normalize via `message_end`
handler to `context_length_exceeded` (see `docs/custom-provider.md`), never matching
rate-limit errors. Compaction summarization runs through the same `streamSimple` — use a
throwaway process.

## Known risks / constraints

- `sdkMcpServers` refused in cloud sessions; protocol is undocumented and version-sensitive
  (probed 2.1.276–278; `--max-turns` works but undocumented) — pin/record CLI version, fail
  loud on protocol drift.
- `--tools ""` is the actual safety boundary: under `manual --permission-prompts none`,
  auto-classified "safe" commands still execute. With `--tools ""` + `--strict-mcp-config`
  only `mcp__pi__*` exist. NEVER use `--bare` (forces API-key auth, defeats subscription).
- Without `--strict-mcp-config`, claude.ai connectors (Gmail/Drive/…) leak in.
- Two retry layers exist (CLI-internal + pi); surface rate-limits as errors, don't rewrite.
- Open: cache behavior + thinking redaction under API-key auth (untested; out of scope).

## Repo conventions (from sibling `extensions/claude-code`)

- TypeScript, loaded from `~/.pi/agent/extensions/` via symlink into `~/pi-config/extensions/`.
- Private tmpfiles 0600 in 0700 dir for system-prompt payload; deleted after init.
- Offline tests via the existing test loader (`node ~/pi-config/extensions/<name>/tests/run.mjs`),
  live tests opt-in behind `--live` (use `--model haiku`, tiny prompts — real quota).
- README documents install, flags, limits honestly.
- pi runtime types: import from `@earendil-works/pi-coding-agent` (installed under
  `/home/user/.local/share/mise/installs/node/25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/`;
  read `docs/custom-provider.md` + `examples/extensions/custom-provider-anthropic/` there).
