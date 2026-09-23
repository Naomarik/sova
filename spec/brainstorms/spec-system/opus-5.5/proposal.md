# `.sova/spec`: a current-implementation manifest (opus-5.5 brainstorm)

Status: independent proposal, 2026-09-23. Nothing here is built. Peers not read.

Labels used throughout: **measured** (I ran it, on the dirty working tree of 2026-09-23),
**proposed** (a design choice), **est.** (a guess about unwritten code or effort),
**unverified** (claimed elsewhere, not checked by me).

## 1. What the evidence says the problem is

- **Grep is not a scope.** measured: `grep -rl composer src server shared` returns 68 files.
  `src/components/Composer.tsx` alone is 1,042 lines. `src/lib/ui-state.ts` is imported by 35
  files, so a pure import closure turns almost any change into a whole-app radius.
- **Sova already annotates source, badly as a map.** measured: 94 files under `src/ server/
  shared/` carry `§N` citations (64 × `§2`, 52 × `§14`). Only 8 files cite bare `§4`. None of
  `src/components/FileMenu.tsx`, `src/lib/files.ts`, `server/drafts.ts` or `src/lib/draft-save.ts`
  cites any section, though all four implement composer behaviour. The user's "no source
  annotations" rule is right: these citations exist and are still an incomplete map.
- **Real untracked behaviour exists today.** measured: the `@` file menu (`FileMenu.tsx`,
  `src/lib/files.ts`, commit `383a35d`) has no home in `spec/`. The only grep hits for "mention" or
  "file-menu" under `spec/` are an unrelated word in `spec/08-token-index.md:6`.
- **The import graph misses real coupling.** measured: `GroupComposer.tsx` has its own `<textarea
  class="input textarea composer-input">` (line 223-225) and does not import `Composer.tsx`. Only
  `ChatView.tsx` and `WatchView.tsx` render `<Composer`. An import-only radius for the composer
  misses the group composer. A CSS-class anchor finds it.
- **Following every edge reaches everything.** foldaidev `docs/identifiers/scope.mjs` header:
  navigation edges are cyclic, dependency edges are few. aidv2 `I-002` reports a 63% read-set cut
  from dependency edges only (unverified by me, and measured on foldaidev's spec, not Sova's).
- **A derived clock lies.** foldaidev `docs/identifiers/stale.mjs` header: a comment-only commit
  reset the derived clock and hid `+73 −20` of brief movement. Only a recorded clock can say
  "someone looked".
- **A composed answer hides its gaps.** abstract-identifiers `doctrine/answers.md` has six kinds of
  absence (absent, resolver failed, unresolved, contradictory, not applicable, not measured) and
  says "complete" is never printed without its boundary. I adopt that whole.

Prior decisions are evidence, not rules. I drop aidv2's "no config file" (portability needs
declared roots) and its hard line caps. I keep "not measured is never green", one home per fact,
and Q-004's warning that `Depends on` lines rot and only their resolution can be checked.

## 2. Two good approaches

### A. Authored ledger

Each feature is a hand-written record: behaviours, file globs it owns, `needs` edges. The tool
hashes owned files at a recorded commit, and anything changed since is stale.

- **Strong:** simple, language-agnostic, one grep-level resolver. Edges mean what the author meant,
  including semantic ones code cannot show ("drafts must survive what the mention menu inserts").
  Stale detection is cheap and exact at file level.
- **Weak:** the file map is a second copy of the codebase's shape and rots on every move. Globs
  over-claim (`src/components/*Composer*` misses `FileMenu.tsx`) or under-claim. Hub files like
  `ui-state.ts` make everything stale on every edit. It cannot notice the group composer unless an
  author already knew.

### B. Anchored, derived map

A record holds features, behaviours, and **anchors**: identifiers the code already exposes (CSS
classes, routes, protocol message types, exported symbols, test files, copy strings). File mapping
and edges are **derived** each run: resolve anchors, add a bounded import neighbourhood, infer
coupling from shared anchors and git co-change.

- **Strong:** no file list to rot. A renamed file still resolves. A vanished anchor is a loud finding.
  Anchor spaces can be enumerated (every CSS class in `src/design/base.css`, every route), so
  unclaimed surfaces are computable. It catches `GroupComposer.tsx` through `.composer-input`.
- **Weak:** needs resolvers per anchor kind and language, so less portable. Derived edges show
  coupling, not dependency: a shared hub import is not a behavioural need. The map changes when the
  code changes, so "what did this behaviour cover at the last review" must be pinned. Semantic
  needs are invisible to it.

### C. Front matter in the existing `spec/` files (the coexistence variant)

