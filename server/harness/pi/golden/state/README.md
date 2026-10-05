# State goldens: the bytes Sova's session writers leave

Milestone 4 of the harness-boundary refactor (§app/harness) moves every pi-session write Sova makes outside
pi-config behind `SessionState`. These fixtures were recorded on the code **before any writer moved**
(feat/harness-integration at 99791bc), by `../../state-golden.test.ts` driving today's real code paths. A
later change must keep them green with **no fixture edit**: a diff here in a refactor is a review stop.

```
pnpm test -- server/harness/pi/state-golden.test.ts                       # compare (part of every pnpm test)
SOVA_GOLDEN_RECORD=1 pnpm test -- server/harness/pi/state-golden.test.ts  # write fixtures that are missing
SOVA_GOLDEN_RECORD=overwrite …                                            # rewrite all: never in a refactor
```

The run: one process, a throwaway `PI_CODING_AGENT_DIR`, the server imported (PORT=0) so routes, the
Overseer and the baton statechart are wired as in production, and `testing/scripted-model.ts` as the model
(registered by models.json as a real authenticated model, so sessions open on it and pi records it).
Each file is compared byte for byte after `testing/canonical-jsonl.ts`: entry ids → `00000001…`, uuids →
`00000000-0000-7000-8000-00000000000N`, ISO times → `2000-01-01T00:00:00.000Z`, message ms timestamps →
`1000…` (same length), temp dirs → `<DIR>`, the repo → `<REPO>`, and three bodies elided: pi's system-prompt
message, hook notes' (`custom_message`) content and tool results' content. Key order is never touched.

| fixture | scenario | pins |
|---|---|---|
| `G1-rewind` | 2 turns, dispose, reopen, rewind to the 2nd input, reopen | `sova-rewind` `{targetId, fromLeafId}` parented on u1's reply; the marker is the leaf on reopen |
| `G1-rewind-no-thinking` | a 2-turn file without a thinking entry, opened and rewound | the deferred `thinking_level_change` written AFTER navigating (on the new branch), then the marker |
| `G2-sender-markers` | `acceptPrompt` with `sentByOverseer`, `sentByBaton`, `sentBySession`, one turn each | the three sender markers, each in its microtask, parented on its user entry, before the reply |
| `G3-topic-delivered` | `deliverTopicBatch(mark)` with one turn | `sova-topic-delivered` on the batch's user entry |
| `G4-pristine-setup` | `writeLoadout`, dispose; `writeProfile`, dispose; `switchSubagentProfile("off")`; `pinMode()`; `applyMode` (align on); `pinMode()` again | the open-time flush before the first write; each reopen's `thinking_level_change`; loadout, profile, pick, Sova's mode pin, the extension's own `mode` entry; the matching pin writes nothing |
| `G5-baton` | `createBaton` (to one person); opened, never prompted, Take back and hand back; a held reply with two messages queued; Take back mid-reply | seed marker + hand-off; the operator's `appendSpecialEntry` hand-offs WITHOUT the open-time flush; the flush at the first prompt; the stopped reply, the queued messages entered as user entries with their `sova-baton-sent` markers, then the hand-off |
| `G6-baton-decision` | a scripted `record_decision` tool call | `sova-baton-decision` through `pi.appendEntry` inside the tool, before the tool result (the test also checks its row is broadcast) |
| `G7-overseer-first` | the Overseer makes a card with a rule option (scripted `sova_card`); the user clicks it | `sova-overseer` marker; `overseer-rule` written in the click's `setImmediate`, after the reply |
| `G7-overseer-cleared` | `/clear`; an unattended brief runs a scripted `sova_send` under the rule; the rule revoked | the carried rule seeded after the marker (naming G7-first's click: the three G7 files share one numbering); `overseer-grant-use` mid-run before the tool result; `overseer-revoke` |
| `G7-overseer-target` | the session `sova_send` reached | `sova-overseer-sent` with the Overseer's id |
| `G8-project-overseer` | `ensureProjectOverseer` | header + `sova-project-overseer` marker, hand-written |
| `G8-web-session-profile` | `POST /api/sessions {cwd, subagent_profile: "off"}` | header, then `subagent-profile` appended by `SessionManager.open` on the header-only file |
| `G9-dialog-answer` | a fixture extension's tool opens a `select`; `answerDialog` | `sova-overseer-dialog-answer` while the tool waits, before its result |
| `G10-open-dispose`, `-empty` | open, attach, detach, dispose with no prompt (a 1-turn file, a header-only one) | the file is byte-identical to before (asserted on the raw bytes too) |

Not covered here: an `enterQueued` item the run already took (a timing window this driver can't hold
deterministically), the fork cache line (M5, `fork`), and pi-config's own grandfathered writers.
