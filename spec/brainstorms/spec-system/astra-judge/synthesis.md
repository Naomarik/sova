# Judge synthesis: a small, annotation-independent implementation manifest

**Research recommendation only; nothing implemented.** Reviewed all five proposals on equal terms, including Astra. Checked decisive reference claims and Sova source on 2026-09-23, at `c8160b6` plus an already-dirty working tree. No repository-wide semantic audit is claimed.

## Executive recommendation

Start with **an authored, deliberately partial relationship manifest, plain Markdown authority, and derived reports**—not a code-inferred feature graph and not a new spec framework.

- Keep **all new machinery, records, proposals, receipts, and caches inside project-local `.sova/spec/`**. Existing code and incumbent docs are read by project-relative citation, not relocated or annotated. No global service, Sova installation, source-header convention, or incumbent spec is required.
- Give behaviors stable IDs independent of paths. Represent surfaces and build sections as small, optional membership groups; cross-cutting behaviors need no UI address.
- Author semantic `requires` edges and external file mappings. Infer only *inspection candidates* from code, selectors, routes, or history. Generate reverse edges; never author them twice.
- Use whole-file code mappings initially. Record exact reviewed inputs, including authority, mappings, dependencies, and method context. Report changed inputs as **movement**, not proven semantic drift.
- Keep proposed intent separate from current claims, and keep **current claims separate from implementation evidence**. Neither a location named `current` nor unchanged hashes establishes truth.
- Pilot one rich-text-composer alignment manually. Automate validation, forward/reverse traversal, boundary census, and targeted review packets only after that exercise. Do not begin with adapters, overlay execution, mandatory migration, or an alignment extension change.

This chooses Astra's small authored core, but strengthens its portable no-spec path, exact dependency invalidation, tool location, and authority-conflict policy. It keeps Kimi/GLM's low authoring burden, Opus's discovery counterexamples, and Fable's explicit incomplete-slice reporting. It is not a vote or adoption of any proposal intact.

## Comparison matrix

| Proposal / architecture | Best contribution | Decisive weakness or inconsistency | Judgment |
|---|---|---|---|
| **Kimi: Markdown cards, path IDs, recorded clocks** | Readable authored dependencies; cheap census; clear proposed-change workspace | Outside-root tool; path audit also catches ordinary code citations; worked reverse edges contradict declared direction; denies dependency-induced review invalidation; current location is mistaken for current truth | Strong alternative authoring experience; revise evidence model and graph examples before adoption |
| **Astra: authored JSON index beside prose** | Separates coverage/freshness/evidence; old+new graph union; cycles and budget frontier; current vs proposed orthogonal to observation | Receipt dependency content scope insufficiently explicit; tool home and no-spec authority need concretizing; sample deliberately omits real mapping helpers; one manifest can become an editing hotspot | Best minimal starting structure, not a finished specification |
| **Opus: anchored ledger** | Finds GroupComposer coupling missed by Composer import traversal; distinguishes inferred provenance; pins resolved mapping in reviews | Multi-kind resolvers and span hashing are substantial infrastructure; forbids real cycles; budget can truncate required reading; example invents reverse dependencies not supplied by its schema | Keep anchors as optional discovery and later precision, not day-one mapping foundation |
| **Fable: inferred substrate with overrides** | Good visibly incomplete slice, unspecified-but-implemented state, and code-moved/spec-still reminder | Source-citation habit is the baseline; portable no-spec project degenerates into the authored architecture it rejects; comment-derived claims treated too strongly; claim of authored manifests requiring completeness is false | Keep migration hints and provenance, reject inference as semantic authority |
| **GLM: authored units seeded by scanner** | Small dependency vocabulary; explicit unmapped census; ordinary nodes for address-less behavior | No behavior-prose home when no spec exists; hardcoded seed/roots conflict with portability; paste-image example is not rich-text change; commit-only clock underspecifies review; mainline/layer distinction overclaims verified truth | Keep incremental seed as optional convenience, not required init |

Markdown cards remain a credible competitor to JSON: they co-locate explanations and distribute edits. JSON is recommended here because relations need unambiguous parsing and Node can read it without a new dependency. That does **not** require behavior prose in JSON or generated prose. Markdown is the authority format; JSON is the relationship format. Choose one structured authoring grammar initially, not JSON plus equivalent frontmatter plus custom `Depends on:` parsing.

