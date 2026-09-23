# Round two — remaining design decisions

glm-5-3 · independent decision proposal · 2026-09-30. Round one preserved at `proposal.md`.
Nothing implemented; no existing file edited. Labels: **verified** (read/measured today),
**recorded** (cited document asserts; not re-measured), **proposed** (this design). The
judge's synthesis (`astra-judge/synthesis.md`) was read; its corrections to my round one —
date error, image-paste ≠ rich text, no-spec gap, unsafe `web-sessions` gloss — are
accepted and drive choices below.

## Settled, and what I verified of it

User settled: foldaidev's identifier convention; Sova retrofit pilot; portable standalone
core consumed by a minor mode; incremental authority; prose-returning `scope`. I verified
the convention at its sources, not from memory:

- `§<namespace>/<name>`, lowercase/hyphens, one qualification dot; `.` and `/` are both
  separators; everything before the last `/` names the file (**verified**,
  `docs/identifiers/README.md` "The namespace is the file address"). `idToFile()` computes
  it — `§control-plane.workers/fleet` → `control-plane/workers.md` (heading `fleet`),
  `§composer/input` → `composer/input.md` — with one special case: a `section`-first
  namespace resolves as directory-all-the-way-down (**verified**, `spec-graph.mjs:79`).
- **One declaration rule**: a `§` *begins a markdown heading* to declare; anywhere else it
  cites. No second glyph meaning "this one counts" (**verified**, README "One declaration
  rule"). `§` is never dropped.
- Append-only: a removed id gets a `cut.md` row with successor/reason; **there is no
  rename** — cut plus add, both register movements in full (**verified**,
  `spec/foldaidev/revising.md` moves table). Retired-notation aliases are data in
  `notation.json`, read by three scripts and copied by none (**verified**).
- Edges live in the *source* unit's file, in fixed tables (`Depends on` traversed,
  `Links out` never) — "Add an edge: the source section's file only" (**verified**,
  `revising.md`).

**What transfers to `.sova/spec/`** (proposed, since foldaidev's own use is
address/spec-shaped): the `§` grammar, declaration rule, resolution arithmetic, cut
register, edge-stated-at-source, `path.md → Heading` citation for incumbent prose. What
does **not** transfer: foldaidev's source-header checks (`Surfaces:` on `src/` files stay
forbidden here), and its `section` special case — instead, which namespaces resolve
directory-deep is **data** in an inventory file (`namespaces.json`, the `notation.json`
precedent), so no project name is hardcoded in the tool. One collision I checked: Sova's
incumbent specs write `§4`, `§4b` for their own numbering (**verified**, `spec/overview.md`
file map). The id grammar requires a leading lowercase letter, so `§N` references never
parse as manifest ids — no ambiguity, stated here so nobody rediscovers it.

## Decision 1 — format and prose discipline

**Choice: one authoring grammar — markdown cards with `§` heading declarations. No JSON
manifest, no frontmatter, no `Depends on:` line-parsing variant.** JSON (the synthesis's
lean) is credible: unambiguous parsing, Node-native, separates relations from prose. But
the settled convention *is* a markdown grammar — a JSON relation file beside it would
invent a second declaration form (a key) for the same names and two places a unit exists,
exactly the "multiple equivalent authoring grammars" the brief forbids, and the failure
foldaidev documents twice over (four drifted copies of one regex; a ledger dropped so
authored rows cannot drift from derived tables — **verified** README; **recorded** aidv2
`DECISION.md`). JSON returns only as derived cache (`.sova/spec/.cache/`), never authored.

### Minimal worked example (**proposed** tree)

```
.sova/spec/
├── README.md              # method, authority policy, boundary declaration
├── namespaces.json        # data: scopes, deep namespaces, exclusions+reasons
├── cut.md                 # the append-only register
├── composer/input.md      # §composer/input
├── composer/attachments.md
├── workspace/input.md     # §workspace/input
├── message/text.md        # cross-cutting: no surface, ordinary unit
└── reviews/               # receipts (never authority, never a scope input)
```

`composer/input.md`, complete:

```markdown
# §composer/input — The session composer's input

One textarea per chat session. It grows with typing and sends on Enter.

Authority: spec/04-composer.md → Anatomy · spec/04-composer.md → Behavior

| Requires | Maps to |
| --- | --- |
| §composer/drafts | src/components/Composer.tsx |
| §composer/send | src/components/ComposerMenu.tsx |
| §message/text | |
```

Rules this example fixes (**proposed**):

- **Heading boundaries**: `# §id — title` declares; prose until the next same-or-higher
  heading is the claim span; children declare at `##`. A `Maps to` cell may hold a path,
  a path plus `→ selector`, or be empty (promise with no located implementation — counted,
  not an error). `Authority:` cites incumbent prose by foldaidev's `path → Heading` form;
  if no incumbent home exists the claim prose *above* the tables **is** the home (the
  no-spec path). One home per fact: a card never restates an authority sentence; it cites.
