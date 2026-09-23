# Repair proposal: disclose the boundary, shrink scaffolding, test on held-out tasks

**Proposal only.** I have not implemented or run anything. Claims about the pilot cite `.sova/spec/pilot/…` (n=1 per task and arm). Claims about source and spec cite the frozen tree `/tmp/sova-spec-pilot-c4d7993` (HEAD `c4d7993`, clean). Numbers marked *est.* are my estimates, not measurements. I did not read peer repairs.

## 1. Causes: what the evidence supports

| Class | Observation | Evidence | Strength |
|---|---|---|---|
| **Coverage disclosure** | T1 packet: "No budget was applied, so nothing in the closure is unread." | The claims cite only `spec/04-composer.md` **Behavior** (64–106). No claim cites Anatomy (4–63), the foot/model paragraph (107–124), **Disabled states** (125–141), **Composer flyout** (143–249, which holds Attach images at 224), Tokens, or **Accessibility** (264–276) (checked in `manifest.json` against frozen headings). Even inside Behavior, the lede's broad 64–106 citation hides bullets that no child claim distills: Auto-grow 66–68, placeholder 73–78, After Stop 89–90, and **Focus** 91. These match the judge's T1-Y gaps: blocked vs read-only, focus, attachment lifecycle. | Strong as a disclosure defect. A causal link to the planner's omission is plausible but unproven. T1-Y read `04-composer.md` lines 1–80 only (`metrics/summary.md`, command 3). T1-X `cat` the whole file and covered read-only and focus. n=1. |
| **Content gap** | The same omissions, plus no test files in any `code` map. Only `src/lib/files.test.ts` appears in `manifest.json`. | Tests pin the claims' literals: `server/drafts.test.ts:164` "capped at 8", `server/transcript.test.ts:143`, `src/lib/group-prompt.test.ts:96–108`. The T3 packet even calls `group-prompt.test.ts` "outside the examined population". | Strong that the gap exists. The task effect is weak: both T2 arms found all three caps. |
| **Planner reasoning** | T2-X read `server/transcript.test.ts` 138–150 and still predicted that the 11-path fixture would "silently pass". The assertion at `:146` compares against the constant, so the test would fail. T2-X also read `04b:302` (horizontal row widths) as a strip-height formula. | The packet said nothing about either. | These errors are not packet-caused, and graph edges would not fix them. |
| **Warning design** | The F1 placeholder conflict was flagged only as "see `pilot/findings.md`", a file the planner could not reach. T1-Y then said the packet "otherwise agrees" with the spec. | `scope-packets/task-1.md` frontier; T1-Y plan | Strong as a defect. The cause of the non-report is unproven. |
| **Scaffolding, not closure** | The T3 packet is 4,523 B. Claim passages are 1,713 B. Header plus reverse impact, code maps (twice), "selected subset", and frontier are 2,800 B. | My byte split of `inputs/scope-packets/task-3.md` on `---` and bold section leads. T1 is 3,866 of 9,504; T2 is 2,908 of 4,921. | Measured bytes. Its role in T3-Y's refused-retry detour is unproven. |
| **Unsafe impact wording** | "If the payload stays a plain string, no group claim is reached." | Declared edges cannot show that nothing else is affected. The group and session composers share `.composer-input` and `GroupView.tsx:436–439` reads `composer.disabled`. Neither is a `requires` edge. | Strong as a wording defect. |
| **Root and intent** | The T3 root (`/retry`) is right, but the closure answers "what the retry's truth relies on". A wording task needs "where the literal lives and what pins it". T1's surface root is right for an editor-substrate swap, but a substrate swap touches the undistilled headings. | Packets and frozen source | Moderate. Graph closure can be mechanically correct with the wrong root or missing behavioral edges. |
| **Authority protocol** | Packets sat beside authoritative `spec/`, and every assisted session reread the incumbent (`judge/synthesis.md`). | By design, candidate status cannot save reading. | Real reading savings were untestable in this pilot. |
| **Measurement** | Bytes mix prose, source, listings, and supplied text. Five of six plans went over 900 words, in both arms. Packet author and checklist author were the same person. The two brainstorm greps traversed the directory before filtering. | `results/metrics/summary.md`, judge | These are confounds, not findings. |

What I **cannot** conclude: that scope helped, hurt, or saved anything. Score differences are single sessions.

## 2. Proposed repairs, smallest first

None of these adds rubric answers, per-task prose, or a mode flag. Each one is either computable from data the manifest already holds, or a single authoring rule.

### R1. A computed coverage ledger replaces completeness language

The ledger lists which parts of the incumbent spec no claim distills. Computing it:
1. For each incumbent file the closure cites, list the heading spans and top-level list-item spans that no **child** claim's `incumbent.lines` covers.
2. A surface lede's citation is orientation. It never counts as coverage.

