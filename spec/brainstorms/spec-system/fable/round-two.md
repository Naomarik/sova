# Round two: the remaining decisions (fable)

> Decision proposal only. Nothing implemented, no spec or source edited. Written 2026-09-23
> against Sova at `c8160b6` with a dirty tree: `git status --porcelain` shows 36 modified,
> 22 untracked, 1 deleted; 58 of those rows are under `spec/`, `src/`, `server/`, `shared/`,
> `pi-config/`. Tracked `spec/*.md`: 23 files, 8,104 lines, 190 `##`/`###` headings, measured on
> the working tree.

Settled and not reopened: foldaidev's `§<namespace>/<name>` grammar, `.sova/spec/` as the only
home, the Sova retrofit as pilot, no required annotations, no required incumbent spec.

## 1 · Format and prose discipline

### The unit

One file per unit at `.sova/spec/<scope>/<name>.md`, and the identifier *is* the path, exactly
as foldaidev's `idToFile` computes it (`spec-graph.mjs:79-89`): `§composer/input` is
`composer/input.md`; a child `§composer.input/keys` is a `##` heading inside it. Scopes are data
in `.sova/spec/spec.json` (`"scopes": [...]`), the way `notation.json` holds foldaidev's, never
hardcoded. A declaration is positional: the identifier begins a heading, everywhere else is a
citation (`README.md` → One declaration rule).

A unit is a **head block** of fixed keys directly under the H1, then free prose. The head block
is the only structured grammar; there is no JSON manifest, no frontmatter, no tables of verbs.

```markdown
# §composer/drafts — The draft survives everything
Authority: spec/04-composer.md → **Behavior** · spec/04-composer.md → **Anatomy**
Requires: §message/text
Related: §session/list
Code: src/lib/draft-save.ts · src/components/Composer.tsx · server/drafts.ts
Reviewed: 2026-09-23 · self · reviews/composer/drafts/1.md

What differs from the authority, or where inside it to look. Nothing restated.
```

| Key | Meaning | Absent means |
|---|---|---|
| `Authority` | Where the promise text lives: `path.md → **Heading**` citations, or the word `here` | **not mapped** (finding) |
| `Requires` | Changing this unit correctly needs these units' promises. Traversed forward; reversed by computation | **not mapped**. `none` means "none after review" |
| `Related` | Named in the slice, never opened | nothing |
| `Code` | Whole files where implementation evidence was found. Not a claim the file is fully specified | **not mapped** (finding) |
| `Reviewed` | Pointer to the latest receipt; the receipt is the record, this line is a convenience | never reviewed |

`Authority: here` makes the unit's own body the promise. `Authority:` naming a heading makes the
body a delta only. Exactly one of the two, so no paraphrase competes with the incumbent. Two units
citing the same heading is a **competing-authority** finding printed with both ids; the tool never
picks (abstract-identifiers `doctrine/answers.md` → contradictory authority).

**Heading resolution.** A cited heading spans from the matching heading line to the next heading
of the same or higher level, matched on exact text after stripping `#`s. Two identical headings in
one file, or none, is an unresolved reference with `file:line`. Line numbers are never authored.

**Alternatives weighed.** foldaidev's `## Depends on` / `## Links out` tables: the same information
at roughly six lines per verb per unit, and `spec-graph.mjs` needs `blockRows` and `cells`
to read them. The judge's `manifest.json`: parses trivially but centralises every edit into one
hotspot and separates a relation from the prose that explains it. The head block is five lines,
co-located, and a parser for it is `^([A-Z][a-z]+): (.*)$` over the lines between the H1 and the
first blank line. A line that does not parse is a located finding, and the unit still counts.

### Prose rules, with the composer's own text

Rules: one promise per sentence, condition first; no argument inside a promise (it moves to a
`## Why` or is dropped); cite a thing by identifier or heading, not by description; a number only
when it is the promise. Before, from `spec/04-composer.md` → Behavior, Drafts (108 words):

> Drafts are never discarded. The draft survives disable/enable, reconnects, and errors, and it
> survives a reload too. Each session's draft lives in two places: In memory, per session path.
> This is the authority within a tab, so switching sessions and coming back restores the draft at
> once. On the server, per session. `PUT /api/sessions/draft { path, text, attachments? }` writes
> it to `~/.pi/agent/sova/drafts.json`, keyed by session id; whitespace-only text with no
> attachments deletes the entry.

