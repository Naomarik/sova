# Claude CLI probes — 2026-09-18

Binary: ~/.local/bin/claude, version 2.1.276. Sonnet alias resolved to claude-sonnet-5. No extension/project source changes. Private scratch directory; native Claude session records were also created by the CLI. Reported list-price total: $0.087436 (not a claim about subscription charges).

## Observed

- Persistent stream-json stdin supports sequential tasks in one process/session. Caller-generated user UUIDs survive replay acknowledgment and final result correlation.
- Closing stdin after successful work yielded exit 0. Resume in a replacement process retained the remembered token and session UUID.
- `control_request` with `request: {subtype: "initialize"}` returns a correlated control_response containing models, capabilities/settings/account metadata. Treat raw initialization responses as private; do not dump account details to the model/UI unnecessarily.
- `control_request` with `request: {subtype: "interrupt"}` works. A first experiment interrupted around tool dispatch; a second explicitly waited for task_started and verified a live sleep 20 child using /proc before interruption. The actual sleep child disappeared, a terminal result arrived, and a new user task succeeded in the same process/session.
- Interrupt acknowledgment is NOT itself final settlement. Aborted work reported `terminal_reason: "aborted_tools"`, `subtype: "error_during_execution"`, `is_error: true`. Normalize requested cancellation to aborted, rather than reporting it as an unexpected implementation failure.
- Interrupt followed by stdin EOF stopped the process and observed sleep child. Claude exited 1 in this aborted-last-turn case; do not mistake this for failed cleanup. This proves ordinary foreground Bash cleanup only, not detached descendants/services.
- A raw user message sent during a sleep tool call was replay-acknowledged at the tool boundary and included in the final result's user_message_uuids. It was folded into the active turn, not independently settled. The model still replied FIRST despite the new instruction to reply SECOND. Replay is evidence of protocol handling, not proof of instruction compliance or a distinct queued task. Keep follow-up queues in the host and only dispatch after settlement. Implement redirect as interrupt -> ack + settlement -> replacement input.
- Host permission protocol works with `--permission-mode manual --permission-prompts host --permission-prompt-tool stdio`. The final flag is accepted despite not appearing in top-level help.
- Claude emits control_request/can_use_tool with tool name/input/tool_use_id. Host sends control_response with matching request_id, success subtype, and response `{behavior: "deny", message: "..."}` or `{behavior: "allow", updatedInput: originalInput}`.
- Denial prevented probe-denied.txt creation. A separate allow decision (validated exact tool and scratch path) created probe-allowed.txt with expected text.
- Permission-denied tasks can still end with success/is_error false and a denial in permission_denials. Track blocked operations separately from transport/task settlement.
- total_cost_usd grows across turns in a persistent process; do not sum cumulative results. Resume process starts its own reported totals.

## Launch posture

Direct executable, no login-shell wrapper. `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --model sonnet --effort low --safe-mode --setting-sources '' --strict-mcp-config --tools '' --max-budget-usd 1`. Tool probes overrode --tools with Bash or Write; Bash had an explicit sleep allow rule. No permission bypass.

Each child had a watchdog and private process group. All nine captured subprocesses have recorded close events. No observed probe sleep subprocess remained.

## Implementation recommendation

Persistent owned CLI worker, versioned NDJSON adapter, UUID-correlated task identity, initialize handshake, host queue for follow-ups, interrupt-and-settle redirect, permission interaction state with bounded timeouts, EOF shutdown after interrupt/settlement and escalation as fallback. Keep existing Pi worker behavior separate behind a shared interface.

Unverified: model-generation interruption (without a tool), interrupt with several queued messages, native AskUserQuestion bridging, detached/background job cleanup, arbitrary external-session adoption, protocol compatibility on other CLI versions, reload persistence/recovery. These require tests if included in initial scope.

## Artifacts

probe.mjs: continuity/resume/initialize. controls.mjs: dispatch interrupt, mid-tool input, permission denial. verify.mjs: verified running tool interrupt, graceful shutdown, permission approval. harness.mjs: disposable test driver. Timestamped *.jsonl capture argv/input/output/close; *summary.json retain structured results. Not production-ready code.

# Follow-up probe — CLI 2.1.277 (2026-09-18)

