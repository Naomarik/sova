# Round two — concise claim files, exact review packets, local gates

**Decision proposal only. No retrofit or implementation performed.** Keep round one's JSON relationships plus Markdown prose, adopt foldaidev identifiers exactly, and choose retained working-byte review packets now—not committed-only receipts. Pilot a narrow Sova retrofit before broadening coverage.

## 1. One authoring format, one home per adopted claim

Use Markdown for claims and JSON for relationships. Do not also parse dependency tables, frontmatter, or natural-language citations into semantic edges. A prose citation resolves but does not silently become `requires`.

```text
.sova/spec/
  README.md                 # brief local discipline and authority policy
  manifest.json             # relationships, mappings, census boundary
  claims/
    chat/composer.md
    shared/keyboard.md
    section/chat/input.md
  proposals/                # desired changes, outside current declaration scan
  cut.json                  # retired IDs, reason, optional successor
  reviews/                  # immutable packets, objects, and receipts
  tools/                    # standalone core and version declaration
  .cache/                   # disposable reports, never review evidence
```

Every new artifact stays here, including temporary files. The core requires a documented runtime, not Sova, Git, a particular source tree, or a language-specific parser. Recommend one vendorable stdlib Node entry point initially; its runtime prerequisite must be explicit.

### Concrete minimal example

In `claims/chat/composer.md`:

```markdown
# §chat/composer — Session input

Send a message to one session. While it runs, Send becomes Steer.

## §chat.composer/keys — Submission keys

Enter sends; Shift+Enter inserts a newline. Submission respects §shared/keyboard.
Do not send whitespace-only text without attachments.
```

In `claims/shared/keyboard.md`:

```markdown
# §shared/keyboard — Composition

A composing Enter finishes IME input; it does not submit a message.
```

The shared file owns the IME exception; composer owns the submit gesture and emptiness condition. The citation gives a reader the relationship; the JSON edge below makes it traversable. It does not repeat the exception's wording.

In `claims/section/chat/input.md`:

```markdown
# §section.chat/input — Session input work

Investigate the session composer's submission keys together.
```

Corresponding `manifest.json` fragment:

```json
{
  "version": 1,
  "notation": {"scopes": ["chat", "shared"], "kinds": ["section"]},
  "boundary": {"include": ["src/", "server/", "shared/"], "exclude": []},
  "records": {
    "§chat/composer": {
      "kind": "surface", "requires": [], "references": [], "code": []
    },
    "§chat.composer/keys": {
      "kind": "behavior",
      "requires": ["§shared/keyboard"],
      "references": [],
      "code": ["src/components/Composer.tsx"]
    },
    "§shared/keyboard": {
      "kind": "behavior", "requires": [], "references": [],
      "code": ["src/components/Composer.tsx", "src/components/GroupComposer.tsx"]
    },
    "§section.chat/input": {
      "kind": "section", "members": ["§chat.composer/keys"]
    }
  }
}
```

These are illustrative candidate claims and mappings, not verified implementation assertions. `code: []` says no implementation mapping is supplied, not that implementation is absent. Missing `requires` means dependencies not investigated; explicit `[]` means no further requirements declared. Section membership and surface-child containment are not behavioral dependencies.

**Identifier resolution:** headings declare; JSON keys and ordinary mentions cite. Apply foldaidev's lowercase/hyphen grammar, at most one namespace qualification dot, and computed paths relative to `claims/`: `§chat/composer` and `§chat.composer/keys` resolve to `chat/composer.md`; `§section.chat/input` resolves to `section/chat/input.md`. Scope/kind inventory is local data. There is one resolver. A cut records the old ID, reason, and successor if any; no ID reuse or silent rename. A dependency targeting a cut is unresolved for work even if the historical lookup explains it.

**Heading boundaries:** claim files have one declaring H1 and optional declaring H2 children; no other headings initially. Fenced examples cannot declare. Each child's body ends at the next heading; the parent's body ends before the first child. A child scope includes its parent's lede as labeled orientation, not its siblings. Duplicate IDs, wrong computed paths, unexpected headings, and malformed records are errors, never dropped rows.

### Deterministic prose output

