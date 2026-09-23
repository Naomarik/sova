# Astra: a small manifest, not a second specification

**Status: proposal, not implemented.** Recommend a portable, project-local manifest that indexes existing authority, records a few explicit dependencies, and keeps implementation evidence outside source code. Its first useful answer is “here is the known composer slice, and here is what we have not checked,” not “the project is documented.”

## What the references actually establish

Read the live files, including dirty working-tree content. Sova was at `c8160b6` with local changes; abstract-identifiers at `7154cb3` with local changes, including `doctrine/verification.md`; foldaidev at `ce7ea599`, clean in the status output. `~/github/aidv2` is not a Git repository here. These observations are snapshots, not a claim that every file was reviewed. No reference checker or product was run.

- **aidv2:** `INVARIANTS.md` demands computed slices and an explicit mechanical/semantic boundary. `DECISION.md` selects a small address checker but explicitly labels its skeleton and retrofit costs unverified. `debate/questions/Q-003-sync-detection.md` reopens change-triggered reconciliation; Q-004 exposes the scoring omission that disadvantaged dependency slicing; Q-006 shows why address-less behavior needs discoverable dependencies; Q-007 keeps speculative expectations separate from current claims. These are open arguments, not a settled architecture to inherit. `context/facts.md` and `debate/investigations/I-002-what-the-graph-does.md` report previous measurements, not measurements repeated here.
- **foldaidev:** `spec/foldaidev/brief/README.md` separates surfaces, build sections, and cross-section flows. Dependency edges load context; navigation edges normally do not. Section membership lives in section files, not duplicated in the index. `docs/identifiers/scope.mjs` computes closure, always-on reading, linked-out names, and line budgets. Its fixed context demonstrates that even a small slice can carry substantial overhead. The README's “whole context needed” language is stronger than this proposal would adopt.
- **Reconciliation:** foldaidev's `docs/identifiers/stale.mjs` distinguishes recorded review clocks from last-source-edit clocks. A recent comment edit once made a derived clock look clean; the script explicitly warns that recent touching is not review. It also relies on source `Surfaces:` headers, which we must replace rather than copy. Its working implementation checks committed ranges; it is not a universal working-tree freshness oracle.
- **abstract-identifiers:** `doctrine/authority.md` explains why malformed rows must remain located findings rather than vanish into a smaller graph. `doctrine/verification.md` distinguishes structural consistency, external observations, and review receipts; matching fingerprints do not prove anyone read anything. `engine/cli/scope.mjs` refuses uncertified graphs and reports owed mechanism notes. Keep those failure lessons without importing mandatory mirrored notes, a general grammar, or its whole engine.
- **Sova:** `spec/overview.md` is already a numbered UX index. `spec/04-composer.md` describes a textarea, sending/steering, persistent drafts, attachments, and related menus—not rich text. Inspection of the opening of `src/components/Composer.tsx` verifies string draft state, a textarea reference, image handling, slash/mention dependencies, and `onSend(text, steer, attachments)`. This is not an exhaustive implementation audit. `CLAUDE.md` establishes shared-protocol ownership, standalone live pi configuration, and watch-server hazards. `pi-config/extensions/mode/minor.ts` asks alignment to investigate and wait for confirmation; `align.ts` parses and persists alignment documents and derives their status. Neither inspected file supplies a project dependency graph or makes confirmation evidence of implementation.

## Two credible architectures

### A. Authored manifest beside incumbent prose — recommended

A small JSON manifest owns identities, membership, dependency edges, and external mappings. Existing Markdown owns behavior. A derived graph and report join these inputs; neither is edited. This is easy to introduce without moving any current spec or adding source annotations. It makes relationships inspectable without teaching a parser Sova's evolving prose conventions.

Its cost is real: the manifest is another authored artifact, and a dependency can be omitted while every JSON check passes. The design must measure the manifest's own changes, report unknown coverage, and make reconciliation examine relationships as well as prose and code.

### B. Markdown-native unit cards with derived indexes

Put small Markdown cards under `.sova/spec/units/`, each with tightly constrained frontmatter for ID, dependencies, source paths, and an authority citation. Derive surface maps and reverse mappings. This co-locates a behavior's explanatory note with its relationships; multiple workers avoid a shared manifest hotspot. A project starting from no spec can put its authoritative prose directly in cards.

The danger is quiet duplication: cards paraphrase existing UX prose, then both become plausible authorities. Frontmatter also demands parsing and precise rules for absent versus empty fields. Choose B if units are numerous enough that one manifest creates editing conflicts, or if most behavior has no incumbent home. Do not support both authoring formats initially. Both options need the same evidence model; choosing Markdown does not solve mapping drift.

