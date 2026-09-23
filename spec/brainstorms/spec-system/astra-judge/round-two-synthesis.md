# Round-two judgment: concise claims, retained evidence, local completion gates

**Decision proposal, not implementation.** Read the round-two brief and all five round-two proposals. Rechecked decisive reference rules and current Sova seams on **2026-09-23**, at `c8160b6` plus the dirty working tree. The user's settled identifier convention, incremental authority, Sova pilot, and portable minor-mode consumer are not reopened.

## Decisions in brief

1. **Use Markdown claim headings with foldaidev identifiers; use JSON only for relationships, mappings, and local configuration.** Headings declare; JSON keys cite them. Return actual concise claim prose through `scope`, not machine summaries or a path inventory. This is a pragmatic pilot choice, not a consequence of the naming convention.
2. **Retain exact, targeted working bytes in content-addressed storage.** Hash-only receipts cannot recover yesterday's dirty input. Do not require commits or Git. Start with one storage mechanism; defer Git-backed storage optimization until measured duplication warrants it.
3. **Use conservative dependency-closure evidence invalidation initially.** Review only task-relevant impacted behaviors, sharing a packet and stored objects. Dependency code movement requests comparison, not a conclusion that consumers broke. Do not automatically restore consumer applicability after an upstream review.
4. **Gate assertions of reconciliation/completion, not permission to investigate or repair.** Unknown global coverage is advisory. Relevant conflicts, missing evidence, and stale inputs remain visible until resolved; an authorized task may stop with unresolved findings without being called reconciled.
5. **Run a staged, baseline-preserving Sova retrofit pilot after separate authorization.** Freeze actual working bytes, not merely a tag. Evaluate omissions and maintenance as well as token savings. Rich text remains a hypothetical planning task, not an authorized feature.

## Comparison: retain the alternatives that solve different problems

| Proposal | Strongest contribution | What prevents adoption intact |
|---|---|---|
| **Kimi** | Co-located readable metadata; corrected reverse traversal; explicit dependency review-needed | Rejects JSON on a false declaration/identity premise. Hashes plus a diff summary do not retain dirty baselines; non-Git durability remains unsupported. “Five lines” adds Scope, Adopted, and Amends. Its illustrated external authority and claim prose coexist despite its own prohibition. |
| **Astra** | Exact retained inputs; deliberate per-claim authority transfer; staged prose scope and local gates | Surface-root expansion is unstated. Broad dependency packets can become expensive. One manifest can contend under concurrent authoring. Its group-clearing compression omits the successful-retry exception. These need correction, not deference to the judge's earlier choice. |
| **Opus** | Most useful competing design: co-located Markdown fields, Git-assisted retention, promise-level propagation to control cost | New bold-list-item selector grammar; broad/nested spans risk duplication. Contract-only propagation assumes consumers rely on nothing outside the written contract. Method changes never invalidate; completion accepts any receipt status. Tagged worktree baseline misses dirty inputs. |
| **Fable** | Explicit no-spec `here` claims; located parse findings; manageable local reporting | Discards recoverable dirty evidence on a mistaken Git premise. One-hop dependency claims omit dependency code and deeper changes. Shared citation is incorrectly treated as conflicting authority. “Delta” bodies blur the one-home rule. Draft compression changes behavior. |
| **GLM** | Configurable namespace inventory; compact scope/frontier; on-demand seeding | JSON citations are wrongly treated as declarations. Combined Requires/Maps rows imply arbitrary associations. Example restates cited prose; scope still confuses a reverse consumer with a forward dependency. Hash-only evidence and date error remain. |

**Credible format alternative:** Opus-style reserved Markdown fields beside each claim would reduce cross-file edits. Its cost is a strict new metadata parser and, if incumbent prose must be short without migration, an increasingly intricate excerpt selector. Choose JSON relations plus plain claims for this pilot because prose compression and incremental authority transfer are user goals; do not implement both authoring formats. Measure whether the additional edit location actually hurts.

## 1. Concrete format, authority, and scope

All new artifacts live under `.sova/spec/`: `claims/`, `manifest.json`, `proposals/`, `cut.json`, `reviews/`, `tools/`, disposable `.cache/`, and local method prose. No required source annotations, language, existing spec, Sova installation, or external state directory. A vendored Node core is a proposed runtime prerequisite, not a Sova dependency.

### Identity and boundaries

Use the verified pattern `§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?/[a-z][a-z-]*`, with full-token validation. Relative to `claims/`:

- `§chat/composer` → `chat/composer.md`, H1 declaration.
- `§chat.composer/drafts` → an H2 declaration in that same file.
- `§section.chat/input` → `section/chat/input.md`, H1 declaration.

