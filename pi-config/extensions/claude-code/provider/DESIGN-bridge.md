# P2.5 bridge design — session-bridge.ts + mcp-host.ts

Author: bridge worker. Status: **design only, nothing built** — held pending platform's P0.5 spike verdict.
Everything below is the CLEAN variant. The fallback plan is in the last section.

## 0. Evidence that the clean variant is protocol-supported

The spike doc (`docs/protocol-probes.md`) predates the `sdkMcpServers` question and does not answer it. While
held I read the CLI's own **embedded control-protocol schema** out of the binary
(`~/.local/share/claude/versions/2.1.278`, read-only, `strings`). It documents the mechanism verbatim:

> Carries one MCP JSON-RPC message for an SDK-hosted MCP server (one named in `initialize.sdkMcpServers`
> or added later with `mcp_set_servers`). Flows in both directions: the CLI sends it to the client to reach
> the in-process server, and the client sends it to the CLI to deliver that server's own messages. When the
> client answers, the success response carries the server's JSON-RPC reply under `mcp_response`; the CLI
> acknowledges a client-sent one with an empty success.

Supporting finds:

- Control subtype `mcp_message` with payload keys `server_name` and response key `mcp_response`. These three
  strings sit **adjacent to the stream-json input parser's own error strings** (`Error: Missing request on
  control_request`, `Error parsing streaming input line (type=`, `cli_malformed_user_message`), i.e. in the
  headless stdio control path — not only in the in-process SDK bridge.
- `initialize` request carries `sdkMcpServers`, `sdkMcpServerConfigs`, `sdkMcpServerManifests`.
- "Settings for the SDK-hosted MCP servers named in `sdkMcpServers`, keyed by server name … Applied when the
  server is first registered."
- The host-sendable control subtype list includes `mcp_set_servers`, `set_model`, `set_max_thinking_tokens`,
  `interrupt`, `mcp_call`, `mcp_status`, `rewind_conversation`.
- "SDK MCP servers are not available in a **cloud-hosted** session" — the restriction is cloud sessions, which
  is not our case (local subscription auth).
- `set_model` and `set_max_thinking_tokens` both exist as documented host requests. `set_model`: "Model to
  switch to. Omitted, null, or 'default' resets to the session default model." `set_max_thinking_tokens`:
  "When `max_thinking_tokens` is omitted or null, thinking resets to the session default."
- `interrupt_receipt_v1` capability on `system/init` adds a `still_queued` field to the interrupt response;
  older CLIs answer with an empty success. Worth reading, not depending on.

**This is documentation mined from the binary, not an executed probe.** It says the wire supports it; it does
not prove the CLI honours `sdkMcpServers` under `-p --input-format stream-json` for *our* argv. That is exactly
what the spike must execute. I am treating it as strong prior, not as the verdict.

## 1. session-bridge.ts

### Registry

`globalThis[Symbol.for("sova.claude-code.session-bridges")]` → `Map<piSessionId, SessionBridge>`.
Process-global because Sova shares one `ModelRuntime` across sessions and `/reload` re-registers extensions;
a module-level map would be re-created and leak the old children.

The same global holds a once-only flag for the process exit hooks (`exit`, `SIGINT`, `SIGTERM`,
`uncaughtException`) so `/reload` does not stack duplicate listeners.

### CLI session identity

`--session-id = uuidv5(NAMESPACE_URL, "pi:" + piSessionId)` for a pi session's FIRST child, and
`"pi:" + piSessionId + "#" + launch` for each one after it. NAMESPACE_URL =
`6ba7b811-9dad-11d1-80b4-00c04fd430c8`.

One id per pi session was the original design, and it was wrong: `--session-id` **creates** a record, it never
re-attaches to one. Handed an id that exists, the CLI prints `Error: Session ID <id> is already in use.` on
stderr and exits 1 without answering `initialize`. With a stable id, the first child's death (an API 500 is
enough) therefore killed the pi session permanently — every later turn failed with "Claude did not answer
initialize", a model switch included. Deriving the id from the pi session keeps the records attributable
without making a relaunch impossible.

The launch counter lives in the bridge, so a new Sova process starts back at 0 and walks forward past the
records the previous one left: `spawnFresh` treats that stderr line as a collision, bumps the counter and
spawns again, up to `SESSION_ID_PROBES` (32) times. Each collision costs one fast-failing spawn (~150 ms); any
other handshake failure still throws on the first attempt.

No `uuid` dependency is available (pi-config extensions are node-builtins-only), so uuidv5 is implemented over
`node:crypto` SHA-1: `sha1(namespaceBytes ‖ utf8(name))`, first 16 bytes, `b[6] = (b[6] & 0x0f) | 0x50`,
`b[8] = (b[8] & 0x3f) | 0x80`. **Verified** against the RFC 4122 vector
`uuid5(DNS, "python.org") == 886313e1-3b8a-5372-9b90-0c9aee199e5d`.

### argv

```
-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --replay-user-messages
--tools ""                     # no built-ins; every tool is pi's, via the MCP facade
--strict-mcp-config
--setting-sources ""
--system-prompt-snapshot off
--session-id <uuid5>
--model <current request model>
--effort <from options.reasoning>
--permission-mode dontAsk      # nothing to prompt for: the only tools are ours
```

`cwd` = the pi session cwd. Env = `process.env` minus `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` (runner.ts does
exactly this), plus `MCP_TOOL_TIMEOUT` (see §2). `shell: false`, `detached` off Windows, piped stdio.

`sdkMcpServers: ["sova"]` goes in the `initialize` control request, not argv.

### Per-turn protocol

The load-bearing fact, verified in `pi-ai/dist/types.d.ts` and `docs/custom-provider.md`:

> **pi calls `streamSimple` once per assistant message. Tool results come back in the NEXT call's transcript.
> But one Claude CLI turn spans all of them.**

So a CLI turn is held open across N `streamSimple` calls. `stream.ts` stays stateless; the bridge owns the
turn. Each `streamSimple` call:

1. Compute the transcript fingerprint (below). If it is not an extension of the recorded one → restart (below).
2. Classify the new tail:
   - trailing `toolResult` messages matching held MCP calls → **resolve those held calls**; the CLI continues
     the same turn and its output streams into this pi message.
   - trailing `user` message(s) → forward them as ONE stream-json user message (as built: every user message
     in the tail, in order, joined with a blank line; the first build sent only the last and dropped the
     rest while fingerprinting them as sent). If held calls are also present,
     answer the held calls **first**, then send the user message (the probe showed a mid-turn user message is
     folded into the active turn, which is what we want for steering).
   - both, in that order.
3. Stream CLI output into normalized `BridgeEvent`s until either the CLI's `result` frame (→ `done`,
   `stopReason: "stop"`) or the `message_stop` of an assistant message that ended in `tool_use`
   (→ `done`, `stopReason: "toolUse"`).

*As built (superseding the original "wait for every `tools/call`" condition).* The end is the message's
`message_stop`, never an earlier per-block `assistant` frame (the CLI sends one per content block) and never
a later dispatch: CLI 2.1.280, live, sends the `tools/call` of an MCP tool not marked read-only only after
the previous call is answered, and pi answers nothing until its message ends — waiting for every dispatch
deadlocked. So announced calls are session state: a result pi returns for a call not yet dispatched is kept
and answered the moment its `tools/call` arrives. Whether the CLI dispatches together or one at a time no
longer matters, so pi's tools carry no `readOnlyHint`.

Tool-call identity: pi's `ToolCall.id` is minted by the bridge from the JSON-RPC request id of the
`tools/call` (`cc_<jsonrpc-id>`), **not** guessed from name+order. pi echoes it back as
`ToolResultMessage.toolCallId`, so correlation is exact. The CLI's own `tool_use_id` is kept only as a
cross-check that the names agree.

### Fingerprint

Per message, a rolling cumulative hash of: `role`, each content block's `type`, its byte size, and a hash of
its text (for images, a hash of `mimeType` + `data.length` — not the base64 payload). Plus a separate hash of
the current system prompt (`getCurrentSystemPrompt`) and the current tool declarations
(`getCurrentTools` → `toToolDeclaration` → JSON), and the model id.

Storing the **array of cumulative hashes** (not one final hash) is what makes "is a prefix of" checkable in
O(1) per message: the new transcript extends the recorded one iff `cumulative[k]` matches for every `k` below
the recorded length.

Divergence causes: rewind, branch, `/compact`, a foreign append, a system-prompt or tool-set change, a model
change. All → restart, except a pure model change while the child is idle, which uses `set_model` (spike must
approve; otherwise restart).

### Restart with folded history

Lossy by construction; the code comment says so. The whole prior transcript becomes ONE stream-json user
message, framed by `FoldMode`:

- `first` — the pi session has never had a CLI child and the transcript is a single user message: that
  message is sent as-is, with no wrapper.
- `joined` — the first child for a conversation that already has history (model switch, reopened or forked
  session). Header: "This conversation started before you joined it, possibly with a different model. …"
- `restarted` — a live child was replaced. Header: "Your session was restarted, so this is a condensed, lossy
  replay of the conversation so far: …"

```
<conversation-history>
<joined or restarted header: condensed transcript, reasoning omitted, tool output may be truncated;
treat it as context you are being told about, not as your own memory>

## User
...
## Assistant
...
## Assistant tool call `mcp__sova__<name>` (id <id>)
## Tool `mcp__sova__<name>` (id <id>) returned
<text, clipped: first 60% … [truncated: N chars omitted] last 40%>
</conversation-history>

Continue from here by answering the latest user message above.
```

Each tool result is clipped to `maxFoldedResultChars` (8,000), or `maxFoldedReportChars` (48,000) for the
subagent retrieval tools `agent_transcript` / `agent_wait` (matched with or without an `mcp__<server>__`
prefix): a worker's report is the deliverable, and every restart re-folds it. A clipped result keeps its head
and its tail, joined by `\n… [truncated: N chars omitted]\n`, so a report's conclusion survives; a result
within its cap is folded verbatim.

*As built (superseding a head-kept 512 KiB character clip).* Tool names are the CLI's (`mcp__sova__<name>`):
the fold once used pi's bare names, the model copied them, and the CLI answered "No such tool available:
bash". The whole body is bounded by a budget sized per request from the model (`foldBudgetChars`,
`contextWindow`/`maxTokens` ride `ClaudeTurnRequest` from stream.ts):

```
overheadTokens = (systemPrompt.length + JSON(tools).length) / 2.2 + 4_000
budgetChars    = clamp((contextWindow - 16_384 - overheadTokens - maxTokens) * 0.85 * 2.2, 64 KiB, 2 MiB)
```

16,384 mirrors pi's default `compaction.reserveTokens` (the provider cannot read pi's settings). 2.2 is
`FOLD_CHARS_PER_TOKEN`, used for every chars-to-tokens conversion, and it is measured: tester live run 1
restarted a real opus[1m] session with a 524,682-character fold, and its first call reported 231,491 input
tokens, system prompt and tools included, so about 2.3 characters per token. The first draft's 4 would have let a
2 MiB fold (about 910K real tokens) overflow a 1M window. 0.85 is headroom for folds denser than that sample. With
the hermetic runtime's system prompt (33.5K / 42.6K characters) and 19 active tools (29.6K characters), the cap is
154,866–162,584 characters on a 200K window and 1,650,866–1,658,584 on 1M (1,712,201 and 216,201 with neither).
2 MiB keeps the one stdin line well under the transport's 4 MiB
`maxLineBytes` with room for JSON escaping and images. A request with no window uses `maxFoldedChars`.
Over budget, whole messages are dropped OLDEST first: the last user message is kept whole whatever its size,
the first user message is kept if it fits in a quarter of the budget, then the newest messages back from the
end until the next would not fit. The body opens with `[N earlier message(s) omitted to fit the context
window]`, the restart header gains a sentence saying the replay does not start at the beginning, a gap after
the kept first message gets `[… N message(s) omitted here …]`, and the images of
dropped messages are dropped with them. The previous head-kept clip replayed the start of a long session and
cut off exactly the recent messages the model had to continue from.

Images cannot be folded into text, so they ride the same user message as stream-json `image` content blocks
alongside the text block. What is lost: thinking content and signatures, exact prompt-cache state, the CLI's
own tool bookkeeping, and any truncated tool output. Cost/usage restarts with the new process (the probes
established that `total_cost_usd` and `modelUsage` are per-process cumulative).

### Abort

`options.signal` → transport `interrupt` control request. Held MCP calls are rejected immediately (JSON-RPC
error) so the CLI is not stuck waiting on us. Per the probes, interrupt **acknowledgment is not settlement**:
wait for the correlated `result` with an `aborted*` `terminal_reason`, and only then emit
`done { stopReason: "aborted" }`. If the turn does not settle within the deadline, fall through to the
runner.ts shutdown ladder (EOF → SIGTERM → SIGKILL on the process group). No bare SIGKILL.

### Usage

The probes are explicit: `modelUsage` and `total_cost_usd` are **process-cumulative**, `usage` is per result
(the sum over every API call in the turn, each tool step, not the last call's), and `num_turns` is per result and may be summed. So the bridge keeps the previous cumulative snapshot and
emits the **difference** per pi turn. Cost is `max`, never a sum, then differenced the same way.

### Cleanup

- `session_shutdown` hook (wired in `index.ts`, which is transport's file) → `disposeSession(piSessionId)`.
- Process exit hooks, registered once via the global → dispose everything.
- Idle-child cap: LRU over idle bridges, default 4; disposing the oldest. A bridge mid-turn is never reaped.
- Every dispose goes through the full shutdown ladder, so no child is ever leaked or bare-killed.

## 2. mcp-host.ts

An in-process MCP server named `sova`, spoken over the control channel. No socket, no subprocess.

- **Inbound**: `control_request` with `request.subtype === "mcp_message"`, `request.server_name === "sova"`,
  `request.message` = a JSON-RPC 2.0 request/notification.
- **Outbound**: `control_response` `{ subtype: "success", request_id, response: { mcp_response: <JSON-RPC reply> } }`.
  A notification is answered with a reply carrying an empty result.

Methods:

- `initialize` — protocol handshake; advertise `tools` capability only.
- `tools/list` — **regenerated every turn** from `getCurrentTools(context.messages)`. Names are
  `mcp__sova__<piToolName>`; description is pi's verbatim; `inputSchema` is
  `toToolDeclaration(tool).parameters`. The JSON round-trip inside `toToolDeclaration` is required, not
  cosmetic: it is what strips typebox's symbol keys and `undefined` fields, which plain `JSON.stringify(tool
  .parameters)` would otherwise mangle. Extension-registered tools are included for free, because
  `getCurrentTools` already resolves them.
- `tools/call` — parse `mcp__sova__<name>` back to the pi tool name, register a **held** call keyed by the
  JSON-RPC id, notify the bridge so it emits the pi `toolCall` and ends the pi message with
  `stopReason: "toolUse"`, and return nothing yet. The JSON-RPC response is sent later, once pi's
  `toolResult` arrives in the next `streamSimple` call.

Held-call resolution maps pi's `ToolResultMessage` to an MCP `CallToolResult`: `TextContent` →
`{type:"text", text}`; `ImageContent {data, mimeType}` → `{type:"image", data, mimeType}` (MCP's image content
shape is the same fields, so this is a direct map); `isError` → `isError: true`.

**Held calls outliving a streamSimple call** is the crux. The held promise lives on the bridge (per CLI child),
not on any one stream. Lifecycle:

| event | held calls |
|---|---|
| pi returns results next turn | resolved with the `CallToolResult` |
| abort (`options.signal`) | rejected → CLI sees a tool error → it settles the turn as aborted |
| fingerprint divergence / rewind | rejected, then the child is restarted (the CLI's view is discarded anyway) |
| child crash | rejected; the pi turn ends `stopReason: "error"` |
| pi never comes back (turn dropped) | rejected at the idle-reap deadline, so the child cannot wedge |

**Timeouts — decided, and grounded in the CLI's own code.** I disassembled the resolution logic out of the
binary rather than guessing. It is:

```js
function ko(e){                                  // effective per-call tool timeout
  let r = (e?.timeout !== undefined && e.timeout >= 1000 ? e.timeout : undefined)
          ?? env.MCP_TOOL_TIMEOUT ?? Sr;         // Sr = 1e8  (~27.8 h)
  return Math.min(Math.max(r, 1000), Jg);        // Jg = 2147483647  (int32 max, ~24.8 d)
}
var Nr = 300000, Fr = 1800000, $r = new Set(["sse-ide","ws-ide","sdk"]);
function Br(e){                                  // idle-reaper timeout
  let n = e?.type ?? "stdio";
  if ($r.has(n)) return 0;                       // <-- "sdk" => 0 => idle reaping DISABLED
  ...
}
```

Three consequences, all in our favour:

1. **The 5-minute cap is not our problem.** That cap is on a *per-server HTTP request* timeout field, documented
   for remote servers, and the schema says it is "Ignored when `timeout` is also set". An SDK-hosted server
   never goes through it. Open question #3 is answered: **a held call may exceed 5 minutes.**
2. **SDK-hosted servers are exempt from the idle reaper.** `Br()` returns 0 for server type `"sdk"`, so a held
   `tools/call` is not reaped for being quiet. Only `ko()`'s wall clock applies.
3. **The hard cap is int32 max ms**, i.e. effectively none.

Decision: **set `MCP_TOOL_TIMEOUT = 86_400_000` (24 h) in the child env.**

Rationale, and why *not* the 1 h that was proposed: if the default really is `Sr = 1e8` (~27.8 h), then setting
3_600_000 would **lower** the limit and make us strictly worse off than not setting it at all. But leaving it
unset means depending on an undocumented default that could differ on another CLI version, so an explicit value
is still right — it just has to be generous, not conservative. 24 h is comfortably above any pi tool run, well
under the int32 cap so nothing gets clamped, and version-independent.

The duration that matters is **not** pi's tool runtime alone. A held call spans pi executing the tool, which can
include pi prompting the *user* for confirmation — unbounded in principle. The real bound on a held call is our
own idle-reap deadline (§2 table), not the CLI's watchdog; `MCP_TOOL_TIMEOUT` is only the backstop.

Do **not** set a per-server `timeout` in `sdkMcpServerConfigs`: any value ≥ 1000 overrides `MCP_TOOL_TIMEOUT`,
so it can only introduce a second, lower limit to keep in sync.

Do **not** set `MCP_TIMEOUT` (server startup). An in-process host answers `initialize` on the control channel
with no process to launch, so startup is immediate; add it only if the spike shows otherwise.

Note for the env allowlist: the CLI groups `MAX_MCP_OUTPUT_TOKENS`, `MCP_TOOL_TIMEOUT`, `MCP_TIMEOUT` and
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` together in one set, and `MAX_MCP_OUTPUT_TOKENS` is worth considering
separately if pi tools return large output.

## 3. Transport API I need (already sent to the transport worker)

From the extracted `transport.ts`, concretely:

1. `spawnImpl` seam with runner.ts's signature — `bridge.test.ts`'s fake CLI child depends on it.
2. NDJSON framing with the byte-bounded reader, `StringDecoder`, malformed record → an error **event**, not a throw.
3. `send(frame) → boolean` with the `writableLength + maxLineBytes` backpressure check.
4. **A hook for raw inbound `control_request` frames whose subtype is not `can_use_tool`.** runner.ts hard-rejects
   these today with "Unsupported host control request" (runner.ts:626). `mcp_message` must reach mcp-host.ts;
   auto-reject should remain only as the fallback when no handler is registered.
5. **`control()` generalized**: accept a full request payload `{subtype, ...fields}` (needed for
   `initialize` with `sdkMcpServers`, `set_model`, `set_max_thinking_tokens`, `mcp_set_servers`) and return the
   **full `response` object**, not just success/error — `tools/list` round-trips carry a payload. Keep the
   30 s deadline and the `undefined`-means-unknown fail-closed contract.
6. Shutdown ladder (interrupt → EOF → SIGTERM → SIGKILL on the group) with the `signalGroupImpl` seam, and
   runner.ts's rule that a deadline never proves death.
7. Env scrubbing of `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`.

## 4. Exported interface to provider-core's stream.ts (already sent to provider-core)

```ts
export type BridgeEvent =
  | { type: "text_start" } | { type: "text_delta"; delta: string } | { type: "text_end"; text: string }
  | { type: "thinking_start" } | { type: "thinking_delta"; delta: string } | { type: "thinking_end"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "usage"; usage: BridgeUsage }
  | { type: "done"; stopReason: "stop" | "toolUse" | "aborted" | "error"; errorMessage?: string };

export interface BridgeRequest {
  piSessionId: string; cwd: string; model: string; reasoning?: string;
  messages: readonly Message[]; signal?: AbortSignal;
}
export interface SessionBridge { run(req: BridgeRequest): { events: AsyncIterable<BridgeEvent> }; dispose(reason?: string): Promise<void>; }
export function getSessionBridge(piSessionId: string, opts?: BridgeOptions): SessionBridge;
export function disposeSession(piSessionId: string, reason?: string): Promise<void>;
```

Division of labour: stream.ts owns `registerProvider`, `AssistantMessage` assembly, pi-ai event pushing,
`calculateCost`, and the `message_end` overflow rewrite. The bridge owns the CLI, tool generation, and tool
correlation. The bridge emits no partial tool-call JSON, because the CLI delivers `tools/call` arguments
whole — stream.ts should emit `toolcall_start`/`toolcall_end` without deltas.

## 5. Fallback variant (only if the spike says the gate failed)

Break-early: surface the CLI's `tool_use` blocks as pi tool calls, end the CLI turn with deny + `interrupt:true`
per the spike's validated shape, and deliver pi's results through whichever resume/follow-up path the spike
validated. No SIGKILL unless the spike proves it is the only way. §1's registry, uuid5, fingerprint, folded
restart, usage differencing, and cleanup are all **variant-independent** and carry over unchanged; only
mcp-host.ts and the turn-continuation mechanism change.

## 6. Open questions for the spike

1. Does `-p --input-format stream-json` actually honour `initialize.sdkMcpServers`, or is it in-process-SDK only?
   (The strings evidence says the stdio path handles `mcp_message`; it needs executing.)
2. Do `tools/call` params carry the CLI's `tool_use_id` in `_meta`? If yes, use it directly instead of the
   JSON-RPC id and drop the cross-check.
3. ~~Does a held SDK-hosted `tools/call` survive longer than 5 minutes?~~ **Answered from the CLI's code** (§2):
   yes. The 5-minute cap is on a remote-server HTTP field that an SDK-hosted server never uses, and server type
   `"sdk"` is exempt from the idle reaper entirely.
4. Are `set_model` and `set_max_thinking_tokens` accepted under `-p`, and does `set_model` mid-session preserve
   the conversation? (`set_max_thinking_tokens` takes a token budget, not an effort level — we need the
   pi `ThinkingLevel` → budget mapping, or a restart with `--effort` instead.)
5. Is `--system-prompt-snapshot off` accepted together with `--session-id` and `--effort` under `-p`?
6. Exact wire shapes to replay in the test fakes: the `mcp_message` envelope both ways, image content blocks on
   stream-json user input, and an MCP image result.

---

# As shipped (supersedes the sections above where they differ)

Written before the spike verdict; three things changed once it landed and once
provider-core defined the seam. The sections above are kept as the reasoning trail, but where
they disagree with this section, this section is what the code does.

1. **The seam is provider-core's, not the `BridgeEvent` union proposed in §4.** `stream.ts` consumes
   `ClaudeSessionBridge.runTurn(request, signal): AsyncIterable<ClaudeFrame>`, where `ClaudeFrame` is the
   validated CLI frame from `types.ts`. The bridge yields parsed frames and ends the iteration; stream.ts
   builds the pi `AssistantMessage`. Simpler, and it keeps one validation boundary rather than two.

2. **Tool-call correlation is by `tool_use` id, not by the JSON-RPC id.** §1 planned to mint pi's
   `ToolCall.id` from the `tools/call` request id. That is not available: `stream.ts` creates the pi tool
   call from the CLI's `tool_use` block, so pi echoes back the CLI's `tool_use` id. And the spike found
   `tools/call` arrives with a BARE name and no `tool_use` id. So the bridge matches a held call to an
   announced block by name plus argument equality, with arrival order as the tiebreak
   (`CliSession.rematch`). This is the name+order correlation §1 hoped to avoid; argument equality makes it
   exact in every case except two identical calls of one tool in one message, where order decides and either
   assignment is equivalent.

3. **`MCP_TOOL_TIMEOUT` ended at 86_400_000 after all** — the value §2 argues for. It shipped briefly at
   3_600_000 on the orchestrator's call, then `ec78a90` moved it to 24 h for exactly the reason in §2: the
   CLI's built-in default is ~27.8 h, so a tighter value only lowers the ceiling. `heldCallTimeoutMs` is
   still the bound that actually matters.

Also settled by the spike and now in the code: `--allowedTools mcp__sova` is mandatory (without it `dontAsk`
auto-denies every MCP call and `tools/call` never arrives); a notification must still be answered with the
dummy `{jsonrpc, result:{}, id:0}`; the MCP image result is flat `{type, data, mimeType}` because the CLI
converts to the Anthropic source shape itself; and a failed tool is not a failed turn.

Dropped for v1 per the orchestrator: `set_model` and `set_max_thinking_tokens` (a model or effort change
restarts and folds instead), `sdkMcpServerManifests`, and `tools/list_changed` (a changed tool set is a
divergence).

**Usage differencing turned out to be unnecessary.** §1 planned to difference the CLI's cumulative
`modelUsage` / `total_cost_usd`. `parseClaudeFrame` reads the per-message Anthropic passthrough usage
instead, which is already per API call, so there is nothing to difference and no cumulative state to keep.
The terminal `result` frame's `usage` is the per-turn sum over every call, so `stream.ts` ignores it for
any message that carried its own usage: the last step would otherwise report the whole turn's tokens as
its context (10 steps at ~105k read as 1.03M and triggered a needless compaction). It is used only when a
message saw no message-level usage at all.

## Session cwd (decided)

The CLI child is spawned in **the pi session's** working directory, not the host process's. The session's cwd
is recorded by the extension at `session_start` (`ctx.cwd`) through `SessionBridge.setSessionCwd(sessionId,
cwd)` and kept in a map beside the session registry — `ClaudeTurnRequest` carries no cwd, and one process
serves many sessions in different directories. `process.cwd()` remains only as the last fallback for a
session that never announced one.

The recording call sits **before** the once-per-process registration guard in `session_start`. Registration
happens once; cwd recording has to happen for every session, and the guard's early return would skip all but
the first.

**A cwd change restarts the child**, the same rule as a model, effort, system-prompt or tool-set change, and
for a stronger reason than any of those: a process's working directory is fixed at spawn and no control
request moves a running CLI. Carrying on in the old directory would leave the model with a false sense of
where it is. `cwd` is therefore part of `turnMeta`, so the existing fingerprint machinery handles it with no
special case.

## Compaction (pi 0.87.1; supersedes "Compaction costs two restarts")

The section this replaces measured pi 0.86.1, whose summary request reused the conversation's session id and so
cost two restarts. In 0.87.1 `completeSummarization` gives the summary request a fresh `uuidv7()` session id
(its caller passes none), with no tools and pi's summarizer system prompt. The bridge therefore sees a new
session: a first-contact child that receives the summarizer prompt as-is, while the conversation's child is
untouched. The 0.86.1 test ("a compaction summary costs two restarts") was replaced by "a compaction summary runs
on its own child, which is disposed after; the conversation restarts once".

- **One-shot children.** A request for a session the bridge has no child for, with no tools and no recorded cwd
  (`setSessionCwd` runs for every real pi session at `session_start`), is one-shot: `SessionBridge.runOneShot`
  disposes its child as soon as the answer is read, instead of leaving it idle until `reapIdle`. pi's
  compaction and branch summaries both arrive this way. Net cost of a compaction: one throwaway child for the
  summary, then one restart of the conversation's child onto summary + kept messages (its prefix changed).
- **Never hang on a message the child did not get.** `ClaudeTransport.send` refuses a line over `maxLineBytes`
  (4 MiB) and returns false. The bridge used to ignore that, so an oversized summary prompt (pi serializes the
  whole to-be-summarized history into it, with no input budget) waited forever. A refused send now ends the
  turn with an error result naming the byte count, and marks the child out of step. A restart whose one
  message certainly cannot fit fails the same way before sending (`windowOverflow`): (message + system prompt
  characters) / 2.2 + `maxTokens` over `contextWindow - 16,384`. There is no safety factor, because it refuses
  only what would fail anyway after a full upload. pi's summary input for the two real 3 MB sessions is 769K
  and 549K characters (about 350K and 250K tokens at 2.2): it fits opus[1m] and is refused at once on a 200K model. Neither check shortens the message; a summary of part of the
  history would read as a summary of all of it.
- **pi owns compaction.** The child is launched with `DISABLE_AUTO_COMPACT=1`. CLI 2.1.282 reads it with
  `M.bool()`, and `fat() = DISABLE_COMPACT || DISABLE_AUTO_COMPACT` makes `autoCompactEnabled` false.
  `DISABLE_COMPACT` is not set because it also removes the manual `/compact`. A `system/compact_boundary`
  frame (the child compacted anyway) marks the child out of step, so the next turn restarts onto pi's view
  rather than letting the two diverge silently.
- **The trigger.** pi's threshold (`contextWindow - reserveTokens`, 983,616 tokens for `[1m]`) is far above the
  fold budget, so nothing compacted and every restart clipped. `auto-compact.ts` hooks `agent_settled`: on a
  `claude-code-cli` model, idle, with nothing queued, and with a leaf that is not already a compaction, it
  estimates the unclipped fold (`foldSizeEstimate` over `convertToLlm(buildSessionProjection().messages)`,
  about 2 ms for a 1,000-message session) against `foldBudgetChars` for the model, the stripped system prompt
  and the ACTIVE tools. If the fold is over, it calls `ctx.compact()`. There is at most one request per leaf,
  and after a failure it retries only once the fold has grown 25%. It uses `agent_settled` rather than
  `agent_end` because `AgentSession.compact()` calls `abort()` first. At `agent_end` `_isAgentRunActive` is
  still true, so that abort would set `_agentRunAbortRequested` and cancel pi's retry of an errored message,
  queued follow-ups and its own `_checkCompaction`. At `agent_settled` the run is over. The check is deferred
  a tick, because a host hands a queued prompt off on the session's `agent_settled`, which pi emits after the
  extension's, and pi runs that prompt once the emission ends. `isIdle()` cannot see that prompt in time:
  `prompt()` passes its compaction check, then awaits input handlers, auth, `_checkCompaction` and
  `before_agent_start` before `_isAgentRunActive` is set. So `input`, `before_agent_start` and `agent_start`
  bump a per-session prompt counter, and the counter must be unchanged since the settle both at the deferred
  check and at `session_before_compact`. A move at that second point cancels the compaction this hook started.
  pi's own threshold/overflow compactions and a user's `/compact` are never cancelled. The hook's own cancel
  is not recorded as a failure, so the next settle may retry. A user's Stop (Sova aborts any compaction) is
  recorded like a failure, so nothing re-triggers until the history has grown 25%, but it is not reported.
- **TUI `/compact`** is built into pi (0.87.0 and 0.87.1: `slash-commands.js`, `interactive-mode.js`
  `handleCompactCommand`), so no extension command is registered. One would also appear as a second
  `/compact` in Sova's command list.

Measured offline on two real `opus[1m]` sessions (607 and 1,062 messages): unclipped folds of 886K and 959K
characters. `[1m]` now folds them whole, where the old code clipped them at 512K and kept the head; a
200K-window model (2.2 characters per token, a 30K-character system prompt, no tools) clips them to about 190K
characters by dropping the oldest 438 and 749 messages, and keeps the task and the last user message.
