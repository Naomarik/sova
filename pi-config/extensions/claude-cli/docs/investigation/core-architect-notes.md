# core-architect notes (pi 0.86.1, claude CLI 2.1.278)

PI = /home/user/.local/share/mise/installs/node/25.2.1/lib/node_modules/@earendil-works/pi-coding-agent
AI = $PI/node_modules/@earendil-works/pi-ai/dist
AC = $PI/node_modules/@earendil-works/pi-agent-core/dist

## Layers
- pi-ai: Model/Provider/Api types, api adapters ($AI/api/*.js), providers ($AI/providers/*.js), OAuth flows ($AI/auth/oauth/*.js), api registry ($AI/compat.js:110-121 BUILTIN_APIS)
- pi-agent-core: agentLoop ($AC/agent-loop.js:86-180) — calls streamFn, executes toolCall blocks, appends toolResult, loops
- pi-coding-agent core: ModelRuntime ($PI/dist/core/model-runtime.js) + provider-composer.js (built-in ⟶ models.json ⟶ extension layering), ModelRegistry facade (model-registry.js), AgentSession (agent-session.js), sdk.js:233-243 streamFn → modelRuntime.streamSimple
- Extension API: $PI/dist/core/extensions/types.d.ts:1072-1073 registerProvider(Provider) | registerProvider(name, ProviderConfig); ProviderConfig.streamSimple at :1109; api required when streamSimple (provider-composer.js:287)

## Known APIs (pi-ai types.d.ts:15)
openai-completions | mistral-conversations | openai-responses | azure-openai-responses | openai-codex-responses | anthropic-messages | bedrock-converse-stream | google-generative-ai | google-vertex | pi-messages ; Api = KnownApi | string (custom ids allowed)

## Codex precedent
$AI/providers/openai-codex.js: createProvider({id:"openai-codex", baseUrl chatgpt.com/backend-api, auth.oauth lazyOAuth({isSubscription:true}), api: openAICodexResponsesApi()})
$AI/api/openai-codex-responses.js: HTTP/WebSocket to chatgpt backend, headers chatgpt-account-id + originator:"pi" (:1276-1277), store:false, include reasoning.encrypted_content
=> It is a direct-HTTP subscription provider, NOT CLI-wrapping. No CLI/subprocess-backed provider exists in pi core.

## Anthropic subscription already in core
$AI/providers/anthropic.js:46-50 oauth "Anthropic (Claude Pro/Max)" isSubscription:true
$AI/auth/oauth/anthropic.js:13-20 claude.ai/oauth/authorize, scopes incl user:sessions:claude_code
$AI/api/anthropic-messages.js:714-727 OAuth tokens (sk-ant-oat) → Bearer + user-agent claude-cli/2.1.251 + x-app:cli; :771-772 betas claude-code-20250219, oauth-2025-04-20; :42-67 tool names remapped to Claude Code canonical names ("stealth mode")
docs/providers.md:36: "billed per token from extra usage, not against Claude plan limits" — this is the motivation for CLI-backed models.
User's ~/.pi/agent/auth.json has openai-codex(oauth), zai, ollama-cloud — no anthropic. ~/.claude/.credentials.json exists (CLI creds); pi does not read it.

## Claude CLI protocol evidence (binary strings, 2.1.278)
- mcp_message: "Carries one MCP JSON-RPC message for an SDK-hosted MCP server (one named in initialize.sdkMcpServers or added later with mcp_set_servers). Flows in both directions" → host-served tools over stdio possible
- set_model, set_max_thinking_tokens, can_use_tool, hook_callback, control_cancel_request control subtypes present
- thinking_delta / signature_delta strings present (12/8 hits)
- initialize response models: value, displayName, description, supportedEffortLevels [low,medium,high,xhigh,max], supportsAdaptiveThinking, supportsFastMode
- existing extension runner.ts:270-276 flags: -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode --tools --model --effort --append-system-prompt-file --mcp-config

## Streaming contract for a custom streamSimple (docs/custom-provider.md "Custom Streaming API")
events: start → text_*/thinking_*/toolcall_* (contentIndex, partial) → done{reason stop|length|toolUse} | error
AssistantMessage fields: content[], usage{input,output,cacheRead,cacheWrite,totalTokens,cost}, stopReason, providerThinkingLevel, responseId
context = TranscriptContext; use getCurrentSystemPrompt/getCurrentTools/collapseSystemMessages
options: reasoning(ThinkingLevel), cacheRetention, sessionId, signal, onPayload, onResponse, thinkingBudgets, maxTokens

## Model metadata needed (types.d.ts:785)
id,name,api,provider,baseUrl,reasoning,thinkingLevelMap,input,cost,promptCache,contextWindow,maxTokens,compat
thinking levels: getSupportedThinkingLevels/clampThinkingLevel ($AI/models.js:554-584) — xhigh/max only if thinkingLevelMap has them

## Auth gating for /model
model-selector.js:104 uses getAvailableSnapshot → provider must have auth configured. Native Provider apiKey.resolve() can return {auth:{}} for "keyless" (models.d.ts:58 doc). Legacy ProviderConfig needs apiKey literal (e.g. "claude-cli") or oauth.

## Compaction
agent-session.js:~300 _compactBeforeNextAssistantResponse uses estimateContextTokens + model.contextWindow; compaction.js:89 uses usage.totalTokens. Compaction summarization uses same streamFn (agent-session.js:1568) → CLI-backed provider must handle a summarization request (plain text, no tools).

## cli-prober live results (2.1.278), part 1 — received
1. SDK in-process MCP over stdio: WORKS end-to-end. initialize {sdkMcpServers:["pi"]} → CLI sends mcp_message initialize/tools/list/tools/call; host answers control_response {response:{subtype:"success",request_id,response:{mcp_response:{jsonrpc,id,result}}}}. With --tools "" only mcp__pi__* tools exposed. Needs --allowedTools "mcp__pi" under --permission-mode manual --permission-prompts none. tools/call _meta carries claudecode/toolUseId (map to pi toolCall.id).
2. Host-supplied tool_result via stdin: DOES NOT WORK. CLI never pairs stdin tool_result to a tool_use. => streamSimple cannot be stateless; pi tools MUST ride SDK-MCP.
3. Thinking: text REDACTED (thinking:"" deltas with estimated_tokens; signature present). Only a token meter. Cannot disable thinking; --effort none invalid.
   => PARITY GAP: pi thinking_delta display impossible; emit nothing or a placeholder; signature is opaque and display-only.
4. Usage per API call on each `assistant` event and `result` (input, cache_creation, cache_read, output, service_tier, 5m/1h split). result.modelUsage adds contextWindow 200000, maxOutputTokens 32000 → can populate Model.contextWindow at discovery. total_cost_usd is CUMULATIVE per process → diff consecutive results.

## cli-prober part 2 — received
5. Images in stream-json user messages: YES (base64 image block).
6. Context seeding: YES via stdin replay of user + assistant TEXT messages (durable, works as first record). Also via synthesized ~/.claude/projects/<slug>/<uuid>.jsonl + --resume (CLI-owned dir; avoid). tool_result replay still fails → flatten prior tool calls/results to text when re-seeding.
   --system-prompt replaces CC preamble (uncached, ~364 tok overhead); --append-system-prompt keeps cached ~6.5k CC prefix.
7. initialize lists models (value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode, disabled). No contextWindow (only in result.modelUsage after a turn).
Correction: assistant text replay works; earlier "dropped" was a safety refusal on fake credential content.
Gaps: no verbatim thinking; thinking can't be off; no temperature/top_p/max_tokens/stop_sequences flags; cumulative total_cost_usd; API errors as subtype success + is_error with exit 0; stray non-JSON stdout lines.
Ops: 1.5–2s startup per process; warm ttft ~700ms; 6 concurrent fine.

## cli-prober hard-verification of SDK-MCP crux — received
- CLI blocks on host tools/call indefinitely (45 s hold OK, exit 0); duration_api_ms excludes held time.
- tool_use block appears in stream-json ~10 ms BEFORE mcp_message tools/call → pi can emit toolcall_start/end then pause the pi stream with stopReason toolUse.
- can_use_tool also fires for sdk-served tools (mcp_server.source:"sdk", permission_suggestions) when --permission-prompts host --permission-prompt-tool stdio; two independent blocking round-trips (permission, then execution). Malformed permission answer → tool error, not crash.
- set_max_thinking_tokens {max_thinking_tokens, thinking_display: summarized|omitted|highlights} acknowledged mid-session; none exposes reasoning text.
