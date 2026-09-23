# Round two (kimi-k3) — decisions

Research/proposal only; nothing implemented. Inputs: `../round-two-brief.md`,
the judge's `../astra-judge/synthesis.md`, re-read references. Counts cited are
only ones I verified this session; the tree was dirty when checked.

## Corrections I accept from round one

- My worked reverse traversal contradicted my own edge direction: reverse
  `composer` does **not** reach its requirements. Fixed below with a graph
  whose forward and reverse listings are both derived, not asserted.
- I denied dependency-induced review invalidation ("neighbors' receipts stand
  unless their own prose changed") — wrong; a dependency's evidence is an
  input to the consumer's receipt. Adopted in §2.
- The tool lives inside `.sova/spec/`, not `tools/` — "all new artifacts in
  `.sova/spec/`" is settled.
- I overclaimed foldaidev's dirty refusal (its `--reconcile` checks authority
  dirt, not code dirt). My §2 model is built fresh, not inherited.

## Decision 1 — format: markdown units, one grammar, § identities

**Chosen.** Foldaidev's convention verbatim (verified, not copied blind):
`§<namespace>/<name>`, lowercase-hyphen; the namespace **is the file address**
under `.sova/spec/`; one qualification dot names a heading inside that file —
`§composer/input` → `.sova/spec/composer/input.md`, `§composer.input/drafts` →
a heading in it. Deeper nesting is refused: a unit that wants a grandchild
splits. A heading beginning `§` declares; any other occurrence cites
(positional rule, `docs/identifiers/README.md` "One declaration rule").
There is no rename: cut + add, cut registered (`spec/foldaidev/revising.md`
"Rename a surface"); our register is `.sova/spec/cut.md`. Namespace inventory
is declared data in our one config file (as `notation.json`'s `scopes` are
data), never hardcoded.

**Authority, per fact, one home.** A unit is a *behavior* (a promise or
constraint — surfaces and persistence rules alike; cross-cutting behaviors
are ordinary units, aidv2 Q-006). Each unit's claim text is either:

- `Authority: spec/04-composer.md → ##Behavior` — a cite to an incumbent
  section that owns the promise (Sova's retrofit default; the incumbent file
  is read, never copied or relocated), with **heading boundary = from that
  heading to the next same-or-shallower heading**, or
- the unit's own claim paragraph (the only option in a spec-less project).

Both set is a malformed-record finding. Two citations of different homes are
complementary until a person records the actual incompatible sentences; the
checker detects duplicate authority declarations, never sentence
disagreement. Incumbent `§N` numbering stays the incumbent's grammar, cited
by path; existing `§N` code comments are optional discovery clues only.

**The one authored grammar** is five line shapes in unit files: the `§`
heading, `Requires:`, `Sees:`, `Code:`, `Authority:`. Receipts and derived
data are machine-written JSON under `reviews/` — not authored, so not a
second grammar. Alternative evaluated and rejected: the judge's
JSON-manifest-plus-markdown split — its IDs are locators, not computable
addresses, which the settled convention forecloses (and the brief bars
invented dotted IDs). Also rejected: importing foldaidev's brief layers
wholesale (its surface/section/flow split serves a UX brief; our units key
on behavior).

```markdown
## §composer.input/drafts — composer drafts            ← declares
Authority: spec/04-composer.md → ##Behavior ("Drafts are never discarded")
Requires: §shared/message-text
Code: src/lib/draft-save.ts · server/drafts.ts

Draft survives disable, reconnect, reload; whitespace-only text deletes the
stored draft. (claim text only when Authority: is absent)
Scope: session composer only — §workspace/input manages no drafts.   ← boundary
```

Minimal, no scaffolding: the "Scope:" line is written only when a unit could
be mistaken for a neighbor (the exception earns a line; absence needs none).
**Terse prose rule:** a claim names an observable, never a mechanism; cut any
sentence a check cannot someday read nor a reviewer falsify. Before: *"The
system robustly handles drafts via a persistence layer."* After: *"Reload
mid-draft: the text is back. Clear the box to whitespace: the stored draft is
gone."*

**`scope(§id)` output is assembled prose, deterministic:** query unit's claim
(or authority excerpt) first, then each requires-closure member depth-first
in file-then-line order, duplicates collapsed after first inclusion, then a
footer: known closure list; **unknown frontier** (requires absent = "not
mapped", unresolved IDs, ignored dirs, and behaviors inside a mapped file the
manifest does not claim — mapping a file never claims all of it) each named; inferred inspection
candidates in a separately labelled block; declared scan boundary; bytes +
estimated tokens; and over budget a staged plan that **lists unread required
material explicitly** — truncation never reads as completeness. A malformed
unit prints `! malformed <path>:<line>` and the walk continues over the rest;
scope never silently shrinks.

