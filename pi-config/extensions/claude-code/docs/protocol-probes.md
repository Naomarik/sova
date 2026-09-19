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
- `modelUsage` token counts and `total_cost_usd` are cumulative for the process; `usage` is per result. The runner assigns from `modelUsage` and takes the maximum cost (no summing).
- `/compact` sent as a stream-json user message emitted `system/compact_boundary` and a success result with an empty `result`. `session_id` stayed the same across compaction and all turns.

## Still unverified

Missing interrupt response from a real CLI; interruption with several host-queued follow-ups against the live CLI (covered offline only); compaction triggered automatically rather than by `/compact`; behavior on other CLI versions.