## Small architecture to pilot

```text
.sova/spec/
  README.md                 local method, authority policy, usage
  manifest.json             IDs, groups, mappings, edges, declared scan boundary
  claims/                   current-claim prose ONLY where no incumbent home exists
  proposals/                desired deltas and alignment decisions
  reviews/                  targeted receipts and retained review rationale
  tools/                    standalone local checker, when earned by the pilot
  .cache/                   disposable derived output; never authority
```

All these are proposed paths. The repository root is inferred from the `.sova/spec` location, not an absolute machine path. Source roots, exclusions with reasons, and always-read context are declared locally—not baked-in `src/server/shared`, and not silently disabled when a language is unsupported. The dependency graph must still work with no Git; durable commit-based review would then report unsupported until snapshot support is chosen.

### Identity, composition, and authority

A behavior ID such as `composer.drafts` is a stable reference; `claims/composer.md` and `src/components/Composer.tsx` are locators. Titles, containment, and file moves do not rename IDs. Do not encode the current surface hierarchy as a mandatory identity hierarchy. Real retirement or a deliberate ID change needs an explicit move record; no elaborate permanent alias engine initially.

A **surface** names a user-facing place. A **section** groups investigation/build work. A **behavior** names a promise or constraint, including persistence or retry rules crossing several surfaces. Membership is authored once and does not secretly mean dependency. Initially groups may live in the same small manifest; no file per surface and no fixed number of behaviors are required.

For each behavior, choose one home for its claim text:

- In Sova, cite an incumbent section when it genuinely owns the promise.
- In a project with no spec, write a short claim in `.sova/spec/claims/`, with its adoption evidence or explicit `unreviewed` status. Init need not invent a whole feature inventory.
- If incumbent prose is prescriptive but implementation differs, retain the mismatch as a finding. Do not silently rewrite the product requirement to match code, or call the requirement verified merely because it is authoritative.
- Migration is optional and per fact. A deliberate move changes the authority pointer and handles the old home; it is not a prerequisite for using the manifest. Avoid independently edited paraphrases masquerading as a second authority.

Two citations are not automatically contradictory: they may own complementary facts. A person records a conflict with the actual incompatible claims. A checker can detect competing authority declarations; it cannot generally determine that two sentences disagree.

### Edges, evidence, and slices

`A requires B` means **changing A correctly requires considering B's declared promise**. Forward traversal is the known dependency read set; reverse traversal identifies possible consumers affected by B. This is a context/impact relationship, not a build-order DAG. Cycles terminate with a visited set and are reported as coupled groups.

A separate non-traversed reference can name related material. An absent dependency list means **not mapped**; an explicit empty list means **no declared requirements after this review**, not proof of independence. Malformed records and unresolved IDs stay located findings; do not quietly shrink the graph.

Imports, CSS matches, route extraction, co-change, and existing source comments can suggest candidates. A CSS match proves a textual/structural association, not inheritance of every behavior. A file mapping says where relevant implementation evidence was found, not that the whole file is specified or that all implementation is there. Do not require source citations, or use the ratio of declared to cited mappings as a quality score.

Start with explicit paths and role labels; line numbers are display hints only. Whole files deliberately over-invalidate. Later symbol/heading selectors must report missing or ambiguous resolution and pin both selector and resolved result. Avoid globs that quietly expand coverage; if introduced, fingerprint their expansion, including additions and removals. Rename detection proposes a mapping update; it does not attest the new mapping.

Every slice should state query, snapshot, inclusion reasons, known closure, unresolved/unknown frontier, inferred candidates, and its scan boundary. Deduplicate overlapping passages. Report bytes and estimated tokens, including fixed context. **If over budget, return a staged plan with unread required material explicitly listed.** Budget exhaustion is not permission to call a truncated slice complete. Full graph closure is still only closure of the authored graph, never complete context.

### Coverage, movement, and review: distinct answers

Keep separate columns, not one `aligned` score:

| Axis | What can honestly be reported |
|---|---|
| Structure | records parsed, IDs resolved, cited paths/headings resolved—or findings |
| Coverage | mapped/unmapped/excluded files within the declared population; unknown dependencies; unadopted areas |
| Freshness | exact reviewed inputs unchanged, changed, missing, or unavailable; no receipt |
| Behavioral evidence | scenario, observation/test result, input snapshot, what ran or did not run |
| Semantic review | reconciled / unaffected-with-reason / unresolved; reviewer and retained rationale |

