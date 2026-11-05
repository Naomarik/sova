# Worked example: a Clojure web app shipped to one VPS

A different stack from Sova's, on a real repository's shape (names and addresses left out). It shows
the method on a project whose **services and deploy are already declared** but whose landing and
releases are not: the Setup chat's first message draws what is there, then it works as a first setup
of the missing halves. Every number below is one the chat measures; this page gives none.

## What the investigation finds

- **Stack**: a Clojure backend (`deps.edn`, a `build.clj` uberjar), ClojureScript (`shadow-cljs.edn`,
  npm for its JS deps, `package-lock.json`), Sass, babashka tasks (`bb.edn`: `test`, `fmt:check`,
  `skill:check`, `build`, `sass:build`, a `prod:*` family), Kaocha (`tests.edn`, with a pre-load
  test-safety hook and `:live` tests skipped by metadata), `mise.toml` pinning only Java.
- **No CI** and **no tags, no changelog**; version strings in `package.json` and `build.clj` (a
  `-SNAPSHOT`). `origin` is on GitHub, so Sova suggests a pull request; the history shows plain merges
  into `master` by one person.
- **Services, already declared**: `web` (app + nREPL + a preview port), `cljs`, `sass`, an on-demand
  `test-repl`; a `store` data hook giving each copy its own database name and cache prefix on shared
  datastores; `setup` steps `local-files` (makes the copy's gitignored `.env` from the main
  checkout's) and `clj-deps` (`clojure -P` for every alias); `test` = `.sova/bin/test` (a babashka
  client running clojure.test in the copy's warm `test-repl`), `requires: ["test-repl"]`, 900 s,
  five smoke namespaces; `share` of the preview port only.
- **Deploy, already declared**: one target `prod` on `master`, smoke tests at plan, an `ssh`
  credential checked with `BatchMode`, build `jar`, steps `upload` and `swap-restart`, a `verify`
  of `https://${host.SITE_URL}/api/health`, rollback `swap-back`, all through one script
  `.sova/bin/deploy-prod` with subcommands. Host names `PROD_HOST`, `PROD_DIR`, `SITE_URL`; no values
  in the repository.
- **The queue today**: no `merge` section but a `test` command, so a listed project is already served
  by the fallback: every landing runs `.sova/bin/test` alone. `draw` shows exactly that.

## The traps a merge copy would hit, found by reading, then proven by a trial

1. **mise refuses an untrusted checkout.** A check takes no `env`, so `["bb", "fmt:check"]` would fail
   in the merge copy once `clojure` needs the mise-pinned Java. The project already has the pattern:
   its launchers (`.sova/bin/test`, `.sova/bin/setup`, …) export `MISE_TRUSTED_CONFIG_PATHS` and then
   exec the real script. A new check follows it (`.sova/bin/check <name>`), never a bare `bb` argv.
2. **Code outside the repository.** Two libraries are `:local/root` dependencies at absolute paths
   in sibling checkouts (and `bb.edn`'s own `:deps` names one). Every landing's result then depends on
   whatever those checkouts hold at that moment, not on the commit. Not fixable by the chat; it is a
   question (below), and the drawing marks the tests row with it.
3. **Secrets.** `local-files` copies the main checkout's `.env` (API keys) into each copy, the merge
   copy included, because `setup` runs there. The tests' safety hook and the `:live` skip keep model
   calls out; `test:all-llms` and `models:audit` reach providers and are never checks.
4. **A project rule written before Sova's deploy.** Its `AGENTS.md` says to deploy only from the main
   checkout after a push; the declared target already does the Sova form of that (a fresh checkout of a
   pushed commit on `master`). Nothing to change; the chat says so rather than "fixing" either.

## What it measures, in its own copy

`project_verbs up` (its own ports and database), then each candidate twice with the clean environment,
recording argv, cold and warm time, exit and counts: `.sova/bin/test` (the whole suite: no selector),
`bb fmt:check`, `bb skill:check` (fails when generated design-skill files differ from a fresh build),
`bb sass:build`, `bb build` (the uberjar: frontend, Sass and jar). It never runs `prod:*`, `deploy-prod`,
`test:all-llms`, `models:audit`, or anything that tunnels to the box.

## What it asks (one interview), each with its recommendation

- **Checks**: required `tests` (`.sova/bin/test`, `requires: ["test-repl"]`, `rerun` left off since
  failures name namespaces, not files) and `fmt` (fast, catches what review would); optional
  `skill` (`bb skill:check`), picked when `resources/sass/**` or the skill sources change; the uberjar
  build at release, not per landing (it costs minutes and rarely breaks alone). Each with the times
  measured.
- **The sibling libraries**: accept that landings test against their current state (and say so in
  the plan), or pin them (a `:git/sha` coordinate) before relying on the queue. Recommend: accept for
  now, and record their heads in the deploy record as the deploy script already does.
- **How it lands**: recommend **Merge locally** (one person, plain merges in the history), not the
  pull request `origin` suggests; push to `origin` after each landing, once the private names are set
  up.
- **Releases**: recommend **none yet**: every pushed `master` commit is deployable, the box keeps the
  previous jar for rollback, and nobody else installs it. If the user wants them anyway: tag-only,
  `calver`, no channel, the uberjar build and the whole suite as `release.checks`, and `prod` taking
  releases only (`releases: "only"`, a deploy change they confirm).
- **Deploy**: no change asked; the chat confirms the drawing of the declared target and asks only
  "anything that must never happen there that the script doesn't guard yet?" (it already refuses a
  restart while generation permits are held).

## The proposal (after the answers: two required checks, one optional, no releases)

On its branch: `.sova/bin/check` (a launcher like the others: `fmt` → `bb fmt:check`, run on every
branch since it is fast; `skill` → `bb skill:check`, writing `SOVA_OUT` with a skip reason when none
of its paths changed), and the `merge` section:

```json
"merge": {
  "target": "master",
  "checks": [
    {"id": "fmt", "label": "Format", "run": [".sova/bin/check", "fmt"], "timeout": 300},
    {"id": "tests", "label": "Tests", "run": [".sova/bin/test"], "timeout": 1200, "requires": ["test-repl"]},
    {"id": "skill", "label": "Design skill in sync", "run": [".sova/bin/check", "skill"], "timeout": 600, "optional": true}
  ],
  "install": {"run": ["npm", "ci", "--offline", "--no-audit"], "inputs": ["package-lock.json"], "timeout": 600}
}
```

The limits stand for twice the warm times the chat measured. `install` is there because the
`local-files` setup step copies the main checkout's `node_modules` only when the copy has none, so a
branch that changes `package-lock.json` would otherwise be checked against the old packages. And
`.sova/playbooks/merge-queue/PLAYBOOK.md` with a blast-radius map whose one rule picks `skill` on its
paths, plus what is worth noting on a landing here ("touches `deps.edn`: restart `test-repl` and the
app"). Services, `test`, `share` and `deploy` stay byte for byte, so no conformance is needed.

Then `fmt`, `check --base master` (0), commit by explicit path, `merge.try` on the head, a fix if the
trial finds one (the usual: a launcher missing its mise line), a trial again. In the trial `skill`
skips (the changed list is empty), so the chat also runs `.sova/bin/check skill` in its worktree with
`SOVA_MERGE_BASE` at the merge base and a change under its paths, and reports both. Then the proposal: the
drawing with "Landing" and "Required checks" marked changed, the measured times, the trial's result,
the open note about the sibling libraries, and Land (offered now that the head passed; the project
is already served through its `test` fallback, so it lands through the queue, checked by that
fallback, and from then on every branch runs the new list).

## Review of this example against its rules

- Every command quoted is one the repository holds; nothing was inferred or run against the box.
- Nothing names a host, a user, a path in a home, a token or the project: host values stay names.
- The services half is untouched, so the trial and the queue need no new conformance.
- The checks follow the "what a check sees" rules: no env, no host value, a launcher for mise,
  `requires` for the REPL, skip reasons through `SOVA_OUT`.
