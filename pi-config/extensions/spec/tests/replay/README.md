# Replay: the spec tools measured on fixed scenarios

A yardstick for changes to the spec tools and hooks (`spec/core`, `mode/spec-guard.ts`,
`claude-code/spec-hooks.ts`). It runs the same scenarios with the same inputs against two tool trees,
a **baseline** and a **candidate**, and reports each row's value and guards side by side.

```sh
node make-tree.mjs master /tmp/replay/base          # prints /tmp/replay/base/pi-config/extensions
node run.mjs --baseline /tmp/replay/base/pi-config/extensions --candidate ../../.. [--out DIR] [--only a,c]
SOVA_SPEC_REPLAY=1 node --test replay.test.mjs     # the harness's own checks (about two minutes)
```

`replay.test.mjs` is a landing gate: the merge round runs it (under `scripts/nice.mjs`, one replay at
a time on the machine) when a landing touches `spec/core`, `mode/spec-guard.ts`, `claude-code/spec-hooks.ts`
or `tests/replay/`. Without `SOVA_SPEC_REPLAY=1` every test in it is skipped, and `pi-config/README.md`'s
Tests line leaves `tests/replay` out: never run it while working.

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
| f. slice quality (synthetic) | a small spec with planted items around the seed `§f.seed/edit`: a true dependency and its own dependency, an embedded H1 with 3 H2s, a contrast-only edge to a 40 KB H1, an unlinked sibling that answers a need, a `core: true` claim, an `about` note, a note about the true dependency (`f.target.about-closure`: D40 rule A carries notes about every claim the packet delivers), a note about the unrelated consumer, a true and an unrelated uninvestigated consumer. `packet`: bytes, passages, files, calls, precision (share of bytes a builder of the seed needs), wander bytes, names-only, unknown, frame bytes; `impact`: consumers, frontier, whether the unrelated consumer is on it. Under pull (`toc`, `read`): lines per direction, written whys, bytes | dependencies read whole; the contrast target read or named; spans byte-exact; frame ≤ 12,000 B; the note about a claim outside the closure never read (`f.about-outside-closure`); the true consumer kept by `impact`. Under pull: each planted link is a line in its direction, every such line has a what and a why, the unrelated consumer shows only under `--dir in`, `read` returns the seed's exact span and names every link it did not deliver |
| g. fullness (real spec) | the 24 needs comparisons (`data/comparisons.json`) over `.sova/spec` pinned to one revision. `packet` (every prose page, plus a `frame` stream if the tree has one), per comparison: needs answered (partial = 0.5), named, bytes, seed-file share, frame bytes, calls, passages, files, unknown; totals with medians, ground rules reached (x/24), matching copy-deck sections reached (x/17); `impact §chat/composer`. Pull proxy (needs `toc`): needs whose passage is a `toc` line one hop from the seed (any direction), toc bytes and calls, needs packet answers that no line shows, and contents-line quality for the composer and sandbox families (`--dir out` lines with a why from prose or from an HTML comment, all lines and `requires` lines apart) | every delivered passage byte-exact; every `toc` call answers; no need answered at the recorded baseline (`data/g-baseline.json`) lost unless its passage is named; the total never drops; frame ≤ 12,000 B |
| h. agreed, not built | a draft adds a behavior with `agreed: {by, at}` and no code, records `--doc-only` evidence and promotes (target: promoted, 0 → 1); a second does the same for a behavior that maps code | nothing that lands on doc-only evidence reads as built (no code, no reviewed/verified label); doc-only never covers a record that maps code |

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

