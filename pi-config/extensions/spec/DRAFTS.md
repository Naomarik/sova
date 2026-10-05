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
node $d check NAME [--base REV]                         --root DIR [--json]
node $d evidence NAME --id '§x' [--id …] --by WHO --verification TEXT \
        (--commit REV | --snapshot | --doc-only) [--path P]… [--log FILE] [--write]   --root DIR [--json]
node $d promote NAME (--id '§x'… | --all) [--meta KEY]… [--file PATH]… [--plan SHA] [--write]  --root DIR [--json]
node $d recover [--write]                               --root DIR [--json]
node $d merge-manifest [--base F --ours F --theirs F] [--write]   --root DIR [--json]
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
   these writes, and current stays byte-identical. `check` also reports drift (`drift`):
   - `removed-phrase-elsewhere` (warn): a two- or three-word phrase the draft removed from one §
     that one to five other § still say. The same fact written twice and edited once. Also a
     quantity it removed (a number with a comparator or unit: `≥80%`, `90%`, `20s`) that another
     § states with a rare word near both (in at most a tenth of the §; one word for a comparison,
     two for a bare unit, reported as `near`), so a different meter's `80%` stays quiet. Rarity is
     the only tie, so it can miss a restatement worded differently, and on a very small spec it
     is weaker.
   - `cited-prose-unchanged` (warn) and `code-changed-prose-unchanged` (note): a § whose mapped
     `code` changed since the draft's base commit (`base.commit`, recorded by `new` in a Git
     project; `--base REV` overrides) while the draft leaves its prose as it was. It warns when a
     line the draft edited cites that §. `drift-base-unknown` (note): an older draft with no base
     commit and no `--base`.
   - `evidence-not-ancestor` (warn, `evidenceNotAncestor`): an active evidence commit that is gone
     or not an ancestor of `HEAD`, usually a rebase after evidence. The newest evidence entry
     for each ID is active. Superseded entries remain in history but no longer raise this warning;
     an older multi-ID entry remains active for IDs a newer entry has not replaced.
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
   - `--doc-only` is accepted only for `note` and `section` kinds, which carry no implementation,
     and for an agreed behavior or surface that is not built yet (see "Agreed, not built" below).
   - `--verification TEXT` says what was run or checked, and what it showed. `--log FILE` keeps
     a copy of a log as an object. Evidence becomes stale if that retained log is missing or its
     digest differs. Log paths may be outside the project, but every path component is checked
     for symlinks before the file is opened, and secret/hard-link/size refusals still apply.
   - Evidence binds to the proposed record and to the prose hash. Editing either later makes it
     `stale`, and so does changing an input in the working tree or at the commit.
   - Every `code` path the ID's record maps must exist (`evidence-code-missing`). `--path` adds
     inputs, but it can't stand in for a mapped path. An ID that maps nothing needs at least one
     present `--path`. For a deletion, the inputs may be absent.
4. **`promote`** previews the change and prints a `plan` hash. Then run
   `promote … --plan <hash> --write`. `--write` without `--plan` is allowed, but `--plan`
   refuses the write (`plan-changed`) if anything moved since you looked. Preview and write both
   print `alsoChanges`: the foreign § the promotion changes, i.e. every selected ID current already
   has, plus each current H1 that gains a new H2 (`alsoChangesDetail: [{id, change, children?}]`,
   `change` one of `text`, `record`, `text+record`, `deleted`, `file`, `child-added`). That list,
   not memory, is what the reply's `Also changes:` line names. They also print `driftWarnings`,
   the `check` warnings above (never a refusal), so drift shows even when nobody ran `check`.
   Evidence on a commit that is gone or not an ancestor of `HEAD` (a rebase after evidence) is
   refused as `evidence-not-ancestor`: never rebase after evidence; re-record evidence on the
   current commit, or merge master in instead.

## What promotion checks, all before any write

Promotion takes a **three-way** view, comparing base, current and proposed for each unit. A unit
is a claim file (compared as whole-file bytes), a manifest record (compared as canonical JSON per
ID), or a top-level manifest key. A claim file that both current and the draft changed is compared
again **per declaration** (see "Per-declaration merge" below); only what that finds is a conflict.

