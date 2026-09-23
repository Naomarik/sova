# Proposal — a project-local `.sova/spec` implementation manifest

glm-5-3 · independent proposal for the spec-system brainstorm · 2026-09-30

Research only. Nothing here is implemented, and nothing here edits an existing file. Every
claim below is labelled **verified** (I read or measured it today), **recorded** (a cited
document in a reference repo asserts it; I did not re-measure), or **proposed** (this
document's design). The one rule the whole document bends around, from the brief: **no
graph check may be presented as proving complete context or semantic correctness** — and
every architecture below says where its checks stop.

## 1. The problem, in current terms

Sova today: 23 markdown files under `spec/` (~8,104 lines, **verified**), a dense
`CLAUDE.md`, and 275 source files under `src/ server/ shared/` (**verified**). Nothing
mechanical connects them. The spec's own overview restates facts owned by code — the
"Class index (all in `src/design/base.css`)" table (**verified**, `spec/overview.md`) —
which is replicated truth with no check, the exact shape `~/github/abstract-identifiers`
was built against: "in one real codebase… **every hand-maintained cross-reference had
already rotted**" (**recorded**, `doctrine/verification.md`).

Wanted: a portable, lightweight, incrementally adopted manifest under `.sova/spec/` that
(a) maps current implementation to spec concerns with **zero source-code annotations**,
(b) computes **feature/behaviour slices** and **alignment blast radius**, (c) detects
stale/missing coverage honestly, (d) supports targeted reconciliation, (e) separates
desired changes from verified current truth.

## 2. What the reference projects already measured

- foldaidev's tooling works but is heavy: `docs/identifiers/` totals 20,004 lines
  (**verified**, `wc -l`). Inside it, `scope.mjs` cuts a section's read set to 1,359 scoped
  + 2,193 fixed lines of 9,705 (**recorded**, aidv2 `debate/questions/Q-004…` citing I-002),
  and its header states why only dependency edges traverse: navigation is cyclic and
  "following every edge out of a section reaches nearly all of them" (**verified**,
  `scope.mjs` header).
- foldaidev's staleness design is the honest core: two clocks (recorded receipts in
  `src/reconciled.json` vs a derived last-commit clock), three states `moved / clean /
  unknown`, "`unknown` is never green", and the measured failure — `§worktree/share` read
  clean while its authority had moved `+73 −20`, because a later commit repointed one
  comment (**all verified**, `docs/identifiers/stale.mjs` header). `spec-sync.mjs` prints
  a LIMITATION string naming what it cannot prove: reading, reviewer independence,
  natural-language agreement (**verified**).
- foldaidev's edge-in-source (`Surfaces:` headers checked onto every `src/` file,
  `stale.mjs` → claimedBySrc) is **forbidden here by the brief** — no retrofit, no
  annotations. That constraint is the main design pressure this proposal answers.
- aidv2's frozen decision (`DECISION.md`): paths as identifiers, no sigil, derived tables
  over authored ledgers, exit 0/1/2 with per-space NOT MEASURED, `run`/`read` dump
  provenance, a falsify ritual, a `REVIEW REQUIRED` tail, no config file, and hard caps
  (12 files / 1,250 lines) as *caps, not goals* (**all recorded**). Its open questions are
  this task's questions: Q-003 (change-triggered receipts), Q-004 (graph restore —
  "adding `§` later rewrites every citation"; and "a scope computed over stale edges is a
  confident wrong answer, worse than grep"), Q-006 (cross-cutting behaviour with no
  address), Q-007 (speculative layers: `Amends:` shadows, expectations-not-claims, a
  layer "never reads red and never reads green… *not built yet*", collision-with-mainline
  the one red) (**all recorded**).
- aid's doctrine: three layers (unit / group / address ledger), mechanism tree beside them,
  mechanical `∀` invariants (`depends-acyclic`, `verbs-in-right-table`,
  `edge-stated-at-source`, `rows-read-or-rejected` — a row that fails to parse is a
  finding, never a drop), readiness "derived, never a status field", `manual: true`
  recorded rather than hidden (**all recorded**, `doctrine/invariants.md`, `README.md`).

## 3. Architecture A — authored manifest, machine-checked claims