Put the same fields as a block at the top of each `spec/*.md`. This avoids a second tree. It is
good for Sova and wrong for portability: most target repos have no prose spec, and Sova's `spec/`
is prescriptive design ("The frontend builds exactly this", `spec/overview.md:3`), not a record of
current state. It also ties identity to file numbering (`04-composer.md`, `04b`, `04g`).

## 3. Recommendation: anchored ledger (A's skeleton, B's mapping)

Authored parts: features, behaviours, `needs` edges, anchors, proposals, receipts. Derived parts,
never committed: resolved files, inferred edges, coverage, slices, radius.

### 3.1 Tree (proposed)

```
.sova/spec/
  README.md               what this is, 8 rules, commands
  manifest.json           roots, ignores (each with a reason), always-read, slice budget
  features/<id>.json      one feature or cross-cutting concern per file
  proposals/<slug>.json   desired deltas; never counted as current
  receipts.json           recorded reconciliations (written by the tool only)
  .cache/                 derived index, gitignored
```

### 3.2 Record schema (proposed, JSON because Node reads it with no dependency)

```json
{
  "id": "composer",
  "kind": "feature",
  "title": "Composer",
  "prose": ["spec/04-composer.md"],
  "anchors": [
    { "css": ".composer-input" },
    { "css": ".composer-flyout" },
    { "file": "src/components/Composer.tsx" }
  ],
  "behaviors": [
    {
      "id": "composer.drafts-survive",
      "says": "A draft survives reload, reconnect, disable and errors.",
      "prose": "spec/04-composer.md#behavior",
      "anchors": [ { "route": "PUT /api/sessions/draft" }, { "symbol": "flushDrafts", "in": "src/lib/ui-state.ts" } ],
      "tests": ["src/lib/draft-save.test.ts"],
      "needs": ["state-dir.atomic-write"]
    },
    {
      "id": "composer.mention-menu",
      "says": "@ opens a file menu; 100 rows drawn, the true total told.",
      "prose": "none: gap, no spec home (measured 2026-09-23)",
      "anchors": [ { "file": "src/components/FileMenu.tsx" }, { "symbol": "insertMention", "in": "src/lib/files.ts" } ],
      "tests": ["src/lib/files.test.ts"],
      "needs": []
    }
  ],
  "needs": ["slash-commands"]
}
```

`state-dir.atomic-write` stands for a cross-cutting concern. It is a record of `kind: "concern"`
with the same schema. That answers aidv2 Q-006: a cross-cutting rule is an ordinary node, and
anything that needs it says so.

### 3.3 Identities

- A behaviour id is `<feature>.<slug>`, lowercase, **append-only**. A rename leaves
  `{"id": old, "moved": new}` in the old file. Paths are never identities. `spec/04-composer.md`
  can be renumbered without touching one id.
- Ids appear only in `.sova/spec/`, in proposals, and in alignment docs. Source files never carry
  them.
- No sigil. aidv2 wanted `§` so grep stays exact inside source. With no ids in source, a dotted
  lowercase id inside JSON string values is already exact. If ids later spread into prose, add a
  sigil then. The rewrite cost is bounded to `.sova/` and `spec/`.

### 3.4 Authoritative vs inferred

| Link | Source | Authority | Checked for |
| --- | --- | --- | --- |
| `needs` | authored | yes: "must hold for this to hold" | resolves; acyclic; corroboration (below) |
| anchor → files | derived by resolver | yes for the mapping at a receipt | ≥1 hit, else broken |
| `prose` pointer | authored | prose wins over `says` | file + heading exist |
| import neighbour | inferred, depth 1 | no | printed with provenance |
| shared anchor (two features hit one file) | inferred | no | printed as co-mapped |
| co-change (git) | inferred | no | printed with counts, e.g. "7 of 12 commits" |
| existing `§N` comment | inferred | no | harvested as a hint only |