| Refusal (exit 1) | Meaning |
|---|---|
| `evidence-missing` / `evidence-stale` | A selected ID has no applicable evidence. The reasons are listed. |
| `conflict` | Both current and the draft changed the same declaration, gap or record, differently (or a file that can't be cut per declaration). The message names each one. Conflicting prose is never merged as text. Start a new draft from current. |
| `selection-incomplete` | A promoted file also carries changes to IDs you didn't select. Files move whole. |
| `candidate-invalid` / `candidate-dangling` | The merged candidate graph (current plus the selected units) doesn't load in the core, or gains a dangling edge that current doesn't have. |
| `candidate-label` / `authority-missing` | A selected ID that isn't being deleted is labelled `authority: "candidate"` in the draft, or declares no `authority`. This applies to a prose-only change too. |
| `agreed-invalid` / `agreed-rewritten` | A selected record's `agreed` is malformed or sits on a note or section, or the draft removes the `agreed` current already has, or replaces it without rewording the prose or with an earlier `at` (see "Agreed, not built"). |
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
blank line, trailing blank lines, and a CRLF-only change, since hashes use `\n`. For selection and
evidence, such a change is attributed to every ID in that file. The one exception is a file where
some span also changed: there the change goes along with the changed IDs.

### Per-declaration merge

When current and the draft both changed one claim file, the file is cut at the core's declaration
spans (an H1 lede, or an H2 up to its last non-blank line) in base, current and draft, and each
piece is merged three-way on its own:

- **A declaration's span.** Changed on one side only: that side's text. Changed on both, differently:
  `conflict`. Deleted on one side and changed on the other: `conflict`.
- **Bytes outside every span** belong to the gap they sit in: the bytes before the lede, or the blank
  lines after one declaration (the file's tail after the last). Each gap merges like a span; the
  same gap changed differently on both sides is a `conflict`.
- **New declarations** hang off the nearest declaration before them that base already had. When
  both sides add after the same one, each side's run stays together and the run whose first ID
  sorts first goes first, so the result is the same bytes whichever side landed first. A new
  declaration that follows one the other side deleted is a `conflict`, and so is one ID added on
  both sides unless both runs there are identical (then it is taken once). A declaration that ends
  up followed by one it never preceded on any side gets a blank line before it.

The merged file must read back, through the core, as exactly the declarations it was built from,
byte for byte, or it is refused as a `conflict`. If the draft's changes already read the same in
current, the file is `same` (nothing to write). A file whose kept declarations were reordered on
either side, that holds a carriage return, or whose graph on any side doesn't load, isn't cut: it is
compared as whole-file bytes, as before. The selection rule is unchanged: files move whole, so every
ID the draft changed in a merged file is selected (`selection-incomplete` otherwise). In the
`promote` output a merged file shows `merge: "merge"`; `status` shows the merged bytes' hash.

### Agreed, not built

A requirements chat can end with its promises in current before any code exists. Put
`"agreed": {"by": "<who agreed>", "at": "<ISO date>"}` on each behavior or surface record the person
agreed to (`at` may carry a time: `2026-10-05T14:30Z`), with `authority: "accepted"` and no `code`.
Then `evidence --doc-only` (the `--verification` text says where it was agreed) and promote. That
records the decision, not that it was built.

- **Built** means the record has `code` and the `evidence` label `reviewed` or `verified`. So
  `--doc-only` is refused (`doc-only-refused`) for an agreed record that maps code or carries one of
  those labels; a record with no `agreed` at all is refused as before.
- **It names who decided.** The build edits the same record: it adds `code` (and its label), keeps
  `agreed` as it is, and records commit or snapshot evidence of the code. A rewording may keep
  `agreed`; a change of meaning goes back to the person, and their new agreement replaces it, in
  the same promotion as the reworded prose, with an `at` not earlier than the old one. Changing
  `agreed` on unchanged prose, an earlier `at`, or removing `agreed` is refused (`agreed-rewritten`).
  Deleting the whole record is an ordinary deletion.
- **Shape.** `agreed` must be an object with exactly a non-empty `by` and a real date `at`, on a
  behavior or surface; anything else is refused (`agreed-invalid`) at `evidence` and at `promote`.
- It is a record field, not a label value: the core ignores record fields it doesn't know, while an
  unknown `authority` or `evidence` value makes it refuse the manifest (exit 2), so cores that
  predate `agreed` still load a manifest carrying it.

## Transaction, rollback, recovery

The write works in this order:

1. Under the lock, the plan is recomputed from the current bytes. Every "before" hash is
   rechecked.
2. The old bytes, the new bytes and a journal are written to `drafts/.txn/`. The targets include
   both the selected current documentation and the promotion receipt in `draft.json`.
3. Each target is replaced by an atomic rename, or deleted. Before each step, the tool checks
   that the target still has its planned "before" bytes. The journal is retired only after the
   documentation and receipt have both been written and checked.

If a step fails, rollback inspects the actual target hashes, including a replacement that took
place before its syscall reported failure. Applied targets, the receipt included, are restored
and new directories are removed. A rollback that cannot safely complete keeps the transaction
and reports the need for recovery; a failed receipt write is never silently treated as publication
without a receipt.

If the process dies mid-way, `.txn/` stays, and every write command refuses with
`pending-transaction`. `recover` shows each target as `untouched`, `applied` or `foreign`.
`recover --write` rolls every applied target, including the promotion receipt, back to its
pre-promotion bytes and removes `.txn/`. Journals from older versions without a receipt target
remain recoverable.
If any file matches neither side (`foreign`), recovery touches nothing. Resolve it by hand from
`.txn/old-*` and `.txn/new-*`.

`recover --write` also takes over a lock whose holder PID is no longer running on this host. It
fails closed with `lock-occupied` if the lock's contents changed, or if another writer takes the
lock between the removal and the retake. The other writer's lock is left alone. No other command
ever removes a lock. If the holder is on another host, check by hand, then delete
`.sova/spec/drafts/.lock`.

## A manifest conflict in a Git merge

`merge-manifest` merges `.sova/spec/manifest.json` record by record: each claim record and each
top-level key takes the side that changed it. The same key changed differently on both sides is
refused (`manifest-conflict`, exit 1, `conflicts: [{key, kind}]`) and nothing is written. Claim prose
files are never touched: a `claims/` conflict is resolved by hand or by re-applying one side in a new
draft. Keys keep ours' order; the output is 2-space JSON, as promotion writes it.

- **During a conflicted `git merge`** (index stages 2 and 3 exist): `merge-manifest` previews,
  `merge-manifest --write` writes the merged manifest to the working tree. It never stages; run
  `sova-spec.mjs check`, resolve `claims/`, then `git add .sova/spec/manifest.json`. Outside a
  conflict it refuses (`not-conflicted`).
- **As a Git merge driver**, so the conflict never happens:

  ```sh
  echo '.sova/spec/manifest.json merge=sova-spec-manifest' >> .gitattributes
  git config merge.sova-spec-manifest.driver \
    'node "<core>/sova-spec-draft.mjs" merge-manifest --root . --base %O --ours %A --theirs %B --write'
  ```

  Git runs it at the repository top; it writes `%A` on success and exits 1 on a same-key conflict,
  which Git reports as a conflict with ours' bytes in place.

## Limits, stated plainly

- **No semantic verification.** The tool checks commits, ancestry, bytes and graph structure.
  Whether the code implements the prose is the recorder's claim. So is what `--verification`
  says. A hand-edited evidence entry is still held to the same byte and revision checks.
- **Conflicts are per declaration, not per line.** Two different edits to one declaration conflict,
  even when they touch different sentences. The tool doesn't rebase or merge text inside a span, and
  falls back to whole-file comparison for reordered or CRLF files.
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
  `core.fsmonitor=false` and the caller's `GIT_*` environment cleared. Before working-tree diffs,
  the tool inspects filter configuration and attributes without running filters. A configured
  executable clean/process filter selected for an inspected path is explicitly refused; an unused
  configured driver does not prevent inspection. Ambiguous boolean attributes with executable
  drivers named `set`/`unset` are conservatively refused too (see `core/README.md`, Safe inspection).
  No refusal includes the configured command text.
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