**Canonical artifact: the manifest.** `.sova/spec/units/*.md`, one file per concern, id =
its path (`units/composer`, no sigil — ids live only inside `.sova/spec/` and command
output, so the grep-exactness argument for `§` (note-opus §5, **recorded** via Q-004) has
no route strings to collide with). A unit file holds *only* index facts — gloss (≤1
sentence), `Spec:` prose paths, `Code:` paths, `Depends on:` unit ids, reconcile receipts —
never behaviour prose (**one home per fact**, aidv2 INVARIANTS.md). Everything else —
dependents, slices, coverage, staleness, layer diffs — is **derived on every run and never
persisted**, so nothing authored can drift from a derived table (aidv2's no-ledger rule).

**Composition** is closure, not containment: a feature = a unit plus its `Depends on`
transitive closure plus a small declared FIXED always-read set (foldaidev seeds `FIXED =
['README.md','rules.md']`, **verified** in `scope.mjs`). Behaviours without addresses
(persistence, retries — Q-006's case) are ordinary units whose `Code:` may be
`maps: none — <reason>`, legal and counted, exactly aidv2's `reachable: none` precedent.

**Edge semantics**: a closed verb table, ≤5 verbs, frozen; only `depends on` traverses for
slices; blast radius traverses its reverse (finite because `depends-acyclic` is checked);
`relates to` never traverses. Edges are stated at source (in the depending unit's file)
per aid's `∀ edge-stated-at-source`.

**Checks** (one stdlib-only Node file, **proposed**): rows-read-or-rejected; ids resolve;
paths exist; verbs legal; graph acyclic; receipts name commits git still has; coverage
sweep (files claimed by no unit are *named in the summary*, foldaidev's claimed-by-no-code
inversion, **verified** precedent in `stale.mjs`); staleness = the two-clock/three-state
design with `--reconcile` receipts that refuse an uncommitted spec HEAD. Exit 0/1/2; every
run ends `REVIEW REQUIRED` naming what no check measures.

**Strength**: smallest concept count; slices and blast radius are first-class; the
existing `spec/` stays the prose authority, cited by path. **Weakness**: the authored
`Code:` mapping is exactly the hand-maintained cross-reference that rots (§5).

## 4. Architecture B — derived substrate, confirmed exceptions

**Canonical artifacts: the code and spec trees themselves.** A scanner derives, per run:
spec units from `spec/*.md` headings; an address space of REST/WS routes from `server/`
plus `shared/protocol.ts` (the wire contract exists, **verified**); containment edges from
imports; file inventory. Humans author *only* exceptions and receipts: exemptions, a small
overlay of dependency edges the scanner cannot see, reconcile records. The graph is output,
never input — it cannot rot as edges, because it is never stored.

**Strength**: rot is structurally impossible for the derived half; address coverage
(route-vs-`shared/protocol.ts` agreement) is aidv2's one demonstrated win (motorsaif 38+26
routes printed by the running system, **recorded**, `DECISION.md`); zero authoring cost to
start. **Weakness, and it is fatal alone**: an import graph is not a behaviour graph.
"Group composer must inherit paste behaviour" is invisible to imports; feature slicing —
the actual requirement — needs authored semantics. B alone gives honest mechanical
coverage of *addresses*, not *features*.

## 5. The shared hard problem — external mapping rot

With annotations forbidden, the unit→code mapping lives in `.sova/spec/` and rots on four
axes, each with a different honest answer (**proposed**, axes from measured precedent):

1. **Path gone** (move/delete) — existence check, exit 1; git rename detection may
   *propose* the new path, never auto-apply (**proposed**).
2. **Path present, content drifted** — two clocks and receipts (`stale.mjs`, **verified**
   design); a derived clock is reset by trivia, so the run prints *which clock answered*.
3. **Mapping semantically wrong while the path stands** (behaviour moved to a new file) —
   **not mechanically detectable, ever**. Hash equality proves bytes, not meaning. This is
   the REVIEW REQUIRED residue; a receipt records that somebody reconciled a unit at a
   commit, and per `spec-sync.mjs`'s LIMITATION it "cannot prove reading" (**verified**
   wording). Reconciliation is therefore *targeted*: `reconcile <unit>` prints the diff
   range since the last receipt and records one key.
4. **New code, no mapping** — coverage sweep names the files; **new unmapped concerns are
   a named state, never silence** ("claimed by no unit", foldaidev's own summary-naming
   rule, **verified**).

## 6. Recommendation — A, seeded by B's scanner

Take **A as the shape** (authored units, closed verbs, derived views) and **B as the seed
and the address-space floor**: an `init` walk mints one unit per existing spec file (23
units, **verified** count) and the route/protocol space is derived and checked without any
authored rows — the same merge shape as aidv2's "C, with features from B". Rationale:
incremental adoption (map the composer cluster first, everything else legitimately
NOT MEASURED), and the two requirements B cannot fake — slices and blast radius — get the
authored graph while the part A cannot fake — address truth — gets derivation.

### Tree (**proposed**)

```
.sova/spec/
├── README.md            # contract: states, verbs, what green proves and never proves
├── units/
│   ├── composer.md      # example below
│   ├── images.md  model-menu.md  mode-menu.md  workspace-group.md …
│   └── web-sessions.md  # behaviour unit: Code: maps none — persistence lives in pi SDK
├── reconciled.json      # receipts: unit → commit (append-only)
└── layers/
    └── paste-images/    # Q-007 convention: shadow units, Amends:, expectations
```

```markdown
# composer
The message composer at the foot of a chat.
Spec: spec/04-composer.md
Code: src/components/Composer.tsx, src/components/ComposerMenu.tsx
Depends on: images, model-menu, mode-menu
Reconciled: a1b2c3d 2026-09-30   (written only by `--reconcile`)
```

### First two hours (**proposed**, hours est.)

0:00–0:20 `init`: mint 23 units from `spec/*.md`; coverage sweep prints the 275 unmapped
source files by name, exit 2 — honest day-one state. 0:20–0:50 map the composer cluster
(~10 rows) by hand; run the falsify ritual: add a bogus path (expect 1), delete a real one
(expect 1), restore (expect 0). 0:50–1:20 first `slice composer` and `blast composer`;
FIXED set declared and measured. 1:20–2:00 reconcile the cluster; commit `.sova/spec/`.
Day-one: 1 of ~15 clusters mapped, everything else named NOT MEASURED — the aidv2 posture.

### Rich-text composer scenario (**anchors verified**)

Change: "pasting an image into the composer attaches it." `slice paste-images` =
`units/composer` + closure (`images`, `model-menu`) → `spec/04-composer.md`,
`spec/04b-images.md`, `src/components/Composer.tsx`, `ComposerMenu.tsx`,
`ImageStrip.tsx`, with line counts and a budget warning past a threshold. `blast` =
reverse `depends on` → `units/workspace-group` (`GroupComposer.tsx`, `spec/14-workspaces.md`
group composer), `units/fanout` (`.composer[data-collapsed]`, `spec/14b-fanout.md`) — the
surfaces that inherit composer behaviour without being in the edit's diff. The align minor
mode (**verified** in `pi-config/extensions/mode/minor.ts`; `/align export` writes
`.pi/align.md`, **verified** in its README) then cites the blast list in its alignment
block: "touches 3 units, 6 files; 2 dependents inherit; GroupComposer paste behaviour
unreconciled." Proposed integration only — today the align block is authored from grep.

### Proposal vs current truth; existing spec; replicated truth

Layers hold **desired** state as *expectations, not claims* (Q-007): a layer unit's
`Code:` rows read `not built yet`, never red, never green; collision with an address the
system already serves is the one red; `Amends:` targets must exist (~10-line check). The
desired/verified distinction is thus mechanical: mainline rows carry receipts, layer rows
carry expectations. `spec/*.md` remains the prose authority — units cite it and never
restate it; the manifest is an index, not a second spec. The overview class index stays
replicated truth unless a cheap derived check (`classes cited ⊆ base.css`) is added later
(**proposed**, optional).

## 7. Complexity limits and growth guardrails (**proposed**; prior caps are evidence, not law)

One checker, stdlib only, no config file, no knob that can silence a check (aidv2's
"single most important property", **recorded**). Start ≤600 lines; re-argue at 1,000.
Verb table frozen at ≤5. A unit whose authored rows exceed ~15 lines must split. FIXED set
printed with its line count every run; warn when it exceeds ~30% of a slice (else the
slice is theatre). Exit 2 at zero graded. Receipts append-only. No overlay engine, no
schema language (Q-007 steelmen, **recorded**). Growth tripwire: if `docs/identifiers/`'s
20,004-line history repeats here, the manifest has become the product — cap and re-argue.

## 8. What green never proves

A green run proves: every row parsed or was rejected by name; ids resolve; paths exist;
edges legal and acyclic; receipts name real commits; unmapped files were counted and
named. It never proves: that mapped code implements the prose, that edges are the *right*
edges, that coverage is semantically complete — a file can be claimed by the wrong unit
and every check still passes. "A scope computed over stale edges is a confident wrong
answer, which is worse than grep" (**recorded**, Q-004). Hence the standing tail on every
run: REVIEW REQUIRED.