## Decision 2 — dirty-tree review records: hash-and-provenance receipts

Options: committed-only receipts (unusable — Sova's tree is chronically
dirty); foldaidev-style commit pointers (`stale.mjs` `reconciled.json` —
assumes commits are the reviewable unit; they are not here); **chosen:
receipts bind exact reviewed bytes, flagged by provenance.**

A receipt (one JSONL append under `reviews/§<ns>/<name>.jsonl`) records: §id;
fingerprint format + tool version; `base.kind: commit|worktree`; the **input
set** — `(path, sha256 | absent)` pairs for the unit's claim bytes/authority
span, every `Code` file, the `Requires:`/`Sees:` lines of the unit **and of
every closure member**, the fixed always-read files, and the config's scan
boundary declaration. Receipt files and `.cache/` are excluded from every
input set (no self-reference).

Semantics, four separately named axes:

- **Movement:** re-hash inputs; any mismatch (edit, rename → old path
  `absent` + new path unrecorded, deletion → `absent`) = `moved`, with which
  input. Movement is not breakage.
- **Applicability:** a receipt applies while all *its own* inputs match
  **and** no requires-closure member's evidence moved. Dependency movement
  flips consumers to `review-needed` over reverse `requires` — an obligation
  to compare, never a verdict of broken; the consumer's next receipt may read
  `unaffected — <reason>`. Impact packets are computed over the **union of
  old and new mappings/edges**, so deleting an edge or a `Code` line cannot
  erase its old consumers.
- **Correctness:** never machine-reported.
- **Claimed review:** reviewer identity incl. model, self-review disclosed as
  such (never labelled independent), conclusion, rationale, unresolved
  questions, retained diff summary.

Dirty-tree rules: `base.kind: worktree` receipts are **provisional** and are
never attributed to HEAD; if a later commit's bytes hash-match the recorded
inputs exactly, `check` computes the promotion at read time (no rewrite).
Unrelated dirty files are not inputs and never block. Race control:
record-time re-hashes inputs immediately before append; a mismatch aborts
the receipt — no receipt certifies bytes that changed mid-review. A failed
hash (file vanished) is `unknown`, counted, never green. **Non-Git:**
everything works with `worktree`-kind only, and the report footer reads
`durability: unsupported` — Git is an accelerator, not a requirement.

## Decision 3 — gates: small matrix, no vague green

`m = .sova/spec/tool/sova-spec.mjs`. Exit codes only on `check`: 0 findings-clean
over the adopted set, 1 findings, 2 could-not-measure (no code root, empty
population — a pass over nothing is banned). No global badge: every command
ends `adopted N of M mapped behaviors · K excluded (reasons on file)`.

| Finding | `scope` | `impact` | `check` | mode: align | mode: implement |
| --- | --- | --- | --- | --- | --- |
| Malformed record | named, walk continues | named | **exit 1** | block capture of that unit | warn, tool still runs |
| Unresolved § / dangling Code path | named in frontier | named | exit 1 if in adopted set, else reported | shows | shows |
| Unmapped file (census) | — | candidate block only | reported+counted, never 1 while adoption incomplete | shows | shows |
| Inputs moved on adopted behavior | — | `review-needed` consumers | **exit 1** | shows | shows |
| Semantic conflict (person-recorded) | — | named | exit 1 until resolved | **block confirm** | block nothing; finding stands |
| Observation failed / empty population | footer says so | footer | **exit 2** | block capture | block nothing |

Incremental adoption is preserved: everything unmapped is *reported*, never
*blocking*; only the adopted set (explicit `Adopted: <date>` line per unit —
a recorded act, not a knob) can fail the gate. **Config, openly chosen:**
one `.sova/spec/config.json` (±5 keys: code roots, ignore-with-reasons,
unit namespaces, always-read files, token budget). aidv2's no-config rule is
deliberately not imported — portability demands declared roots; no key can
disable a check or mark anything reviewed.

## Decision 4 — pilot plan (plan only)

**Baseline preserved:** tag `spec-baseline-2026-09-23`; incumbent `spec/`
untouched; comparison is per-fact authority citations measured against the
tag, not a rewrite. **Staged, earned triggers, no full rollout.**

- **Stage 0 — no-spec fixture.** Temp dir, five hand-made source files, no
  spec, half the runs without Git. Bootstrap, author two units, run
  `scope`/`check`. Measure: minutes, authored lines, frontier honesty, the
  `durability: unsupported` footer. Proves portability before Sova touches
  anything.
