# Repair proposal (kimi-k3): disclose the boundary, don't widen the net

**Status: proposal only.** No tooling, no packet edits, no experiment was run; the next step below needs explicit authorization. Facts were checked against the frozen tree `/tmp/sova-spec-pilot-c4d7993` and the pilot artifacts under `.sova/spec/`. One session per task/arm (`results/metrics/summary.md`): everything causal below is a hypothesis with direction, not a measured benefit. The settled requirements stand: portable `.sova/spec`, foldaidev `§` identifiers, no source annotations, incremental authority transfer, deterministic closure rendered as actual prose.

## 1. What the pilot established, stated as evidence

- Scores incumbent/scope: 76/81, 91/74, 95/93 (`results/judge/stage-one.md`). One win each way and one near-tie. Neither arm achieved zero critical misses.
- Packets were supplied verbatim: 9,504 / 4,921 / 4,523 bytes (`results/metrics/summary.md`). Total returned tool text mixes supplied, prose, and source bytes; no prose-only measurement exists.
- Named unknowns were acted on; unnamed ones were not. The Task 2 packet named the transcript row cap as a blind spot, and the scope planner investigated it (synthesis §2). The Task 1 packet never named `spec/04-composer.md` → **Disabled states** (frozen `:125-142`) or **Accessibility**, and the scope plan missed blocked-vs-read-only — though the query's own prose says "Send is possible when the composer is not disabled."
- The two −10 assumptions in T2-X were **reasoning errors over material the planner had in hand**: the 11-path transcript fixture does not "silently pass" (`transcript.test.ts:143-147` asserts length equals `MAX_ATTACHMENTS_PER_ROW`), and the "strip height" formula is about horizontal control widths (`spec/04b-images.md:301-305`). No packet content caused these, and no graph edge would have prevented them.
- The candidate-beside-incumbent authority protocol behaved inconsistently: T1-Y did not report the placeholder conflict the packet itself flags (its frontier points to `pilot/findings.md`, F1 — unreadable in the isolated worktree, per `comparison/README.md`); T2-X called an explicitly disclosed coverage gap a "disagreement."
- The tiny Task 3 received a 4,523-byte packet, and the scope arm returned 49% more bytes on a task both arms answered correctly. The packet's frontier bait (refused-retry → `Send to the Rest` targeting) was partly credited by the judge — the cost was distraction and word-limit failure, not error.
- Five of six plans exceeded 900 words; two incumbent greps traversed the prohibited brainstorm directory before filtering output lines (T1-X call 2, T3-X call 2; commands verbatim in `summary.md`).

## 2. Cause separation

| Cause class | Evidence it contributed | Evidence it did not |
|---|---|---|
| **Content gaps** (undistilled seams) | Task 1: Disabled-states/accessibility/focus never entered claims *or* disclosure; scope plan missed blocked-vs-read-only. Task 2: no test file in the code map | Incumbent with full spec access also missed critical seams; gaps are not packet-exclusive |
| **Coverage disclosure** | "No budget was applied, so nothing in the closure is unread" asserts completeness about the *graph*, which a reader naturally hears as completeness about the *task*; undistilled material was invisible rather than named | The frontier mechanism itself worked where used |
| **Root/intent selection** | All three closures were mechanically correct (verified against renders, report.md §4) | Roots were arguably right; Task 3's cost was frontier composition, not a wrong root |
| **Planner reasoning/compliance** | The two T2-X misreadings; 5/6 word-limit failures; output-side-only grep filtering | Not repairable by packet format; must be *measured* as false assertions, not assumed away |
| **Authority protocol** | Unreported flagged conflict; gap-vs-disagreement misclassification; candidate status plausibly drove revalidation reads (T3-Y read `spec/14` broadly despite the packet) | Causality unmeasured; the forever-candidate pilot state may inflate scope-arm reading |
| **Measurement** | Returned bytes conflate supplied/retrieved, prose/source; `kinds` classifies commands, not bytes; prep/review/storage costs unmeasured | — |

## 3. Proposed repairs (smallest generalizable forms)

**R1 — Named undeclared-incumbent boundary (the keystone).** Every packet gains a section listing headings in cited incumbent files that the closure does *not* distill, in two buckets: *uncited* (no claim in this closure cites any line) and *partially cited* (some lines cited, others not). This is computable today from data the manifest already holds — every `incumbent` entry records `{file, heading, lines}` (`manifest.json`) — plus a heading list per cited file. It generalizes to any incumbent documentation; for a no-spec project the section is one line ("no incumbent documentation").

