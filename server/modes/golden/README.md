# Modes recordings

What a chat's or a worker's model sees of its modes, recorded at master `7c4750f0a` with the pi-config mode
extension running every mode, and the yardstick for Sova's engine (al_1, Settings → Experimental → "Sova
runs chat modes"). The code is in `server/modes/tests/` (`harness.fixture.ts` says what a recording holds;
`cases.fixture.ts` lists the cases).

```
cases/<case>.json      one recording per case: its steps, each big value a "@<hash>" reference
store/<hash>.json      the big values (system prompts, tool lists, notes), once for every case, named by content
```

| | |
|---|---|
| `pnpm test -- server/modes/modes-extension.golden.test.ts` (+ `.integration.test.ts`) | switch off: each case vs its recording, a1's additions aside (`withoutA1`) |
| `pnpm test -- server/modes/modes-sova.golden.test.ts` (+ `.integration.test.ts`) | each case off, then on: on must give off's bytes, unfiltered; every chat and worker of the on run loads Sova's engine in the mode slot |
| `bun server/modes/tests/show.fixture.ts <case> [path]` | a recording read back whole, e.g. `c14-toggles 5.calls.0.add` |
| `SOVA_MODES_GOLDEN=record pnpm test -- server/modes/modes-extension.golden*.ts` | re-take them (switch off only) |
| `SOVA_MODES_DUMP=<dir>` | a request that failed the once-only check, written whole |

Re-take them from master's code, never from a tree in the middle of the move: `git archive <rev>` into
`.cache/<name>`, link `node_modules`, copy `server/modes/tests/`, the four test files, the runner's
`server/modes/**/*.test.ts` glob and `SOVA_MODES_GOLDEN` in `scripts/test-env.mjs`'s allowed list in (while master lacks them), record there with `node scripts/run-tests.mjs -- <files>`, and copy
`golden/cases` and `golden/store` back (delete both first: the store check fails on files nothing uses).
Review the diff as the change's effect on every case.

Cases that run a program (the spec tools, a project tool) are in the integration files; the rest are unit.
A case with `unrecorded` (c23: it needs a1's `spec` tool, which master lacks) has no file: it checks its own
record, and the on/off byte comparison still covers it. `worker-slots.golden.test.ts` pins the worker mode
files' single source (subagents' constants, own-code's in-place mapping).