After, as a `here` unit body (44 words):

> A draft is never discarded: it survives disable, reconnect, error and reload.
> In one tab, memory per session path is the authority. Across tabs, the server copy is.
> The server stores `{ text, attachments }` keyed by session id, and deletes it only when both
> are empty.

The route and file path leave the promise and go to `Code:` and the mechanism they belong to.
In the Sova pilot this rewrite is **not** performed: `Authority:` cites the incumbent heading and
the unit body is empty or one line. The rule applies to new `here` units only.

### No prior spec, and Sova's incumbent

A project with no spec writes `here` units; init creates `spec.json` and `README.md` and no
units. Sova writes citing units. Existing `§N` comments in Sova code are read by an optional
`candidates` command that prints `src/components/Composer.tsx cites §4, §4b` beside a unit whose
authority is `04-composer.md`; it never writes a `Code:` line. Retirement follows foldaidev
(`revising.md` → Rename a surface: there is no rename): a row in `.sova/spec/cut.md` with
successor and reason, the name never reused.

## 2 · Dirty-tree review records

**Options.** (a) Committed-only: a receipt binds to blob hashes at a commit; any dirty input
refuses recording. (b) Exact working-byte snapshots: copy every input into `.sova/spec/reviews/`
at record time. (c) **Content-addressed input set**: hash the exact bytes of every input as they
are on disk, record the hashes and the HEAD they were taken beside, retain no copies.

**Choose (c).** It is the smallest model that is honest on Sova's tree, where the reviewed input is
routinely dirty (36 modified files today). (a) would block every review until a commit, which
pushes reconciliation after the moment it is cheapest. (b) retains bytes git already has for
tracked files and doubles the review folder for nothing the receipt needs. (c) needs no git at
all; git only supplies the *old* side of a packet and rename hints.

**Input set for unit U, hashed individually, absence recorded as `absent`:**

1. U's own file.
2. Each `Authority:` span of U (the resolved heading span bytes, not the whole file).
3. Each `Code:` file of U, whole.
4. For each `Requires:` target T, one hop: T's file and T's `Authority:` spans. Dependency
   evidence movement is an input by design; it invalidates U's receipt without proving U broken.
5. `spec.json` and every `always` file.
6. The tool's format version string.

Excluded always: `.sova/spec/reviews/**`, `.sova/spec/.cache/**`. A receipt never hashes itself.

**Receipt** at `.sova/spec/reviews/<scope>/<name>/<n>.json`, append-only:

```json
{ "unit": "§composer/drafts", "format": 1,
  "head": "c8160b6", "dirty": ["src/lib/draft-save.ts"],
  "inputs": { "composer/drafts.md": "sha256:…", "spec/04-composer.md#Behavior": "sha256:…",
              "src/lib/draft-save.ts": "sha256:…", "message/text.md": "sha256:…" },
  "mapping": { "requires": ["§message/text"], "code": ["src/lib/draft-save.ts", "…"] },
  "status": "reconciled", "reviewer": "omar", "self": true,
  "reason": "draft-save.ts still writes {text,attachments}; whitespace-only deletes",
  "evidence": "reviews/composer/drafts/1.md" }
```

`dirty` lists only inputs whose working bytes differ from HEAD. A receipt with a non-empty
`dirty` list never certifies HEAD; it certifies the hashes. Unrelated dirty files are not
consulted (foldaidev's `reconcileTarget` checks only the authority tree; this checks only the
input set). `evidence` is a reviewer-written file with the quotes compared; the gate never opens it
(`spec-sync.md` → Receipt format).

**Old and new.** A packet for U is built over the **union** of U's current mapping and the mapping
in U's last receipt: a `Requires` edge or `Code` path removed since then is still in the packet,
marked `removed`, so deleting an edge cannot delete its review obligation. Reverse impact of a
change to T is computed over reverse `Requires` from both the current graph and every receipt's
recorded `mapping.requires`, so a consumer that dropped its edge still appears once, marked
`former consumer`. New files under declared roots with no `Code:` line are a census finding
(`changed-but-unmapped`), not part of any packet until mapped. A git rename is printed as a
proposed `Code:` update, never applied.