Output rules, fixed by query shape:
- A **surface** query lists the gaps in its host file(s).
- A **child** query lists the gaps inside its host heading.
- Other cited files get a single line: file name and undistilled-heading count.
- Stop at about 12 lines, then state the count. A capped ledger must say it is capped.

Before (T1):
> No budget was applied, so nothing in the closure is unread.

After (T1, hand-derived from the manifest):
> Returned: all 10 passages of the declared closure. **Not distilled, and still the requirement**, in `spec/04-composer.md`: Anatomy 4–63; Behavior bullets Auto-grow 66–68, placeholder 73–78 (see conflict below), After Stop 89–90, Focus 91; foot/model indicator 107–124; Disabled states 125–141; Composer flyout 143–249; Tokens 250–263; Accessibility 264–276. Other cited files: `04b-images.md`, 3 of 4 headings undistilled; `04d-slash-commands.md`, 7 of 10; `09-copy-deck.md`, most rows. Behaviour outside these files that no claim names is not listed.

This answers the question about undeclared incumbent headings: **yes, show them as unknowns, but compute them rather than author them.** The ledger names locations only. It does not say which of them matter, so it cannot leak a rubric. It costs about 600 B *est.* It needs no authoring, and it stays current when claims are added. Its limit: it knows only incumbent Markdown structure. Source-only behavior, such as `GroupView.tsx` reading `.disabled`, stays invisible. For a project with no incumbent spec the ledger is empty, and the packet must say so.

### R2. Warnings stand alone and attach to their claim

Every conflict or gap is stated inline in one or two sentences, with both locations and the authority rule. It never cites material the reader was not given.

Before:
> Placeholder copy … disagrees with the code (see `pilot/findings.md`, F1).

After:
> **Unresolved conflict.** `spec/04-composer.md:73–78` and `09-copy-deck.md:110–111` specify "Ask pi to…". `Composer.tsx:212–215` builds only the key hint, and nothing below 768 px or when read-only. `spec/` stays the requirement until an owner decides. A plan touching the placeholder must name this.

The frontier keeps only items that touch the requested claims' own mapped files or incumbent spans. Everything else becomes a count. The T3 refused-retry seam would still appear, because it lives in `GroupComposer.tsx`, but as one line.

### R3. Impact states the limit of what it can see

Before:
> If the payload stays a plain string, no group claim is reached.

After:
> Declared consumers of `§shared/message-text`: `§workspace.input/{acceptance,retry,keys}`. This lists declared `requires` edges only. Shared styling, DOM reads, and undeclared reliance are not covered.

### R4. Tests as pins, not claims

Allow test files in `code` and give each one its test **name** in the packet, never its content:
> Checked by: `server/drafts.test.ts` "store: invalid attachment entries are dropped, the rest kept, capped at 8".

Authoring cost is about 2–5 minutes per claim for a grep *est.*, so roughly one hour for the current 16 claims *est.* Names churn less than line numbers. **Limit:** T2-X read the relevant assertion and still misread it. Pins direct attention; they do not fix reasoning.

### R5. Fixed packet order and a one-line intent

The packet has five parts, in this order:
1. One line naming the change and why the root owns it, e.g. "literal `Send to {member}` → `Retry {member}`; root `§workspace.input/retry` owns the label".
2. The requested claim's prose.
3. The `requires` prose.
4. The ledger, warnings, and pins.
5. The code files mapped by the requested claim. The full union becomes a count plus "on request".

Drop "selected subset", because author judgement dressed as graph output is noise. The closure prose stays whole, as the settled requirement demands. Only the scaffolding shrinks. Projected T3 packet: about 2.3 KB against 4.5 KB *est.* No bytes were measured for this projection.

### Preservation contracts

I recommend **no separate contract section**. The claims already are the preservation contract. A second "must still hold" list per surface duplicates them and invites per-task tailoring. Where a claim holds a literal that must stay in sync (the three 8s), the claim's prose should say so in one sentence. G4 already records this, and the drafts claim omits it.

## 3. Good alternatives I did not choose