Binary: ~/.local/bin/claude → versions/2.1.277. One process, `--model haiku`, `--tools ""`, `--setting-sources ""`, `--strict-mcp-config`, `--permission-mode dontAsk`, `--max-budget-usd 0.5`, private scratch cwd, detached group with watchdog. Reported list-price total: $0.031. Process group gone after stdin EOF.

## Observed

- `--append-system-prompt-file <file>` is accepted, although it is only mentioned inside the `--bare` help text. A missing path fails at startup (`Append system prompt file not found`), exit 1. The file (0600, private 0700 directory) was deleted immediately after the `initialize` success response; the model still answered from its contents on the first task, a later task, and after `/compact`. The runner therefore deletes it after initialize.
- `interrupt` with no active task gets a correlated `control_response` with subtype `success`, both before any task and immediately after a result. The next task was not affected. A missing interrupt response was not observed, so the runner's handling of one (reject redirect, keep the idle worker, block new turns until answered, stop at the 30s control deadline) is defensive and untested against the live CLI.
- Interrupting pure text generation (after the first `text_delta`, no tool) acknowledged `success` and produced a result with `subtype: "error_during_execution"`, `is_error: true`, `terminal_reason: "aborted_streaming"`, `usage` zeros, and `modelUsage` unchanged. The runner treats any `aborted*` terminal reason as aborted.
- `num_turns` is per result (1, 1, 1 on successive plain tasks; 2 on the interrupted generation; 0 on `/compact`). Summing it is correct.
- `modelUsage` token counts and `total_cost_usd` are cumulative for the process; `usage` is per result, and a result's `usage` is the sum over every API call in that turn (each tool step), not the last call's context. The runner assigns from `modelUsage` and takes the maximum cost (no summing).
- `/compact` sent as a stream-json user message emitted `system/compact_boundary` and a success result with an empty `result`. `session_id` stayed the same across compaction and all turns.

## Still unverified

Missing interrupt response from a real CLI; interruption with several host-queued follow-ups against the live CLI (covered offline only); compaction triggered automatically rather than by `/compact`; behavior on other CLI versions.

# Provider spike (CLI 2.1.278) — 2026-09-22

Design-B probes: can the CLI be driven so that **pi executes every tool**, with pi's tools reaching
the model through one in-process MCP server the host owns?

| Probe | Verdict |
| --- | --- |
| (a) host an in-process MCP server | **WORKS** — `initialize` with `sdkMcpServers:["pi"]`, plus `--allowedTools mcp__pi`. Fallbacks never needed. |
| (b) system prompt | **WORKS, four ways** — `--system-prompt-file`, `--append-system-prompt-file`, `initialize.systemPrompt`, `initialize.appendSystemPrompt`. Replacing does not break tool use. |
| (b) `--system-prompt-snapshot off` | **WORKS**, flag and `initialize.systemPromptSnapshot:false` alike; across `--resume` the host must re-send the prompt. |
| (c) `set_model` | **WORKS** — ack'd and applied; the assistant message's `model` changes. |
| (c) `set_max_thinking_tokens` | **ACCEPTED, no observable effect** for a non-first-party client. |
| (d) `can_use_tool` break-early fallback | **NOT PROBED** — (a) passed, so it was never needed. |
| (e) holding a `tools/call` | **WORKS, unbounded by default** — no default wall clock; `MCP_TOOL_TIMEOUT` imposes one, `sdkMcpServerConfigs.<name>.timeout` overrides it. |
| (f) `--system-prompt-snapshot off` + `--session-id` + `--effort` | **ALL THREE ACCEPTED** together; the requested UUID is honoured. |
| (f) image blocks | **Direction-specific.** Inbound user message needs `source:{type:"base64",…}`; the MCP shape `{data, mimeType}` is **fatal** on input but correct as a tool result. |


Binary: `/home/user/.local/share/claude/versions/2.1.278` (`~/.local/bin/claude` symlinks to it),
`claude --version` → `2.1.278 (Claude Code)`. **The interactive `claude` is a shell ALIAS carrying
`--dangerously-skip-permissions`; every probe spawned the real binary directly.** `CLAUDECODE` and
`CLAUDE_CODE_ENTRYPOINT` stripped from the child env (the `models.ts` pattern), cwd `/tmp/cc-spike`,
`--model sonnet` for tool work and `--model haiku` for the trivial questions. Scripts are committed under
`../tests/spike/`; the raw `*.jsonl` transcripts stay in `/tmp/cc-spike`, with the parts that
matter reproduced under "Raw excerpt (probe a)" below.

