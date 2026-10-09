# spec: the `.sova/spec` tools

Standalone command-line tools over a project's `.sova/spec/` directory: the
project's documentation, as a `manifest.json` of claim records plus
`claims/*.md` prose, keyed by `§` IDs (the foldaidev identifier convention).
They work in any language, with or without Git, and need no existing docs and
no source annotations. They are not a pi extension. There is no
`index.ts`, so pi's loader skips this directory. They need only the Node
standard library and import nothing from pi, Sova or the rest of pi-config.

The `spec` minor mode (`../mode/`) uses these tools for coding work. Its text,
[`../mode/spec-mode.md`](../mode/spec-mode.md), is the discipline: when to run
them and what to do with the output. A project may point its agents at that
file without the mode, as Sova's `CLAUDE.md` does; that instruction alone does
not activate the mode's automatic checks. With the mode on, its hooks run
census and change checks. Sova's requirements reconciler is another consumer:
it uses drafts and doc-only evidence to publish accepted decision notes, not
to assert that those decisions have been implemented.

## Layout

| Path | What it is |
| --- | --- |
| `core/sova-spec.mjs` | The read-only core: `map`, `where`, `toc`, `read`, `impact` (and `impact --near`), `packet`, `scope`, `graph`, `check`, `census`, `foreign` |
| `core/packet.mjs` | The standalone core's bounded packet serialization and stateless navigation module |
| `core/toc.mjs`, `core/read.mjs` | Pull: `toc`, a one-hop contents view (what, why, size per line), and `read`, one exact passage without its chain |
| `core/fields.mjs` | The optional record fields `embeds`, `core` (the always-on frame stream, capped at 12,000 bytes) and `about` |
| `core/graph.mjs`, `core/map.mjs`, `core/where.mjs` | Look: `map` (every area on one page), `where` (the claims for a file or a name), `impact --near` (one reverse hop) and `graph --json` (the computed graph, paged) |
| `core/README.md` | The core's reference: commands, exit codes, the manifest format it reads, evidence states |
| `core/sova-spec-draft.mjs` | Drafts: full-copy proposals of `.sova/spec`, their evidence, and guarded promotion into the current docs |
| `DRAFTS.md` | The draft workflow's reference |
| `PROMOTE.md` | What promotion needs that the draft tool can't check; the spec mode points at it before a commit |
| `core/sova-spec-review.mjs` | The review companion: `prepare`, `record`, `status`. It keeps the exact bytes a review compared |
| `core/sova-spec-assess.mjs` | Observation-only input-bound dispositions and metadata-only receipts: `prepare`, `record`, `status` |
| `tests/*.test.mjs` | Black-box fixture tests that spawn the CLIs against temporary projects |
| [`docs/GOALS.md`](docs/GOALS.md) | What the spec system is for: its goals and constraints. A change to these tools names the goal it serves and is measured against today's tools (`tests/replay/`) |

## Core (read-only)

```sh
node core/sova-spec.mjs <map [namespace | '<§id>'] | where <path|name> [--token] [--all] | graph --json> [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR] [--json]
node core/sova-spec.mjs toc '<§id>' --dir out|in|down|up|mentions [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR] [--json]
node core/sova-spec.mjs <read '<§id>' [--whole] [--no-frame] | read --frame> [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR] [--json]
node core/sova-spec.mjs impact '<§id>' --near [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR] [--json]
node core/sova-spec.mjs packet '<§id>' [--part prose|inventory|frontier|code|findings|frame] [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR]
node core/sova-spec.mjs <check | census [--changed [--base <rev>] [--related]] | foreign --base <rev> [--head <rev>] | scope '<§id>' [--budget <bytes>] | impact '<§id>'> [--root DIR] [--spec DIR] [--json]
```

The reading path is contents first, then one passage: `map` and `where` find the roots, `toc`
lists one hop of neighbours, `read` returns one passage, and `impact --near` lists what a change
could reach (`core/README.md`, "Pull" and "Look"). `packet` is the bounded full-closure path: compact JSON, exact text (not summaries), default
12,000 UTF-8 bytes for the entire response including metadata and newline. Explicit budgets
are integers 1,024–32,768. Follow `next` with `--cursor`, keeping the same ID and part, to
finish relevant contiguous prose fragments; finish a passage at `fragment.end == fragment.total`.
`fragment.complete` means the item contains the whole passage, NOT that it is the final chunk.
Inspect `--part frontier` separately; `inventory`, `code` and `findings` expose paged details.
Counts reveal all streams; a cursor advances only the selected one. `done` or exit 0 is not
complete behavioral context or evidence of earlier reading. Changed captured inputs invalidate
continuation. There is no cursor store, snapshot write, new assessment or release gate.
Full-graph `scope` remains available for deliberate machine inspection and review, with its
unchanged prose-only budget. See `core/README.md` for packet fields, fragments and refusals.

