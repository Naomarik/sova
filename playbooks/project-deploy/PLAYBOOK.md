---
title: Project deploy
approves: deploy
description: Writes how this project ships, the deploy section of .sova/project.json, from the operator's own answers: each target, its exact commands as argv, its credentials by name, how it is verified and undone. Never runs any of it.
promptHint: Which targets you ship to and anything Sova can't see: where each lives, which machine or account, what must never happen there.
---

# Project deploy

You write how this project ships: the `deploy` section of `.sova/project.json`, on a branch, from what the operator tells you. A deploy reaches every user and often can't be taken back, so nothing in it is a guess: every target, command, credential, check and rollback you write traces to an answer the operator gave in this session. You read the repository only to offer candidates. You never run a deploy, a plan, a build, a credential check, ssh, or any command that reaches a target. The operator approves each resolved step on Sova's review and merges; you never do.

Paths here are relative to this playbook's folder. `scripts/project-deploy.mjs` does the mechanical reading: run `node scripts/project-deploy.mjs <command> --root <your checkout>` and read its digest. Exit 0 is fine, 1 is something to act on, 2 is "couldn't tell": treat 2 as not fine. Read `references/deploy.md` before you write anything.

## Where you work
- Your checkout is a worktree on its own branch, never the main checkout. A run started from the project page already is one. Started anywhere else: check `git worktree list`; in the main checkout, cut a worktree first (the `worktree` tool, `create project-deploy`) and work there.
- Read the project at HEAD. The main checkout's uncommitted edits are not the project.
- The only verbs you call are `project_verbs {verb: "deploy.status"}` and `project_verbs {verb: "deploy.check", ref: "<your branch>"}`: both read. Every other deploy verb is the operator's.

## Ask before you write
You run with `align` on, and the operator answers you. Your first act after reading the state is an `align` interview, and you write nothing until it is answered. Ask, with what you found as options and your recommendation where the repository supports one:

1. **Targets**: which places this project ships to (production, staging, a docs site…), a name for each, and one sentence on what each is.
2. **Branch**: for each target, the branch a commit must be on to ship there (default: the main checkout's).
3. **Steps**: for each target, the exact commands, in order, as the operator runs them today. Offer every candidate `candidates` found (a package.json script, a bb or make task, a deploy script), quoted as it reads in the repository, and ask which one is real, in what order, with what arguments. A shell pipeline becomes a script under `.sova/bin/` only when the operator agrees, and its text is then part of what they approve.
4. **Build**: what must be built first, and whether it builds in the fresh checkout Sova cuts (it always does: say so).
5. **Addresses**: every host, user, path or URL a step names becomes a host variable `${host.NAME}`. Ask for the name of each; its value is set on this host by the operator (Sova's `host.json`), never in the repository.
6. **Credentials**: for each target, every credential a step needs, by name and kind (`env`: a value Sova keeps for this host and hands to the steps; `ssh`: a key in the operator's ssh setup; `tool-login`: a tool's own login, like `wrangler login`), and the read-only command that proves it works (`ssh -o BatchMode=yes deploy@${host.PROD_HOST} true`, `wrangler whoami`). Never ask for a secret's value, and never write one.
7. **Verify**: the URL that answers when the target is healthy, and the status it answers (default 200); or none.
8. **Rollback**: how a bad deploy is undone: its own steps, deploying the previous verified commit again (`redeploy-previous`), or it can't be (`none`, with the operator's reason, word for word).
9. **Tests**: what must pass before it ships: the smoke selection, the full suite, or none.
10. **Plan steps** (optional): read-only commands that show what a deploy would change without changing it (`rsync --dry-run`, `terraform plan`). Only ones the operator names.

Ask one question per decision. The answer arrives as the next message; carry on from there. Ask again whenever an answer leaves a field open; never fill one from the repository alone. Never ask for approval or a merge: those are the operator's buttons, after your report.

## Steps
1. **State.** `project_verbs {verb: "deploy.status"}`; the definition at HEAD (`.sova/project.json`, its `deploy` if any); the run's reason is the text after `---` in this message, if any.
2. **Candidates.** `project-deploy.mjs candidates`: the deploy entrypoints the repository holds, read, never run. Read each one it lists (the script's text, the task's body) so you can quote it.
3. **Interview** (above), and end your turn until it is answered.
4. **Write**, on your branch only, exactly what the answers say:
   - the `deploy` section (`references/deploy.md`), every command an argv, never a shell string;
   - each host variable's name in the top-level `host` list;
   - a script under `.sova/bin/` only where the operator agreed to one.
   Keep the rest of the definition byte for byte as it is: the services are the Project verbs playbook's.
   When a `deploy` already exists, change only what the answers changed.
5. **Check.** `project-deploy.mjs fmt`, then `project-deploy.mjs check` until it exits 0 (a `problem:` must be fixed: a literal address, a shell string, a value that looks like a secret). Commit by explicit path: `git add .sova/project.json <each script>`, `git commit -m "Project deploy: <what>"`.
6. **Prove offline.** `project_verbs {verb: "deploy.check", ref: "<your branch>"}`: the recipe parses, every program resolves in a fresh checkout, every host variable and env credential is set on this host (presence only). It contacts no target and runs no step. A missing host value or credential is not yours to set: list it in the report for the operator. At most 3 runs.
7. **Report** (below), and end your turn.

## Never
- Run a deploy, plan, build, rollback, verify or credential check, by any means: no `ssh`, `rsync`, `scp`, `curl` to a target, cloud CLI, `npm run deploy`, `bb deploy`, `make deploy`.
- Write a value: an address, a user, a key, a token, a password. Names only.
- Write a field no answer settled, or keep a candidate the operator didn't confirm.
- Touch the services, the main checkout, or its running processes; push, approve or merge.

## Report
- `Targets`: one block each: name — about · branch · tests; its steps in order as argv; credentials (name · kind · check); verify (URL · status, or none); rollback.
- `Trace`: each field you wrote and the answer it came from (quote the operator's words).
- `Host values to set`: each `host` name and each `env` credential this host lacks, from `deploy.check`, for the operator to set in Sova's `host.json`.
- `Check`: `deploy.check` pass or fail, runs used of 3, the deploy hash (first 12 hex).
- `Next`: "Approve & Merge {hash12} on the project page: tick each step on its review first."

End with a line that needs no reading of the rest: `Proposes deploy {hash12} for {targets}.`, or, when you changed nothing, `No change: the deploy recipe matches the answers.`
