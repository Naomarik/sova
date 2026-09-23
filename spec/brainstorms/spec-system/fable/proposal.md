# A `.sova/spec` implementation manifest — proposal (fable)

> Brainstorm only. Nothing here is implemented; every `.sova/` path is proposed, and every claim
> about existing files is cited so it can be checked. Written 2026-09-23 against Sova at
> `383a35d` plus its dirty working copy.

## The problem, measured on this repo

Sova already has a spec: 20 files, 8,104 lines under `spec/`, one file per `§N` surface
(`spec/overview.md` → File map). Code cites it densely: 363 `§` mentions in 91 `.ts`/`.tsx`
files plus ~40 `spec/NN-name.md` path citations (`rg`, 2026-09-23). The code → spec map exists
informally in doc comments. What does not exist:

- **The reverse map.** "Which files implement §4 · Composer" is a grep whose completeness nobody
  can state. `Composer.tsx:67` cites `spec/04-composer.md §4, §4b`; `ComposerMenu.tsx` cites `§4`;
  `FileMenu.tsx` cites nothing.
- **A dependency slice.** `spec/04-composer.md` names §4b, §4c, §4d, §4g, §2, §3, §4h and §11 in
  its prose, but nothing says which a builder must load and which are merely pointed at. Loading
  all of them is ~1,600 lines before the copy deck.
- **Stale detection.** Commit `383a35d` (2026-09-23) rewrote the composer's `@` menu in
  `Composer.tsx`, `FileMenu.tsx` and `files.ts`. `spec/` was last touched at `237cca9`
  (2026-09-22), and neither `04-composer.md` nor `04d-slash-commands.md` mentions the `@` menu at
  all. Today this is invisible: the spec reads complete and the code cites it. That is the silent
  failure `~/github/abstract-identifiers/README.md` opens with.
- **Alignment blast radius.** The `align` minor mode (`pi-config/extensions/mode/align.ts`)
  captures Findings / Approach / Open questions, but nothing tells the aligning agent what a
  change touches in spec terms.

The brief's constraints, no source annotations, piece-meal adoption, honest "did not look"
reporting, lightweight, rule out foldaidev's `Surfaces:` source headers (`stale.mjs:93-104`:
"the header is the edge and there is no other") and rule out retrofitting 8,104 spec lines into a
new grammar.

## Two competing architectures

### A · The authored manifest

One file, `.sova/spec/manifest.json`, listing concerns: id, spec ranges, code paths, typed edges.
Every check runs over the manifest.

```
.sova/spec/
  manifest.json      # the only authority: concerns, edges, code claims
  reconciled.json    # concern → commit sha, written by `reconcile` only
  proposals/         # speculative concerns
```

Strengths: every relation is explicit, so scope is a pure graph walk (foldaidev
`docs/identifiers/scope.mjs:1-16`); no prose is parsed. Weaknesses: the manifest is a second copy
of facts the spec prose and code comments already carry, and "the second copy is the one that
goes stale" (`spec/foldaidev/revising.md` → Which layer holds it; aidv2 `INVARIANTS.md` "One
home per fact"). A code-path list authored on day one is also a claim with no evidence, which is
amalmoney's `manual: true` failure (aidv2 `DECISION.md`, non-negotiable 3).

### B · The inferred graph with authored overrides

Derive what already exists, `§` citations in code, `§` and path cross-references in spec prose,
git history, and author only what cannot be derived: concern boundaries finer than a file, edge
verbs, exemptions, reconciliation receipts. The derived graph is rebuilt every run and never
committed.

```
.sova/spec/
  concerns.md          # authored: concern inventory (ids → spec anchors), edges, claims
  reconciled.json      # written by `reconcile`: concern → commit sha
  proposals/<slug>.md  # authored: a speculative concern layered over current truth
  .derived/            # gitignored: computed graph, last report
```

Strengths: adoption is incremental by construction; a concern absent from `concerns.md` still
exists in the derived graph as "spec file §N, cited by these files, unclaimed". Weaknesses:
inference is only as good as the citation habit, and a `§4` in a comment may be a mention, not a
claim. foldaidev needed positional grammar to separate 49 declarations from 419 mentions (aidv2
`Q-004`, I-002).

### Recommendation: B, with A's manifest as the override, never the authority

`concerns.md` is a manifest in A's sense but is **partial by design and never treated as
complete**. Every derived fact carries provenance, and every check reports the population it read.
B's ambiguity problem is answered by one cheap authored line: `claims:` per concern, naming globs,
which overrides inference for that concern and is itself checked (a claimed path must exist, or
the row is a finding). You write it only where inference was wrong or thin, so authored rows
track pain, not size.

