# Legacy spec migration

Sova's product documentation used to live in `spec/*.md`. It now lives in `../claims/`, and
`../manifest.json` records it. The move is finished. What's left here is the one thing Git can't
reproduce: the lookup from old paths and `§N` citations to the new IDs.

Migration moved **requirement authority**, not proof of implementation. At migration every record
was labelled `authority: "migrated"`, `evidence: "unreviewed"`. Nothing was reviewed against the
code, and no receipt was issued.

## What changed in the text

Nothing but two mechanical transforms:

- Each H1 and H2 outside a fence gains `§id — ` right after its `#` marker. For example,
  `## Decisions` in `spec/14-workspaces.md` became `## §workspace.groups/decisions — Decisions`.
  H3 and deeper headings, tables, fences and prose are byte-identical.
- A relative link from one legacy file to another now points at the migrated file, for example
  `(overview.md)` → `(../design/overview.md)`.

## Files

| Path | What it is |
|---|---|
| `legacy-map.json` | Resolves the old world: `sections` (`§4b` → `spec/04b-images.md` → `§chat/images`), `aliases` (`§03`, `§04h`, `§copy-deck`), `files` (every legacy H1 and H2 → its ID, for current and draft), `dependencies`, and `pilotIds`. Its `source` and `archived` paths name the removed files below. |

## Where the rest went

- **The original bytes** of every committed legacy doc are `git show c4d7993:spec/<file>`. They
  are byte-identical to the removed `legacy/head/spec/`. `spec/04i-playbooks.md` was never
  committed; it is now `§chat/playbooks`.
- **The migration scripts and record** (`migrate.mjs`, `transform.mjs`, `verify.mjs`,
  `redirects.mjs`, `inventory.json`), `legacy/head/` and the pilot archive `pilot/` were removed
  once the move was done. The commit before that removal still has them; see
  `git log -- .sova/spec/migration/verify.mjs`. `verify.mjs` proved the parity of the move and is
  not needed again; the live graph is checked by the core's `check`.
- `legacy/worktree/` (edits uncommitted at capture) was never in Git and stays local only.

## IDs

- One legacy file is one claims file. Its H1 is the document, and each H2 is a child record whose
  name is a slug of the heading (letters only, collisions get `-b`, `-c` and so on).
- Legacy `§N` stays in the prose as written, and `legacy-map.json` resolves it to a file and its
  H1 ID. `§4h` (file mentions) is cited in prose and code but never existed, so it maps to "absent".
- The pilot's `§chat/composer` kept its ID. Its 15 other IDs are retired; `pilotIds` lists each
  one's successors. A retired ID is never declared again.

### What an old reference resolves to

Only H1 and H2 headings became IDs, so only they resolve through the map. Many old references
point deeper: an H3 (`§14 "Pane composers…"`), a bold lead-in (`§4 Drafts`), or a table row. For
those, resolve `§N` to its file and then search that file for the quoted words. H3+ headings, bold
text and tables are byte-identical to the legacy text, so the search finds them. There is no
ID or map entry below H2, and no promise that old `#anchor` links still work: the H1/H2 text
gained a `§id — ` prefix, so their generated anchors changed.