An annotation-free, code-derived graph alone is not an adequate third option. Imports can suggest candidates but cannot reliably discover which behavior relies on a persistence promise, nor distinguish navigation from required context. Retain import analysis as optional evidence, never canonical scope.

## Recommended shape and authority

```text
.sova/spec/
  manifest.json             # authored relationships and scope boundary
  proposals/
    rich-composer.md         # desired behavior, explicitly not current
  reviews/
    composer-drafts.json     # one targeted reconciliation record
  README.md                 # short local usage and authority choices
# derived reports are stdout, or disposable cache outside these inputs
```

A deliberately partial example (IDs referenced below require their own records before a usable slice can be published):

```json
{
  "version": 1,
  "coverage": {
    "mode": "incremental",
    "watch": ["src/", "server/", "shared/"],
    "exclude": [{"path": "public/fonts/", "reason": "Vendored assets"}]
  },
  "units": [{
    "id": "composer.drafts",
    "kind": "behavior",
    "intent": "current",
    "authority": [{"path": "spec/04-composer.md", "heading": "Behavior"}],
    "requires": ["session.identity"],
    "references": ["composer.images"],
    "implementation": [
      {"path": "src/components/Composer.tsx", "role": "consumer"},
      {"path": "server/drafts.ts", "role": "persistence"}
    ],
    "evidence": [{"path": "server/drafts.test.ts", "kind": "test-candidate"}]
  }],
  "surfaces": [{"id": "composer", "units": ["composer.drafts"]}],
  "sections": [{"id": "chat-input", "surfaces": ["composer"]}]
}
```

This example is an adoption hypothesis, not a verified full mapping. In particular, it omits draft client state helpers; a first reconciliation must discover and add them. Calling the evidence `test-candidate` prevents a path from masquerading as a passing test.

A **surface** is a user-facing place; a **behavior** is a promise that may cross surfaces or have no UI; a **section** groups work usually investigated together. No mandatory one-file-per-surface retrofit. Stable IDs survive file moves, while paths and heading locators remain checked citations. Membership is authored once. An absent dependency list means “not mapped”; an explicit empty list means “reviewed as having no declared dependencies,” never mathematical independence from everything else.

Existing specs coexist by reference. If two authorities disagree, report the conflict; the manifest does not override them implicitly. Migration into `.sova/spec/` is optional and separate from adoption. “Replicated truth” can mean two things: generated projections of one authoritative statement are useful replicas; independently edited copies of the same rule are competing authorities. Choose the former. If snapshots are needed for proposals or reviews, label their source revision and do not let snapshots become current authority.

## Slicing, blast radius, and context limits

For an implementation slice, expand selected section membership, then follow behavior `requires` edges forward. Include authority, declared implementation entry points, and relevant evidence. `references` remain names plus the reason for exclusion, unless the task explicitly needs them. Shared constraints such as draft ownership get their own behavior node, not repeated rules or a global “read everything” bucket.

For impact analysis, begin at changed units or mapped paths and follow **reverse** `requires` edges; report affected surfaces and sections. Attach navigation/reference neighbors separately as inspection candidates. A code dependency candidate must say “inferred from import,” not look like a reviewed behavior edge. For a mapping or edge edit, traverse the union of before-and-after relationships so deleting an edge cannot erase its former consumers from the reconciliation packet.

Every result carries its root query, input snapshot, inclusion reasons, unresolved nodes, omitted references, and coverage boundary. Count bytes and estimated tokens separately from files. If the selected reading exceeds budget, return a staged reading plan and the omitted frontier; do not silently cut dependency closure and call the result complete. Summaries are navigational aids, not replacements for authoritative passages. Cycles terminate via a visited set and are shown as coupled clusters; unlike foldaidev's build-order policy, real behavior dependencies need not always form a DAG.

## Missing coverage and freshness are different questions

External mappings can go stale even when both files exist. Initially use whole-file paths: coarse invalidation is cheaper and safer than fragile line ranges. Optional symbol selectors can come later, with zero or multiple matches reported as unresolved. Renames generate suggestions requiring confirmation; removed paths stay findings rather than disappear.

At each check compare independently enumerated files in the declared watch boundary with mapped files. Report changed-but-unmapped files, new files, stale exclusions, dangling mappings, and current units with no implementation evidence. A mapped file is **not** a fully specified file. A current unit with no mapping means “implementation mapping missing,” not necessarily “unbuilt.” Proposals without implementation are expected, not failures.

Where available, separately compare a real route/registry observation with documented surfaces in both directions. Record whether it came from source inspection, a live process, or a test; record skipped inputs. A product without an observer remains unmeasured on that axis. File enumeration cannot detect an undocumented branch inside an already mapped file, and neither routes nor imports enumerate all behavior. Periodic focused exploration and new-change review remain necessary.

