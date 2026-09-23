# Round two: decisions (opus-5.5)

Status: independent decision proposal, 2026-09-23. Nothing is built or retrofitted. I read the
brief, `astra-judge/synthesis.md`, and the reference files listed in §8. I did not read peers' round-two files.

Labels: **measured** (I ran it in this session), **proposed** (a design choice), **est.** (a guess),
**hypothetical** (a pilot illustration, not a real record).

## 0. Decisions in one screen

1. **Format.** Markdown only, using foldaidev `§` headings. There are three reserved head fields
   (`**Requires.**`, `**Code.**`, `**From.**`) directly under a `§` heading. There is no JSON
   manifest and no front matter: one authoring grammar. Claims live under
   `.sova/spec/claims/`. An incumbent spec is cited with `**From.**` and extracted verbatim,
   never paraphrased.
2. **Review records.** A receipt binds the **exact working bytes** of each input by sha256.
   Git reproduces inputs that were clean at HEAD. Inputs that were dirty, untracked, or in a
   non-Git project are **retained** as content-addressed blobs. A dependency is bound by its
   *promise* (claim block bytes) and by whether its own review is current. It is not bound by its
   code.
3. **Gates.** Blocking applies only to the **touched set** (ids a task changes or impacts) and
   to malformed input that was actually parsed. Global coverage is always reported and advisory
   by default. `spec.json` may raise it to blocking. No setting can make "not measured" read as
   clear. Exits: `0` clear, `1` blocking finding, `2` not measured, `3` partial (budget).
4. **Pilot.** A staged retrofit of Sova's composer region in a separate worktree, against a
   tagged baseline. Seven evaluations include planted drift, an A/B alignment test and a no-spec
   fixture. Go/stop criteria decide stage two. A full retrofit is not the default.

## 1. Format and prose discipline

### 1.1 Alternatives weighed

