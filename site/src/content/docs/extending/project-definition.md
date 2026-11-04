---
title: The project definition
description: One file in your repository, .sova/project.json, says how your project runs, tests, shares, ships and lands. Sova runs each checkout from it.
group: Extending
order: 21
---

`.sova/project.json` sits at the root of the checkout it describes, so each branch carries its own.
Sova runs it as **copies**, one per checkout, each with its own ports and data. A coding agent in a
worktree gets a running copy of its own this way, apart from the others and from the main checkout.

The file is JSON with `"version": 1`, read strictly. An unknown key, a wrong type or a name that breaks
the rules makes the whole file invalid, with the path of the first problem, and nothing runs from it.
Every command is a list of arguments, never a shell string.

A static site is one service:

```json
{ "version": 1, "services": { "site": { "static": ".", "ports": { "http": { "base": 8731 } } } } }
```

## What each part is for

| Key | What it says | A change needs |
|---|---|---|
| `services` | What runs: each is a command or a static folder, with ports, what it requires, how Sova knows it's ready, and how it builds and reloads | Conformance, once it's on main. A running copy picks it up at its next `apply` or `up` |
| `setup` | Steps run when a copy is created | Conformance. A step runs again at a copy's next `create` when its command or `inputs` changed |
| `data` | Folders or hooks each copy gets its own of. `sensitive: true` means a copy holds data derived from production, and it is never shared | Conformance |
| `test` | The project's test command, what it needs running, and a small `smoke` selection that passes on main | Conformance runs the `smoke` selection |
| `hooks` | `probe`, an optional check that one copy can't see another's data | Conformance |
| `slots` | `cap`: how many copies may run at once by default. This computer's own limit, on the Branches tab, overrides it | Nothing: read from the main checkout |
| `host` | Names of values kept on this computer, never in the repository, that templates read | Each name set on this computer |
| `share` | Which endpoints a running copy may share as a preview link, and for how long. Without it, no copy is shared | Conformance checks each endpoint answers |
| `open` | Where a person opens the app | Conformance checks it answers |
| `deploy` | Where the project ships: targets only you ship to | Its own check, `deploy.check`, which proves a recipe offline and runs nothing |
| `merge` | How branches land | See [below](#merge) |
| `sources` | The files the definition was written from, such as a lockfile or compose file. When one changes, the project reads as stale | Nothing |

Templates write `${…}`, with `$$` for a literal `$`: `${slot}`, `${checkout}`, `${branch}`, `${data}`,
`${ports.<service>.<port>}`, `${host.<NAME>}` and a few more. Every process also gets them in the
environment, as `SOVA_SLOT`, `SOVA_CHECKOUT` and the like.

## Ports

A port is `{"base": 3000, "stride": 1}`, numbered per copy as base + slot × stride, or `{"fixed": 3000}`,
the same in every copy. Slot 0 is the main checkout. Which numbers a copy uses always come from the
main checkout's file, so a branch can't move them.

## `merge`

The `merge` section says how the project's branches land through its merge queue.

- `checks`: 1 to 30 checks, in order, each with an `id`, a `label` and a `run` command. Or `"none"`, for
  a project with no automated tests.
- `target`: the branch that receives work. By default, the main checkout's branch.
- `push`: whether to push after landing. By default, when the repository has an `origin` remote.
- `install`: run in the merge copy when a branch changes one of its `inputs`.
- `review`: the folder of the project's review kit.
- `land`: how a branch lands: `local` (the default), `github-pr`, `gitlab-mr` or `push-branch`. This
  computer's own choice overrides it.
- `request`: the folder of the project's request kit.

With no `merge` section the queue uses `test`. With neither, the queue isn't set up: the project's
Merge Queue tab offers **Initialize**.

The checks are read from the target's copy of the file, never the branch's. A branch that changes them
is checked with the old list, and its own list counts once it lands.

Settings → Merge Queue saves `push`, `review` and each check's limits as one commit, which you confirm.
Check commands, the install step, the target and the kits change by a branch and Land.

## Conformance

Each new version of the definition on main is proven by **conformance**, a fixed suite no project can
change. It starts by itself. It makes two scratch copies from the commit, starts them side by side, and
checks that their ports and data don't meet, that setup can run twice, that `up` and `apply` behave,
that `reset` clears data, and that `smoke`, each share endpoint and `open` work.

The project's **Software** card shows where it stands: not declared, being proven, registered, stale,
or failed with the reason. A project must be registered before a copy can be shared.

## Check a change

From a chat, the `project_verbs` tool runs these on your own worktree. From a checkout, use
`node scripts/sova-project.mjs <verb>`.

| Verb | What it tells you |
|---|---|
| `doctor` | Whether the file parses, every program is on the path, every `host` name is set and the ports are free. It changes nothing |
| `up`, then `status` | Whether the copy starts, and what's running |
| `test` | Whether the test command passes in this copy |
| `conform` | Whether the definition passes the whole suite |
| `deploy.check` | Whether a deploy recipe is sound: programs, host values and credentials by presence |

Only you ship. A chat can read deploy status and check a recipe, but it can't plan, run or roll back a
deploy.
