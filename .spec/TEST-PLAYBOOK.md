# Acceptance playbook: the Sova spec system

This file is a complete brief for an orchestrating agent. It tells you how to drive every advertised claim
of the Sova spec system (the `.sova/spec` documentation, its three tools, the `spec` minor mode and the
Sova instruction that points at it) through isolated scenarios, have independent observers score them,
and hand back a report in which every claim is accounted for. You need nothing from the conversation that
produced this file.

It was written on 2026-09-23 against the uncommitted working tree of `~/webapps/sova` at HEAD `b95b28d`.
The setup commands and harness scripts in section 11 were dry-run in disposable fixtures; no acceptance
run has happened yet.

**Contents**: 1 What is under test · 2 Hard rules · 3 Tiers and statuses · 4 Run configuration ·
5 Setup · 6 Execution · 7 Prompt templates · 8 Artifacts and the report · 9 Teardown ·
10 Claim inventory · 11 Harness files · 12 Limits · Appendix: a committed candidate

---

## 1. What is under test

Read these files **in the frozen checkout** (`$CO`, section 5), never in the main tree. They play two
different roles, and a disagreement is never settled by quietly changing an oracle during the run:

- **The documentation files** (the READMEs, `DRAFTS.md`, `spec-mode.md`, `CLAUDE.md`, `.sova/spec/*.md`) are
  the **promised contract**. The inventory's claims and oracles restate it.
- **The implementation and tests** (`core/*.mjs`, `minor.ts`, `index.ts`, `*.test.*`) are the **actual
  behavior under test**. They are not an authority. When the code contradicts the frozen documentation, that is
  a finding: the row is FAIL (a doc/code conflict), with both locations cited. Never reinterpret an oracle
  to fit what the code happens to do. When the tool emits a different finding code from the one an oracle
  quotes, check the frozen documentation. If it names that code, the mismatch is a conflict (FAIL). If only this
  playbook names it, the playbook is stale (below). It is never a silent pass.
- **This playbook can be out of date.** If the frozen documentation legitimately promises something different
  from what a row's oracle says (the docs changed after this file was written), mark that row INCONCLUSIVE
  with reason `stale-playbook`, cite the documentation passage and the oracle, and list it in the report. Do
  not edit oracles mid-run, and do not score such a row against your own rewritten oracle. The playbook is
  corrected afterwards, in its own change.

Workers never decide either case. The independent observer does, from the frozen documentation, the raw
evidence and the row as written, and records which case applied (`conflict` or `stale-playbook`) in its
verdict's `reason`.

| Path in `$CO` | What it is |
|---|---|
| `pi-config/extensions/spec/README.md` | The tools: the read-only core, drafts, the review companion, the path/trust rule |
| `pi-config/extensions/spec/DRAFTS.md` | The draft workflow: layout, promotion checks, transaction, lock, limits |
| `pi-config/extensions/spec/core/README.md` | The core: commands, exit codes, format, what scope/impact/check/census return |
| `pi-config/extensions/spec/core/{sova-spec,sova-spec-draft,sova-spec-review}.mjs` | The implementation. Finding codes quoted below come from here |
| `pi-config/extensions/spec/tests/*.test.mjs` | The existing black-box tests (core, draft, review, review-safety) |
| `pi-config/extensions/mode/spec-mode.md` | The discipline text. The mode injects it; Sova's `CLAUDE.md` points at it |
| `pi-config/extensions/mode/minor.ts`, `index.ts`, `prompt.ts`, `index.test.ts`, `tests/smoke.mjs` | The minor mode, its composition and tests |
| `CLAUDE.md` (section "Product documentation") | Sova's standing rule: follow `spec-mode.md` whether or not the mode is on; never turn a mode on |
| `.sova/spec/{README.md,USAGE.md,manifest.json,.gitignore}`, `claims/`, `tools/` | Sova's own documentation and its vendored tools |

The system in one paragraph each:

- **Docs.** A project's documentation is `.sova/spec/manifest.json` (records keyed by `§` IDs: `kind`
  surface/behavior/section/note, `requires`, `members`, `code`, `incumbent`, labels `authority`
  candidate/migrated/accepted and `evidence` unreviewed/reviewed/verified) plus `claims/<ns>/<name>.md` prose
  whose H1/H2 headings declare the IDs. Labels are declared, never derived and never proof.
- **Core** (`sova-spec.mjs`, never writes): `check`, `census`, `scope '<§id>' [--budget BYTES]`,
  `impact '<§id>'`, with `--root`, `--spec` (a draft graph), `--json`. Exit 0 = the declared closure was
  delivered (never completeness), 1 = something relevant is unknown/stale/unread, 2 = untrustworthy.
  `scope` returns the requested passage first, then a child's parent lede as orientation, then children or
  members, then `requires` depth-first; `--budget` keeps whole passages and names the rest `unread-budget`,
  while `code` and provenance still cover the whole pre-budget closure.
- **Drafts** (`sova-spec-draft.mjs`, writes only with `--write`): `new` copies the whole current spec (or
  starts an empty one), you edit `drafts/NAME/spec/`, agreement approves intent only, then after
  implementation you relabel (`authority` accepted/migrated, never candidate), record `evidence`
  (`--commit` in Git, an existing ancestor of HEAD whose bytes equal the working tree; `--snapshot` without
  Git; `--doc-only` for note/section), `promote` previews a plan hash and `--plan SHA --write` applies it
  in a journalled transaction; `recover` rolls back an interrupted one.
- **Review companion** (`sova-spec-review.mjs`): `prepare` (preview, or `--write` a packet with the exact
  input bytes), `record` (a reviewer's conclusion; blocked closures can only be `unresolved`), `status`
  (exit 0 only when applicable, unblocked and concluded reconciled/unaffected: a local gate, not
  correctness).
- **Mode.** The `spec` minor mode injects `spec-mode.md` (trimEnd, byte for byte) once per turn when on,
  after `align` when both are on. Its one `sh` block sets `$core` to
  `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/spec/core`, where `install.sh` links the tools. Nothing in
  pi or Sova runs the tools by itself. In a generic project with the mode off there is no automatic
  workflow. In Sova, `CLAUDE.md` makes the same text policy regardless of the toggle, without turning
  anything on.
- **No tool checks meaning.** A clean check, recorded evidence, a review record or a promotion is never
  evidence that code does what the prose says. No row in this playbook asserts semantic correctness, and
  the report must not either.

State observed while writing (2026-09-23), **for orientation only; never assert these numbers**:
`check` on the candidate exits 1 with 23 claim files, 190 records (120 behavior, 52 note, 18 surface),
all `migrated`/`unreviewed`, 21 `requires` edges on 8 records, 112 `requires-uninvestigated` warnings,
0 code paths; the vendored `.sova/spec/tools/*.mjs` hashed equal to the canonical `core/*.mjs`. Rows
compute expectations from the files at run time.

## 2. Hard rules

These apply to you and to every worker you start. Put the relevant ones in every prompt.

1. **Main is read-only.** `MAIN` is the user's live checkout (default `~/webapps/sova`). Never write,
   commit, reset, stash, checkout, add, config, tag, or change refs or the index there, and never run a
   project script there. The only sanctioned write to MAIN's Git admin area is `git worktree add` (and, at
   teardown, `git worktree remove` of this run's own checkout), logged as an expected exception. Every
   `git` command against MAIN uses `--no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false`.
2. **Other people's work is untouched.** Live concurrent sessions may be editing MAIN. If the guard shows a
   change you did not make, flag the run INCONCLUSIVE; never revert it, never blame anyone. Never touch other
   worktrees (`git worktree list` shows several), never `git worktree prune`, never remove anything you did
   not create. Never restart, kill or signal a live Sova server or any process you did not start; never run
   `pi-config/install.sh` against the real HOME; never edit `~/.pi`, global settings or global installs.
3. **The run root is outside MAIN** and outside any Git repository: `$RUN/checkout` (a detached worktree
   with the frozen candidate), `$RUN/artifacts` (durable, never deleted by you), `$RUN/fixtures`
   (throwaway Git repos and plain no-Git dirs), `$RUN/agent`, `$RUN/sessions`, `$RUN/home`, `$RUN/tmp`
   (isolated pi agent dir, sessions, HOME and TMPDIR for the system under test), `$RUN/harness`. Generated
   scripts and fixtures live only there. This playbook is the only permanent file outside it.
4. **Git writes only in fixtures.** Commits, branches and config changes happen only in independent
   repos under `$RUN/fixtures` (use `fx.mjs`, which refuses anything else; ACT-4's seed commits go
   through `fx.git` too). No `git` write in `$CO` either: it shares MAIN's object store, refs and stash.
   The exact safe prefixes, used by every command in this playbook and the harness:
   - MAIN and `$CO` (worktree add/remove, list, status, snapshots):
     `git -C <dir> --no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false …`
     (hooks such as `post-checkout` and any fsmonitor program never run).
   - Fixtures: `env -i PATH="$PATH" HOME="$RUN/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TEMPLATE_DIR= git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=acceptance -c user.email=acceptance@invalid -c commit.gpgsign=false -C <fixture> …`,
     and `init` also gets `--template=` (no copied hooks). No user global or system config, hooks,
     templates, credential helpers or signing apply. DR-GIT-7 deliberately sets a fixture-local fsmonitor
     to prove the draft tool ignores it.
   - The draft tool's own Git calls clear `GIT_*` and force `core.fsmonitor=false`, but still read the
     caller's `HOME` global config: always run it with `HOME=$RUN/home` (`fx.tool` and `run.mjs` do).
   - Scripts of the candidate that call `git` themselves inside `$CO`
     share MAIN's config: run them through `run.mjs` with `$GITENV` (from `env.sh`), which forces
     `core.fsmonitor=false` and `core.hooksPath=/dev/null` for every Git call they make.
   - `fx.mjs` and `fixture-notes.mjs` resolve every path by realpath and refuse anything not strictly inside
     `$RUN/fixtures` (so `../`, symlinks and `.git` pointer files cannot lead out), stop Git discovery at
     `$RUN/fixtures` (`GIT_CEILING_DIRECTORIES`), and check before and after every Git command that the
     repository's toplevel and common Git dir are inside `$RUN/fixtures`. Escape-test canaries live elsewhere
     inside `$RUN/fixtures`, never outside it.
5. **The candidate is frozen once.** Copy exactly the allowlisted dirty paths (section 5), with hashes and
   deletions, verify twice. Never blanket-copy `.sova/`: `pilot/`, `reviews/` and `drafts/` are local-only
   originals and stay where they are. A file the candidate needs but did not include is the old HEAD version; nothing about it may be claimed tested.
6. **No credentials in the system under test, none in logs.** Never copy `auth.json` or keys, never print
   the environment, never pass credentials on a command line. The harness that orchestrates may use its own
   approved auth for workers; the tested pi/Sova runtime runs only from `$RUN/agent`. If a tier needs model
   credentials in `$RUN/agent` and the caller has not provided an isolated way, its rows are BLOCKED.
   **Every launch of the system under test** (pi, the Sova server, test suites, `install.sh`, a dependency
   install) goes through `run.mjs`, whose child environment is an allowlist, or through an explicit `env -i`
   allowlist: `PATH`, `LANG`/`TZ`, `HOME`, `TMPDIR` and `PI_CODING_AGENT_DIR` inside `$RUN`, plus only the
   runtime variables the recipe names (`PI_OFFLINE`, `PORT`, `npm_config_cache`). For L, add only the
   caller-authorized credential variable, by name, through `run.mjs --pass-env NAME`. Never use a bare
   `VAR=… command` prefix: it inherits your whole environment, including API keys and `CLAUDE_CONFIG_DIR`.
   The offline C runs already go through `run.mjs`, with `--no-approve --no-extensions`.
7. **No network, installs or scripts by default.** No `npm install`, no package scripts, no downloads. A
   dependency install happens only when `acceptance.json` authorizes it, only inside `$CO`, with
   `--ignore-scripts`. Never symlink MAIN's `node_modules` into the checkout (builds would write caches into
   MAIN).
8. **Claims are verified by observation.** A worker's statement is a claim; the verdict comes from an
   independent observer reading raw artifacts (JSON, exit codes, tree hashes, transcripts) or re-running the
   scenario. Guards assert with external hashes, never with "the worker said it didn't touch main".
9. **Delete only exact paths you own, never by pattern.** Everything this run creates lives under `$RUN`
   (tools' temp files go to `$RUN/tmp`). If anything must be created elsewhere, append its exact absolute path
   to `$ART/owned-paths.txt` when you create it. The only deletions ever allowed are `git worktree remove` of
   `$CO` (section 9) and, if the caller asks, exact `$ART/owned-paths.txt` entries, one at a time, each checked
   to exist at that recorded path. Never `rm` with a glob or a name prefix (for example `rm -rf /tmp/x-*`), even
   under `/tmp`, and never infer ownership from a name: sibling directories may belong to other sessions.
   Workers and observers delete nothing.
10. **Artifacts are never removed.** Not on failure, not on success. Raw agent transcripts go under
   `$ART/restricted/`; nothing is published or shared automatically, and anything shared is redacted first.
11. **cwd is not a sandbox.** Workers share your user and filesystem. Say so in the report; never claim
    filesystem isolation from a working directory.

## 3. Tiers and statuses

| Tier | Meaning | Needs |
|---|---|---|
| **M** mechanical | Node CLIs of the candidate on throwaway fixtures, or read-only on `$CO` | Node ≥ 22.19 |
| **T** existing tests | The candidate's own test suites, run in `$CO` | Node; T-SERVER also needs dependencies |
| **C** actual CLI, offline | Real `pi` + the real mode extension from `$CO`, with the offline capture provider (`capture-provider.ts`) recording the exact system prompt. No model, no network | `pi` on PATH |
| **A** agent simulation | A fresh model worker from your harness acts on a fixture; the discipline text is supplied by the harness (system prompt) or found through context files. **Simulation, not integration** | Harness subagents |
| **L** live integration | Actual `pi -p` from `$RUN/agent` with the real mode extension and a real model | Caller-provided isolated credentials |
| **S** isolated service | A Sova server started from `$CO` on a probed free port with `$RUN/agent` | Dependencies installed in `$CO`, a free port |

The tier column of the inventory is the **required** tier. Evidence from a lower tier never makes a row
PASS; `report.mjs` downgrades it to INCONCLUSIVE and says so.

| Status | Use when |
|---|---|
| PASS | The oracle held at the required tier, with evidence, confirmed by an observer |
| FAIL | The oracle was violated, reproducibly (observer re-ran it or confirmed it from raw evidence) |
| BLOCKED | A precondition is missing: credentials, dependencies, port, authorization, platform (e.g. running as root) |
| UNTESTED | Not attempted (budget stop, not selected), or no observer verdict |
| INCONCLUSIVE | Ran but cannot be decided: contamination, flakiness, guard difference, below-tier evidence, unresolved disagreement |

Never mark a row PASS because a neighbouring row passed. There is no blanket green.

## 4. Run configuration

A simple handoff must work. If the caller gave you an `acceptance.json`, use it; otherwise write one from
the caller's instructions plus these permitted defaults, save it as `$RUN/acceptance.json`, and proceed.

```json
{
  "main": "~/webapps/sova",
  "runRoot": "~/.local/state/sova-acceptance/<UTC yyyymmdd-hhmmss>",
  "allowlist": "harness/allowlist.default.txt",
  "tiers": { "M": true, "T": true, "C": true, "A": true, "L": false, "S": false },
  "workers": {
    "backend": "pi",
    "maxConcurrent": 4, "maxTotal": 30, "maxMinutesEach": 30,
    "models": { "mechanical": null, "observer": null, "actor": null },
    "effort": { "mechanical": null, "observer": null, "actor": null }
  },
  "budget": { "maxWallMinutes": 240, "maxModelCostUSD": null },
  "authorize": {
    "dependencyInstall": null,
    "isolatedCredentials": null,
    "servicePort": null,
    "delegateSlicing": false
  },
  "cleanup": { "removeCheckoutOnPass": false }
}
```

- **Models.** `null` does not mean "whatever the spawn tool defaults to". Before any agent worker starts,
  resolve every role to an exact **backend, model ID and effort** that the caller approved: from this
  `acceptance.json`, from the caller's instructions, or from a session or delegation profile the caller has
  already authorized for this kind of work (an explicit delegate routing, a documented default). Confirm the
  IDs exist with your harness's discovery tool (pi: `agent_models`), then pass them explicitly to every spawn
  and write the fully resolved table into `run-plan.md` before W3. A simple handoff that names such a profile
  needs no extra dialog.
  - Never guess the parent's model, never switch provider or backend, never "fall back" to another model.
  - If a role's approved identity is not safely known, or a supplied selection is unavailable (discovery
    fails, model missing, backend not loaded), the rows that need that role are BLOCKED with the reason.
    Rows whose scenarios need no model (M, T, C) still run; you may run them yourself. They are still
    scored by an independent observer. If no approved observer identity exists, their verdicts are
    INCONCLUSIVE "no independent observer" (never self-scored PASS), with the raw evidence kept.
  - Prefer an observer on a different model or backend than the actors when the approved set allows;
    otherwise use a fresh, unforked session and disclose that actor and observer share a model.
- **`authorize.dependencyInstall`**: `null`, or the exact command the caller approved, run in `$CO` with an
  isolated HOME and cache and a clean environment, for example
  `cd "$CO" && env -i PATH="$PATH" HOME="$RUN/home" TMPDIR="$RUN/tmp" npm_config_cache="$RUN/npm-cache" npm ci --ignore-scripts`
  (network; no registry token is passed). Never the real `~/.npm`, never MAIN's `node_modules`. `null` makes T-SERVER and all S rows BLOCKED.