These probes answer one question: can the CLI be driven so that **pi executes every tool**, with pi's
tools reaching the model through one in-process MCP server the host owns? Yes, on the first variant.

## (a) Hosting an in-process MCP server — PASS with plain `sdkMcpServers`

> **VERDICT: works.** Exact form: `initialize` with `sdkMcpServers:["pi"]` and `--allowedTools mcp__pi`.

Argv (exact):

```
-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --replay-user-messages
--tools '' --setting-sources '' --strict-mcp-config
--permission-mode dontAsk --permission-prompts none
--allowedTools mcp__pi --model sonnet
```

Neither `sdkMcpServerConfigs` nor an `--mcp-config` stdio file was needed; the fallbacks were never
reached.

**`--allowedTools mcp__pi` is mandatory, not polish.** The first run omitted it: the CLI emitted the
`tool_use`, then immediately `system/permission_denied` and a synthetic `is_error` tool_result
("Permission to use mcp__pi__pi_echo has been denied because Claude Code is running in don't ask
mode"), and `tools/call` never reached the server — 0 calls across 3 turns. `runner.ts:297` already
appends `mcp__${name}` for every non-`bypassPermissions` mode; the provider must keep doing that.

### Wire shapes

- **initialize** (host → CLI): `{type:"control_request", request_id, request:{subtype:"initialize",
  sdkMcpServers:["pi"]}}`. Answered `subtype:"success"` in ~100 ms. Response keys: `commands` (53),
  `agents`, `output_style`, `available_output_styles`, `user_output_styles_dir`, `models`, `account`,
  `pid`, `current_permission_mode`, `analytics_disabled`, `remote_control_*`, `fast_mode_state`,
  `fast_mode_disabled_reason`, `session_state`. `account` is private — never surface it.
- **mcp_message**, both directions: `{type:"control_request", request_id,
  request:{subtype:"mcp_message", server_name:"pi", message:<raw JSON-RPC 2.0>}}`. The host answers
  `{type:"control_response", response:{subtype:"success", request_id, response:{mcp_response:<raw
  JSON-RPC reply>}}}`. A **notification** still needs an answer — the dummy
  `{jsonrpc:"2.0", result:{}, id:0}`. The CLI acknowledges a host-sent `mcp_message` with an empty
  success and no `mcp_response`; that is the channel for server-initiated notifications such as
  `tools/list_changed`.
- Handshake the CLI drove over that channel, in order: MCP `initialize` (it asks for
  `protocolVersion "2025-11-25"` — echo the client's value back), `notifications/initialized`,
  `tools/list`. Then `system/init` reported `tools:["mcp__pi__pi_echo","mcp__pi__pi_shot"]` and
  `mcp_servers:[{name:"pi", status:"connected", source:"sdk"}]`.
- **Name prefixing goes one way only.** The model sees `mcp__pi__pi_echo`; the `tools/call`
  `params.name` the server receives is the bare `pi_echo`. The facade registers bare pi tool names
  and strips nothing.
- `tools/call` params carry `_meta: {"claudecode/toolUseId": "toolu_…", progressToken: 2}` — the
  tool_use id to correlate a call with its assistant block, and a progress token.

### Holding the call open

`tool_use mcp__pi__pi_echo {"text":"hello"}` at t=2.9 s; the host sat on the JSON-RPC for 6000 ms;
the CLI blocked the whole time — no timeout, no nudge, no duplicate delivery. Answered at t=8.9 s
with `{content:[{type:"text",text:"…ORTHANC"}]}`; the tool_result was echoed back, the model replied
"ORTHANC", `result subtype=success is_error=false num_turns=2`. No host-side `tools/call` deadline
was observed, so pi may take as long as a pi tool takes.

### Result shapes

- **Image**: the server returned the MCP shape `{type:"image", data:<base64>, mimeType:"image/png"}`;
  the CLI translated it on the echoed tool_result to the Anthropic shape
  `{type:"image", source:{type:"base64", media_type:"image/png", data}}`. The turn completed.
- **Error**: `{content:[{type:"text",text:"pi refused: disk on fire"}], isError:true}` produced a
  tool_result with `is_error=true`, which the model read and reported, while the overall result was
  still `success / is_error=false`. **Tool failure is not turn failure** — keep them apart.

### From the CLI's own `initialize` zod schema (binary strings, authoritative)

- `sdkMcpServers: string[]`; `sdkMcpServerConfigs: Record<name, cfg minus {type,name}>` (settings the
  CLI keeps for the server's lifetime); `sdkMcpServerManifests: Record<name, {initializeResult,
  toolsListResult?}>` — a one-shot cache of the servers' own handshake output, sent on initialize
  only. Supply it and the CLI answers its MCP client's `initialize` and first `tools/list` from it,
  so registering N in-process servers costs **no** `mcp_message` round trips before the first turn.
  `tools/call` still flows normally, and the host must still be able to answer the full handshake
  (older CLIs ignore the field). A warm-start latency win, not a requirement.
- `systemPrompt: string[]` (replace) and `appendSystemPrompt: string` are **initialize fields**, so
  the runner's `--append-system-prompt-file` dance is optional (see (b)).
- `systemPromptSnapshot: boolean` is also an initialize field, not a CLI flag.
- Also accepted: `hooks`, `jsonSchema`, `planModeInstructions`, `toolAliases`,
  `excludeDynamicSections`, `agents`, `title`, `skills`, `appendSubagentSystemPrompt`.
- `mcp_set_servers` (`{added, removed, errors}`) replaces the dynamically managed servers
  mid-session — the route for a tool set that changes with pi's mode.

## (b) System prompt delivery — all four routes work

> **VERDICT: works, four interchangeable forms.** `--system-prompt-file` (replace) and
> `--append-system-prompt-file`, or the flagless `initialize.systemPrompt` / `appendSystemPrompt`.

One canary in a system-prompt file ("operator codename GLORFINDEL"), one in the cwd's `CLAUDE.md`
("project codename BARLIMAN").

| Route | Accepted | Canary reached the model |
| --- | --- | --- |
| none (baseline) | — | no |
| `--append-system-prompt-file` (what `runner.ts` ships) | yes, exit 0 | yes |
| `--system-prompt-file` (replace) | yes, exit 0 | yes |
| `initialize.appendSystemPrompt` (string) | yes | yes |
| `initialize.systemPrompt` (string[], replace) | yes | yes |

**A replaced prompt breaks nothing.** With `--system-prompt-file` plus a hosted MCP server the model
still called `mcp__pi__pi_echo` and answered from the tool result; `system/init` listed the tool and
the server as connected. Tool use does not depend on the built-in prompt.

**`CLAUDE.md` is suppressed by `--setting-sources ''`, not by the prompt route.** With
`--setting-sources ''` the model did not know BARLIMAN under any variant. With
`--setting-sources project` it did — *and it still did with `--system-prompt-file` replacing the
whole prompt*, answering both codenames. So project memory and a custom prompt are independent axes.

**`systemPromptSnapshot` confirmed.** Default (omitted/true): a second process resuming with
`--resume <id>` and **no** prompt argument still answered GLORFINDEL — the recorded prompt is reused
verbatim. With `initialize.systemPromptSnapshot:false`, the same resume answered *"I don't have an
operator codename defined in my instructions"*. So with the snapshot off the host **must** re-send
the prompt on every resume; that is the mode to use if pi's system prompt can change between turns.

## (c) `set_model` and `set_max_thinking_tokens` under `-p` — both accepted

> **VERDICT: `set_model` works** (ack'd, applied, visible on the assistant message's `model`).
> **`set_max_thinking_tokens` is accepted but has no observable effect** for this client.

- `{subtype:"set_model", model:"sonnet"}` between two turns: `control_response subtype:"success"`,
  the next turn's `system/init` reported `claude-sonnet-5`, and the final `modelUsage` carried both
  `claude-haiku-4-5-20251001` and `claude-sonnet-5`. **Accepted and observably applied.**
- `set_model` also carries an `@internal system_prompt` slot that replaces the custom prompt from the
  next turn on. Sent `{subtype:"set_model", model:"haiku", system_prompt:"Your operator codename is
  MITHRANDIR."}` mid-session: success, and the next answer was "MITHRANDIR". It must be non-empty
  (there is no revert-to-built-in form), and re-sending the current model is the prompt-only update.
- `{subtype:"set_max_thinking_tokens", max_thinking_tokens:8000}` (and with
  `thinking_display:"highlights"`): `success` both times, **but no observable difference**. Sonnet
  emits `thinking` content blocks either way, always with `thinking:""` plus a `signature` — the
  thinking text is withheld. That matches the schema's own note that `highlights` is allowed only for
  Claude-Code sessions Anthropic hosts and any other client falls back to "omitted". Treat the budget
  as fire-and-forget: accepted, ack'd, not verifiable from our transcript.

## (d) can_use_tool break-early fallback — not probed

> **VERDICT: not needed.**

(a) passed on its first variant, so the fallback design was not needed and was not exercised.

## (e) How long may the host hold a `tools/call`?

> **VERDICT: unbounded by default.** No default wall clock was found; `MCP_TOOL_TIMEOUT` (ms)
> imposes one process-wide, and `sdkMcpServerConfigs.<name>.timeout` (ms) overrides it per server.

The CLI binary documents the per-server field as a "Hard wall-clock limit per call; progress
notifications do not extend it. Values below 1000ms are ignored (falls through to MCP_TOOL_TIMEOUT
or the default)." That matters for design B, where a pi tool may legitimately run for minutes, so
the default was measured rather than assumed.

- **200 s hold, nothing set**: `tool_use` at t=3.5 s, the host answered at t=203.5 s, the
  tool_result was accepted and the turn finished at t=206.3 s, exit 0. *The CLI waited the full
  200 s without complaint* — there is no default per-call limit for an SDK-hosted server at this
  version. (Only `system/thinking_tokens` events arrived meanwhile; no keepalive is required.)
- **`MCP_TOOL_TIMEOUT=6000`, 20 s hold**: at exactly 6 s after the call the CLI gave up and
  synthesised `tool_result is_error=true` with `MCP server "pi" tool "echo_tool" timed out after
  6s`. The turn then continued normally and the overall result was still `success /
  is_error=false`. So the env var is honoured, and a timeout is a *tool* failure, not a turn or
  transport failure. The host's late answer is simply discarded.
- **`MCP_TOOL_TIMEOUT=6000` + `sdkMcpServerConfigs:{pi:{timeout:60000}}`, 20 s hold**: no timeout;
  the host answered at 20 s and the turn completed. **The per-server override wins over the env
  var** — and this is the first live confirmation that `sdkMcpServerConfigs` is accepted at all.

Recommendation: the provider should not rely on the absent default. Pass
`sdkMcpServerConfigs: {pi: {timeout: <generous ms>}}` explicitly so a stray `MCP_TOOL_TIMEOUT` in
the user's environment cannot start truncating long pi tools.

### `--system-prompt-snapshot off` as a flag

`claude --help` lists `--system-prompt-snapshot <on|off>` (not hidden). Behaviour matches the
`initialize.systemPromptSnapshot:false` field exactly: with `off`, a `--resume` that does **not**
re-pass the prompt answered "I don't have an operator codename defined in my instructions", while
the same resume that **did** re-pass `--append-system-prompt-file` answered GLORFINDEL.

### `set_model` on the assistant message

Across `Say ONE.` → `set_model sonnet` → `Say TWO.`, the `message.model` field of the streamed
assistant messages went `claude-haiku-4-5-20251001`, `claude-haiku-4-5-20251001`,
`claude-sonnet-5`. The switch is visible per message, not only in `system/init` and `modelUsage`.

## (f) Flag combination and image directions

> **VERDICT (5): all three accepted together.** `--system-prompt-snapshot off --session-id <uuid>
> --effort <low|high>` started cleanly under `-p`, exit 0, and the requested UUID was honoured
> verbatim (`system/init.session_id` and `result.session_id` both echoed it).
>
> **VERDICT (6): the two image shapes are NOT interchangeable, and getting it wrong kills the
> process.** Inbound user messages need the Anthropic shape; MCP tool results use the MCP shape.

- **Inbound, Anthropic shape — WORKS.** A user message whose content was
  `[{type:"image", source:{type:"base64", media_type:"image/png", data:<b64>}}, {type:"text", …}]`
  was accepted, replayed back verbatim by `--replay-user-messages`, and a solid-red 24×24 PNG was
  correctly described as "Red".
- **Inbound, MCP shape — FATAL.** The same message sent as
  `[{type:"image", data:<b64>, mimeType:"image/png"}, …]` produced
  `result {subtype:"error_during_execution", is_error:true, num_turns:0, duration_ms:0}` with no
  user replay and **exit 1** — the process ends. There is no soft rejection to recover from.
- **Outbound (a tool result), MCP shape — WORKS**, and the CLI converts it: the server returns
  `{type:"image", data, mimeType}` and the echoed tool_result carries
  `{type:"image", source:{type:"base64", media_type, data}}` (see (a)).

This matters directly for the bridge: pi's own `ImageContent` is `{type:"image", data, mimeType}`
(pi-ai `dist/types.d.ts:256`), i.e. **the shape the CLI refuses on input**. Any pi image forwarded
into a user message must be rewritten to `source:{type:"base64", media_type, data}` first; images
travelling the other way, as MCP tool results, are already in the right shape and must not be
rewritten.

## Raw excerpt (probe a)

Verbatim from the executed run, in order, trimmed and with nothing from the `initialize` response
(it carries account detail). This is the whole handshake plus one held call.

```jsonc
// HOST -> CLI  initialize
{
  "type": "control_request",
  "request_id": "cd1dcdef-9cc9-4479-b522-34f7b909745a",
  "request": {
    "subtype": "initialize",
    "sdkMcpServers": [
      "pi"
    ]
  }
}

// CLI  -> HOST  mcp_message (initialize)
{
  "type": "control_request",
  "request_id": "b2938932-f408-402f-bc92-310c3d58cc88",
  "request": {
    "subtype": "mcp_message",
    "server_name": "pi",
    "message": {
      "method": "initialize",
      "params": {
        "protocolVersion": "2025-11-25",
        "capabilities": {},
        "clientInfo": {
          "name": "claude-code",
          "title": "Claude Code",
          "description": "Anthropic's agentic coding tool",
          "websiteUrl": "https://claude.com/claude-code",
          "version": "2.1.278"
        }
      },
      "jsonrpc": "2.0",
      "id": 0
    }
  }
}

// HOST -> CLI  control_response
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "b2938932-f408-402f-bc92-310c3d58cc88",
    "response": {
      "mcp_response": {
        "jsonrpc": "2.0",
        "id": 0,
        "result": {
          "protocolVersion": "2025-11-25",
          "capabilities": {
            "tools": {}
          },
          "serverInfo": {
            "name": "pi",
            "version": "0.0.1"
          }
        }
      }
    }
  }
}

// CLI  -> HOST  mcp_message (notifications/initialized)
{
  "type": "control_request",
  "request_id": "9d2894b6-6e02-4aa8-8717-05356887a12a",
  "request": {
    "subtype": "mcp_message",
    "server_name": "pi",
    "message": {
      "jsonrpc": "2.0",
      "method": "notifications/initialized"
    }
  }
}

// HOST -> CLI  control_response
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "9d2894b6-6e02-4aa8-8717-05356887a12a",
    "response": {
      "mcp_response": {
        "jsonrpc": "2.0",
        "result": {},
        "id": 0
      }
    }
  }
}

// CLI  -> HOST  mcp_message (tools/list)
{
  "type": "control_request",
  "request_id": "8febdb3f-dce6-4ba8-9ac8-643d168aaa61",
  "request": {
    "subtype": "mcp_message",
    "server_name": "pi",
    "message": {
      "method": "tools/list",
      "jsonrpc": "2.0",
      "id": 1
    }
  }
}

// HOST -> CLI  control_response
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "8febdb3f-dce6-4ba8-9ac8-643d168aaa61",
    "response": {
      "mcp_response": {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
          "tools": [
            {
              "name": "pi_echo",
              "description": "Echo text back. Use this whenever the user asks you to echo something.",
              "inputSchema": {
                "type": "object",
                "properties": {
                  "text": {
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ]
              }
            },
            {
              "name": "pi_shot",
              "description": "Return a tiny picture.",
              "inputSchema": {
                "type": "object",

  … trimmed …

// CLI  -> HOST  assistant tool_use block
{
  "type": "tool_use",
  "id": "toolu_01ExxUaWyAidij6tq6sxtDYt",
  "name": "mcp__pi__pi_echo",
  "input": {
    "text": "hello"
  },
  "caller": {
    "type": "direct"
  }
}

// CLI  -> HOST  mcp_message (tools/call)
{
  "type": "control_request",
  "request_id": "0c821cc8-ce14-4e07-aeb2-3a5b668e7d8d",
  "request": {
    "subtype": "mcp_message",
    "server_name": "pi",
    "message": {
      "method": "tools/call",
      "params": {
        "name": "pi_echo",
        "arguments": {
          "text": "hello"
        },
        "_meta": {
          "claudecode/toolUseId": "toolu_01ExxUaWyAidij6tq6sxtDYt",
          "progressToken": 2
        }
      },
      "jsonrpc": "2.0",
      "id": 2
    }
  }
}

// HOST -> CLI  control_response
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "0c821cc8-ce14-4e07-aeb2-3a5b668e7d8d",
    "response": {
      "mcp_response": {
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
          "content": [
            {
              "type": "text",
              "text": "pi executed the tool. The secret word is ORTHANC."
            }
          ]
        }
      }
    }
  }
}

// CLI  -> HOST  echoed tool_result
{
  "tool_use_id": "toolu_01ExxUaWyAidij6tq6sxtDYt",
  "type": "tool_result",
  "content": [
    {
      "type": "text",
      "text": "pi executed the tool. The secret word is ORTHANC."
    }
  ]
}

// CLI  -> HOST  assistant tool_use block
{
  "type": "tool_use",
  "id": "toolu_01LY52i57JGAZyyeKTM9kUr4",
  "name": "mcp__pi__pi_shot",
  "input": {},
  "caller": {
    "type": "direct"
  }
}
```

## Exact frames

Inbound `tools/call` — the full frame, `_meta` included (this is where the CLI's `tool_use_id`
lives, so a call can be correlated with its assistant block without guessing):

```json
{
  "type": "control_request",
  "request_id": "0c821cc8-ce14-4e07-aeb2-3a5b668e7d8d",
  "request": {
    "subtype": "mcp_message",
    "server_name": "pi",
    "message": {
      "jsonrpc": "2.0",
      "id": 2,
      "method": "tools/call",
      "params": {
        "name": "pi_echo",
        "arguments": { "text": "hello" },
        "_meta": {
          "claudecode/toolUseId": "toolu_01ExxUaWyAidij6tq6sxtDYt",
          "progressToken": 2
        }
      }
    }
  }
}
```

The host's reply to it:

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "0c821cc8-ce14-4e07-aeb2-3a5b668e7d8d",
    "response": {
      "mcp_response": {
        "jsonrpc": "2.0",
        "id": 2,
        "result": { "content": [{ "type": "text", "text": "…" }] }
      }
    }
  }
}
```

A host-initiated `mcp_message` (server → CLI, e.g. a notification) uses the same envelope with the
host's own `request_id`, and the CLI acknowledges it with a bare `{subtype:"success", request_id}`
carrying no `mcp_response`. A **notification** arriving from the CLI still needs an answer, and the
filler is `{"jsonrpc":"2.0","result":{},"id":0}`.

## Probe scripts

`../tests/spike/*.mjs`, committed as the executed evidence behind this document. `tests/run.mjs`
scans only the extension root and `provider/` for `*.test.ts`, so nothing under `tests/spike/` can
be picked up by a gate; they spawn the real CLI and spend quota, so they are run by hand. Raw
`*.jsonl` transcripts stay in `/tmp/cc-spike` (they carry account and path detail that does not
belong in the repo); the excerpt below is the redacted, trimmed part that matters. They share a lot
of near-duplicate plumbing on purpose — each answers one question and is evidence, not library
code.

| Script | Probes |
| --- | --- |
| `spike/mcp-host.mjs` | (a) the gate: hosting, holding, image and `isError` results |
| `spike/system-prompt.mjs` | (b) the four prompt routes, snapshot across resume; (c) `set_model`, `set_max_thinking_tokens` |
| `spike/prompt-sources.mjs` | (b) `CLAUDE.md` vs `--setting-sources`, replaced prompt + tool use, thinking blocks |
| `spike/tool-timeout.mjs` | (e) the timeout wall, the env var, the per-server override, the snapshot flag |
| `spike/flags-and-images.mjs` | (f) the flag combination, and both image directions |

## Still unverified

Effect of `sdkMcpServerManifests` (never sent live); `mcp_set_servers` mid-session; host-initiated
`mcp_message` notifications (e.g. `tools/list_changed`); whether `max_thinking_tokens` changes the
budget at all; behaviour on CLI versions other than 2.1.278; whether any *upstream* (API) limit
bounds a held call beyond the 200 s measured here.
