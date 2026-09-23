# Repair proposal: make the packet say what it does not cover

**Proposal only.** No pilot, source, spec, or packet was edited. Claims below were checked against `/tmp/sova-spec-pilot-c4d7993` (source, `spec/`) and the live `.sova/spec/pilot/` archive (plans, packets, metrics, judge). Peer repair files were not read.

## 1. Causes, separated, against the evidence

| Cause | What the evidence supports | What it does not support |
|---|---|---|
| **Content gap** | The Task 1 packet distils `spec/04-composer.md` → Behavior only (manifest `incumbent` for `§chat/composer` cites lines 64-106). Disabled states (125-142), Accessibility (264+), and the Focus/After-Stop bullets (89-91) are not in any claim. T1-Y read `04-composer.md` lines 1-80 only (its inventory, item 7) and missed blocked-vs-read-only; T1-X read the whole file (inventory item 4) and got it. | That distilling those headings would have fixed T1-Y. n=1, and T1-Y also stopped reading at line 80 on its own. |
| **Coverage disclosure** | The packet's "No budget was applied, so nothing in the closure is unread" is true of the graph and misleading about the surface. The frontier lists 8 hand-chosen unknowns; the undistilled headings of the one cited spec file are not among them. | That the sentence caused the truncated read. It is a plausible false-sufficiency signal, untested. |
| **Root/intent** | All three roots were correct. Task 2's transcript row cap is a behaviour inside a mapped file with no claim, and the packet disclosed it as a blind spot. Both arms found all three caps. | That a different root or extra edges would have changed any score. |
| **Planner reasoning** | T2-X's two penalties were on material it read itself: `server/transcript.test.ts:143-147` asserts `length === MAX_ATTACHMENTS_PER_ROW` with 11 paths, so raising the cap fails the test (T2-X said it would "silently pass"); `spec/04b-images.md:302-306` is a horizontal width formula, not strip height. | Any packet fix. Do not spend packet bytes on this. |
| **Compliance** | 5 of 6 plans exceeded 900 words, both arms. T1-Y did not report the F1 placeholder conflict, but the packet pointed it at `pilot/findings.md`, which the operator prompt prohibited. T1-X and T3-X ran `grep -r … .` then filtered `brainstorms` from results (metrics, calls 2). | That the packet makes planners wordier: T1-Y was shorter than T1-X, T3-Y longer than T3-X. |
| **Authority protocol** | Every scope-assisted session re-read incumbent spec and source. That is what "candidate, spec is the requirement" asks for, so it is not a failure. Adopted-status behaviour is untested. | Any claim about reading savings under adoption. |
| **Measurement** | Tool-result text is not archived (`metrics/sessions.json`, `_`), and `kinds` classifies the command, not the bytes. Every planner used compound commands. Prose and source bytes cannot be split from this archive. | Any prose-token saving. |

The one cause the pilot can act on cheaply is disclosure. The packet knows exactly which incumbent lines it distilled, and says nothing about the rest.

## 2. Proposed repair: packet contract v3

Five rules, each mechanical or a one-line discipline. No new claim kinds, no new identifiers, no templates by task type.

### 2a. Undistilled ledger, computed from the manifest

For each incumbent file any closure claim cites, list the headings (H2) and, within a cited heading, the line ranges no closure claim's `incumbent.lines` covers. This is set arithmetic on data the manifest already holds. One line per file, capped at 12 named headings; above that, give the count. Table-shaped files such as `09-copy-deck.md` get rows-cited-of-rows-total, nothing more.

Before (Task 1 packet):

```text
No budget was applied, so nothing in the closure is unread.
```

After:

```text
Closure complete: all 10 declared passages are above. It is not the surface.
Not distilled, by incumbent file:
- spec/04-composer.md: headings Anatomy, Disabled states, Composer flyout, Tokens,
  Accessibility. Inside Behavior: lines 73-78 (placeholder), 89-91 (After Stop, Focus),
  107-124 (the foot, model indicator).
- spec/04b-images.md: 1 of 4 headings cited (Composer attachments). Not distilled: Thread
  thumbnails, Path attachments (holds the row cap), Lightbox.
- spec/09-copy-deck.md: 4 rows cited; the rest of the deck is not distilled.
- spec/04d-slash-commands.md: 3 of 10 headings cited (When the menu opens, Keyboard and
  mouse, In the thread).
A behaviour inside a mapped source file that no claim names cannot be listed.
```