Separate result dimensions:

1. **Structure:** IDs, schema, paths, and unique heading resolution.
2. **Freshness:** known inputs changed, unchanged, or unavailable since a recorded review.
3. **Coverage:** mapped, unmapped, excluded-with-reason, or unknown within a named population.
4. **Behavior evidence:** tests/observations with their actual scenario and result.
5. **Review claim:** reconciled, unaffected-with-reason, or unresolved.

Never compress these into one green “aligned” badge.

## Targeted reconciliation and lifecycle

A review record binds one behavior to the exact authority bytes, mapped source bytes, mapping record, dependency snapshot, and evidence examined. Include reviewer identity, timestamp, conclusion, rationale, and unresolved questions. Hashes make bytes comparable; they certify neither semantics nor reviewer honesty. Do not fingerprint the receipt itself. Missing historical objects, unreadable paths, or a changed mapping yield unknown or changed—not an automatic fallback to a recent source edit.

For dirty trees, capture the actual working bytes and retain the reviewed diff or content evidence; a bare HEAD reference is insufficient. Recheck inputs before saving the record to catch concurrent edits. If exact working-tree evidence cannot be retained in a first implementation, refuse durable reconciliation until a commit exists while still allowing an explicitly provisional review.

Reconcile only impacted behaviors. Read the diff, the old and new mapping, dependent promises, and named tests; fix prose, implementation, or mapping as appropriate. An “unaffected” record explains why the change leaves the promise intact. No mass “accept current” operation. Old receipts remain historical, not blanket certification.

Intent and observation are orthogonal. Proposal → accepted plan does not mean implemented. Implementation → observed evidence does not mean every promise verified. A proposal cites current IDs and baseline hashes; base movement requests rebase/review. On promotion, update the authoritative current prose and mapping, retain the decision link, and record the actual evidence. Use ordinary Git branches for executable prototypes; avoid an overlay interpreter until same-checkout parallel proposals genuinely need one.

## Rich-text composer: one complete adoption exercise

1. **Ask:** “Replace the textarea with rich text.” Register a proposed `composer.rich-input`, amending the current input behavior; leave the current textarea claim unchanged.
2. **Investigate:** select composer and its known draft/send dependencies. Read `spec/04-composer.md` and relevant image/slash specs. Inspect actual draft helpers, `GroupComposer.tsx`, transport contracts, and callers. The existing string-based interface makes serialization a question, not evidence that rich text is impossible.
3. **Align:** decide Markdown-on-wire versus structured documents; draft compatibility; paste sanitation; keyboard/IME behavior; slash and file mentions; images; group broadcast; accessibility; whether edit formatting must survive reload. Reverse traversal names shared consumers; unmapped group behavior remains an explicit gap. Reject “swap the element only” because it leaves storage and keyboard semantics unspecified.
4. **Implement after confirmation:** on a branch, change only agreed current contracts as implementation lands. Discoveries update mappings; an unexpected protocol change widens the packet and requires coordination under `CLAUDE.md`.
5. **Observe:** test reload, reconnect, rejected send, streaming steer, composition Enter, multiline paste, attachment preservation, and group behavior. Inspect keyboard focus and relevant widths/themes. Report what ran and what did not; a build is not these observations.
6. **Reconcile:** review input, draft, and send promises separately. Record exact candidate inputs and residual unknowns. Promote the rich-text proposal only with the agreed current prose; leave unrelated composer-menu debt visible without requiring a project-wide retrofit.

## First 2 hours and guardrails

**Estimated, not rehearsed:** 0–20 minutes identify authority and boundary; 20–50 map 3–5 composer behaviors and actual entry points; 50–80 hand-produce forward/reverse slices and expose missing edges; 80–110 perform one focused draft reconciliation; 110–120 inspect an intentionally stale mapping and changed input to verify the report would distinguish them. No full-source inventory mandate, no imported doctrine, no code annotations.

Implement tooling only after that manual pilot earns it: one validator, one graph traversal module, and one report format; no graph database, plugin ecosystem, generated checker per project, or automatic semantic pass. Add selectors, observers, and stricter gates only for demonstrated noise or blind spots. Prior aidv2 line caps are evidence of a complexity problem, not our budget specification.

Alignment is a **future consumer**, not phase-one infrastructure. Initially paste the report into Findings and put unknown boundaries in Open questions. Later it can request a read-only slice and impact report with provenance. Keep `align-doc` unchanged until the shared contract is deliberately coordinated. User confirmation approves a plan; it must never advance reconciliation receipts or mark desired behavior as current.
