# Drafts: proposed spec changes, kept apart from current

`core/sova-spec-draft.mjs` keeps a proposed change to a project's `.sova/spec` apart from the
current docs until the change is implemented and verified. Then it promotes the selected part.
Like the other tools here, it needs only the Node standard library.

- `.sova/spec/manifest.json` and the claims tree are the **current** documentation.
- A draft is a **proposal**. Agreeing on a draft (alignment) approves intent. It doesn't make
  anything current.
- Promotion requires recorded implementation and verification evidence for each selected `§` ID.

```sh
d=core/sova-spec-draft.mjs   # or the installed copy; see README.md for the path rule
node $d new NAME [--purpose TEXT] [--write]              --root DIR [--json]
node $d status NAME                                     --root DIR [--json]
node $d diff NAME [--against base|current]              --root DIR [--json]
node $d check NAME                                      --root DIR [--json]
node $d evidence NAME --id '§x' [--id …] --by WHO --verification TEXT \
        (--commit REV | --snapshot | --doc-only) [--path P]… [--log FILE] [--write]   --root DIR [--json]
node $d promote NAME (--id '§x'… | --all) [--meta KEY]… [--file PATH]… [--plan SHA] [--write]  --root DIR [--json]
node $d recover [--write]                               --root DIR [--json]
```

Nothing is written without `--write`. Quote IDs, because `§` is not a shell word character.

## Layout

```text
.sova/spec/drafts/NAME/
  draft.json    the draft's only machine state: baseline hashes, evidence[], promotions[]
  base/         immutable literal copy of manifest.json + the whole claims tree at `new`
  spec/         the proposal: edit manifest.json and claim files here
  evidence/     tool-owned: objects/<sha256> snapshot bytes and logs
  attachments/  free-form, ignored by the tool and never promoted
.sova/spec/drafts/.lock   held while any command writes
.sova/spec/drafts/.txn/   exists only while a promotion is in flight or was interrupted
```

`new` copies everything: the manifest and **every** file under its `claimsRoot`. It never copies
a subset, so the draft graph is always complete. With no current spec, the baseline is empty, and
`spec/` starts with `{"formatVersion": 1, "claims": {}}` for you to author into. This is how a
project with no docs documents existing behavior piecemeal as features are worked on. Nothing
else is required beforehand: no prior docs and no Git. Only the records you promote need an
`authority` label (see below). A `claims/` tree with no
`manifest.json` is refused (`orphaned-spec`, exit 2) rather than treated as "no spec". Restore the
manifest first.

Never edit `base/`, `draft.json` or `evidence/` by hand. If `base/` changes, every command exits
2 with `base-tampered`. Status lives only in `draft.json` plus the bytes themselves. Don't mirror
it into markdown. The core's optional `authority`/`evidence` record labels are declared text. This
tool never sets them, but `promote` reads `authority`. Every selected ID that stays current must
declare it explicitly, and a `candidate` value is refused. Set it in the draft record to what it
should say once current:

- `accepted` once the user adopted it.
- `migrated` for ported text. This is provenance, the text's historical origin. It isn't a claim
  of ongoing verification.

The machine can't tell which label is correct.

## Workflow

1. **`new NAME --write`**, then edit `spec/`. `check NAME` runs the core over the draft graph
   (`sova-spec.mjs check --spec .sova/spec/drafts/NAME/spec`). `status` and `diff` compare
   the draft against the baseline, or against current with `diff --against current`. None of
   these writes, and current stays byte-identical.
2. **Implement the change and verify it.** The tool never does this part.
3. **`evidence`** records, for each changed ID, what was verified and against which
   implementation bytes:
   - **Git project**: `--commit REV`. The commit must exist and be an ancestor of `HEAD`. Every
     input must be byte-identical in the working tree and at that commit. The inputs are the
     ID's mapped `code` paths plus any `--path`, and they may be absent in both for a deletion.
     Commit only the implementation, and name that commit. The tool itself never commits.
     `--snapshot` is refused in a Git project. A project root that an enclosing repository ignores
     and doesn't track, such as a home-directory dotfiles repo, counts as having no Git.
   - **No Git**: `--snapshot`. The exact input bytes are kept under `evidence/objects/`.
   - `--doc-only` is accepted only for `note` and `section` kinds, which carry no implementation.
   - `--verification TEXT` says what was run or checked, and what it showed. `--log FILE` keeps
     a copy of a log as an object.
   - Evidence binds to the proposed record and to the prose hash. Editing either later makes it
     `stale`, and so does changing an input in the working tree or at the commit.
   - Every `code` path the ID's record maps must exist (`evidence-code-missing`). `--path` adds
     inputs, but it can't stand in for a mapped path. An ID that maps nothing needs at least one
     present `--path`. For a deletion, the inputs may be absent.
4. **`promote`** previews the change and prints a `plan` hash. Then run
   `promote … --plan <hash> --write`. `--write` without `--plan` is allowed, but `--plan`
   refuses the write (`plan-changed`) if anything moved since you looked.

## What promotion checks, all before any write

Promotion takes a **three-way** view, comparing base, current and proposed for each unit. A unit
is a claim file (compared as whole-file bytes), a manifest record (compared as canonical JSON per
ID), or a top-level manifest key.