**Corroboration check (proposed):** an inferred cross-feature import with no authored `needs`
prints `uncorroborated coupling`. An authored `needs` with no inferred support prints `semantic
only`. Neither fails. This check keeps the graph from being decoration (Q-004's condition) without
pretending an import is a dependency.

**Hub rule:** a file hit by more than N features (N=4 est.), or marked `hub` in `manifest.json`,
contributes only the anchored symbol's text span to fingerprints. The span is found with a
TypeScript parse (proposed, unverified), and the omission is printed. Without this rule,
`ui-state.ts` makes every edit a global reconcile.

### 3.5 Graph semantics, slices, limits

- **Slice(behaviour)** is `always` files, plus the prose sections of the behaviour and its
  `needs`-closure, plus resolved code files ranked (own anchors, then closure anchors, then depth-1
  importers). The slice fills a line budget. Navigation-type links arrive as names only.
- **Radius(change)** is a change given as behaviour ids or file paths. Output: behaviours whose
  anchors resolve into the changed files, their reverse `needs`-closure, co-mapped behaviours, and
  depth-1 importers (labelled inferred).
- Every answer prints its **boundary**: classes measured, classes not measured and why, broken
  anchors, commits read, and whether the tree was dirty. The verdict is one of `complete within
  boundary`, `incomplete` or `unsupported`, as in `answers.md`. Never "complete" alone.
- **Standing limits, printed every time:** runtime behaviour, visual layout, pi-config consumers
  outside `roots`, anything reached only through dynamic dispatch or strings, and any behaviour
  nobody wrote down. A slice is a reading list, not the context. An agent handed one is told it may
  be short.

### 3.6 Maintenance, and the untracked or new

- **Coverage (measured by set difference):** files in `roots` claimed by no anchor and not
  ignored (with a reason) print as `unclaimed`. Unadopted areas print `not adopted`, never clean.
- **Surface spaces:** each anchor kind with an enumerator (CSS classes from `src/design/base.css`
  and `src/app.css`, routes, `shared/protocol.ts` message types, test files) diffs both ways.
  Declared-but-absent means a broken anchor. Present-but-unclaimed means an `unclaimed surface`.
  A route list read from source is labelled `read, not run` (aidv2 `DECISION.md` rule 5).
- **On a diff (`--base <sha>`):** changed unclaimed files print as `untracked change`. New exports,
  classes or routes print as `new surface candidates`. **Not detectable:** a new behaviour added
  inside an already-claimed file (a new shortcut in `Composer.tsx`). It shows only as "composer
  moved". The report says so.

### 3.7 Stale detection and targeted reconciliation

A receipt holds a behaviour id, a commit, a fingerprint, a reviewer, a status
(`reconciled | unaffected | unresolved`), a reason, and whether the reviewer authored the change.
The fingerprint is a sha256 over: the behaviour record, the bytes of its prose section, the bytes
of the resolved files (or spans), and the ids and records of its `needs`. States:

- `clean`: measured, unchanged since the receipt.
- `moved`: says which input moved (prose, code, record, or a needed behaviour).
- `unknown`: no receipt, receipt commit gone, or inputs dirty or uncommitted. Never green.

`reconcile <id>` prints a **packet**: record, prose diff since the receipt commit, code diff of
resolved files, `needs` labels, and tests. It then records one receipt per id. There is no bulk
record, per abstract-identifiers `verification.md`.

### 3.8 Semantic honesty

Hashes say bytes moved. Anchors say an identifier exists. `needs` says an author believed
something. None of these says a sentence is true. Each behaviour gets columns, not a score:
`mapped`, `prose`, `tested` (test file exists; "passed" only if this run ran it), and `reviewed`
(a fresh receipt). A model reviewer is recorded as `model:<id>`. Every run ends with `REVIEW
REQUIRED: no check here reads meaning`.

### 3.9 Proposed change vs current truth

`features/` describes **current code only**. Desired change lives in `proposals/<slug>.json`:

```json
{ "slug": "rich-text-composer", "status": "draft|confirmed|implementing|landed|dropped",
  "alignment": { "session": "<id>", "alignDocRevision": 3 },
  "changes": [ { "op": "change", "id": "composer.mention-menu", "says": "…" },
               { "op": "add", "id": "composer.inline-chips", "in": "composer", "says": "…" } ] }
```

A proposal is never counted as coverage and never reads green: "not landed is never truth" (Q-007
shape). Landing an implementation involves three steps. First, the implementer edits `features/`.
Second, every changed id and every id in the recorded radius gets a receipt. Third, the proposal is
deleted, with git keeping it. A current record may not cite a proposal. Sova's align mode
(`pi-config/extensions/mode/align.ts`, `Findings/Approach/Open questions/Status`) fills
`### Findings` from `radius`. `Status: confirmed` is the moment a proposal becomes `confirmed`.

### 3.10 Coexistence and the two-sources problem

Sova now has two candidate homes for a behaviour sentence: `spec/04-composer.md` and a `says`
line. Rules (proposed):

1. When `prose` points at a real section, `says` is a **label** of one line, and prose is the
   authority. Nothing checks that they agree. That limit is stated, not solved.
2. With no prose (portable repos, or gaps like the mention menu), `says` is the claim.
3. `spec/` in Sova is design intent. The manifest never edits it. Disagreement found at
   reconcile is recorded as `status: unresolved` with the quote, and a human decides which side
   changes. Neither side wins silently.

**Open question for the user:** is `.sova/spec` meant to eventually replace `spec/` as the home of
current behaviour, with `spec/` kept as design history? Until that is answered, rule 1 keeps one
authority per sentence.

## 4. Worked example: rich-text composer

Desired: replace the `<textarea>` with a rich editor holding inline path and mention chips.

1. **Align.** The user asks. Align mode runs `radius composer.mention-menu composer.drafts-survive
   src/components/Composer.tsx`. Expected output, derived by hand from measured facts, as the tool
   is unbuilt:
   - direct: `composer.*` behaviours anchored in `Composer.tsx`. There are 8 `selectionStart /
     selectionEnd / setSelectionRange` uses there (measured) that assume a textarea caret.
   - co-mapped via `.composer-input`: `GroupComposer.tsx` (import graph would miss it).
   - reverse needs: `slash-commands` (caret token `slashTokenAt`, `src/lib/slash.ts`).
     `workspaces.group-composer`.
   - serialization: `composer.drafts-survive`. `server/drafts.ts` stores `text`, so chips must
     round-trip as plain text or the drafts schema changes. That becomes an Open question.
   - inferred, depth 1: 35 importers of `ui-state.ts` suppressed by the hub rule, count printed.
   - not measured: visual layout, screen-reader behaviour, IME and paste behaviour, pi's prompt
     wire format (outside `roots`).
2. **Propose.** `proposals/rich-text-composer.json` adds `composer.inline-chips` and changes
   `composer.mention-menu` and `composer.drafts-survive`. Status becomes `confirmed` when the align
   doc does.
3. **Slice for the implementer.** Always-set `spec/00-ground-rules.md` (211 lines), plus
   `04-composer.md` (276), the slash-commands section, `Composer.tsx` (1,042), `files.ts` (211),
   `slash.ts` (89), `draft-save.ts` (69), `server/drafts.ts` (164) and `GroupComposer.tsx` (264).
   That is about 2,300 lines, against 68 files from grep. Estimated from measured file sizes. The
   slice prints "may be short: IME and a11y unmeasured".
4. **Land.** The implementer updates `features/composer.json`: new anchor
   `{ "css": ".composer-editor" }`, and the textarea anchor goes. The run shows `.composer-input`
   still hit in `GroupComposer.tsx`, which is either intended or a missed migration. It is a
   finding either way.
5. **Reconcile.** Five ids are `moved`. Each gets a packet and a receipt. Where the design prose
   in `spec/04-composer.md:31` still says `<textarea>`, the receipt is `unresolved` until the
   designer edits §4.

## 5. The first two hours (est.)

| Time | Step | End state |
| --- | --- | --- |
| 0:00–0:15 | `init`: README, `manifest.json` with `roots: [src, server, shared]`, ignores with reasons | every file `not adopted` |
| 0:15–0:30 | first `coverage` run | populations printed, 0 claimed |
| 0:30–1:15 | write `features/composer.json`, 4–6 behaviours, anchors | resolved map, surprises seen (group composer) |
| 1:15–1:35 | falsify: bogus anchor → broken, delete a claim → unclaimed, stale a file → moved; restore | the checks have been seen failing |
| 1:35–2:00 | reconcile 2 behaviours, commit | 2 `clean`, the rest `unknown` |

Adoption grows one feature at a time. The coverage line is the progress bar, and it says
`not adopted` about the rest.

## 6. Guardrails and costs

- One record kind. One authored edge (`needs`). Inferred edges are never committed.
- `manifest.json` has four keys. An ignore without a reason is a finding. No key disables a check.
- `says` is one line. More than ~12 behaviours in a feature means split it (a guardrail, not a cap).
- Nothing in source. No derived file committed except `receipts.json`.
- Tool est. 700–1,000 lines, Node stdlib, plus tests with planted fixtures (the abstract-identifiers
  control-block idea). The TypeScript span-hasher is the only language-specific part, and it is
  optional.
- It must run without the Sova server (portability). Where it lives is open.
- **Costs:** 15–40 min per feature to author (est.). Receipt churn on busy files. False `moved`
  from unrelated edits (the price of never trusting a derived clock). Per-kind resolvers. A second
  place to look beside `spec/`.

## 7. Not verified

Every line and minute estimate above. That symbol-span hashing tames hub files. That anchors stay
stable under Sova's refactor rate (`Composer.tsx` changed in 27 commits between 2026-09-19 and
09-23, measured with `git log`). That the corroboration check is signal rather than noise. That radius output helps
align mode more than it distracts. The 63% slice cut, which was foldaidev's, not Sova's.