**Measuring a spec change (M6).** A verdict's location is kept as an anchor too (`verdict.anchor`: its
passage id and the quoted line; `verdict.anchors` lists several, any one holds), found again wherever the
line moves; a verdict whose line is gone is `unanchored` (guard `g.packet.anchored`, listed for a new hand
verdict, never re-scored by the probe), and `--record` refuses a spec where any verdict is unanchored (a
re-verdict adds the new spec's line to `anchors` and keeps the old one, so both arms place it).
`g.packet.passage-changed` lists needs whose answer now lives in another passage than at the recorded
baseline. Those still answered are counted apart (`g.packet.total.viaChangedPassage`, and in the
`total-never-drops` detail), and guard `g.packet.moved-confirmed` fails until each is hand-checked and an
anchored verdict in its new passage confirms it. `g.packet.passage-changed` sees only an answer whose
passage id moved; `g.packet.answer-text-changed` lists answers that stayed in a passage whose text
changed (the record holds a hash of each answering passage, `textOf`), marked "(anchored)" or
"(probe only)": a probe-only one may hit a line that no longer carries the fact, so it is the hand check.
Guard `g.packet.about-bytes` (plan §5c, M5 `about`, plan.md:391): per comparison, packet bytes without the
frame minus the recorded arm's (`comparisons.<id>.bytes`); the MEDIAN of those increases stays ≤ 12,000 B. A
per-comparison cap would be wrong: one seed may fairly gain more. Row `g.packet.about-bytes-delta` reports the
median, the largest increase in bytes (`max`, `maxAt`) and as a ratio of the recorded packet (`maxRatio`,
`maxRatioAt`), how many exceed +12,000 B (`overSlack`, `which`) and how many grow more than 50% (`overHalf`):
informational, so a change whose median is small but whose tail is large (rejected rule B: a settings tab
2.7 → 31 KB) still shows. A comparison with no recorded bytes is named in the refusal.
Guard `g.packet.about-growth` (reviewer-4, reviews/about-growth-guard.md): no comparison's packet, frame
excluded, grows by more than 100% of its recorded size when the increase is also over 4,000 B (the floor keeps a
707 B packet that gains its own copy section from tripping). The median can be won by bloating fewer than half
the comparisons; this guard sees one small packet swamped by notes it never asked for. Rule A holds it (largest
×1.30, C09); rejected rule B trips it (C21 +466%, C18 +131%). `max`, `overSlack` and `overHalf` stay information:
the two byte figures don't tell A from B (A +31,358 and 8 over 12 KB, B +31,358 and 9), and `overHalf` does (A 0, B 2)
but its 50% line is too tight for legitimate copy-deck work; the ratio guard above does that job. Rows `g.pull.dirs` (lines and bytes per toc direction over the 24 seeds, and the notes about its H2s an H1's `down`
lists) and `g.pull.down-sweep` (`toc --dir down` over every H1: lines, bytes, notes about H2s, H1s with any): a
change that adds lines shows as lines in its direction; bytes moving in another direction with the same lines are its
footer counting them (D49 R1: counts, not new lines).
Target `g.target.copy-deck-needs` (decision D49): the copy-deck needs, C07:3, C10:2, C21:2 and C24:3 by name plus any
need whose recorded passage is a copy-deck section (C23:4), each answered by packet and shown one hop out by pull
(a toc line or the frame); counts per arm, `both`, and any need packet answered at the record and lost now (`packetLost`). There is no pull-lost: the record keeps the pull arm only
as a total (`pull.shown`), not per need, so a need pull stopped showing is seen only through `g.pull.shown-floor`. It
replaced "≥ 14/17 sections" (not met: 8/17), because a section count can be met by listing names without
answering any need; the 17-section count stays as information (`g.packet.total.copyDeck`, `g.pull.copy-deck`).
**Caveat:** g caught B only because C21 and C18 are among its 24 seeds; B's worst
cases over all 861 claims (settings-dialog tabs ×11, open-questions ×19) are outside them. A rule that changes what
a packet is made of still needs an inventory diff over every claim (`packet --part inventory`, base tools against
candidate tools); the g guards are the cheap tripwire, not the proof. A recording without bytes
per comparison fails the guard (re-record). To measure a draft against the spec it drafts from:

```sh
node scenario-g.mjs --record <tree> --pinned <spec dir> --spec "<label>" --out data/g-baseline-<rev>.json   # once, on the base spec
node run.mjs --baseline <tree> --candidate <tree> --only g --baseline-pinned <base spec dir> --candidate-pinned <draft spec dir> \
  --g-baseline data/g-baseline-<rev>.json [--what-verdicts <file>]
node scenario-g.mjs --what-sheet <tree> --pinned <draft spec dir> > sheet.json   # the lines a reviewer grades
```

`data/g-baseline-b1de66b1.json` is integration b1de66b1's spec (master merged), recorded with its tools (93.5/138, pull
shown 106/138); a recording with toc also holds the pull floor (`pull.shown`), which `g.pull.shown-floor`
uses with `--g-baseline`. A given spec dir is copied into the workspace with the pinned `where` sources
beside it. New rows: `g.pull.frame-answered` (needs shown only because the seed's first `read` page
carries their passage in its frame; the frame counts as shown), `g.read.frame-bytes` (`read --frame`; the first read's frame bytes also sit beside each comparison's toc bytes, `g.pull.C*.frameBytes` and `bytesWithFrame*` in `g.pull.total`,
guard `g.read.frame-cap` ≤ 12,000 B), `g.target.what-right.<family>` (pct = right over ALL the family's lines; a reviewer's verdicts
`{verdicts: {id: {what, right, note}}}`, default `data/what-verdicts.json`: right/graded, and verdicts
on a what no longer shown counted stale), `g.pull.copy-deck` (copy-deck sections matching each seed's surface, the 17 that `g.packet.total.copyDeck` counts: shown as a toc line, delivered by the seed's first read, and which; M6's `about` on copy-deck notes moves both).

## Milestone gates measured here

| Milestone | Gate (against the pinned baseline tree) |
| --- | --- |
| M0 | the baseline tree against itself: zero diff, every guard held; a sabotaged tree trips every guard |
| M1 (`toc`, `read`) | computed run, no agent: `packet` and `scope` unchanged (g's packet rows, d's exactness), f's pull guards hold; g's pull proxy rows give bytes and calls per comparison; the 21 needs packet answers but no `toc` line shows one hop out are listed by id |
| M1 onward | ratchet guard `g.pull.shown-floor`: needs shown one hop out never below 106/138 (M1's gate run at c67a1ae2) |
| M1 onward | guards `g.pull.what-whole` and `f.pull.what-whole`: every contents-line what is a whole sentence of its passage or ends in "…" (`cutWhat` in fullness.mjs checks it against the source, not the tool's splitter). Over the pinned spec, `toc <H1> --dir down` for every H1; f plants a first sentence that wraps (§f.dep/rule) and one with a colon inside parentheses (§f.other/uses-edit). Punctuation inside an open ( or [ ends no sentence; an empty what fails. Integration 70d6696e cuts 413 of 800 at the end of the first source line; b1843900 cuts 21 of 797 inside parentheses |
| M2 (spec-mode text) | agent arm, all 24 comparisons, same model and level in both arms, on the M1+M5 tree. Answered ≥ the AGENT packet arm on the same 24 (on the 8-sample: 30.5/48), not the computed packet (34/48 on the sample, 93.5/138 in all), because an agent stops paging early. Every M2 scorecard reports both packet numbers. No need the agent packet arm answered is lost unless its passage was seen in a toc line or footer; calls per comparison within today's 7–18; the needs packet answers but toc does not show one hop out (3 at M1) checked one by one |
| M4 (span promotion) | a.diff-h2.hand-reapply 1 → 0; `a.target.same-spot` both orders land, byte-identical; a's guards hold |
| M3 (`map`, `where`, `impact --near`) | f: `impact §f/seed --near` keeps the true consumer and keeps the unrelated one off its frontier (guards); g: `g.target.impact-near.chat-composer` frontier 143 → ≤ 25, `g.where.all` lists every claim whose code names server/chat-manager.ts (guard, 74), `g.target.where-ranked` for shared/protocol.ts (107, top 10); `g.digest.scope` and `g.digest.impact` (plain impact) unchanged |
| M8 (`agreed`, draft tool) | `h.target.agreed-promoted` 0 → 1; guards `h.unbuilt-not-built`, `h.doc-only-refuses-code` hold; `a.stacked.relisted-at-master` stays a target (needs the own-rule change) |
| M6 (field records) | g on the draft spec against `data/g-baseline-<integration rev>.json` (above): shown ≥ 109 with `g.pull.frame-answered`, `g.read.frame-bytes` ≤ 12,000, copy-deck needs (D49) each answered by packet and shown by pull, 5/5 per arm (`g.target.copy-deck-needs`; the 17-section count, `g.packet.total.copyDeck` and `g.pull.copy-deck`, is information: its old "0/17 → ≥ 14/17" target was not met, 8/17, and was replaced), `g.target.what-right.*` ≥ 90%; `h.target.field-only-doc-only` 0 → 1 (a field-only embeds/about/core change on a built behavior lands on doc-only evidence) while guard `h.field-bundle-refused` holds (the same change bundled with prose, a code list or a label is refused) |
| M5, M6 | the f/g target rows they claim (embed read whole, core arrives unasked, about note travels; answered-or-named), and which of the 21 come into view |

## The agent arm (opt-in, not deterministic)

`agent-arm.mjs` measures how a builder actually reads: headless pi agents read the pinned spec through
one tool tree, and the harness grades what came back to them. It is never part of `node --test` or of
`run.mjs`'s exit code.

```sh
node agent-arm.mjs run --tree <extensions dir> --arm packet|pull --model zai/glm-5.3:medium --out <dir> \
  [--comparisons sample|all|C01,C05] [--concurrency N] [--timeout-min 20] [--work <dir>] [--extension <dir>]… [--dry-run]
node agent-arm.mjs grade --out <run dir>     # grade a finished run again; starts no agent
```

- **Models:** only `zai/glm-5.3`, `-flash` or `-highspeed` (any thinking level) and
  `ollama-cloud/deepseek-v4.1-flash` (low or medium). At most 2 runs at once on zai, 3 on ollama-cloud.
  Compare arms only at one model and level: the model alone moves tokens about 2.7×.
- **What the agent sees:** a work directory (default under the OS temp dir, outside any repository)
  holding only the pinned manifest and claims and `tools/`, the tree's `spec/core`. pi runs with
  `-p --mode json --tools bash,read`, no discovered extensions, context files, skills or prompt
  templates, and `-e` for provider-limits and llm-inflight from the pi agent directory (one must be
  provider-limits), and `--append-system-prompt` with the tree's own `mode/spec-mode.md` (the text that
  ships with that tree; only its trusted-core line is pointed at `tools/`, and the docs it names are copied
  beside it; its sha is in `run.json`; `--instructions <file>` or `--no-instructions` for experiments; two
  runs compare only if both had instructions). The task prompt is the same in every arm (`PROMPT_VERSION`
  neutral-1; compare refuses two versions): it names the surface and its § id, says what a builder must find,
  points at `node tools/sova-spec.mjs <command> … --root .`, names no command or reading strategy, and asks
  for a brief. How the agent reads comes only from the tree's mode text, so an M2 number measures that text.
- **Not measured:** "every `census --changed` claim read". The agent edits nothing, in a directory outside any
  repository, where `census --changed` refuses (`exit 2`, `census: null`), so the guard would hold for an agent
  that read nothing. `compare` lists it under `notMeasured`.
- **Output:** `<out>/<arm>-<model>-<time>/` with `run.json`, and per comparison `prompt.txt`,
  `events.jsonl`, `stderr.txt`, `exit.json` and `sessions/`; then `agent-scorecard.json` and
  `summary.txt`.
- **Grading:** a passage counts as read when its exact text came back (packet or read items, fragments
  joined, or verbatim output of a file read); a claims file read by line range counts those lines.
  Needs score as in g. Rows per comparison: needs answered, named, bytes received, tool calls, passages
  read, contents lines seen, tokens, commands that reach outside the work directory. The guard,
  reported: no need the recorded packet baseline answers is lost unless the agent saw its passage in a
  toc line or a footer.
- **Rules and worked examples:** [GRADING.md](GRADING.md), including the two hand-reading jobs a reviewer may do.
- **The 8-comparison sample:** C01, C05, C07, C10, C14, C17, C19, C22 (`SAMPLE` in the script).

## The rubric arm (opt-in, not deterministic, graded blind)

`rubric-arm.mjs` re-runs the 15-task rubric (`data/rubric.json`: wording, seeds, a–d) fresh in two arms and has it
graded blind. For the final comparison: baseline arm = a95768b7's tools and spec-mode text, candidate = the final
head's; same subject model (glm-5.3:medium) and the same task words. It never runs under `node --test`; only its
blinding is tested (`replay.test.mjs`, "rubric arm").

```sh
node rubric-arm.mjs run --tree <base tree>  --arm baseline  --model zai/glm-5.3:medium --out <dir>               # a95768b7 spec
node rubric-arm.mjs run --tree <final tree> --arm candidate --model zai/glm-5.3:medium --out <dir> \
  --pinned <final spec dir> --spec-label "final <rev>"                                                      # (a) primary
node rubric-arm.mjs blind --a <baseline run dir> --b <candidate run dir> --out <blind dir> [--accept-tells]
#   hand <blind dir>/grader/ (and nothing else) to the grader; it replies with scores.json
node rubric-arm.mjs check --blind <blind dir>
node rubric-arm.mjs unblind --blind <blind dir> --scores scores.json --out card.json
```

- **run**: one headless pi per task, as the agent arm (allowed models, provider caps, provider-limits loaded, a work
  directory with only the spec and `tools/`; its path names no arm). It refuses a work directory inside a git work
  tree (a TMPDIR inside a worktree would put the source and the live spec in reach: give `--work` outside any
  repository). The prompt is the task's wording and seeds plus a generic line on the spec tools, identical in both
  arms; how to read comes only from the tree's own spec-mode text. Each task records its final brief, (e) bytes,
  (g) calls and its routes (outside, directSpec, scratch, classed as in the agent arm). `--pinned <dir>` gives an arm
  another spec, named by `--spec-label`; every report names the spec each arm read.
- **blind**: refuses runs with another model, another task set or any task's `prompt.txt` differing by a byte. Per
  task, only each run's final brief, scrubbed: commands, tool names (toc, packet, frontier, inventory, census,
  sova-spec, contents lines), arm phrases ("pull arm"), flags and revision ids (hex with a digit and a letter) become
  […]. A bare product word ("footer", "baseline", "pull") stays: the agent is never told its arm. A list only holds what
  someone thought of, so the **differential check** stands behind it: every token (word, word pair, size figure) in at
  least 3 tasks of one arm's scrubbed briefs and none of the other's goes to `tells.json`, and blind hands out nothing
  until a person scrubs each tell or rules it content (`--accept-tells`, recorded in key.json). The X/Y draw uses a
  random seed unless `--seed` is given, recorded only in key.json. `grader/` holds the rubric (a–d), the tasks and the
  briefs; key.json (X/Y, bytes, calls, routes, redactions per arm, run ids, specs) and tells.json stay beside it.
- **check**: the listed patterns, and the differential check again over the briefs as handed out, with only accepted
  tells allowed; it prints how many patterns it checked and how many tells were accepted.
- **unblind**: a–d, sum /120, (e), (g), routes and redactions per arm, per task and in total. The study's 63/120
  (`data/rubric.json` `baseline`) is reported for reference only: its subject model is unknown.
- The grader is a separate Claude reader given only `grader/`; whoever runs the arms never grades. Two blind folders
  that share an arm's briefs go to two fresh grader sessions.

## Determinism

Scratch repos live under a temp dir; every commit has a fixed author and a date from a per-repo counter,
so commit ids repeat across runs. Child processes get only `PATH`, a scratch `HOME` and `TMPDIR`, and
`GIT_CONFIG_NOSYSTEM`. g reads a `git archive` of its pinned revision (`--pinned DIR` supplies one
instead), so every arm reads identical bytes whatever the checkout; its read-only calls run several at
a time, and results are collected by comparison, never by finishing order.
The runner imports `claude-code/tests/hermetic-env.mjs` first, so the in-process hooks see a throwaway
home. Shell effects in scenario c are applied by the harness, not run. Values carry no temp paths.
Hook timing (`Date.now()`, file mtimes) is used only for ordering within a run, never in a value.
The hooks bound each git and census call by a 5 s timeout and add an "incomplete check" note when one runs
out, so a loaded machine can add a note the tree didn't cause (seen once: `c.claude.notes` 7 for 6). c
therefore runs each hook's session in fresh repos until two runs give the same notes (paths aside), at most
5, and fails the scenario if none repeat. With the timeout cut to 150 ms, 1 run in 6 differed before and 0 in 18 after.