**Races.** `record` recomputes every hash immediately before writing and refuses if any differs
from the packet it was given. Non-git projects: identical hashing; the `head` field is `null`,
`dirty` is `unknown`, and the packet shows current bytes only, saying so.

**Four words kept apart on every report.** *Moved*: some input hash differs from the last
receipt. *Applicable*: a receipt exists and all its hashes match now. *Correct*: never claimed by
any command. *Claimed review*: status, reviewer, and `self: true` where the reviewer is the author
or the model that wrote the change. Self-review is allowed and always disclosed, never called
independent.

## 3 · Advisory versus blocking

Exit codes: `0` every binding check measured and clean · `1` a binding finding · `2` a binding
check could not be measured. Each check prints `PASS`, `FAIL`, `ADVISORY` or `NOT MEASURED`, its
population (`over 6 units, 14 authority spans, 9 code files`), and what it does not prove. There is
no summary badge.

**Binding scope is the touched set, not the repository.** Touched = units in the current slice ∪
units whose `Code:` or `Authority:` intersects files changed since the last receipt (git) or since
the last run (`.cache` hash list, no git). Global coverage is reported and never binds, so a
three-unit adoption exits 0 with 20 unmapped spec files listed.

| Finding | `check` | `scope` / `impact` | reconcile stage |
|---|---|---|---|
| Malformed head line, bad identifier | FAIL, `file:line`, unit kept | shown in frontier, slice not shrunk | FAIL |
| Unresolved `§`, path, heading | FAIL if in touched set, else ADVISORY | frontier entry | FAIL |
| Unit with no `Requires:` / `Authority:` / `Code:` | ADVISORY (count) | frontier entry, "not mapped" | FAIL for the unit being reconciled |
| File in roots with no `Code:` | ADVISORY census | listed if changed | ADVISORY |
| Competing authority (two units, one heading) | FAIL | both shown | FAIL |
| Receipt inputs moved, unit in touched set | FAIL | header line "N slice units moved since review" | FAIL until re-recorded |
| Receipt inputs moved, unit untouched | ADVISORY | not shown | not shown |
| Receipt `unresolved` | FAIL in touched set | shown | FAIL |
| Cannot read git, file, or spec.json | NOT MEASURED, exit 2 if binding | printed | exit 2 |

Configuration exists and is honest: `spec.json` declares `roots`, `exclude` (each with a
`reason`), `always`, and `advisory: ["…"]` to demote a check. A demoted check prints
`ADVISORY (demoted: <reason>)` on every run. This is deliberately not aidv2's no-config policy,
because a portable tool must be told where source lives; the guard is that nothing can be turned
off silently.

## 4 · Pilot plan (not executed)

**Baseline preserved by construction.** `spec/` is not edited. The retrofit is `.sova/spec/`
citing it. Tag `c8160b6` as `spec-pilot-baseline` for the comparison runs.

**Stage 1, composer neighbourhood, 7 units.** `§composer/input`, `§composer/drafts`,
`§composer/send`, `§composer/flyout`, `§composer/mentions` (`Authority:` absent, a live
unspecified case: the `@` menu has code and no spec heading), `§message/text` (`here`, the string
contract both composers share), `§workspace/input` (authority `spec/14-workspaces.md → **The group
composer**`, body: "carries no images and no slash commands, on purpose"). `GroupComposer.tsx`
does not import `Composer.tsx` (its header at lines 11-20 says what it omits and why), so
`§workspace/input` requires `§message/text` and `§input/keyboard` only. Always-read:
`.claude/skills/fold-ai-dev-design/SKILL.md`.

**Stage 2, the dirty area:** mode menu, settings, delegate. **Stage 3:** decide full rollout or
stop, on the numbers below. Recommend staged: 7 units is one afternoon and the evaluation is the
point.

**Evaluation task:** a hypothetical rich-text composer change (formatting, mention chips), used only
as an exercise. Two runs of `align` mode on the same prompt with a throwaway model, one with the
`scope §composer/input` output pasted, one without. Score Findings against four seams the judge
verified: string draft payload in `draft-save.ts`, string storage in `server/drafts.ts`, the
separate `GroupComposer.tsx`, IME Enter. Record which run names each, and what each run reads
that the other did not.

