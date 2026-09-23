# sova-spec core

A standalone, read-only Node CLI for a project's `.sova/spec/`. It uses only the Node standard
library. There is no install step and no config import, and it never writes a file.

```sh
node sova-spec.mjs check                [--root DIR] [--spec DIR] [--json]
node sova-spec.mjs scope  §ns/name      [--root DIR] [--spec DIR] [--json] [--budget BYTES]
node sova-spec.mjs impact §ns/name      [--root DIR] [--spec DIR] [--json]
node sova-spec.mjs census               [--root DIR] [--spec DIR] [--json]
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
| 1 | Relevant unknown, stale, unresolved, or unread content: dangling edge, missing `requires`, a code path that is missing, refused (absolute, outside the root, through a symlink), unreadable or not a regular file, provenance moved/changed/missing/refused/unreadable, budget left passages unread (including the requested one), no census boundary, unreadable census directory. |
| 2 | Output can't be trusted: usage error, unreadable or unsupported manifest, malformed record, bad declaration, a symlink anywhere on the claims path or in the claims tree, an unreadable claims file or directory, an unknown seed, or an internal error. Scope and impact return no passages while the graph is malformed. A malformed record never enters the graph. |

`--json` prints one object: `tool: "sova-spec"`, `command`, `spec` (the normalized graph
directory), `root`, `exit` (equal to the process status), and `findings[]` (`severity`
error|warn|note, `code`, `message`, and `id`/`file`/`line` where known). It also holds the
command's results. A `note` never changes the exit code. Every `file` in the output is relative
to the project root. New fields are only ever added. Other tools read this output:
`sova-spec-review.mjs` uses `scope`, and the draft tool uses `check`.

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

## Evidence

- `code` paths are the union across the closure. They are evidence locations, not
  specifications. A path is refused if it's absolute, leaves the project root, or passes through
  a symlink.
- `incumbent` entries are `{file, lines: [a, b], spanSha256 | hash}`. The hash is SHA-256 of
  lines a–b joined by `\n`, with no trailing newline. Each entry reports `current-equal`,
  `span-moved` (with `currentLines`), `changed`, `missing`, `refused`, or `unreadable`.
- Citation and hash state are **provenance only**. A cited or equal span says nothing about
  whether the claim preserves every condition in it. That judgment belongs to review.

## What this tool does not do

This core only reads. It has no command that writes. Two sibling tools in this directory write,
explicitly and only under `.sova/spec/`, and both run this core rather than parse claims
themselves:

- `sova-spec-draft.mjs` handles drafts. `new NAME --write` copies the whole current graph into
  `.sova/spec/drafts/NAME/`. Promotion checks the draft and the merged candidate with
  `check --spec` before it writes anything. A project with no `.sova/spec` starts here: `new`
  begins from an empty baseline, `{"formatVersion": 1, "claims": {}}`. So there's no separate
  `init`, and docs are written piecemeal as features are worked on. See `../DRAFTS.md`.
- `sova-spec-review.mjs` handles review evidence. Its `prepare --write` stores the exact bytes of
  a closure's inputs, `record` stores a reviewer's conclusion, and `status` rechecks them. It
  writes only under `.sova/spec/reviews/`. See `../README.md`.

Neither tool adopts a claim or decides that code implements prose. The `spec` minor mode
(`../../mode/minor.ts`) tells the agent when to run them. The three tools are shipped together:
the other two find this core as the sibling `sova-spec.mjs`.

Tests: `node --test ../tests/*.test.mjs`