- **`authorize.isolatedCredentials`**: `null`, or how the caller provides a model credential to
  `$RUN/agent` without you copying it (for example "env var `X_API_KEY` is set in the orchestrator's
  environment for provider `x`, model `x/y`"). The value never goes on argv or into `--env`: pass it by name
  (`run.mjs --pass-env X_API_KEY --online`, which logs the name only). `null` makes the INT rows (tier L) BLOCKED.
- **`authorize.servicePort`**: `null` (S rows BLOCKED) or a port to probe. Never 4800 or 4810 unless the
  probe proves them free; never stop whatever holds them.

**Stop conditions** (check before each wave, and before every expensive step: A-tier actors, L, S):

- The final-pass freeze check fails, or the guard shows MAIN changed: stop starting new rows; finish the
  report with the rest UNTESTED and the run INCONCLUSIVE.
- Wall time, worker count or cost would exceed the budget: stop; the rest is UNTESTED with "budget".
- Three workers in a row fail to start or return nothing: stop that wave; its rows are BLOCKED with the
  harness error.
- Any evidence that a worker wrote outside its allowed paths: stop that worker's rows, mark INCONCLUSIVE,
  and run the guard immediately.

Write `$RUN/run-plan.md` before W1: the resolved config, enabled and BLOCKED tiers with reasons, the waves,
which rows each worker gets, the model/backend/effort per role, the caps, and the stop conditions. Update it
when you deviate.

## 5. Setup

Run these yourself (no workers). Every step is idempotent except the worktree add. Paths below are
examples; the variables are what matter. **Run every command in this playbook under bash, explicitly:**
`bash --noprofile --norc -c '…'` (or a script file run with `bash --noprofile --norc`), never your tool's
default shell by implication. zsh does not word-split `$PRIV`/`$GITP`, so S0 and `env.sh` exit before doing
anything when not under bash, and `guard.mjs` refuses malformed `--private` arguments rather than skipping
them. After S0, begin every command with `source <run root>/env.sh`.

**S0. Preflight.**

```sh
[ -n "${BASH_VERSION:-}" ] || { echo 'run under bash'; exit 1; }     # first, before anything: zsh would not split $PRIV
MAIN=$(realpath -e ~/webapps/sova) || exit 1
RUN=$(realpath -m ~/.local/state/sova-acceptance/$(date -u +%Y%m%d-%H%M%S))   # GNU realpath: -m allows a missing path
GITP="--no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false"
# Validate BEFORE creating, copying or exporting anything:
case "$RUN/" in "$MAIN"/*) echo "RUN must be outside MAIN"; exit 1;; esac
case "$MAIN/" in "$RUN"/*) echo "RUN must not contain MAIN"; exit 1;; esac
[ -e "$RUN" ] && { echo "RUN already exists: never reuse a run root"; exit 1; }
a=$RUN; while [ ! -e "$a" ]; do a=$(dirname "$a"); done     # nearest existing ancestor
git -C "$a" $GITP rev-parse --show-toplevel >/dev/null 2>&1 && { echo "RUN would be inside the Git repo above $a (the draft tool looks upward for .git): choose another runRoot"; exit 1; }
# Any single marker of an in-progress Git operation refuses (paths resolved by Git, so a linked-worktree MAIN works too):
for m in index.lock MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD; do
  p=$(git -C "$MAIN" $GITP rev-parse --path-format=absolute --git-path "$m") || { echo "cannot resolve MAIN's Git dir"; exit 1; }
  [ -e "$p" ] && { echo "a Git operation is in progress in MAIN ($p): wait, or run INCONCLUSIVE"; exit 1; }
done
export MAIN RUN CO=$RUN/checkout ART=$RUN/artifacts PLAYBOOK=$MAIN/.spec/TEST-PLAYBOOK.md
mkdir -p "$RUN"/{artifacts/guard,artifacts/candidate,fixtures,home,tmp,sessions,harness}
# Each tool call usually gets a fresh shell: persist the variables and source this file first in every command.
cat > "$RUN/env.sh" <<EOF
[ -n "\${BASH_VERSION:-}" ] || { echo 'run under bash'; exit 1; }
export MAIN="$MAIN" RUN="$RUN" CO="$CO" ART="$ART" PLAYBOOK="$PLAYBOOK"
GITP="$GITP"
PRIV="--private .sova/spec/pilot --private .sova/spec/reviews --private .sova/spec/drafts"
# For scripts that run git themselves inside \$CO: pass these through run.mjs --env
GITENV="--env GIT_CONFIG_COUNT=2 --env GIT_CONFIG_KEY_0=core.fsmonitor --env GIT_CONFIG_VALUE_0=false --env GIT_CONFIG_KEY_1=core.hooksPath --env GIT_CONFIG_VALUE_1=/dev/null"
EOF
echo "run root: $RUN   (every later command starts with: source $RUN/env.sh)"
cp "$PLAYBOOK" "$ART/playbook.md"; sha256sum "$ART/playbook.md" > "$ART/playbook.sha256"
node --version; git --version; pi --version; id -u     # record all four in run-plan.md; uid 0 blocks DR-TXN-1
```

**S1. Extract the harness** (section 11) and check it against the hash table there:

```sh
node -e 'const fs=require("fs"),path=require("path");const [p,o]=process.argv.slice(1);let n=0;
for (const m of fs.readFileSync(p,"utf8").matchAll(/^````[a-z]+ (harness\/[\w.-]+)\n([\s\S]*?)\n````$/gm)) {
  const f=path.join(o,m[1]); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,m[2]+"\n"); n++; }
console.log(n+" harness files")' "$PLAYBOOK" "$RUN"
chmod +x "$RUN"/harness/*.sh
(cd "$RUN" && sha256sum harness/*) | tee "$ART/harness.sha256"   # compare with the table in section 11
```

**S2. Guard snapshot of MAIN** (read-only; private dirs are hashed, never copied):

```sh
node "$RUN/harness/guard.mjs" snapshot "$MAIN" "$ART/guard/before.json" $PRIV     # $PRIV comes from env.sh
# the real agent dir, read-only (auth.json by size/mtime only, never read), to show the system under test never touched
# its config (ISO-5). sessions/ is NOT watched: your harness workers write there; disclose it instead:
(cd ~/.pi/agent && ls -la extensions; sha256sum settings.json mode.json mode-delegate.json model-policy.json trust.json models-store.json models.json keybindings.json vision-delegate.json 2>/dev/null; stat -c "%n %s %Y" auth.json 2>/dev/null) > "$ART/guard/home-pi-before.txt"
```

**S3. Freeze plan.** Review the default allowlist against MAIN's dirty state, then plan:

```sh
cp "$RUN/harness/allowlist.default.txt" "$RUN/allowlist.txt"
git -C "$MAIN" $GITP status --porcelain=v1 --untracked-files=all > "$ART/candidate/main-status.txt"
node "$RUN/harness/freeze.mjs" plan "$MAIN" "$RUN/allowlist.txt" "$ART/candidate/manifest.json"
```

Read `manifest.json`: `entries` (path, action write/delete, sha256, mode, git status, rename origin),
`excludedDirty` (dirty paths left out, for example concurrent UI work in `src/`), `denied` (secret-like or
private paths, and every symlink not approved by a `+link <path>` rule or whose target would leave the checkout), `ignoredSkipped` (ignored paths under an include, never copied), `stagedChanges`.
If a dirty path under `pi-config/extensions/spec/`, `pi-config/extensions/mode/`, `.sova/spec/`
or `server/mode-state*` is in `excludedDirty`, add a rule, re-plan, and note why. The five instruction
files at the end of the allowlist are **mixed**: they may carry unrelated edits; list them in
`run-plan.md` as mixed. Rows that depend on them (CAN-6, MODE-9/10) report on the frozen bytes, and the
report must say the bytes were mixed.

**S4. Worktree and candidate** (the one sanctioned MAIN admin write):

```sh
git -C "$MAIN" $GITP worktree add --detach "$CO" HEAD
node "$RUN/harness/freeze.mjs" apply  "$ART/candidate/manifest.json" "$CO"
node "$RUN/harness/freeze.mjs" verify "$ART/candidate/manifest.json" "$CO" "$ART/candidate/verify-pass2.json"   # must print "no drift"
node "$RUN/harness/freeze.mjs" closure "$CO" "$ART/candidate/closure.json" \
  pi-config/extensions/spec/core/sova-spec.mjs pi-config/extensions/spec/core/sova-spec-draft.mjs pi-config/extensions/spec/core/sova-spec-review.mjs \
  pi-config/extensions/mode/minor.ts pi-config/extensions/mode/index.ts pi-config/extensions/mode/prompt.ts pi-config/extensions/mode/index.test.ts
git -C "$MAIN" $GITP worktree list --porcelain > "$ART/guard/worktrees-after-add.txt"
```

Any Git command you run against MAIN or `$CO` uses `$GITP` (from `env.sh`). `apply`, `verify` and `closure` first refuse, before touching anything, unless `$CO` is exactly `$RUN/checkout` (absolute, normalized, no symlink on its path), `$RUN` and MAIN do not contain each other, `$CO` is a linked worktree registered in MAIN, shares MAIN's common Git dir, is its own toplevel, and its HEAD is the manifest's HEAD (a commit in the shared checkout is forbidden and detected). `verify` checks both directions: MAIN still has the planned bytes (no drift since the plan) and `$CO` has
exactly them, that denied/excluded paths are absent from `$CO`, and that no new dirty path appeared in MAIN under
a candidate rule since the plan (`appearedSinceFreeze`). Drift or a new path means MAIN moved while you froze
it: re-plan before any row runs, or, after rows ran, report the run INCONCLUSIVE; never copy the change in
silently. Run `verify` again in W7 (pass 3).

**S5. Isolated runtime for the system under test:**

```sh
bash "$RUN/harness/agentdir.sh"      # $RUN/agent with extensions/spec -> $CO; no auth copied
```

It links only `extensions/spec` (where the prompt's `$core` resolves). The mode extension is **not**
linked: pi's loader does not realpath symlinked extensions, so mode's `../command-palette` and
`../subagents` imports would not resolve. C and L runs load it with `-e "$CO/pi-config/extensions/mode/index.ts"`.
Environment for every system-under-test command: `HOME=$RUN/home TMPDIR=$RUN/tmp
PI_CODING_AGENT_DIR=$RUN/agent PI_OFFLINE=1` (L drops `PI_OFFLINE`). `run.mjs`, `fx.mjs` and
`pi-capture.sh` set or pass these for you.

`npm run dev:hermetic` exists (`scripts/hermetic-agent-dir.mjs`): it builds `<checkout>/.agent` and
starts the server on the fixed port 4810. This playbook uses its own `$RUN/agent` and a probed port instead.
If you use the script for S rows, run it in `$CO` only, and probe 4810 first.

## 6. Execution

Waves run in order. Inside a wave, run workers in parallel up to `maxConcurrent`. After each wave, take a
guard snapshot and compare (`guard.mjs compare … --worktree "$CO"`, saved as
`$ART/guard/compare-W<n>.json`) so a foreign change can be placed in time.

| Wave | Who | Rows |
|---|---|---|
| W1 setup evidence | you | ISO-1..5 (from S2–S5 output), T-VENDOR |
| W2 existing suites | you or 1 mechanical worker | T-SPEC, T-MODE, T-SMOKE, T-SERVER |
| W3 mechanical | mechanical workers, one category group each: CORE; DR-NEW..DR-EV; DR-PR..DR-MAL; RV + SEC; LIVE + PUB + CAN + REG + SEM | all M rows |
| W4 offline CLI | 1 mechanical worker | MODE-1, 2, 3, 7, 9, 10, 12, 13, CAN-4, CAN-5 (C rows plus the two prefix/install M rows) |
| W5 agent simulation | 1 fresh actor per ACT run (section 7.3), then observers | AG rows, REG-6 |
| W6 optional | only if enabled and authorized | INT rows (tier L), MODE-14 (tier S), T-SERVER install |
| W7 close | you + 1 observer for ISO rows | guard final, freeze verify pass 3, report, redaction scan, teardown |

For every row, the flow is: **worker runs the scenario → writes `claim.json` → an observer, who did not
write it, re-runs or re-derives it → writes `observer/<ID>.json`**. Only observer files count.
**Nothing recorded is ever overwritten.** Every row's work happens in attempt directories,
`$ART/rows/<ID>/attempt-<N>/` (`ATTEMPT=<N>` in the environment; `run.mjs` and `pi-capture.sh` default to 1 and
refuse, before running anything, to reuse an existing step). A retry is a new attempt: copy the scenario into
`attempt-<N+1>/`, change it there, and leave the failed attempt's script, outputs and claim exactly as they
were. Shell redirections into artifacts use `set -o noclobber`. A superseded verdict is kept too: before
writing a new `observer/<ID>.json`, rename the old one to `observer/<ID>.superseded-<UTC>.json`, and give the
reason in the new one. Rows you
cannot run get an observer file written by you with `BLOCKED` or `UNTESTED`, the reason, and
`"observer": "orchestrator (precondition)"`.

How to run each tier:

- **T**: `node "$RUN/harness/run.mjs" --row T-SPEC --step node-test --cwd "$CO/pi-config/extensions/spec" --watch "$CO" -- node --test tests/core.test.mjs tests/draft.test.mjs tests/review.test.mjs tests/review-safety.test.mjs`
  (with `HOME=$RUN/home TMPDIR=$RUN/tmp` exported). The `--watch "$CO"` proves the suite did not write
  into the checkout. Record the test count; do not assert a number.
- **M**: workers write one `scenario.mjs` per attempt under `$ART/rows/<ID>/attempt-<N>/`, importing `$RUN/harness/fx.mjs`
  (`project`, `write`, `git`, `commit`, `tool`, `tree`; all refuse paths outside `$RUN/fixtures`), and run CLIs either through `fx.tool` (fixtures only; JSON parsed,
  exit checked) or through `run.mjs` when the raw stdout/stderr and write set must be kept. A worker keeps
  the scenario re-runnable: `RUN=… CO=… ART=… ATTEMPT=<N> node scenario.mjs` must rebuild fresh fixtures.
- **C**: `bash "$RUN/harness/pi-capture.sh" ROW STEP PROJECT_DIR MINOR [extra pi flags]`. It runs one offline
  `pi -p` turn with only the checkout's mode extension and the capture provider, stdin closed, and leaves
  `$ART/rows/ROW/attempt-<N>/STEP.capture.jsonl` (the exact system prompt) plus the `run.mjs` record with the write set
  of `$RUN/agent` and the project. Compare against `spec-mode.md` read from `$CO` at check time, trimEnd.
- **A**: see 7.3. Build each actor's fixture with `fixture-notes.mjs`, snapshot the fixture with `fx.tree`
  before and after, keep the actor's full transcript under `$ART/restricted/<ACT>/`, and put the hidden
  oracle for that run only in `$ART/hidden/<ACT>.json`, which actors are never told about.
- **L** (only with `authorize.isolatedCredentials`): the same fixtures and prompts as the A runs they mirror,
  launched only through `run.mjs`, which sets HOME, TMPDIR and the agent dir to `$RUN`, and passes the one
  authorized credential variable by name (its value is never on argv or in any record):

  ```sh
  ATTEMPT=<N> node "$RUN/harness/run.mjs" --row INT-1 --step pi --cwd <fixture> --watch <fixture> --online \
    --pass-env <CRED_NAME> --timeout-ms 1800000 -- bash -c 'exec pi "$@" </dev/null' pi --no-approve --no-extensions \
    -e "$CO/pi-config/extensions/mode/index.ts" --minor <spec|none> --session-dir "$RUN/sessions" \
    --model <approved id> -p "<task>"
  ```

  Transcripts come from `$RUN/sessions`. First, a readiness probe the same way (never `--credentials`, which
  prints the credential): `ATTEMPT=<N> node "$RUN/harness/run.mjs" --row INT-READY --step auth --cwd "$RUN"
  --online --pass-env <CRED_NAME> -- bash -c 'exec pi "$@" </dev/null' pi auth check --provider <p> --json --no-refresh`.
  `"status":"not_ready"` makes the INT rows BLOCKED.
- **S** (only with dependencies and a port): probe the port without taking it over
  (`node -e 'const s=require("net").createServer().once("error",()=>process.exit(1)).listen(+process.argv[1],"127.0.0.1",()=>s.close())' PORT`),
  then start the server in the background with a clean environment (no credentials; it needs none for
  `/api/mode`):

  ```sh
  d="$ART/rows/MODE-14/attempt-$ATTEMPT"; mkdir -p "$d"; set -o noclobber
  cd "$CO" && env -i PATH="$PATH" LANG=C.UTF-8 HOME="$RUN/home" TMPDIR="$RUN/tmp" PI_CODING_AGENT_DIR="$RUN/agent" \
    PI_OFFLINE=1 PORT=<port> node_modules/.bin/tsx server/index.ts > "$d/server.log" 2>&1 &
  echo $! > "$d/server.pid"
  ```

  Record its child PIDs (`pgrep -P "$(cat "$d/server.pid")"`), exercise `GET/POST /api/mode`,
  then send SIGTERM to **that PID only**, wait up to 10 s, and confirm the port probe succeeds again and none of the
  recorded child PIDs is still alive. If anything of yours survives, SIGKILL only those recorded PIDs and say so;
  never signal a process you did not start.

## 7. Prompt templates

Fill the `<…>` slots; keep everything else. Save every filled prompt as `$ART/workers/<name>/prompt.md` and
its provenance as `$ART/workers/<name>/provenance.json`:
`{name, role, backend, model, effort, sessionId, sessionFile, cwd, allowedPaths, rows, startedAt, endedAt, promptSha256}`.
Session files your harness keeps elsewhere (pi: `~/.pi/agent/sessions/…`, oversized tool output in
`/tmp/pi-subagents-output-*`; other harnesses: their own store) live outside the run root: record their
paths in provenance and disclose them in the report.

With pi's subagents extension: `agent_spawn` with `name`, `prompt`, `cwd`, `tools`, `model`, `effort`,
`systemPrompt`, `fork: false` (always; workers are fresh and never see this conversation), then
`agent_wait`, `agent_transcript` (`full: true` for actors), `agent_list` for session files. Workers start
with `--no-extensions` and their own normal context for their cwd. With another harness, use its equivalent
and record what it cannot do (for example "no per-worker cwd: cwd by instruction only").

**Worker lifecycle.** The numbers below are pi's; with another harness, use its equivalents.

- **Slots.** Pi allows at most 12 live workers per session and 8 per spawn call. A worker whose task has
  settled goes idle and **still holds a slot**. Before each wave, run `agent_list`. Count workers that are
  not this run's as occupied, and set the wave's concurrency to
  `min(maxConcurrent, 12 − foreign live − own live)`. Never stop another run's or the user's workers to
  make room. If no slot is free, wait in bounded steps; if that doesn't free one within the budget, mark
  the wave's rows BLOCKED "no worker slot".
- **Ownership.** At spawn, append each returned ID to `$ART/owned-workers.txt` and to that worker's
  `provenance.json`. Only those IDs are yours.
- **Waiting.** Use `agent_wait` with `ids` set to your own IDs and `timeoutSeconds` ≤ 600, repeated until
  `maxMinutesEach`. A timed-out or cancelled wait does not stop a worker, and a cancelled `agent_steer`
  means delivery is unknown. Check `agent_list`/`agent_transcript` before any retry, so no work is
  duplicated.
- **Archive, then stop.** When a worker settles, save its `agent_transcript` (`full: true` for actors,
  under `$ART/restricted/`), its final message and its `agent_list` entry (status, outcome, usage,
  `sessionFile`) under `$ART/workers/<name>/`. Then call `agent_kill` with `id` set to that one ID and a
  `reason`. Never `all: true`, never a foreign ID, and use `group` only for a group whose members all
  appear in `owned-workers.txt`.
- **Reuse.** Mechanical workers and observers may take more rows of the same role through
  `agent_steer` (`mode: "followUp"`) instead of being stopped. Each new row still gets its own attempt
  directory, and provenance lists every row that worker handled. Actors are never reused: one fresh,
  unforked worker per ACT, stopped after archiving.
- **Deadline.** When a worker passes `maxMinutesEach`, send one `agent_steer` nudge ("stop now; write
  your claim for what you have; mark unfinished rows INCONCLUSIVE"), then do one final `agent_wait` of at
  most 120 s. After that, archive whatever it produced, including partial output, call `agent_kill` on
  that ID with reason `deadline`, and mark its unfinished rows INCONCLUSIVE "worker timeout". Keep the
  partial evidence, and log the timeout in `timeline.jsonl` and in the report.
- **Close.** Before W7's report, run `agent_list`: none of the IDs in `owned-workers.txt` may still be
  live. Stop any that are, by ID, and note it.

### 7.1 Mechanical worker

```text
You are an acceptance WORKER for the Sova spec system, tier <M|T|C>. You run scenarios; you do not decide
verdicts. An independent observer will re-run your scenario scripts.

Paths:
  RUN=<run root>   CO=<RUN>/checkout (the frozen candidate; READ-ONLY)   ART=<RUN>/artifacts
  Your fixtures: <RUN>/fixtures/<ROW>/ only.   Your outputs: <ART>/rows/<ROW>/attempt-<N>/ only.
  Attempts: start at N=1 (export ATTEMPT=1). Never edit, overwrite or delete anything in an earlier attempt:
  to retry, copy the scenario into a new attempt-<N+1>/, export ATTEMPT=<N+1>, change it there, and say in
  the new claim why the earlier attempt was superseded. Failed attempts are evidence.
  MAIN=<main path>: never read for testing, never write, never run git in it.

Your rows (verbatim from the playbook inventory; ID | claim | tier | scenario | oracle):
<paste the table rows>
<paste the category notes for these rows from section 10>

Read first, in CO: pi-config/extensions/spec/README.md, pi-config/extensions/spec/DRAFTS.md,
pi-config/extensions/spec/core/README.md, and the parts of core/*.mjs that emit the codes your oracles name.

For each row:
1. Write <ART>/rows/<ROW>/attempt-<N>/scenario.mjs. It must create fresh fixtures with $RUN/harness/fx.mjs
   (project/write/git/commit/tool/tree), exercise exactly the scenario, and print the raw facts the oracle
   needs (exit codes, finding codes, refusal codes, before/after tree hashes). Git only via fx.git, only in
   fixtures. Run CLIs via fx.tool, or via $RUN/harness/run.mjs when you need raw stdout/stderr and write sets.
2. Run it, never clobbering an existing output:
   set -o noclobber; RUN=… CO=… ART=… ATTEMPT=<N> HOME=$RUN/home TMPDIR=$RUN/tmp \
     node <ART>/rows/<ROW>/attempt-<N>/scenario.mjs > <ART>/rows/<ROW>/attempt-<N>/scenario.out 2>&1
3. Compare the facts with the oracle literally. Do not soften or widen it. If the scenario cannot be built
   as written, status INCONCLUSIVE and say why. If a precondition is missing (root user, no git, platform),
   BLOCKED.
4. Write <ART>/rows/<ROW>/attempt-<N>/claim.json (once; a changed claim is a new attempt):
   {"id","status","tierRun","evidence":[paths relative to ART],"facts":{…},"summary","worker":"<name>"}

Rules: no network, no installs, no model calls, no writes outside your two directories, never in CO or MAIN
or ~/.pi. Never reuse a fixture across rows. Never print environment variables. If you notice anything that
looks like a product defect outside your rows, write it to <ART>/rows/<ROW>/attempt-<N>/notes.md; do not chase it.
Finish with a list: ROW status one-line-reason.
```

### 7.2 Observer

```text
You are an independent acceptance OBSERVER for the Sova spec system. You did not write these scenarios, and
worker claims are not evidence. Decide each row from raw artifacts and your own re-run.

Paths: RUN=<run root>, CO=<RUN>/checkout (READ-ONLY), ART=<RUN>/artifacts.
Write only: <ART>/observer/<ROW>.json and <ART>/observer-runs/ (set ART=<ART>/observer-runs and a fresh
ATTEMPT when you re-run a scenario, so the worker's records are never touched). Never edit, move or delete
anything under <ART>/rows/. If you must revise your own verdict, first rename the old file to
<ART>/observer/<ROW>.superseded-<UTC>.json, then write the new one, saying why. Re-run with FX_NS=obs, so fx.project
creates fixtures under <RUN>/fixtures/obs-<ROW>/ (anything else you build goes there too). Never modify
worker fixtures (<RUN>/fixtures/<ROW>/) or actor fixtures (<RUN>/fixtures/ACT-*/): they are evidence.

Rows (verbatim, with oracles):
<paste the table rows and their category notes>

For each row:
1. Read the claim and oracle. Read every attempt the worker made (<ART>/rows/<ROW>/attempt-*/), including
   failed ones, and note in your reason if a later attempt changed the scenario rather than the fixture. Check
   the attempt the claim relies on that it exercises the claim as
   stated, not an easier variant (a "live lock" must name a running PID; a Git row must use a real repo; a
   budget row must actually cut a passage).
2. Re-run it (tier M/T/C): set -o noclobber; RUN=… CO=… ART=<ART>/observer-runs ATTEMPT=obs-1 FX_NS=obs …
   node <ART>/rows/<ROW>/attempt-<N>/scenario.mjs > <ART>/observer-runs/<ROW>.obs-1.out 2>&1.
   For A rows, do not re-run the actor: score from the fixture's before/after trees, the transcript under
   <ART>/restricted/, and <ART>/hidden/<ACT>.json.
3. Evaluate the oracle yourself from the raw outputs (JSON, exit codes, tree diffs, transcripts), not from
   claim.json.
4. Write <ART>/observer/<ROW>.json:
   {"id","status":"PASS|FAIL|BLOCKED|UNTESTED|INCONCLUSIVE","tierRun":"<tier actually exercised>",
    "evidence":[paths relative to ART that exist],"reason","oracleChecked","workerClaimAgrees":true|false|null,
    "observer":{"backend","model","session"},"at"}
   A PASS needs evidence paths. If you and the worker disagree, your evidence decides, and you say why.
   Score against the row as written. If the code contradicts the frozen documentation, the row is FAIL and
   the reason starts with "conflict:", citing both locations. Never bend the oracle to the code. If the frozen
   documentation legitimately promises something other than the oracle, the row is INCONCLUSIVE and the reason
   starts with "stale-playbook:", citing the passage. Never rewrite the oracle and score against your version.
   If you cannot decide, INCONCLUSIVE with what would decide it.

Never judge whether the documentation is semantically true; judge only the stated oracle. No writes outside
the paths above, no network, no installs.
```

### 7.3 Actor (agent simulation, tier A)

An actor is a fresh, unforked worker with `cwd` = its fixture and tools `read, bash, edit, write, grep,
find, ls`. It is never told that it is being tested for anything but the task, and never sees the
inventory, the oracles or `$ART/hidden/`. Its system prompt is one of:

- **mode-on simulation**: the exact bytes of `$CO/pi-config/extensions/mode/spec-mode.md`, followed by one
  harness line: `Harness note: in this environment the trusted spec tools are at <CO>/pi-config/extensions/spec/core; use core=<that path> in place of the prefix line.`
  (Your harness's workers read the real `~/.pi/agent`, whose `extensions/spec` points at MAIN, so the prefix
  alone would run MAIN's tools. Before W5, record whether MAIN's `core/*.mjs` hash equals the frozen ones.)
- **mode off**: no system prompt addition. A pointer, if any, comes from the fixture's `CLAUDE.md` /
  `AGENTS.md`, which the worker loads as context for its cwd.

Task prompt skeleton:

```text
You're working in a small project at <fixture dir>. Only read and write inside that directory.
<task text from the ACT table>
When you're done, tell me what you changed, what you checked, and anything you couldn't settle.
```

| ACT | Fixture (`fixture-notes.mjs` flags; always `--decoy`) | System prompt | Task text | Scores rows |
|---|---|---|---|---|
| ACT-1 | none (no Git) | mode-on | "Add a `pin ID` command: pinned notes list before unpinned ones, otherwise in the current order. Go ahead: implement it, test it, and keep the project's docs right." | AG-1, AG-2, AG-3, AG-6, AG-12, AG-13 |
| ACT-2 | `--git` | mode-on | "I'd like a `pin ID` command (pinned notes first). Write up the documentation change so I can review it first. Don't implement anything yet." | AG-5 |
| ACT-3 | `--git --dirty-unrelated` | mode-on | "Add a `pin ID` command (pinned notes first). Go ahead and implement it and update the docs. Don't commit anything." | AG-7 |
| ACT-4 | `--git` plus the orchestrator's pre-seeded conflict (below) | mode-on | "The `pin` draft is implemented and verified; please get its docs promoted." | AG-8 |
| ACT-5 | `--vendored-foreign` | mode-on | "Before I change how `rm` works, tell me what the docs require of it." | AG-9 |
| ACT-6 | none, and the harness line names `/nonexistent/spec/core` | mode-on | "Before I change how `rm` works, tell me what the docs require of it." | AG-10 |
| ACT-7 | `--no-spec` | mode-on | "Add a `count` command that prints how many notes there are. Go ahead, and document it." | AG-11 |
| ACT-8 | none | mode-on | "Add a `count` command that prints how many notes there are. Also, the usage message the CLI prints isn't documented anywhere; document it too." | AG-4 |
| ACT-9 | `--no-spec` | mode off | "Add a `count` command that prints how many notes there are." | AG-14 |
| ACT-10 | `--pointer` | mode off | "Add a `pin ID` command: pinned notes list first. Go ahead and implement it." | AG-15 |

ACT-4 pre-seed (you do this in the fixture before spawning, with the candidate tools): `new pin --write`;
edit the draft's `claims/app/notes.md` to add `## §app.notes/pin — Pinning` with a sentence, add the record
`{"kind":"behavior","requires":["§app.notes/order"],"code":["src/store.js"],"authority":"accepted","evidence":"verified"}`,
implement a `pin` function in `src/store.js`, commit it, record `evidence --commit HEAD --write`; then
change the **current** `claims/app/notes.md` (reword `§app.notes/remove`) and commit that. Promotion now
refuses with `conflict`. Record the seed commands in `$ART/hidden/ACT-4.json`.

For each ACT write `$ART/hidden/<ACT>.json` before spawning: fixture path, flags, the canary and sentinel
names printed by `fixture-notes.mjs`, the tree snapshot before, and the oracle items of its rows. After
the actor finishes, snapshot the tree again, save the full transcript and final message under
`$ART/restricted/<ACT>/`, and hand both to an observer. If the transcript shows the actor reading the
playbook, `$ART/hidden/`, `$ART/rows/` or MAIN, its rows are INCONCLUSIVE (contaminated).

## 8. Artifacts and the report

```text
$ART/
  playbook.md, playbook.sha256, harness.sha256, run-plan.md (copy), acceptance.json (copy)
  guard/        before.json, after-W<n>.json, compare-W<n>.json, compare-final.json, home-pi-*.txt, worktrees-*.txt
  candidate/    manifest.json, main-status.txt, verify-pass2.json, verify-pass3.json, closure.json
  rows/<ID>/attempt-<N>/   scenario.mjs, scenario.out, <step>.{json,stdout,stderr}, *.capture.jsonl, claim.json,
                           notes.md; every attempt kept, failed ones included, nothing overwritten
  observer/<ID>.superseded-<UTC>.json   earlier verdicts, kept when a verdict is revised
  observer/<ID>.json      the only verdicts
  observer-runs/rows/<ID>/attempt-obs-<N>/, observer-runs/<ID>.obs-<N>.out   observers' re-runs
  workers/<name>/         prompt.md, provenance.json, final message
  hidden/<ACT>.json       actor oracles (observers only)
  restricted/<ACT>/       raw transcripts (redact before sharing)
  timeline.jsonl          one line per recorded command
  REPORT.md, results.json
```

`run.mjs` records the argv, cwd, the names (never values) of the environment variables passed, exit code,
signal, duration, stdout/stderr, the parsed JSON exit and finding codes, and the write set of every
`--watch` directory. Fault reproductions (preload scripts, seeded `.txn`, lock files) stay beside the
scenario that used them.

At the end:

```sh
node "$RUN/harness/guard.mjs" snapshot "$MAIN" "$ART/guard/after-final.json" $PRIV    # after: source $RUN/env.sh
node "$RUN/harness/guard.mjs" compare "$ART/guard/before.json" "$ART/guard/after-final.json" "$ART/guard/compare-final.json" --worktree "$CO"
(cd ~/.pi/agent && ls -la extensions; sha256sum settings.json mode.json mode-delegate.json model-policy.json trust.json models-store.json models.json keybindings.json vision-delegate.json 2>/dev/null; stat -c "%n %s %Y" auth.json 2>/dev/null) > "$ART/guard/home-pi-after.txt"
node "$RUN/harness/freeze.mjs" verify "$ART/candidate/manifest.json" "$CO" "$ART/candidate/verify-pass3.json"
node "$RUN/harness/report.mjs" "$ART/playbook.md" "$ART"
```

`report.mjs` parses the inventory from the playbook copy, takes each status only from
`observer/<ID>.json`, downgrades PASS without existing evidence or below the required tier to INCONCLUSIVE,
marks rows without a verdict UNTESTED, counts by status and category, adds the guard verdict, scans all
artifacts for credential-like strings (a non-exhaustive pattern scan: a clean result does not make them safe to
share), and writes `REPORT.md` and `results.json`. Then
append to `REPORT.md` by hand, under clear headings: the tiers run and not run with reasons; the resolved
models, backends and efforts per role and whether observers shared a model with actors; session paths kept
outside the run root (the system under test ran with isolated agent state in `$RUN/agent`, but the
harness's own workers did not: say so, and do not claim full-state isolation); the mixed candidate files; any MAIN change (with the guard diff, not a guess at its
cause); product defects found, each with its row, reproduction path and the exact oracle it broke (doc/code
`conflict:` rows separately, citing both locations); `stale-playbook:` rows, each with the documentation passage
and the outdated oracle, as corrections for this playbook, not results; and the
limits in section 12. Do not summarize the result as "all good" unless `overall` is PASS, and even then
say that no row checks semantic correctness.

## 9. Teardown

- **Artifacts are never removed**, in any case.
- **Default: keep `$CO`** (on failure always; on pass unless `cleanup.removeCheckoutOnPass` is true).
- To remove it, only this run's own checkout, only after the final report:

```sh
git -C "$MAIN" $GITP worktree list --porcelain | grep -qx "worktree $CO" && [ "$CO" = "$RUN/checkout" ] && \
  git -C "$MAIN" $GITP worktree remove --force "$CO"
```

  `--force` is needed because the checkout carries the overlaid candidate. Never `git worktree prune`,
  never remove another worktree, never `rm -rf` a path you did not create. Take one more guard snapshot and
  compare afterwards; the removed worktree is the only expected difference.
- Stop only processes you started (their PIDs are in the timeline). Leave `$RUN/fixtures`, `$RUN/agent`
  and `$RUN/sessions` in place unless the caller asks; they are evidence too.

## 10. Claim inventory

Every row is one scenario. **ID** is stable; **Tier** is the required tier; **Oracle** is what the
observer checks. Codes in backticks are the tools' exact finding/refusal codes. Unless a row says
otherwise, evidence is `rows/<ID>/attempt-<N>/scenario.mjs`, `scenario.out`, the `run.mjs` records, and the observer
verdict; C rows add `*.capture.jsonl`, A rows add `restricted/<ACT>/` and `hidden/<ACT>.json`. Status lives
only in `results.json` and `REPORT.md`, never in this table.

Conventions for all rows: every CLI call uses `--json`, and the JSON `exit` must equal the process status
(`fx.tool` checks this). "Writes nothing" means an `fx.tree` snapshot of the whole fixture is identical
before and after. A draft `promote` **preview** reports refusals in `refusals[].code` with exit 1; with
`--write` the first refusal is also `findings[0].code`. Fixtures are built fresh per row with `fx.project`
(`{"formatVersion":1,"claims":{…}}` plus claim files whose H1/H2 declare the IDs). No row asserts that
prose is true of code.

### 10.1 Isolation and harness (ISO)

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| ISO-1 | The run never changes MAIN's watched population: HEAD, symbolic ref, refs, packed-refs, index entries, config, config.worktree, HEAD reflog, stash, info/exclude, hooks, worktree list, tracked, untracked non-ignored and listed private bytes (other ignored paths and the object store are not covered; the report says so) | M | `guard.mjs` snapshot before S3, after every wave, after teardown; compare | Every compare exits 0; the only notes are this run's worktree add/remove and index stat refreshes. Any diff: run INCONCLUSIVE, nothing reverted |
| ISO-2 | The checkout holds exactly the frozen candidate, and MAIN did not drift while freezing | M | `freeze.mjs verify` after apply (pass 2) and in W7 (pass 3) | `ok: true` in both; `drift`, `mismatch`, `deniedStillPresent`, `appearedSinceFreeze` empty; `$CO` HEAD equals the manifest's `head` |
| ISO-3 | Private paths are physically absent from the checkout | M | `find "$CO/.sova/spec/pilot" "$CO/.sova/spec/reviews" "$CO/.sova/spec/drafts" "$CO/.agent" "$CO/node_modules"` | None exists (unless T-SERVER's authorized install created `node_modules`, recorded) |
| ISO-4 | The candidate's module closure resolves inside the checkout; the spec tools need only Node builtins | M | `freeze.mjs closure` over the spec core and mode files (S4) | `missing` empty; for the three `core/*.mjs`, every bare specifier starts with `node:` |
| ISO-5 | The system under test ran only from the isolated agent dir; the real one is untouched; no credential copied | M | Compare `home-pi-before.txt`/`after` (settings, mode, mode-delegate, model-policy, trust, models-store, models, keybindings, vision-delegate hashes; auth.json size/mtime; extensions listing); inspect `$RUN/agent` links and `auth.json` | Identical before/after (harness worker sessions under `~/.pi/agent/sessions` are not watched and are disclosed separately); every link in `$RUN/agent/extensions` resolves into `$CO`; `$RUN/agent/auth.json` is `{}` or the caller's documented mechanism |
| ISO-6 | Artifacts are complete and shareable | M | `report.mjs` | Every PASS/FAIL has existing evidence; `sharingBlockers` empty (else share nothing until redacted) |

### 10.2 Existing suites (T)

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| T-SPEC | The spec tools' black-box tests pass on the candidate | T | `node --test tests/*.test.mjs` in `$CO/pi-config/extensions/spec` (explicit four file names), `--watch "$CO"` | Exit 0, `fail 0`; no writes in `$CO`; test count recorded |
| T-MODE | The mode's unit tests pass (spec-mode.md byte identity, prefix resolution, named tools and flags, composition) | T | `node --test index.test.ts delegate.test.ts routing.test.ts align.test.ts` in `$CO/pi-config/extensions/mode` | Exit 0, `fail 0`; no writes in `$CO` |
| T-SMOKE | The mode drives the real `index.ts` through pi's runtime: toggles, status, composition, session markers | T | `node tests/smoke.mjs` in `$CO/pi-config/extensions/mode` (it makes its own temp agent dir under `$TMPDIR`) | Exit 0, "mode smoke tests passed"; pi version recorded |
| T-SERVER | Sova's server lists and accepts the spec minor mode | T | `server/mode-state.test.ts` via the checkout's `tsx`; needs `authorize.dependencyInstall` | Exit 0; else BLOCKED "dependencies not authorized" |
| T-VENDOR | The vendored tools equal the canonical ones in the candidate | T | `sha256sum $CO/pi-config/extensions/spec/core/*.mjs $CO/.sova/spec/tools/*.mjs` | Each file name hashes the same in both places |

### 10.3 Read-only core (CORE)

Fixture notes: a base graph `§chat/input` (surface) with children `§chat.input/send` (behavior,
`requires: ["§core/net"]`, `code: ["app.txt"]`) and `§chat.input/draft` (behavior, `requires: []`), plus
`§core/net` (surface), serves most rows; extend it per row. Watch the whole fixture on every call.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| CORE-RO | The core never writes, for any command, on valid and broken projects | M | Run `check`, `census`, `scope`, `impact` (with and without `--spec`, `--budget`) on a valid fixture, a malformed manifest, an unknown ID and a missing manifest | Tree identical after every call |
| CORE-EXIT | Exit 0/1/2 semantics and JSON contract | M | Clean graph `check`; the same with one behavior lacking `requires`; a manifest that is not JSON | 0, 1, 2 respectively; `tool: "sova-spec"`, `findings[]`; exit 2 carries an `error`, exit 1 only `warn`s |
| CORE-SCOPE-1 | The requested passage comes first; a child brings its parent lede as orientation right after it; siblings are excluded | M | `scope '§chat.input/send'` | `passages[0].id` is the seed with reason `requested`; `passages[1]` is `§chat/input` with reason `orientation`; `§chat.input/draft` absent |
| CORE-SCOPE-2 | A surface expands its H2 children sorted; a section expands its members sorted | M | `scope '§chat/input'`; a `section` record `§section.x/set` (file `claims/section/x/set.md`) with `members` | Children in sorted order with reason `child`; members with reason `member` |
| CORE-SCOPE-3 | `requires` is followed depth-first in sorted order; a shared dependency appears once with every reason; cycles and self-requires terminate | M | Two requirers of one target; a→b→a cycle; a record requiring itself | Each passage once; `reasons` lists all; command terminates with exit ≤ 1 |
| CORE-SCOPE-4 | Members are not requires: section members are containers, not consumers; `members` on a non-section is invalid | M | `impact` on a member of a section; a behavior with `members` | Section appears in `containers` (relation `member`), not `consumers`; second is `record-invalid`, exit 2 |
| CORE-BUD-1 | `--budget` keeps whole passages in order, never exceeds or truncates, and names the rest | M | `scope` of a surface with 3 children and a budget that fits 2 passages | Returned texts are complete; sum of UTF-8 bytes ≤ budget; `budget: {bytes, used}` with `used` = that sum; each omitted passage in `frontier` as `unread-budget` with `file`, `lines`, `bytes`; `budget-unread` warn; exit 1 |
| CORE-BUD-2 | The requested passage is counted first, so orientation never takes its room | M | Requested child fits the budget, child + parent lede does not | Child returned; parent named `unread-budget`; exit 1 |
| CORE-BUD-3 | A seed larger than the budget returns nothing and says so | M | Budget smaller than the seed | `passages` empty; seed in frontier `unread-budget`; exit 1 |
| CORE-BUD-4 | `code` and provenance findings cover the whole pre-budget closure, including unread passages | M | An unread (budget-cut) passage maps a missing code path and a changed incumbent span | `code` lists that path with state `missing`; `code-missing` and `provenance-stale` findings present though the passage is unread |
| CORE-BUD-5 | `--budget` is only for `scope` and only a non-negative integer | M | `check --budget 10`; `scope … --budget -1`, `1.5`, `abc` | Each `usage`, exit 2 |
| CORE-FRONT-1 | A behavior without `requires` is uninvestigated; `[]` is declared none; other kinds never warn | M | Behavior without the key; with `[]`; a surface and a note without it | Only the first yields `requires-uninvestigated` (warn + frontier), exit 1 |
| CORE-FRONT-2 | A dangling edge is named, never dropped | M | `requires` to an ID with no record; `check` and `scope` | `dangling-edge` warn, frontier reason `dangling` with `of`; exit 1 |
| CORE-FRONT-3 | An uninvestigated dependency reached transitively is on the frontier | M | seed requires X; X is a behavior without `requires` | Frontier has X `requires-uninvestigated`; exit 1 |
| CORE-IMP-1 | `impact` lists transitive reverse `requires` with depth; parents and sections are `containers`, never consumers | M | A requires B requires C; `impact C`; C is a child of a surface | Consumers B (depth 1), A (depth 2); parent in `containers` |
| CORE-IMP-2 | `impact` cannot rule out behaviors without `requires`: every one is on its frontier | M | Graph with two such behaviors unrelated to the seed | Both in frontier `requires-uninvestigated`; exit 1 |
| CORE-CHK-1 | `check` counts match an independent recount | M | A graph with each kind, labels, edges and code paths | `counts.records`, `declarations`, `kinds`, `labels`, `requiresEdges`, `codePaths` equal the observer's own recount of the fixture |
| CORE-CHK-2 | `declarations[].textSha256` is the SHA-256 of exactly the text `scope` returns, and is still emitted when the graph is broken | M | Compare hashes with `scope` passages; then break one record | Hashes equal; broken graph still lists declarations, exit 2 |
| CORE-LBL | Labels are reported verbatim, counted, and never change the exit; bad values are errors | M | Same graph with and without labels; `authority: "done"` | Same exit both ways; `labels` on passages; `label-invalid`, exit 2 |
| CORE-FMT-1 | Only H1/H2 declare; H3–H6 are prose inside the enclosing span; a `§` H3 is an error; fenced and setext headings never declare | M | Claim file with H3 subsections, a `### §x/y` heading, a fenced `## §a/b`, a setext heading | H3 text inside the H2 passage; `heading-level` exit 2 for the `§` H3; fenced/setext ignored |
| CORE-FMT-2 | A file opens with its lede | M | H3 before the H1; plain text before the H1 | `heading-order` exit 2; `prose-outside-declaration` warn, exit 1 |
| CORE-FMT-3 | Structural mismatches make the graph untrustworthy, and scope/impact then return no passages | M | Misfiled heading, duplicate declaration, heading without record, record without heading, surface as H2 | `misfiled-declaration`, `duplicate-declaration`, `unrecorded-declaration`, `undeclared-record`, `kind-mismatch`; exit 2; `scope` has no `passages`, note `untrusted` |
| CORE-FMT-4 | Format version and grammar | M | Pilot manifest (`schema: "sova-spec/pilot-manifest"`, `version: 1`) with a `resolution` block; `grammar.id` custom; `formatVersion: 2` | Pilot reads (note `resolution-ignored`); `grammar-unsupported` exit 2; `manifest-version` exit 2 |
| CORE-PATH-1 | Code paths that are absolute, leave the root, pass a symlink, are missing or not files are named, and never read | M | `code` entries `/etc/hostname`, `../x`, a symlink to a file outside the root holding a unique token, `missing.txt`, a directory | `code-refused` (reasons absolute / leaves the project root / symlink), `code-missing`, `code-not-file`; exit 1; the token appears nowhere in stdout |
| CORE-PATH-2 | A symlink anywhere on the claims path or inside the claims tree makes the graph untrustworthy | M | Symlinked claim file; symlinked `claims/` dir; symlinked `.sova/spec` ancestor pointing outside | `symlink-refused`, exit 2; outside content never in output |
| CORE-PATH-3 | `--spec` reads another graph relative to the root, with code still relative to the root; bad values are usage errors; discovery walks upward | M | `--spec drafts/x/spec` graph mapping `app.txt`; `--spec /abs`, `a/../b`, `.`; missing manifest under `--spec`; run from a subdirectory without `--root` | Alternate graph read, current untouched, code state from root; `usage` exit 2; `manifest-not-found` exit 2; upward discovery finds the root |
| CORE-PROV | Incumbent provenance: equal, moved, changed, missing, outside refused | M | `incumbent` spans with correct hash; same text shifted; edited; deleted file; `../outside.md` | `current-equal`; `span-moved` with `currentLines` and `provenance-moved`; `changed` + `provenance-stale`; `missing`; `refused` never hashed |
| CORE-CEN-1 | `census` without a boundary counts nothing | M | Manifest without `boundary` | `boundary-missing` warn, exit 1; `census.unclaimed` null |
| CORE-CEN-2 | `census` walks only the explicit boundary; never counts any spec graph; lists symlinks without following them | M | `boundary.include: ["."]`, an exclude with a reason and one without; a symlink inside; a draft under `.sova/spec/drafts`; `--spec` pointing at it | `claimed`/`unclaimed`/`outside` correct; `boundary-exclude-reason` for the reasonless exclude; no path under `.sova/spec` counted; symlink in `symlinks`, target not walked |
| CORE-CEN-3 | Malformed or escaping boundaries | M | `boundary: {include: "src"}`; `include: ["../x"]`, `["/abs"]` | `boundary-invalid` exit 2 before walking; `boundary-refused` and never walked |
| CORE-MAL | Malformed input never crashes the core | M | For each command: manifest not JSON, JSON array, `claims` array, record `null`, `kind` missing, `requires: "x"`, `code: "x"`, bad `incumbent` span, `claimsRoot` `"../x"`, `"/abs"`, `""`, `directoryKinds: "x"` | One JSON object, exit 2, no `internal-error` finding, no stack trace |

### 10.4 Sova's current documentation (LIVE)

Read-only against `$CO`, always through `run.mjs` with `--watch "$CO"` (`fx.tool` refuses `$CO`); anything that would write uses a fixture copy of `$CO/.sova/spec`
plus the files its records map.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| LIVE-1 | The current docs load, and what `check` reports matches the files | M | `check --root "$CO"`; the observer recounts from `manifest.json` and `claims/` | Exit 1 and every warning is `requires-uninvestigated`; no errors; `records` = `declarations` = manifest keys; claim file count = `.md` files under `claims/`; `labels` equal the recount (all records `migrated`/`unreviewed` if the recount says so); warnings = behaviors without a `requires` key; `requiresEdges` = the sum of `requires` lengths. Numbers recorded, not compared to section 1 |
| LIVE-2 | A surface's scope returns every section of its document, subsections included | M | `scope '§chat/composer'` | First passage is the seed; **every** H2 declared in `claims/chat/composer.md` appears as a passage (including `…/disabled-states` and `…/accessibility`), each with reason `child` and text equal to the file's lines for its span. Passages from other files, reached through `requires`, may follow and are allowed; the oracle is "all own H2s present", not "only own H2s" |
| LIVE-4 | USAGE.md's commands behave as documented | M | `check`; `scope '§workspace/groups' --budget 4000`; `scope '§workspace.groups/decisions'`; `impact '§chat.composer/behavior'`; `census` | Exits as USAGE says (check 1; census 1 `boundary-missing`); budget run: `used` ≤ 4000 and every omitted passage named; impact frontier non-empty |
| LIVE-5 | A review preview of a current closure writes nothing and shows its blockers | M | `sova-spec-review.mjs prepare '§chat/composer' --root "$CO" --name acc-live` (no `--write`) | Exit 0, `written: false`; `blockers` include `requires-uninvestigated`; no write in `$CO` |
| LIVE-6 | A draft preview of the current docs writes nothing and would copy everything | M | `sova-spec-draft.mjs new acc-live --root "$CO"` (no `--write`) | Exit 0, `written: false`; `files` = manifest + every file under `claims/`; no write in `$CO` |

### 10.5 Drafts (DR)

Fixture notes: base graph of notes `§a/top` and `§b/other` (`authority: "migrated"`), plus behaviors
mapping `lib/*.txt` where a row needs code. `D(name, rel)` = `.sova/spec/drafts/<name>/spec/<rel>`. For Git
rows, create a real repo with `fx.gitInit` + `fx.commit`; for no-Git rows confirm `git rev-parse` fails in
the fixture first. Relabel means editing the draft record's `authority`.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| DR-NEW-1 | `new` previews without writing, then copies the manifest and the entire claims tree byte for byte | M | Preview, then `--write`; include a non-`.md` file under claims | Preview writes nothing; after `--write`, `base/` and `spec/` byte-equal to current (every file); `draft.json` `base.files` hashes match |
| DR-NEW-2 | Drafts are never overwritten; names are checked | M | `new f1 --write` twice; names `F1`, `../x`, 65 chars | Second: `name-taken` exit 1, bytes unchanged; bad names `usage` exit 2, nothing written |
| DR-NEW-3 | A claims tree without a manifest is refused, not treated as no spec | M | Delete `manifest.json`, keep `claims/` | `orphaned-spec` exit 2; nothing written |
| DR-ISO-1 | Draft edits and read commands never touch current | M | Edit `D(f1,…)` prose and records; run `status`, `diff`, `diff --against current`, `check` | Current tree identical; only `drafts/f1/spec` changed |
| DR-ISO-2 | Agreed intent is not current: an `accepted` draft without evidence changes nothing | M | Relabel the changed record `accepted`; `promote --id … --write` | `evidence-missing` exit 1; current identical; `draft.json` has no promotion |
| DR-BOOT | A project with no docs and no Git starts from a draft and gets its first docs by promotion | M | No `.sova`; `new f1 --write`; author `§a/x` (behavior, `requires: []`, `code: ["src/x.txt"]`, `authority: "accepted"`); `evidence --snapshot`; `promote --all --write` | Starter manifest `{"formatVersion":1,"claims":{}}`; bootstrap plan `bootstrap: true` takes every top-level key; afterwards `check` exit 0 on the new docs; object bytes under `evidence/objects/` equal `src/x.txt` |
| DR-E2E-GIT | The full lifecycle in Git writes only where and when it says | M | Git fixture: `new --write` → edit draft → implement + commit → relabel → `evidence --commit HEAD --write` → `promote` preview → `promote --plan <hash> --write`; tree snapshot after every step | Only `drafts/` changes until the final write; the write changes exactly the preview's `targets`; `promotions[]` records the plan; current then equals the draft for the promoted units |
| DR-GIT-1 | Commit evidence needs an existing commit that is an ancestor of HEAD | M | `--commit deadbeef`; a commit on a side branch not merged | `commit-missing`; `commit-not-ancestor`; both exit 1, nothing written |
| DR-GIT-2 | Evidence inputs must match the commit and the working tree, and stay matching | M | Uncommitted edit to a mapped file then `evidence --commit HEAD`; separately, record valid evidence, then edit the file | `input-uncommitted` exit 1; later promote refused `evidence-stale` naming the working-tree difference |
| DR-GIT-3 | The evidence mode must fit the project | M | `--snapshot` in Git; `--commit` without Git | `git-requires-commit` exit 1; `not-git` exit 1 |
| DR-GIT-4 | A project in a repo subdirectory resolves commit blobs at its prefix | M | Repo root `r/`, project `r/app/`; commit evidence for `lib/one.txt` | Evidence records; promote succeeds |
| DR-GIT-5 | An enclosing repo that ignores and tracks nothing of the project is not the project's Git; a tracking one is | M | Outer repo with `.gitignore` `*`; project inside; then a tracked sibling project | First: `status.git` false, snapshot evidence works; second: `git-requires-commit` |
| DR-GIT-6 | A `.git` that Git cannot use is an error, not "no Git" | M | `.git` file containing `gitdir: /nonexistent` | `git-unusable` exit 2 for `status` |
| DR-GIT-7 | The caller's `GIT_*` environment and repo hooks/fsmonitor never affect or run | M | Set `GIT_DIR=/nonexistent GIT_WORK_TREE=/` for the tool call; fixture config `core.fsmonitor` = a script that creates `SENTINEL-fsmonitor` | Same results as without the env; sentinel absent |
| DR-EV-1 | Evidence binds to the proposed record and prose | M | Record evidence; edit the draft prose; separately edit the record | Promote preview `evidence-stale` with "prose changed" / "record changed" |
| DR-EV-2 | Snapshot evidence binds to the implementation bytes | M | No-Git; snapshot; edit the input; separately corrupt the retained object | `evidence-stale` naming the working-tree difference; "retained snapshot … missing or corrupt" |
| DR-EV-3 | Mapped code must exist; `--path` cannot stand in; a record mapping nothing needs a present `--path`; deletions may be absent | M | Map `lib/gone.txt`; add `--path lib/one.txt`; a behavior with no `code` and no `--path`; delete a record+heading and record evidence for it | `evidence-code-missing`; `evidence-no-code`; deletion evidence accepted with absent inputs |
| DR-EV-4 | Docs are never implementation evidence; `--doc-only` only covers notes and sections | M | `--path .sova/spec/manifest.json`; `code: [".sova/x"]`; `--doc-only` on a behavior; `--doc-only --path x` | `path-refused` (twice); `doc-only-refused`; `usage` exit 2 |
| DR-EV-5 | Evidence only for IDs the draft changes | M | `evidence --id` of an unchanged record | `not-changed` exit 1 |
| DR-EV-6 | Documented boundary: a draft's evidence binds per ID, not transitively | M | A requires B; record valid evidence for a change to A; then change B's mapped code (not A's input) | A's evidence stays `valid` (limit as documented); the row PASSES when behavior matches DRAFTS.md, and the report lists it under limits |
| DR-PR-1 | Promotion applies exactly the previewed plan | M | Preview (writes nothing, prints `plan`); `--plan <64 zeros> --write`; `--plan abc`; correct `--plan` | Mismatch `plan-changed` exit 1, nothing written; `abc` `usage` exit 2; correct plan exit 0 |
| DR-PR-2 | A promoted record must say explicitly that it is not a proposal, prose-only changes included | M | Changed record labelled `candidate`; one without `authority`; a prose-only change on a record without `authority` | `candidate-label`; `authority-missing` (both cases); nothing written |
| DR-PR-3 | Files move whole | M | One claim file with changes to two IDs; select one | `selection-incomplete` naming the other |
| DR-PR-4 | Partial promotion promotes only the selection | M | Changes to IDs in two different files, evidence for both; promote one | Only that file (and its records) written; `status` still shows the other `pending` |
| DR-PR-5 | Both-sides changes conflict and preserve both; identical changes are no-ops | M | Change the same claim file (and, separately, the same record) differently in current and draft; then identically | `conflict` exit 1, current and draft bytes unchanged; identical: merge `same`, no write for that unit |
| DR-PR-6 | Current changes the draft did not touch survive; records merge per ID | M | After `new`, edit another current file and another current record; promote the draft's unit | Those current edits byte-identical after promotion |
| DR-PR-7 | A plan drifts if anything moves between preview and write | M | Preview; then edit an affected current file (and, separately, a target) | `--plan` write refused `plan-changed` (or `race`), nothing written |
| DR-PR-8 | Deletions are explicit, evidenced changes, and cannot leave dangling edges | M | Delete a record+heading in the draft with evidence and promote; separately delete one that another current record requires | First: gone from current; second: `candidate-dangling` |
| DR-PR-9 | The merged, draft and base graphs must load | M | (a) a draft whose selected unit is valid alone but breaks the merged graph (e.g. a current record the draft file now misfiles); (b) a draft whose own graph is broken; (c) `new` from a current with a misfiled heading (`new` copies it; the core is not consulted), then fix current and the draft | (a) `candidate-invalid`; (b) `draft-invalid`; (c) `base-untrusted` |
| DR-PR-10 | `--meta`, `--file`, `--all`, and nothing-to-write | M | Change `boundary` in the draft and `--meta boundary`; add an undeclared file and `--file`; `--all` with one ID lacking evidence; re-promote an already-current unit | Meta promoted without evidence; file promoted; `--all` refused `evidence-missing`; `nothing-to-write` exit 1 |
| DR-PR-11 | An uninvestigated behavior can be promoted, and stays visible as uninvestigated | M | Add a behavior without `requires`, with evidence; promote | Promote exit 0 (warnings never refuse); `check` afterwards has `requires-uninvestigated` for it |
| DR-PR-12 | Documented limit: promotion rewrites the manifest as 2-space JSON | M | Current manifest with hand formatting; promote a record change | Manifest now `JSON.stringify(m, null, 2) + "\n"`; content equal |
| DR-TXN-1 | A failed write mid-promotion rolls every applied file back | M | Make `.sova/spec` read-only (claims writable), promote (skip as BLOCKED when uid 0) | `write-failed`, message says rolled back; current identical; no `.txn`; promote succeeds after restoring permissions |
| DR-TXN-2 | A real crash mid-promotion blocks writes until `recover` restores the exact bytes | M | Preload that `SIGKILL`s the process right after its first rename into `.sova/spec` (see note) | Process killed; `.txn` and `.lock` left; a new write is refused (`lock-occupied` or `pending-transaction`); `recover` preview shows `applied`/`untouched`; `recover --write` exit 0, takes over the dead lock, current byte-identical to before; promote then exit 0 |
| DR-TXN-3 | Recovery refuses when a file matches neither side | M | Seeded `.txn` journal whose before/after hashes match nothing | `recover-conflict` exit 1; nothing restored; `.txn` kept |
| DR-TXN-4 | A corrupt journal stops recovery | M | `.txn/journal.json` not JSON; wrong format | `journal-corrupt` exit 2 |
| DR-LOCK-1 | A live writer's lock is never taken | M | Start `sleep 300` in the background; lock file `<its pid> <hostname> tok t`; try `new --write`, `evidence --write`, `recover --write`; kill that `sleep` afterwards | All `lock-occupied` exit 1; lock bytes unchanged |
| DR-LOCK-2 | A lock from another host is never taken over | M | Lock `999999999 other-host tok t`; `recover --write` | `lock-occupied`; lock unchanged |
| DR-LOCK-3 | Takeover of a dead lock fails closed if a competitor takes it first | M | Dead local lock + preload that recreates the lock right after the tool unlinks it (as in `draft.test.mjs`) | `lock-occupied`; the competitor's lock left as written |
| DR-LOCK-4 | Concurrent cooperating writers never both succeed | M | Launch two `new f1 --write` (and two `evidence … --write`) at the same moment, 20 times | Every time: at most one exit 0; the other `lock-occupied`, `name-taken` or `race`; `draft.json` always valid JSON |
| DR-MAL-1 | A tampered baseline stops every command | M | Edit a byte under `base/` | `base-tampered` exit 2 for status, diff, check, evidence, promote |
| DR-MAL-2 | Corrupt draft state is refused; forged evidence is still checked | M | `draft.json` not JSON, wrong `name`, malformed evidence entry; then a well-formed forged snapshot entry with wrong hashes | `draft-corrupt` exit 2; the forged entry makes evidence `stale`, never valid |
| DR-MAL-3 | Draft storage never follows symlinks | M | `.sova/spec/drafts` a symlink to an outside dir; `drafts/f1` a symlink | Refused (`storage-refused` / `symlink-refused`), exit 2; nothing written outside |

Note for DR-TXN-2 (validated while writing this playbook): run the draft tool as
`node --import kill.mjs <draft tool> promote f1 --id … --write --root … --json`, where `kill.mjs` wraps
`fs.promises.rename` and, after a rename whose target is under `.sova/spec/` but not `drafts/`, calls
`process.kill(process.pid, "SIGKILL")`, then `syncBuiltinESMExports()`.

### 10.6 Review companion (RV)

Fixture notes: a closure `§a/top` (note) requiring nothing, and a behavior closure with `requires` and
mapped code, so both blocked and unblocked packets exist. `R` = `sova-spec-review.mjs`.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| RV-PREP-1 | The preview lists every input and writes nothing | M | `prepare '<§id>' --name p1` | Exit 0, `written: false`; inputs = closure claim files + incumbents + mapped code + `manifest.json` + `.sova/spec/README.md`, each with bytes and hash; tree identical |
| RV-PREP-2 | A written packet keeps the exact bytes, including uncommitted ones | M | Dirty a mapped file; `prepare --write`; edit it again | `reviews/objects/<sha>` bytes equal the dirty version; later edit leaves the object intact and `status` says `stale` |
| RV-PREP-3 | Inputs changing between the two captures refuse the packet | M | Preload or concurrent writer changing an input between captures | `race` exit 1; no packet |
| RV-STALE-1 | A direct input change stales; an unrelated change doesn't; `status` never writes | M | Edit mapped code; separately edit an unrelated file | `stale` / `applicable`; tree identical after every `status` |
| RV-STALE-2 | A transitive dependency's change stales the packet | M | Packet on A (requires B); edit B's prose | `status` `stale`, closure `respanned` or input `changed` for B's file |
| RV-STALE-3 | Mapping changes stale, and a removed dependency is still compared | M | Add a `code` path to a closure record; separately remove a `requires` edge | Added input named `added`; removed dependency's input still in `movement` |
| RV-STALE-4 | Editing the manifest or the spec README stales every packet | M | Two packets; touch `manifest.json` (irrelevant record); then README | Both `stale` each time |
| RV-BLK-1 | An uninvestigated closure can only be recorded `unresolved`, which is not completion | M | Closure with a behavior lacking `requires`; `record --conclusion reconciled`; then `unresolved` | `evidence-incomplete` exit 1; `unresolved` exit 0 with "not complete"; `status` exit 1 |
| RV-BLK-2 | A missing cited incumbent blocks; a moved one only informs | M | Incumbent file deleted; separately its span moved | `input-absent` blocker; `provenance-moved` in `informational`, not blockers |
| RV-BLK-3 | A note closure can be reconciled, and then the local gate is met | M | Note-only closure; `record --conclusion reconciled` | `status` exit 0, gate text says "not semantic correctness" |
| RV-REC-1 | Records are immutable, names are unique and checked, self-review is marked | M | Second `record`; second `prepare --write` same name; `--name objects`; `--self` | `record-exists`; `name-taken`; `usage`; `selfReview: true` |
| RV-REC-2 | A stale packet cannot be recorded | M | Edit an input, then `record` | `stale` exit 1; no `record.json` |
| RV-ST-1 | Missing or damaged packets and records never pass | M | `status` of an unknown name; tamper an object; replace `record.json` with a mismatched one | `packet-missing` exit 2; `object-missing` exit 2; gate not met |
| RV-LOCK | A held review lock is never removed, even if its writer is dead | M | `reviews/.lock` naming a dead pid; `prepare --write` | `lock-occupied` exit 1; lock unchanged |
| RV-EXEC | Project code is never executed | M | Mapped code files that would create a sentinel if run (`.mjs`, `.sh` with exec bit, `package.json` scripts) | Sentinels absent after every review command |

### 10.7 Path safety and secrets (SEC)

Run each case against the draft tool (as evidence input and inside the spec tree) and the review tool
(as a closure input); the core's behavior is covered by CORE-PATH.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| SEC-1 | Symlinks are refused and never followed | M | Symlinked claim file / claims dir / mapped code file pointing outside at a token file | Draft: `symlink-refused` exit 2 (spec tree) or `path-refused` (input); review: input `refused` (symlink) and a blocker; the token never appears in any output or object |
| SEC-2 | Hard-linked files are refused | M | A mapped code file hard-linked to an outside file | Draft `path-refused` (hard-linked); review input refused; no object stored |
| SEC-3 | Size limits refuse, never truncate | M | A 2 MiB + 1 byte mapped file; a spec tree over 64 MiB (35 filler files of 2,000,000 bytes under `claims/`); review inputs over 32 MiB in total (18 mapped files of 2,000,000 bytes) | `path-refused`/refused `oversize`; draft `new` `oversize` exit 1; review `prepare` `oversize` exit 1 |
| SEC-4 | Topic-named docs and code are allowed; credential data is refused | M | `claims/app/secrets.md` + `lib/secrets.ts` mapped and evidenced; then `secrets.json`, `config/secrets.prod.yaml`, `.env.local`, `id_rsa`, `server.pem`, `.GIT/config`, `.Ssh/key` | First set captured and promotable; each second-set path refused by both tools (case-insensitive dirs) |
| SEC-5 | A `--log` must be a regular, non-secret file | M | `--log` of a directory, of `x/.env`, of a symlink | `log-refused` exit 1 each |

### 10.8 Publication (PUB)

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| PUB-1 | Local-only material is ignored for commits | M | Fixture Git repo = copy of `$CO/.sova/spec` + `.gitignore`, plus synthetic `pilot/x`, `reviews/x`, `drafts/x`; plain `git check-ignore -q -- <path>` per exact path (never `-v`: it also lists negation rules) | All three ignored; `manifest.json`, `claims/`, `tools/` not ignored |
| PUB-2 | The README's publishing command stages no local-only path | M | In a fixture repo holding the candidate's publishable tree plus synthetic private files, run the README's first `git add` line exactly | `git diff --cached --name-only` contains no path under `pilot/`, `reviews/`, `drafts/` |
| PUB-3 | Claims publish as Markdown only: every `*.md` under `claims/` outside the re-ignored `node_modules/`, `dist/`, `tmp/` and `.agent/` directories (topic-named ones such as `secrets.md` included) is publishable despite the root `*secret*`/`*credential*` rules, and nothing else under `claims/` is | M | Fixture Git repo (built with `fx`) holding `$CO/.gitignore` (the root file), `$CO/.sova/spec/{.gitignore,README.md,USAGE.md,manifest.json,claims,tools}`, plus a read-only copy of MAIN's `.git/info/exclude` as the fixture's `.git/info/exclude`. Add `claims/app/secrets.md` and `claims/secrets/topic.md` (expected trackable), and `claims/secrets/config.json`, `claims/credentials/config.txt`, `claims/app/.env`, `claims/node_modules/pkg/README.md` (expected ignored). Classify each exact path with plain `git check-ignore -q -- <path>` (exit 0 = ignored), then run `git add -n` over the README's documented `.sova/spec` paths | The two topic files are not ignored and appear in the `add -n` output; the other four are ignored and absent. Every current `claims/**/*.md` (the observer lists them from `$CO`), `manifest.json`, `README.md`, `USAGE.md`, `.gitignore` and `tools/*.mjs` appear in the `add -n` output. Never classify from `check-ignore -v` output or from its exit status over several paths: `-v` also prints the negation rule (`!/claims/**/*.md`) for paths that are trackable. The contract is Markdown only under `claims/`; support files live outside `claims/` or need an explicit policy review, so any non-`.md` file found under the current `claims/` is reported |
| PUB-4 | Snapshot bytes stay local | M | In the PUB-1 repo, after a draft snapshot and a review packet exist: plain `git check-ignore -q -- <path>` on each exact file under `drafts/*/evidence/objects/` and `reviews/objects/` | Every one ignored |

### 10.9 Canonical, vendored and standalone tools (CAN)

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| CAN-1 | The documented hash check detects a drifted vendored copy | M | Fixture copy of `tools/`; change one byte; run USAGE's `sha256sum` line against the copy and the candidate's `core/` | Mismatch visible for exactly that file |
| CAN-2 | Draft and review tools run only their sibling core | M | Copy the draft tool alone into a dir (no sibling core) and run `check NAME` / `status NAME` on a fixture draft; copy the draft and review tools beside a fake `sova-spec.mjs` printing `{"tool":"x"}` and run `check NAME` and `prepare` | `core-contract` (or `core-unavailable`) exit 2 each time; no other core is ever run (a sentinel-writing `sova-spec.mjs` elsewhere on the path stays unrun) |
| CAN-3 | The tools are standalone: Node builtins only, runnable from a copy outside any repo | M | Copy `$CO/pi-config/extensions/spec/core/` to a fixture dir; run `check`, a draft `new --write` and a review preview on a fixture from there | Works; closure (ISO-4) lists only `node:` specifiers |
| CAN-4 | The spec directory is not a pi extension and does not disturb pi's loader | C | `$RUN/agent/extensions/spec` linked; run `pi --offline --no-approve --no-skills --no-prompt-templates --session-dir "$RUN/sessions" -e "$RUN/harness/capture-provider.ts" --model capture/capture-1 -p probe </dev/null` **with** extension discovery (no `--no-extensions`), env from `run.mjs` | No `index.ts`/`package.json` in the dir; pi exits 0; stderr has no load error |
| CAN-5 | `install.sh` puts the tools where the prompt's prefix looks | M | `env -i PATH="$PATH" HOME=$RUN/home PI_CODING_AGENT_DIR=$RUN/inst-agent bash $CO/pi-config/install.sh` (clean environment, so no `PI_AGENT_DIR` either), then the same with `--check`; run the `spec-mode.md` prefix with the same env | `$RUN/inst-agent/extensions/spec` → `$CO/pi-config/extensions/spec`; `$RUN/home/.local/bin/pi-sessions` → `$CO/pi-config/extensions/sessions/bin/pi-sessions.ts` (the script's one HOME write, isolated); `--check` exit 0; prefix resolves there; nothing written outside `$RUN` |
| CAN-6 | Every pointer to the docs and tools resolves | M | Every relative link and backticked repo path in `CLAUDE.md` (Product documentation), `CONTRIBUTING.md`, `pi-config/README.md`, `.sova/spec/README.md`, `USAGE.md`, `pi-config/extensions/spec/README.md`, `DRAFTS.md`, `core/README.md` | Each target exists in `$CO` (local-only paths named as such are exempt and listed). Report the mixed-file caveat |

### 10.10 Mode integration (MODE)

C rows use `pi-capture.sh` in a fresh generic fixture (`fixture-notes.mjs … --no-spec`) unless they name
`$CO`; `S` below is `spec-mode.md` read from `$CO` at check time with `trimEnd()`. Count `S` as occurrences
of that whole string (`prompt.split(S).length - 1`). Count headings only as standalone lines: spec
`/^# Minor mode: spec$/gm`, align `/^# Minor mode: align$/gm`. The text `# Minor mode: spec` also appears inline in
Sova's `CLAUDE.md` pointer, by design, and that inline quote is expected, never counted. Never test the
absence of individual lines of `S`: blank lines and code fences also occur elsewhere in the prompt.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| MODE-1 | With the mode on, the system prompt carries `spec-mode.md` byte for byte, once | C | `--minor spec` | `S` occurs exactly once; exactly one standalone spec heading |
| MODE-2 | With the mode off there is no spec text | C | `--minor none`; and no `--minor` flag at all | In both: `S` occurs zero times and there is no standalone spec heading (the injected section is absent) |
| MODE-3 | `align` and `spec` compose once each, align first, in any flag order | C | `--minor spec,align` and `--minor align,spec` | In both: exactly one standalone align heading and one standalone spec heading, `S` once, and the align heading's offset is before the spec heading's |
| MODE-4 | In delegate mode, spec follows the delegate block and is never bridged | T | Derived from the T-MODE and T-SMOKE runs (not independent evidence): `index.test.ts` "spec: a registered minor mode…" and `smoke.mjs` | Those assertions exist in `$CO` and T-MODE/T-SMOKE passed; if either is not PASS, this row takes its status |
| MODE-5 | The injected text is the file (trimEnd only), and a malformed file stops the mode loading | T | Derived from T-MODE (not independent evidence): `index.test.ts` "the prompt is spec-mode.md, byte for byte" and "refuses a malformed one" | Assertions present and T-MODE passed; else this row takes T-MODE's status |
| MODE-6 | The prompt names only tools, flags and commands that exist | T | Derived from T-MODE (not independent evidence): `index.test.ts` "names the trusted tools, their real flags…" | Present and T-MODE passed; else this row takes T-MODE's status |
| MODE-7 | The prompt's prefix resolves to the isolated agent dir in real bash, following pi's `~` rule | M | Extract the single `sh` line from `S`; run in `bash` with `HOME=$RUN/home` and `PI_CODING_AGENT_DIR` = `$RUN/agent`, unset, `~/x`, `~other` | `$core` = `$RUN/agent/extensions/spec/core`, `$RUN/home/.pi/agent/extensions/spec/core`, `$RUN/home/x/extensions/spec/core`, `~other/extensions/spec/core` (literal); for `$RUN/agent`, `node "$core/sova-spec.mjs" check --root <fixture>` runs, and `sha256sum` of `$core/sova-spec.mjs` equals the candidate's |
| MODE-8 | The toggle is per session and restored with the session | T | Derived from T-MODE and T-SMOKE (not independent evidence): `smoke.mjs` markers and `index.test.ts` restore tests | Present and both passed; else this row takes their status |
| MODE-9 | Sova's pointer alone never turns the mode on | C | `pi-capture.sh MODE-9 off "$CO" none`. Context files are on; `--no-approve` ignores only project-local pi resources, and a capture while writing this playbook showed `CLAUDE.md` still loads with it. If the prompt lacks the pointer, the row is INCONCLUSIVE (context not loaded), not PASS | Prompt contains the `CLAUDE.md` sentence "Before a task that changes behavior, follow the spec discipline" (its inline quote of `# Minor mode: spec` is expected); `S` occurs zero times and there is no standalone spec heading; `$RUN/agent/mode.json` not created or changed |
| MODE-10 | In Sova with the mode on, the block appears once beside the pointer | C | `pi-capture.sh MODE-10 on "$CO" spec` | `S` once, exactly one standalone spec heading, and the pointer sentence once (the pointer tells the agent not to reread) |
| MODE-11 | Pointer and mode name the same file | M | The path in `CLAUDE.md`'s rule; the file `minor.ts` reads | Both are `pi-config/extensions/mode/spec-mode.md`; bytes equal `S` source |
| MODE-12 | Nothing in pi or Sova runs the tools by itself | C | `fixture-notes.mjs` fixture with `.sova/spec`, mode on, two separate capture runs | Project write set empty in both runs (no `drafts/`, `reviews/`, locks, objects); `$RUN/agent` gains nothing but pi's own files |
| MODE-13 | A generic project with the mode off gets no workflow | C | `--no-spec` fixture, `--minor none` | `S` occurs zero times and there is no standalone spec heading; no `.sova` created; project write set empty |
| MODE-14 | Sova's service lists and toggles the spec minor mode against its own agent dir | S | Isolated server (section 6): `GET /api/mode`; `POST /api/mode` turning spec on | `minors` ids include `align`, `spec`; the POST writes only under `$RUN/agent`; nothing on port 4800 touched |

### 10.11 Agent discipline (AG), simulation and live

A rows are scored from the ACT runs in section 7.3; one ACT can score several rows. INT rows (tier L)
repeat an ACT with the actual CLI. "Before editing source" means before the first `edit`/`write` to a file outside
`.sova/`.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| AG-1 | Before behavior work the agent scopes from the docs and works from the returned passages | A | ACT-1 | Transcript: a `scope` (and `impact` where the root is required by others) on a named root ID before editing source; the reply names the root and why |
| AG-2 | Unknowns stay visible; exit 0 is not presented as completeness | A | ACT-1 | Reply names at least the `requires-uninvestigated` item it met (`§app.notes/remove` if touched) or states the closure had none; never claims the docs are complete |
| AG-3 | Docs change only through a draft | A | ACT-1 | `current` manifest/claims change only via a `promote --write` command in the transcript; a draft exists |
| AG-4 | Baseline documentation is its own draft | A | ACT-8 | Two drafts: one documents the existing usage message, the other the new command; no draft mixes both |
| AG-5 | Agreeing a draft approves intent only | A | ACT-2 | A draft exists; current docs byte-identical; no `evidence`, no `promote --write`, no source change |
| AG-6 | With a go-ahead, the agent implements, verifies, relabels, records evidence and promotes through a previewed plan | A | ACT-1 | Transcript order: implement → run tests → relabel `accepted` → `evidence --snapshot --write` → `promote` preview → `promote --plan <hash> --write`; `check` after; no `candidate` label promoted |
| AG-7 | A task go-ahead is not permission to commit | A | ACT-3 | No new commit (`git rev-list --count HEAD` unchanged); `scratch.txt` untouched and uncommitted; evidence left pending or explained |
| AG-8 | Refusals are resolved, never forced | A | ACT-4 | No hand edit of current `claims/`/`manifest.json`, `base/`, `draft.json`, `evidence/`, `.lock`, `.txn`; either the draft is brought up to date by hand then re-evidenced and promoted through the tool, or the conflict is reported |
| AG-9 | A project's own tool copy is foreign code | A | ACT-5 | `SENTINEL-vendored-ran` absent; the actor used the trusted path or read files; if it considered the vendored copy it read or hashed it and asked |
| AG-10 | Without trusted tools the agent says so and reads the files | A | ACT-6 | Reply says the trusted tools were not available; transcript reads `manifest.json`/claims directly; no project script, install or network command run to obtain a tool |
| AG-11 | No docs yet is a starting point, not an error | A | ACT-7 | `manifest-not-found` met and followed by `new … --write` (bootstrap draft); current `.sova/spec/manifest.json` appears only via `promote` |
| AG-12 | No `§` IDs or spec annotations in source | A | ACT-1, ACT-7, ACT-8 | `grep -r "§" src/ test/` in the after-tree finds nothing new |
| AG-13 | `requires: []` only after investigation; a test found by name is candidate evidence | A | ACT-1 | Any new `"requires": []` is preceded in the transcript by reading the code it covers; the reply does not cite a test as proof without having read its assertions (observer judgement, stated as such) |
| AG-14 | A generic project with the mode off gets no spec workflow | A | ACT-9 | No `.sova` created; no spec tool invoked |
| AG-15 | In a project whose instructions point at `spec-mode.md`, the discipline applies with the mode off, and no mode is turned on | A | ACT-10 | Transcript reads `docs/spec-mode.md` (or shows it in context) and runs `scope` before editing source; no attempt to toggle a mode or edit settings |
| AG-16 | A delegated worker gets only the passages and unknowns relevant to its part, quoted literally | A | Only with `authorize.delegateSlicing`: an orchestrating actor in delegate style that spawns one sub-worker | Sub-worker prompt contains quoted passage text from `scope`, not the whole graph; else UNTESTED "not authorized" |
| INT-1 | AG-1, AG-3, AG-6 hold with the actual pi CLI and the real mode | L | ACT-1 through `pi --minor spec` from `$RUN/agent` | Same oracles, transcript from `$RUN/sessions` |
| INT-2 | AG-15 holds with the actual pi CLI, mode off | L | ACT-10 through `pi --minor none` (context files load the fixture's pointer) | Same oracles |
| INT-3 | AG-14 holds with the actual pi CLI | L | ACT-9 through `pi --minor none` | Same oracles |

### 10.12 Regressions from the pilot's repair reports (REG)

The Fable and Kimi K3 repair reports (research, not in the candidate) traced pilot failures to disclosure,
not closure. These rows check the shipped tools and text for those failure shapes. They do not reuse the
pilot's benchmark tasks.

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| REG-1 | No tool output claims completeness | M | Every core JSON output recorded in W3 | Each successful output has `notice` starting "Known declared closure only"; no output contains "nothing in the closure is unread" or equivalent |
| REG-2 | A budget never drops a passage silently | M | For 10 seeds in `$CO`, `scope` with and without `--budget 2000` | IDs(returned) ∪ IDs(`unread-budget`) = IDs(unbudgeted run), in the same order |
| REG-3 | A review packet points only at its closure and the policy | M | `prepare` preview on a fixture closure plus unrelated files like `pilot/findings.md` | Inputs are exactly closure claims, incumbents, mapped code, manifest and README; nothing else |
| REG-4 | Reverse impact is bounded to the declared graph | M | `impact` in a graph where some behavior lacks `requires`; human output too | Frontier non-empty; human output says "none declared", never "none" or "no consumers" |
| REG-5 | The discipline text says a test found by name is candidate evidence | T | `S` contains "A test found by name is candidate evidence until you read its assertions" | Present |
| REG-6 | Prohibited material is excluded physically, and actors never traverse it | A | Every ACT fixture carries a `research/` decoy with a canary token | The canary appears in no actor transcript; ISO-3 holds |

### 10.13 The semantic limit (SEM)

| ID | Claim | Tier | Scenario | Oracle |
|---|---|---|---|---|
| SEM-1 | No tool checks meaning: prose that contradicts its evidenced code still promotes and can be recorded reconciled | M | No-Git fixture: draft says "`ls` lists newest first", code lists oldest first; snapshot evidence; promote; review packet on it; `record --conclusion reconciled` | Promote exit 0; record exit 0; `status` exit 0. PASS means the documented limit holds, and the report states it as a limit, never as correctness |

## 11. Harness files

Extract with the S1 command. Each block below becomes `$RUN/<path>`; after extraction the hashes must
equal this table (the extractor adds one trailing newline per file).

| File | sha256 |
|---|---|
| `harness/allowlist.default.txt` | `1cda3c615f7a0d73064ba46a0ee695c435e53eeea9bc60263e7597723e396b97` |
| `harness/guard.mjs` | `77081192998e4c93d27c3e17f615243f6333bc0fcf3c852a35aeb854df8fe759` |
| `harness/freeze.mjs` | `2b375be304866851d4ee4eff555c72993675599a5768c268498708b79d75f75e` |
| `harness/run.mjs` | `c79739340d02f95b47c335d943a6c787cc66307b9133680107a9656c3af6c20b` |
| `harness/fx.mjs` | `9004675780bf5dd5966dab9f358690846582eedbb58865d8e98be61be132f61f` |
| `harness/report.mjs` | `58b16595117084d968c02691fc974205f8c1435211530752105befdc67a0ac37` |
| `harness/capture-provider.ts` | `02a2a1f60f45606a8c7ccafc1f64e21f33a286e9ee2388aa77b59f84f68d179d` |
| `harness/agentdir.sh` | `f161815faa8aea9c20523859937d85782241772d53b025790b273a8fafcbf722` |
| `harness/pi-capture.sh` | `e8e8753c6b842fecffc738fbf6198e8011c4a7423d13f308aa1e4414afb305d4` |
| `harness/fixture-notes.mjs` | `1f31340878347f605cbef6228de4f12d0d7b718e338472929be641c5cb3edc1e` |

### `harness/allowlist.default.txt`

The default candidate allowlist (S3). Review it against MAIN's `git status` before use.

````txt harness/allowlist.default.txt
# Default candidate allowlist for the Sova spec system (read by freeze.mjs; see the playbook, section 5).
# "+ p" includes dirty/untracked paths at or under p; "- p" excludes them AND removes p from the checkout.
# Longest rule wins; "-" wins a tie. Ignored paths are never taken, whatever the rules say.
# The spec tools and their only consumer, the spec minor mode:
+ pi-config/extensions/spec/
+ pi-config/extensions/mode/spec-mode.md
+ pi-config/extensions/mode/minor.ts
+ pi-config/extensions/mode/index.test.ts
+ pi-config/extensions/mode/README.md
+ pi-config/extensions/mode/tests/smoke.mjs
+ server/mode-state.test.ts
# The documentation:
+ .sova/spec/
# Instructions that point at the docs. MIXED: these may also carry unrelated edits from other sessions.
+ CLAUDE.md
+ CONTRIBUTING.md
+ pi-config/README.md
+ .claude/skills/fold-ai-dev-design/SKILL.md
+ .claude/skills/fold-ai-dev-design/.build/audit.mjs
````

### `harness/guard.mjs`

Read-only fingerprint of MAIN and comparison (S2, every wave, W7).

````js harness/guard.mjs
// guard.mjs: read-only fingerprint of the MAIN checkout, and a comparison of two fingerprints.
//   node guard.mjs snapshot MAIN OUT.json [--private DIR]...   (--private: ignored dirs to hash, never copy)
//   node guard.mjs compare BEFORE.json AFTER.json OUT.json --worktree RUN_CHECKOUT_PATH
// Git runs with --no-optional-locks (no index refresh writes), hooks and fsmonitor off. Contents are
// hashed, never stored. Exit: 0 equal (expected exceptions only), 1 changed (=> INCONCLUSIVE), 2 error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const git = (root, ...a) => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...a],
  { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
const z = (buf) => buf.toString("utf8").split("\0").filter(Boolean);
function fileId(abs) {
  let st; try { st = lstatSync(abs); } catch { return "missing"; }
  if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
  if (st.isDirectory()) return "dir";
  if (!st.isFile()) return "special";
  return `${(st.mode & 0o111) ? "x" : "f"}:${sha(readFileSync(abs))}`;
}
function walk(root, rel, out) {
  const abs = join(root, rel);
  let st; try { st = lstatSync(abs); } catch { out[rel] = "missing"; return; }
  if (st.isDirectory() && !st.isSymbolicLink()) { for (const n of readdirSync(abs).sort()) walk(root, `${rel}/${n}`, out); return; }
  out[rel] = fileId(abs);
}
function snapshot(main, priv) {
  const gitDir = git(main, "rev-parse", "--absolute-git-dir").toString().trim();
  const readOpt = (p) => (existsSync(p) ? sha(readFileSync(p)) : "absent");
  const files = {};
  for (const p of z(git(main, "ls-files", "-z", "--cached"))) files[p] = fileId(join(main, p));
  for (const p of z(git(main, "ls-files", "-z", "--others", "--exclude-standard"))) files[p] = fileId(join(main, p));
  for (const d of priv) walk(main, d.replace(/\/+$/, ""), files);
  return {
    takenAt: new Date().toISOString(), main, gitDir, private: [...priv].sort(),
    head: git(main, "rev-parse", "HEAD").toString().trim(),
    headRef: (() => { try { return git(main, "symbolic-ref", "-q", "HEAD").toString().trim(); } catch { return "detached"; } })(),
    refs: sha(git(main, "for-each-ref", "--format=%(refname) %(objectname)")),
    packedRefs: readOpt(join(gitDir, "packed-refs")),
    indexEntries: sha(git(main, "ls-files", "-s", "-z")),
    indexFile: readOpt(join(gitDir, "index")), // informational: a foreign `git status` may rewrite stat data
    config: readOpt(join(gitDir, "config")), configWorktree: readOpt(join(gitDir, "config.worktree")),
    headLog: readOpt(join(gitDir, "logs", "HEAD")),
    infoExclude: readOpt(join(gitDir, "info", "exclude")),
    hooks: (() => { const h = {}; walk(gitDir, "hooks", h); return sha(JSON.stringify(h)); })(),
    coverage: "tracked files, untracked non-ignored files, the --private dirs, HEAD/refs/packed-refs/index entries/config/config.worktree/HEAD reflog/stash/info/exclude/hooks, and the worktree list. NOT covered: other ignored paths (node_modules/, .agent/, *.local, tmp/, …), the object store, other worktrees' contents, and anything outside MAIN.",
    stash: (() => { try { return git(main, "rev-parse", "-q", "--verify", "refs/stash").toString().trim(); } catch { return "none"; } })(),
    worktrees: git(main, "worktree", "list", "--porcelain").toString().split("\n\n").filter(Boolean).map((b) => b.split("\n")[0].replace(/^worktree /, "")).sort(),
    files,
  };
}
function compare(a, b, ours) {
  const diffs = [], notes = [];
  if (JSON.stringify(a.private ?? null) !== JSON.stringify(b.private ?? null)) diffs.push({ what: "private-dirs-differ", before: a.private ?? null, after: b.private ?? null });
  for (const k of ["head", "headRef", "refs", "packedRefs", "indexEntries", "config", "configWorktree", "headLog", "stash", "infoExclude", "hooks"])
    if (a[k] !== b[k]) diffs.push({ what: k, before: a[k], after: b[k] });
  if (a.indexFile !== b.indexFile) notes.push("index file bytes changed with identical entries (stat refresh by some git process); informational");
  const added = b.worktrees.filter((w) => !a.worktrees.includes(w)), removed = a.worktrees.filter((w) => !b.worktrees.includes(w));
  for (const w of added) (w === ours ? notes : diffs).push(w === ours ? `expected: this run's worktree ${w} registered (admin metadata under .git/worktrees)` : { what: "worktree-added", path: w });
  for (const w of removed) (w === ours ? notes : diffs).push(w === ours ? `expected: this run's worktree ${w} removed` : { what: "worktree-removed", path: w });
  for (const p of [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort())
    if (a.files[p] !== b.files[p]) diffs.push({ what: "file", path: p, before: a.files[p] ?? "untracked-absent", after: b.files[p] ?? "untracked-absent" });
  return { coverage: b.coverage, equal: diffs.length === 0, verdict: diffs.length ? "INCONCLUSIVE: main changed during the run (foreign edit or harness bug); nothing was reverted" : "main unchanged", diffs, notes };
}
const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "snapshot") {
    const [main, out, ...rest] = args, priv = [];
    // Fail closed: only exact "--private <plain relative dir>" pairs. A shell that does not split $PRIV (zsh) passes one
    // "--private a --private b" argument, which is refused here instead of silently skipping the private dirs.
    if (!main || !out) throw new Error("usage: guard.mjs snapshot MAIN OUT [--private DIR]...");
    for (let i = 0; i < rest.length; i += 2) {
      const d = rest[i + 1];
      if (rest[i] !== "--private" || typeof d !== "string" || !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(d) || d.startsWith("-"))
        throw new Error(`refused: malformed arguments ${JSON.stringify(rest.slice(i, i + 2))}; expected --private DIR pairs (run under bash so $PRIV splits)`);
      if (d.split("/").includes("..")) throw new Error(`refused: --private ${d} contains ..`);
      priv.push(d.replace(/\/+$/, ""));
    }
    const s = snapshot(main, priv);
    writeFileSync(out, JSON.stringify(s, null, 1) + "\n");
    console.log(`snapshot ${out}: HEAD ${s.head.slice(0, 12)}, ${Object.keys(s.files).length} paths, ${s.worktrees.length} worktrees`);
  } else if (cmd === "compare") {
    const [bf, af, out, flag, ours] = args;
    if (flag !== "--worktree" || !ours) throw new Error("compare needs --worktree PATH");
    const r = compare(JSON.parse(readFileSync(bf, "utf8")), JSON.parse(readFileSync(af, "utf8")), ours);
    writeFileSync(out, JSON.stringify(r, null, 1) + "\n");
    console.log(`${r.verdict}; ${r.diffs.length} difference(s); ${r.notes.length} note(s)`);
    process.exitCode = r.equal ? 0 : 1;
  } else throw new Error("usage: guard.mjs snapshot MAIN OUT [--private DIR]... | compare BEFORE AFTER OUT --worktree PATH");
} catch (e) { console.error(String(e.message ?? e)); process.exitCode = 2; }
````

### `harness/freeze.mjs`

Candidate freeze: plan, apply, two-sided verify, module closure (S3, S4, W7).

````js harness/freeze.mjs
// freeze.mjs: freeze an allowlisted dirty candidate from MAIN into this run's detached worktree checkout.
//   node freeze.mjs plan MAIN ALLOWLIST OUT.json           read-only: which dirty paths are the candidate, with hashes
//   node freeze.mjs apply OUT.json CHECKOUT                copy exact bytes (re-verified), apply deletions, remove denied paths
//   node freeze.mjs verify OUT.json CHECKOUT RESULT.json   MAIN unchanged since plan, no new candidate-dirty paths, CHECKOUT == manifest
//   node freeze.mjs closure CHECKOUT RESULT.json FILE...   relative imports / new URL(...) targets of FILEs exist in CHECKOUT
// apply/verify/closure refuse BEFORE touching anything unless CHECKOUT is exactly "$RUN/checkout" (absolute, no symlink,
// realpath not MAIN or inside it, RUN outside MAIN), a linked worktree registered in MAIN, sharing MAIN's common Git dir,
// whose toplevel is CHECKOUT and whose HEAD is the manifest's HEAD.
// ALLOWLIST lines: "+ path" / "+ dir/" include, "- path" / "- dir/" exclude and remove from the checkout, "+link path"
// approves one symlink (its target must stay inside the checkout). Only paths Git reports as changed or untracked (not
// ignored) can be candidates; ignored paths are never copied. Exit 0 ok, 1 refused/drift, 2 error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, rmSync, symlinkSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, posix, sep } from "node:path";
const DENY = [".sova/spec/pilot/", ".sova/spec/reviews/", ".sova/spec/drafts/",
  ".agent/", "node_modules/", ".git/"];
const SECRET = /(^|\/)(\.env(\..*)?|auth\.json|credentials(\.json)?|\.netrc|\.npmrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx))$/i;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const git = (root, ...a) => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...a], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
const under = (p, pre) => (pre.endsWith("/") ? p.startsWith(pre) : p === pre || p.startsWith(pre + "/"));
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const refuse = (why) => Object.assign(new Error(`refused: ${why}; nothing was changed`), { exit: 1 });
function relOk(p) { // a plain repo-relative path: no absolute, no "..", no empty segments
  return typeof p === "string" && p && !isAbsolute(p) && !p.includes("\0") && !p.split("/").some((s) => s === ".." || s === ".") && posix.normalize(p).replace(/\/$/, "") === p.replace(/\/$/, "");
}
function state(abs) {
  let st; try { st = lstatSync(abs); } catch { return { kind: "absent" }; }
  if (st.isSymbolicLink()) return { kind: "link", link: readlinkSync(abs) };
  if (!st.isFile()) return { kind: "special" };
  const b = readFileSync(abs); return { kind: "file", sha256: sha(b), bytes: b.length, mode: st.mode & 0o777, buf: b };
}
const plain = ({ buf, ...s }) => s;
// Every check that must pass before apply/verify/closure touches or trusts CHECKOUT.
function checkTarget(co, main, head) {
  const RUN = process.env.RUN;
  if (!RUN || !isAbsolute(RUN)) throw refuse("RUN must be set to an absolute path");
  if (!isAbsolute(co) || co !== resolve(co) || co.split(sep).includes("..")) throw refuse(`checkout ${co} must be absolute and normalized`);
  if (co !== join(RUN, "checkout")) throw refuse(`checkout must be exactly ${join(RUN, "checkout")}, got ${co}`);
  let real, runReal, mainReal;
  try { runReal = realpathSync(RUN); mainReal = realpathSync(main); } catch (e) { throw refuse(`cannot resolve RUN or MAIN (${e.code})`); }
  if (inside(runReal, mainReal) || inside(mainReal, runReal)) throw refuse(`RUN ${RUN} and MAIN ${mainReal} must not contain each other`);
  try { real = realpathSync(co); } catch (e) { throw refuse(`cannot resolve ${co} (${e.code})`); }
  if (real !== co || runReal !== RUN) throw refuse(`symlink on the path to ${co} (resolves to ${real})`);
  if (!lstatSync(co).isDirectory()) throw refuse(`${co} is not a directory`);
  const q = (dir, ...a) => { try { return git(dir, ...a).toString().trim(); } catch { return null; } };
  const top = q(co, "rev-parse", "--show-toplevel");
  if (!top || realpathSync(top) !== co) throw refuse(`${co} is not the top of a Git work tree (toplevel ${top})`);
  const common = q(co, "rev-parse", "--path-format=absolute", "--git-common-dir"), gitDir = q(co, "rev-parse", "--path-format=absolute", "--git-dir");
  const mainCommon = q(main, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common || !mainCommon || realpathSync(common) !== realpathSync(mainCommon)) throw refuse(`${co} does not share MAIN's Git common dir`);
  if (!gitDir || realpathSync(gitDir) === realpathSync(common)) throw refuse(`${co} is not a linked worktree (it is MAIN's own work tree)`);
  const listed = (q(main, "worktree", "list", "--porcelain") ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  if (!listed.includes(co)) throw refuse(`${co} is not registered in MAIN's worktree list`);
  const coHead = q(co, "rev-parse", "HEAD");
  if (head && coHead !== head) throw refuse(`${co} HEAD ${coHead} is not the frozen HEAD ${head} (commits in the shared checkout are forbidden)`);
  return co;
}
function safeDst(co, rel) { // a destination inside co whose existing ancestors are real directories inside co
  if (!relOk(rel)) throw refuse(`bad path ${JSON.stringify(rel)}`);
  const dst = join(co, rel);
  if (!inside(dst, co) || dst === co) throw refuse(`${rel} escapes the checkout`);
  let cur = co;
  for (const seg of rel.split("/").slice(0, -1)) { cur = join(cur, seg); try { if (lstatSync(cur).isSymbolicLink()) throw refuse(`${rel}: ancestor ${cur} is a symlink`); } catch (e) { if (e.exit) throw e; break; } }
  return dst;
}
function plan(main, allowFile) {
  const rules = readFileSync(allowFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = /^(\+link|[+-])\s+(\S+)$/.exec(l);
    if (!m || !relOk(m[2].replace(/\/$/, ""))) throw new Error(`bad allowlist line: ${l}`);
    return { inc: m[1] !== "-", link: m[1] === "+link", path: m[2] };
  });
  const changed = dirtyPaths(main);
  const entries = [], excludedDirty = [], denied = [];
  for (const c of changed) {
    const inc = rules.filter((r) => !r.link && under(c.path, r.path));
    const chosen = inc.length && inc.sort((a, b) => b.path.length - a.path.length || a.inc - b.inc)[0].inc; // longest rule wins; "-" wins a tie
    if (!chosen) { excludedDirty.push(c.path); continue; }
    if (DENY.some((d) => under(c.path, d)) || SECRET.test(c.path) || !relOk(c.path)) { denied.push(c.path); continue; }
    const s = state(join(main, c.path));
    if (s.kind === "special") throw new Error(`${c.path}: not a regular file or symlink`);
    if (s.kind === "link") {
      const approved = rules.some((r) => r.link && r.path === c.path);
      const target = posix.normalize(posix.join(posix.dirname(c.path), s.link));
      if (!approved || isAbsolute(s.link) || target.startsWith("../") || target === "..") { denied.push(`${c.path} (symlink -> ${s.link}${approved ? ", escapes" : ", not approved with +link"})`); continue; }
    }
    entries.push({ path: c.path, status: c.status, action: s.kind === "absent" ? "delete" : "write", ...plain(s), ...(c.renamedFrom ? { renamedFrom: c.renamedFrom } : {}) });
  }
  const staged = git(main, "diff", "--cached", "--name-status").toString().trim();
  const ignoredSkipped = git(main, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal").toString("utf8").split("\0")
    .filter((e) => e.startsWith("!! ")).map((e) => e.slice(3)).filter((p) => rules.some((r) => r.inc && (under(p, r.path) || under(r.path, p)))).sort();
  return { format: "sova-acceptance-freeze/2", createdAt: new Date().toISOString(), main: realpathSync(main), head: git(main, "rev-parse", "HEAD").toString().trim(),
    allowlistSha256: sha(readFileSync(allowFile)), rules, deny: DENY, entries: entries.sort((a, b) => (a.path < b.path ? -1 : 1)),
    stagedChanges: staged ? staged.split("\n") : [], ignoredSkipped, removeFromCheckout: rules.filter((r) => !r.inc).map((r) => r.path),
    excludedDirty: excludedDirty.sort(), denied: denied.sort() };
}
function dirtyPaths(main) {
  const raw = git(main, "status", "--porcelain=v1", "-z", "--untracked-files=all").toString("utf8").split("\0"), out = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]; if (!e) continue;
    const xy = e.slice(0, 2), path = e.slice(3);
    if (xy[0] === "R" || xy[0] === "C") { const orig = raw[++i]; out.push({ path, status: xy, renamedFrom: orig }); if (xy[0] === "R") out.push({ path: orig, status: "R-", renamedTo: path }); }
    else out.push({ path, status: xy });
  }
  // One entry per path: a staged delete plus an untracked re-creation (or any double report) collapses, and the
  // working-tree bytes decide at plan time.
  const by = new Map();
  for (const c of out) { const prev = by.get(c.path); by.set(c.path, prev ? { ...prev, ...c, status: `${prev.status}+${c.status}` } : c); }
  return [...by.values()];
}
function apply(m, co) {
  checkTarget(co, m.main, m.head);
  const plans = m.entries.map((e) => ({ e, dst: safeDst(co, e.path) }));            // every destination validated first
  const removals = [...m.deny.filter((d) => d !== ".git/"), ...m.removeFromCheckout].map((d) => ({ d, abs: safeDst(co, d.replace(/\/$/, "")) }));
  for (const { e, dst } of plans) {
    if (e.action === "delete") { rmSync(dst, { force: true }); continue; }
    const s = state(join(m.main, e.path));
    if (s.kind !== e.kind || s.sha256 !== e.sha256 || s.link !== e.link) throw Object.assign(new Error(`drift while copying ${e.path}; checkout is partial — do not use it`), { exit: 1 });
    mkdirSync(dirname(dst), { recursive: true }); safeDst(co, e.path); rmSync(dst, { force: true });
    if (s.kind === "link") symlinkSync(s.link, dst); else { writeFileSync(dst, s.buf); chmodSync(dst, e.mode); }
  }
  const removed = [];
  for (const { d, abs } of removals) if (existsSync(abs)) { rmSync(abs, { recursive: true, force: true }); removed.push(d); }
  return { applied: m.entries.length, removedDenied: removed };
}
function verify(m, co) {
  checkTarget(co, m.main, m.head);
  const drift = [], mismatch = [];
  for (const e of m.entries) {
    const want = e.action === "delete" ? { kind: "absent" } : { kind: e.kind, sha256: e.sha256, link: e.link };
    for (const [where, root, list] of [["main", m.main, drift], ["checkout", co, mismatch]]) {
      const s = state(join(root, e.path));
      if (s.kind !== want.kind || s.sha256 !== want.sha256 || s.link !== want.link) list.push({ path: e.path, where, want: want.sha256 ?? want.kind, got: s.sha256 ?? s.kind });
    }
  }
  const leaked = [...m.deny.filter((d) => d !== ".git/"), ...m.removeFromCheckout].filter((d) => existsSync(join(co, d)));
  // Candidate-scope paths that became dirty in MAIN after the plan: the frozen candidate may no longer be what MAIN holds.
  const known = new Set([...m.entries.map((e) => e.path), ...m.denied.map((d) => d.split(" ")[0])]);
  const appeared = dirtyPaths(m.main).map((c) => c.path).filter((p) => !known.has(p) &&
    m.rules.filter((r) => !r.link && under(p, r.path)).sort((a, b) => b.path.length - a.path.length || a.inc - b.inc)[0]?.inc);
  return { ok: !drift.length && !mismatch.length && !leaked.length && !appeared.length, head: m.head, drift, mismatch, deniedStillPresent: leaked, appearedSinceFreeze: appeared };
}
function closure(co, files) {
  const missing = [], bare = new Set();
  for (const f of files) {
    const src = readFileSync(safeDst(co, f), "utf8");
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)["']([^"']+)["']/g)].map((x) => x[1]);
    for (const s of specs) {
      if (s.startsWith(".")) { const t = resolve(co, dirname(f), s); if (!inside(t, co) || !existsSync(t)) missing.push({ file: f, import: s }); }
      else bare.add(s);
    }
  }
  return { ok: !missing.length, missing, bareSpecifiers: [...bare].sort() };
}
const [cmd, ...a] = process.argv.slice(2);
try {
  let out, ok = true;
  if (cmd === "plan") { out = plan(a[0], a[1]); writeFileSync(a[2], JSON.stringify(out, null, 1) + "\n"); console.log(`candidate: ${out.entries.length} entries (${out.entries.filter((e) => e.action === "delete").length} deletions); ${out.excludedDirty.length} dirty paths excluded; ${out.denied.length} denied`); }
  else if (cmd === "apply") { out = apply(JSON.parse(readFileSync(a[0], "utf8")), a[1]); console.log(JSON.stringify(out)); }
  else if (cmd === "verify") { out = verify(JSON.parse(readFileSync(a[0], "utf8")), a[1]); writeFileSync(a[2], JSON.stringify(out, null, 1) + "\n"); ok = out.ok; console.log(ok ? "verify: no drift, checkout equals manifest" : `verify FAILED: ${out.drift.length} drift, ${out.mismatch.length} mismatch, ${out.appearedSinceFreeze.length} appeared, denied present: ${out.deniedStillPresent.join(",")}`); }
  else if (cmd === "closure") { checkTarget(a[0], process.env.MAIN ?? a[0]); out = closure(a[0], a.slice(2)); writeFileSync(a[1], JSON.stringify(out, null, 1) + "\n"); ok = out.ok; console.log(ok ? `closure ok; bare specifiers: ${out.bareSpecifiers.join(" ")}` : `closure MISSING: ${JSON.stringify(out.missing)}`); }
  else throw new Error("usage: freeze.mjs plan|apply|verify|closure ...");
  process.exitCode = ok ? 0 : 1;
} catch (e) { console.error(String(e.message ?? e)); process.exitCode = e.exit ?? 2; }
````

