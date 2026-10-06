# Using the spec tools

Four Node entrypoints, with no install and no network. Run them from the repo root. Add `--json` for
machine output.

| Tool | Writes |
|---|---|
| `sova-spec.mjs` | Never. It reads a spec and prints its prose and relations. |
| `sova-spec-draft.mjs` | Only with `--write`: drafts under `drafts/`, and the current docs on `promote`. |
| `sova-spec-review.mjs` | Only on `prepare --write` and `record`, under `reviews/`. |
| `sova-spec-assess.mjs` | Optional observations: only on `prepare --write` and `record --write`, under `assessments/`. |

In this repo, run the canonical copies in `pi-config/extensions/spec/core/`, as below. `tools/`
holds vendored copies of all four entrypoints and their helper modules, which may lag behind. Before you run a vendored copy, check
that it is byte-identical to a copy you trust:

```sh
core="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; case $core in "~"|"~/"*) core="$HOME${core#\~}";; esac; core="$core/extensions/spec/core"
sha256sum pi-config/extensions/spec/core/*.mjs .sova/spec/tools/*.mjs "$core"/*.mjs
```

Each file name must hash the same everywhere. Resolve `$core` with exactly that first line, never a
guessed path such as `$HOME/.pi/agent/...`: the agent dir may be elsewhere (`PI_CODING_AGENT_DIR`),
and a guessed path that finds nothing doesn't mean the tools are missing. The `$core` copies exist
only after `pi-config/install.sh` has run. In any other project, treat vendored copies as foreign code: read
them, or compare hashes, before you run them. The draft, review and assessment tools run the
`sova-spec.mjs` beside them, so vendor them together.
Ship all `core/*.mjs`, including `packet.mjs`; copying only the four entrypoints is insufficient.

## Reading the docs

```sh
node pi-config/extensions/spec/core/sova-spec.mjs check
node pi-config/extensions/spec/core/sova-spec.mjs map                              # every area on one page
node pi-config/extensions/spec/core/sova-spec.mjs where server/chat-manager.ts    # the claims for a file or a name
node pi-config/extensions/spec/core/sova-spec.mjs toc '§workspace.groups/decisions' --dir out
node pi-config/extensions/spec/core/sova-spec.mjs read '§workspace.groups/decisions'
node pi-config/extensions/spec/core/sova-spec.mjs read '§workspace.groups/decisions' --no-frame --cursor '<returned next token>'
node pi-config/extensions/spec/core/sova-spec.mjs impact '§chat.composer/behavior' --near
node pi-config/extensions/spec/core/sova-spec.mjs packet '§workspace.groups/decisions' # the whole chain, in pages
node pi-config/extensions/spec/core/sova-spec.mjs scope '§workspace/groups' --budget 4000 # deliberate full-graph inspection
node pi-config/extensions/spec/core/sova-spec.mjs impact '§chat.composer/behavior'
node pi-config/extensions/spec/core/sova-spec.mjs check --spec .sova/spec/drafts/NAME/spec   # a draft; local only
```

The reading path is contents first, then one passage, as spec mode teaches it:
- **`map`** and **`where <path|name>`** find the roots for a task.
- **`toc §id --dir out|in|down|up|mentions`** lists the claims one hop away in one direction, a
  line each saying what it is, why it is linked and what reading it costs, and delivers no passage.
- **`read §id`** returns one passage without its chain (an H1 gives its lede unless `--whole`).
  The first read carries the frame; later reads add `--no-frame`.
- **`impact §id --near`** lists what a change to it could reach, one hop at a time.

[core/README.md](../../pi-config/extensions/spec/core/README.md) has their output and flags.
The rest are whole-chain views:

- **`packet §id`** delivers the whole closure in bounded pages: exact text, never summaries, in compact JSON.
  Each prose fragment carries its declared kind and any authority/evidence labels; absent labels
  stay absent, and labels are not a tool's verification verdict. Its default 12,000-byte budget includes all UTF-8 output, metadata, cursor and newline;
  explicit budgets are integers 1,024–32,768. Follow `next` using `--cursor`, same ID/part,
  to finish relevant contiguous fragments. A passage finishes at `fragment.end == fragment.total`;
  `fragment.complete` means THIS item is the whole passage, not the final oversized chunk.
  Inspect `--part frontier` and `--part findings` separately: warnings such as missing code are
  findings, not dependency-frontier entries. `inventory` and `code` page their own details;
  counts expose all streams, while each cursor continues only the selected stream. Oversized
  detail records carry JSON fragments: join them before parsing. Changed captured inputs refuse
  continuation; restart rather than mixing versions. No cursor state is stored.
- **`scope §id`** remains the complete-graph API for deliberate machine inspection and review. A surface gives its
  lede and every child. A child gives its parent lede for orientation, and not its siblings. A
  section gives its members. Then everything they `requires`, depth-first. `--budget BYTES` keeps
  whole passages and names the rest as unread.
- **`impact §id`** lists what `requires` or `embeds` it, directly or indirectly.
- **`check`** validates the whole graph. **`census`** needs a `boundary` in the manifest; this one
  includes `server`, `shared`, `src` and `vite.config.ts`. **`census --changed [--base REV]`** checks only the
  files your task changed: the ones that differ from `REV` (default `HEAD`), plus untracked files.
  Each changed file inside the boundary is either claimed (listed with its §IDs) or reported as
  `changed-unclaimed` (exit 1). Changed files outside the boundary are listed, not failed.
- **`--spec DIR`** reads a draft's graph instead of the current one.

Exit `0` means the declared closure was delivered (`packet`: selected stream done without scope
warnings), never complete behavioral context or proof of reading earlier pages. Packet `status`
`more`/`done` describes only selected-stream navigation; `next` is null only when it is done.
Exit `1` means something relevant is unknown, stale or unread, or the packet stream has more.
Exit `2` means refused/untrusted, including a packet budget that cannot make progress. Packet errors
also fit supported budgets and have no stderr side channel. This adds no assessment or release gate.