`scope(§section.chat/input)` expands membership and forward `requires`, emitting section lede, parent orientation, requested behavior prose, then dependencies in stable ID order. Shared material is emitted once, with all inclusion reasons. The resulting body contains actual authored sentences, not generated summaries or only filenames:

```text
§section.chat/input [candidate] — requested section
Investigate the session composer's submission keys together.

§chat/composer [candidate] — parent orientation
Send a message to one session. While it runs, Send becomes Steer.

§chat.composer/keys [candidate] — section member
Enter sends; Shift+Enter inserts a newline. Submission respects §shared/keyboard.
Do not send whitespace-only text without attachments.

§shared/keyboard [candidate] — required by §chat.composer/keys
A composing Enter finishes IME input; it does not submit a message.
```

Output also names snapshot, provenance, mapped implementation paths, required unread material, and unknown frontier. Forward keys reaches keyboard. Reverse keyboard reaches keys and reports its section membership; reverse keys does **not** reach keyboard. A hypothetical group-input behavior would appear only if explicitly declared to require keyboard—not because it shares a CSS class or a mapped file. Cycles are traversable coupled clusters, not an infinite walk.

Budget overflow produces whole-unit stages with explicit unread required IDs and token estimates; never truncate an exception or imply a smaller closure is sufficient. Unmapped dependencies and inferred candidates remain visible. Even an exhausted authored closure is not all necessary context.

### Prose discipline and incumbent specs

Write observable conditions and consequences, not templates filled with rationale:

- Before: “In order to ensure safe operation, the user must be prevented from losing their input during an unsuccessful send.” After: “Keep the draft when sending fails.”
- Before: “The composer always clears once the server accepts.” After, for **group input only**: “Clear after every included member accepts. On partial acceptance, keep the draft; retries use the original sent text.”

Use short paragraphs or bullets; keep conditions, exceptions, and negative behavior adjacent. Do not repeat edge definitions, tool instructions, status boilerplate, or the justification for having a rule in every claim. Split only when a behavior needs separate investigation or review. Prose-length warnings are advisory; deleting exceptions to satisfy a cap is a regression.

For Sova, deliberately distill selected numbered-spec passages into candidate claim files. The manifest retains provenance locators, using `path.md` → **Heading**, plus the exact baseline excerpt in review evidence. Until reconciled, incumbent requirements remain authoritative and the candidate is labeled unadopted. Promotion explicitly transfers authority for the named behavior to the concise claim; the manifest records which incumbent passage it supersedes. Incumbent files remain preserved evidence, not independently editable competing truth for that claim. Changes to linked incumbent passages still trigger a conflict/review candidate. Requirements/code disagreement blocks promotion until a decision; do not silently rewrite requirements around a bug.

A project with no spec uses the same claim files, initially labeled candidate, with source/observation provenance instead of legacy prose. No separate grammar. A generated authority index shows adopted versus legacy/unadopted areas. Discovery must consult it before treating old prose as current; this is a real adoption cost to measure.

**Alternative:** frontmatter cards distribute metadata nicely but add a parser and can duplicate relationship syntax. Pure reference-based JSON avoids prose migration but cannot reliably deliver concise scope from Sova's broad headings without a span-selection language. Choose concise local claims plus one structured relationship grammar for this pilot; reverse that choice if migration overhead outweighs the measured reading benefit.

## 2. Review actual working bytes

Committed-only evidence is simpler but would frequently block Sova's ordinary dirty-tree workflow and cannot serve non-Git projects. Hash-only receipts are smaller but lose the reviewed text after editing. Choose **immutable targeted content snapshots**, not whole-repository snapshots and not a new version-control system.

`prepare-review(id)` explicitly writes a packet under `reviews/`, with content-addressed objects shared between packets. This write requires permission; `scope`, `impact`, and `check` remain read-only. The first packet has an absent baseline and establishes no claim about history. Later packets compare against that behavior's last adopted packet, not an arbitrarily advancing HEAD.

The exact input set comprises:

1. Selected claim body and parent orientation; section membership used to select it; applicable local policy bytes and format/tool compatibility version.
2. Own external code mappings and full mapped file bytes, including absence; declared evidence definitions/results actually considered.
3. Forward dependency closure's claim and mapped implementation bytes, applicable review conclusions, and unresolved findings. Receipt identity/timestamp alone is not dependency content.
4. Old and new relevant edges, mapping records, resolved paths, adoption/supersession provenance, and any legacy passages still constraining the claim.

Whole-file source capture intentionally over-invalidates. Keep full container documents as retained provenance, but fingerprint selected claim passages and meaningful graph records rather than unrelated JSON whitespace. Fingerprint membership/path resolution too. Do not optimize away dependency implementation movement: it requests consumer review even when consumer prose is unchanged, without asserting breakage.

Impact uses the union of retained-old and current-new mappings and edges. Deletions are explicit absence; a rename is deletion plus addition until reviewed; adding a path invalidates prior mapping evidence. New files inside the declared boundary appear in an independently enumerated census, even without mappings. They are triage obligations, not automatically dependencies of every unit. Unrelated dirty files neither enter the packet nor prevent recording; changing a boundary or global policy is not unrelated.

Capture reads the input bytes and inventory twice; disagreement refuses the packet. Before recording, compare the live input set again with the immutable packet, then atomically write a receipt under a cooperating-writer lock. This guards detectable races, not a hostile writer's changes between checks. A later check compares again. A receipt always describes its snapshot even if the live tree changes immediately afterward.

Retain reviewer identity, model/version when applicable, author/self-review disclosure, conclusion (`reconciled`, `unaffected`, `unresolved`), specific rationale, observations, and opened-source references. Self-review is permitted but labeled; a second model is not automatically independent evidence. Inputs exclude receipts, retained object storage, and cache to avoid self-reference. Preserve unresolved semantic findings until explicitly addressed; changed bytes cannot erase them.

Non-Git operation is identical. Git commits are optional provenance, never substitutes for dirty bytes. No symlink escape or out-of-root code capture in v1; external dependencies get versioned citations and an unavailable-evidence frontier. Do not snapshot secret files silently: if required evidence cannot safely be retained, decline a durable reconciled claim and name that limitation.

**Four distinct statements:** bytes moved; a prior receipt still applies to these inputs; someone claims to have reviewed them; behavior is correct. Only the first two are mechanically decided. A fresh receipt does not prove the latter two.

## 3. Advisory discovery, blocking local assertions

Use explicit command semantics, not one green badge:

| Condition | Discovery: scope/impact | Work authorization | Record reconciled / completion gate |
|---|---|---|---|
| Malformed graph or duplicate declaration | Refuse normal scope; diagnostic only | Block until repaired | Block |
| Required ID/path unresolved | Return incomplete prose and frontier | Investigate; block dependent implementation | Block affected claim |
| Globally unadopted/unmapped regions | Named boundary warning | Allow unrelated adopted work | No global block |
| Relevant unmapped seam | Candidate + question | Investigate/backfill before relying on it | Block affected claim |
| Relevant inputs changed since review | Mark movement; show old/new impact | Allow reconciliation/fix, not unchanged-truth assumption | New comparison required |
| Known semantic conflict | Quote conflict | Seek decision; permit diagnostic work | Unresolved until decided |
| Required observation failed | Retain scenario/result | Permit repair | Cannot claim reconciled |
| Observation unavailable | Name missing evidence | Align on evidence or narrower claim | Do not certify the unobserved promise |

A proposal is usable desired context but never discharges a current-implementation gate. An explicit user override can authorize work despite uncertainty; it does not convert unknown evidence into reconciliation.

Exits: `scope`/`impact` return **0** for a valid requested known-closure report, even with explicitly labeled global unknown coverage; **1** for relevant incompleteness, staleness, or unresolved findings; **2** when malformed input or I/O prevents a trustworthy requested report. Budget truncation with unread required material is 1. Diagnostics remain available on 2. `check(ids)` returns 0 only when those selected claims satisfy the local evidence policy, 1 for owed/stale/unresolved review, 2 for invalid/unreadable inputs. `prepare-review` 0 means packet produced, not review completed. `record` 0 means the requested claim was stored, including an explicitly unresolved claim; recording a falsely labeled reconciled state is refused where mechanically knowable. Each result includes its population and axis states. Unknown whole-project coverage is never silently upgraded by exit 0.