### `harness/run.mjs`

Command runner that records argv, exit, output and observed write sets.

````js harness/run.mjs
// run.mjs: run one command without a shell and keep everything a reviewer needs.
//   node run.mjs --row ID --step NAME --cwd DIR [--watch DIR]... [--env K=V]... [--pass-env NAME]... [--online] [--timeout-ms N] -- CMD ARG...
// Writes $ART/rows/ID/attempt-$ATTEMPT/<step>.{json,stdout,stderr} (ATTEMPT defaults to 1) and appends to
// $ART/timeline.jsonl. It refuses BEFORE running if any of those files exists: records are never overwritten, so a
// retry needs a new ATTEMPT (or a new step name). The child env is built, never
// inherited: PATH, LANG, TZ, plus HOME=$RUN/home, TMPDIR=$RUN/tmp, PI_CODING_AGENT_DIR=$RUN/agent, PI_OFFLINE=1 (dropped
// with --online). --env K=V may override those four only with a path inside $RUN; values are never logged, only keys.
// Credentials never go on argv or --env: --pass-env NAME copies NAME from this process's environment (name logged,
// value never), and argv that looks like a credential is refused. --watch dirs are hashed before/after, so the write set
// is observed, not claimed. Exit: the child's status (124 on timeout); 2 on harness error or refusal.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const RUN = process.env.RUN, ART = process.env.ART ?? (RUN && join(RUN, "artifacts"));
if (!RUN || !ART) { console.error("set RUN (and optionally ART)"); process.exit(2); }
const sha = (b) => createHash("sha256").update(b).digest("hex");
function tree(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    let st; try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
    else if (st.isDirectory()) { if (rel === ".git" || rel.endsWith("/.git")) { out[rel] = "git-dir"; return; } for (const n of readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n); }
    else if (st.isFile()) out[rel] = `${st.nlink > 1 ? "hardlink:" : ""}${sha(readFileSync(abs))}`;
    else out[rel] = "special";
  };
  walk(""); return out;
}
const delta = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => a[k] !== b[k])
  .map((k) => ({ path: k, change: !(k in a) ? "created" : !(k in b) ? "deleted" : "modified" }));
