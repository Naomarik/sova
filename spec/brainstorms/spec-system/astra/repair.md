# Repair proposal: make the boundary useful before making scope smaller

Proposal only. I read the repair brief, judge preflight/stage-one/synthesis, prior round-two synthesis, revision-2 packets, manifest, findings, metrics summary, and attachment scope plan. Decisive checks below use `/tmp/sova-spec-pilot-c4d7993`, not live source. No implementation, experiment, adoption, or peer-repair review occurred.

## 1. What failed, and what the evidence cannot establish

The six archived plans support several different diagnoses, not “graphs need more edges.” Judge `stage-one.md` and `synthesis.md` report incumbent/scope scores of 76/81, 91/74, and 95/93 for rich text, attachment limits, and retry wording. These are single observations per task/arm. They do not isolate effects of content, presentation, model variation, or authority status.

**Content gaps.** Revision-2 task-1 prose covers send acceptance and keys but not the distinction between an unusable editor and an editable editor whose send is blocked. Frozen `spec/04-composer.md`, **Disabled states**, explicitly distinguishes them, and **Behavior** requires focus after Send, Steer, and Stop. Frozen `spec/04b-images.md`, **Composer attachments**, also contains removal focus, upload-after-session-switch behavior, picker reset, and announcements beyond the packet's limit-centered claim. These are preservation obligations for replacing an editor, not answers peculiar to rich text.

**Coverage disclosure.** Task 1 says nothing in the closure is unread. That can be mechanically true while relevant incumbent headings remain undisclosed. The manifest's surface provenance names **Behavior**, not a census of the composer's incumbent sections. “Mapped file” does not mean “mapped behavior.” A generic blind-spot sentence does not distinguish a known undistilled section from a behavior nobody has discovered.

**Root/intent selection.** Task 2 starts at admission limits although the requested change crosses persistence and display. Its frontier fortunately identifies display. Task 3 returns four passages plus broad frontier material for a label change. Correct traversal cannot establish that the selected root expresses the task, and dependency membership does not mean every evidence file needs reading now.

**Reasoning/compliance.** Both attachment plans found all three caps, per the fixed judge assessment. Adding test mappings would improve discovery but cannot explain away the scope plan's explicit errors. Frozen `server/transcript.test.ts:143–149` creates 11 distinct paths and asserts length equals `MAX_ATTACHMENTS_PER_ROW`: changing the constant to 12 makes that assertion fail, not silently pass. Frozen `server/drafts.test.ts:179–182` uses 10 uploads, insufficient to exercise overflow above 12. Frozen `spec/04b-images.md:301–308` computes horizontal control widths and expressly says the pending list does not squeeze the textarea. The scope plan nevertheless describes strip-height squeezing. These are interpretation failures after relevant material was retrieved.

**Authority.** Candidate packets were additions, not replacements. Task 1 points to inaccessible findings rather than carrying the placeholder conflict itself. Frozen `Composer.tsx:212–215` produces no idle prefix, whereas frozen composer **Behavior** requires “Ask pi to…”. The packet warns, but the plan's agreement statement does not account for that conflict. This supports improving conflict delivery and acknowledgments, not a conclusion that adoption would eliminate rereading.

**Measurement.** `comparison/results/metrics/summary.md` measures returned text, with mixed compound outputs. Its smaller attachment output accompanied worse reasoning; retry output increased. None is prose-reading or attention savings. Five plans exceeded the word limit including inventory. Protocol compliance needs testing independently of graph quality.

## 2. Recommended minimum: boundary card, literal closure, evidence check

Keep portable `.sova/spec`, foldaidev § declarations/citations, concise behavioral authority, incremental reconciliation, and an independent core with an optional minor-mode consumer. Change the manual authoring/output discipline first. Do not add task-class configuration, source annotations, language adapters, or a second graph.

### A. Add one small boundary card per queried surface

On first touching a surface, inspect the headings of its named incumbent documents. Record the relevant heading references as **represented**, **partially represented**, or **not distilled**; the author still decides relevance. No incumbent means “no incumbent inventory,” not complete coverage. For broad documents, declare the bounded section inspected; do not census the entire repository.