`census --changed` checks one task's files instead of the whole boundary. It
takes the files that differ between `--base` (default `HEAD`) and the working
tree, plus untracked files that aren't ignored. Mapped deletions remain touched
claims; an unmapped deletion needs no new mapping. It lists files inside the
boundary as claimed (with their §IDs) or unclaimed.
Changed files outside the boundary are listed but don't count against it.
Each unclaimed file is a `changed-unclaimed` finding (exit 1). No Git work
tree (`not-git`) or a `--base` that isn't a commit (`bad-rev`) exits 2. Git is
run read-only, without a shell.

`census --changed --related` also lists, as `touched`, each § a changed file
lands in: its kind, labels, claim file and lines, the changed files that put it
there, its `requires` (`null` when the key is absent) and its transitive
consumers with depth. It reads the `--spec` graph when one is given. A touched
behavior without a `requires` key is a `touched-uninvestigated` note, so the
exit code stays what the files make it. It lists what to read; it never judges
a flag. `--related` without `--changed` is a usage error.

With `--related` the census also ranks the foreign touched § by the change's own
lines. From the added and removed lines (`git diff -U0` against the base; an
untracked file's lines all count as added) it takes code-shaped names (an inner
capital, `_`, `-`, `.` or `$`, or all capitals), short string literals and
numbers of two or more digits, and scores each § by the ones its passage holds,
each weighted by how rare it is across the spec's passages. A string or number
the change removed and didn't add back that a § still states is `stale`, and a
§ with one ranks first. `census.rank` lists each foreign touched § once with
`rank`, `score`, `reason` (the matched names) and `stale` (also set on its
`touched` entry); `census.readFirst` is the first 5 that score or are stale,
`census.named` the rest, so none is dropped. Human output prints `read first:`
and `named:` lines. The ranking is a literal match, never proof; nothing in it
knows a project.

Every § the task didn't create is foreign. The task created each § the spec
lacks at `--base` (the `created` of `foreign --base`), so one it promoted and
committed since the base is its own; with `--spec <draft spec dir>`, the ids
the draft has and `.sova/spec` lacks are its own too, and with `--own-base`, the
ids absent at every such revision. Every `census --changed`, with or without
`--related`, carries `census.foreignNote` (the rule) then `census.foreign` and
`census.childUnderForeign` right after `census.changed`, so a `head` keeps
them (surfaces first); one `foreign-summary` note, the rule then every foreign
id, is the last finding, so a `tail` keeps it; and when stdout is not a terminal
the same summary is one `sova-spec: …` line on stderr, rule first so a byte cut
keeps it, which a `grep` or JSON key-pick of stdout
doesn't touch. With `--spec` only, each new id whose H1 parent already exists
gets a `child-under-foreign` note. With `--related`, each `touched` entry also
carries `created: true|false`, and each foreign touched § gets a
`touched-foreign` note (read it with `read '<id>'`; if a user sees a change
there, even one the new claim describes, update it in the draft without asking and list it; a gap it already had never counts, even one you now rely on). Human output prints the summary
before the touched list. Notes are reminders, not flags: the exit code is
unchanged. The rule counts a request, hook, helper or CSS class as plumbing.
Plain `census` and `check` are as before.

`census --changed` also lists, as `mappedOutside`, changed files outside the
boundary that some claim's `code` maps (a `pi-config` file, say), with their §;
those § join `foreign`. The boundary itself is not widened.

`foreign --base <rev>` lists the foreign § the current spec changed from
`<rev>` to `--head <rev>` (default: the working tree, so an uncommitted
promotion counts): each § whose prose or record changed, was deleted, or gained
a new child, minus the § created in that range; `promote --write` prints it
for its own range, and reviews read it.

Quote IDs, because `§` is not a shell word character. Every command that takes a § id reads a
bare namespace like `§app.shell` as `§app/shell`, and says so (an `id-alias` note, or `alias` in the
pull and look views). `--budget` is accepted by `scope`, `packet`, `toc`, `read`, `map`, `where`,
`impact --near` and `graph`; with any other command it's a usage error. Scope budgets prose only;
packet budgets the whole response. `--spec` reads another
spec directory, given relative to the project root (default `.sova/spec`), such
as a draft. Code and incumbent paths stay relative to the root. The core never
writes.