Namespace inventory and directory-deep kinds are local data, not hardcoded Sova areas. There is one resolver, not an authored ID-to-path table. Cut/add identifiers and retain a successor/reason record; never silently rename or reuse. Proposal filenames can contain dates, but `§change/2026-09-23-rich-text` is **not** a valid identifier. Proposals need no new declaration kind initially; they cite IDs with `amends` metadata outside the current claim scan.

For the pilot, allow an H1 lede and H2 child claims; no other headings in claim files. Ignore fenced examples as declarations. The parent lede ends before the first H2; each child ends before the next heading. This makes spans disjoint. A child query includes the parent lede as orientation, not its siblings. **A surface-root query selects its lede and all declared children.** A section expands its explicitly listed members, applying the same surface rule. These are selection/membership rules, not `requires` edges. Dependency traversal may itself reach a surface and must then expand its children. Cycles are permitted and terminate by a visited set.

### Exact small example

These are **candidate pilot claims**, not adopted authority or an exhaustive description of the composers.

`claims/chat/composer.md`:

```markdown
# §chat/composer — Session input

Single-session message input.

## §chat.composer/drafts — Stored-draft retention

On a draft save, retain the original text and validated pending attachments
when trimmed text or valid attachments remain; otherwise delete the stored entry.
```

`claims/shared/message-text.md`:

```markdown
# §shared/message-text — Text representation

Composer send payloads carry text as a string, not a separate editor document.
```

`claims/workspace/input.md`:

```markdown
# §workspace/input — Group input

No attachment or slash-command controls. A box send clears on clean acceptance
and keeps text on partial acceptance. Retries use the original sent text and
never clear newly typed text.
```

`claims/section/chat/input.md`:

```markdown
# §section.chat/input — Input work

Consider session drafts and group submission together.
```

The relationship portion of `manifest.json` is exactly:

```json
{
  "§chat/composer": {"kind":"surface", "requires":[]},
  "§chat.composer/drafts": {
    "kind":"behavior", "requires":["§shared/message-text"],
    "code":["src/lib/ui-state.ts","src/lib/draft-save.ts","server/drafts.ts"]
  },
  "§shared/message-text": {
    "kind":"behavior", "requires":[],
    "code":["src/components/Composer.tsx","src/components/GroupComposer.tsx"]
  },
  "§workspace/input": {
    "kind":"behavior", "requires":["§shared/message-text"],
    "code":["src/components/GroupComposer.tsx"]
  },
  "§section.chat/input": {
    "kind":"section", "members":["§chat/composer","§workspace/input"]
  }
}
```

Empty requirements here are an illustration, **not independently verified independence**. In actual authoring, absent `requires` means not investigated; explicit `[]` means no further requirements declared. Code paths are evidence locations, never complete-file specification claims. Surface/section orientation is review context, not a separate ceremony requiring a behavior receipt.

Deterministic scope: emit the requested lede, expand sorted members/children, then depth-first sorted requirements, each passage once. Label orientation, membership, and dependency reasons separately. Thus `scope(§section.chat/input)` returns the **literal prose above**, in this order:

```text
§section.chat/input [candidate; requested]
§chat/composer [candidate; member/surface orientation]
§chat.composer/drafts [candidate; surface child]
§shared/message-text [candidate; required by drafts and workspace input]
§workspace/input [candidate; member]
```

The renderer inserts each body's actual sentences after its heading; there is no summarizer. `scope(§chat/composer)` includes drafts and message-text, **not workspace input**. Reverse `impact(§shared/message-text)` returns drafts and workspace input; composer and section are reported as containing groups, not invented dependent behaviors. Reverse `impact(§chat.composer/drafts)` has no declared behavioral consumer in this graph. A shared CSS class remains a separately labeled inspection candidate.

Each output reports snapshot, named known closure, relevant uninvestigated records, unresolved references, external/unmeasured inputs, and whole-unit unread stages when over budget. A general blind-spot warning cannot enumerate unknown behaviors. Count declared records or files within a named boundary, **never “N of all behaviors” without an enumerable population**. A root with one adopted child is not a fully specified surface.

### Authority and terse prose

For Sova, distill selected incumbent promises into candidate claims, retaining exact original passages and provenance. Promotion records **which promise**, not an entire broad heading, transfers authority after comparison and an explicit decision on discrepancies. Until then, incumbent requirements remain requirements; candidate text is not a replacement. Once transferred, stale implementation evidence does **not** quietly return authority to the incumbent: report “adopted claim; evidence stale.” Old passages remain historical for that promise; their later edits are review candidates. Multiple claims may legitimately cite different facts under the same heading.