Independently enumerate the declared file boundary and compare mappings. Show changed-but-unmapped and newly added files, dangling paths, and obsolete exclusions. Treat proposal-only mappings separately: a proposal must not make current coverage appear satisfied. An ignored directory or unsupported extractor is visible, not silently clean.

This detects missing **file mapping**, not missing behaviors inside already mapped files. New shortcuts, semantic relocations, omitted dependency edges, and inherited incorrect claims can evade it. Optional route/registry observers later add separately named populations; source parsing is `read`, not proof a runtime served the route. Periodic focused exploration and change review are still necessary.

### Receipt inputs and dependency invalidation

Prefer a deliberately conservative v1: durable receipts against committed input bytes; dirty candidate reviews are provisional unless exact working-tree evidence is retained. An unrelated dirty file need not block a review, but a dirty *input* must not be attributed to HEAD. Receipt/cache writes are excluded from the inputs they certify.

A targeted review packet and its receipt should bind:

1. Behavior ID, resolved baseline/candidate revisions, fingerprint format and applicable method/checker version.
2. Exact old/new claim-authority and implementation bytes, or explicit absence, for the reviewed behavior and its known dependency context; evidence definitions/results actually considered.
3. The relevant mapping records, declared edges, resolved path set, and membership/context that determined the packet—not merely dependency IDs or a top-level commit string.
4. Applicable always-read policy bytes and the scan boundary used; material boundary/context changes request renewed review.
5. Reviewer identity (including model identity and self-review disclosure), conclusion, concrete rationale, unresolved questions, and retained comparison evidence.

Take impact over the **union of old and new mappings/edges** before generating packets. Removing a dependency or moving a claim must not erase its old consumers. At record time, recheck candidate inputs to reject races. Store receipts as history; unchanged receipts can remain applicable across unrelated commits because input identity, not HEAD equality, controls freshness.

**A dependency's changed evidence invalidates applicability of reviews that relied on it**, even if their own prose did not change. Conservatively propagate review-needed along reverse `requires`, and examine dependency context forward for each affected behavior. This is not proof those consumers broke. One may receive an `unaffected` receipt after a targeted comparison explaining why. Unrelated disconnected behaviors do not need rereview. An unresolved dependency is visible in a consumer's packet, not washed away by unchanged consumer bytes.

Whole-file dependency evidence may be noisy; accept that initially. Later contract-level fingerprints could reduce noise, but omitting a dependency's implementation silently is not a safe optimization. Neither matching inputs nor a fresh receipt proves anyone read them, that their reasoning was sound, or that historically wrong prose is now right. Tests add scenario evidence, not universal verification.

## Corrected rich-text worked example

**Desired change:** replace the session textarea with a rich-text editor supporting formatting and inline path/mention chips. This is not already implemented, and image paste alone is not this change.

### Verified current seams

- `spec/04-composer.md` specifies a textarea, IME-aware Enter, string draft persistence, attachments, send/steer, and reload behavior. `Composer.tsx` declares `HTMLTextAreaElement`, string state, slash/mention helpers, and `onSend(text: string, steer, attachments)`.
- `src/lib/draft-save.ts` has a string `text` payload plus attachments; `server/drafts.ts` stores string text and attachment metadata. These reads establish representation seams, not full end-to-end correctness.
- `GroupComposer.tsx` is a separate textarea implementation; it does not import `Composer.tsx`, and its own send/retry logic captures text. **Images and slash commands are deliberately absent**, in both that implementation and `spec/14-workspaces.md`. Shared `.composer-input` is a discovery clue, not evidence group input inherits all session features.

### Hypothetical authored graph for the exercise

These edges are **proposed relationships to review**, not an existing manifest:

```text
composer.input   requires composer.drafts, composer.send, input.keyboard,
                          composer.mentions, composer.slash, composer.images
composer.drafts  requires message.text
composer.send    requires message.text
composer.mentions requires message.text
composer.slash  requires message.text
workspace.input requires input.keyboard, message.text, workspace.batch
workspace.batch requires message.text
```