Headings and counts are from the frozen files; the in-heading line ranges are read by eye from the manifest and would be computed in a real render. This answers the brief's question: yes, map undeclared incumbent headings as unknowns, but only as a list. Assigning them as `requires` edges would be authoring, and false edges are worse than a ledger.

### 2b. Self-contained warnings

A packet may not point at a file outside the closure's cited population. Conflicts touching the closure are stated inline, two lines, both locations, no verdict.

Before: "Placeholder copy in `spec/04-composer.md` and `spec/09-copy-deck.md` disagrees with the code (see `pilot/findings.md`, F1)."

After: "Conflict, unresolved: `spec/04-composer.md:73-78` says the idle placeholder reads 'Ask pi to…'. `src/components/Composer.tsx:212-215` renders only the key hint at ≥768 and an empty string otherwise. The spec is still the requirement."

### 2c. Typed frontier, closure-bound

Each frontier line carries one type: `conflict`, `blind spot` (behaviour inside a mapped file), `not investigated`, `observed seam`. A line stays in the packet only if it names a mapped file or cited span of this closure. Other findings collapse to one count. Task 3 keeps its refused-retry line (it is in `GroupComposer.tsx`, mapped) but as one typed sentence, not four lines with a routing discussion; the "provider limits" line in Task 2 becomes `not investigated` with no elaboration. Estimated saving: 0.5 to 1 KB per packet. This is trimming, not the cause of T3-Y's length; T3-Y's extra words were its own speculation on verb semantics.

### 2d. Tests as evidence, computed

For each mapped source file, list test files that import it (a grep, no authoring). Label them "asserts behaviour; fixture sizes not read." For Task 2 this adds `server/drafts.test.ts` and `server/transcript.test.ts`. This makes the fixture-size question findable. It does not fix misreading: T2-X read `transcript.test.ts:138-150` and still got it wrong.

### 2e. Reverse impact as declared edges, and prose as the contract

Replace "If the payload stays a plain string, no group claim is reached" with: "Declared consumers of `§shared/message-text` outside this closure: `§workspace.input/acceptance`, `/retry`, `/keys`. The graph lists declared edges; it does not certify that a change keeping the string type cannot affect them." Add one sentence at the top of every packet: "Each sentence in a claim is behaviour to preserve unless your task changes it; say which you change." That is the preservation contract. The claims already are it; the packet just has to say so. No per-claim invariants, no checklists.

## 3. Candidate versus adopted, and safe simulation

The pilot placed candidate packets beside authoritative spec, and planners correctly re-read the spec. Adopted status is what the settled design will actually run under, and it is untested. Do not fake adoption in `manifest.json`. Instead, run one pair where the packet's status label reads `[adopted for this exercise; incumbent spans superseded for these promises]` while the manifest and spec stay untouched, and the results are filed as *simulated adoption*. The question is narrow: does the planner stop re-reading the superseded spans, and does it then miss what those spans said and the claim did not? If it does, the claim was under-distilled, which is exactly what review before adoption should catch. This pair is last in the sequence and runs only if the candidate pairs pass.

## 4. Rejected alternatives

**Distil the missing headings now** (Disabled states, Focus, Accessibility, flyout). It would close the Task 1 gap directly and costs an hour. Rejected: it is a full-retrofit slope, and the next held-out task finds the next undistilled heading. The ledger converts this into demand-driven work: when a task touches a listed heading, distil it then.

**Task-shaped packets** (wording, limit, representation templates). It matches the three observed shapes and would have shrunk Task 3. Rejected: it is a configurable framework, task intent is the planner's judgment, and a wrong template silently narrows scope. The root choice plus staged depth (full prose at depth ≤1, heading and first sentence beyond, marked as truncated) gives most of the trimming with one fixed rule. On the pilot graph it changes little, which is honest: these packets were not badly sized.

**Planner instruction only** ("read every cited incumbent heading in full after the packet"). Zero authoring, arm-neutral. Rejected as the sole fix: it gives up the reading goal and depends on compliance, which the word limit shows is weak in both arms. Kept as one sentence: "The packet orients; it does not replace the cited spans."

