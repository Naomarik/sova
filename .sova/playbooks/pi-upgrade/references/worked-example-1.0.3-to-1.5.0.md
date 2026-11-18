# Worked example: pi 1.0.3 to 1.5.0

One real run of Phase 1, condensed from the team's three reports. It shows the depth a run should reach and how its findings read. It is a record of that run: nothing here is true of a later upgrade until that upgrade's own team says so. Line numbers are at Sova commit `7d544bde`.

**Verdict: upgrade later, to 1.5.0; no upgrade decision taken yet; findings as of 2026-11-09**

That means a planned branch to 1.5.0, not a bump today. The upgrade itself has not started. On 1.5.0, typecheck and build fail with 3 errors and the unit tests go from 1 failing file to 13. Most of the fixes are small, but four of the changes alter how running chats behave.

## Versions

| | Pinned | Found |
|---|---|---|
| `pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-mcp` | 1.0.3 (2026-10-05) | 1.5.0 (2026-11-02), `latest` on all four |
| Terminal pi (npm global under mise's Node) | n/a | **0.87.0** |

Six releases after the pin (1.0.4, 1.1.0 to 1.5.0), in lockstep. No prereleases. The only other dist-tag was `legacy-node20`. `pi-agent-core`, `pi-codemode` and `pi-telemetry` moved too, `pi-schema` is new, and `chord` was dropped.

## What the tests showed (`ran`)

| Check | 1.0.3 baseline | 1.5.0 |
|---|---|---|
| `pnpm run typecheck` | pass | **3 errors**, one cause |
| `pnpm run build` | pass | **fails** in its `tsc` step; the two `vite build`s pass |
| `pnpm test` (1,236 files) | 14,385 pass, 8 fail, 1 failing file | 14,326 pass, 67 fail, 13 failing files |
| Harness integration (30 files) | 221 pass, 3 fail, 1 failing file | 220 pass, 4 fail, 2 failing files |
| `test:int --groups trial` (41 files) | 53 pass, 4 fail | 56 pass, 1 fail |

Install: 13 packages added, 11 removed. No new install script wanted to run, and no peer warnings.

## Harm, in the order reported

**1. Automatic turns now run the start-of-turn hook.** Runs an extension's own message starts now go through the same first step as a person's message. Mode notes, Overseer notes and tool syncing that assume a person typed will run on those turns too, and the Overseer tells a change on the wrong run, so the next real run says nothing changed.
- pi 1.2.0, BREAKING: `before_agent_start` also fires on `sendMessage(…, {triggerTurn:true})`, and the event is a union on `messageType`.
- `ran`: the 3 compile errors, `server/harness/pi/modes.ts:201`, `server/harness/pi/playbook.ts:55`, `server/served-tools.ts:58`; `server/overseer-runtime.test.ts:806` fails.
- `read`: `pi-config/extensions/mode/index.ts:1682` and `:1722` assume the opposite, and pi-config compiles fine because it isn't typechecked. Other handlers now fire on those runs too: link, remote, wake-nudge, explain, compact-handoff, provider-limits, vision-delegate, model-levels, llm-inflight, subagents' fork child, claude-code's auto-compact.
- QUIRKS P39's prose states the old assumption, and its canary still passes.

**2. A chat counts as busy while a turn starts.** Code that checks "is it idle" or sends a message with no delivery instruction in that moment gets a different answer, or an error.
- pi 1.2.0, BREAKING: `isIdle()` is false during `before_agent_start`, and `sendUserMessage()` requires `deliverAs` then.
- `read`: callers that pass none when idle, `server/harness/pi/modes.ts:131`, `pi-config/extensions/mode/index.ts:1225`, `pi-config/extensions/btw/btw.ts:2331`. `pi-config/extensions/claude-code/provider/auto-compact.ts:75-118` reasons about this exact timing.
- `ran`: `server/baton-handoff.test.ts:139` sees the reply as `starting`, not `writing`.

**3. Old and new pi sharing session files after landing.** Low risk: read from the code, not tested.
- `read`: session version 3 on both, the same entry types, new fields additive only (`durationMs`, `argumentsError`, `responseModel`, `totalFromProvider`), so no file is rewritten on open.

**4. Tool order changes.** Tools that stay active keep their place and new ones are appended, so a reopened chat can declare tools in a different order than a fresh one. The order is part of the request prefix, so the prompt cache misses.
- pi 1.5.0 (#11495).
- `ran`: canaries P22 and P23, `server/harness/pi/contract.test.ts:767` and `:882`. Sova promises a reopen keeps the fresh chat's order (§app.project-services/tool-offered).

**5. Tool validation moved library.** Validation now runs on `pi-schema`, and the messages the model reads changed wording. `pi-ai` no longer re-exports TypeBox, so code outside pi's extension loader that imports it from there breaks.
- pi 1.5.0, BREAKING.
- `read`: `pi-config/extensions/claude-code/provider/frames.test.ts:5` and `bridge.test.ts:17` import `Type` from `pi-ai`. `rg` found no use of the TypeBox features that stopped applying (`Type.Refine`, `BigInt`, `Undefined`, codecs, `Format.Set`).

**6. Deep reaches no test covers.** These can break with nothing failing.
- `read`/`inferred`: `scripts/mesh-vps/warm-extensions.mjs:18-38` hard-codes pi's alias map, and the loader gained entries; `server/harness/pi/system-replay.ts:29-32` imports a `dist/` path; `pi-config/extensions/llm-inflight/runtime.ts:271-310` and `pi-config/extensions/subagents/fork/cache.ts:101-118` replace stream functions. pi's new `markRuntimeStreamFunction()` was not examined.

**7. HTML export now loads terminal drawing code.** A file outside the terminal mode newly takes a drawing module, which breaks the assumption chats make when they strip that code out.
- `ran`: canary P27, `server/harness/pi/contract.test.ts:1046`; `server/harness/pi/headless.test.ts:70` finds 4 files nothing classifies (`program-status.js`, `program-status-reporter.js`, `theme-schema.js`, `theme-tokens.js`).

## Benefits

- **Much cheaper streaming of large tool calls** (1.5.0). `ran`: the guard's unguarded control case cost 3,241 ms of main-thread CPU at 1.0.3 and 56 to 62 ms at 1.5.0.
- **Compaction summaries sized to the model's output limit, without thinking blocks** (1.2.0, 1.4.0), so long reasoning no longer makes them fail.

No workaround could be dropped.

## Neutral

- `aborted` on `agent_settled` and `durationMs` on tool results: additive, and Sova tolerates both.
- RPC mode byte-identical; `dist/bun/*` unchanged; `engines.node` unchanged.

## Set aside as not pi

Each by comparing the two versions, not by reasoning:

- `src/lib/settings-forms-roundtrip.test.ts` (8): the tier guard caught a test spawning `systemctl` about the tester's own chat unit. Same on both.
- `server/harness/pi/mcp.integration.test.ts` "Sandbox On" (3): a nested sandbox can't be set up inside a sandboxed chat. Same on both.
- `trial-s5-generations` fails on both; three other trial files failed only at baseline, so they are load-sensitive.
- `server/claude-pool/agent.test.ts` passes on rerun. `server/merge-queue/queue.test.ts` uses an 80 ms timer: passes alone on both, failed in parallel only on 1.5.0. Load, not pi.
- `Unknown options: --claude-code-provider` appeared only in the 1.5.0 log, but forcing the output showed 12 occurrences at 1.0.3 too: the runner hides the output of passing files.

And one failure that is good news: `server/stream-guard-runtime.integration.test.ts:131` asserts the unguarded case is at least 4 times dearer, and pi removed most of that cost. The test's premise, and the guard's case, need rethinking.

## Golden drift

Re-recorded at both versions to separate pi from the recording environment (the modes recordings pick up an extra `spec` tool at 1.0.3 too, which is not pi). At 1.5.0: `agent_settled` carries `aborted`, persisted tool results carry `durationMs`, and pi's base prompt was rewritten ("You are a coding assistant running inside pi…", edit guidelines cut from 4 to 2), which moved the modes goldens, `special-model-view.json` and the loadout snapshot. One diff was not explained: `G5-baton`'s effect key changed `@16.0` to `@15.0`, most likely the run-start ordering (`inferred`, not verified). In Phase 2 that one needs explaining before any re-record.

## Not examined in this run

- pi-config's own suites (the `## Tests` block) and `typecheck.mjs` were not run, so everything said above about pi-config is `read`.
- `themes/` against the theme schema pi 1.2.0 moved and now validates at start.
- What the jump from 0.87.0 changes for the terminal pi.
- The tours (driven in Chrome), the forms-browser and merge-queue slow groups, and the rest of the everyday integration set.

## What the upgrade would need

- Pins to 1.5.0; `typebox` stays 1.3.27, the version `pi-coding-agent` still asks for. In the release-age list drop `chord` and add `pi-schema`.
- Narrow the 3 compile sites on `messageType`, and apply the answer to question 1 across the handlers. Fix the prose of QUIRKS P39.
- Pass `deliverAs` at the 3 send sites.
- Triage P22, P23, P27 by row. Classify the 4 new files.
- Fix or re-check the deep reaches in harm 6.
- Rethink the stream guard test.
- Explain each golden diff, then re-record.
- Terminal pi 0.87.0 to 1.5.0 at the landing (the standing decision).

## Questions, still open

The user decided none of these.

1. Should the `before_agent_start` hook skip extension-started runs, to keep today's behaviour? **Recommendation: yes.**
2. Move the terminal pi to 1.5.0 with Sova's bump? Now superseded by the standing decision: always.
3. Allow old and new chats to overlap after landing, then Reload Now soon after? **Recommendation: yes.**

## What the run taught this playbook

- A clean-looking compile error can hide the real change. The 3 errors had one cause, and the behaviour behind them reaches handlers that compile fine.
- A passing canary can sit under false prose (P39).
- Compare, don't reason: eleven failures were the tester's own environment, and one log line looked new only because the runner hides passing output.
- A test can fail because pi improved.
- The terminal pi was outside this research, though at 0.87.0 it jumps furthest and shares `~/.pi/agent` with Sova. The changelog reader now covers it.
- pi-config's suites default to the global pi, and the merge queue's `extensions` check runs only changed extensions, on that global pi. So the tester and Phase 2 both run the whole block with `PI_PACKAGE_DIR` set.