Before: "No budget was applied, so nothing in the closure is unread." + a frontier that names some omissions and never mentions **Disabled states**.
After: "Declared coverage: 10 passages. Incumbent files cited above carry headings no claim distills — `spec/04-composer.md`: **Anatomy**, **Disabled states**, **Accessibility** (uncited); **Behavior** (partially cited). Those keep full incumbent authority; read them when the task touches them."

Predicted effect, untested: the Task-1 missed seams become *named choices* (investigate or defer), not invisible absences. Hand cost estimate: 10–20 minutes per packet for 3–5 cited files (labelled estimate; the future tool recomputes it). Risk: heading granularity is coarse — mitigated by the two-bucket rule. **Demand trigger:** a critical miss traced to an undeclared heading is the signal to distill it into claims. This *is* the settled demand-driven reconciliation, now with a detection instrument.

**R2 — Self-contained warnings; define "disagreement."** No packet may reference a file outside the reader's authorized tree (the worktree has no `.sova/`). Each conflict states both sides inline with evidence paths inside `spec/`/source.
Before: "Placeholder copy … disagrees with the code (see `pilot/findings.md`, F1)."
After: "Conflict, undecided: `spec/04-composer.md:73-78` and `spec/09-copy-deck.md:110-111` say 'Ask pi to…—Enter sends…'; frozen `src/components/Composer.tsx:212-215` builds the placeholder without 'Ask pi to…'. Which side is intended has no owner decision."
Preamble adds one line: "A *disagreement* is packet prose contradicting `spec/`. A named frontier item is a known unknown, not a disagreement. A heading under R1 is undisputed authority outside this packet." Cost: minutes per warning; zero schema change.

**R3 — Frontier activation conditions (task-sensitivity without knobs).** Each frontier item ends with when it matters.
Before (Task 3): "After a refused retry, the refusal offer's `Send to the Rest` … sends the box's current text. No owner decision."
After: same fact, plus: "Relevant only if the change alters the refusal offer or its targeting; a retry-label-only change must leave it exactly alone."
This converts passive bait into a conditional the planner can skip with a reason. It is a writing rule, not a query option: the closure stays deterministic and complete (settled), and no task-class config appears. Rejected alternative: per-query budgets or "minimal packet" modes — a framework knob that duplicates the lever that already exists (root choice) and invites benchmark tuning.

**R4 — Reverse impact bounded to the declared graph.** Replace conditional guarantees with scoped query answers.
Before: "If the payload stays a plain string, no group claim is reached."
After: "No declared consumer in this graph depends on the string's structure. This answers the graph only: a behavior in a mapped file that no claim names is invisible here, and an unchanged payload is a human review finding, not a computed guarantee."

**R5 — Tests as evidence locations.** Each closure's code map adds a `Checks:` list of test files referencing the mapped seams — names only, no content annotations.
Before: `- server/drafts.ts: §chat.composer/attachments, §chat.composer/drafts`
After: additionally `- Checks: server/drafts.test.ts, server/transcript.test.ts`
Annotating *why* ("fixture has only 10 uploads") is prohibited: a rubric answer that leaks deciding seams and rots. Locations are evidence, per the standing rule that code lists are never specifications. This cuts location cost (greps), not judgment — Task 2's failures were judgment, and edges do not claim to fix reasoning.

**R6 — Root-fit line.** Preamble: "This packet is the declared closure of `<query>`. If your task's deciding behavior looks outside this closure, say so under Questions instead of silently expanding or shrinking scope." Root choice is human judgment the graph cannot verify; the repair makes mismatch reportable rather than silent drift.

**R7 — Simulate adoption instead of eternal candidacy.** The pilot tested a state the design never intends as an endpoint (candidate beside authoritative incumbent). The next run keeps two arms but changes the scope arm's packet preamble: "The claims in this packet are **adopted** for the promises they state; the incumbent passages they cite are historical for those promises. Everywhere else, `spec/` remains the requirement." No manifest flip is needed — the planner sees only the packet — and no real authority moves, because the exercise edits nothing. This measures the end-state behavior: do planners stop re-reading transferred spans (the reading-saving hypothesis), and does anything critical fall out? Keep the candidate wording as a fallback arm only if budget allows.

**R8 — Measurement and isolation protocol.** Three numbers per session, never one: *supplied* bytes (brief + packet, exact), *retrieved* bytes (tool returns), *plan words*. Retrieved bytes split prose/source only at command boundaries carrying a verified unique sentinel in the recorded command; unsplittable commands are reported as "mixed," never apportioned by regex — no echo-boundary split is exact unless every boundary is metadata-backed. Prep minutes, review minutes, and stored bytes (now: claims 6,763 B, manifest 18,644 B, baseline objects 527,616 B / 24 files — `pilot/report.md` §5) are logged beside session metrics. Planner briefs gain: "exclude prohibited directories by pruning traversal, never by filtering output; traversal alone is an isolation failure."