A record may carry the labels `authority` (`candidate`, `migrated`,
`accepted`) and `evidence` (`unreviewed`, `reviewed`, `verified`). The core
reports them as written and never derives them. Kind `note` holds reference,
decision and rationale prose. Plain H3 and deeper headings are prose inside a
claim. `core/README.md` has the format.

- **Exit 0**: the declared closure was delivered (`packet`: the selected stream is done without
  scope warnings). It never means the context is
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
node core/sova-spec-draft.mjs merge-manifest --root DIR [--write] [--json]
node core/sova-spec-draft.mjs merge-claims --base F --ours F --theirs F [--path P] --root DIR [--write] [--json]
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
   record's `code` or `--path` (unless it is agreed and not built yet, or the change is to its
   `embeds` or `core` field alone and it is not an agreed record that maps code: both take
   `--doc-only`, below), and every `code` path must exist. In a Git project it needs `--commit`, an existing commit, ancestor
   of `HEAD`, whose files match the working tree for the mapped code. Without Git, `--snapshot` keeps the
   exact bytes. `--doc-only` covers `note` and `section` records, an `agreed` behavior or
   surface with no code (DRAFTS.md, "Agreed, not built"), and a change to an existing behavior's or
   surface's `embeds` or `core` field alone, unless the record is agreed and maps code: that is
   refused (`doc-only-refused`) and needs `--commit` or `--snapshot` (DRAFTS.md, "Field-only
   changes"). `about` belongs on notes, which take `--doc-only` anyway.
   Evidence binds to the record and prose as they are now, so a later edit
   stales it.
4. **`promote`** previews the plan and prints its hash. Then
   `promote … --plan SHA --write` applies exactly that plan. It refuses when
   evidence is missing or stale, when a declaration, gap or record changed
   differently in both the draft and the current docs, or when the merged graph would not
   load. Prose is compared per declaration (an H1 lede or H2 span): edits to
   different declarations of one file merge, and one declaration changed on both
   sides is a conflict, never merged as text. Current changes the draft doesn't
   touch are kept.
5. **`recover`** rolls back an interrupted promotion. Until it runs, every
   other write refuses.
6. **`merge-manifest`** resolves a Git merge conflict in `manifest.json` record
   by record (index stages base, ours, theirs) and refuses any key both sides
   changed differently. It is the only sanctioned way to settle that conflict;
   [PROMOTE.md](PROMOTE.md) has the rule.
7. **`merge-claims`** is a Git merge driver for `claims/*.md`: the promotion's
   per-declaration merge, with Git's own line merge and markers for what it
   can't merge, so the same declaration changed on both sides still conflicts.

When to draft, and how to keep a baseline apart from a feature, is in
[`../mode/spec-mode.md`](../mode/spec-mode.md). Evidence is bytes, revisions and the recorder's statement.
No tool here checks that code implements prose. The draft tool uses only the sibling core
and, in a Git project, read-only `git` plumbing, never a shell or a project script. Its silent
read-only `inspectDraft(root, name, {base, readPolicy})` export returns the existing check envelope;
it exposes no write command. Assessment draft triage passes its assessment-specific pre-read
refusal policy through proposed/baseline graph checks and proposed/baseline/current claim-tree
reads, including receipt-store incumbents and a current claims root that names receipt storage.
Only assessment-policy API results add metadata-only `inputSources` from actual draft-state and
proposed/baseline/current manifest/claim-tree reads. The assessor binds those sources and refuses
mixed read versions as a race; changed draft sources stale a receipt even when candidate routes do
not change. Default API results and ordinary draft CLI checks keep their original JSON contracts
and subprocess path.
[DRAFTS.md](DRAFTS.md) has the layout, exit codes, lock and limits.

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

## Observation-only change assessments

```sh
node core/sova-spec-assess.mjs prepare NAME --root DIR [--base REV] [--spec REL] [--draft NAME] \
  [--id '§id']… [--path REL]… [--baseline-json JSON] [--attribution-json JSON] [--write] --json
node core/sova-spec-assess.mjs record NAME --root DIR --by WHO --decisions-json JSON \
  [--attribution-json JSON] [--self] --write --json
node core/sova-spec-assess.mjs status NAME --root DIR --json
node core/sova-spec-assess.mjs status --root DIR --owner-session OWNER --json
```

This optional companion changes no review, promotion, footer or release gate. It routes candidates
from mapped changed files, declared consumers, explicit IDs, and optional draft restatement/citation
heuristics. Routing is not exhaustive behavioral discovery. Every candidate and unmapped change
starts unresolved, even with a verified label. One explicit batch can retain many candidate IDs with
a single reason and verification basis; omission never means not applicable. Legacy labels without
an assessment remain declarations, not invented verification provenance.

Git preparations bind a resolved base commit plus exact current dirty hashes. Explicit `--path`
selects only those observed paths; otherwise the full changed census is used. A task's initial dirty
snapshot can be passed as `--baseline-json '{"inputs":[{"path":"lib/file","state":"present",
"sha256":"<64 hex>","bytes":123}]}'` (absent or refused states are also supported). Exact readable
matches subtract pre-existing dirty paths; refused inputs remain unknown. Snapshot baselines are
caller declarations, distinguished from Git blob hashes. Without Git, explicit paths and declared
snapshot inputs work; missing baseline or change inventory is unknown, never complete.
Nothing passes such a snapshot on a caller's behalf: no session, worker or hook runs the
companion by itself. With a known `--base` and no snapshot, every committed and working-tree change
since that base is included, pre-existing dirty paths too, visibly.

`--decisions-json` is `{ "decisions": [ { "ids": ["§app/rule"], "disposition": "preserved",
"reason": "Compared the refactor", "basis": [{"kind":"inspection", "revision":null,
"result":"passed", "summary":"Recorder's comparison"}], "acceptedIntent":true } ], "files": [] }`.
Dispositions are `changed|preserved|not-applicable|unresolved`; file batches use `paths` instead of
`ids` and classify unmapped changes. Basis kinds are `test|inspection|command`, outcomes
`passed|failed|unknown`; intent is optional and never adopts a claim. The companion does not execute
a basis. Status separately reports any declared revision's input matching/mismatch/unknown, not
that a test was run. Self review is explicitly marked, not independent review.

Attribution has exactly six nullable printable fields: `ownerSessionId`, `sessionId`, `workerId`,
`teamId`, `taskId`, `attemptId`. Unknown fields default to null; identity is unauthenticated.

Preparations and records are immutable under `.sova/spec/assessments/NAME/`. Cooperating writers use
an exclusive lock, double capture and atomic no-overwrite publication. After a crash, an occupied
lock requires an operator to verify its holder is gone; it is never automatically removed. Partial,
corrupt, unreadable and capped (100 receipt) inventories are explicitly incomplete. Owner queries
keep null attribution visible and count excluded known other owners. No raw source or log bytes
are retained or printed. Metadata paths, names and rationale can themselves be private: receipts
stay locally ignored by default; publishing JSON is a separate explicit decision.

Each capture imports a fresh capture-local internal core reader and batches selected immutable Git
blob hashes. Independent double captures and status do not reuse source state. Size, path, mode and
credential refusals remain explicit; no raw blob contents are retained or printed. Existing core
CLI outputs and packet behavior remain unchanged.

Preparation preview exposes a stable fingerprint and exact current input metadata. Status reports
input `applicability` (`current|stale|unknown`), unresolved coverage, declared labels, accepted-intent
assertions and recorded verification separately. Status exit 0 means only current, known input
binding, even with unresolved coverage or failed verification. Exit 1 means unknown/stale inputs or
ordinary write refusal, 2 untrustworthy input/storage. Prepare/record exit 0 is operation success,
not reconciliation. New observations never overwrite or hide older or newer unresolved receipts.
Changed inputs stale an assessment; they do not automatically mean broken product behavior.

## What the minor mode checks by itself

With spec on, `../mode/spec-guard.ts` runs these tools for the agent (in pi
from `../mode/index.ts`; in Claude Code workers from the hooks the subagents
spawn path installs): after any tool call, bash included, a `git status` delta
that shows a first changed file in the boundary, or a new one, runs
`census --changed` and appends a short `[spec census]` digest to that tool
result, saying so when the session has no draft yet. At the first call after
the session's last edit it runs `census --changed --related` once and adds one
line, `Unread § your change landed in: read first …; named …`: the foreign §
the session's own files landed in, in rank order, minus those it ran
`sova-spec.mjs read` on; it says nothing again until an edit changes that set.
That line replaces the census the guide used to ask for by hand before
finishing. Nothing runs at the end of a turn: a reply carries no spec lines, and
a turn ends when the model stops.

These are post-operation diagnostics, not a write barrier. An unchanged claim
whose mapped code changed is advisory: review the affected behavior rather than
treating a quiet census as evidence of preservation.

`PI_SPEC_CENSUS_HOOK=0` turns the census note off in pi.

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