All listed targets need actual records before this example is a usable machine slice. `composer.images`, `input.keyboard`, and `message.text` have no further edges in this *illustration*, not a claim of real-world independence. Surface membership associates `composer.input` with session composer and `workspace.input` with group composer; membership alone adds no reverse edges.

**Consequences consistent with those rules:** forward `composer.input` reaches its listed requirements and `message.text`. Reverse `message.text` reaches drafts/send/mentions/slash, session input, workspace input, and batch. Reverse `composer.input` does **not** reach its requirements or workspace input. Changing only a session editor implementation raises group input as a shared-selector/design *candidate*; changing the shared text or keyboard contract makes it a declared reverse-dependent. No fabricated dependency is needed to flag the question.

### Alignment → implementation → reconciliation

1. **Investigate and map:** cite existing composer/image/slash/workspace prose; start with `Composer.tsx`, draft helpers, `server/drafts.ts`, mention/slash helpers, and the separate `GroupComposer.tsx`. Follow real call sites before claiming a send-path mapping. `shared/protocol.ts`, `server/chat-manager.ts`, and draft tests are inspection candidates, not a complete verified closure. Record unmapped group/server seams explicitly.
2. **Align:** decide Markdown/plain-text serialization versus structured documents; formatting survival on reload; chip round trips; paste sanitation; keyboard/IME/selection behavior; attachment placement; screen-reader and focus behavior; whether group input changes at all. Preserve its deliberate attachment/slash exclusions unless expressly changed. Shared-protocol changes require Sova's existing coordination.
3. **Bound the reading:** stage authority/contracts first, implementation second, then tests and inferred neighbors. List unread dependencies and questions. Paste known impact and unknowns into alignment Findings/Open questions; confirmation approves a plan, not a receipt. Export a project-local proposal explicitly if desired; do not rely on the existing default `.pi/align.md` export.
4. **Implement only after confirmation:** a new editor file is a changed-unmapped finding until mapped; a proposal-only mapping remains prospective. Compare old/new maps so removing the textarea mapping cannot remove its review obligation. A new dependency or representation change widens impact and can reopen alignment.
5. **Observe and reconcile:** examine draft reload/reconnect, failed send, streaming steer, IME Enter, multiline/HTML paste, chip serialization, attachment retention, accessibility and both themes/widths. If group behavior is affected, examine captured-text partial retries separately. These are recommended checks, **not checks run in this research**. Record each affected promise's evidence and unresolved gaps; consumers can be reviewed unaffected with reasons. Update authoritative current prose deliberately as implementation lands; stale textarea prose remains a finding until then. Keep the proposal/decision link as history, without treating accepted intent as verified implementation.

## Keep / drop / defer

**Keep:** stable references; authored semantic edges; ordinary cross-cutting behaviors; optional groups; one authority per fact; visible unknown frontier; independent bounded census; provenance on candidates; exact-input receipts; before/after impact; per-behavior reconciliation; falsification examples demonstrating checks can fail.

**Drop:** mandatory code headers or reliance on existing ones; “current directory = truth”; derived last-edit time as review evidence; acyclicity as necessary for termination; blanket every-path dependency audits; reverse edges hand-authored separately; proposal mappings satisfying current coverage; unconditional receipt immunity when dependencies change; hard line/concept caps inherited as law.

**Defer:** symbol-span hashing, multi-language anchor resolvers, route observers, co-change ranking, executable proposal overlays, generated docs sites, mandatory independent-review gates, CLI/UI alignment integration, per-feature manifest sharding. Preserve these as alternatives if the pilot shows a concrete need. Last-source-edit history may aid triage, but should never produce a review-like `clean` state.

## Decisions still needed from the user

1. **Authoring ergonomics:** accept JSON relationships plus Markdown claims, or prefer structured Markdown cards? Recommend the former for the pilot; do not implement both.
2. **Authority policy:** retain incumbent `spec/` promises by reference indefinitely, or allow deliberate per-fact migration into `.sova/spec/claims/`? Recommend reference-first with optional migration, not blanket replacement.
3. **Review cost:** committed-input receipts first, or retained dirty-tree snapshots immediately? Recommend committed inputs plus provisional working reviews; make no-Git durable snapshots a separate decision.
4. **Gate strictness and reviewer trust:** advisory adoption reports versus blocking only touched/adopted behaviors; is self/model review acceptable if disclosed, or is independent review mandatory? Recommend no repository-wide coverage gate during adoption, and never label self-review independent.
5. **Pilot boundary and richness:** which composer promises enter the pilot, and does rich text mean serialized Markdown or a structured document? Does group input participate? Those answers determine the graph, not vice versa.

