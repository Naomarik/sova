---
watches: ["pi-config/extensions/spec/**", "pi-config/extensions/mode/spec*.ts", "pi-config/extensions/mode/spec-mode.md", "pi-config/extensions/subagents/spec-brief.ts", "pi-config/extensions/worktrees/spec.ts"]
alsoUpdate: ["pi-config/extensions/spec/docs/CHANGELOG.md"]
---
# spec

The spec system: the `.sova/spec` tools, the `spec` minor mode that tells agents to run them, and its hooks. This
guide is for changing the system. To follow the discipline while working on Sova, AGENTS.md points at
`pi-config/extensions/mode/spec-mode.md` and, before a behavior change, `pi-config/extensions/spec/WRITING.md`.

## What lives here, and its own docs

| Piece | Where | Its docs |
|---|---|---|
| The tools (read-only core, drafts, review) | `pi-config/extensions/spec/core/*.mjs` | [`spec/README.md`](../../../pi-config/extensions/spec/README.md), [`core/README.md`](../../../pi-config/extensions/spec/core/README.md), [`DRAFTS.md`](../../../pi-config/extensions/spec/DRAFTS.md), [`PROMOTE.md`](../../../pi-config/extensions/spec/PROMOTE.md) |
| The mode's text in two parts: the short one injected while spec is on, the writing procedure handed over once | `pi-config/extensions/mode/spec-mode.md`, `pi-config/extensions/spec/WRITING.md` | (they are the text) |
| The mode's hooks, worker checks and brief | `mode/minor.ts`, `mode/prompt.ts`, `mode/spec-guard.ts`, `mode/spec-worker.ts`, `subagents/spec-brief.ts`, `worktrees/spec.ts` | [`MODE.md`](../../../pi-config/extensions/spec/docs/MODE.md), every piece and how they connect |
| Goals, history, ledger | `pi-config/extensions/spec/docs/` | [`README.md`](../../../pi-config/extensions/spec/docs/README.md): [`GOALS.md`](../../../pi-config/extensions/spec/docs/GOALS.md), [`EVOLUTION.md`](../../../pi-config/extensions/spec/docs/EVOLUTION.md), [`CHANGELOG.md`](../../../pi-config/extensions/spec/docs/CHANGELOG.md) |
| Sova's own spec, and how to run the tools in this repo | `.sova/spec/` | [`.sova/spec/README.md`](../../../.sova/spec/README.md), [`.sova/spec/USAGE.md`](../../../.sova/spec/USAGE.md) |
| The user-facing page | `site/src/content/docs/modes/spec.md` | |
| The yardsticks | `spec/tests/replay/`, `spec/tests/search/` | [`tests/replay/README.md`](../../../pi-config/extensions/spec/tests/replay/README.md), [`tests/search/README.md`](../../../pi-config/extensions/spec/tests/search/README.md) |

The requirement is §tools/spec (`.sova/spec/claims/tools/spec.md`); MODE.md describes the code, not the requirement.

## Rules

- **Name the goal.** A change to the spec system (a tool, a rule, the mode text, a hook) names the goal it serves in
  `GOALS.md` and shows, measured against today's tools on the same inputs, that it moved that goal's measure and
  broke no other goal or constraint ("How to judge a change to the spec system"). The constraints are not traded:
  it works in any project, not just Sova; source code carries no `§` ids; it stays light.
- **The tools stay standalone.** Node standard library only; they import nothing from pi, Sova or the rest of
  pi-config. They are not a pi extension (no `index.ts`).
