# Using the spec tools

Three Node scripts, with no install and no network. Run them from the repo root. Add `--json` for
machine output.

| Tool | Writes |
|---|---|
| `sova-spec.mjs` | Never. It reads a spec and prints its prose and relations. |
| `sova-spec-draft.mjs` | Only with `--write`: drafts under `drafts/`, and the current docs on `promote`. |
| `sova-spec-review.mjs` | Only on `prepare --write` and `record`, under `reviews/`. |

In this repo, run the canonical copies in `pi-config/extensions/spec/core/`, as below. `tools/`
holds vendored copies of all three, which may lag behind. Before you run a vendored copy, check
that it is byte-identical to a copy you trust:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
sha256sum pi-config/extensions/spec/core/*.mjs .sova/spec/tools/*.mjs "$core"/*.mjs
```

Each file name must hash the same everywhere. The `$core` copies exist only after
`pi-config/install.sh` has run. In any other project, treat vendored copies as foreign code: read
them, or compare hashes, before you run them. The draft and review tools run the `sova-spec.mjs`
beside them, so vendor them together.

## Reading the docs

```sh
node pi-config/extensions/spec/core/sova-spec.mjs check
node pi-config/extensions/spec/core/sova-spec.mjs scope '§workspace/groups' --budget 4000
node pi-config/extensions/spec/core/sova-spec.mjs scope '§workspace.groups/decisions'
node pi-config/extensions/spec/core/sova-spec.mjs impact '§chat.composer/behavior'
node pi-config/extensions/spec/core/sova-spec.mjs check --spec .sova/spec/drafts/legacy-working/spec   # local only
```

- **`scope §id`** prints the actual text you need before you change that area. A surface gives its
  lede and every child. A child gives its parent lede for orientation, and not its siblings. A
  section gives its members. Then everything they `requires`, depth-first. `--budget BYTES` keeps
  whole passages and names the rest as unread.
- **`impact §id`** lists what `requires` it, directly or indirectly.
- **`check`** validates the whole graph. **`census`** needs a `boundary` in the manifest. This one
  has none, so it reports `boundary-missing`.
- **`--spec DIR`** reads a draft's graph instead of the current one.

Exit `0` means the declared closure was delivered, never that it is complete. Exit `1` means
something relevant is unknown, stale or unread. Exit `2` means the input can't be trusted.

**Current state, 2026-09-24:** `check` exits 1 with 125 `requires-uninvestigated` warnings. Only
10 records declare `requires`, 25 edges in all, each quoted from the migrated prose. `impact` can't
rule out the other behaviors, and it lists them as unknown.

Old paths and `§N` citations, such as "spec §14 Decisions", resolve through
`migration/legacy-map.json`. That one is `§workspace.groups/decisions`.

## Changing the docs

Never edit `manifest.json` or `claims/` directly. Every change, including the first document in
a project with none, goes through a draft. Drafts are local only, and never committed:

```sh
d=pi-config/extensions/spec/core/sova-spec-draft.mjs
node $d new composer-paste --purpose "paste images from the clipboard" --root .   # preview
node $d new composer-paste --purpose "paste images from the clipboard" --root . --write
# edit .sova/spec/drafts/composer-paste/spec/ only
node $d status composer-paste --root .
node $d diff composer-paste --root .
node $d check composer-paste --root .
```

A draft is a proposal. Agreeing on it approves the intent, and makes nothing current. Then:

1. Implement it, and verify each changed promise against the result.
2. Relabel each changed record as it should read once current. `promote` needs an explicit
   `authority` on every record it writes, and refuses `candidate` or none. New or rewritten
   prose becomes `accepted` once it is implemented and reconciled; the user's go-ahead for the
   task adopts it, and is still not permission to commit. `migrated` stays only on text still
   exactly as ported: it records provenance, not verification. `evidence` says what you did:
   `reviewed` or `verified`.
3. Record evidence. A behavior or surface needs at least one implementation file, and every path
   in its `code` must exist. The migrated records map no `code`, so add the files to the draft
   record's `code`, which binds them to the evidence, or pass `--path`. This repo uses Git, so name an existing commit that holds the
   implementation, and never commit unrelated changes to get one:

   ```sh
   node $d evidence composer-paste --id '§chat.composer/behavior' --by claude \
     --verification "pasted a PNG in the composer; it attached and sent" \
     --commit HEAD --path src/components/Composer.tsx --root . --write
   ```

   Without Git, use `--snapshot`, which keeps the exact bytes. `--doc-only` covers only `note`
   and `section` records.
4. Promote. The preview prints a plan hash, and `--write` applies exactly that plan:

   ```sh
   node $d promote composer-paste --id '§chat.composer/behavior' --root .
   node $d promote composer-paste --id '§chat.composer/behavior' --plan <printed hash> --root . --write
   ```

   It refuses when evidence is missing or stale, when a file changed differently in both places,
   or when a promoted file carries other changes you didn't select. Resolve the refusal. Never
   work around it. After an interrupted promotion, run `node $d recover --root .`, then again with
   `--write`.

Documenting what the code already does, where the docs miss or misstate it, is its own draft.
Don't mix it into a feature's draft.

`drafts/legacy-working/` holds the edits that were uncommitted in `spec/` at migration time, plus
`spec/04i-playbooks.md`. It is a proposal like any other, and local only, like every draft. Its
records are labelled `candidate`, so nothing in it can be promoted until it has been
implemented, verified and relabelled.

[DRAFTS.md](../../pi-config/extensions/spec/DRAFTS.md) has the layout, the lock and the limits.

## Review packets

`sova-spec-review.mjs` stores the exact bytes a review compared, and a reviewer's conclusion:

```sh
r=pi-config/extensions/spec/core/sova-spec-review.mjs
node $r prepare '§chat/composer' --root . --name composer-check   # preview, writes nothing
node $r status composer-check --root .
```

The preview lists the packet's blockers. Most migrated behaviors have no `requires` yet, so their
closures carry `requires-uninvestigated` blockers, and only `unresolved` can be recorded for them.
Map that closure's dependencies in a draft and promote it first; the rest of the graph can wait.
Notes carry no such blocker. A cited incumbent file that is missing also blocks.

Until a packet is written (`prepare --write`), `status` exits 2 with `packet-missing`. The name
`baseline` is taken by the pilot. A stale packet is prepared again under a new name. Never edit
anything under `reviews/` by hand. See
[the tools README](../../pi-config/extensions/spec/README.md).

## What no tool tells you

- No tool checks that code does what the prose says. A clean `check`, recorded evidence, a
  review record or a promotion is not correctness.
- `migrated` means the text carries the requirement, and nobody has checked the implementation.
- `code` paths are evidence locations. A behavior inside a mapped file that no claim names is
  still unknown.
- A missing `requires` key means not investigated. `[]` means none declared, not none exist.
- Source code carries no `§` IDs or spec annotations.