| Measure | How | Pass looks like |
|---|---|---|
| Scope size **and** omissions | bytes/tokens of slice vs whole cited files; a person lists what the change needed, diffed against the slice | smaller, and every miss is on the printed frontier, not silent |
| Blast radius | `impact §message/text` must list `§workspace/input`; `impact §composer/input` must not, but must print the shared `.composer-input` class as a candidate | both hold |
| Planted drift | edit the Drafts paragraph in `spec/04-composer.md` | `§composer/drafts` and its `Requires` consumers read moved; nothing else |
| Planted edge deletion | remove `Requires: §message/text` from `composer/drafts.md` | `impact §message/text` still lists it as former consumer |
| Planted new file | add `src/components/RichInput.tsx` under roots | census: changed-but-unmapped; no slice claims it |
| Planted malformed line | `Requres:` typo | FAIL with `file:line`; unit count unchanged |
| Reconciliation effort | minutes per receipt, receipts per stage | ≤ 10 min per unit after the first |
| Authoring footprint | lines per citing unit | ≤ 8 head+body; `here` units ≤ 25 |
| Portability fixture | a throwaway folder with no git, no spec, three `here` units | every command runs; `head: null`, `dirty: unknown` printed |

Group composer: the pilot asserts its unit's promise stays "no attachments, no slash" and that
no slice for the session composer pulls it in as a requirement.

## Integration boundary

A minor mode (`spec`, beside `align` in `minor.ts`'s registry) loads a discipline of about twelve
lines: before Findings, run `scope` for the units the ask touches and paste the frontier into Open
questions; never write `.sova/spec/` before the user confirms; after implementation, run `check`
and offer `record`. The prompt is a request. Compliance is measured only by `check` at reconcile.

Discovery: the mode looks for `<ctx.cwd>/.sova/spec/spec.json` and a vendored
`.sova/spec/tools/sova-spec.mjs` whose first line carries its format version (Pi docs:
`ctx.cwd`, `extensions.md` → ExtensionContext). Missing either, it says so in the widget and asks
via `ctx.ui.confirm` before bootstrapping, guarded by `ctx.hasUI`; in print or JSON mode it never
writes. `record` is offered through the same confirm. Composition with alignment: the existing
`align-doc` capture (`align.ts`) stays untouched; the scope output goes into the block the user
already reads. No extension, server, or `shared/protocol.ts` change in this round.

## Unresolved choices

1. Whether `Requires` one-hop dependency evidence (item 4 of the input set) is too noisy on
   whole files; the pilot's reconciliation-effort number decides.
2. Whether `§composer/mentions` gets a `here` promise written during the pilot or stays a
   recorded unspecified finding.
3. Reviewer policy: self-review disclosed is proposed as sufficient during adoption; the user may
   want `self: true` receipts to fail `check` at some later stage.
4. Whether the minor mode is `spec` or an extension of `align`.

## Verified references and limitations

Read on 2026-09-23: `~/webapps/foldaidev/docs/identifiers/README.md` → The § grammar, One
declaration rule, Where a declaration goes; `spec-graph.mjs:79-89` (`idToFile`), `:49-50` (verb
lists); `notation.json`; `spec/foldaidev/revising.md` → Rename a surface; `docs/identifiers/
spec-sync.md` → Receipt format, Results and limits; `stale.mjs` `reconcileTarget`;
`~/github/abstract-identifiers/doctrine/verification.md` → A receipt is pinned to exact bytes,
Three dispositions; `doctrine/answers.md` → Six absences; Sova `spec/04-composer.md` → Behavior,
`spec/14-workspaces.md` → The group composer, `src/components/GroupComposer.tsx:1-20`,
`pi-config/extensions/mode/minor.ts`, `align.ts:1-30`; Pi `docs/extensions.md` → `ctx.cwd`,
`ctx.hasUI`, `ctx.ui.confirm`, `pi.registerCommand`.

Not verified: any line estimate for the tool; that heading-text matching is stable across Sova's
190 headings; the false-positive rate of one-hop dependency evidence; that a twelve-line prompt
changes agent behaviour at all; the reconciliation and footprint targets. No command was run
against the repository beyond `git status`, `git ls-files`, `wc`, `rg` and `sed`. The judge's
verified composer seams were not independently re-read beyond `GroupComposer.tsx`'s header and
imports.
