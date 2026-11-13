# Modes recordings

What a chat's or a worker's model sees of its modes, from Sova's engine, the only mode owner in Sova. First taken at
master `7c4750f0a` from the pi-config mode extension (the team tools' wording re-taken since, when every team got
Sova's coordinator and monitor, and when team members got Delegate's work kinds), then re-taken from Sova's engine at
`f425253eb`, where its records matched the extension's byte for byte apart from al_1 a1's additions (the `spec` tool
and its two sentences) and w07 (a worktree-config worker whose tree has no mode extension: refused by the extension,
started by the engine). Since then only intended changes moved them: the spec block's trusted-tools line reads
`SOVA_SPEC_CORE` first (al_1 q1). They are the yardstick that keeps every prompt and tool where it is. The code is in
`server/modes/tests/` (`harness.fixture.ts` says what a recording holds; `cases.fixture.ts` lists the cases).

```
cases/<case>.json      one recording per case: its steps, each big value a "@<hash>" reference
store/<hash>.json      the big values (system prompts, tool lists, notes), once for every case, named by content
```

| | |
|---|---|
| `pnpm test -- server/modes/modes-sova.golden.test.ts` (+ `.integration.test.ts`) | each case vs its recording, unfiltered; every chat and worker loads Sova's engine in the mode slot and never a mode extension's own file |
| `bun server/modes/tests/show.fixture.ts <case> [path]` | a recording read back whole, e.g. `c14-toggles 5.calls.0.add` |
| `SOVA_MODES_GOLDEN=record pnpm test -- server/modes/modes-sova.golden*.ts` | re-take them (delete `cases/` and `store/` first: the store check fails on files nothing uses) |
| `SOVA_MODES_DUMP=<dir>` | a request that failed the once-only check, written whole |

Re-take them only for an intended change, and review the diff as that change's effect on every case: decode the old
and new recordings and compare them with the intended edit applied to the old side, so nothing else moved.

Cases that run a program (the spec tools, a project tool) are in the integration file; the rest are unit. A case's
`check` asserts what its record means beside the byte comparison (c23: one census counter for a tool read and a shell
read; w07, w09: a worktree-config worker's start and prompt). The recorded chats list the mode folder and subagents
in their settings, as an installed pi folder does: the engine takes the mode folder's slot in place. A chat with no
mode entry at all is `server/sova-modes-owner.test.ts`'s. `worker-slots.golden.test.ts` pins the worker mode files'
single source (subagents' constants, own-code's in-place mapping).
