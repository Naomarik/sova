# spec: the `.sova/spec` tools

Standalone command-line tools over a project's `.sova/spec/` directory: the
project's documentation, as a `manifest.json` of claim records plus
`claims/*.md` prose, keyed by `§` IDs (the foldaidev identifier convention).
They work in any language, with or without Git, and need no existing docs and
no source annotations. They are not a pi extension. There is no
`index.ts`, so pi's loader skips this directory. They need only the Node
standard library and import nothing from pi, Sova or the rest of pi-config.

The `spec` minor mode (`../mode/`) is their only consumer here. Its text,
[`../mode/spec-mode.md`](../mode/spec-mode.md), is the discipline: when to run
these tools and what to do with the output. A project may point its agents at
that file without the mode, as Sova's `CLAUDE.md` does. Nothing in pi or Sova
runs the tools itself.

## Layout

| Path | What it is |
| --- | --- |
| `core/sova-spec.mjs` | The read-only core: `check`, `census`, `scope`, `impact` |
| `core/README.md` | The core's reference: commands, exit codes, the manifest format it reads, evidence states |
| `core/sova-spec-draft.mjs` | Drafts: full-copy proposals of `.sova/spec`, their evidence, and guarded promotion into the current docs |
| `DRAFTS.md` | The draft workflow's reference |
| `PROMOTE.md` | What promotion needs that the draft tool can't check; the spec mode points at it before a commit |
| `core/sova-spec-review.mjs` | The review companion: `prepare`, `record`, `status`. It keeps the exact bytes a review compared |
| `tests/*.test.mjs` | Black-box fixture tests that spawn the CLIs against temporary projects |

## Core (read-only)

```sh
node core/sova-spec.mjs <check | census | scope '<§id>' [--budget <bytes>] | impact '<§id>'> [--root DIR] [--spec DIR] [--json]
```

Quote IDs, because `§` is not a shell word character. `--budget` is accepted by
`scope` only; with any other command it's a usage error. `--spec` reads another
spec directory, given relative to the project root (default `.sova/spec`), such
as a draft. Code and incumbent paths stay relative to the root. The core never
writes.

A record may carry the labels `authority` (`candidate`, `migrated`,
`accepted`) and `evidence` (`unreviewed`, `reviewed`, `verified`). The core
reports them as written and never derives them. Kind `note` holds reference,
decision and rationale prose. Plain H3 and deeper headings are prose inside a
claim. `core/README.md` has the format.

- **Exit 0**: the declared closure was delivered. It never means the context is
  complete, because what the graph doesn't declare can't show up.
- **Exit 1**: something relevant is incomplete or stale.
- **Exit 2**: the output can't be trusted.

A clean `check` means the structure is valid. It says nothing about whether the
claims are true. `core/README.md` has the details.

## Drafts

The current docs are `.sova/spec/manifest.json` and `claims/`. A proposed change
never goes there directly. It goes in a draft, and reaches the current docs
only by promotion, after it has been implemented and verified.

```sh
node core/sova-spec-draft.mjs new NAME [--purpose TEXT] --root DIR [--write] [--json]
node core/sova-spec-draft.mjs status NAME --root DIR [--json]
node core/sova-spec-draft.mjs diff NAME [--against base|current] --root DIR [--json]
node core/sova-spec-draft.mjs check NAME --root DIR [--json]
node core/sova-spec-draft.mjs evidence NAME --id '<§id>' --by WHO --verification TEXT \
  (--commit REV | --snapshot | --doc-only) [--path P] [--log FILE] --root DIR [--write] [--json]
node core/sova-spec-draft.mjs promote NAME (--id '<§id>' | --all) [--meta KEY] [--file PATH] \
  [--plan SHA] --root DIR [--write] [--json]
node core/sova-spec-draft.mjs recover --root DIR [--write] [--json]
```

1. **`new`** copies the whole current manifest and claims tree into
   `.sova/spec/drafts/NAME/`: an immutable `base/` and an editable `spec/`.
   With no current spec, it starts an empty one, so a project with no docs
   starts the same way.
2. Edit `spec/` only. `status`, `diff` and `check` (the core over the draft,
   through `--spec`) never write. The draft is a proposal. Agreeing on it
   approves the intent, and makes nothing current.
3. Implement, then verify each changed promise against the result. Relabel
   each record as it should read once current: promotion needs an explicit
   `authority` on every record it writes, and refuses `candidate` or none. New
   or rewritten prose becomes `accepted`, adopted under the task's go-ahead;
   `migrated` stays only on text still as ported, as provenance. Then run **`evidence`**. A
   behavior or surface needs at least one implementation file, from the
   record's `code` or `--path`, and every `code` path must exist. In a Git project it needs `--commit`, an existing commit, ancestor
   of `HEAD`, whose files match the working tree for the mapped code. Without Git, `--snapshot` keeps the
   exact bytes. `--doc-only` covers only `note` and `section` records.
   Evidence binds to the record and prose as they are now, so a later edit
   stales it.
4. **`promote`** previews the plan and prints its hash. Then
   `promote … --plan SHA --write` applies exactly that plan. It refuses when
   evidence is missing or stale, when a file or record changed differently in
   both the draft and the current docs, or when the merged graph would not
   load. Prose is compared as whole files and never merged. Current changes the
   draft doesn't touch are kept.
5. **`recover`** rolls back an interrupted promotion. Until it runs, every
   other write refuses.

When to draft, and how to keep a baseline apart from a feature, is in
[`../mode/spec-mode.md`](../mode/spec-mode.md). Evidence is bytes, revisions and the recorder's statement.
No tool here checks that code implements prose. The draft tool runs only the
sibling core and, in a Git project, read-only `git` plumbing, never a shell or
a project script. [DRAFTS.md](DRAFTS.md) has the layout, exit codes, lock and
limits.