## 4. Rejected good alternatives

- **A. Distill the missed seams now** (write Disabled-states/accessibility/focus claims before rerunning). Surest recall for exactly those seams — and indistinguishable from retrofit creep: it converts "the disclosure failed" into "author more," with unbounded cost and no instrument for the *next* omission. Kept only as the R1 demand trigger.
- **B. Per-task independent packet review before sessions.** Would have caught several Task-1 packet weaknesses, but doubles prep cost, and — decisive — packets tuned against the tasks that evaluate them destroy the held-out property. Review effort belongs on *claims* (which persist), not per-task renderings.
- **C. Task-size-adaptive packets** (copy/structural/architectural depth classes). Directly answers Task 3's overhead, but it is the head of a configurable framework: who classifies, on what evidence, at what misclassification cost? R3's activation conditions capture most of the benefit with a writing rule.
- **D. Preservation-contract section per packet.** Claim prose already supplies much of this; authored per task it becomes the rubric's answers in disguise. The reason labels (`[required by …]`) already encode the preserve graph; R1 covers the undisclosed remainder.

## 5. Bounded evaluation (requires authorization; nothing here runs unapproved)

**Setup.** Freeze claims and manifest. Apply R1–R6 to packets by re-rendering from frozen claims — the *only* per-task human choice is the query root, recorded as an experiment decision. Select **two held-out tasks** in the composer region *after* the freeze, from seams the claims did not anticipate (examples for the runner to finalize: cross-tab draft collision; adding a new local slash command; attachment removal/reorder). No claim edits may reference these tasks.

**Sessions, hard cap 6.** Stage R: 2 tasks × 2 arms (incumbent; scope-as-adopted per R7) = 4. Pre-registered decision gate:

- Any scope-arm critical miss traced to packet prose → **stop; repair claims, not tooling** (n=1 suffices for "this packet misleads").
- Scope arm shows fewer critical misses and no more false assertions than incumbent on both tasks, and supplied + retrieved bytes are not worse on both → **optionally** rerun one task pair (2 sessions) to bound gross instability, then stop regardless.
- Anything else → report descriptively and stop.

Totals: 4–6 sessions, one judge, within a half-day of session time (estimate). With ≤2 observations per cell there are no significance claims; the design detects *defect classes* (packet-induced miss, packet-induced false assertion, reading-cost direction) and nothing finer.

**Judging.** Same discipline as this round: rubric fixed before plans, authored from frozen source, scores unchangeable after metrics are seen. One new judge duty: every scope-arm critical miss or false assertion gets a **trace verdict** — packet-prose, packet-disclosure, root-choice, planner-reasoning, or incumbent-miss-too. Without the trace we cannot distinguish R1-success from planner luck; Task 2 already demonstrated a packet can be adequate and reasoning still fail.

**Measurement.** R8's three numbers plus the prep/review/storage ledger. Prose-reading savings are reported only if sentinel-verified; otherwise we report total retrieved bytes and say so. No pooled cross-task averages as benefit claims.

**Stop/continue to tooling (Stage B).** Continue only if: zero packet-caused critical misses; false assertions ≤ incumbent arm; total supplied+retrieved ≤ incumbent on ≥1 task without a >50% regression on the other; median packet prep ≤ ~30 minutes by hand (above that, tooling economics fail regardless of plan quality). Failing the first condition keeps the method manual indefinitely — that is a designed outcome, not a failed experiment. Broader workflows (real adoption, reconcile loop, Stage B/C as scoped in the round-two synthesis) need **separate authorization** after this run.

## 6. Limits and unresolved choices

- Judge blinding was and remains imperfect: scope-file names and `§` identifiers leak arm membership (`summary.md` heuristics).
- R1's heading granularity will sometimes mislead by omission *within* a partially cited heading; the two-bucket rule mitigates but does not eliminate — trial before trusting.
- R7's preamble simulation cannot measure what a real adoption flip does to incumbent-document maintenance (frozen spans, review candidates on later edits). Untested by design this round.
- Whether planner reasoning errors respond to *any* disclosure format is unknown; the eval treats them as a measured background rate, not a repair target.
- The 900-word limit counts the reading inventory; five of six missed it. Keep it for comparability, but decide before the run whether inventory bytes belong in the limit.
- Unresolved variant worth one later experiment: for tiny wording tasks, "claim + code map, no frontier" versus R3-conditionalized frontier. Not in this run; one variable at a time.