Why not A alone: it fails piece-meal adoption the moment a check needs a complete manifest to mean
anything, and it re-authors 363 citations. Why not B alone: with no override there is no way to
say "this mention is not a claim", so stale reports over- or under-report. The override is the
escape hatch, and its count is the honesty meter.

## Vocabulary and IDs

- **Concern.** The unit of specification, mapping and staleness. Examples: `composer`,
  `composer.flyout`, `composer.mentions`, `mode-menu`, `workspace.group-composer`.
- **Id.** `<surface>[.<sub>]`, lowercase, two levels max (foldaidev `brief/README.md` → How To
  Read: a surface wanting a grandchild should be split). No sigil. Sova's `§N` numbers stay as
  *anchors*, not ids: renaming them is aidv2 `Q-004`'s "rewrites every citation" cost, and they
  sit in 363 code sites and the copy deck. A concern id is a new name pointing at old anchors, so
  nothing existing moves.
- **Spec anchor.** `spec/<file>.md[#<heading-slug>]`, slugs from headings that exist today. The
  checker resolves each anchor at run time, so a renamed heading is a finding, not silence.
- **Code claim.** A path or glob under `src/`, `server/`, `shared/`, `pi-config/`, with provenance
  `cited` (the file's text carries the anchor or `§N`), `declared` (a `claims:` row), or
  `co-changed` (git co-commit with a cited file; advisory only, never binding).
- **Edge.** Directed, authored in the source concern only (`revising.md` → Add an edge). Two
  verbs: `needs` (must be loaded to build this: foldaidev's embeds / instantiates) and `points`
  (named, never opened: navigates / links / draws from). The only question a scope asks is "load
  or name?", so five verbs collapse to two. A `needs` cycle is a spec defect and exits 2
  (`scope.mjs:98-107`).

### `concerns.md` after the first two hours

```markdown
## composer
spec: spec/04-composer.md · spec/09-copy-deck.md#composer
needs: composer.flyout, model-menu, mode-menu, images.attach
points: session-list, transcript, subagents-pane, session-info
claims: src/components/Composer.tsx, src/lib/slash.ts

## composer.flyout
spec: spec/04-composer.md#composer-flyout · spec/09-copy-deck.md#composer-flyout
needs: model-menu
claims: src/components/ComposerMenu.tsx

## composer.mentions
spec: none — UNSPECIFIED, see proposals/at-menu.md
claims: src/components/FileMenu.tsx, src/lib/files.ts

## mode-menu
spec: spec/04g-mode-menu.md
claims: src/components/ModeMenu.tsx, server/mode-state.ts, pi-config/extensions/mode/state.ts

## design-system
spec: .claude/skills/fold-ai-dev-design/SKILL.md
always: true    # in every slice, never edged — foldaidev's FIXED set (scope.mjs:36)
```

Every other `spec/NN-*.md` without a block is still a concern: derived, `needs: unknown`, claims
from the `cited` scan, reported as **unclaimed-by-author**. Day one: 5 authored blocks, 15
derived, and the report says which is which.

## Traversal and the context slice

`sova-spec scope <concern>` walks `needs` transitively, unions `always`, and prints, in
`scope.mjs`'s order:

1. **Load**: spec anchors of every reached concern as `file#heading` with line spans, not whole
   files (`04-composer.md` is 276 lines; `#composer-flyout` is ~105).
2. **Named only**: `points` targets, one line each.
3. **Code**: claims of reached concerns with provenance.
4. **Unknown coverage**: reached concerns whose `needs` is derived. The slice prints anyway,
   headed `SLICE INCOMPLETE: 2 of 6 concerns have no authored edges; their dependencies were not
   followed`. This is abstract-identifiers' rule that an answer states its own boundary
   (`doctrine/answers.md` → Six absences: *not measured* is not *absent*).

The budget line is a line count and a 4-chars-per-token estimate, labelled as an estimate.

### Scenario: the composer becomes rich text

Inline formatting, mention chips instead of a plain `@path`, pasted images inline. In `align`
mode the agent runs `sova-spec scope composer --for-change`:

```
SLICE  composer  (authored)
  load   spec/04-composer.md                       276 L  composer
         spec/04-composer.md#composer-flyout       105 L  composer.flyout (within the above)
         spec/04c-model-menu.md                    208 L  model-menu
         spec/04g-mode-menu.md                     176 L  mode-menu
         spec/04b-images.md#composer-attachments  ~130 L  images.attach
         spec/09-copy-deck.md#composer              16 L
         .claude/skills/fold-ai-dev-design/SKILL.md       (always)
  named  session-list · transcript · subagents-pane · session-info
  code   src/components/Composer.tsx       cited     1042 L
         src/components/ComposerMenu.tsx   cited      499 L
         src/lib/slash.ts                  declared
         src/components/FileMenu.tsx       declared   composer.mentions — UNSPECIFIED
         src/lib/files.ts                  declared   composer.mentions — UNSPECIFIED
  blast  needs composer:   workspace.group-composer  (spec/14-workspaces.md#the-group-composer)
         points at composer: slash-commands · images · timeline
  ~1,100 spec lines · ~5k tokens est.
BOUNDARY
  followed      needs edges of 5 authored concerns
  not followed  images.attach → ? (derived, no authored edges)
  not measured  whether Composer.tsx matches spec/04-composer.md today (run `stale`)
  excluded      prose truth · runtime behaviour
```

Two things this gives the alignment doc. `composer.mentions` surfaces as **UNSPECIFIED with code
attached**, so Findings can say: the `@` menu has code and no spec; rich text rewrites it; spec it
first or the change is unspecifiable. And `--for-change` adds reverse edges: the group composer
`needs` the composer ("one composer that writes to every member", `spec/14-workspaces.md`), so
rich text is also a group-composer change, and that lands in Open questions instead of week two.

## Mapping to code, and stale mapping

Three claims, proved differently and never merged:

| Claim | Proof | Words |
|---|---|---|
| this file implements concern X | `cited` text · `declared` row · `co-changed` git (advisory) | cited / declared / co-changed / **none** |
| the code was written against the spec as it is now | per-concern clock vs `git diff <clock>..HEAD -- <anchors>` | clean / moved / **unknown** |
| the spec describes what the code does | nobody | **REVIEW REQUIRED**, printed every run |

**The clock.** `reconciled.json` maps concern → sha, written only by
`sova-spec reconcile <concern> [<sha>]`. Without a record, the derived clock is the last commit
touching the concern's claims, and the report says `derived` beside it. Both clocks, and the
warning that derived-clean means *touched*, not *read*, are lifted from `stale.mjs:35-49`,
including its measured case where one comment edit hid a +73/−20 brief change. Reconcile refuses
`HEAD` while `spec/` or `.sova/spec/` is dirty (`stale.mjs` `reconcileTarget`): the prose on
screen is not the prose in the commit.

**The reverse direction, which foldaidev does not report:** code moved, spec did not.
`git log <clock>..HEAD -- <claims>` with anchors unchanged prints
`code-moved-spec-still: composer (383a35d touched Composer.tsx, FileMenu.tsx; 04-composer.md
unchanged)`. This is mechanical and would have caught the `@` menu today. It is not a correctness
claim: a pure refactor trips it, and the answer is one `reconcile`, which records who looked.

**Unknown is first-class**: no claims, an anchor that does not resolve, a recorded sha git lacks,
a claimed path not on disk. None is ever green. Summary line:
`N clean · N moved · N unknown · N unspecified · N unclaimed`; exit 0 only when moved and unknown
are both zero (`stale.mjs` exit rule; aidv2 "Not measured is never green").

## Mechanical versus semantic

Every command ends with a generated block, never a typed one:

```
MEASURED         anchors resolve · claims exist · edges resolve · needs acyclic · clock vs spec · clock vs code
NOT MEASURED     co-change edges (advisory) · concerns with derived needs (3)
REVIEW REQUIRED  whether any spec sentence is true of the running app · whether a needs verb is right · whether a claim list is complete
```

The tool proves resolution and motion. It never proves meaning. Meaning is checked in the
alignment doc by a person or an aligning agent, and `reconcile` is how that check gets a date.

## Lifecycle: proposals and current truth

A new feature is a **proposal**, not a spec edit. `.sova/spec/proposals/<slug>.md` is a concern
block in the same grammar plus one line, `amends: composer` (aidv2 `Q-007` spec-layers: an
`Amends:` line and nothing else). `scope composer --with rich-text` layers it onto the base
slice; `stale` never grades a proposal, because not merged is never truth. Graduation is editing
the real `spec/04-composer.md`, moving `composer.mentions`' `spec:` from `none` to the new anchor,
deleting the proposal file, and reconciling. Git records it. A proposal with no commits for N
days is listed as `lingering` every run.

Per-concern state is derived, never a status field (aidv2 `INVARIANTS.md`: a status field goes
stale in the flattering direction): `unspecified` → `proposed` → `specified` → `claimed` →
`reconciled`. Only the last is authored, by the reconcile command.

## Coexistence and ambiguous truth

- `spec/` stays the authority for behaviour and is not rewritten. `concerns.md` holds only what
  `spec/` cannot: edges, claims, exemptions.
- The design skill is `always`, cited by path, never copied (`SKILL.md:12-15` says `spec/` owns
  behaviour and duplication is how the two drift).
- `CLAUDE.md` carries implementation facts that read like spec (the `pi-web` compatibility list,
  mode aliasing). The manifest does not resolve that; it records it: a concern may list two
  anchors for one behaviour and the row reads `contradictory-authority` with both paths. The tool
  never picks (`doctrine/answers.md`: "a silent choice is a decision made by iteration order").
  A person picks, in `spec/`, and the row disappears.
- Existing `§N` comments keep working unchanged; they *are* `cited` provenance. No new annotation
  form is introduced, and none is required, because `claims:` exists.

## The first two hours

1. `sova-spec init` writes `concerns.md` with one block per `spec/NN-*.md`, ids from filenames,
   `needs: unknown`, `claims:` from the `cited` scan. Ten minutes, mostly reading.
2. `sova-spec stale` on derived clocks. Expect near-total `unknown` and a few
   `code-moved-spec-still`. Nothing is green. That is the honest baseline.
3. Author edges for the two or three concerns in play this week. Ten lines each.
4. `sova-spec falsify`: claim a path that does not exist, expect exit 1; anchor a heading that is
   not there, expect exit 1; restore (aidv2 `DECISION.md` merge 2). A check nobody has seen fail
   is not a check.
5. Reconcile the one concern actually reread today. Everything else stays `unknown`, reported.
6. Four lines in `CLAUDE.md`: what `.sova/spec` is, that `scope` opens an alignment, that
   `reconcile` closes one, and that the `REVIEW REQUIRED` tail is read, not skipped.

## Guardrails against growth

- **Tool cap ~600 lines**, stdlib Node, no dependencies, no config file. foldaidev went from
  1,236 to 23,391 lines in six weeks (aidv2 `context/facts.md`); the cap is the reopen trigger.
- **Two verbs, two binding provenances, one clock file.** A third verb needs a written case where
  `needs`/`points` produced a wrong slice.
- **No sigil, no grammar over `spec/` prose.** Anchors are headings that already exist.
- **Authored rows are counted.** If `declared` claims outnumber `cited` ones, the citation habit
  has died and the manifest has become the second copy. Print the ratio.
- **`co-changed` never binds** and is dropped if it is noise.
- **Reopen the design** past ~80 concern blocks, or after the first alignment whose slice was
  wrong and the report could not say why.

## What B costs, honestly

`scope` can never promise a complete slice for a concern with derived edges; it says so instead
of pretending. foldaidev's measured cut (1,359 scoped + 2,193 fixed of 9,705 lines, `Q-004`
I-002) came from a fully authored graph. A partially authored one cuts less until edges are
written, and that ramp is visible on every run.

## Evidence

- Sova: `spec/overview.md` File map; `spec/04-composer.md:8-261`; `spec/14-workspaces.md:17-44`,
  `#the-group-composer`; `src/components/Composer.tsx:67`, `ComposerMenu.tsx:32,74`; commits
  `383a35d`, `237cca9`; `rg -c "§" src server shared` = 363 in 91 files;
  `pi-config/extensions/mode/align.ts:1-30`, `mode/README.md` → Alignment doc;
  `.claude/skills/fold-ai-dev-design/SKILL.md:12-15`.
- aidv2: `INVARIANTS.md`; `DECISION.md` merges 1-5 and "Not verified";
  `debate/questions/Q-003`, `Q-004` (I-002), `Q-006`, `Q-007`; `context/facts.md`;
  `context/TARGETS.md:85-105`; `context/note-opus.md` §7 items 8 and 11.
- foldaidev: `spec/foldaidev/brief/README.md` → How To Read, Edges between sections;
  `spec/foldaidev/revising.md` → Which layer, What moves, Choosing an edge verb;
  `docs/identifiers/scope.mjs:1-40,98-107`; `docs/identifiers/stale.mjs:1-120,160-330`;
  `docs/identifiers/spec-sync.md` → Interface.
- abstract-identifiers: `README.md` → The method in brief, `aid explain`;
  `doctrine/answers.md` → Six absences.

## Not verified

- Every line count and token estimate except the `wc`/`rg` figures named as measured.
- That heading-slug anchors are stable enough: Sova's spec headings are edited freely (§14 has
  20+), and nothing resolves them today.
- That `cited` provenance is precise. The 363 count is mentions; I did not classify any.
- That two edge verbs suffice. foldaidev needed five and retired one; the copy deck may want
  `draws from` back.
- The false-positive rate of `code-moved-spec-still` on a repo with 386 commits since
  2026-08-01, 113 touching `spec/`.
- That `align` mode would run `scope` first; nothing in `minor.ts` does today.
- The 600-line cap. Nothing is written.
- Whether `.sova/` is the right root beside the existing `.pi/` and `ai/`; it was taken from the
  brief, not argued.
