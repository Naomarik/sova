# Repair proposal: enumerated disclosure, test evidence, self-contained conflicts

**Status:** proposal only. No implementation performed, no pilot/source edits, no execution.
Evidence is checked against the frozen tree at `/tmp/sova-spec-pilot-c4d7993` (HEAD `c4d7993`)
and the pilot artifacts under `.sova/spec/pilot/`. Scores and byte figures are the judge's and
operator's, n=1 per task×arm; nothing here is causal. Settled requirements (portable
`.sova/spec`, foldaidev `§` convention, no source annotations, demand-driven reconciliation,
concise prose as incremental authority, standalone core) are not reopened.

## 1. Causes, separated, with the evidence that supports each

**(a) Content gaps — real, and the largest scoring driver on Task 1.** The claim graph distilled
13 behaviours; `spec/04-composer.md` headings **Disabled states** (`:125`), **Composer flyout**
(`:143`), **Tokens** (`:250`), and **Accessibility** (`:264`) are intersected by no claim's
`incumbent` span (checked against `manifest.json`: spans on that file are `64-106` (orientation
lede), `69-72`, `79-88`, `92-100`, `96-106`). The judge's missing critical seams for T1-Y —
blocked-vs-read-only, focus restoration, attachment lifecycle breadth — sit exactly there. This
is expected pilot seeding incompleteness, not a design failure; the defect is that the packet
didn't *say so item-by-item* (see (b)).

**(b) Coverage disclosure — the wording over-promises.** Task-1 packet: "No budget was applied,
so nothing in the closure is unread" (true, about the closure) beside a generic blind-spot line
placed last in the frontier. Neither enumerates known-but-undistilled headings *in files the
closure already cites* — which are mechanically enumerable, unlike unknown source behaviours.
Verified: packet frontier names eight unknowns, none of them the four headings above.

**(c) Root/intent selection — not observed to fail.** T2's root (`§chat.composer/attachments`)
was right for the client cap; the row cap is a transcript behaviour no claim exists for, and the
packet disclosed it in the frontier. T1/T3 roots were right. I propose no repair here: no
observed failure, and a "root rationale" field would be unmeasurable decoration.

**(d) Planner reasoning errors — real, and not packet-fixable.** T2-X misread
`server/transcript.test.ts:143-147` (11 paths, `assert.equal(length, MAX_ATTACHMENTS_PER_ROW)`:
raising the constant makes the fixture **fail**, not "silently pass") and the `04b` geometry
("Each attachment is 44px tall and at most 240px wide… 44px Remove" — horizontal control
widths, not textarea-vs-strip height). Both arms read the same material; only one arm erred.
No graph edge fixes a misread, and I claim none does.

**(e) Authority protocol — instruction without destination; warnings without access.** The
packet says "report any disagreement" but gives no output slot; T1-Y then wrote "The packet and
spec agree otherwise" while the packet itself flagged the F1 placeholder conflict. And that
warning cites `pilot/findings.md`, which the planner cannot read (it is in `.sova/`, excluded by
protocol). Separately, candidate status did not stop either arm rereading `spec/` — cause
unmeasured. The full authority/reconcile workflow is untested.

**(f) Measurement — confounded.** Returned tool text is not prose tokens. On Task 2 the
incumbent's 56,133 B include 24,666 B of harness persisted-output rereads (calls 5–6,
`metrics/summary.md`); net of them the incumbent is ~31.5 kB vs the scope arm's 44.6 kB — the
sign of the task-2 comparison inverts. On Task 3 the scope arm *read more* (53,325 vs 35,751 B):
a 4.5 kB packet did not discipline a tiny task, and frontier material invited out-of-task
qualification (judge, stage-one T3-Y). Also: incumbent greps traversed `spec/brainstorms/`
before filtering (T1-X cmd 2, T3-X cmd 2) — isolation defect, operator-side.

## 2. Proposed repairs (smallest, manual-first)

### R1 — Enumerate cited-but-undistilled incumbent headings in every scope output

Mechanical, at packet-render time, from data that already exists (`manifest.json` spans +
`^##`-heading line scan of cited incumbent files). Three-way partition per cited file:
**promised** (heading range intersects a child claim's span), **orientation-only** (intersects
only a surface lede span, which the pilot already declares "not a promise being transferred"),
**undistilled** (no intersection with any claim in the graph, closure or not).