- **Stage 1 — composer namespace on Sova.** Units: `§composer/input` (+ child
  headings `drafts`, `send`), `§shared/keyboard`, `§shared/message-text`,
  `§workspace/input`, `§workspace/batch`. Edges **proposed, to be authored
  from real reads in the pilot**:

  ```text
  §composer/input    requires §composer.input/drafts · §composer.input/send · §shared/keyboard
  §composer.input/drafts · §composer.input/send      require §shared/message-text
  §workspace/input   requires §shared/keyboard · §shared/message-text · §workspace/batch
  §workspace/batch   requires §shared/message-text
  ```

  Forward `scope(§composer/input)` = input, drafts, send, keyboard,
  message-text (5 units, message-text included once at first reach). Reverse
  `impact(§shared/message-text)` = drafts, send, composer/input,
  workspace/input, batch. Reverse `impact(§composer/input)` = **nothing** —
  stated, because nothing requires it. `§workspace/input` declares **no**
  edge to image or slash units and its unit file's `Scope:` line says the
  omission is deliberate (verified: `GroupComposer.tsx` implements its own
  textarea without attachments; the shared `.composer-input` class at
  `GroupComposer.tsx:225-226` / `Composer.tsx:866-867` is a discovery
  candidate, listed under impact's *candidate* block — never inheritance,
  and a planted pilot assertion enforces that).
- **Stage 2 — evaluation cases (planted):** drift an adopted Code file
  post-receipt (expect `review-needed` on the unit and its reverse
  dependents); delete one edge (impact must still flag the old consumer via
  old∪new union); add a new source file (census names it unmapped); `git mv`
  a mapped file (movement + rename proposal, no auto-attest); inject a
  malformed unit (scope names it, does not shrink); set token budget tiny
  (expect staged plan with unread required list); dirty the tree mid-review
  (receipt aborts; worktree receipt never attributed to HEAD).
- **Metrics, with a gold set authored by hand BEFORE any `scope` run** (from
  verified seams: `Composer.tsx`, `draft-save.ts` 69 lines, `server/drafts.ts`
  164 lines, `GroupComposer.tsx`, `spec/04-composer.md` Behavior/Anatomy
  spans — established as representation seams, not end-to-end correctness):
  slice bytes + est. tokens vs gold; **gold omissions must be zero** and the
  frontier must name what the slice honestly missed; false inclusions;
  reconcile minutes and authored lines per receipt; authored footprint lines
  per unit. Alignment A/B: run the rich-text-composer hypothetical twice —
  once with grep/reading as today, once with `scope(§composer/input)`
  assembled prose pasted into the align doc's Findings; compare tokens, the
  seams each run discovers (does the no-scope run find the separate
  GroupComposer and the string-payload draft seam?), and question quality.
  Rich text is an evaluation task, not an authorized feature.
- **Expansion trigger:** Stage 3 (transcript, session-list) only if gold
  omissions = 0, `unaffected` receipts land within reason, and authoring ~
  ≤40 lines/unit. Otherwise revise format first.

## Decision 5 — integration boundary

Minor mode precedent is verified: `pi-config/extensions/mode/minor.ts` —
minor modes are injected prompt blocks (`MINOR_INSTRUCTIONS` →
`buildMinorPrompt`), prompt-level only. So `spec` mode loads a ~15-line
block: before non-trivial edits run `m scope §id`; cite §ids; after edits run
`m review §id` (the tool, never prose, writes receipts); a reconcile claim
without a receipt reads as unreviewed. **Discovery:** mode is inert without
`.sova/spec/config.json`; with it, it install-checks `node ≥ 20` and the
tool's version handshake, else reports unusable. It asks permission once
before bootstrapping (`mkdir` + seed) or writing any review file; it never
bootstraps silently and never edits extensions/server. **Alignment
composition:** Findings gains one line — `Scope: §composer/input → 5 units ·
frontier: §workspace/input not mapped` — and `confirmed` approves a plan, not
a receipt; an exported change becomes `§change/<date>-<slug>`, which declares
`Amends:` and is never a current-truth claim. The prompt block does not
guarantee compliance and says so; the enforcement point is the tool.

## Unresolved · limitations

Unresolved: kind namespaces beyond `change`/`question`; symbol-level `Code`
selectors (deferred until whole-file noise is measured); mandatory
independent review (recommend disclosed self/model review accepted, never
labelled independent); whether authority spans hash whole-section or need
finer granularity in practice. **Limitations:** no code was run; the pilot
graph above is a hypothesis to author from real reads; no complete-context or
semantic-correctness claim is made for anything here.

**Verified references (read this round):** foldaidev `spec-graph.mjs`
`idToFile` (:79-89), `notation.json` (scopes as data), `revising.md` "Rename
a surface"; Sova `GroupComposer.tsx:225-226`, `Composer.tsx:866-867`,
`draft-save.ts` (69 lines), `server/drafts.ts` (164), `pi-config/extensions/
mode/minor.ts` (prompt-only minor modes); `astra-judge/synthesis.md`.