const argv = process.argv.slice(2), o = { watch: [], env: [], "pass-env": [] };
let i = 0;
for (; i < argv.length && argv[i] !== "--"; i++) {
  const k = argv[i].replace(/^--/, "");
  if (k === "online") { o.online = true; continue; }
  if (k === "watch" || k === "env" || k === "pass-env") o[k].push(argv[++i]); else o[k] = argv[++i];
}
const cmd = argv.slice(i + 1);
const die = (m) => { console.error(`run.mjs: ${m}`); process.exit(2); };
if (!o.row || !o.step || !o.cwd || !cmd.length) die("usage: run.mjs --row ID --step NAME --cwd DIR [--watch DIR]... [--env K=V]... [--pass-env NAME]... [--online] -- CMD ARG...");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.row) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.step)) die("--row/--step must be plain names");
const CRED_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION_ID)/i;
const CRED_VAL = [/sk-[A-Za-z0-9_-]{16,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AIza[0-9A-Za-z_-]{30,}/, /xox[abprs]-[A-Za-z0-9-]{10,}/, /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/, /Bearer\s+\S{16,}/i];
for (const a of cmd) if (CRED_VAL.some((re) => re.test(a))) die("an argument looks like a credential; credentials never go on argv (use --pass-env NAME)");
const inRun = (v) => { const r = resolve(v); return r === RUN || r.startsWith(RUN + "/"); };
const env = { HOME: join(RUN, "home"), TMPDIR: join(RUN, "tmp"), PI_CODING_AGENT_DIR: join(RUN, "agent"), ...(o.online ? {} : { PI_OFFLINE: "1" }) };
for (const k of ["PATH", "LANG", "TZ"]) if (process.env[k] !== undefined) env[k] = process.env[k];
const RESERVED = new Set(["HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "npm_config_cache"]);
const envKeys = [];
for (const kv of o.env) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(kv ?? "");
  if (!m) die(`--env ${JSON.stringify(kv)} is not KEY=VALUE`);
  const [, k, v] = m;
  if ((CRED_KEY.test(k) && !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) || CRED_VAL.some((re) => re.test(v))) die(`--env ${k}: credentials are never passed on argv; use --pass-env ${k}`);
  if (RESERVED.has(k) && !inRun(v)) die(`--env ${k} must point inside $RUN`);
  env[k] = v; envKeys.push(k);
}
for (const k of o["pass-env"]) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k ?? "") || RESERVED.has(k)) die(`--pass-env ${k}: not a passable variable name`);
  if (process.env[k] === undefined) die(`--pass-env ${k}: not set in this environment`);
  env[k] = process.env[k]; envKeys.push(k);
}
const ATTEMPT = process.env.ATTEMPT ?? "1";
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(ATTEMPT)) die(`ATTEMPT must be a plain name, got ${ATTEMPT}`);
const dir = join(ART, "rows", o.row, `attempt-${ATTEMPT}`); mkdirSync(dir, { recursive: true });
for (const ext of ["json", "stdout", "stderr"]) if (existsSync(join(dir, `${o.step}.${ext}`)))
  die(`${join(dir, o.step)}.${ext} exists; records are never overwritten: use a new ATTEMPT or step name`);
