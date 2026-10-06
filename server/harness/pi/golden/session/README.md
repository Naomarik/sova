# Session goldens: what a live chat does, S1-S15

Characterization tests for a live chat (§app.harness/session): what it sends two clients, what it writes
and the order of its calls into pi, driven by `../../session-golden.test.ts` through the real code paths.
First recorded before milestone 5 moved the live pi session behind `HarnessSession` (feat/harness-integration
at 76a4513), where they proved the move changed nothing; they now pin the current behaviour, above all the
SDK call order the quirk rows P1, P2, P5, P6, P7, P9, P10, P13, P15 and P20 rely on, end to end. An
unintended diff is a bug; an intended one is re-recorded and its diff reviewed with the change.

```
pnpm test -- server/harness/pi/session-golden.test.ts                       # compare (part of every pnpm test)
SOVA_GOLDEN_RECORD=1 pnpm test -- server/harness/pi/session-golden.test.ts  # write fixtures that are missing
SOVA_GOLDEN_RECORD=overwrite …                                              # re-record all, after an intended change
… --test-name-pattern='^S7:'                                                 # one scenario (each stands alone)
```

The root is a fixed-length `/tmp/sova-session-golden-XXXXXX`, not `TMPDIR`: S7/S8's `estimatedTokensAfter`
counts the system prompt, which names paths under it. Where `/tmp` is not writable the test can't run.

The run: one process, a throwaway `PI_CODING_AGENT_DIR`, the server imported (PORT=0), two scripted models
(`scripted`, and `scripted-think` with a thinking ladder), the repo's mode extension by path, a fixture
extension whose tool opens a `select`, and `../../testing/compact-fixture-ext.ts`, which makes pi's real
compaction write a summary it supplies (with a fixed `tokensBefore`). The links source is replaced by one
that answers `[]` in a microtask, so each `links` frame stays at its call site. `PI_PACKAGE_DIR` points pi
at a link under the throwaway root, so the README/docs/examples paths in pi's system prompt (which the
compaction's `estimatedTokensAfter` counts) do not carry the checkout's path length.

Each scenario leaves two files:

- `<name>.jsonl`: the session file(s), canonical as the state goldens (`../state/README.md`).
- `<name>.trace`: everything that happened, in order, canonical with the same numbering (and a known entry
  id replaced wherever it appears, e.g. a row's `<id>:0`):
  - `A …` / `B …`: what each attached client was sent, A on wire 1 and B on wire 2 (the server's own
    mappers), for the frame types the scenarios exercise (`PINNED` in the test): event frames, rows, queue
    and those control messages whole; a hello cut to its run state, model, thinking and rows' `id kind`
    (`HELLO_KEYS`), a history to its rows' `id kind`. Any other frame type (the command list, the profile,
    the Claude login note, whatever a later feature adds to a hello or an attach) is left out, so adding one
    re-records nothing; its own tests pin it. pi's system-prompt message and a hook's custom-message content
    are elided inside events, as in the file.
  - `sdk <call> <args>`: each call into pi's `AgentSession` (prompt, steer, followUp, abort, clearQueue,
    compact, navigateTree, setModel, setThinkingLevel, sendCustomMessage, `agent.continue`, an extension
    command's handler), recorded by wrapping the raw session from the test side; `(settling)` marks a call
    made inside pi's `agent_settled` emit.
  - `write …`: each entry pi appended (`_appendEntry`), when it appended it.
  - `step …` / `got …`: the test's actions and what they returned.

Ordering comes from the code only: a held reply (`ScriptedModel.hold`) or a held compaction parks the run,
the test acts there and waits for the outcome. No wait depends on how long anything took.

