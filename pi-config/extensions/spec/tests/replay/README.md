# Replay: the spec tools measured on fixed scenarios

A yardstick for changes to the spec tools and hooks (`spec/core`, `mode/spec-guard.ts`,
`claude-code/spec-hooks.ts`). It runs the same scenarios with the same inputs against two tool trees,
a **baseline** and a **candidate**, and reports each row's value and guards side by side.

```sh
node make-tree.mjs master /tmp/replay/base          # prints /tmp/replay/base/pi-config/extensions
node run.mjs --baseline /tmp/replay/base/pi-config/extensions --candidate ../../.. [--out DIR] [--only a,c]
node --test replay.test.mjs                         # the harness's own checks (about two minutes)
```

A tree is a copy of `pi-config/extensions` holding `spec/`, `mode/` and `claude-code/`. `make-tree.mjs`
extracts one from a ref with `git archive` and records the commit in `replay-source.json`, which the
scorecard carries. `run.mjs` writes `scorecard-baseline.json`, `scorecard-candidate.json`, `diff.json`
(per row: both values, both guard results, `changed`), `summary.txt` (the one-screen summary it also
prints: `*` marks a changed row, `[✓✗–]` the candidate's guards, then the target rows, baseline →
candidate) and `run.json` (both trees, the harness commit, the command, the date). Exit 0: every guard
held in both arms; 1: a guard failed; 2: usage, or a scenario crashed (a promote that fails `internal`
is a crash, never a pass).

## Rows and guards

A row is a measurement; a fix moves it. A guard is what a fix must not break; it is evaluated in both
arms, and is chosen so that the cheap way to improve the row (refuse less by merging blindly, say less by
saying nothing) fails it.

| Scenario | Rows | Guards |
| --- | --- | --- |
| a. merging drafts | two drafts from one base editing different H2s of one claim file: how many need a hand re-apply; the same H2: the second's outcome; a stacked chain (integration → task → master) and its absorbed variant: § listed at the mid merge and listed again at master (`judgeOp`); target: two drafts each add a new H2 at the same spot, landed in both orders (outcomes, byte-identical result, H2 order); the manifest merge driver (`.gitattributes` → `merge-manifest`, configured repo-locally to the tree under test): two branches each promoting a record, with and without the driver, and two changing the same record | the same-H2 conflict still stops; no prose is lost; the master landing still lists every foreign §; the same new id added differently still stops; with the driver, two new records merge with both present; the same record changed on both sides still stops |
| b. evidence | commit → evidence → a merge changing unrelated lines of the claimed file / a rebase / a real edit: each promote's refusal and reason kinds | the real edit goes stale |
| c. hook noise | one scripted session (edits, read-only commands, `cd` outside the repo and to `$S/$p`, a second relative `cd`, a heredoc body that mentions `cd`, a no-op repeat) through the pi hooks (`CensusHook`, `SpecWriteGuard`, as `mode/index.ts` composes them) and the Claude hooks (`runHook`): notes, notes per call, information-free notes by kind (assessment unavailable; Git view unavailable outside the repo, or for a path under it the shell never was at; a census repeating lines already said) | planted drift (code changed, claim not) and a new unclaimed file in the boundary are each still flagged |
| d. invocation shapes | `packet --budget 1024` on a labelled claim, a budget below range, `census` with a stray argument, `promote` without a selection, `--spec` at a draft dir: outcome codes, usable count | every passage a packet returns equals its source span byte for byte |
| e. draft leftovers | drafts fully promoted, superseded by a `-2` copy, and live: what `status`, `check`, `census` and `foreign --landing` say of each | the fixture set up as intended |
| f. slice quality (synthetic) | a small spec with planted items around the seed `§f.seed/edit`: a true dependency and its own dependency, an embedded H1 with 3 H2s, a contrast-only edge to a 40 KB H1, an unlinked sibling that answers a need, a `core: true` claim, an `about` note, a true and an unrelated uninvestigated consumer. `packet`: bytes, passages, files, calls, precision (share of bytes a builder of the seed needs), wander bytes, names-only, unknown, frame bytes; `impact`: consumers, frontier, whether the unrelated consumer is on it. Under pull (`toc`, `read`): lines per direction, written whys, bytes | dependencies read whole; the contrast target read or named; spans byte-exact; frame ≤ 12,000 B; the true consumer kept by `impact`. Under pull: each planted link is a line in its direction, every such line has a what and a why, the unrelated consumer shows only under `--dir in`, `read` returns the seed's exact span and names every link it did not deliver |
| g. fullness (real spec) | the 24 needs comparisons (`data/comparisons.json`) over `.sova/spec` pinned to one revision. `packet` (every prose page, plus a `frame` stream if the tree has one), per comparison: needs answered (partial = 0.5), named, bytes, seed-file share, frame bytes, calls, passages, files, unknown; totals with medians, ground rules reached (x/24), matching copy-deck sections reached (x/17); `impact §chat/composer`. Pull proxy (needs `toc`): needs whose passage is a `toc` line one hop from the seed (any direction), toc bytes and calls, needs packet answers that no line shows, and contents-line quality for the composer and sandbox families (`--dir out` lines with a why from prose or from an HTML comment, all lines and `requires` lines apart) | every delivered passage byte-exact; every `toc` call answers; no need answered at the recorded baseline (`data/g-baseline.json`) lost unless its passage is named; the total never drops; frame ≤ 12,000 B |