Before (task-1 packet, actual): a generic last line — "A behaviour inside a mapped file that no
claim names is a blind spot the graph cannot list."

After (rendered):

```
Cited incumbent headings no claim in the graph covers (readable requirements,
not unknowns — reconcile on demand):
- spec/04-composer.md: Disabled states (:125), Composer flyout (:143), Tokens (:250), Accessibility (:264)
- spec/04-composer.md Behavior (:64): partially promised; :107-124 orientation-only
Closure statement: every claim passage in the named closure appears above; this list covers
only incumbent headings in cited files, not unknown behaviours in source.
```

"Nothing in the closure is unread" stays, but only beside this enumeration. This is the answer
to "should scope map undeclared headings as unknowns": yes, but labelled **known-but-undistilled
prose**, not "unknown" — calling readable requirements unknowns would understate them; the
demand-driven rule survives because the disclosure is exactly the demand signal.

### R2 — Tests join the evidence map

The manifest's only test file is `src/lib/files.test.ts` (checked). `server/drafts.test.ts`,
`server/transcript.test.ts`, `src/lib/group-prompt.test.ts` pin the very behaviours the claims
assert (caps, label strings), yet no `code` list carries them, so the packet's "complete union"
steered attention away from fixtures — where the incumbent arm's decisive advantage lived
(finding both undersized fixtures). Change: an authoring-time rule that a test pinning a claim's
observable behaviour goes in that claim's `code`. Honest scope: this fixes an *evidence
asymmetry*, not T2-X's misread of a test it did read. No claim of score effect is made.

### R3 — Self-contained conflicts with a reporting slot

Two template rules, no schema change:

- **3a, inline evidence.** A packet may cite only material the recipient can open. Before
  (actual): "Placeholder copy … disagrees with the code (see `pilot/findings.md`, F1)." After:
  "spec/04-composer.md:73-78 and 09-copy-deck.md:110-111 say 'Ask pi to…—Enter sends…';
  Composer.tsx:212-215 builds idle≥768 as only 'Enter sends…', idle<768/read-only as empty, and
  streaming as 'Steer the current turn…' joined with a space. No claim covers it; spec/ remains
  the requirement here." ~5 lines per conflict, capped to conflicts touching the closure — the
  demand-driven boundary keeps packets small.