**Per-claim checks or boundary lists.** Rubric answers in the packet. Rejected outright.

## 5. Costs and growth risks

- **Authoring:** 2a, 2d are computed from existing manifest fields plus one grep; zero authoring once rendered by hand or script. 2b, 2c, 2e are editing discipline on the existing frontier: estimated 5 to 10 minutes per packet by hand.
- **Packet growth:** the ledger adds an estimated 300 to 700 bytes per packet; typing and closure-binding the frontier removes a similar amount. Net near zero, an estimate.
- **Growth risk:** the ledger scales with the size of cited incumbent files, not with the graph. The 12-heading cap and the rows-of-rows rule for tables bound it. A no-spec project has no incumbent files, so the ledger is empty and says so; the blind-spot sentence remains.
- **Maintenance:** the ledger must be re-rendered when either the manifest lines or the incumbent file changes. That is the same trigger the `spanSha256` already tracks; a stale span means a stale ledger.
- **Storage:** unchanged.

## 6. Bounded, sequential evaluation

Held-out tasks in the same neighbourhood, because that is where claims exist:

- **H1.** "Let a user choose Enter to newline and Shift+Enter to send." Touches `/keys`; the spec says the group box uses the same keys with no shared code (findings, seams). Tests group non-inheritance and the undistilled keys hint in the placeholder.
- **H2.** "Persist the group box text across reload." Touches `§workspace.input/exclusions` and the draft store; the incumbent is silent (G3). Tests cross-surface reasoning and disclosure of an unverified seam.
- **R1.** Repeat Task 1 with a v3 packet. Weak evidence by construction: the ledger was designed on this task. Record it as a regression check, not a result.

Protocol per pair: fresh sessions, same model, both arms, brief byte-identical, packet appended. Judge writes a rubric per task before any plan, scores blind to the extent § identifiers allow, and records that limit. Planners are told to read one path per command with no pipes, so each tool result maps to one file and bytes classify by path; any compound result is marked *unsplit* rather than split by echo markers. Log packet prep minutes, judge minutes, and packet bytes.

Sequence and budget:

| Stage | Sessions | Go/stop |
|---|---|---|
| 1: H1, H2, both arms | 4 | Stop and redesign if the scope arm has a critical miss the incumbent arm lacks **and** the ledger named it. That is a compliance failure the packet cannot fix. |
| 2: R1 both arms, plus H1 scope arm twice more | 4 | Continue if scope-arm critical misses ≤ incumbent in every pair so far and no false assertion traces to packet content. The two repeats show whether one session's result is stable, not a confidence interval. |
| 3: simulated adoption on H1 | 2 | Run only after stages 1 and 2 pass. |

Ten sessions maximum, about 2 minutes of planning each at pilot rates, plus judging. Primary measures: critical misses and false assertions per session, listed by name. Secondary: supplied bytes, retrieved prose bytes, retrieved source bytes, separately. Report per-session tables; no averages, no percentages over n ≤ 3.

**Continue to minimal tooling** (a scope renderer with the ledger) only if all three hold: scope arm never has more critical misses than incumbent; at least one planner cites a ledger or blind-spot line as the reason for a read; hand-rendering the ledger took longer than writing the frontier. The third is the only argument for a tool. **Stop** if planners ignore the ledger in every session, or if any critical miss is traced to trusting a claim over an undistilled span.

## 7. Limits and unresolved choices

- Everything in §1 rests on one session per cell. The ledger is a hypothesis about false sufficiency, not a demonstrated cause.
- The heading-level ledger cannot name behaviours inside a mapped source file. That blind spot stays, and the packet should keep saying so.
- Staged depth and the 12-heading cap are fixed numbers chosen by judgment, not measured.
- The simulated-adoption label is a controlled fiction. It must be filed as such and never copied into `manifest.json`.
- Whether the judge should be forbidden from seeing § identifiers, or planners told not to cite them, is a blinding trade the operator must choose. Either changes planner behaviour.
- The one-path-per-command rule changes how planners read. Its bytes are comparable across arms, not to the pilot's compound-command figures.
- Test-import listing (2d) uses a grep on import paths; relative imports through index files would be missed. Say "found by import grep" on the packet.