## 4. Pilot protocol — preserve baseline, test usefulness

Recommend staged adoption, not full Sova conversion. First obtain permission for artifacts and capture exact incumbent working bytes and baseline task materials. No new rich-text feature is authorized: it is a hypothetical planning task.

**Stage A: paired planning.** Compare existing-spec-only investigation with manifest-assisted investigation using equivalent task briefs and disclosed model/settings. Counterbalance task order or use separate fresh sessions to limit learning effects. Start with composer keys, draft persistence, send acceptance, group retry, and representation seams. The inclusion list is a proposed pilot boundary, not a claim of completed mappings.

An evaluator independently reads incumbent requirements and deciding source before scoring the plans. Keep discovered omissions open to further revision; this reference answer is not infallible. Score required seam recall and unjustified scope expansion, not just shorter output. Preserve group's deliberate lack of attachments/slash commands and captured-text partial retries (`spec/14-workspaces.md`, relevant composer rules).

**Stage B: controlled perturbations in disposable fixtures under `.sova/spec/`.** Plant an authority change, mapped code change, dependency evidence change, deleted edge, renamed/deleted mapping target, new unmapped file, new behavior inside an already mapped file, malformed record, unrelated dirty file, and mid-review race. Expect old-edge consumers to remain visible; unrelated dirt must not invalidate disconnected receipts. The inside-file behavior case must demonstrate the blind spot rather than receive an invented mechanical detection claim.

**Stage C: evaluate cost.** Record actual prose tokens read, required material omitted/unread, correctness of reverse impact with reasons, review minutes per changed behavior, extra authoring bytes/files, follow-up maintenance after the planted changes, and false-positive review burden. Compare alignment plans for questions found, unnecessary questions, contradictory assumptions, and preserved group semantics. Treat faster but materially incomplete plans as failures.

**Stage D: portability.** Repeat a small claim/edge/mapping/snapshot exercise in a non-Git fixture with no spec, no `src/`, no Sova, and non-TypeScript source. Tools should need only their documented runtime; no observer execution is mandatory.

Broaden adoption only if required-seam recall is no worse than baseline, no critical group behavior is lost, planted structural/movement cases distinguish their controls, and the operator judges observed maintenance cost worth the reading reduction. Report raw task results; do not generalize a few exercises into universal percentages. If packets become too broad, narrow claim/mapping boundaries before adding selectors or inference engines.

## 5. Minor-mode boundary and remaining judgment

The future mode loads a short discipline: discover local tools; request scope; investigate necessary unknowns; align before nontrivial changes; keep proposals separate; update affected claims and mappings with permission; reconcile exact inputs before claiming completion. It checks a standalone tool version/format declaration at the project root. Absent or incompatible tools trigger an install/bootstrap question—no automatic network execution or global installation. Opening a project is not consent to write claims or receipts.

Alignment consumes prose scope and impact reasons in Findings, and puts missing context/conflicts in Open questions. Confirmation approves work, not evidence. Use existing alignment output without changing its API in this proposal; no Pi API claim is required. Prompt instructions cannot guarantee compliance; the local completion check supplies the limited mechanical enforcement.

Open for pilot judgment: acceptable snapshot storage/maintenance cost, prose migration burden, and which observations are necessary for each promise. These are task decisions, not a new configuration language.

### Verified references and limits

Read the judge synthesis and live foldaidev `docs/identifiers/README.md` (grammar/declarations), `notation.json`, `spec-graph.mjs` through `idToFile` and parsing primitives, `spec/foldaidev/revising.md` (cut/add rename rule), and `docs/identifiers/spec-sync.md` (working-byte candidate and receipt limitations). Foldaidev's implementation distinguishes surface children from section paths; its inventory names are not portable constants. Its source-header convention and acyclic build-order policy are not adopted. Re-read Sova workspace prose around group exclusions, partial acceptance, and captured retry text. Round-one readings covered composer, alignment, aidv2 debates, and abstract-identifiers verification; no check, browser, or implementation audit was rerun here. Only this proposal was written.