- **3b, a destination.** Replace "report any disagreement you notice" with a required one-liner
  per listed conflict and per discovered conflict: "`Conflict C1: packet says X; spec/ says Y at
  file:heading; my reading: Z.`" The task brief's reply format gains this line. Without a slot,
  "report" is a mood, not an action; T1-Y proved the mood is not enough.

### R4 — Two wording fixes in the packet template

- **Reverse impact states traversal, not task safety.** Before (actual): "If the payload stays a
  plain string, no group claim is reached." After: "`impact(§shared/message-text)` lists those
  consumers regardless of this task. Whether the task changes what they rely on is a property of
  the task's edits, not of this traversal."
- **Frontier is not a work queue.** One line: "Frontier items mark what you do not know; do not
  expand plan scope to resolve them unless the brief asks." Addresses T3-Y's outside-task
  qualification without hiding the frontier.

### R5 — Adopted-simulation for the next test, without real adoption

A pilot-only header block: claims marked `[adopted-sim]` are *for this session* the requirement;
the superseded incumbent spans (already listed per claim in `manifest.json`) are read-only
reference; the planner reports any behaviour it needed that the claims did not state. No
`adoption.records` write, no source edit, fully reversible; the reviewer can diff needed-vs-stated
against the superseded spans. This is the only honest way to test the authority question the
pilot left untested, at zero artifact cost.

## 3. Rejected good alternatives

- **Per-task hand-enumerated disclosure** (what the pilot's frontier effectively was): zero
  tooling, but it repeated exactly the miss class — F1 disclosed, Disabled states not. A
  mechanical enumeration cannot be accidentally satisfied by author recall; a hand list can.
- **Gate scope output until the closure is complete**: contradicts settled demand-driven
  reconciliation and no-retrofit; blocking is not disclosing.
- **Separate `tests[]` manifest field**: cleaner kind-labelling than R2, but a second list to
  maintain that the renderer must union anyway; uniform `code` wins at pilot scale. Revisit if
  kind-confusion shows up.
- **LLM-generated gap summaries per task**: unreviewable, nondeterministic, risks manufacturing
  the opposite false confidence.
- **Shadow-write `adoption.records` tagged `simulated`, rolled back after**: closest fidelity to
  real adoption but pollutes the authority record and needs rollback machinery — wrong trade for
  a test of prose behaviour, not of write mechanics.
- **Pruning the packet for tiny tasks (task-sensitive size)**: rejected as a framework smell;
  R4's frontier rule plus the existing "selected subset" already bound the distraction, and T3-Y's
  coverage was *higher* — over-reading cost bytes, not correctness, and one n cannot justify
  configurability.

## 4. Effort and growth risks

- **R1:** ~10 min/packet by hand today (`grep '^## '` on cited files vs manifest spans); later a
  ~20-line renderer addition. Output grows with incumbent headings (one line each); a mostly-
  undistilled file yields a long list — which is honest retrofit-debt signal, not noise.
- **R2:** ~1 line per claim with a pinning test; staleness risk equals existing `code` paths
  (same census).
- **R3:** ~5 lines per closure-relevant conflict (pilot had 3 conflicts, 6 gaps); the cap is the
  closure, so growth is bounded by graph size, not findings size.
- **R4/R5:** template text; R5 risks behavioural distortion vs real adoption (a label is not an
  adoption) — flagged, not solved.
Total: well under the judge's "iterate manually" half-day for all three packets plus the manifest
test additions. No tooling is requested.

## 5. Bounded held-out evaluation (small, sequential, pre-authorized stops)

**Design.** Three held-out tasks inside the existing distilled graph (it covers nothing else —
that is a stated limit, not a choice): (1) placeholder-copy alignment (exercises R1's Disabled
states/Accessibility exposure + R3's inline F1 conflict); (2) draft-attachment *byte* cap
20 MB→50 MB (count-vs-byte discrimination; exercises R2 via `drafts.test.ts`); (3) refusal-offer
wording (tiny task; exercises R4). Phase 1: 6 sessions (3 tasks × incumbent vs repaired-scope,
one model, counterbalanced order, fresh sessions). Judge rubric fixed blind before plans, as
before. Phase 2 only on signal: one repetition of each pair (≤6 more). Never average across
tasks; report per task. Run in a pruned worktree with prohibited directories physically absent
(fixes the traversal defect mechanically; judge already recommended pruning before traversal).

**Measures, kept separate:** critical misses and false assertions per plan (primary); packet
bytes supplied; returned bytes whole, plus a per-file read classification from the transcript
(commands touching only `spec/*.md` vs only `src|server`, with compound-command bytes reported
as "mixed" — no exact prose/source split is claimed); author/review minutes and stored bytes
from the authoring log.

**Stop / continue-to-tooling conditions, fixed now.** Continue only if, across Phase 1: zero
unreported listed conflicts; zero mislabelled-disagreement reports; misses concentrate in areas
*not* enumerated by R1 (if misses persist inside enumerated headings, disclosure is not working);
false-assertion count not above the incumbent arm; packet prep ≤ ~2× the first pilot's. **Stop**
if, under R5 adopted-sim, scope arms still reread incumbent spec at incumbent volume with no
coverage gain — then the concise-prose-as-authority premise fails at this scale and the design,
not the tooling, is revisited. No statistical confidence is claimed from n=1 or n=2 per cell.

## 6. Limits and unresolved choices

Planner misreads (cause d) are explicitly unaddressed — measurement counts them; no packet
change is claimed to prevent them. Prose-token savings remain unmeasured; the byte→token
inference stays forbidden. Held-out tasks cannot leave the composer graph, so cross-area
generalization is untested. R5's fidelity to real adoption is unknown until a real adoption is
separately authorized. Unresolved operator choices: the Phase-1 model/settings, the judge for
held-out scoring, and whether `[adopted-sim]` output may be retained as evidence. Nothing here
was implemented, run, or scored.