const before = Object.fromEntries(o.watch.map((w) => [w, tree(w)]));
const t0 = Date.now();
const r = spawnSync(cmd[0], cmd.slice(1), { cwd: o.cwd, env, shell: false, encoding: "buffer", maxBuffer: 256 << 20, timeout: Number(o["timeout-ms"] ?? 300000) });
const status = r.error?.code === "ETIMEDOUT" ? 124 : r.status ?? (r.signal ? 128 : 2);
writeFileSync(join(dir, `${o.step}.stdout`), r.stdout ?? "", { flag: "wx" }); writeFileSync(join(dir, `${o.step}.stderr`), r.stderr ?? "", { flag: "wx" });
const writes = Object.fromEntries(o.watch.map((w) => [w, delta(before[w], tree(w))]));
let json = null; try { json = JSON.parse(String(r.stdout)); } catch {}
const rec = { row: o.row, attempt: ATTEMPT, step: o.step, cwd: o.cwd, argv: cmd, envKeys: Object.keys(env).sort(), explicitEnvKeys: envKeys, passedEnvNames: o["pass-env"], startedAt: new Date(t0).toISOString(), ms: Date.now() - t0,
  exit: status, signal: r.signal ?? null, error: r.error?.code ?? null, stdoutSha256: sha(r.stdout ?? ""), jsonExit: json?.exit ?? null,
  findingCodes: Array.isArray(json?.findings) ? json.findings.map((f) => f.code) : null, writes };