| Format | For | Against | Verdict |
| --- | --- | --- | --- |
| JSON relations + Markdown claims (judge's lean) | strict parse, no custom grammar | two files per edit; the manifest becomes an edit hotspot; ids appear twice (JSON and heading), so they can disagree | rejected |
| Markdown + YAML front matter | familiar | one block per file, not per heading; needs a YAML dependency | rejected |
| foldaidev section tables (`## Depends on` rows) | proven in foldaidev | table parsing is most of `spec-graph.mjs`, and the tables live in separate section files | rejected for v1 |
| **Markdown `§` headings + three head fields** | one file, one grammar; the edge sits beside the promise it qualifies; positional like foldaidev's declaration rule | a small custom grammar, so a strict parser is required | **chosen** |

The strictness cost is paid once, in the parser rules of §1.3. An unparseable field is a located
finding. It never counts as absent.

### 1.2 Identity and resolution (foldaidev convention, made data-driven)

- **Shape.** `§<namespace>/<name>`, lowercase with hyphens. There is at most one qualification
  dot. A heading declares it; anywhere else, it is a citation. Identifiers are append-only; see
  `~/webapps/foldaidev/docs/identifiers/README.md` → **The `§` grammar** and **One declaration
  rule**.
- **Resolution**, relative to `.sova/spec/claims/`:
  - `§session/composer` → `session/composer.md`, the file itself, declared by `# §session/composer — …`.
  - `§session.composer/drafts` → a heading `## §session.composer/drafts — …` in
    `session/composer.md`.
  - A kind listed in `spec.json` `deepKinds` resolves as a directory all the way down:
    `§section.worktree/chat` → `section/worktree/chat.md`.
  - foldaidev hardcodes `section` inside `idToFile` (`docs/identifiers/spec-graph.mjs:79-89`). Here
    that becomes the `deepKinds` data, and scopes are data too (compare `notation.json`).
- **A declaration must sit where its id resolves.** A misplaced `§` heading is malformed, not a
  second declaration.
- **Cut, never rename.** Cut the old id and add the new one, as in `spec/foldaidev/revising.md` →
  **Rename a surface**. `.sova/spec/cut.md` holds one row per cut id: `| Identifier | Successor |
  Reason |`. Citing a cut id is a finding that names the successor.
- Source files never carry ids. Sova's existing `§N` code comments are optional *discovery hints*
  only.

### 1.3 A unit, exactly

`.sova/spec/claims/session/composer.md` (hypothetical):

```markdown
# §session/composer — Composer

**From.** spec/04-composer.md → **Anatomy**

## §session.composer/drafts — Drafts

**Requires.** §shared/message-text · §session/attachments
**Code.** src/lib/ui-state.ts · src/lib/draft-save.ts · server/drafts.ts
**From.** spec/04-composer.md → **Behavior** → **Drafts**

## §session.composer/send — Send and steer

**Requires.** §shared/message-text
**Code.** src/components/Composer.tsx
**From.** spec/04-composer.md → **Behavior** → **Send.**
```

Rules:

- **Head fields.** Head fields are the first non-blank lines after a `§` heading. Each field appears
  at most once. The three spellings are reserved. A reserved field anywhere else is malformed.
- **Block boundary.** A block runs from its heading to the next heading of the same or higher
  level. Non-`§` subheadings inside a block belong to that block.
- **`**Requires.**`** means that changing this correctly requires considering those promises. It is
  a context and impact edge, not build order. Cycles are allowed; traversal uses a visited set
  and reports them as coupled groups. **Absent** means not mapped (an unknown frontier).
  `none — <reason>` means reviewed with nothing declared, which is not proof of independence.
- **`**Code.**`** lists whole-file paths relative to the repo root, separated by ` · `. There are
  no globs, and line numbers are never identity. Absent means unmapped; `none — <reason>` is
  allowed for a pure rule.
- **`**From.**`** names the claim's one home when it lives in an incumbent doc. It points to
  `path.md → **Heading**`, optionally followed by `→ **Bold lead-in**`, which selects the list item
  that starts with that bold text, up to the next sibling item. It has exactly one home:
  - If `**From.**` is present, the block has **no body prose**. The incumbent text is the claim.
  - If it is absent, the body prose is the claim.
  - A block with both a `**From.**` field and body prose is malformed. This is the rule that
    stops two homes for one fact.
- **Mentions.** A `§` cited in prose is a link. It is named in the scope output but never read or
  traversed.
- **Proposals** live in `.sova/spec/proposals/<slug>.md` and use `## Adds §x` / `## Amends §x`
  headings, never a bare `§` heading. A proposal never declares, and never counts as coverage or
  current truth.

### 1.4 Authority

**A claim is the authority for *current behaviour* only while an applicable `reconciled` receipt
covers it.** Otherwise it is labelled `draft`: an agent's finding, usable as a lead but not
trusted. Receipts decide this, not a field in the prose. In Sova, an incumbent paragraph stays
the requirement. The claim that cites it with `**From.**` asserts nothing extra, and a review
compares that requirement with the code. When they disagree, the receipt is `discrepancy`. That
raises the problem without choosing a side, so a bug is never canonized.

**Per-fact migration (optional).** When an incumbent paragraph mixes several promises, the
sentence moves into the claim body, and the incumbent keeps one pointer line: `→
§session.composer/drafts`. That moves authority from one home to the other and never
duplicates it. It requires an edit to `spec/`, so the user's permission, and it does not happen
in the pilot's first stage.

**No existing spec.** `init` writes `spec.json`, `README.md`, an empty `claims/` and `cut.md`.
Claims are written on demand, when a task first needs one. They have body prose and no
`**From.**`, and they start as `draft`.

### 1.5 Writing rules (lightweight prose)

1. **One observable promise per sentence.** Write what a user or caller sees, not how.
2. **Conditions go inline** as `when`/`unless` clauses. A true exception gets one `Except:`
   sentence.
3. **Mechanism only when it is a contract** another unit relies on (a route, a wire shape, a
   stored format).
4. **One `Why:` sentence at most**, and only when the rule would otherwise look wrong.
5. **Cite, don't restate.** Never copy another claim's promise; link it or require it.
6. **No counts or file inventories in prose.** They rot, and the tool derives them.

**Before**: the first half of `spec/04-composer.md` → **Behavior** → **Drafts** (lines 92-99, 91 words;
quoted in part):

> Drafts are never discarded. The draft survives disable/enable, reconnects, and errors, and it
> survives a reload too. Each session's draft lives in two places: In memory, per session path.
> This is the authority within a tab, so switching sessions and coming back restores the draft at
> once. On the server, per session. `PUT /api/sessions/draft { path, text, attachments? }` writes
> it to `~/.pi/agent/sova/drafts.json`, keyed by session id; whitespace-only text with no
> attachments deletes the entry. …

**After**, if migrated per fact (hypothetical, 46 words):

> A draft is never discarded: it survives session switches, disable, reconnect, errors and
> reload, and follows the session to other browsers. It holds text and pending attachments. A
> send clears it everywhere. Except: text that is only whitespace, with no attachments, deletes
> it. Contract: `PUT`/`GET /api/sessions/draft`.

The storage path and the two-tier cache are mechanism. They stay in code and `CLAUDE.md`.

### 1.6 `scope(id)`: deterministic prose output

The algorithm:

1. Resolve the id. An unresolvable query is exit 2, with no partial answer.
2. BFS over `**Requires.**` from the query. Order by depth, then by id.
3. For each node, emit the heading and prose. `**From.**` text is extracted verbatim, with its
   `path:lines`. Overlapping extracts are emitted once. A child query includes its parent's intro
   block.
4. List separately: the frontier (nodes with no `Requires`, unresolved ids, and malformed
   blocks, which are printed raw and marked `UNPARSED`); links (names only); reverse dependents
   (names only); `**Code.**` paths (listed, not inlined); always-read files and their sizes; each
   node's review state.
5. Apply the budget: est. tokens = bytes/4. Emit up to the budget, then print `UNREAD REQUIRED:`
   with ids and sizes, and exit 3.

Hypothetical graph used here and in §4:

```text
§session.composer/input   Requires drafts · send · mentions · slash · §shared/keyboard
§session.composer/drafts  Requires §shared/message-text · §session/attachments
§session.composer/send | /mentions | /slash   Requires §shared/message-text
§workspace.group-composer/input   Requires §shared/keyboard · §shared/message-text · §workspace.group-composer/exclusions
§workspace.group-composer/exclusions   Requires none — a rule
   From spec/14-workspaces.md → **The group composer** → **Attachments and slash commands are not in the group composer.**
§shared/message-text   Requires none — root contract
§shared/keyboard, §session/attachments   (no Requires field: frontier)
```

```text
scope §session.composer/drafts   (hypothetical output)   tree <commit>, inputs: 5, dirty 0   budget 6000 tok
CLOSURE  0 §session.composer/drafts   reconciled (receipt applicable)
         1 §session/attachments       draft — no receipt   [From spec/04b-images.md → **Composer attachments**]
         1 §shared/message-text       reconciled
FRONTIER §session/attachments: dependencies not mapped
LINKS    —        REVERSE §session.composer/input (name only)
CODE     src/lib/ui-state.ts · src/lib/draft-save.ts · server/drafts.ts
ALWAYS   .sova/spec/README.md
PROSE    ── §session.composer/drafts … ── §session/attachments … ── §shared/message-text …
BUDGET   used ≈ 3.1k of 6k; unread required: none
VERDICT  complete within the authored closure. Frontier 1. Not measured: runtime behaviour,
         undeclared dependencies, behaviours inside mapped files that nobody wrote down.
exit 0
```

## 2. Dirty-tree review records

### 2.1 Options

| Model | Honest? | Practical in Sova? | Non-Git |
| --- | --- | --- | --- |
| Committed-only: refuse unless every input is clean | yes | poorly. measured: at `c8160b6`, `git status --short` had 59 entries repo-wide, 40 under `spec/ src/ server/ shared/`, so WIP would have to be committed to review anything | unsupported |
| Snapshot every input on every receipt | yes | yes, but it stores bytes git already holds | yes |
| **Exact bytes; retain only what git cannot reproduce** | yes | yes | yes (retains everything) |

**Chosen: the third.** When every input is clean, it behaves exactly like committed-only and
stores no blobs.

### 2.2 The input set of a receipt for id B

| Role | Bytes bound |
| --- | --- |
| claim | B's block span, plus its parent intro span |
| from | the extracted incumbent span, if `**From.**` is present |
| code | each `**Code.**` file, whole, or `absent` |
| requires | for each direct target D: D's block and From span (its **promise**), plus the D receipt current at review time |
| tests or observations | only those the reviewer used, as evidence entries, not inputs |

Each input records `sha256`, `path`, the span id, and a state: `head` (git can reproduce it),
`dirty`, `untracked`, `absent` or `nogit`. Every state except `head` and `absent` gets a blob at
`.sova/spec/reviews/blobs/<sha256>`. **A receipt never says HEAD for bytes that were dirty.**
The receipt also records the packet hash, the HEAD commit (or none), and the method hash (bytes
of `README.md` and `spec.json`). A method change is shown on the receipt but does not invalidate
it; mass re-review is not worth its cost here.

**Old/new mappings and edges.** Each receipt stores the parsed `Requires` and `Code` it
reviewed. Impact uses the **union** of the edges in current blocks and the edges in the receipts
of every candidate consumer. Removing an edge, or cutting an id, therefore still reaches its
former consumers.

### 2.3 Four answers, kept apart

| Question | Computed by | Values |
| --- | --- | --- |
| **Movement**: did the bytes change? | hash compare | `unchanged`, `moved:<roles>`, `missing` |
| **Applicability**: does the receipt still speak for now? | own inputs unchanged, **and** every D's promise unchanged **and** D's review current | `applicable`, `pending-upstream(D)`, `stale` |
| **Claimed review**: what did someone say? | the receipt fields (shape only) | `reconciled`, `unaffected`, `discrepancy`, `unresolved`, plus reviewer and self-review flag |
| **Correctness** | nothing here | never computed; every run prints `REVIEW REQUIRED` |

**Dependency invalidation.**
- If D's promise changes, B is `stale` and needs a new receipt, perhaps `unaffected` with a
  reason.
- If only D's code moves, D is stale and B is `pending-upstream(D)`. Review D first. If D's
  promise still holds, B becomes applicable again without its own re-review.
- This propagates transitively and stops at any promise that holds.
- **Blind spot, stated on every run:** B may rely on D's implementation beyond what D promises,
  and that reliance is invisible.

**Deletions and renames.** A missing `**Code.**` path is a broken mapping. A rename is suggested
from a matching blob hash or git's rename detection, but the suggestion attests nothing. The
edit to `**Code.**` changes B's block, so B needs review.

**New files.** A new file in the declared population is `unmapped`. A file the task created or
changed is blocking in the touched set (§3).

**Races.** `record` rehashes every input. If the packet hash differs, it refuses. Writes take an
`O_EXCL` lock and an atomic rename.

**Self-reference.** `.sova/spec/reviews/**` and `.cache/**` are outside every population and
every input.

**Unrelated dirty files** are never read and never block.

**Non-Git projects.** Every input is retained, so movement and applicability work. "Since
commit X" diffs report `unsupported`.

**Storage.** Receipts are append-only in `reviews/receipts.jsonl`, and history is kept. Blobs
that no receipt references can be pruned. Each receipt holds `reason` and `evidence` (quotes with
`path:line`, and commands run with their exit codes). The reviewer is a person or
`model:<id>` plus a session, and `author` is `same`, `different` or `unknown`. A self-review is
never labelled independent.

## 3. Advisory versus blocking

**Touched set.** The touched set is:
- ids named in the task's proposal or alignment;
- ids whose `**Code.**` includes a file the task changed;
- the reverse closure of those ids;
- files the task created or changed.

| Finding | `check` (CI) | `scope`, `impact` | align stage | done claim |
| --- | --- | --- | --- | --- |
| Malformed graph (bad field, misplaced `§`, `**From.**` with body, duplicate declaration) | **block** for files parsed | shown in place, `UNPARSED`; exit 1 if in the closure | must appear in Findings | **block** if in touched set |
| Missing reference (unresolved `§`, missing path or From heading, cut id cited) | **block** | frontier; exit 1 if in the closure | Findings | **block** if touched |
| Unmapped region | advisory; can be set to `block` in `spec.json` | changed-unmapped files listed as unknown impact | must be named | **block** for files the task changed |
| Stale or pending relevant claim | advisory | shown per node | Findings; review packets offered | **block**: every touched id needs an applicable receipt, of any status |
| Semantic conflict (`discrepancy`/`unresolved`) | advisory, listed on every run | shown | becomes an Open question | allowed only if it is stated in the final report |
| Failed observation (git, a test, or a resolver could not run) | exit 2 for that measurement | exit 2 if the query needed it | stated | the missing observation is named; it never reads as passed |

Exits: `0` means clear **within the printed boundary**, `1` means a blocking finding, `2` means
not measured, and `3` means partial (budget or staging). Every run prints populations
(`mapped / unmapped / excluded` of the declared population), the boundary, and `REVIEW
REQUIRED`. There is no badge. Unknown global coverage only produces a census line, so
adopting one behaviour at a time stays usable.

**Config** (`.sova/spec/spec.json`):
- `claimsRoot`, `scopes`, `deepKinds`;
- `population.roots`, and `exclude[]`, where every entry has a reason;
- `always[]`, `budget`, and `gate.unmapped`: `advisory|block`.

That is the whole config. Unlike aidv2, a config exists, because portability needs declared
roots. What aidv2 was right about is kept as a rule: no key can suppress a finding or turn
"not measured" into clear.

## 4. Pilot plan (not executed)

**Setup.**
- Tag the baseline `spec-pilot-baseline` at a chosen commit.
- Do all pilot work in a separate `git worktree`, so the dirty main tree is untouched.
- Record which incumbent `spec/` files are dirty at the tag, because the baseline must be named
  at a commit.
- Write `.sova/spec/tools/spec.mjs` by hand for the pilot: Node stdlib only, est. 600–900 lines
  plus fixture tests. Building it is a separate, approved step.

**Stage 1: the composer region.**
- Write claims for the session composer, `§shared/message-text`, `§shared/keyboard`, the
  attachment and slash-command surfaces, the group composer, and **its exclusions**. Use
  `**From.**` for everything incumbent.
- Map the `**Code.**` paths after following real call sites.
- Record receipts. Every discrepancy found is a pilot result, not something to fix silently.

Hypothetical tasks for the evaluation. None of them is an authorized feature:
- **T1:** rich-text session editor with inline chips;
- **T2:** raise the draft attachment limit;
- **T3:** reword the group composer's partial-retry text.

| # | Evaluation | Method | Pass signal (to agree before starting) |
| --- | --- | --- | --- |
| E1 | Scope size **and** omissions | A different model builds a gold read-set per task, with unlimited investigation. Compare scope with gold, with grep of the task noun, and with "whole incumbent files" | recall of gold claims ≥ agreed bar, and every omission explained by frontier or not-measured text; tokens well under the whole-file baseline |
| E2 | Blast radius | `impact` for T1 to T3 against gold. `impact §shared/message-text` must reach drafts, send, mentions, slash, session input and group input. `impact §session.composer/input` must reach nothing declared, and group input may appear only as a `.composer-input` candidate | exact match with the §1.6 graph; T1 never proposes images or slash for the group composer |
| E3 | Planted cases | a byte edit in a mapped file, a claim edit, an edge deletion, a new file, a rename, a malformed field, a cut without a register row, a dirty input at record time | each fails the expected way; the edge deletion still reaches its old consumer; the malformed block appears as `UNPARSED`, not as a smaller scope; no receipt says HEAD for dirty bytes |
| E4 | Reconciliation effort | minutes per packet; discrepancies raised; `pending-upstream` resolved without re-review; false-movement rate | recorded, not assumed |
| E5 | Authoring footprint | lines under `.sova/spec/` per behaviour; count of `**From.**` vs body claims; sentences in claims that restate incumbent text | zero restatements |
| E6 | Alignment with vs without scope | two fresh align-mode sessions on T1, each given the same prompt, on **glm-5.3** (the user's throwaway-test model), one with `scope` output pasted; score Findings and Open questions against a checklist written in advance: string draft seam, IME Enter, caret-based slash and mention tokens, `onSend(text)` contract, group exclusions preserved, protocol coordination | more checklist hits, fewer false claims; report tokens read |
| E7 | No-spec portability | a ~10-file fixture in another language, with no `spec/` and no git, then initialised with git: `init`, three draft claims, scope, census, one receipt | no Sova path is assumed; the non-Git receipt retains all blobs; "since commit" reports unsupported |

**Rollout.** Staged. After stage 1: **go** if E1 to E3 pass and E4 and E5 costs are acceptable to
the user; then stage 2 covers workspaces and settings, with on-demand backfill everywhere else.
**Adjust** if E1 recall is low, which signals that the claims are too coarse or edges are
missing. **Stop** if E6 shows no alignment gain. A full retrofit is never required.

## 5. Integration boundary

- **The core.** `.sova/spec/tools/spec.mjs` runs standalone (`node .sova/spec/tools/spec.mjs
  scope …`). Neither Sova nor Pi is needed.
- **A future minor mode `spec`** would be one more entry beside `align` in `MinorMode`
  (`pi-config/extensions/mode/minor.ts`). No edit happens this round.
- **The discipline it loads**, about 8 lines (proposed):
  1. Run `scope` before changing behaviour.
  2. Paste the verdict, frontier and unread material into alignment Findings.
  3. Turn discrepancies into Open questions.
  4. After the change, run `impact`.
  5. Offer review packets.
  6. Ask before writing receipts or claims.
  7. Never call matching hashes proof.
  8. Say "not measured" out loud.
- **Discovery.** At the first turn, the mode checks for `.sova/spec/spec.json` and the tool.
  - If they are absent, it asks: "bootstrap `.sova/spec/`?" It never creates them on its own.
  - If the tool's version header differs from what the mode expects, it reports that and never
    overwrites the tool.
- **With align.** `confirmed` approves a plan, not a receipt. Writing a proposal file,
  claims or receipts each needs a yes from the user.
- **Limit.** A prompt biases behaviour; it does not guarantee it. The gates in §3 are what the
  tool enforces, and only when it is run.

## 6. Unresolved choices for the user

1. Should the done gate block on every touched id, or only on ids named in the alignment? I
   recommend every touched id.
2. Should a method change invalidate receipts? I recommend no, but show it.
3. Is a disclosed model self-review enough for `reconciled`, or does it cap at `unresolved`
   until another reviewer signs? I recommend allowing it, labelled.
4. The pilot's E1 and E6 thresholds, set before the pilot starts.
5. Does per-fact migration from `spec/` into claims happen in stage 2, or never?

## 7. Limitations

- The tool, the line estimates and all pilot numbers are unbuilt or unmeasured.
- Promise-level dependency binding misses undeclared reliance on implementation.
- A whole-file `**Code.**` over-invalidates.
- The census finds unmapped *files*, not unwritten behaviours inside mapped files.
- A shared CSS class is only a candidate.
- The bullet-level `**From.**` selector is proposed and unverified on Sova's prose shapes.

## 8. References checked (2026-09-23)

- foldaidev:
  - `docs/identifiers/README.md` → **The `§` grammar**, **One declaration rule**, **Where a `§`
    declaration goes** (its source-header row is *not* adopted);
  - `docs/identifiers/spec-graph.mjs:79-89` (`idToFile`, with `section` hardcoded);
  - `docs/identifiers/notation.json`; `docs/identifiers/cut.md`;
  - `spec/foldaidev/revising.md:69` (no rename, cut plus add).
- Sova, at `c8160b6` plus a dirty tree:
  - `spec/04-composer.md:64-124` (Behavior, Drafts at 92-99);
  - `spec/04b-images.md:272` (**Composer attachments**);
  - `spec/14-workspaces.md:360` and `:470` (group composer exclusions);
  - `pi-config/extensions/mode/minor.ts` (`MinorMode`, `ALIGN_INSTRUCTIONS`).
- `astra-judge/synthesis.md` and `round-two-brief.md`.
- My round-one counts are not repeated. The only counts here are the git status populations in
  §2.1, measured in this session.