**Targets.** Some of the plan's checks fail on today's tools by design (the sibling read or named, the
`about` note read, the core claim and the embedded H1 arriving unasked, every need answered or named).
They are rows named `*.target.*`, not guards, because a guard is what a candidate must not break. A
guard that checks something a tree doesn't have is `n/a` (`–` in the summary): never a pass, never a
failure. "Doesn't have" is probed, not guessed: `sova-spec.mjs toc` (or `read`) with no arguments
answers `unknown command toc`. A tree that has the command and crashes, refuses or answers malformed
JSON fails the guard.

The self-test (`replay.test.mjs`) runs the pull checks through `toc-stub.mjs`, a stand-in routed into a
scratch copy of the tree, and trips every guard with a sabotaged copy: a draft that always wins, a
quiet census, evidence that never stales, packets that trim or stop following `requires`, a frame
stream that grows, an `impact` that drops the uninvestigated, a merge driver that keeps ours or
refuses everything, and a contents view that hides out-links, says nothing, or misreads.

**g's data.** `data/comparisons.json` holds each comparison's seed, its needs (a category, the wording,
a probe regex, and a hand verdict where a reader corrected the probe: status, location, note), and the
pinned revision. A need scores against the arm's delivered passages: a verdict's location must fall in
one; otherwise the probe must match there (a sentence wrapped onto the next line counts). Six verdicts
took their location from their own note ("… (chat/changes.md:4)"), marked `atFrom: "note"`.
`data/g-baseline.json` is the packet arm of the pinned revision's tools, per need; regenerate it only on
purpose: `node scenario-g.mjs --record <tree made from the baseline ref>`. `data/rubric.json` holds the
15-task rubric (wording, seeds, a–d scores) for the agent arm.

## Determinism

Scratch repos live under a temp dir; every commit has a fixed author and a date from a per-repo counter,
so commit ids repeat across runs. Child processes get only `PATH`, a scratch `HOME` and `TMPDIR`, and
`GIT_CONFIG_NOSYSTEM`. g reads a `git archive` of its pinned revision (`--pinned DIR` supplies one
instead), so every arm reads identical bytes whatever the checkout; its read-only calls run several at
a time, and results are collected by comparison, never by finishing order.
The runner imports `claude-code/tests/hermetic-env.mjs` first, so the in-process hooks see a throwaway
home. Shell effects in scenario c are applied by the harness, not run. Values carry no temp paths.
Hook timing (`Date.now()`, file mtimes) is used only for ordering within a run, never in a value.