- **Edges stated at source** in the `Requires` table (and optional non-traversed
  `Relates to`); reverse impact is always derived, never authored twice. An empty Requires
  cell-set after review means "no declared requirements" — distinct from a card with no
  Requires table, which means *not mapped*.
- **Deterministic scope output** (the settled "prose, not only paths"): `scope §composer/input`
  prints, in fixed order — query and boundary; the claim prose of the unit and of each
  `Requires`-closure member (id-sorted, indented by depth, each line tagged
  `requires`/`always-read`/`candidate`); mapped paths with bytes and token estimate;
  the frontier: unmapped dependencies, `Maps to` empty rows, and the standing blind spot
  ("mapped files may contain unclaimed behaviors"). Identical graph ⇒ byte-identical
  output, so scopes diff. **Over budget ⇒ staged plan with the unread required material
  listed by name** — truncation never masquerades as completeness.

### Terse prose rules, before/after (**proposed**; layer split per `revising.md` surface/system
precedent, **verified**)

A claim is one present-tense sentence a person meets, never how it is worked out; conditions
are an inline "unless", not a subsection; numbers that belong to code are not restated.

- Before: *"The composer input is a textarea which supports multiple lines and grows up to
  40vh then scrolls, and persists drafts so reloading keeps the text, which is stored via
  the drafts API as a string with attachments."*
- After: three claims — `§composer/input` *"Grows from one line, then scrolls."* ·
  `§composer/drafts` *"A reload restores the unsent draft."* — and the API shape lives in
  `Maps to` evidence, not prose. The condition example: *"Enter sends, unless an IME
  composition is open."* — one line, no `#### Exceptions` scaffolding.