No-spec projects write candidate claims directly, with observations/source as evidence. The same promotion rule applies. A machine cannot certify that a compressed claim preserved every condition; that is the review.

**Compression control:** retain conditions, exceptions, and externally relied-on mechanisms. “Whitespace deletes the draft” is wrong: valid attachments preserve it. “Across tabs, the server is authoritative” is not established: `ui-state.ts` uses local known-path memory and does not repeatedly fetch the server. “A send clears it everywhere” overstates deferred persistence and ignores other already-loaded tabs. The example above deliberately specifies only **stored-entry retention**, not reload guarantees, attachment limits, failed persistence, or cross-tab synchronization; those remain separate adoption work, not silently compressed away. Likewise, successful group retries do not clear a newer draft.

## 2. Exact dirty evidence without a receipt bureaucracy

**Choose targeted immutable snapshots, shared by hash.** A receipt stores hashes *and retrievable bytes*. Git may hold clean inputs, but it does not normally hold uncommitted working bytes. Merely recording HEAD plus a dirty flag cannot recover those bytes later. Non-Git operation must offer the same review comparison, not permanently provisional evidence.

A packet binds the relevant old/new claim spans and parent orientation; selected membership; mappings and resolved whole code files; **transitive required claim and implementation evidence**; relevant incumbent provenance/authority-transfer records; applicable policy/format version; and observation definitions/results actually relied upon. Store absence explicitly. Retain full source documents for reproducibility while fingerprinting disjoint claim spans and meaningful relation records. Observation outputs are retained data, not commands to rerun automatically.

Impact uses the union of **the selected last-reviewed snapshots and current relationships**, not every historical edge forever. Added/deleted paths and removed dependencies remain review obligations until addressed. Deletions differ from unreadable input. A new file in the declared census is triage work, not an automatic dependency of every claim. Unrelated dirty files are not packet inputs. Malformed records cannot disappear into a smaller apparently valid closure.

Capture inputs/inventory twice and recheck before recording under a cooperating-writer lock; refuse changed candidates. This detects races, not hostile concurrent mutation. Recording then atomically stores the receipt. A receipt describes its snapshot even if disk changes immediately afterward. Exclude receipts, object storage, cache, and fixtures from their own input population.

One shared packet may support several **separately named conclusions**, avoiding repeated copies and “one CLI invocation per checkbox” bureaucracy. No blanket accept-all: each affected promise needs a reason or an unresolved finding. Store reviewer/model identity, self-review disclosure, comparison evidence, and conclusion. Self-review can be accepted during the pilot but is never independent review.

### Conservative closure versus Opus's contract firewall

For `A requires B requires C`, C's code movement makes applicability uncertain upstream. Under the chosen model, A and B remain review-needed even if C receives a new reconciled receipt; a targeted `unaffected` conclusion can discharge each without rewriting prose.

Opus's alternative can save substantial work: once C's unchanged promise is revalidated, its consumers automatically recover. That is defensible **if** consumers rely only on a sufficiently specified contract, reviews cover its relevant observable properties, and hidden implementation dependencies are separately mapped. The machine can check a declared contract boundary, current receipts, and unchanged contract bytes; it cannot prove contract completeness or consumer non-reliance. Automatically treating this as equivalent safety would conceal the very omission the graph is meant to expose. Defer it as an explicitly weaker, opt-in policy experiment on genuinely encapsulated contracts—not the default for Sova's shared helpers.

Applicable policy bytes must participate. A substantive method change cannot be “shown but never invalidating.” Keep binding policy small and separate from historical explanation; policy migration may explicitly preserve unaffected receipts with reasons, never silently grandfather them.

### Storage and privacy tradeoff

Without deduplication, cost is roughly the sum of input sizes across packets. With content-addressed objects, cost is **unique retained file versions plus small packet references**; ten packets sharing an unchanged 100 KiB file store that version once, not ten times. Full dependency closure can still retain many versions of busy large files. Measure unique bytes and bytes added per review.

Preview paths and byte totals before capture. Refuse symlink escapes and external-root capture initially. Never silently snapshot credentials, `.env` files, runtime state, or unrelated attachments; exclusions remain visible. A refused required input means a durable reconciled claim is unavailable, not permission to hash-and-forget it as equivalent evidence. Evidence storage is project-local, not automatically safe to commit or upload. Decide retention/backup visibility before capture; preserve objects referenced by active baselines/receipts, and prune only unreachable objects explicitly. Git-backed clean-blob references are a later space optimization with missing-object behavior, not necessary infrastructure now.