| Refusal (exit 1) | Meaning |
|---|---|
| `evidence-missing` / `evidence-stale` | A selected ID has no applicable evidence. The reasons are listed. |
| `conflict` | Both current and the draft changed the same file or record, differently. Prose is never auto-merged. Update the draft by hand, or start a new draft. |
| `selection-incomplete` | A promoted file also carries changes to IDs you didn't select. Files move whole. |
| `candidate-invalid` / `candidate-dangling` | The merged candidate graph (current plus the selected units) doesn't load in the core, or gains a dangling edge that current doesn't have. |
| `candidate-label` / `authority-missing` | A selected ID that isn't being deleted is labelled `authority: "candidate"` in the draft, or declares no `authority`. This applies to a prose-only change too. |
| `base-untrusted` | The draft's baseline graph doesn't load in the core (exit 2), so changes can't be attributed to IDs. Start a new draft from a fixed current. |
| `draft-invalid` | The draft's own graph doesn't load (exit 2). Run `check NAME` and fix it. |
| `not-changed`, `plan-changed`, `nothing-to-write`, `pending-transaction`, `lock-occupied`, `race` | These mean what they say. |

Other rules:

- Units that only current changed are kept, because the candidate starts from current.
- A unit that is identical on both sides is a no-op.
- Deletions of records and files are ordinary selected changes, and they need evidence.
- `--meta KEY` selects a top-level manifest key such as `boundary`. It needs no evidence.
- `--file PATH` selects a changed claims-tree file that declares no ID.
- In a bootstrap, where no current manifest exists yet, every top-level key is taken.
- `--all` selects every change. Each ID still needs evidence.

A promoted file can carry changed bytes outside every declaration span. Examples are a pre-lede
blank line, trailing blank lines, and a CRLF-only change, since hashes use `\n`. Such a change
is attributed to every ID in that file. The one exception is a file where some span also changed:
there the change goes along with the changed IDs.

## Transaction, rollback, recovery

The write works in this order:

1. Under the lock, the plan is recomputed from the current bytes. Every "before" hash is
   rechecked.
2. The old bytes, the new bytes and a journal are written to `drafts/.txn/`.
3. Each target is replaced by an atomic rename, or deleted. Before each step, the tool checks
   that the target still has its planned "before" bytes.

If any step fails, every applied file is restored and new directories are removed. Afterwards,
`draft.json` records the promotion (`promotions[]`).

If the process dies mid-way, `.txn/` stays, and every write command refuses with
`pending-transaction`. `recover` shows each target as `untouched`, `applied` or `foreign`.
`recover --write` rolls every applied file back to its pre-promotion bytes and removes `.txn/`.
If any file matches neither side (`foreign`), recovery touches nothing. Resolve it by hand from
`.txn/old-*` and `.txn/new-*`.

`recover --write` also takes over a lock whose holder PID is no longer running on this host. It
fails closed with `lock-occupied` if the lock's contents changed, or if another writer takes the
lock between the removal and the retake. The other writer's lock is left alone. No other command
ever removes a lock. If the holder is on another host, check by hand, then delete
`.sova/spec/drafts/.lock`.

## Limits, stated plainly

- **No semantic verification.** The tool checks commits, ancestry, bytes and graph structure.
  Whether the code implements the prose is the recorder's claim. So is what `--verification`
  says. A hand-edited evidence entry is still held to the same byte and revision checks.
- **Conflicts are coarse.** Two different edits to one claim file conflict, even when they touch
  different sections. The tool doesn't rebase or merge text.
- **The `claimsRoot` can't move** in a draft, and the tool refuses one that differs between base,
  current and draft.
- **Promotion rewrites `manifest.json` as JSON with 2-space indentation** whenever a record or
  key changes. Hand formatting of the current manifest isn't kept.
- **It refuses a draft whose baseline graph doesn't load**, and one whose own graph doesn't load.
  Fix the graph, or start a new draft from a fixed current.
- **Cooperating writers only.** The lock, the double capture and the per-file "before" checks
  keep cooperating writers apart. A writer racing between a check and a rename, or a parent
  directory swapped for a symlink, isn't fully prevented with portable fs calls. The Git calls
  are read-only plumbing (`rev-parse`, `cat-file`, `merge-base`). They run without a shell, with
  `core.fsmonitor=false` and the caller's `GIT_*` environment cleared.
- **Limits on what it reads.** Symlinks, hard-linked files and files over 2 MiB are refused, both
  in the spec trees and as evidence inputs. A spec tree (current, base or draft: the manifest plus
  the whole claims tree) over 64 MiB in total is refused (`oversize`). The 2 MiB limit applies per
  file. The review companion's 32 MiB cap is a different limit, on one review capture. These secret
  and credential paths are refused too:
  - secret directories (`.git`, `.ssh`, `.aws`, …)
  - key extensions (`.pem`, `.key`, `.p12`, …)
  - files named like credential data (`.env*`, `id_rsa`, `credentials.json`, and `secrets` bare
    or with a data extension, such as `secrets.json` or `secrets.prod.yaml`)

  These rules apply everywhere, spec trees included. The name rule is narrow, so a source or
  prose file named after the topic, such as `lib/secrets.ts` or `claims/app/secrets.md`, is
  allowed. The patterns are the same as the review companion's secret patterns. Only the patterns
  are shared: which files each tool reads is its own business.
- **`.sova/spec` is never implementation evidence.** Any path under `.sova/spec`, or `.sova`
  itself, is refused as an evidence input (`path-refused`), whether it came from `--path` or from
  a record's mapped `code`. A record that maps its code there can't get evidence. Docs are not
  implementation.
- **It doesn't use the review companion.** `sova-spec-review.mjs` packets are separate evidence of
  a closure review. They are not a promotion gate.

Tests: `node --test tests/draft.test.mjs` (from this directory).