**Sova's incumbent numbered specs stay untouched**: cards cite `spec/04-composer.md →
Behavior`; incumbent `§N` comments are optional discovery evidence only (settled).

## Decision 2 — dirty-tree review records

**Choice: content-addressed receipts — bind exact bytes, not commits.** Committed-only
(the conservative v1 the synthesis floated) is honest but refuses exactly when Sova works
most (long-lived dirty trees); full working-tree snapshots retain unrelated bytes and rot
into "what was that blob". The smaller honest model: a receipt fingerprints **only the
inputs actually read**, and separately *labels* its basis.

Receipt fields (**proposed**): behavior id; `basis` — `head <sha>` only if every input's
bytes equal HEAD at record time, else `working`, else `bytes` (no git: fingerprints still
work; that is the portability argument); `inputs` — authority spans (path + heading span +
sha256), implementation files (old **and** new `Maps to` union), the resolved `Requires`
rows used, always-read policy bytes, the scan boundary hash; `reviewer` — kind, identity,
`self: true` disclosure; `conclusion` — `reconciled | unaffected-with-reason | unresolved`;
retained rationale; command evidence (what actually ran, output hashes — a prompt is not
compliance). **No receipt certifies HEAD bytes while an input was dirty** (quality bar):
`basis` cannot say `head` then.

The rest of the required set:

- **Unrelated dirty files**: never inputs, never blockers; `basis: working` is the honest
  statement that *some* input was uncommitted.
- **Dependency invalidation**: applicability is recomputed, not remembered — any input of
  the behavior's packet (including dependency *authority* bytes and old-mapping paths)
  changed ⇒ receipt lapses for that behavior, and reverse-`Requires` consumers get
  `review-needed` — *requiring review, not proving breakage*; a consumer may answer with
  an `unaffected` receipt whose rationale says why. Unresolved dependency visibility, not
  unchanged consumer bytes, controls (quality bar).
- **Deletion/rename/new**: missing input path ⇒ state `unavailable` (never `clean`);
  rename detection *proposes* a mapping update, attesting nothing; a new file is a census
  finding until mapped — it inherits no receipt.
- **Races**: re-fingerprint inputs at write time; mismatch ⇒ refuse, regenerate packet.
- **Self-reference**: `reviews/` and `.cache/` are excluded from inputs and from the census
  boundary (declared in `namespaces.json`); the README/policy/inventory are always-read
  inputs of every packet.
- **Four kept distinct** (the report's columns, never one score): **movement** (bytes
  changed — mechanical), **applicability** (the receipt still covers the current packet —
  mechanical), **correctness** (the conclusion was sound — never provable, rationale is
  the evidence), **claimed review** (someone read — never provable, provenance only).

## Decision 3 — advisory versus blocking

Exit semantics, identical for every command (**proposed**): `0` computed, no findings or
informational only; `1` computed with degrading findings (named, `file:line`); `2` could
not compute. No green badge; every report ends with its frontier statement. Policy lives
in project-local `namespaces.json`/README (portable), may **tighten** but never silence a
finding — an exclusion carries a reason and stays visible in the census. (aidv2's no-config
stance is *not* imported wholesale; its real lesson — no knob that turns a check off — is
kept as tighten-only.)

| Finding | scope | census | receipt write | gate (touched set only) |
| --- | --- | --- | --- | --- |
| Malformed record | name it, show reachable part, exit 1 | exit 1 | refuse | **block** |
| Unresolved `§`/path ref | named, exit 1 | exit 1 | refuse | **block** |
| Unmapped region | informational, exit 0 | counted, exit 0 | allow | pass — unknown global coverage never blocks adoption |
| Stale relevant claim | marked `stale` in output, exit 0 | listed | allow | **block** until receipt |
| Semantic conflict (two authority claims / authority-impl discrepancy raised) | marked, exit 0 | listed | refuse without a recorded decision | **block** |
| Failed observation | named `failed`, exit 1 | exit 1 | refuse | **block** |

A failed parse never shrinks scope silently (reachable part prints, finding named). The
touched set = behaviors whose cards/mappings changed ∪ their reverse-`Requires` consumers ∪
newly claimed — global census findings never enter it. Mode stages: **align** — everything
advisory; **implement** — advisory census; **reconcile** — receipt required before a claim
update; **gate** — the matrix above, touched set only.

## Decision 4 — pilot plan (planned, not run)

Target: retrofit Sova's incumbent `spec/`; compare against the preserved baseline. Staged:

- **Stage 0 — baseline.** Tag the tree; record today's alignment workflow (grep-based) as
  the comparator. Capture the authoring-footprint clock start.
- **Stage 1 — seed one cluster** (~2h budget, est.): author `composer/input`,
  `composer/drafts`, `composer/attachments`, `composer/send`, `workspace/input`,
  `message/text` with the judge's corrected edge set, in foldaidev form. `Maps to` whole
  files: `Composer.tsx`, `GroupComposer.tsx`, `src/lib/draft-save.ts`, `server/drafts.ts`
  (all **verified** to exist; `draft-save.ts`/`server/drafts.ts` string-payload seams per
  the synthesis's reads, **recorded**).
- **Stage 2 — hypothetical task, both ways.** Rich-text composer (serialized Markdown vs
  structured doc left open — an alignment question, not a feature authorization). Run the
  alignment once grep-only, once scope-fed; measure align-block file list, false includes,
  and misses. Success: scope names `GroupComposer.tsx` (via `§workspace/input requires
  §message/text` — shared-selector candidate, *not* behavior inheritance) and the drafts
  seam, while **preserving the deliberate group exclusions** ("Attachments and slash
  commands are not in the group composer" — **verified**, `spec/14-workspaces.md:470`).
- **Stage 3 — planted defects**: (a) edit a mapped file ⇒ movement + applicability lapse
  must fire; (b) delete the `composer/input → composer/drafts` edge ⇒ scope diff must
  *name the shrinkage* (the failure-modes precedent: edges deleted as misplaced existed
  nowhere else — **recorded**); (c) add an unmapped file ⇒ census finding; (d) dirty an
  input, attempt `basis: head` ⇒ refusal.
- **Stage 4 — reconciliation effort**: time-boxed receipts on the cluster; record seconds
  per receipt and rationale lengths.
- **Stage 5 — no-spec fixture**: a directory with code but no spec; author three claims
  from scratch; scope and census must run with zero incumbent citations.
- **Evaluation report**: scope size *and* omissions; blast correctness against the
  hand-checked answer; defect-detection tally; authoring and reconciliation hours; with/
  without-scope alignment comparison; fixture result. Roll out further clusters only if
  Stage 3 detects 4/4 and Stage 2's scope-fed align block strictly dominates grep on
  misses without more false includes.

## Integration boundary (**proposed**; no extension/server edits this round)

The minor mode loads a short discipline block (the `ALIGN_INSTRUCTIONS` pattern,
**verified** in `pi-config/extensions/mode/minor.ts`): how to call `scope`, when a receipt
is owed, never trust a clean exit as semantic proof. Tools are discovered at
`.sova/spec/tools/` (project-relative); install-check = `--selfcheck` reporting version and
boundary; a missing tools dir downgrades the mode to prose-only, loudly. Composition with
align: the align block's Findings section *cites* scope output (query id + output hash) —
the mode's parser (`align.ts`, heading-anchored, **verified**) stays unchanged. Permissions:
bootstrapping `.sova/spec/` and every receipt write is a file mutation the agent asks
before performing; confirmation approves a plan, never certifies a read — receipts record
what ran, not what was promised. "Do not pretend a prompt guarantees compliance" is
enforced by evidence fields, not prose.

## Unresolved (explicitly left open)

Always-read policy granularity and its invalidation cost; whether kind namespaces
(`§behaviour/…`) earn their place over plain areas; selector-level `Maps to` timing;
whether `gate` also runs in CI or stays mode-local; receipt retention/pruning policy.

## Limitations

Graph checks prove structure, movement, and applicability — never that mapped code
implements a claim, never that edges are the right edges, never that anyone read. Missing
behaviors inside mapped files remain a stated blind spot, printed in every scope. Counts I
report: 6 cards, ~10 edges, 4 planted defects, 2 alignment runs — all planned, none run.
Reference reads verified today: foldaidev identifier files as cited; Sova
`spec/14-workspaces.md`, `minor.ts`, `align.ts`, composer files. The synthesis's own reads
(draft payload shapes) are recorded, not re-measured here beyond existence.