For partial headings, name the obvious remaining subjects rather than assigning a misleading coverage percentage. Include headings as unknown-work references, not invented § claims or dependency edges. Unknown relevance stays unknown. Newly moved/added headings make this card review-needed when that surface is next queried, without forcing a retrofit elsewhere.

Before: “10 passages; nothing in closure unread.”

After: “All selected declared prose returned. Incumbent inventory inspected: composer Behavior/Disabled states and image Composer attachments. Disabled states are not distilled; Behavior remains partial (focus and control states). Other documents may contain obligations.”

The card makes an enumerable omission visible without claiming all behaviors are enumerable. Inline warnings must carry the decision-relevant fact: “Spec requires idle ‘Ask pi to…’; frozen implementation omits it. Unresolved; this task does not decide copy.” A source pointer supports this sentence but cannot replace it.

### B. Select intent before traversal; never silently prune closure

Require one short request statement: **change**, **preserve**, **roots**, and **selection uncertainty**. This is ordinary prose, not a configurable taxonomy. A label change says the handler and payload remain unchanged; an editor replacement says the editing surface changes while persistence and send behavior remain contractual. Ambiguous roots require investigation or a question, not a best-effort green status.

`scope` still returns literal prose for the complete known closure of those roots. Keep selected roots, forward dependencies, reverse-impact candidates, and undistilled incumbent references visibly distinct. A task-facing reading order may put the requested claim and relevant evidence first, but may not hide required prose as “irrelevant.” If a budget stages whole passages, explicitly list what was not returned.

For tiny changes, first remove repetitive explanatory scaffolding and unrelated investigation narratives. If closure remains expensive, inspect whether a broad claim is conflating independent promises; split only when there is a reusable behavioral boundary, not to win this benchmark. Do not create a retry-label-only claim merely to suppress inconvenient dependencies.

Replace “string unchanged ⇒ no group claim reached” with: “This graph's reverse traversal from the representation claim is relevant if that promise changes. An unchanged string type does not establish unchanged parsing, focus, shared styling, or other consumers.” This separates a graph result from an impact guarantee.

### C. Preserve contracts, not exhaustive implementation summaries

Demand-driven distillation should preserve conditions and exceptions in compact prose. Example candidate wording, requiring review before adoption:

> Read-only ownership prevents editing. Temporary send blocks preserve editing and the draft. Send, Steer, and Stop return focus to the editor.

That is more useful than a permanent task checklist enumerating every rich-text rubric point. Another reusable contract names attachment admission, persistence, and display as distinct boundaries; it need not prescribe the next numerical cap. Existing prose remains authority until a reviewer explicitly transfers the named promise. Conflicting implementation observations remain observations, not silently promoted requirements.

### D. Map tests as evidence, not dependencies or truth

Add relevant test locations to existing evidence mappings when discovered, with uninspected tests labeled honestly. Tests are executable assertions about a population; their names are not a coverage certificate. They can be stale, undersized, or inconsistent with requirements.

For each consequential prediction in a plan, require a concise source-backed check: what input reaches what assertion, and what outcome follows? For a limit change, that naturally asks whether fixtures cross the new boundary; for a copy change, whether the tested label builder feeds the actual action. Do not append solved pilot fixture answers to every packet. This generic reasoning discipline belongs in both evaluation arms, so its effect is not mistaken for a scope benefit.

The plan can cite a short evidence note or mark uncertainty. It need not serialize every reasoning step. Enforce the requested word budget, with a separate machine-recorded retrieval inventory if authorized, rather than asking the model to spend most of its plan reconstructing reads.

## 3. Good alternatives and why not choose them first

**Alternative 1: fuller surface preservation contracts, no heading inventory.** Authors reconcile all incumbent surface promises before returning a compact replacement. This offers cleaner authority and fewer distracting unknowns. It is attractive for a small mature surface, but turns initial adoption into substantial retrofit and makes compression review the bottleneck. Our boundary card lets useful incremental authority coexist with explicit unfinished work. Full contracts remain the destination where demand warrants them.

