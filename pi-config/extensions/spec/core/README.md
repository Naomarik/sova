# sova-spec core

A standalone, read-only Node CLI for a project's `.sova/spec/`. It uses only the Node standard
library. There is no install step and no config import, and it never writes a file.

```sh
node sova-spec.mjs check                [--root DIR] [--spec DIR] [--json]
node sova-spec.mjs packet §ns/name      [--part prose|inventory|frontier|code|findings|frame] [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR] [--read-policy review]
node sova-spec.mjs toc    §ns/name --dir out|in|down|up|mentions [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]
node sova-spec.mjs read   §ns/name      [--whole] [--no-frame] | read --frame [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]
node sova-spec.mjs scope  §ns/name      [--root DIR] [--spec DIR] [--json] [--budget BYTES]
node sova-spec.mjs impact §ns/name      [--root DIR] [--spec DIR] [--json]
node sova-spec.mjs impact §ns/name --near [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]
node sova-spec.mjs map    [namespace | §ns/name] [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]
node sova-spec.mjs where  <path|token>  [--token] [--all] [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]
node sova-spec.mjs graph                [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]
node sova-spec.mjs census               [--root DIR] [--spec DIR] [--json]
node sova-spec.mjs census --changed [--base REV] [--related] [--own-base REV]... [--root DIR] [--spec DIR] [--json]
node sova-spec.mjs foreign --base REV [--head REV | --spec DIR] [--own-base REV]... [--landing [--drafts DIR]...] [--root DIR] [--json]
```

`--spec` picks which spec graph to read. It's a directory relative to the project root, and it
defaults to `.sova/spec` (the current documentation). A feature draft is read with, for example,
`--spec .sova/spec/drafts/NAME/spec`. Only the manifest and claims come from that directory.
`code` and `incumbent` paths always stay relative to the project root. `--spec` is a usage error
if it's absolute, contains `..`, or names the root itself. A symlink on any segment of the path to
its manifest or claims makes the graph untrustworthy.

Without `--root`, it looks for `<spec>/manifest.json` in the current directory and then in each
parent.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Usable output over the known declared closure. **Never** a completeness claim. |
| 1 | Relevant unknown, stale, unresolved, or unread content: dangling edge, missing `requires`, a code path that is missing, refused (absolute, outside the root, through a symlink), unreadable or not a regular file, provenance moved/changed/missing/refused/unreadable, budget left passages unread (including the requested one), no census boundary, unreadable census directory, a changed file in the boundary that no record claims (`changed-unclaimed`, one per file). |
| 2 | Output can't be trusted: usage error, unreadable or unsupported manifest, malformed record, bad declaration, a symlink anywhere on the claims path or in the claims tree, an unreadable claims file or directory, an unknown seed, or an internal error. For `census --changed`: no Git work tree, or an enclosing repository that ignores the project (`not-git`), a `--base` that doesn't name a commit (`bad-rev`), or a failed Git command (`git-failed`). Scope and impact return no passages while the graph is malformed. A malformed record never enters the graph. |

For commands other than `packet`, `--json` prints one object: `tool: "sova-spec"`, `command`, `spec` (the normalized graph
directory), `root`, `exit` (equal to the process status), and `findings[]` (`severity`
error|warn|note, `code`, `message`, and `id`/`file`/`line` where known). It also holds the
command's results. A `note` never changes the exit code. Every `file` in the output is relative
to the project root. New fields are only ever added. Other tools read this output:
`sova-spec-review.mjs` uses `scope`, and the draft tool uses `check`.

## Bounded task packets

`packet` is the task-reading path; `scope` remains the complete-graph API for deliberate machine
inspection and review, with its existing prose-only budget unchanged. Packets always print compact
JSON (also with `--json`), with no stderr side channel or writes. The default whole-response budget
is 12,000 UTF-8 bytes; explicit integer budgets are 1,024–32,768. The bound includes all metadata,
cursors and the final newline, even on errors. Invalid-budget errors have their own small bound.
`packet --help` is bounded JSON too. This is one CLI response's bound: a host may add an exit-status
footer or result envelope. Keep one packet per tool call rather than concatenating pages into a
single result that can be clipped again.