## Verification notes and proposal corrections

- **Kimi suspicions confirmed:** its declaration `composer → attachments/slash-commands` does not yield those nodes from reverse `composer`; its later example says it does. “Every path” includes its `Code` and authority paths, whereas the aidv2 argument concerns citations of other units. `tools/spec-manifest.mjs` violates the requested fully local machinery boundary; location is not cosmetic here. It explicitly says neighbor receipts stand absent own-prose change, which misses dependency evidence. Its claimed foldaidev dirty-code refusal is stronger than the actual `reconcileTarget`: that checks the authority tree, not source dirt.
- **GLM suspicions confirmed:** its document date is September 30; this session/check is September 23. Its “rich-text” scenario is image attachment paste, and its slice omits the declared mode-menu dependency. No-spec adoption is not specified despite forbidding behavior prose in units. Hardcoded seed/roots plus “no config” are unresolved portability problems. Its `web-sessions` example's “persistence lives in pi SDK” is unsafe if referring to Sova origin tracking: `server/web-sessions.ts` implements that persistence locally. Distinguish it from SDK transcript persistence.
- **Fable concern substantiated, not an absolute annotation requirement:** it allows authored overrides and adds no new annotations, so it can be adapted. But its recommended init, default mappings, and declared/cited ratio depend on existing annotations and incumbent specs; those cannot be the portable foundation. Its example includes `composer.mentions` without a declared traversal edge from composer; same-file association would need a separately named candidate rule. Its semantic freshness model lacks exact mapping/dependency input binding. Two authorities are not automatically contradictory.
- **Opus concerns confirmed:** `needs` must be acyclic by its rule; real mutual behaviors do not justify that restriction. “Fills a line budget” does not specify a required unread frontier despite a general boundary warning. The example's reverse slash dependency is not supported by its shown forward composer-to-slash declaration. The TypeScript hub resolver is admitted unverified complexity. Its GroupComposer counterexample is valid; transferring image behavior to it is not.
- **Astra corrections:** no assertion that its partial sample is complete; it explicitly flags missing draft helpers. Nevertheless, exact dependency content invalidation, tool/cache location, and a concrete no-incumbent claim home were left too loose. These are supplied above rather than treating its restraint as an already-complete design.

### Decisive sources actually read

- `~/github/aidv2/INVARIANTS.md` and `debate/questions/Q-004-spec-graph-and-identifiers.md`: slicing was omitted from earlier scoring; dependency truth remains authored; the reported slice savings are prior measurements, not rerun here.
- `~/github/abstract-identifiers/doctrine/verification.md`: coherent graphs can describe a wrong product; partial populations require qualified results; current receipt doctrine binds exact bytes and relationships across both snapshots. It explicitly disclaims proving reading or meaning. Its stricter independent-review and engine rules are evidence, not imported requirements.
- `~/webapps/foldaidev/spec/foldaidev/brief/README.md` (inventory/composition sections), `docs/identifiers/scope.mjs` (header and cycle policy), and `stale.mjs` (clock, source-header mapping, and reconcile implementation): navigation/dependency distinction is useful; annotation dependence and build-order acyclicity do not transfer. A recent source touch is not review.
- Sova paths read for current seams: `spec/04-composer.md`, `spec/14-workspaces.md`, `src/components/Composer.tsx`, `src/components/GroupComposer.tsx`, `src/lib/draft-save.ts`, `server/drafts.ts`, `server/web-sessions.ts`, `pi-config/extensions/mode/align.ts`, and alignment text in `minor.ts`/`README.md`. The align parser/status and confirmation instructions provide a consumer surface, not the proposed manifest integration.

No global source/spec counts are repeated: proposals used different populations, revisions, and working trees, and brainstorm files themselves change that population. Cited local paths were checked; inspected regions are not an exhaustive read of every referenced module. No reference checker, build, tests, or browser was run. No semantic correctness or complete-context claim follows from this research. **Only this synthesis file was written; no existing file or implementation was edited.**