## 3. Statuses, local gates, and authorization

Keep four columns: **input movement**, **receipt applicability**, **claimed review**, and **observations**. Semantic correctness is not computed. For example, `changed / stale / previously reconciled / not rerun` is not “broken”; `unchanged / applicable / unresolved / failed scenario` is not “done.”

| Condition | Scope/planning | Investigation, alignment, repair | Local reconciled-completion assertion |
|---|---|---|---|
| Malformed graph / ambiguous declaration | Diagnostic only; no certified closure | Allowed to diagnose and repair | Block where graph integrity is needed |
| Required reference missing; relevant mapping unknown | Incomplete prose + located frontier | Investigate/backfill; authorize only a bounded plan acknowledging gaps | Block affected promise |
| Global unmapped/unadopted region | Boundary warning | No unrelated block | No global block |
| Relevant inputs moved or necessary material unread | Mark stale/unread; stage remaining prose | Allow review and repair | Require current comparison/read evidence |
| Recorded semantic conflict or failed required observation | Show concrete finding | Decide or repair; confirmation is not a pass | Block until resolved or claim legitimately narrowed |
| Observation unavailable | Name what was not measured | Allow investigation | Cannot certify the unobserved promise |

A user can authorize a repair while these gates are red. A task can end with an honest unresolved report; **“work stopped” is not “reconciled completion.”** Recording `unresolved` must remain possible. Opus's “applicable receipt of any status” is insufficient for the latter gate, and GLM's receipt-before-claim-edit sequence must not prevent repair.

Commands report their own operation: scope/impact `0` means usable known-closure output within its declared boundary; `1` means relevant stale/incomplete/unresolved/unread content; `2` means invalid/unreadable inputs prevent trustworthy computation. A completion check returns `0` only for the selected affected promises satisfying local policy, `1` for outstanding obligations, `2` for inability to check. Producing a packet or recording an unresolved receipt may succeed operationally with `0`; neither means completion. Global unknown coverage alone does not fail a local query. Start advisory for repository-wide reports; no omnibus green badge or semantic-pass field.

Task scope includes declared task IDs, behaviors mapped to changed source/authority/relationship inputs, old/new reverse impact, and changed-unmapped files requiring triage. It must not rely solely on authors naming their changes. Cache loss cannot erase obligations: use the retained task baseline and adopted snapshots.

## 4. Next pilot plan and scoring—permission required before execution

**First freeze the real baseline.** A Git tag or clean worktree at `c8160b6` excludes existing dirty source/spec changes. With permission, capture exact working bytes and presence/absence inventory of the agreed pilot source/spec populations under `.sova/spec/reviews/baseline/`; retain HEAD only as optional provenance. Include relevant untracked files, not just `git diff`, and preview sensitive exclusions. No stash/reset/checkout, original-file edits, Git tag requirement, or reliance on the index. Later-discovered files absent from that capture are labeled first-observed later, not retroactively called baseline. The comparator uses those captured bytes. Temporary perturbation fixtures stay under `.sova/spec/`; copying a project is not permission to execute it.

**Stage A: manual retrofit and paired planning.** Distill a small composer region: stored drafts, send representation/acceptance, keyboard/IME, mention/slash seams, and group exclusions/retry. Preserve original spec files. Use three hypothetical tasks: rich-text session input, attachment-limit change, and group retry wording. Pair incumbent-only and scope-assisted planning in fresh sessions, counterbalanced where practical. Same approved model/settings and task brief; **no pilot model has yet been authorized**. A reviewer prepares a deciding-seam checklist before seeing the plans, then records any checklist omissions discovered later.

**Stage B: authorized minimal tooling and controlled fixtures.** Validate grammar/resolution, prose scope, old/new reverse impact, bounded file census, snapshots, and recording/checking. No observers, language adapters, symbol selectors, proposal overlay engine, or extension edit. Plant: own-code movement, transitive dependency-code movement, removed edge, rename/deletion, new unmapped file, malformed declaration, tiny budget, unrelated dirty file, mid-review change, substantive policy edit, and unavailable snapshot input. Also plant a new behavior inside an already mapped file: the tool should report movement, **not pretend to identify the new behavior**. Add an unknown upstream contract to challenge the proposed future firewall optimization.

**Stage C: portable fixture.** No Git, no incumbent spec, no `src/`, no Sova, and non-TypeScript text sources. Create a candidate claim and dependency, retain a review, modify the old dirty bytes, and demonstrate the old/new comparison remains retrievable. No fixture code execution is necessary.