- **The mode text is two parts, each one copy.** `spec-mode.md` (finding your way, rides every turn) and
  `spec/WRITING.md` (the writing procedure, never in the prompt) are the only texts; everything else quotes or loads
  them. `minor.ts` reads `spec-mode.md` once at load and refuses to load (pi and Sova's server alike) unless it holds
  exactly one single-line `sh` block. The census hook reads `WRITING.md` from the installed tools at hand-over
  (`CensusHook.takeProcedure`). `mode/index.test.ts` pins both: every flag they spell is parsed by its command, the
  procedure's `--doc-only` cases are the draft tool's own, and each part's word count is capped. `subagents/spec-brief.ts`
  quotes rules from both by anchor, so moving a rule can break the worker brief, and `SPEC_WORKER_NOTE` must equal
  the procedure's Workers paragraph.
- **A change to the short part needs a measured run.** Since al_3 (round 3 of the context test), a change to
  `spec-mode.md` is measured with an arm on the context-test set and its numbers recorded in the CHANGELOG entry; a
  `WRITING.md` change needs its tests and a changelog entry.
- **The spec writer.** `mode-spec.json` (agent dir, `mode/spec.ts`, read by `server/spec-settings.ts`) is the spec
  mode's writer: one backend, model and effort plus an optional fallback, or `null` (the session writes the spec
  itself). It seeds and backs the subagent profiles' spec writer, syncs like the other mode files, and is re-read at
  each turn boundary by every session with spec on, in either major mode.
- **Never run the replay suite while working.** `tests/replay` is a landing gate the merge round runs, one at a time per
  machine, when a landing touches `spec/core/`, `spec/tests/replay/` or `mode/spec-guard.ts`. Without `SOVA_SPEC_REPLAY=1` every test in it skips.
- **What Sova imports.** `server/spec-drafts-state.ts` imports `core/official.mjs` (types in `official.d.mts`), the
  one rule for whether a draft is official, and through it `sova-spec.mjs`: both stay free of work at import. An
  edit to either can break Sova's typecheck and readiness: run `pnpm run typecheck` and `pnpm test` too.
- **One copy of the tools.** The spec tools exist only in `core/`, run through the installed extension (`$core`).
  No project, Sova included, keeps a copy; a copy found in a project is that project's code, never run without asking.

## While working

- Tool tests (about a minute):
  `cd pi-config/extensions/spec && node --test --test-concurrency=4 tests/*.test.mjs`.
- Mode tests: the `mode` line in `pi-config/README.md` "Tests" (`spec.test.ts`, `spec-guard.test.ts`,
  `tests/spec-turn.mjs`, `tests/spec-worker.mjs`, …).
- Search changes: the topic bench in `tests/search/` (its README; a held-out set is run once).
- Measuring a tool change: `tests/replay/run.mjs` against a baseline tree (`make-tree.mjs master …`), as its README
  shows. That is the measurement, not the gate.

## When you change it, also update

- **`CHANGELOG.md`: one entry per change**, written on the branch under its date, oldest first, with `Changed`,
  `§` (computed by `sova-spec.mjs foreign --base <first parent> --head <commit>`, `+` marking a § created) and any
  `Numbers` with the scorecard that measured them. Until it lands, the entry names the branch ("not on master yet");
  after landing, a follow-up commit fills in the master commit and its base, as c7fe3132 did for lanes D, E and B2.
- **`CHANGELOG.md` "UPGRADING another project"** when another project must act: new files to copy, a new merge
  driver line, changed output or exit codes, a mode-text change a project that points at `spec-mode.md` picks up.
- **`EVOLUTION.md`** when a milestone lands, a measured number moves, or an idea is tried and dropped (with its
  numbers and the commit that reverted it).
- **`GOALS.md`** only when a goal, constraint or rule itself changes (a decision, not a status).
- **`MODE.md`** when a piece of the mode moves, is added, or changes how the pieces connect.
- **When commands or output change:** `core/README.md`, `spec/README.md`, `DRAFTS.md` / `PROMOTE.md` (the draft
  tool), `.sova/spec/USAGE.md`, the site page `site/src/content/docs/modes/spec.md`, and the usage line
  (`tests/usage.test.mjs` pins it to the commands).
- **`spec-mode.md` or `spec/WRITING.md`:** `mode/index.test.ts`'s pins, the brief's anchors
  (`subagents/spec-brief.test.ts`), the review-smoke fixture (`mode/tests/fixtures/flag-off-master.json`, for
  `spec-mode.md`), the site page, and an UPGRADING step.
- Commit spec docs by explicit path, as `.sova/spec/README.md` shows; drafts and reviews stay local.