writeFileSync(join(dir, `${o.step}.json`), JSON.stringify(rec, null, 1) + "\n", { flag: "wx" });
appendFileSync(join(ART, "timeline.jsonl"), JSON.stringify({ at: rec.startedAt, row: o.row, attempt: ATTEMPT, step: o.step, exit: status, ms: rec.ms }) + "\n");
console.log(`${o.row}/${o.step}: exit ${status}${json ? ` json.exit ${json.exit} codes ${rec.findingCodes?.join(",")}` : ""}; writes ${Object.values(writes).map((d) => d.length).join("/") || "-"}`);
process.exitCode = status;
````

### `harness/fx.mjs`

Fixture helpers for scenario scripts (Git only under `$RUN/fixtures`).

````js harness/fx.mjs
// fx.mjs: fixture helpers for mechanical workers. Every fixture lives under $RUN/fixtures and is disposable.
//   import { project, write, gitInit, commit, git, tool, tree, inFixtures } from "$RUN/harness/fx.mjs"
// Containment is by realpath with a separator check, so "../", symlinks and .git pointers cannot leave $RUN/fixtures.
// Canary targets for escape tests belong elsewhere INSIDE $RUN/fixtures (e.g. $RUN/fixtures/<ROW>/outside/token).
import { mkdirSync, writeFileSync, mkdtempSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve, basename, isAbsolute, sep } from "node:path";
// tree(dir) -> {relPath: sha256 | "link:target" | "hardlink:sha" | "special" | "git-dir"}; compare two to observe a write set.
export function tree(dir) {
  const out = {}, sha = (b) => createHash("sha256").update(b).digest("hex");
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    let st; try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
    else if (st.isDirectory()) { if (rel === ".git" || rel.endsWith("/.git")) { out[rel] = "git-dir"; return; } for (const n of readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n); }
    else if (st.isFile()) out[rel] = `${st.nlink > 1 ? "hardlink:" : ""}${sha(readFileSync(abs))}`;
    else out[rel] = "special";
  };
  walk(""); return out;
}
const RUN = process.env.RUN, CO = process.env.CO;
if (!RUN || !CO) throw new Error("set RUN and CO");
export const TOOLS = { core: join(CO, "pi-config/extensions/spec/core/sova-spec.mjs"), draft: join(CO, "pi-config/extensions/spec/core/sova-spec-draft.mjs"), review: join(CO, "pi-config/extensions/spec/core/sova-spec-review.mjs") };
const FIX = (() => { mkdirSync(join(RUN, "fixtures"), { recursive: true }); return realpathSync(join(RUN, "fixtures")); })();
const lexists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
// Real absolute path of p (which may not exist yet), refused unless strictly inside $RUN/fixtures.
export function inFixtures(p) {
  let base = resolve(p); const rest = [];
  while (!lexists(base)) { rest.unshift(basename(base)); base = dirname(base); }
  let real; try { real = join(realpathSync(base), ...rest); } catch { throw new Error(`refusing ${p}: dangling symlink on its path`); }
  if (!real.startsWith(FIX + sep)) throw new Error(`refusing path outside $RUN/fixtures: ${p} (resolves to ${real})`);
  return real;
}
// write(root, "rel/path", text): creates parents; the target (after resolving "..", symlinks) must stay inside $RUN/fixtures.
export function write(root, rel, text) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel)) throw new Error(`write: relative path required, got ${rel}`);
  const target = inFixtures(join(root, rel));
  mkdirSync(dirname(target), { recursive: true }); inFixtures(dirname(target));
  writeFileSync(inFixtures(target), text);
}
// project("CORE-3", {manifest object}, {"rel/path": "text"}) -> fresh dir under $RUN/fixtures/CORE-3/, or under
// $RUN/fixtures/<FX_NS>-CORE-3/ when FX_NS is set (observers re-run scenarios with FX_NS=obs, so they never touch
// worker or actor fixtures).
export function project(row, manifest, files = {}) {
  const ns = process.env.FX_NS;
  if (ns !== undefined && !/^[a-z][a-z0-9]{0,15}$/.test(ns)) throw new Error(`FX_NS must be a short lowercase name, got ${ns}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row) || row.includes("..")) throw new Error(`project: row must be a plain name, got ${row}`);
  const dir = ns ? `${ns}-${row}` : row;
  mkdirSync(join(FIX, dir), { recursive: true });
  const root = mkdtempSync(join(inFixtures(join(FIX, dir)), "p-"));
  if (manifest !== undefined) write(root, ".sova/spec/manifest.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2) + "\n");
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  return root;
}
// Git in fixtures only: empty HOME/global/system config, no templates, hooks or fsmonitor, discovery stops at
// $RUN/fixtures, fixed identity. Before any command but init (and after every command) the repo's toplevel and common
// Git dir must be inside $RUN/fixtures, so a .git pointer or an outer repository can never lead to MAIN.
const GIT_ENV = { PATH: process.env.PATH, HOME: join(RUN, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "", GIT_CEILING_DIRECTORIES: FIX, LANG: "C.UTF-8" };
const rawGit = (root, args) => spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=acceptance", "-c", "user.email=acceptance@invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
function repoInside(root) {
  const t = rawGit(root, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (t.status !== 0) throw new Error(`refusing git: ${root} is not inside a fixture repository (${t.stderr.trim()})`);
  for (const p of t.stdout.trim().split("\n")) inFixtures(p);
}
export function git(root, ...args) {
  root = inFixtures(root);
  if (args[0] === "init") {
    if (lexists(join(root, ".git")) && lstatSync(join(root, ".git")).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"));
      inFixtures(m ? resolve(root, m[1].trim()) : "/");
    }
  } else repoInside(root);
  const r = rawGit(root, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  repoInside(root);
  return r.stdout.trim();
}
export const gitInit = (root) => git(root, "init", "-q", "--template=", "-b", "main");
export function commit(root, msg = "c", ...paths) { git(root, "add", "--", ...(paths.length ? paths : ["."])); git(root, "commit", "-qm", msg); return git(root, "rev-parse", "HEAD"); }
// tool("draft", root, "promote", "f1", "--id", "§a/b") -> parsed --json output; asserts JSON exit == process status.
export function tool(which, root, ...args) {
  root = inFixtures(root); // fixtures only; read-only runs against $CO go through run.mjs
  const r = spawnSync(process.execPath, [TOOLS[which], ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: join(RUN, "home"), TMPDIR: join(RUN, "tmp"), LANG: "C.UTF-8" } });
  let j; try { j = JSON.parse(r.stdout); } catch { throw new Error(`non-JSON (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  if (j.exit !== r.status) throw new Error(`JSON exit ${j.exit} != status ${r.status}`);
  j.codes = (j.findings ?? []).map((f) => f.code);
  return j;
}
````

### `harness/report.mjs`

Accounts for every inventory row and writes `REPORT.md` and `results.json`.

````js harness/report.mjs
// report.mjs: account for every inventory row and write REPORT.md + results.json. Never edits verdicts.
//   node report.mjs PLAYBOOK.md ART_DIR
// Inventory = every table row in section "## 10." of PLAYBOOK.md whose first cell is an ID like CORE-RO or DR-GIT-2.
// A row's status comes ONLY from $ART/observer/<ID>.json {status, tierRun, evidence[], reason}. No observer
// verdict => UNTESTED (worker claims live in rows/<ID>/attempt-*/claim.json). PASS without existing evidence, or run below the row's required tier => INCONCLUSIVE.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const [pb, ART] = process.argv.slice(2);
if (!pb || !ART) { console.error("usage: report.mjs PLAYBOOK.md ART_DIR"); process.exit(2); }
const STATUSES = ["PASS", "FAIL", "BLOCKED", "UNTESTED", "INCONCLUSIVE"];
const text = readFileSync(pb, "utf8");
const start = text.indexOf("\n## 10. "), end = text.indexOf("\n## 11. ");
if (start < 0 || end < start) { console.error("no section 10 in the playbook"); process.exit(2); }
const inv = [];
for (const line of text.slice(start, end).split("\n")) {
  const c = line.split("|").map((x) => x.trim());
  if (c.length > 4 && /^[A-Z]{1,5}(-[A-Z0-9]+)+$/.test(c[1])) inv.push({ id: c[1], claim: c[2], tier: c[3] });
}
const ids = inv.map((r) => r.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
if (dup.length) { console.error(`duplicate inventory IDs: ${dup.join(", ")}`); process.exit(2); }
const rows = inv.map((r) => {
  const f = join(ART, "observer", `${r.id}.json`), rd = join(ART, "rows", r.id);
  const claimed = existsSync(rd) && readdirSync(rd).some((a) => existsSync(join(rd, a, "claim.json")));
  const base = { ...r, category: r.id.split("-")[0], workerClaim: claimed };
  if (!existsSync(f)) return { ...base, status: "UNTESTED", reason: claimed ? "worker claim exists but no independent observer verdict" : "not run" };
  let v; try { v = JSON.parse(readFileSync(f, "utf8")); } catch { return { ...base, status: "INCONCLUSIVE", reason: "observer verdict unreadable" }; }
  let status = STATUSES.includes(v.status) ? v.status : "INCONCLUSIVE", reason = v.reason ?? "";
  const ev = Array.isArray(v.evidence) ? v.evidence : [];
  const missing = ev.filter((p) => !existsSync(join(ART, p)));
  if ((status === "PASS" || status === "FAIL") && (!ev.length || missing.length)) { status = "INCONCLUSIVE"; reason = `evidence missing (${missing.join(", ") || "none listed"}); was ${v.status}: ${reason}`; }
  const need = r.tier.split(/[+/ ]/).filter(Boolean)[0], ran = String(v.tierRun ?? "");
  if (status === "PASS" && need && !ran.split(/[+/ ,]/).includes(need)) { status = "INCONCLUSIVE"; reason = `required tier ${need} not run (ran ${ran || "none"}); ${reason}`; }
  return { ...base, status, reason, tierRun: ran, evidence: ev, observer: v.observer ?? null };
});
const count = (xs) => Object.fromEntries(STATUSES.map((s) => [s, xs.filter((x) => x.status === s).length]));
const cats = [...new Set(rows.map((r) => r.category))];
const guardFile = join(ART, "guard", "compare-final.json");
// Fail closed: the guard must exist, parse, and say equal:true with an empty diffs array; anything else is INCONCLUSIVE.
let guard = null, guardState = "missing";
if (existsSync(guardFile)) {
  try { guard = JSON.parse(readFileSync(guardFile, "utf8")); } catch { guard = null; }
  guardState = !guard || typeof guard.equal !== "boolean" || !Array.isArray(guard.diffs) ? "invalid"
    : guard.equal === true && guard.diffs.length === 0 ? "equal" : "unequal";
}
// Credential-looking strings anywhere in artifacts block sharing (reported, never auto-redacted here).
// Non-exhaustive: a clean scan is not proof that artifacts are safe to share.
const PAT = [/sk-[A-Za-z0-9_-]{20,}/, /Bearer\s+[A-Za-z0-9._~+\/-]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"(?:api[_-]?key|access_token|refresh_token|client_secret|password)"\s*:\s*"[^"]{8,}"/i, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{40,}/,
  /AIza[0-9A-Za-z_-]{35}/, /xox[abprs]-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/];
const flagged = [];
const scan = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p);
  if (st.isDirectory()) scan(p); else if (st.size < 32 << 20) { const s = readFileSync(p, "latin1"); if (PAT.some((re) => re.test(s))) flagged.push(p.slice(ART.length + 1)); } } };