| Alternative | Strength | Why not now |
|---|---|---|
| **B. An authored boundary sentence per surface lede**, e.g. "Not yet distilled: disabled/read-only states, focus, flyout, accessibility, auto-grow" | Semantic. Can name cross-file seams like `GroupView` focus. | The author lists only the gaps they know about, which is exactly the pilot's failure. It goes stale silently and cannot be checked. Keep it as optional prose on top of R1, not instead of it. |
| **C. Distill Disabled states, Focus, and Accessibility now** | Fixes the T1 content directly. | Overfits the benchmark the judge just scored, and does not generalize to the next gap. Do it demand-driven, and exclude T1 from evaluation afterwards. |
| **D. Inline the raw text of undistilled incumbent spans** | Nothing is hidden. | This is the source-wide copying the brief forbids. T1 would grow by about 8 KB *est.* |
| **E. Task-mode queries (`--wording`, `--behavior`)** | Would have trimmed T3. | A configurable framework. R5's intent line plus root choice gets most of the effect with no flags. |
| **F. Skip the packet for literal-only changes and let the planner grep** | T3-X (grep, no packet) scored 95 and stayed within the limit. | Plausible, and worth testing as a rule, but it is n=1. It also leaves wording changes without their preservation semantics, such as captured original text. |

## 4. Authority: candidate versus adopted, simulated safely

While packets stay candidate, planners must reread the incumbent, so reading savings cannot appear. That follows from the protocol, not from any finding.

**Simulated adoption**, if later authorized, works like this:
- Run in a disposable sparse worktree. Leave `spec/` and `manifest.adoption` untouched.
- The packet header lists the exact incumbent line ranges that the returned claims stand in for "for this exercise". Everything outside those ranges stays the requirement, and R1's ledger shows the outside.

Two limits apply:
- The claims are unreviewed, so simulated authority can plant false assertions. The judge must tag each false assertion as **packet-induced** or **independent**.
- Run this only after an independent review of the claims involved, and as a second stage. It is not part of the first run below.

## 5. Bounded held-out evaluation

**Setup**
- An independent reviewer writes **three held-out tasks** inside the distilled region, plus their rubrics, before any packet is generated. The packet author sees neither.
- The tasks should cover:
  - a literal/copy change outside T3, e.g. the refusal offer label;
  - a behavior change crossing a `requires` edge, e.g. draft save debounce or deletion;
  - a change that lands in undistilled material, e.g. a disabled-reason change. This one tests R1.
- The packet author only picks the root ID and writes R5's intent line, logging both before generation. Everything else follows R1–R5 mechanically.
- A second person recomputes the T1 ledger independently. Disagreement means R1 is not mechanical yet.
- Run in a sparse worktree without `spec/brainstorms/` or `.sova/`, so there is nothing to traverse.

**Stage 1:** 3 tasks × 2 arms (incumbent / repaired scope), one session each, counterbalanced order, same model. **Stage 2** (same six cells again) runs only if Stage 1 is neither a stop nor clearly passing. At most **12 sessions**.

**Primary measures, per plan**
- Critical seams missed.
- False assertions, tagged packet-induced or independent.
- Whether each ledger or warning item relevant to a miss was shown and ignored, or never shown.

**Secondary measures**
- **Supplied bytes**, exact: brief plus packet.
- **Retrieved bytes**, in three buckets. Single-kind commands count as prose or source. Compound commands count as **mixed**, left unsplit. Echo markers are not proof of a boundary.
- Elapsed time and tool calls.
- Plan words, excluding the read inventory. The limit applies to sections 1–4.
- **Costs:** root and intent minutes, packet-generation minutes, ledger-check minutes, reviewer minutes, and new artifact bytes.

**Decision rules, fixed before the run**
- **Stop and revise the method.** Any packet-induced false assertion that affects the plan, or the repaired arm misses more critical seams than incumbent on any task in the cells run so far.
- **Stop and fix the planner protocol, not the spec method.** The miss was listed in the ledger or warnings and ignored.
- **Continue to a tooling proposal** (separate authorization). Needs all four:
  - no packet-induced false assertion;
  - on every task, no more critical misses than the incumbent arm;
  - the ledger was reproduced exactly by the second person;
  - hand-generating ledgers and packets took long enough that automating them pays off. I'd suggest over 15 minutes per packet *est. threshold*.
- **Otherwise inconclusive.** Report raw results. No benefit is claimed, and no statistics are drawn from n ≤ 2.

Re-running T1–T3 is a labelled regression check only, never evidence.

## 6. Costs, growth, and open choices

**Costs and growth**
- R1–R3 and R5 add no authoring. R4 adds about one hour now *est.*, plus upkeep when tests are renamed.
- Ledger length grows with the size of the host file. `14-workspaces.md` has 21 headings, which is why the cap is needed.
- Stored line spans rot when incumbent files change; the ledger must flag moved spans, not trust them.

**Open choices for the user or judge**
- The ledger cap size.
- Whether to trial alternative F (no packet for literal-only tasks) as a third arm.
- Whether simulated adoption is worth the review it requires.

**Not addressed**
- Semantic dependencies that no heading or edge records: the root-selection error class. R1 shows where the unknowns are; it cannot name what is missing.