| fixture | scenario | pins |
|---|---|---|
| `S1-open-first-prompt` | a message-less file with a recorded `model_change`; open, attach A+B, detach, dispose; reopen; prompt | open/attach/dispose leave the bytes identical; the first prompt writes the deferred `thinking_level_change` before `prompt()`, the restated model dropped (P1, P20) |
| `S2-steer-mid-turn` | held reply; A steers, B steers an image-only message; release | Sova's queue rows on both tabs; one item in the SDK at a time; `queue_item_gone{delivered}`; the image-only steer is delivered, not stranded (P9) |
| `S3-follow-up-queue` | held reply; three follow-ups; the middle removed; release | order kept; `queue_removed` to the asker, `queue_item_gone{removed}` to all |
| `S4-abort` | held reply; a steer and a follow-up queued; Stop | `clearQueue` then `abort`; `queue_cleared{steering,followUp}`; the aborted reply |
| `S5-rewind` | two turns; rewind to the 2nd input; dispose; reopen | `navigateTree`, then the marker; hello, mode (and the mode extension's status) to both, `rewound` to the asker; the marker is the leaf on reopen (P10) |
| `S6-regenerate` | two turns; regenerate from `<a2>:0` | resolve, `navigateTree`, marker, hello, `regenerated`, then `prompt(text, {expandPromptTemplates:false})` |
| `S7-compact-manual` | two turns; `/compact keep x`; a send while the summary is held | `compact()` (pi's own `abort()` first); the send queued; the compaction entry; hello, mode, queue, then `compacted`; the held turn after (P2) |
| `S8-compact-auto` | a reply reporting 90k tokens with a follow-up handed off; pi's threshold compaction | the compaction inside the run, the follow-up's turn, then the refresh hello at settle |
| `S9-deferred-in-settle` | a prompt sent from an `agent_settled` listener; a topic batch offered there | `prompt()` made `(settling)` and pi's own re-call after it; `deliverTopicBatch` → `busy`; the second turn's provider error as an assistant error message (P5) |
| `S10-baton-stop` | baton session: held reply, two participant messages queued, the operator's Stop; then a new message | `keepQueued`: `clearQueue`, `abort`, the queued messages entered as user entries with `sova-baton-sent`; the next request's context contains them (P6) |
| `S11-overseer` | the Overseer: the user's message, then a server brief | `attended` true at the user's model call only; the run note before each reply (P7) |
| `S12-link-delivery` | `deliverToAgent` idle, then mid-turn | `started` via `prompt(…, {streamingBehavior:"steer", preflightResult})`; `delivered` via `steer` (P15) |
| `S13-dialog-bridge` | three `select` dialogs in one turn: answered from tab B, by the Overseer, then every tab leaves | `ui_request`/`ui_resolved` to both; the dialog-answer marker row; the fallback when nobody is attached |
| `S14-model-thinking` | `set_model`, `set_thinking` (twice) idle on a pristine session; both refused mid-run | the flush before `setModel`; the synthesized `Thinking:` row only on a change (P13); the clamped echo; refusals; the new-session defaults saved |
| `S15-mode-command` | `applyMode` (align on) and `pinMode` on a pristine session; `switchMode` mid-turn | the flush, then the `/mode` handler calls in order and the extension's entries; `applies: "after-turn"` |

Not covered: an extension's follow-up sharing the SDK queue (`shared_queue` refusal), a compaction from an
extension's `ctx.compact()`, the `already processing` link retry, `/claude-login`, `/sandbox` and
`agent-resume` (their extensions are not loaded here), and a turn-2 error that rejects turn 1's `prompt()`
(a scripted provider error never rejects: pi records it as an assistant error message).

## Re-records

- 2026-10-05 S7, S8 (`.jsonl`, `.trace`): pi's package dir moved from `<REPO>/node_modules/.pnpm/…` to the
  fixed-length `<DIR>/pi` (`PI_PACKAGE_DIR`). The system prompt's three pi paths had made
  `estimatedTokensAfter` depend on the checkout's path length (S7/S8 failed in other worktrees); it is now
  2815 in S8. Recorded on feat/harness-integration f59cc66; no other fixture changed.
- 2026-10-06 all traces: frame types no scenario exercises (`commands`, `profile`, `claude_login`) left
  out, and a hello cut to `HELLO_KEYS`; every remaining line unchanged (feat/golden-slim).