| Score | Record | Pilot go criterion / decision |
|---|---|---|
| Necessary context | Individually named checklist seams found, missed, unread; false assumptions | Zero missed **critical** seams or invented group inheritance; generic frontier disclaimers do not excuse a missed critical seam |
| Reading cost | Actual prose/source tokens read, fixed context, rereads, unread stages | Target ≥25% prose-reading reduction on at least two of three tasks, with no critical-recall loss; an experiment target, not a predicted saving |
| Graph fidelity | Expected versus returned forward/reverse sets and inclusion reasons | Exact agreement on controlled graph; old-edge consumers retained; membership not mislabeled dependency |
| Honest evidence | Dirty-byte recovery, dependency invalidation, unrelated-dirt control, failed/unavailable distinctions | Every planted mechanical case distinguishes its control; inside-file semantic blind spot disclosed |
| Maintenance | Author minutes, changed authored lines, review minutes, affected receipt count, unique stored bytes | Provisional review target: median ≤10 minutes per small seeded change after setup; report tails and upstream fan-out, not just median |
| Alignment usefulness | Deciding questions, incorrect assumptions, preserved group exceptions, time/tokens | Scope-assisted plans lose no critical question; if benefit is absent, revise/stop rather than expand |

Time-box the manual pilot to one half-day before committing to tooling scope. Numerical targets above are suggested experiment criteria, not new doctrine. First report raw results and discrepancies; broaden adoption only if recall and honest evidence pass and observed cost is worthwhile. Do not perform full retrofit to make the experiment look complete.

## 5. Minor mode: consumer, not platform dependency

The future mode discovers `.sova/spec/` and reads local format/runtime/version information **as data**. An unfamiliar project's `--selfcheck` is executable code, not a safe install probe. Inspect or obtain trust/permission for the vendored tool and its dependencies before executing anything; no automatic npm/install/network command, imported config, or arbitrary evidence command. A version string is compatibility information, not authentication.

After trust, the discipline is small: obtain scope; investigate necessary unknowns; place impact and frontier in alignment; ask before bootstrap/claim adoption/evidence writes; after authorized changes, compare affected inputs before asserting completion. One explicit permission can cover a bounded review batch—no need to ask for every object-store write. Alignment confirmation authorizes a plan, not an observation or receipt. Missing/incompatible tooling is reported and may leave a manual workflow; prompt text cannot enforce compliance. This recommendation requires no Pi API claim or global/server edit.

## Corrections verified, residual decisions, and limits

- Foldaidev's **One declaration rule** explicitly calls other occurrences in prose/code/**data** citations. JSON relation keys need not create declarations or an ID-to-path lookup. Kimi/GLM's categorical objection is unfounded; Opus's edit-hotspot objection remains a real tradeoff.
- Kimi's draft example loses the attachment condition; its date-leading proposal ID fails the actual regex. Fable's compression both drops whitespace semantics and invents cross-tab authority. GLM again dates the proposal September 30 while accepting the earlier correction; its combined table couples unrelated columns and its workspace consumer cannot enter a forward scope merely by requiring message-text.
- Astra and Opus's shortened “clear after acceptance” prose needs the box-send versus retry distinction; source confirms only `fromBox && !next` clears group input. Opus's chosen testing model was not user-authorized. Substantive method changes and unresolved receipts cannot pass a reconciled-completion claim by policy omission.
- Relevant primary reads: foldaidev `docs/identifiers/README.md` → **The § grammar / One declaration rule**, `spec-graph.mjs` → `ID` / `idToFile`, `notation.json`, `spec/foldaidev/revising.md` → **Rename a surface**, and `docs/identifiers/spec-sync.md`. The latter uses a pinned Git baseline and current working bytes; it does not establish recovery of arbitrary earlier dirty reviews from hashes. Sova: `spec/04-composer.md` → **Behavior**, `src/lib/ui-state.ts` draft load/save logic, `server/drafts.ts` → `setDraft`, `Composer.tsx` send logic, and `GroupComposer.tsx` send/retry logic. Round-one readings supply additional context, not a new end-to-end verification.

Only residual user decisions before execution: **authorize the bounded pilot and tool-writing stage separately or together; approve the evaluator/model/time budget; and approve snapshot populations, sensitive exclusions, and whether retained evidence may be committed/shared.** Format, evidence model, and gates above are recommendations to test, not a request to re-decide settled requirements.

No builds, tests, browser, reference checker, or repository artifact were executed. No product behavior was certified. No global repository or behavior counts are repeated. **Only `astra-judge/round-two-synthesis.md` was written; previous research and all implementation were preserved.**