## Review companion

```sh
node core/sova-spec-review.mjs prepare '<§id>' --root DIR --name NAME [--write] [--json]
node core/sova-spec-review.mjs record NAME --root DIR --by WHO \
  --conclusion reconciled|unaffected|unresolved --note TEXT [--self] [--json]
node core/sova-spec-review.mjs status NAME --root DIR [--json]
```

`--root` is required for all three.

1. **`prepare`** runs the sibling core's `scope` and lists every input with its
   size and hash. The inputs are the closure's claim files, cited incumbent
   files and mapped code, plus the whole `manifest.json` and
   `.sova/spec/README.md`, which is the policy input. Without `--write` it
   writes nothing.
2. **`prepare --write`**, run only when recording is authorized, stores
   `.sova/spec/reviews/NAME/packet.json` and the input bytes under
   `reviews/objects/`. It reads the inputs twice and refuses (`race`) if they
   changed in between.
3. **`record`**, run after an actual comparison, rechecks the inputs and stores
   `record.json`. Use `--self` when you review your own work. It refuses a
   stale packet. While the packet has blockers, only `unresolved` can be
   recorded. A record is never overwritten.
4. **`status`** never writes. It reports whether the packet is `applicable` or
   `stale`, and shows the recorded conclusion. It exits 0 only when the packet
   is applicable, has no blockers, and is concluded `reconciled` or
   `unaffected`. That is a local review gate, not semantic correctness.

A packet goes stale when an input changes, appears or disappears, or when the
closure gains, loses or respans a passage. Editing the manifest or the spec
README stales every packet, on purpose. **Stale means prepare a new packet
under a new name and review again.** Never edit anything under `reviews/` by
hand. Names match `^[a-z0-9][a-z0-9_-]{0,63}$` and can't be `objects`.

Blockers are core warnings plus inputs that are absent or refused. The
provenance warnings, `provenance-moved` and `provenance-stale`, are
informational: they are why a review happens, not missing evidence. Two
consequences:

- A `requires-uninvestigated` warning blocks `reconciled` and `unaffected`
  until that closure's dependencies are mapped. Map them in a draft and promote
  it, then prepare a new packet. Only the closure under review needs mapping,
  not the whole graph, and the gate is never waived. A `note` never raises this
  warning, so notes can be reconciled as they are.
- A cited incumbent file that no longer exists is an absent input, so it
  blocks, even though its prose moving or changing would only inform.

The packet also records the hashes of both tools, for audit only: a new tool
version doesn't stale a packet. These inputs are refused and never read:

- symlinks and hard-linked files
- files over 2 MiB
- credential files, and VCS and secret directories (matched case-insensitively)

A packet over 32 MiB in total can't be written.

Exit codes:

- **0**: the operation succeeded. For `status`, the gate above is met.
- **1**: refused or outstanding. Examples: `stale`, `race`, `evidence-incomplete`,
  `name-taken`, `record-exists`, `lock-occupied`, `oversize`.
- **2**: it can't run. Examples: a usage error, the core exiting 2 or breaking
  its output contract, and a missing or corrupt packet or object.

Neither tool adopts a claim, or edits claims or mappings. A conclusion is a
reviewer's claim, and self-review is never independent review. A hash match or a
record alone never adopts anything. Adoption is an explicit, authorized decision
for each promise, made after an actual comparison. "Authorized" means the user
decided, or an agent decided under a policy the user approved. One approval can
cover a bounded batch of promises or review writes, so autonomous work doesn't
need a dialog per promise.

### The write lock, and what it doesn't protect

`--write` and `record` hold `.sova/spec/reviews/.lock`. The companion never
removes a lock it doesn't own. If a writer crashed, the lock stays, and every
later write exits 1 with `lock-occupied` and the pid and time it holds. Delete it
by hand only after confirming two things: that process is no longer running,
and no review write is in progress.

The lock and the double read keep **cooperating** writers apart. Every path
component is checked and the final open refuses symlinks. Even so, a parent
directory swapped for a symlink between the check and the open is not fully
prevented. Nothing here is a filesystem sandbox or safe against a hostile
writer on the same machine.

## Where the minor mode finds them (path and trust)

`install.sh` links this directory to `<agent dir>/extensions/spec`. The minor
mode tells the agent to start each bash command with the shell prefix in the
one `sh` block of [`../mode/spec-mode.md`](../mode/spec-mode.md). It sets
`$core` to this directory's `core/`, so a command then reads
`node "$core/sova-spec.mjs" check --root <project root> --json`. The prefix
follows pi's own agent-dir rule: only an exact `~` or a leading `~/` means home,
and `~other` stays literal. Pi's bash tool always runs bash.
`../mode/index.test.ts` runs the prefix in bash against those cases. It also
checks that every tool, flag and draft command the prompt names exists in these
CLIs. The tools in that directory are the only ones the mode runs without
asking.

`install.sh` also honours `PI_AGENT_DIR`, ahead of `PI_CODING_AGENT_DIR`, but pi
ignores `PI_AGENT_DIR`. If `PI_AGENT_DIR` points somewhere else, the links land
where pi, and this path, never look.

A project may vendor its own copies, for example under `.sova/spec/tools/`. The
companion and the draft tool run the `sova-spec.mjs` in their own directory,
so vendor the files together. Vendored copies are the project's code, not these
tools. The minor mode reads them, or compares their hashes with the trusted copies, and asks
before running them. It never runs any other project script, install or
network command to get a spec tool. When no trusted copy is reachable, the
agent says so and reads the manifest and claim files directly. That happens on
a remote target, for example, where tools run on a machine without the agent
directory.

## Verification

```sh
cd extensions/spec
node --test tests/*.test.mjs
```

The tests make no network or model requests.
