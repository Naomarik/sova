# Replay: the spec tools measured on fixed scenarios

A yardstick for changes to the spec tools and hooks (`spec/core`, `mode/spec-guard.ts`,
`claude-code/spec-hooks.ts`). It runs the same scenarios with the same inputs against two tool trees,
a **baseline** and a **candidate**, and reports each row's value and guards side by side.

```sh
node make-tree.mjs master /tmp/replay/base          # prints /tmp/replay/base/pi-config/extensions
node run.mjs --baseline /tmp/replay/base/pi-config/extensions --candidate ../../.. [--out DIR] [--only a,c]
node --test replay.test.mjs                         # the harness's own checks (about a minute)
```

A tree is a copy of `pi-config/extensions` holding `spec/`, `mode/` and `claude-code/`. `make-tree.mjs`
extracts one from a ref with `git archive` and records the commit in `replay-source.json`, which the
scorecard carries. `run.mjs` writes `scorecard-baseline.json`, `scorecard-candidate.json` and `diff.json`
(per row: both values, both guard results, `changed`), and prints a one-screen summary (`*` marks a
changed row, `[✓✗]` the candidate's guards). Exit 0: every guard held in both arms; 1: a guard failed;
2: usage, or a scenario crashed.

## Rows and guards

A row is a measurement; a fix moves it. A guard is what a fix must not break; it is evaluated in both
arms, and is chosen so that the cheap way to improve the row (refuse less by merging blindly, say less by
saying nothing) fails it.

| Scenario | Rows | Guards |
| --- | --- | --- |
| a. merging drafts | two drafts from one base editing different H2s of one claim file: how many need a hand re-apply; the same H2: the second's outcome; a stacked chain (integration → task → master) and its absorbed variant: § listed at the mid merge and listed again at master (`judgeOp`) | the same-H2 conflict still stops; no prose is lost; the master landing still lists every foreign § |
| b. evidence | commit → evidence → a merge changing unrelated lines of the claimed file / a rebase / a real edit: each promote's refusal and reason kinds | the real edit goes stale |
| c. hook noise | one scripted session (edits, read-only commands, `cd` outside the repo and to `$S/$p`, a second relative `cd`, a heredoc body that mentions `cd`, a no-op repeat) through the pi hooks (`CensusHook`, `SpecWriteGuard`, as `mode/index.ts` composes them) and the Claude hooks (`runHook`): notes, notes per call, information-free notes by kind (assessment unavailable; Git view unavailable outside the repo, or for a path under it the shell never was at; a census repeating lines already said) | planted drift (code changed, claim not) and a new unclaimed file in the boundary are each still flagged |
| d. invocation shapes | `packet --budget 1024` on a labelled claim, a budget below range, `census` with a stray argument, `promote` without a selection, `--spec` at a draft dir: outcome codes, usable count | every passage a packet returns equals its source span byte for byte |
| e. draft leftovers | drafts fully promoted, superseded by a `-2` copy, and live: what `status`, `check`, `census` and `foreign --landing` say of each | the fixture set up as intended |

## Determinism

Scratch repos live under a temp dir; every commit has a fixed author and a date from a per-repo counter,
so commit ids repeat across runs. Child processes get only `PATH`, a scratch `HOME` and `GIT_CONFIG_NOSYSTEM`.
The runner imports `claude-code/tests/hermetic-env.mjs` first, so the in-process hooks see a throwaway
home. Shell effects in scenario c are applied by the harness, not run. Values carry no temp paths.
Hook timing (`Date.now()`, file mtimes) is used only for ordering within a run, never in a value.