The default `--part prose` returns exact scope text, never summaries, in deterministic near-first
order: requested claim, its parent orientation, then breadth-first declared obligations. Every prose
item carries its `id`, declared `kind`, and `labels` when present, on partial fragments too. Absent
labels stay absent; authority and evidence labels are recorded declarations, never a derived verdict.
Oversized text uses explicit `fragment: {start, end, total, complete}` UTF-8 byte ranges (exclusive end,
Unicode-scalar-safe). Join contiguous fragments to recover the passage. `complete` means this
item contains the WHOLE passage (`start == 0 && end == total`); even the final fragment of an
oversized passage remains false. Finish at `end == total`, not by waiting for `complete: true`.

Each response exposes `items`, `next`, `counts` for all five streams, `remaining` for the selected
stream (including a partially delivered record), and `status`. Repeat the same ID and part with
`--cursor` set to the returned `next` until the relevant fragments are finished. Start
`--part frontier` separately to inspect declared dependency unknowns, and `--part findings` for
warnings such as missing code that are not frontier entries. `inventory` lists all passage metadata
and byte sizes; `code` and `findings` page the scope's detailed records. These four detail streams
return `{index, value}` items, or `{index, json, fragment}` for oversized records; join contiguous
JSON fragments before parsing them. Counts are record totals, not proof of prior reading. A
cursor continues only its selected stream; it does not consume the others.

`status: more` means that selected stream has more and supplies `next`; `done` has `next: null`.
Exit 1 means more OR existing scope warnings/unknowns; exit 0 means selected-stream done without
scope warnings, never a complete behavioral context or proof that an agent read earlier pages.
Exit 2 is `status: refused`, including invalid graph, usage/cursor errors and a budget too small
to make progress. A known missing manifest adds `cause: manifest-not-found` to `graph-untrusted`;
other graph refusals do not imply a missing spec. Start a draft for that missing-manifest cause,
but never overwrite orphaned claims: the draft tool still refuses `orphaned-spec`. Pagination is separate from dependency unknowns: the frontier does not
substitute page omissions for graph findings. Inspect the stated frontier and unread inventory,
not just the first readable page. This adds no assessment or release gate.

Cursors are stateless navigation tokens, not authenticated identity or reading evidence. They bind
root, spec, seed, read policy, captured inputs, and the actual ordered/serialized streams. Changed
raw manifest/claim sources, changed stream records/order, or relevant
reported provenance/code-readability state invalidate them; restart the stream rather than mixing
versions. Code-content-only changes need not invalidate a cursor when only code locations and
readability were reported. A continuation may change the supported budget. No session, cursor
store or source snapshot is written, and no project code is run.

## Pull: `toc` and `read`

`packet` pushes a claim's whole declared closure. `toc` and `read` let the reader choose instead:
look at the contents one hop out, then read the passages the task needs, one at a time. Both live in
their own modules (`toc.mjs`, `read.mjs`), parse their own flags, and read the graph with this core's
loader. Flags may come before or after the command word. `sova-spec --help` doesn't list them;
`toc --help` and `read --help` print their own bounded JSON help.

**`toc §id --dir DIR`** lists the neighbours one hop away in one direction:

| `--dir` | Lines | Groups |
|---|---|---|
| `out` | the declared `requires`, the `embeds`, the notes `about` it or its H1, then the § the claim's prose names without requiring | `requires`, `embeds`, `about`, `named` |
| `in` | the claims whose `requires` name it; the claims that `embeds` it; the notes `about` it; for an H2, also those that require or embed its H1 and the notes about its H1 (`via` names it) | `required-by`, `required-through-parent`, `embedded-by`, `embedded-through-parent`, `about-it` |
| `down` | an H1's H2s, or a section's members, in declaration order | `children`, `members` |
| `up` | an H2's parent | `parent` |
| `mentions` | the claims whose prose names it | `mentioned-by` |

