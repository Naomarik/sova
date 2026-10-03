---
title: Project verbs
description: Declares how this project runs in .sova/project.json, so every worktree gets its own isolated running copy: chooses isolation per service, writes the definition, hooks and a minimal app adapter on a branch, and proves it with conformance.
promptHint: Why you are running it (first onboarding, or what changed), and anything Sova can't see: services you never start, data that must not be copied, ports to keep clear.
---

# Project verbs

You make this project runnable by Sova's project verbs: one running copy per checkout, each with its own ports and data, so coding sessions build features side by side without touching each other or the main checkout. You write `.sova/project.json` and what it needs, on a branch, and prove it with `conform`. The operator approves and merges; you never do.

Paths here are relative to this playbook's folder. `scripts/project-verbs.mjs` does the mechanical reading: run `node scripts/project-verbs.mjs <command> --root <your checkout>` and read its digest. Exit 0 is fine, 1 is something to act on, 2 is "couldn't tell": treat 2 as not fine, never as 0. Read `references/contract.md` before you write the definition and `references/isolation.md` before you choose isolation; `references/recipes.md` has the usual moves per stack (ports, datastores, local config, test runners), and `references/examples/` three worked definitions.

## Where you work
- Your checkout is a worktree on its own branch, never the main checkout. A Project verbs run started from the project page already is one. Started anywhere else: check `git worktree list`; in the main checkout, cut a worktree first (the `worktree` tool, `create project-verbs`) and work there.
- Read the project at HEAD. The main checkout may have uncommitted edits: they are not the project, and the definition must not depend on them.
- Every run of the project's code goes through `project_verbs`. Before the operator approves, `conform` is the only verb that runs your definition (confined: a private network namespace, the sandbox's files rule); `up` and `test` answer `not-approved`, and that is expected.

