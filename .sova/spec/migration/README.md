# Legacy spec migration

Sova's product documentation used to live in `spec/*.md`. It now lives in `../claims/`, and
`../manifest.json` records it. This directory holds what the move needs to stay checkable and
reversible. It's migration mechanics, not a product tool.

Migration moved **requirement authority**, not proof of implementation. At migration every record
was labelled `authority: "migrated"`, `evidence: "unreviewed"`. Nothing here was reviewed against
the code, and no receipt was issued.

## What changed in the text

Nothing but two mechanical transforms (`transform.mjs`):

- Each H1 and H2 outside a fence gains `§id — ` right after its `#` marker. For example,
  `## Decisions` in `spec/14-workspaces.md` became `## §workspace.groups/decisions — Decisions`.
  H3 and deeper headings, tables, fences and prose are byte-identical.
- A relative link from one legacy file to another now points at the migrated file, for example
  `(overview.md)` → `(../design/overview.md)`.

`verify.mjs` inverts both transforms and compares the result with the retained originals byte for
byte. See [Checking the record](#checking-the-record) for what it does and doesn't prove.

## Files

| Path | What it is |
|---|---|
| `inventory.json` | Every root `spec/*.md` (not `spec/brainstorms/`) at capture: HEAD commit, Git state, SHA-256 and Git blob of the HEAD and worktree bytes. |
| `legacy/head/spec/*.md` | Exact committed bytes. Current documentation is built from these. |
| `legacy/worktree/spec/*.md` | Exact bytes of files that were modified or untracked at capture. They are proposals, so they build the draft `../drafts/legacy-working/`, never current. |
| `legacy-map.json` | Resolves the old world: `sections` (`§4b` → `spec/04b-images.md` → `§chat/images`), `aliases` (`§03`, `§04h`, `§copy-deck`), `files` (every legacy H1 and H2 → its ID, for current and draft), and `pilotIds`. |
| `pilot/` | The manual pilot's `manifest.json` and `claims/`, byte-exact, with `SHA256SUMS`. `../pilot/` reports and `../reviews/baseline/` refer to these files. |
| `migrate.mjs` | `capture` and `build --out DIR`. The build reads only `legacy/` and `pilot/`, so it's reproducible. |
| `verify.mjs` | The parity check of the migration record ([Checking the record](#checking-the-record)). `--live` (pre-move only) also compares the live `spec/*.md` with the capture. |
| `redirects.mjs` | Planned the legacy redirect stubs and applied them after its checks passed. All 24 are applied. |

## IDs

- One legacy file is one claims file. Its H1 is the document, and each H2 is a child record whose
  name is a slug of the heading (letters only, collisions get `-b`, `-c` and so on).
- `design/*` documents are notes. Other H1s are surfaces. H2s are behaviors, except the rationale
  and reference lists (Rejected, Decisions, Open questions, Tokens, Classes, Class table, Class
  index, File map), which are notes.
- The migration itself gave no behavior `requires`. Afterwards, 8 records got 21 hand-authored
  edges (see [Dependencies](#dependencies)). Every other behavior has none, because nobody has
  investigated its dependencies, and the core reports each one as `requires-uninvestigated`.
  Links and `§N` citations in the prose are ordinary references, not dependencies.
- Legacy `§N` stays in the prose as written, and `legacy-map.json` resolves it to a file and its
  H1 ID. `§4h` (file mentions) is cited in prose and code but never existed, so it maps to "absent".

### What an old reference resolves to

Only H1 and H2 headings became IDs, so only they resolve through the map. Many old references
point deeper: an H3 (`§14 "Pane composers…"`), a bold lead-in (`§4 Drafts`), or a table row. For
those, resolve `§N` to its file and then search that file for the quoted words. H3+ headings, bold
text and tables are byte-identical to the legacy text, so the search finds them. There is no
ID or map entry below H2, and no promise that old `#anchor` links still work: the H1/H2 text
gained a `§id — ` prefix, so their generated anchors changed.

## Dependencies

After parity was proven, a few `requires` edges were authored by hand (`EDGES` in `migrate.mjs`,
also under `dependencies` in `legacy-map.json`). Each source passage was read in full, and each
edge quotes the migrated sentence that makes the target something the source relies on.
`verify.mjs` checks that the quote is really in the source passage. A `§N` citation or a link on
its own is a reference, never an edge. For example, the group composer's "Images belong to a
conversation (§4b)" explains an exclusion, so it adds no edge.

| Record | requires | Because the prose says |
|---|---|---|
| `§chat.composer/behavior` | `§chat.images/composer-attachments` | stored draft images are files "already uploaded into the session's attachments folder (§4b)" |
| `§chat.images/composer-attachments` | `§chat.composer/composer-flyout`, `§chat.images/lightbox`, `§chat.composer/behavior`, `§design.copy-deck/images` | the flyout's Attach images row opens the picker; the preview opens the lightbox; drafts keep attachments; "change the numbers here and in the copy deck together" |
| `§chat.model-menu/menu` | `§chat.composer/composer-flyout` | "The flyout owns the popover; this panel is what's inside it" |
| `§chat.timeline/rewind` | `§chat.transcript/message-actions` | the message strip's Rewind is "the identical `rewind` request … the same two-step confirm and the same refusals" |
| `§app.session-list/content-rules` | `§chat.composer/behavior`, `§chat.context-window/sidebar-ring`, `§app.shell/remote-session-chips` | draft rows exist because of stored drafts; the ring uses "the same `contextStep`"; the connection dot is "the same reading as the head chip" |
| `§app.settings-dialog/modes` | `§app.settings-dialog/models` | the Models policy decides "— off for subagents" |
| `§workspace.groups/the-group-composer` | `§workspace.groups/member-states`, `§design.copy-deck/workspace`, `§chat.composer/behavior`, `§chat.composer/anatomy`, `§design.ground-rules/color-budget`, `§design.ground-rules/voice` | refusal codes are "the closed set the state table above names"; banner words come from §9; "the same optimistic rule §4 gives" and the same keys; the collapse table resizes "the §4 composer"; §0's one-accent rule and three-beat errors |
| `§workspace.groups/a-pane` | `§chat/transcript`, `§chat/composer`, `§chat/model-menu`, `§chat/mode-menu` | "§3, §4 and their sub-sections apply verbatim" |

So 8 records carry 21 edges. The other 112 behaviors keep no `requires`, which means their
dependencies are uninvestigated. The core reports each one, and its reports never claim to be
complete.

## The draft `legacy-working`

`../drafts/legacy-working/` was created with `sova-spec-draft.mjs new` from the migrated current
docs. Its `spec/` then took the build's draft variant: the modified 03, 04, 09 and overview, plus
the never-committed `04i-playbooks.md` as `claims/chat/playbooks.md`. A record whose passage is new
or differs from current is labelled `authority: "candidate"`. `attachments/legacy/` holds the exact
worktree bytes, and the HEAD bytes of the modified files, beside the draft. It stays a proposal
until the playbooks work is implemented, verified and promoted with the draft tool.

## The pilot's IDs

The pilot's candidate claims were short rewrites of legacy passages. Keeping them next to the full
migrated text would duplicate every promise, so they're archived, not current:

- `§chat/composer` keeps its meaning. It's still the chat composer surface, and its text is now the
  legacy document.
- The other 15 pilot IDs are retired. `legacy-map.json` lists each one's successors, the migrated
  headings that hold the legacy passages the candidate was drawn from. A successor is a location,
  not an equivalent. A retired ID is never declared again, and `verify.mjs` enforces that.

## Checking the record

`verify.mjs` checks the **migration record**, not the live docs. It rebuilds the migration output
from the captured bytes into a temp directory and checks that output:

- The HEAD originals match `inventory.json` and their Git blobs.
- The rebuild inverts to the originals byte for byte.
- The rebuild matches the claim hashes recorded in `legacy-map.json`, and the records match the
  headings.
- Every dependency quote is in its source passage, and no retired pilot ID is reused.
- Every `§N` resolves, and the pilot archive is byte-exact.

It then reports whether the live `../` and `../drafts/legacy-working/spec/` still equal that
output. Right after the migration they did. Once anything is promoted or edited they won't, and
that's expected: it prints a `note`, not a failure. Whether the live graph is valid is the core's
`check` (and the draft tool's), not this script's.

```sh
node .sova/spec/migration/verify.mjs
node .sova/spec/migration/migrate.mjs build --out /tmp/sova-mig   # the same output, on disk
```

| Exit | Meaning |
|---|---|
| 0 | Every check ran and passed. |
| 3 | Every check that ran passed, but some inputs were unavailable (`UNAVAILABLE` lines). This is partial parity, never full. |
| 1 | `--live` drift (pre-move only). |
| 2 | A parity failure. |

**A public clone gives partial parity.** `../.gitignore` keeps `legacy/worktree/`, `../drafts/`,
`../pilot/` and `../reviews/` local. Without them `verify.mjs` checks current in full, but it
can't rebuild or check the draft variant, so it exits 3 and names what it skipped. Without Git it
also can't list the `§N` citations in the code, and says so. `migrate.mjs build` also needs
`pilot/manifest.json` (published) to derive the retired IDs.

`verify.mjs --live` also compared the live `spec/*.md` with the capture. It was a pre-move check
for `redirects.mjs apply`. Now that all 24 legacy files are redirect stubs, it reports drift (exit
1) by design, so don't use it after the move.

`migrate.mjs capture` wrote `inventory.json` and `legacy/` from the live tree once. It refuses to run
again while `inventory.json` exists, so a capture is never overwritten by accident.