**Alternative 2: task-tailored packets authored by an expert.** A curator can supply exactly the invariants and tests required, probably minimizing planner retrieval. This is a credible service workflow, especially for rare high-risk changes. It makes the curator a hidden second planner, however; costs scale with tasks, and held-out performance can reflect task-answer leakage rather than reusable scope. Prefer reusable claims plus a short root rationale, measuring any curator investigation time.

**Alternative 3: ask planners to read the complete relevant incumbent section whenever coverage is partial.** This is the simplest conservative fallback and should remain available. As the universal rule it recreates duplicate reading and makes adoption benefits impossible to distinguish. Trigger it when unresolved partial coverage intersects the proposed change, not merely because a surface contains any unknown.

The recommended approach costs an initial bounded heading review and occasional card updates. Estimates: 20–40 minutes per small surface for first inventory/review, and 5–10 minutes for a straightforward changed-heading review; these are budget guesses, not measured pilot costs. A sprawling card or repeated claim splitting is a warning to stop expanding metadata. Record author/reviewer minutes, authored lines, retained unique bytes, and bytes added per revision. Retain targeted evidence versions under the existing proposal; do not copy source-wide context into packets to manufacture recall.

## 4. Authority simulation and a bounded next test

No actual adoption is needed to test the next proposal. With separate authorization, an isolated experiment context can declare reviewed candidate promises **authoritative for this simulation only**. Give it exact transferred promise boundaries; keep undistilled incumbent requirements accessible and authoritative. Omit superseded prose from routine supplied context, but retain accessible provenance for audits. Conflicts and stale evidence remain inline. Never change the live manifest or imply real owner approval. Candidate-overlay and simulated-adopted results must not be pooled.

Start with candidate behavior to test the repair without changing two variables at once. Budget **8 planning sessions**, 10 minutes each: two fresh held-out tasks, two arms, two repetitions. Choose one cross-boundary behavior change and one narrowly scoped wording/configuration change outside the three practiced tasks. Freeze tasks and independent critical-seam expectations before packet authoring; authors may see briefs, not evaluator answers. Use the same approved model/settings, fresh sessions, counterbalanced order, and explicit filesystem allowlists that exclude prohibited directories before traversal.

Allow at most **4 additional sessions** only if the first gate passes: two new held-out tasks, paired repaired-candidate versus simulated-adopted context. These explore authority behavior, not establish statistical confidence. Cap preparation and independent review at four person-hours total; if the useful packet cannot fit that budget, report the authoring failure rather than quietly extend it.

Primary outcomes: individually named critical misses, unsupported factual assertions, and undisclosed relevant conflicts. A concrete verification question may satisfy an unresolved planning seam; generic caution does not. Secondary outcomes: plan compliance, total supplied plus retrieved prose, source separately, elapsed time, author/review time, and retained storage growth. Preserve per-call file/range/category metadata and emitted bytes. Source comments stay in the source bucket under a declared convention. Mixed output without reliable boundaries stays mixed/unclassified; echo delimiters alone are not exact provenance. Measure delivered bytes/tokens, not attention.

**Stop criteria fixed before running:** any critical omission or consequential false assertion in the repaired arm, inaccessible essential warning, isolation failure, or exhausted preparation budget stops progression to tooling. Report failures by mechanism, not only aggregate scores. If both arms fail, revise the planning discipline before blaming retrieval. If safety passes but total prose/source or authoring overhead is worse with no useful benefit, stop expansion and retain the manual fallback.

**Continue criterion:** all repaired runs meet the primary gate and plan constraints, with lower total delivered prose on both held-out tasks and no unexplained source-volume substitution. This is an engineering screening rule, not a confidence interval. Only then request authorization for minimal scope/output tooling and separate adoption/reconciliation tests. Snapshot invalidation, dirty evidence recovery, non-Git portability, and minor-mode compliance remain untested by this planning experiment.