## Steps
1. **State.** `project_verbs {verb: "status"}` and `{verb: "doctor"}` for the project; the run's reason is the text after `---` in this message, if any.
2. **Plan.** `project-verbs.mjs plan`. With a valid definition at HEAD and exit 0, nothing points at a change: unless the reason names one, or doctor or the last conform report shows one, make no edit and no commit and end with exactly: `No change: the contract matches the project.` Otherwise its lines are your work list: read each changed source's diff since the definition's last commit (`git diff <commit> HEAD -- <path>`); when none of it changes what runs (a new deploy task, a comment, a dependency the services don't use), make no edit and no commit and end with the same line: Sova then adopts the sources as they are now.
3. **Inspect.** `project-verbs.mjs inspect`. Then read what it points at: CLAUDE.md / AGENTS.md / README, the stack files, the tasks that start the app, its datastores and its tests, and every file where a port literal you will move lives.
4. **Decide**, per service, what runs and how it is isolated (`references/isolation.md`). Declare only what a builder needs to run, see and test the app: its servers, the datastores they use, asset watchers its pages need, and its test REPL as an on-demand service. Never a deploy, prod, mobile release, tunnel or backup task. Record each choice as `isolation: {method, why}`, and the files you derived it from as `sources`. Mark a data resource `sensitive: true` when its contents derive from production: inspect's "production data" lines (a task that clones, downloads or restores prod), a database whose id or name says prod (a transactor or server log line, a dump's name), a restore from a production backup. When unsure, mark it and say why.
5. **Write**, on your branch only:
   - `.sova/project.json`. Reconcile, never regenerate: when one exists, keep every service, key, order and sentence the sources don't contradict; add, change or remove only what changed.
   - Project scripts under `.sova/bin/` (executable, `#!/bin/sh` or the project's own runtime): a wrapper that renders a config from `SOVA_PORT_*` / `SOVA_DATA` and execs the program, the setup step that brings gitignored local config into a fresh worktree, the `test` runner that writes `SOVA_OUT`, and the isolation `probe` hook.
   - The minimal app adapter: each port, URL or data path the app hard-codes becomes an env read **with today's literal as its default**, so the main checkout (slot 0) runs exactly as before. Nothing else in the app changes.
   - `test`: the project's test command, its `smoke` selection (small, fast, green at HEAD), and the on-demand services it requires. When no selection is green at HEAD (the suite is red, or every test needs the network or production data), declare no `test` and say so in the report; never a test that proves nothing.
   - `about` on each service with ports: how a builder uses it, with its real port as a template.
   - `share.endpoints`: only the ports a stakeholder should open in a browser (the app's web page, a public API it calls), as `"<service>.<port>"` of checkout services. Never a REPL, nREPL, shadow-cljs, debugger, metrics, database or admin port, and never a shared service. With any `sensitive` data resource, or when nothing is for a stakeholder to see, declare `share: {"allow": false}` and say why in the report.
   - `onMerge: "reload"` only on a service the operator asked to follow main (a server people check after each merge, whose reload is cheap and drops nothing): Sova then reloads it on the main checkout's running copy each time main's HEAD moves. Off by default; never on a REPL, a long-running job or a datastore.
   - **Silence outbound sends when any data resource is `sensitive`** (a copy of real users' data must never message them). Find every channel in config and code: push notifications, chat bots (Telegram, Slack…), SMS/WhatsApp, email, webhooks, payment and other third-party calls. Route each send through one switch, `SOVA_SILENCE_OUTBOUND`: set to anything but `0` or empty, the send returns a stand-in answer and nothing leaves the host. Set it to `${slot}` in every service's `env`, so slot 0 (the main checkout) sends as before. Add a test to the `smoke` selection that fails when `SOVA_SLOT` is not 0 and the switch is off, and that calls every send path with each transport replaced by one that throws. `references/recipes.md` has the pattern.
   - One sentence in CLAUDE.md (or AGENTS.md, whichever the project has): "Ports above are the main checkout's; in a Sova worktree use the ports in Sova's instance note, and run tests with project_verbs test."
6. **Check.** `project-verbs.mjs fmt`, then `project-verbs.mjs check` until it exits 0 (a `note:` is advice, a `problem:` must be fixed). Commit by explicit path: `git add .sova <each adapted file>`, `git commit -m "Project verbs: <what>"`.
7. **Conform.** `project_verbs {verb: "conform", ref: "<your branch>"}`. On a failure read its error code, the failing check's detail and `conform.logs` (the last lines of each service that was not ready and of a failed step), fix the cause, check, commit, and run it again. **At most 6 conform runs** in this session; after the sixth failure stop and report. A conform that answers `not-approved` (a container service, a data folder copied from outside the project or from a hidden path, or a host that can't confine) ran nothing: fix the definition if you can (keep data `from` inside the project), else report the refusal word for word instead of looping.
   **Guard:** with a sensitive resource, propose nothing until a confined conform passed with the silencing test in `smoke`. If you can't verify the silencing (a channel you can't route through the switch, a send you can't make throw in a test), stop and say exactly which, and never ask for approval.
8. **Measure.** The passing report's `memory` gives each service's steady and peak resident memory, and each scratch instance's total. Report it as measured; never estimate.
9. **Report** (below), and end your turn.

## Traps seen in real projects
- **The main checkout is not HEAD.** Its uncommitted edits (a new test alias, a classpath fix, a changed script) are what makes some commands work there; a fresh worktree at HEAD lacks them. Prove every command you declare from HEAD's files, and when HEAD lacks something, add it on your branch and say so.
- **Gitignored files the code needs.** A file a task generates and the code reads at load (a version stamp, compiled assets) or a local config the tasks read is missing in a fresh worktree: a setup step generates or copies it (`references/recipes.md`).
- **Tests that start the app.** A test fixture that boots the dev system binds the app's ports and opens its datastores: give the test service the copy's own env and require the datastores. A test profile's own fixed port collides between copies too.
- **Version-manager shims refuse a fresh checkout.** With mise (`.mise.toml`), even `node` or `bb` fails there ("Config files … are not trusted"): run your own commands with `MISE_TRUSTED_CONFIG_PATHS=<checkout>` and give the definition's services and scripts the same (`references/contract.md`, Toolchains).
- **A page that needs compiled assets.** A server whose `/` fails until a watcher's first compile (an asset bundle it reads) is ready on a path that needs none (an API route, a health check); declare the watcher as a service that starts with `up`, and say so in its `about`.
- **Declare only ports something listens on while the service runs.** Conformance checks that every declared port of a running service is held by it; a port a config names but nothing opens (a disabled admin console, a port only a test fixture binds for a moment) fails that check. Leave it out, or keep it in the program's env only.
- **A selection that runs no test proves nothing.** Zero tests ran is a failure, never a green smoke.
- **Datastores copied while they run** may be inconsistent: take per-copy data from a store at rest, a dump, or a seed (`references/isolation.md`).

## Report
- `Services`: one line each: name · kind · scope · isolation method — why · ports (slot 0 → slot 1) · "reloads on merge" when it carries `onMerge`.
- `Conform`: pass or fail, runs used of 6, confined or not, suite version, the definition's hash (first 12 hex), and for a failure the check, its detail and what you would try next.
- `RAM`: per service steady / peak, and per instance total, from the report.
- `Sensitive data`: each data resource marked `sensitive` and the evidence (or "none: no production-derived data found").
- `Share`: the endpoints listed and what each shows, or `allow: false` and why.
- `Outbound silenced`: each channel found, the file and function the switch guards, and the test that proves it (or why there was nothing to silence).
- `Tests`: the command, the smoke selection and its counts.
- `Adapter`: each app file changed, and the literal it keeps as its default; and each of those files the main checkout has uncommitted edits to (Merge Branch needs them committed or set aside first).
- `Deploy entrypoints found (never run)`: what inspect listed.
- `Next`: "Approve <hash12> on the project page's Software card, then Merge Branch." (or why it can't be approved yet).

## Never
Approve a definition, merge, push or rebase. Edit, start, stop or reset the main checkout or its running processes (its datastores included). Run deploy, prod, release, tunnel or backup tasks. Start anything by hand (`&`, `nohup`, tmux, `bb tmux`, `docker run`): only the verbs start things. Copy secrets or local config into tracked files, or write `${host.…}` values into the repo. Print, copy or log a channel's credentials (bot tokens, push or API keys, SMTP passwords) anywhere: reports, fixtures, tests, commit messages, messages to anyone; read config files with such values masked. Send anything real while testing. Weaken, skip or rewrite a conformance check or the smoke selection to make conform pass.