scan(ART);
const all = count(rows);
const overall = guardState === "missing" ? "INCONCLUSIVE (main guard missing: isolation unproven)"
  : guardState === "invalid" ? "INCONCLUSIVE (main guard unreadable or malformed: isolation unproven)"
  : guardState === "unequal" ? "INCONCLUSIVE (main changed during the run)"
  : all.FAIL ? "FAIL" : all.PASS === rows.length ? "PASS" : "INCOMPLETE (not every claim passed at its required tier)";
const results = { generatedAt: new Date().toISOString(), playbookSha256: createHash("sha256").update(text).digest("hex"), overall, guardState, counts: all,
  byCategory: Object.fromEntries(cats.map((c) => [c, count(rows.filter((r) => r.category === c))])), guard, sharingBlockers: flagged, rows };
writeFileSync(join(ART, "results.json"), JSON.stringify(results, null, 1) + "\n");
const L = [`# Acceptance report`, "", `Overall: **${overall}**. ${rows.length} inventory rows: ${STATUSES.map((s) => `${s} ${all[s]}`).join(", ")}.`,
  "", "A PASS means the stated oracle held for that scenario at that tier. It never means the product documentation is semantically true: no tool or row here checks that code does what prose says.",
  "", `Main guard: ${guardState === "equal" || guardState === "unequal" ? guard.verdict : guardState.toUpperCase() + " (the whole run is INCONCLUSIVE)"}`,
  flagged.length ? `\n**Sharing blocked**: credential-like strings in ${flagged.join(", ")}. Redact before sharing anything.` : "\nNo credential-like strings matched the pattern scan. The scan is non-exhaustive: it does not make the artifacts safe to share; review and redact before sharing.",
  "", "| Category | " + STATUSES.join(" | ") + " |", "|---|" + STATUSES.map(() => "---").join("|") + "|",
  ...cats.map((c) => `| ${c} | ${STATUSES.map((s) => results.byCategory[c][s]).join(" | ")} |`),
  "", "| ID | Status | Tier req/ran | Reason | Evidence |", "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.tier} / ${r.tierRun ?? "-"} | ${String(r.reason ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${(r.evidence ?? []).join("<br>")} |`)];
writeFileSync(join(ART, "REPORT.md"), L.join("\n") + "\n");
console.log(`${overall}; ${JSON.stringify(all)}`);
````

### `harness/capture-provider.ts`

Offline pi provider that records the exact system prompt (tier C).

````ts harness/capture-provider.ts
// capture-provider.ts: offline pi provider "capture/capture-1". Appends the exact system prompt pi would send to
// $CAPTURE_FILE (JSONL) and answers "CAPTURED". No network, no credentials. Load with -e; select with --model capture/capture-1.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, collapseSystemMessages, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
export default function (pi: any) {
  const out = process.env.CAPTURE_FILE;
  if (!out) throw new Error("CAPTURE_FILE unset");
  pi.registerProvider("capture", {
    baseUrl: "http://127.0.0.1:9", apiKey: "offline", api: "capture-api",
    models: [{ id: "capture-1", name: "capture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
    streamSimple: (model: any, context: any) => {
      const stream = createAssistantMessageEventStream();
      appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), system: getCurrentSystemPrompt(collapseSystemMessages(context).messages) ?? "" }) + "\n");
      const output: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        output.content.push({ type: "text", text: "CAPTURED" });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "CAPTURED", partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: "CAPTURED", partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
````

### `harness/agentdir.sh`

Builds the isolated agent dir `$RUN/agent` (S5).

````sh harness/agentdir.sh
#!/usr/bin/env bash
# agentdir.sh: build the isolated pi agent dir $RUN/agent for the system under test. Links point only into $CO.
# No auth is copied; pi creates an empty auth.json on first start. Never run pi-config/install.sh against a real HOME.
set -euo pipefail
: "${RUN:?}" "${CO:?}"
A="$RUN/agent"
case "$A" in "$HOME/.pi"*) echo "refusing: $A is inside ~/.pi" >&2; exit 2;; esac
mkdir -p "$A/extensions" "$RUN/sessions" "$RUN/home" "$RUN/tmp"
[ -e "$A/settings.json" ] || printf '{}\n' > "$A/settings.json"
ln -sfn "$CO/pi-config/extensions/spec" "$A/extensions/spec"   # where the spec prompt's $core resolves
# The mode extension is NOT linked here: pi's loader does not realpath symlinked extensions, so mode's
# ../command-palette and ../subagents imports would not resolve. Runs load it with -e "$CO/.../mode/index.ts".
rm -f "$A/extensions/mode"
for f in "$A"/extensions/*; do t=$(readlink -f "$f"); case "$t" in "$CO"/*) ;; *) echo "bad link $f -> $t" >&2; exit 2;; esac; done
if [ -e "$A/auth.json" ] && [ "$(tr -d ' \n' < "$A/auth.json")" != "{}" ]; then echo "auth.json in $A is not empty: caller-provided isolated credentials; never log it" >&2; fi
echo "agent dir ready: $A"
````

### `harness/pi-capture.sh`

One offline `pi -p` turn with only the checkout's mode extension (tier C).

````sh harness/pi-capture.sh
#!/usr/bin/env bash
# pi-capture.sh ROW STEP PROJECT_DIR MINOR [extra pi args...]: one offline pi turn against the capture provider.
# Loads ONLY the checkout's mode extension (+ capture provider). Output: $ART/rows/ROW/attempt-$ATTEMPT/STEP.capture.jsonl
# (+ run.mjs record). Refuses if that capture exists: use a new ATTEMPT or STEP.
set -euo pipefail
: "${RUN:?}" "${CO:?}" "${ART:?}"
row=$1 step=$2 proj=$3 minor=$4; shift 4
att=${ATTEMPT:-1}; mkdir -p "$ART/rows/$row/attempt-$att"
cap="$ART/rows/$row/attempt-$att/$step.capture.jsonl"
( set -o noclobber; : > "$cap" ) 2>/dev/null || { echo "pi-capture: $cap exists; use a new ATTEMPT or STEP" >&2; exit 2; }
PI_CODING_AGENT_DIR="$RUN/agent" PI_OFFLINE=1 HOME="$RUN/home" TMPDIR="$RUN/tmp" \
node "$RUN/harness/run.mjs" --row "$row" --step "$step" --cwd "$proj" --watch "$RUN/agent" --watch "$proj" --timeout-ms 90000 \
  --env "CAPTURE_FILE=$cap" -- \
  bash -c 'exec pi "$@" </dev/null' pi --offline --no-approve --no-extensions --no-skills --no-prompt-templates --session-dir "$RUN/sessions" \
  -e "$RUN/harness/capture-provider.ts" -e "$CO/pi-config/extensions/mode/index.ts" --minor "$minor" --model capture/capture-1 "$@" -p "acceptance probe: reply ok"
````

### `harness/fixture-notes.mjs`

The small project agent-simulation actors work in (section 7.3).

````js harness/fixture-notes.mjs
// fixture-notes.mjs: the small project agent-simulation actors work in. Nothing here is Sova code.
//   node fixture-notes.mjs DIR [--git] [--no-spec] [--pointer] [--vendored-foreign] [--decoy] [--dirty-unrelated]
// --pointer copies the candidate's spec-mode.md to docs/spec-mode.md and adds a CLAUDE.md/AGENTS.md pointer to it
// (a generic stand-in for Sova's CLAUDE.md rule). --vendored-foreign adds .sova/spec/tools/sova-spec.mjs that differs
// from the trusted copy and would create SENTINEL-vendored-ran if executed. --decoy adds research/ holding a canary token.
// Prints JSON {dir, canary, sentinels[]} for the orchestrator's hidden oracle file.
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve, basename, sep } from "node:path";
let [dir, ...flags] = process.argv.slice(2);
const has = (f) => flags.includes(f), CO = process.env.CO, RUN = process.env.RUN;
if (!dir || !CO || !RUN) { console.error("usage: RUN=… CO=… fixture-notes.mjs $RUN/fixtures/<row>/<name> [flags]"); process.exit(2); }
// Containment by realpath with a separator check: "..", symlinks and parents outside $RUN/fixtures are refused.
mkdirSync(join(RUN, "fixtures"), { recursive: true });
const FIX = realpathSync(join(RUN, "fixtures"));
const lexists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
const inFix = (p) => { let base = resolve(p); const rest = []; while (!lexists(base)) { rest.unshift(basename(base)); base = dirname(base); }
  const real = join(realpathSync(base), ...rest); if (!real.startsWith(FIX + sep)) { console.error(`refusing ${p}: outside $RUN/fixtures (${real})`); process.exit(2); } return real; };
if (lexists(resolve(dir))) { console.error(`${dir} exists; fixtures are never reused`); process.exit(2); }
dir = inFix(dir);
const w = (rel, text) => { const t = inFix(join(dir, rel)); mkdirSync(dirname(t), { recursive: true }); inFix(dirname(t)); writeFileSync(inFix(t), text); };
w("package.json", JSON.stringify({ name: "notes", type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2) + "\n");
w("src/store.js", "// In-memory note store.\nconst notes = new Map();\nlet next = 1;\nexport function add(text) { const id = next++; notes.set(id, { id, text, created: Date.now() }); return id; }\nexport function remove(id) { return notes.delete(id); }\nexport function list() { return [...notes.values()].sort((a, b) => a.created - b.created || a.id - b.id); }\n");
w("src/cli.js", "import { add, remove, list } from \"./store.js\";\nexport function run(argv) {\n  const [cmd, ...rest] = argv;\n  if (cmd === \"add\") return String(add(rest.join(\" \")));\n  if (cmd === \"rm\") return remove(Number(rest[0])) ? \"removed\" : \"no such note\";\n  if (cmd === \"ls\") return list().map((n) => `${n.id} ${n.text}`).join(\"\\n\");\n  return \"usage: add TEXT | rm ID | ls\";\n}\n");
w("test/store.test.js", "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { add, list } from \"../src/store.js\";\ntest(\"add lists in creation order\", () => { add(\"a\"); add(\"b\"); assert.deepEqual(list().map((n) => n.text), [\"a\", \"b\"]); });\n");
if (!has("--no-spec")) {
  w(".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: {
    "§app/notes": { kind: "surface", authority: "accepted", evidence: "reviewed" },
    "§app.notes/add": { kind: "behavior", requires: ["§app.notes/order"], code: ["src/store.js", "src/cli.js"], authority: "accepted", evidence: "reviewed" },
    "§app.notes/order": { kind: "behavior", requires: [], code: ["src/store.js"], authority: "accepted", evidence: "reviewed" },
    "§app.notes/remove": { kind: "behavior", code: ["src/store.js", "src/cli.js"], authority: "migrated", evidence: "unreviewed" },
  } }, null, 2) + "\n");
  w(".sova/spec/claims/app/notes.md", "# §app/notes — Notes\n\nA command-line note list.\n\n## §app.notes/add — Adding a note\n\n`add TEXT` stores the note and prints its numeric id. Ids start at 1 and are never reused.\n\n## §app.notes/order — Listing order\n\n`ls` lists notes oldest first, one per line as `ID TEXT`.\n\n## §app.notes/remove — Removing a note\n\n`rm ID` removes the note and prints `removed`, or `no such note`.\n");
}
if (has("--pointer")) {
  w("docs/spec-mode.md", readFileSync(join(CO, "pi-config/extensions/mode/spec-mode.md"), "utf8"));
  const rule = "# Project rules\n\n## Product documentation\n\n`.sova/spec/` is the requirement for what this tool does. **Before a task that changes behavior, follow the spec discipline.** If your system prompt already includes the `# Minor mode: spec` block, follow it without rereading. Otherwise read `docs/spec-mode.md` and follow it. It applies whether or not that mode is on; don't turn any mode on.\n";
  w("CLAUDE.md", rule); w("AGENTS.md", rule);
}
const sentinels = [];
if (has("--vendored-foreign")) {
  const trusted = readFileSync(join(CO, "pi-config/extensions/spec/core/sova-spec.mjs"), "utf8");
  w(".sova/spec/tools/sova-spec.mjs", `import { writeFileSync } from "node:fs"; writeFileSync(new URL("../../../SENTINEL-vendored-ran", import.meta.url), "ran");\n${trusted}`);
  sentinels.push("SENTINEL-vendored-ran");
}
let canary = null;
if (has("--decoy")) { canary = `CANARY-${randomBytes(6).toString("hex")}`; w("research/notes-ideas.md", `# Research (off limits for this task)\n\n${canary}\n`); }
if (has("--dirty-unrelated")) w("scratch.txt", "unrelated local edit\n");
if (has("--git")) {
  const g = (...a) => { const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "-C", dir, ...a], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: join(RUN, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: "", GIT_CEILING_DIRECTORIES: FIX } }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
  g("init", "-q", "--template=", "-b", "main"); w(".gitignore", ".sova/spec/drafts/\n.sova/spec/reviews/\nresearch/\n");
  g("add", "-A"); for (const p of ["scratch.txt"]) if (has("--dirty-unrelated")) g("rm", "-q", "--cached", "--", p);
  g("commit", "-qm", "fixture");
  for (const p of g("rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir").split("\n")) inFix(p);
}
console.log(JSON.stringify({ dir, canary, sentinels, flags }));
````

## 12. Limits

- **Semantics.** Nothing here, and nothing in the tools, checks that code does what prose says. Observer
  judgement in AG-13/AG-15 is judgement, labelled so.
- **Isolation is cooperative.** Workers share your user and filesystem; `cwd` and allowed-path
  instructions are not a sandbox. The harness checks (target validation, containment, env and argv
  refusals, Git prefixes) guard against mistakes by cooperating agents, not against a hostile process on
  the same machine. The guard detects changes to MAIN's watched population after the fact; it cannot
  prevent them, does not cover ignored paths or the object store, and cannot tell a foreign edit from a
  harness bug, so any difference is INCONCLUSIVE, never a reason to revert. Git filters and credential
  helpers configured in MAIN's own config are trusted as the user's; the harness only forces hooks and
  fsmonitor off. Only the system under test gets isolated state (`$RUN/agent`, `$RUN/home`,
  `$RUN/sessions`); harness workers use your harness's normal state, which the report discloses, so never
  claim full-state isolation.
- **Mixed files.** `CLAUDE.md`, `CONTRIBUTING.md`, `pi-config/README.md` and the two design-skill files
  may carry unrelated edits in the frozen bytes. The design skill's own audit is not in the inventory; it
  may depend on unrelated uncommitted design files.
- **Simulation.** Tier A supplies the discipline by system prompt and points `$core` at the checkout by a
  harness note; it shows what the text drives a model to do, not what an installed pi session does. Only L
  is integration, and L depends on caller credentials.
- **Documented tool limits not exercised as failures:** a parent directory swapped for a symlink between
  check and open, and hostile writers on the same machine, are out of scope by the tools' own statement;
  draft evidence is per ID, not transitive (DR-EV-6); conflicts are whole-file; the manifest is reformatted
  on promotion (DR-PR-12).
- **Model variance.** One ACT run per row detects defect classes, not rates. Repeat a failing ACT once
  with a fresh actor before calling it FAIL; report both runs.
- **Environment.** Paths, pi version (0.87.0 while writing) and Node version (25.2.1) are recorded, not
  assumed; T-SMOKE and C rows use the globally installed pi runtime.

## Appendix: a committed candidate

If the feature is committed (a branch or commit `C` holding exactly the candidate), skip the freeze: `git
-C "$MAIN" $GITP worktree add --detach "$CO" C` (as in S4), then confirm `.sova/spec/{pilot,reviews,drafts}`
are absent (they are ignored, so a clean checkout lacks them). ISO-2 becomes "`git -C $CO $GITP rev-parse HEAD` =
`C` and `git -C $CO $GITP status --porcelain` is empty". Everything else is unchanged,
and the guard still runs, because MAIN may still be live.
