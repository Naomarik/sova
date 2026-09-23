# `.sova/spec` — an implementation manifest for Sova

A brainstorm proposal. **Nothing below is implemented.** Claims about existing
work are marked *(observed at path)*; everything else is *proposed* or
*unverified*, and says which.

The manifest answers four questions an agent or reviewer is otherwise left to
grep: **what are the features, which code serves each one, what must I read
before changing this one, and when did someone last check my slice is still
true.** It lives entirely in `.sova/spec/` — no source annotations, no full
retrofit, no generated site.

## 1. Grounding: what each reference actually contributes

*(Path = where observed; none of this is binding.)*

- **aidv2** (`~/github/aidv2/INVARIANTS.md`): "Not measured is never green" —
  a check that couldn't run names that, and no knob turns a check off. Also:
  prose truth is unmeasured and every run must say so (`DECISION.md`'s
  `REVIEW REQUIRED` tail). `DECISION.md`'s per-target table shows the winning
  shape: a seed + one checker + falsify ritual, hours not days per target.
- **aidv2 debate**: Q-003 (sync detection: receipts keyed to a unit→source
  map), Q-004 (the graph decision: identifier/edge machinery "lost on concept
  count" yet `scope.mjs` measured 1,359+2,193 of 9,705 lines — a 63% cut —
  from ~200 lines of follow-the-edges code), Q-006 (cross-cutting behaviour is
  an ordinary node, just one with no address), Q-007 (speculative layers:
  a layer's claims are *expectations*; "not merged is never truth").
- **foldaidev** (`spec/foldaidev/brief/README.md`, `docs/identifiers/`):
  surface/section composition (one file per surface; sections say what's built
  together); `§` ids whose namespace *is* the file path — computed, never
  looked up; `scope.mjs` follows **only dependency edges** because "navigation
  is cyclic" (`scope.mjs` header); `stale.mjs` grades staleness with **two
  clocks** — recorded (a human-attested commit) vs derived (last commit to
  touch the surface's code) — and prints which clock answered, because "a
  surface reading `clean` off a derived clock has not been checked by anybody;
  it has merely been touched recently." Three states: moved / clean / unknown,
  unknown never green.
- **abstract-identifiers** (`doctrine/PRINCIPLES.md`, `verification.md`):
  a fact has exactly one home, chosen by what kind of fact it is; a check
  states what it proves and **a partial population reports a qualified pass,
  never a bare one**; meaning agreement is a *third proof* held by a person,
  recorded in a receipt — never implied by structural green.
- **Sova**: `spec/` is a UX spec in numbered files (`spec/overview.md`,
  `spec/04-composer.md`…), keyed by `§N` numbers that already show insertion
  suffixes (`04b`, `04c`…). The align minor mode
  (`pi-config/extensions/mode/align.ts`, README §"Alignment doc") captures a
  heading-anchored `## Alignment:` block with Findings / Approach / Open
  questions / Rejected, and a status walk: `aligning → questions-open → ready
  → confirmed → implementing`. That lifecycle is the natural carrier for "this
  change is desired, not yet true."

Two observed liabilities the manifest must not inherit: foldaidev's
`// Surfaces: §…` header lines in source (`docs/identifiers/README.md`,
"A head line is for the files whose location cannot say it") — excluded by the
brief; and `stale.mjs`'s dependency on those headers (`stale.mjs`,
`claimedBySrc` — a surface whose files lost headers "drops out of this sweep
entirely rather than reporting clean").

## 2. Two competing architectures

### A. Docs-first: authored feature docs, one checker

A human/agent-authored markdown file per feature carries a small structured
block (Depends, Code, State). One checker resolves them, computes slices and
blast radius, runs the census, and grades staleness. Prose is the authority;
structure is what the machine can hold.

**For:** prose semantics live next to the facts; the authorship cost is
visible; the tool stays small. **Against:** the structured block is authored
and can rot — `Depends on` truth is not machine-checkable, only its resolution
is (I-002's own pushback: "a scope computed over stale edges is a confident
wrong answer"); and the spec-to-code mapping, kept in the docs, is one more
list per doc to keep true.

### B. Data-first: one machine-owned `manifest.json`, prose rendered

A single JSON tree (features, edges, code globs, receipts) is the only truth;
docs are generated views. **For:** one parse, one home for every fact, queries
are trivial, receipts can't drift from the tree they grade. **Against:** the
lifecycle of *desired vs current* is narrative, and JSON is where nuance goes
to become a status field — abstract-identifiers principle 4 warns a typed
status "goes stale in the direction that flatters the project"; authoring UX
is poor (PRs edit JSON); and a generated doc a person edits is a diff war.

### Recommendation: A, with one exception borrowed from B

Docs-first. The single data file kept is `.sova/spec/reconciled.json` — a
receipt register, written only by the checker's `--reconcile`, exactly
foldaidev's `src/reconciled.json` pattern. Everything else is prose with
declared blocks. What settles it: the manifest's hardest content is the
*desired/current* narrative and per-feature judgement ("this list says which
files matter, not that they're true"), which prose carries and JSON flattens;
while the manifest's hardest *mechanical* content (which commit, which clock)
is precisely what receipts carry and prose falsifies. Tradeoff accepted: the
authored Dep lists can rot, so A **must** ship its audit check (§3) or the
graph is decoration — I-002's condition, adopted whole.

## 3. The design

### Tree

```text
.sova/spec/
  README.md            method: the 7 concepts, the rules, what this refuses
  manifest.json        4–6 lines: code roots, e.g. {"codeRoots": ["src","server","shared"]}
  features/
    composer.md        one feature per file; the file path IS the address
    attachments.md
    transcript.md      (a group is a feature file with a Group heading — no kind yet; see §7)
  changes/
    2026-09-30-rich-text-composer.md   a desired change; lifecycle §4
  reconciled.json      receipts; checker-written, human never edits
tools/
  spec-manifest.mjs    the one tool (scope, blast, census, check, reconcile)
```

No sigil grammar. **The address is the relative path minus `.md`**:
`features/composer`. Computed, never looked up (aidv2 and
abstract-identifiers principle 2 agree on this much); Sova-only, one repo, so
cross-repo grammar buys nothing.

### One feature doc (the whole schema)

```markdown
# features/composer — Composer

State: current.   Behavior authority: spec/04-composer.md (UX promises; never copied here).
Depends on: features/attachments · features/slash-commands
Sees: features/transcript (sends into it; not a build dependency)

## What this is
Two sentences. What the composer is and must never do — implementation-facing.

## Code
- src/components/Composer.tsx        input, send/steer/stop, auto-grow
- src/components/ComposerMenu.tsx    the flyout
- src/lib/…                          drafts persistence client
- server/chat-manager.ts :499-501    steer-vs-prompt split (behavior seam)

## Verify
Reconciled 2026-09-30 at <commit> by <who> — receipt in reconciled.json.
```

`State` is one of `current | proposed | retired`. Only `proposed` may appear
**and only in `changes/`** — a feature under `features/` with `State:
proposed` fails the check, because Q-007's rule holds: *not merged is never
truth*. `Code` entries are paths or `path:L1-L2` for a seam inside a file;
a bare directory is refused (claim what you read, not a tree).

### Authored graph, inferred audit

`Depends on` is authored: *to build or correctly edit this feature, you must
read that one.* Direction gives both queries for free: **forward closure =
the read slice**, **reverse closure = blast radius**. Citations that aren't
dependencies go under `Sees:` (names only, never traversed — foldaidev's
navigation/dependency split, `scope.mjs` header, observed).

The audit (I-002's pushback, implemented): **every path a feature doc
mentions must appear in `Depends on` or `Sees:`**, else the check fails with
`file:line`. An authored edge can still be *wrong*, and the checker must say
so — every run prints: *edges are authored claims; their resolution is
checked, their truth is not.*

### Slices and unknown coverage

`node tools/spec-manifest.mjs slice features/composer` prints: the dep
closure's files, each with its Code files, plus the fixed always-on set
(`README.md`, `CLAUDE.md` — Sova has no `revising.md` yet; add method there,
not a fixed read). **Explicit unknowns:** any closure feature whose `Code`
list is empty-unchecked, and every feature the closure *names but that has no
file* — printed as `uncovered`, counted, never blank (foldaidev `where.mjs`'s
`\xB7 = no declaration in that tree` discipline: "Nothing is never silent").

`census` answers the inverse: every file under `codeRoots`, minus every
claimed `Code` entry, minus `manifest.json`'s optional `unclaimed` list
(entries must each carry `none — <reason>`, aidv2's honest-opt-out shape) —
printed as **uncovered, with a count**. Day one this is ~260 files (270
`.ts`/`.tsx` exist under those roots today, measured); the number is the
feature, not an embarrassment. A file appearing in the repo that nothing
claims and nothing excuses is a finding on the next check run.

### Drift: mechanical vs semantic, and targeted reconciliation

**Mechanical drift** — a `Code` path no longer exists (rename, delete,
slice bounds moved): exact, checked, exit 1 with `file:line`.
**Semantic drift** — a sentence stopped being true: *no hash or graph sees
this*, and the tool never claims otherwise. The proxy, adopted from
`stale.mjs`: each feature has two clocks — **recorded** (`reconciled.json`
— someone re-read the code against the doc and attested a commit) and
**derived** (last commit touching its `Code` files, free, from git).
`check` reports per feature: `reconciled` / `derived-only` (clean means
"touched recently", not "checked by anybody") / `moved` / `unknown`
(could not measure — never green, never counted clean). `reconcile
features/composer [<commit>]` writes the receipt; it **refuses while the
feature's prose or code is dirty**, because a receipt pinned to bytes nobody
could have read certifies nothing (observed rule in `stale.mjs`, same
reasoning). Reconciliation is *per feature and targeted*: a drifted
`transcript` never invalidates `composer`'s receipt.

### Exit doctrine

`check` exits 0 (checked, clean) / 1 (findings) / 2 (nothing could be
measured — no code root, empty census: a PASS over nothing is believed twice
a week). Every check that ran prints its population and what it does *not*
establish; the run always ends with the line: **semantic agreement is a
review, not a check.**

## 4. Lifecycle and alignment integration

`State: proposed` content lives in `changes/<date>-<slug>.md`, same block
schema plus `Amends: features/composer` lines naming what it shadows.
Merger = editing the feature doc(s) and deleting the change file (git keeps
the graveyard free). This answers "desired vs verified current" structurally:
*location is the truth-status*, no status field to flatter.

**Align integration (proposed, unverified):** while `align` is on, before
`## Approach`, the agent runs `blast features/<x>` and pastes the reverse
closure as an `Affects:` list into the align doc; the user confirms approach
*and blast radius* together. On `confirmed`, the align doc exports to
`changes/…` (`align.ts` already derives the status walk; the handoff is
convention in v1, a small hook only if it proves out). On implementation end,
`check` failing on a change file's new `Code` entries that nothing serves is
the natural landmine catch.

## 5. End-to-end: rich-text composer

**Desired change** (hypothetical): replace the plain `<textarea>` (current,
observed `spec/04-composer.md` anatomy and `src/components/Composer.tsx`)
with a rich-text input rendering inline path-chips.

1. `/mode align on`. Agent runs `slice features/composer` → reads composer,
   attachments, slash-commands docs + their Code files (~6–10 files, not 270).
2. `blast features/composer` → `attachments`, `slash-commands` depend on it
   (strip layout, menu trigger); align doc records `Affects:` them. User
   confirms — blast radius is part of the confirmation, not a surprise in
   review.
3. Doc exported as `changes/2026-09-30-rich-text-composer.md`,
   `Amends: features/composer` — the mainline stays true while work proceeds.
4. Implementation adds `src/components/ComposerRich.tsx`. Next `check`:
   census reports it **uncovered** → the change file claims it; mechanical
   failure gone, semantic claim still *proposed* by location.
5. `spec/04-composer.md`'s anatomy block still shows `<textarea>` — the
   change file's Amends line names this explicitly as a UX-spec edit owed;
   nothing pretends the UX spec was updated.
6. Done: feature doc updated (new Code entry, one prose sentence), change
   file deleted, `reconcile features/composer` — recorded clock at HEAD.
   `blast` neighbors are re-read spot-checked; their receipts stand unless
   their own prose changed.

## 6. First two hours

0:00 `mkdir -p .sova/spec/features`; write README.md (method, ~80 lines) and
`manifest.json` (the three code roots).
0:20 Write `features/composer.md` properly — from `spec/04-composer.md` *and*
a real read of `Composer.tsx`/`ComposerMenu.tsx`/`server/chat-manager.ts`
steer split. Skeleton `attachments.md`, `transcript.md`.
0:50 Write `tools/spec-manifest.mjs` core: parser, census, paths-exist check,
exit codes. Run: census prints ~260 uncovered (explicit, counted), 3 features
resolve, exit 0.
1:25 Falsify ritual: rename a Code path → expect exit 1 naming it; drop a
path → census reports it uncovered; restore → exit 0. *(A check never seen
failing is not a check.)*
1:40 `reconcile features/composer` at HEAD. Commit: 5 files (+tool), zero
code edits. Day-one state: 3 slices real, everything else named uncovered —
no green claimed that wasn't checked.

## 7. Complexity budget and guardrails

Concepts (8): feature, address=path, depends, sees, code-claim, receipt +
two clocks, change-file, census. Tool budget: **≤450 lines** stdlib-only
(aidv2's caps informed this shape but are not adopted as requirements).
Growth guardrails: a new concept must (a) name the failure it prevents,
(b) say why the existing 8 can't express it, (c) ship its check or state
plainly that it's uncheckable. A `Group` kind is the expected first
addition (foldaidev's sections; Q-006's cross-cutting nodes are ordinary
features with an `none — reason` Code list) — *when a real surface file
wants one, not before.* If the tool crosses budget twice, that's evidence
the docs-first split was wrong, revisit §2B.

## 8. Open questions I did not decide

- **UX-spec coexistence.** Candidates: (a) `features/*.md` cite `spec/§N`
  as behavior authority, forever (my lean; replication hazard is real — two
  documents describing the composer must be told apart by *kind of fact*:
  UX promises in `spec/`, implementation mapping in `.sova/spec/`, and the
  line must be stated in both READMEs, or the second copy goes stale
  silently); (b) absorb per-fact migration; (c) leave `spec/` untouched and
  let `.sova/spec` grow its own behavior notes. Also unresolved: `spec/`'s
  numbered addressing (04b/04c suffixes observed) vs stable slugs — a
  migration with its own cost, not a precondition for this manifest.
- **"Replicated source of truth"** for facts that genuinely span both
  (e.g. composer send behavior): which file owns which sentence, and is the
  routing rule itself checked or reviewed? Unanswered; the manifest should
  start by citing, never copying, and log every conflict hit in practice.
- **Tool home:** `tools/spec-manifest.mjs` (repo convention) vs inside
  `.sova/spec/` (fully portable). Data must be portable regardless; the
  tool's location is cosmetic but worth deciding once.