Each line has `id`, `title`, `kind`, `labels` (when declared), `bytes` (what `read` of it delivers;
an H1's lede) and `whole` (an H1's lede plus all its H2s), `what` and `whatSource`
(`prose|blockquote|none`), and, for `out`, `in` and `mentions`, `why` and `whySource`
(`prose|comment|declared|none`; `declared` is a note's `about` field when its prose names nothing). A record with
`agreed` adds `agreed: {by, at, built}` (built: `code` plus evidence `reviewed` or `verified`), and
the text reads `agreed (decision) <at> by <by>, not built` (or `, built`); `read` items carry it too. What is the first prose sentence after the heading: fences, comments,
tables, thematic breaks and headings skipped, a blockquote only when nothing else is prose, at least 20 and at most
200 characters, never code. Why is the first visible-prose sentence of the linking claim naming the
other, else an HTML comment naming it, else exactly `not mentioned in this claim's text`. Mentions
mask fenced code, HTML comments and double-backtick spans; single backticks count, and `§a.b` reads
as `§a/b`. A line for an id with no record or span is `dangling: true`.

`seed` describes the requested claim the same way, plus `codeFiles` (how many code files its record
lists; `read` names them); for `out` on an H1 with H2s it adds
`childRequires: {h2s, claims, of, uninvestigated}`, how many of its `of` H2s require or embed claims outside the H1, how many distinct claims, and how many H2s are behaviors with no `requires` key (also a `requires-uninvestigated` unknown, so exit 1). `footer` holds `delivered` (always empty: a
contents line is never the passage), `listed` and `notListed` for this response, `otherDirections`
(the line count of each direction not asked) and `unknowns` (`requires-uninvestigated` for a
behavior with no `requires` key, or for `in` the behaviors that could also require it; `unknown` for
dangling targets). Exit 0 is done without unknowns, 1 is more lines or an unknown, 2 a refusal.

**`read §id [--whole]`** returns one passage, exact, with no closure: `items: [{index, id, kind,
labels?, agreed?, code?, codeMore?, title, file, lines, text, fragment}]`, where `code` is the record's
first 12 code paths as `{path, state}` (`present`, `missing`, `refused`, …) and `codeMore` counts the rest, where `text` is byte-for-byte the passage `scope`
returns. An H1 gives its lede; `--whole` gives the lede and then each H2 in declaration order. The
`footer` names (`named`) the passage's `requires` and prose mentions that this read does not deliver on any of its pages,
and for an H1 read as its lede, `children` and `wholeBytes`. Exit 0 is done, 1 more, 2 a refusal.

Both take `--json` (compact JSON) or print readable text, under one whole-response budget either
way: integers 1,024–32,768, default 12,000 for `toc` and 32,768 for `read`, so one passage of
ordinary size is one call. What doesn't fit is paged with `--cursor`, as packet pages: `read`
splits an oversized passage into exact UTF-8 fragments (finish at `end == total`). Cursors bind the
root, spec, request and the whole computed stream, so a spec change that alters it makes them stale. Refusals
(`usage`, `unknown-id`, `graph-untrusted` with `cause: manifest-not-found` when there's no
manifest, `token-malformed`, `token-mismatch-or-stale`, `token-range`, `budget-refused`) are small
JSON within the budget. Nothing is stored.

## Optional record fields: `embeds`, `core`, `about`

Three optional manifest record fields, handled in their own module (`fields.mjs`). None is a kind,
a label value or a top-level key, so an older core reads the manifest and ignores them. A spec whose
records carry none of them gets exactly the output it got before.

| Field | On | Means | Read by |
|---|---|---|---|
| `embeds: [§id]` | any record | surfaces drawn inside this one, needed whole | `scope`/`packet` follow it (reason `embeds`); `impact` walks it back; `toc --dir out` group `embeds`, `--dir in` group `embedded-by`; `read` delivers each target whole after the passage, items marked `embeddedIn` |
| `core: true` | any record, usually an H2 | part of the always-on frame | the frame stream: `packet §id --part frame`, `read --frame`, and `frame.items` on the first page of `read §id` (outside its budget; `--no-frame` drops it) |
| `about: [§id]` | notes only | the surface or behavior the note serves | `toc --dir out` group `about` (also for an H2 of the target H1, marked `via`); `read` footer `about`; `packet` prose, reason `about`, for the seed, its H1 and the surfaces it embeds |

**The frame** is every `core: true` record's passage in file and line order (an H1 gives its lede).
It is never part of another stream or of the requested claim's page budget. When the spec flags at
least one core record, every `packet`, `toc` and `read` response carries `frame: {passages, bytes,
cap, overCap}`, and its text form says how to read it; `packet` counts then include `frame`. The cap
is 12,000 bytes (the sum of the passages' UTF-8 bytes). Over it, the frame is still delivered whole,
and `check` and `packet` report a `frame-over-cap` warning.

`check` errors (exit 2) when `embeds` or `about` is not an array of § ids, or `core` is not a
boolean. It warns on `about` on a record that is not a note (`about-not-note`), a target with no
record (`dangling-edge`), an `embeds` target that is not a surface (`embeds-not-surface`), and an
`about` target that is a note or section (`about-wrong-kind`).

## Look: `map`, `where`, `impact --near`, `graph`

Computed views over the whole graph, for orientation and lookup. `graph.mjs` holds the shared index
(areas, interface tokens, code and reverse `requires`/`embeds` maps, agreement counts), `graph` and `impact --near`; `map.mjs`
and `where.mjs` hold the other two. Like `toc`, each parses its own flags (before or after the
command word), prints compact JSON with `--json` or readable text, pages under one whole-response
budget (1,024–32,768) with a stateless `--cursor` bound to the request and every computed line, and
prints its own bounded JSON with `--help`. Exit 0 is done, 1 more lines or a named unknown, 2 a
refusal as small JSON. Nothing is stored.

**`map [namespace | §ns/name]`** (default budget 32,768). Without an argument: `lines` of
`type: "area"` (`id`, `namespace`, `title`, `what`, `claims`, `labels` as counts by `authority`,
`evidence` and `unlabelled`, `requiresOut`, `requiresIn`: `requires` and `embeds` edges across the area's boundary), then
`type: "hub"` (`path`, `records`: the ten code files the most records list). `counts` holds
`namespaces`, `areas`, `claims`, `labels`, `agreedNotBuilt` and `gaps` (`uninvestigated`, `noCode`, `noProse`,
`noInterfaceToken`). A namespace limits all of it. A §id shows its area (an H2 shows its parent's):
`type: "claim"` lines (H1 first, then declaration order; `requires` is `null` when the key is
absent, `requiredBy` counting requirers and embedders, `agreed` and `built` when the record carries
`agreed`), `out` and `in` crossing edges (`from`, `to`, `kind` `requires|embeds`), and `token` lines
(`token`, `definedBy`, `usedElsewhere`): interface tokens in a claim's heading or first sentence.
`counts.agreedNotBuilt` is `{agreed, notBuilt, oldest, newest}` over the records in view that carry
`agreed`: built is `code` plus `evidence` `reviewed` or `verified` (sova-spec-draft.mjs `BUILT_LABELS`), and
`oldest`/`newest` are the not-built records' `agreed.at` dates, never ages. With no `agreed` record in
view the key is absent and the text says so. `agreed` records who decided and when, not that anyone
read the current words.

**`where <path|token> [--token] [--all]`** (default 12,000). A path is a file some record's `code`
lists or that exists under the root; it is read with the core's own refusal rules. `mode: "path"`:
`file: {path, state, mapped}`, then `ranked` lines (`score`, `shared` tokens, rarest first), then
`unranked` lines (claims listing the file that share no token), top 10 unless `--all` (`total`,
`shown`). An unmapped file lists up to 10 `candidate` lines (a name match, never a mapping), exit 1;
an unreadable file keeps its claims unranked, exit 1. `mode: "token"`: `defines` lines (the token in
the claim's heading or first sentence) then `mentions` lines, each with the matching backticked
`spans`. An interface token is a backticked span (fences and comments masked) of 3+ characters with
a letter and a separator, bracket or sigil, an inner capital, or all capitals; it occurs in a file
with no `[A-Za-z0-9_$]` on either side, and weighs `ln((records + 1) / records using it)`.

**`impact §id --near`** (default 12,000). `impact` without `--near` is unchanged. The family is an
H1 with its H2s, or an H2 alone (claims requiring or embedding its parent count, `via: "parent"`).
`lines` by `group`, in order: `consumer` (one reverse hop over `requires` and `embeds`, contents-line
fields plus `requires`, `embeds` when it embeds, and `why`), `container` (sections with family
`members`), `about` (notes whose `about` names the family or, `via: "parent"`, an H2 seed's H1), `frontier` (behaviors with no `requires` key in the
family or naming it: `reason` `in-family|mentions-family`), `next` (ids requiring or embedding a consumer),
`mentioned` (ids naming the family in prose or in their heading after their own id, frontier ids left out), `code` (per
shared file: `records`, up to 12 `ids`, `more`). `counts.uninvestigatedElsewhere` counts the
behaviors with no `requires` key left to plain `impact`.

**`graph --json`** (default 32,768). Pages of `nodes` (id order: `id`, `kind`, `level`,
`namespace`, `area`, `title`, `what`, `whatSource`, `labels`, `bytes`, `whole`, `file`, `lines`,
`requires` count or `null`, `code` count, `core: true` when set, `agreed` when present) and then `edges`
(`kind` `requires|embeds|member|contains|about|mentions|code`,
`from`, `to`, `dangling` when the target has no record or span). `counts` (`nodes`, `edges`,
`byKind`) is on every page; concatenating `nodes` and `edges` across pages rebuilds one payload,
whatever the budget. Without `--json`, only the counts.

## Format read (version 1)

- The manifest needs `formatVersion: 1`. The manual pilot's `schema: "sova-spec/pilot-manifest"`
  with `version: 1` is also accepted.
- The grammar is fixed to foldaidev's full-token `§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?/[a-z][a-z-]*`.
  Only two grammar values are data: `claimsRoot` (default `claims/`) and `directoryKinds` (default
  `["section"]`). If `grammar.id` is set to any other pattern, the manifest is an error.
- Path resolution follows foldaidev `idToFile`:
  - `§a/b` → `a/b.md`, as an H1.
  - `§a.b/c` → an H2 in `a/b.md`.
  - A directory kind is directory-deep: `§section.x/y` → `section/x/y.md`, as an H1.
- Only an H1 or H2 declares, and it must start with a full ID. Any other H1/H2 is an error.
  Fenced blocks never declare. Setext (underlined) headings aren't read as headings.
- H3–H6 are ordinary prose. They belong to the span of the H1 or H2 above them, so a migrated
  document keeps its subsections, tables and rationale inside the passage. An H3+ whose first
  token starts with `§` is an error (`heading-level`), because it looks like a declaration and
  isn't one. A later `§` in a heading, or anywhere in body text, only cites, and nothing checks it.
- A claim file opens with its H1 lede. A plain H3+ before it is an error (`heading-order`), and
  any other text before it is a warning (`prose-outside-declaration`), because no passage would
  ever return it.
- An H1 lede ends before the first H2, and an H2 ends before the next H1/H2, so spans never
  overlap. Trailing blank lines are trimmed.
- JSON keys cite IDs and never declare them. Every record needs exactly one heading, and every
  heading needs a record.
- A derived `resolution` block is optional and ignored, with a note. Spans are always recomputed
  from headings, so don't author one. The core ignores other unknown fields.

### Safe inspection

Invalid `claimsRoot` configuration is refused before any traversal. Boundary include and exclude
paths are validated by the shared parser, so full and changed census cannot disagree about an
escaping or absolute boundary. Mapped code marked `present` must be readable, not only stat-able.

The review companion invokes the additive `--read-policy review` option. It applies the companion's
secret-name, hard-link, and per-file size refusals before the core opens claim or incumbent contents.
The default core provenance policy is unchanged; callers requiring review-grade refusal must opt in.
This is a cooperative read policy, not protection against a hostile filesystem writer.

Before a working-tree diff, Git configuration and attributes are inspected without running filters.
Selected executable clean/process filters are unsupported and explicitly refused before the diff;
ordinary unused driver configuration does not block inspection. Git's attribute output represents
boolean filter attributes and literal driver names `set`/`unset` identically; if an executable
driver has that ambiguous name, the matching result is conservatively refused. Absent filter
attributes do not select a driver named `unspecified`. Filter command values are never included
in refusal output. Git still runs with fsmonitor disabled and without a local shell.

### Records

- `kind` is one of:
  - `surface`: an H1 area.
  - `behavior`: a requirement.
  - `section`: a working set, directory-deep, with `members`.
  - `note`: reference, decision or rationale prose. It can be an H1 or an H2, and it has no
    `members`.
- `requires` is optional. Leaving it out is flagged (`requires-uninvestigated`, exit 1) only on a
  `behavior`, because only a behavior's missing dependencies are an unknown. `[]` means none
  declared, not proven independence. Never write `[]` to make a warning go away.
- Two optional labels hold declared status. The manifest record is their only home:
  - `authority`: `candidate` (proposed, not a current requirement), `migrated` (ported from
    legacy documentation; it carries that documentation's requirement authority, and the rewrite
    hasn't been re-reviewed), or `accepted` (reviewed and adopted).
  - `evidence`: `unreviewed`, `reviewed`, or `verified`. This is the implementation-evidence status
    a person or a promotion recorded.

  Any other value is `label-invalid` (exit 2). Labels are reported as they are written: `labels`
  on scope passages and impact consumers, and `counts.labels` in check. The core never derives
  them, never treats them as proof, and never lets them change the exit code. `migrated` doesn't
  mean implemented, and `verified` doesn't clear a dangling edge.

## What each command returns

- **packet**: bounded exact task context and separately paged inventories; see above.
- **scope**: actual claim prose, never a summary. The requested passage always comes first.
  - A surface expands its sorted H2 children.
  - A child brings its parent lede as `orientation`, but not its siblings. For a requested child,
    the lede comes right after the child. For any other child reached later (by `requires` or
    `member`), the lede comes right before it, unless it was already emitted. The order is
    deterministic.
  - A section expands its sorted `members`.
  - `requires` is then followed depth-first in sorted order. Each passage appears once and
    collects every reason (`requested`, `child`, `orientation`, `member`, `requires`, with `of`).
    Cycles terminate.
  - `--budget BYTES` counts the UTF-8 bytes of passage `text` and keeps whole passages in order
    until the next one would exceed it. The budget is never exceeded, and no passage is ever
    truncated.
    - The requested passage is counted first, so orientation never uses up its room. If the
      seed alone is larger than the budget, no passage is returned.
    - Every omitted passage is named in `frontier` as `unread-budget`, with its `file`, `lines`
      and `bytes`, and a `budget-unread` warning makes the exit 1. Nothing is dropped silently.
    - `budget: {bytes, used}` reports the limit and what was spent.
    - `code` and the findings from provenance checks still cover the whole closure computed
      before the budget, including passages left unread. The budget only limits which prose is
      returned.
- **impact**: transitive reverse `requires` only, with `depth`. Parents and sections are listed
  separately as `containers`, never as consumers. A behavior that has no `requires` key could be
  an unlisted consumer, so it goes on the frontier.
- **check**: validates the whole graph and every record's evidence. It also returns `counts`
  (including `labels`) and `declarations: [{id, file, lines, level, textSha256}]`, sorted by id.
  `textSha256` is the SHA-256 of exactly the text `scope` would return. `declarations` is still
  emitted when the graph is broken, but it may then be partial.
- **census**: walks only the explicit `boundary: {include: [dir], exclude: [{path, reason}]}`.
  No directory is assumed. All of `.sova/spec` is never counted, and neither is the `--spec`
  directory. That covers current docs, drafts and reviews, whichever graph is read. Symlinks are listed and
  never followed. It reports which boundary files are claimed or unclaimed, and which mapped paths
  lie outside the boundary.
- **census --changed**: checks only the files a task changed. Those are the files that differ between
  `--base` (default `HEAD`) and the working tree, plus untracked files that aren't ignored.
  Deleted files are kept: `deleted: [path]` lists them; a deleted file a record maps is a `claimed`
  (or `mappedOutside`) entry with `deleted: true`, so its ids are touched; a deleted unmapped file has
  nothing to claim and is never `unclaimed`. Git runs as read-only plumbing, without a shell. The boundary rules are
  the same. `census` then holds `mode: "changed"`, `base: {rev, commit}`, `changed` (the count),
  `claimed: [{path, claims}]`, `unclaimed`, `outside` (changed files beyond the boundary, which
  aren't failures), `mappedOutside: [{path, claims}]` (the `outside` files some record's `code`
  maps: never unclaimed, never a warning, but their ids are touched and foreign like any claimed
  file's, since the boundary is not widened), `orphanedEvidence: [{draft, commit, ids}]` (commit
  evidence in `.sova/spec/drafts/*/draft.json` that `HEAD` doesn't contain, as after a rebase; one
  `evidence-orphaned` note each, never a warning) and `symlinks`. Each unclaimed file is a `changed-unclaimed` warning. With no
  boundary it still lists the claimed files, but `unclaimed` and `outside` are null.
- **census --changed --related**: adds `touched: [{id, kind, labels?, created, file, lines, files, requires,
  consumers: [{id, depth}]}]`, one entry per id that claims a changed file, sorted by id. `files`
  are the changed files that put it there; `requires` is the record's list, or `null` when the key
  is absent; `consumers` are transitive reverse `requires`, as `impact` computes them. A touched
  behavior without `requires` is a `touched-uninvestigated` note, never a warning, so the exit
  code is unchanged. Without `--related` the output is exactly as above. `--related` without
  `--changed` is a usage error.
- **Foreign §s (every census --changed).** Reading `.sova/spec`, nothing is *created*. With
  `--spec DIR` (other than `.sova/spec`), an id is created when DIR's manifest has it and
  `.sova/spec/manifest.json` does not (a missing or unreadable current manifest counts as empty; its
  findings are dropped). A claimed changed file's ids that are not created are *foreign*. The census
  object gets, right after `changed`, `foreignNote` (a fixed instruction string), `foreign: [id]`
  (surface ids first, then the rest, each in id order) and `childUnderForeign: [{id, parent}]`
  (empty arrays when none). The instruction ends "plumbing (a request, hook, helper or CSS class) never flags, nor a gap it already had, even one you now rely on; the last line names these foreign §, never your new claims". With `--spec` only, each created
  H2 id whose parent H1 is not created is a `child-under-foreign` note `{id, parent}`, touched or
  not. When `foreign` is non-empty, one `foreign-summary` note `{ids}` (message: the instruction, then
  `: N touched (ids)`) is the last finding, and, if
  stdout is not a TTY, its message is also written to stderr as `sova-spec: <message>`. With
  `--related`, each `touched` entry has `created: true|false` and each touched id that is not
  created is a `touched-foreign` note `{id}`; human output marks entries `; created` or `; foreign`.
  Human output prints the summary before the touched list. Notes never change the exit code; plain
  `census` and `check` are unchanged. With `--own-base REV` (repeatable), the task's own ids (absent
  at every one of those revisions) are never foreign; the census gets `own` and `ownBases`.
- **foreign --base REV [--head REV]**: the § a range of history changes, for a merge's or a
  promotion's `Also changes:` line. It reads `.sova/spec` at each revision from Git objects
  (read-only `ls-tree` and `cat-file --batch`; no checkout), or from the working tree when
  `--head` is omitted; with `--spec DIR` (no `--head`) the working-tree head is that graph, a
  draft's `spec/`, so a turn can name the foreign § its draft edits. An id is in `foreign` when its prose span's text or its canonical record
  differs, when it is deleted, or when it is an H1 on both sides that gains a new H2
  (`child-added`, with `children`), and it is not created in the range (an id head records and
  base does not). A revision without a spec is an empty graph. Output: `base: {rev, commit}`,
  `head: {rev, commit}` (or `{rev: null, worktree: true}`), `foreign: [id]`, `changes: [{id, change,
  children?}]` (`change` joins `text`, `record`, `child-added` with `+`, or is `deleted`),
  `created: [id]`. A bad revision is `bad-rev` and no Git is `not-git`, both exit 2; `--spec` with
  `--head` is a usage error. Human output ends `Foreign § changed: §a, §b` (or `none`).
  For a merge, `--base` is the TARGET's tip before the merge and `--head` its tip after, never the
  branch's start: a branch that merged the target in carries the target's own § (another task's),
  and they are not what the merge lands. A deleted id whose body (all but its heading) reappears under
  a created id carries `renamedTo`; it stays foreign.
- **The task's own claims (`--own-base REV`, repeatable).** An id absent from the spec at every
  own base (the task's fork point from the default branch, the default branch's tip when the task's
  run started, a worktree's recorded base) is the task's own: created by it, in this range or an
  earlier one. Own ids leave `foreign` and `changes`; `own: [id]` lists those the range touched or
  created and `ownBases: [{rev, commit}]` the bases. Master's own new claims exist on its tip, so
  they are never own.
- **Landing lists (`--landing`).** What a merge or promotion lands besides §: `unmappedChanged:
  [{path, status, inBoundary}]` (files the range changed, deletions included, `A|M|D|T`, no renames,
  minus `.sova/`, that no claim's `code` maps in the head spec, or in the `--spec` draft);
  `mappedUntouched: [{id, files}]` (ids, neither foreign, created nor own, whose mapped code the range
  changed: advisory); `unpromotedDrafts: [{draft, worktree, ids}]` (draft records `pending`, or in
  `conflict` without the draft ever promoting them, in each worktree whose HEAD the range brings in:
  an ancestor of head and not of base, never the default branch's own checkout; with no `--head`, the
  root's drafts; and each `--drafts DIR` project root; read with `sova-spec-draft.mjs status`, at most
  20 drafts). Corrupt, unreadable, or capped draft inventories carry `draftScan` (`complete`,
  `scanned`, `capped`, `unread`); a landing also carries top-level `complete` and `incomplete`
  reason codes. An incomplete scan is not evidence that no pending draft exists. Changed census
  carries its evidence inventory state as `census.draftScan`.
  `handResolved: [{commit, ids}]` (when head is a merge commit, ids whose text or record
  differs from every parent's: a hand resolution, see `git show --cc`). None of them changes the exit.
- **§a.b ids.** `packet`, `scope` and `impact` read `§a.b` (not a § identifier) as `§a/b`, with an `id-alias`
  note; an unknown result is `unknown-id` as usual.

## Evidence

- `code` paths are the union across the closure. They are evidence locations, not
  specifications. A path is refused if it's absolute, leaves the project root, or passes through
  a symlink.
- `incumbent` entries are `{file, lines: [a, b], spanSha256 | hash}`. The hash is SHA-256 of
  lines a–b joined by `\n`, with no trailing newline. Each entry reports `current-equal`,
  `span-moved` (with `currentLines`), `changed`, `missing`, `refused`, or `unreadable`.
- Citation and hash state are **provenance only**. A cited or equal span says nothing about
  whether the claim preserves every condition in it. That judgment belongs to review.

## Capture-local internal reader

Companions may import `createInspection(root, {spec, readPolicy})` from this module. Import is
silent; direct CLI invocation, including through a directory symlink, retains the existing output
and refusal contracts. The reader loads one graph and exposes synchronous `check()`, `scope(id)`,
`impact(id)` and `census({base, related})` results with the same JSON envelopes. Returned objects
are detached, so consumer mutation cannot alter another query. `sourceHashes()` returns detached
raw-byte hashes from the graph's actual reads (including any repeated versions and a conflict flag),
not re-encoded prose or another file read. The assessment checks these against bound present inputs
and refuses a mixed-version capture as a race, even when its requested prose is unchanged.
This is a capture-local graph, not a live or persistent cache: create a new reader for every
independent capture/status check. Internal `readPolicy: "assessment"` applies review refusals and
also refuses the assessment receipt store before graph or lazy incumbent contents are read;
ordinary CLI policies are unchanged. The assessment companion uses this policy and batches only
selected, size-approved immutable Git blobs.

The draft sibling exports silent, read-only `inspectDraft(root, name, {base, readPolicy})` for its
existing `check` result. It accepts no write command. The assessment uses `readPolicy: "assessment"`
through the proposed/baseline core checks and proposed/baseline/current claim-tree reads used by
optional draft triage. Receipt/cache paths are refused before the draft's safe content reader,
including when the selected proposed graph is safe but the current claims root names storage.
Only this internal
assessment-policy result includes detached `inputSources` metadata from the exact safe reads of
proposed, baseline and current manifest/claim trees and draft state. Repeated source versions remain
visible; the assessor binds these paths and refuses changed versions as a race. No raw bytes are
returned. Candidate identities staying the same does not conceal changed draft inputs. Default
API results and draft CLI checks retain their original JSON contracts and subprocess path. No new CLI flag, weaker read
policy, source snapshot store or release gate is introduced.

## What this tool does not do

This core only reads. It has no command that writes. Three sibling tools in this directory write,
explicitly and only under `.sova/spec/`, and all use this core for graph inspection (through its
CLI or capture-local reader):

- `sova-spec-draft.mjs` handles drafts. `new NAME --write` copies the whole current graph into
  `.sova/spec/drafts/NAME/`. Promotion checks the draft and the merged candidate with
  `check --spec` before it writes anything. A project with no `.sova/spec` starts here: `new`
  begins from an empty baseline, `{"formatVersion": 1, "claims": {}}`. So there's no separate
  `init`, and docs are written piecemeal as features are worked on. `merge-manifest` merges a
  conflicted `manifest.json` record by record (as a Git merge driver it writes Git's `%A` file,
  the one write outside `.sova/spec/`). See `../DRAFTS.md`.
- `sova-spec-review.mjs` handles review evidence. Its `prepare --write` stores the exact bytes of
  a closure's inputs, `record` stores a reviewer's conclusion, and `status` rechecks them. It
  writes only under `.sova/spec/reviews/`. See `../README.md`.

- `sova-spec-assess.mjs` records observation-only dispositions against exact claim and implementation
  inputs, with metadata-only local receipts and separate applicability/coverage/verification outcomes.
  Its `prepare`, `record`, and `status` commands do not change any existing release or review gate.
  See `../README.md` for the CLI and the distinctions.

None of these tools adopts a claim or decides that code implements prose. The `spec` minor mode
(`../../mode/minor.ts`) tells the agent when to run them. The four entrypoints are shipped together:
the three companions find this core as the sibling `sova-spec.mjs`.
Ship all `core/*.mjs`, including `packet.mjs`; copying only the four entrypoints is insufficient.

Tests: `node --test ../tests/*.test.mjs`
