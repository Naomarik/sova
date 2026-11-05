# `.sova/project.json`: every section the Setup chat writes or keeps

One JSON file at the checkout's root, `"version": 1`, parsed strictly by Sova's own parser
(`shared/project-contract.ts`, which `scripts/project-setup.mjs check` runs): an unknown key, a wrong
type, a bad name, a dangling `requires`, a shell string where an argv belongs or an unknown template
variable makes the **whole file** invalid, naming the JSON path of the first problem. A file that
doesn't parse on the target holds every landing (`Definition invalid`), so you never leave one.

Rules for every section:
- **Names** (services, checks, targets, steps, data): lowercase letters, digits and hyphens, starting
  with a letter, at most 31 characters, unique where they sit.
- **Commands are argv arrays** of non-empty strings, never a shell string. A pipeline, a `cd`, an `&&`
  or a redirect goes in a script under `.sova/bin/` (executable, `#!/bin/sh` or the project's own
  runtime) and the definition runs that script.
- **No values that identify a person, host or secret**: no IP, hostname, user@host, home path, token
  or password. A deploy names them as `${host.NAME}`; a check never needs one.
- **Canonical form**: `project-setup.mjs fmt` (2-space JSON, keys in the contract's order, names in
  declaration order). `check` refuses a file that isn't.
- **Keep what you don't change byte for byte.** Reconcile, never regenerate.

Top-level keys, in canonical order: `version`, `slots`, `host`, `sources`, `setup`, `data`, `services`,
`open`, `hooks`, `test`, `share`, `deploy`, `merge`, `release`.

## The two halves and their hashes

| Part | Keys | Hash | Proof it works |
|---|---|---|---|
| **Services** (how a copy runs) | `slots`, `setup`, `data`, `services`, `hooks`, `test`, `share` (+ `host`) | the definition's hash (every `timeout`, `about`, `isolation`, `sources`, `open`, readiness `path` left out) | `project_verbs conform {ref}` |
| **Pipeline** (how it lands, releases, ships) | `merge`, `release`, `deploy` | outside the definition's hash; `deploy` has its own (the deploy hash) | a trial (`merge.try`) for `merge` and `release.checks`; `deploy.check` for `deploy` |