**While coding**, exempt work included, run `census --changed` right after the first code edit, before the
second, and again whenever the edit set reaches a new file; it lists the foreign § a changed file
lands in (`census.foreign`), with the rule, and on one stderr line. Adding `--related` lists every
§ a changed file lands in, with its `requires` and consumers, and notes each touched § the task didn't create
(`touched-foreign`), and with `--spec <draft spec dir>` each new claim nested under one
(`child-under-foreign`). The notes are reminders to read and judge, not flags. Where you put your
claim changes nothing: the parent is foreign either way and the flag is owed either way. Any § the task didn't create is foreign, even one your draft edits, and
even the parent your new claim nests under; editing it in the draft (a row, a sub-claim, a sketch
line) is itself a flag. Read a foreign § with `read` and stay silent while its text holds;
plumbing (an added request, hook, helper, CSS class or types) never flags. Otherwise flag only a contradiction of its text, or
something a user would see there that its own text doesn't describe; that your new claim describes
it, in the parent's document or its own, does not remove the flag. A gap the foreign § already had (a field its prose never named) is not
a change your task made, even when your feature now depends on that field: mention it above the last line, never in it, or open a baseline draft. Batch the flags into the plan as one question ("this
also changes §X: <what>. OK?"). Before finishing, the reply's last line, exempt work included, is
exactly "Also changes: §X — <what>" (a list) or "Also changes: none", with nothing after it, even
when the user said not to ask. Notes (the exemption, a gap) go above it. The line names foreign §
only, never your own new claims: a user-visible addition under a foreign § is that §'s change,
even when your new claim describes it.
Exempt work skips the draft, not the census or the last line.

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
3. Record evidence. A behavior or surface needs at least one implementation file, unless it is
   agreed and not built yet, or the change is to its `embeds` or `core` field alone and it is not an
   agreed record that maps code (both `--doc-only`, below), and every path in its `code` must exist. The migrated records map no `code`, so add the files to the draft
   record's `code`, which binds them to the evidence, or pass `--path`. This repo uses Git, so name an existing commit that holds the
   implementation, and never commit unrelated changes to get one:

   ```sh
   node $d evidence composer-paste --id '§chat.composer/behavior' --by claude \
     --verification "pasted a PNG in the composer; it attached and sent" \
     --commit HEAD --path src/components/Composer.tsx --root . --write
   ```

   Without Git, use `--snapshot`, which keeps the exact bytes. `--doc-only` covers `note` and
   `section` records, agreed behaviors or surfaces with no code (DRAFTS.md, "Agreed, not built"), and
   a change to an existing behavior's or surface's `embeds` or `core` field alone, unless the record is
   agreed and maps code: that is refused (`doc-only-refused`) and needs `--commit` or `--snapshot`
   (DRAFTS.md, "Field-only changes"). `about` belongs on notes, which take `--doc-only` anyway.
4. Promote. The preview prints a plan hash, and `--write` applies exactly that plan:

   ```sh
   node $d promote composer-paste --id '§chat.composer/behavior' --root .
   node $d promote composer-paste --id '§chat.composer/behavior' --plan <printed hash> --root . --write
   ```

   It refuses when evidence is missing or stale, when a declaration, gap or record changed differently in both places,
   or when a promoted file carries other changes you didn't select. Resolve the refusal. Never
   work around it. After an interrupted promotion, run `node $d recover --root .`, then again with
   `--write`.

Documenting what the code already does, where the docs miss or misstate it, is its own draft.
Don't mix it into a feature's draft.

`.gitattributes` routes `manifest.json` through `merge-manifest`, so two branches that change
different records merge without a conflict. Git needs the driver defined once per clone (worktrees
share it):

```sh
git config merge.sova-spec-manifest.driver \
  'node pi-config/extensions/spec/core/sova-spec-draft.mjs merge-manifest --root . --base %O --ours %A --theirs %B --write'
```

Without it, Git falls back to its line merge. Both sides changing the same record still conflict.

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
`baseline` is taken. A stale packet is prepared again under a new name. Never edit
anything under `reviews/` by hand. See
[the tools README](../../pi-config/extensions/spec/README.md).

## Optional structured observations

Assessments run only when someone asks: no session, worker or hook runs one by itself. They do not
add a required release gate or replace the existing footer/review workflow. Prepare against a known
base, the revision the work started from (noted before it began, or `git merge-base master HEAD`);
every change since it is included, a file already dirty then too:

```sh
a=pi-config/extensions/spec/core/sova-spec-assess.mjs
base=$(git merge-base master HEAD)
node $a prepare change-review --root . --base $base                # preview
node $a prepare change-review --root . --base $base --write
node $a record change-review --root . --by reviewer \
  --decisions-json '{"decisions":[],"files":[]}' --write            # deliberately leaves items unresolved
node $a status change-review --root .
node $a status --root . --owner-session '<owner session id>'
```

Record explicit `changed`, `preserved`, `not-applicable` or `unresolved` dispositions with reasons
and structured verification bases; batches retain candidate IDs without duplicate claim prose.
The empty example records no verification and resolves nothing. Input applicability, disposition,
accepted-intent assertions, declared labels and recorded verification outcomes are separate: none
proves semantic correctness or changes readiness policy. Status exit 0 means only current known
inputs, even when coverage is unresolved or recorded verification failed. Missing inputs/baselines
remain unknown; changed inputs stale a receipt. No-Git explicit paths/snapshot baselines work too.

Immutable metadata receipts stay locally ignored under `assessments/`; no raw source or logs are
retained. Paths, identity and rationale can themselves be private, so publication is a separate
explicit decision. [The tools README](../../pi-config/extensions/spec/README.md) has the full
schema, attribution, refusal and applicability distinctions.

## What no tool tells you

- No tool checks that code does what the prose says. A clean `check`, recorded evidence, a
  review record or a promotion is not correctness.
- `migrated` means the text carries the requirement, and nobody has checked the implementation.
- `code` paths are evidence locations. A behavior inside a mapped file that no claim names is
  still unknown.
- A missing `requires` key means not investigated. `[]` means none declared, not none exist.
- Source code carries no `§` IDs or spec annotations.