So a pipeline change keeps every conformance proof of the project's copies standing. A change to the
services half needs a new conformance before copies run it: when your setup needs one (a check that
requires a service the project doesn't declare yet, a `test` command), do that part by the Project
verbs method (`../project-verbs/PLAYBOOK.md` and its `references/contract.md`, `isolation.md`,
`recipes.md`): it is the full contract for services, and this file only summarises it.

## Services, in one screen (the full contract: `../project-verbs/references/contract.md`)

- `setup`: steps `{id, run, inputs?, timeout?}` run at create, and **in the merge copy before every
  run's checks**, in order; skipped while the rendered argv and the hash of `inputs` are unchanged.
  This is where a fresh copy gets what it lacks: dependencies (`npm ci`, `clojure -P`), a gitignored
  local config copied from the main checkout (`.sova/bin/setup` doing `cp -n "$SOVA_MAIN/.env" .`),
  a generated file the code reads at load. `timeout` default 120 s, at most 1800.
- `data`: per-copy data, `{kind: "dir", path?, from?, sensitive?}` or `{kind: "hook", provision,
  deprovision, timeout?, sensitive?}`. `sensitive: true` when its contents come from production.
- `services`: `{name: service}`, each exactly one of `cmd` (argv) and `static` (a folder Sova serves);
  `ports` (`{base, stride?}` or `{fixed}`), `env`, `requires`, `ready`, `reload`, `build`, `scope`,
  `container`, `start` (`"on-demand"`: only when named or required, e.g. a test REPL or a database a
  check needs), `about`, `isolation`, `adopt`, `onMerge`. Absent or empty is valid: a library, or a
  project the queue only checks.
- `test`: `{run, requires?, timeout?, smoke}`: the project's test command, selectors appended;
  `requires` names the services a run needs; `smoke` 1–50 selectors green on main. Deploy targets
  that require tests need it.
- `share`: `{endpoints, maxDays?, allow?}`: the ports a stakeholder may open through a preview link;
  `{"allow": false}` when nothing is for a stakeholder or any data is sensitive.
- `host`: names (`A-Z0-9_`) of host variables kept on this host (Sova's `host.json`), read as
  `${host.NAME}` by services and deploys. Never their values.

## `merge`: how a branch lands

The queue merges each approved commit onto the newest `target` in a merge copy beside the project
(`<parent of the main checkout>/.worktrees/<repo>-merge`), runs `setup`, the install when needed, the
spec land when the project has a spec, the checks and the review there, and only then moves the
target (or opens a request). **The queue reads this section from the target's head, never from the
branch being landed.**

| key | value |
|---|---|
| `target` | the branch branches land on; default the main checkout's branch |
| `push` | `true` / `false`: push the target to `origin` after each landing; default: push when an `origin` exists |
| `checks` | 1 to 30 checks in run order, at least one not `optional`; or `"none"` (the project has no automated tests: every landing reads "No checks declared"). Absent: the queue falls back to `test.run` with its `requires`; with no `test` either, the project isn't served |
| `install` | `{run, inputs, timeout?}`: run in the merge copy only when a branch changes one of `inputs` (the lockfiles); make it offline/frozen (`pnpm install --frozen-lockfile --offline`, `npm ci --offline`, `bundle install --local`, `poetry install --no-root --sync`, `cargo fetch --locked --offline`). `inputs` must exist; `timeout` default 120, at most 1800 |
| `review` | a review kit's folder (relative; holds `PLAYBOOK.md`): a read-only reviewer chat reads each branch with it, beside the checks. Absent: no review step |
| `land` | `"local"` (default: the target fast-forwards to the tested commit), `"github-pr"`, `"gitlab-mr"` or `"push-branch"`. A choice saved on this computer wins over it. **Releases need `local`** |
| `request` | the request kit's folder: how a pull/merge request's title and body are written. Only with a request `land` |

**A check**: `{id, label?, run, timeout?, rerun?, requires?, optional?}`.
- `id`: a name, unique among the checks (and among the release's own).
- `label`: what the queue shows, 1–60 characters, default the id.
- `run`: an argv. Templates: the definition's own (`${checkout}` is the merge copy, `${main}` the main
  checkout, `${slot}`, `${data}`, `${ports.<svc>.<port>}`) plus `${merge.base}`, `${merge.tip}`,
  `${merge.target}`. `${host.NAME}` renders **empty** in a check and `${branch}` is empty: a check
  never depends on a host value.
- `timeout`: seconds, default 600, at most 1800. Set it to about **twice the time you measured**;
  a check that can't finish in 30 minutes is split (by group, by package) or made optional.
- `rerun` (`true`) only when its failures name test files and `run` followed by those files reruns only
  them: then a red file is rerun alone, then on the target alone, to place the blame (flaky, the
  target's, or the branch's). A check whose runner names no files (a build, a typecheck) leaves it off.
- `requires`: services of `services` brought up in the merge copy, in its own slot and ports, before
  the check, and stopped after the checks.
- `optional: true`: out of the required set; runs only when the merge thread picks it for a branch
  (by the project's blast-radius map in `.sova/playbooks/merge-queue/`, or its judgement).

**What a check sees.** It runs in the merge copy (cwd its root) with an allow-list environment:
`PATH`, `HOME`, `USER`, `LANG`, `TZ`, `TMPDIR`, the XDG dirs, `MISE_*`, plus `SOVA_V`, `SOVA_SLOT`,
`SOVA_CHECKOUT`, `SOVA_MAIN`, `SOVA_DATA`, `SOVA_VERB=merge`, `SOVA_PORT_<SVC>_<PORT>`,
`SOVA_MERGE_BASE`, `SOVA_MERGE_TIP`, `SOVA_MERGE_TARGET`, `SOVA_MERGE_CHANGED` (a file listing the
changed paths), `SOVA_MERGE_PICKED=1` when the thread picked it, `SOVA_OUT` and `SOVA_LEAK_NAMES`.
**No secret and no chat variable reaches it**: a test that needs an API key reads it from a
gitignored file a `setup` step copies from the main checkout, or it is not a landing check. A check
writes its counts to `$SOVA_OUT` as JSON, `{"passed": n, "failed": n, "skipped"?: n | "<why>",
"failures"?: [{name, message?, file?, line?}]}`; one with nothing to do for this change exits 0 and
writes `{"passed": 0, "failed": 0, "skipped": "<why>"}` (a lint of changed files when none changed).
Without a report only the exit counts.

**Examples.** A Node project with a frozen install, a typecheck, unit tests that rerun per file, a
build, and an end-to-end suite picked only when the UI changed:

```json
"merge": {
  "target": "main",
  "push": true,
  "checks": [
    {"id": "typecheck", "label": "Typecheck", "run": ["npm", "run", "typecheck"], "timeout": 300},
    {"id": "unit", "label": "Unit tests", "run": ["npx", "vitest", "run"], "timeout": 900, "rerun": true},
    {"id": "build", "label": "Build", "run": ["npm", "run", "build"], "timeout": 600},
    {"id": "e2e", "label": "Browser tests", "run": [".sova/bin/e2e"], "timeout": 1800, "requires": ["web"], "optional": true}
  ],
  "install": {"run": ["npm", "ci", "--offline", "--no-audit"], "inputs": ["package-lock.json"], "timeout": 600}
}
```

A Python service whose tests need its Postgres (an on-demand service of `services`), landing by pull
request:

```json
"merge": {
  "checks": [
    {"id": "lint", "label": "Ruff", "run": ["uv", "run", "ruff", "check", "."], "timeout": 120},
    {"id": "types", "label": "Mypy", "run": ["uv", "run", "mypy", "src"], "timeout": 600},
    {"id": "tests", "label": "Pytest", "run": ["uv", "run", "pytest", "-q"], "timeout": 1200, "rerun": true, "requires": ["db"]}
  ],
  "install": {"run": ["uv", "sync", "--frozen", "--offline"], "inputs": ["uv.lock", "pyproject.toml"], "timeout": 600},
  "land": "github-pr"
}
```

A project with no tests yet (it says so once; landings read "No checks declared"):

```json
"merge": {"checks": "none"}
```

## `release`: how the project releases

A pointer to the project's release playbook plus only the facts Sova acts on itself. Absent: releases
aren't set up. Sova reads it from the target's tip. The full method, the step list and what its check
refuses: `../release-maker/references/release.md`; the release chat's general method:
`../release/PLAYBOOK.md`.

| key | value |
|---|---|
| `playbook` | required: the project's release playbook folder (relative, never `.`), holding `PLAYBOOK.md` and `release.json`; usually `.sova/playbooks/release` |
| `tag` | the numbered tag's pattern, `${version}` exactly once and no other variable; default `v${version}`. Sova makes it at Publish and never moves it |
| `scheme` | `semver` (default: X.Y.Z, optional `-pre`), `calver` (YYYY.MM, optional .DD and .N) or `none` (any tag-safe word) |
| `channels` | 0 to 3 moving tags Publish moves to each release (`stable`), each once, never shaped like a numbered tag; Withdraw moves them back |
| `commit` | `true` (default): the release makes a commit (its `commit` prepare step) that lands through the queue; `false`: tag-only, the release is of the target's tip at Start |
| `checks` | at most 20 gating checks run on the release entry **after the landing's required checks**: a merge check's id as a string (an optional one included; needs `merge.checks` to be a list), or `{id, label?, run, timeout?, rerun?, requires?}` declared here (never `optional`, never a merge check's id). A failed one holds Publish; nothing overrides it |
| `quietMin` | 5 to 1440 (default 30): minutes without a report from the release chat, while the target is frozen, before Needs you says so |

Whether Publish pushes follows the queue: one atomic push of the target, the tag and the channels to
`origin` unless `merge.push` is `false` or there is no `origin` (then it tags on this machine only).

`release.json` beside its `PLAYBOOK.md`: `{"v": 1, "steps": [{id, label, phase, held?, artifact?}]}`,
at most 30 steps, listed in phase order `prepare` → `check` → `after` → `withdraw`; `checks`,
`publish`, `withdraw`, `abandon` are Sova's own ids. With `commit: true` the last prepare step is
`commit`; with `commit: false` there is none. `held: true` ends the step held until the operator's
Continue; `artifact: true` must report a built file kept outside the repository or under an ignored
path. The project's `PLAYBOOK.md` names every step id in backticks with its exact commands.

With the Node project's `merge` above (its optional `e2e` named by id, plus one check of its own):

```json
"release": {
  "playbook": ".sova/playbooks/release",
  "tag": "v${version}",
  "scheme": "semver",
  "channels": ["stable"],
  "commit": true,
  "checks": ["e2e", {"id": "package", "label": "Package builds", "run": ["npm", "pack", "--dry-run"], "timeout": 300}]
}
```

## `deploy`: how the project ships

`deploy` holds one key, `targets`: `{<name>: target}`, 1 to 10 targets in declaration order. Every command an argv; every address, user and path
on a target `${host.NAME}` with `NAME` listed in the top-level `host`. The full table and the plan/run
lifecycle: `../project-deploy/references/deploy.md`; recipe shapes per kind of target:
`targets.md` here.

| key | value |
|---|---|
| `about` | what it is, one sentence ≤ 200 characters, no template |
| `branch` | the branch a commit must be on (and pushed) to ship here; default the main checkout's |
| `releases` | `"only"`: only a published, not withdrawn, numbered release's commit ships here |
| `requires` | `tests`: `"smoke"`, `"full"` or `"none"`, default `smoke`; any but `none` needs `test` |
| `credentials` | a list, each `name` (once), `kind` and `check`: `env` (a variable name whose value is set on this host and handed to every step, redacted from logs; never `SOVA_…`), `ssh` (the operator's ssh setup), `tool-login` (a CLI's own login); `check` a read-only argv whose exit 0 proves it, run at plan |
| `plan` | optional read-only steps run at plan: a dry run (`rsync -n`, `terraform plan`, `kubectl diff`) |
| `build` | optional steps run before `steps` |
| `steps` | 1 to 30 `{id, run, timeout?}` run in order in a fresh checkout of the exact commit; `timeout` default 600, at most 1800 |
| `verify` | optional: `http` a URL (template) that must answer `expect` (default 200) within `timeout` (default 30) after the steps |
| `rollback` | required: `{steps: […]}`, `"redeploy-previous"`, or `{none: "<the operator's reason>"}` |

Deploy templates read only `${host.<NAME>}`, `${commit}`, `${target}`, `${checkout}`, `${branch}`;
`$$` is a literal `$`.

## How you validate what you write

In this order, every time, before you commit:
1. `node scripts/project-setup.mjs fmt` (rewrites `.sova/project.json` and the release playbook's
   `release.json` canonically).
2. `node scripts/project-setup.mjs check --base <the target>`: Sova's parser on the whole file, then
   per section what it can't see (merge: shell strings, literal addresses, secrets, home paths,
   missing review/request/install files, a release on a project that lands by request; release:
   `release-maker check`'s scan of the playbook folder; deploy: `project-deploy`'s lints). Exit 0
   before you commit. A `problem:` is fixed; a `note:` is read and, where it asks, told to the user.
   With `--base`, a problem already on the target in a section you don't change is a note: tell the
   user, fix it only if they agree.
3. Commit by explicit path.
4. Prove each part the way it runs:
   - merge checks and release checks: a trial of the branch's head, `merge.try`
     (`behaviour.md`, "Trials"), until it passes. It runs every merge check, but a release check only
     when it is new or changed against the target's, or named in the trial's `checks`;
   - deploy: `deploy.check {ref: <your branch>}` (at most 3 runs);
   - services you changed: `conform {ref: <your branch>}` (the Project verbs method's limits).
