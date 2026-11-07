---
title: Merge thread (Sova)
description: Sova's own additions to the merge thread's method: what's worth noting on a Sova landing, restarting Sova once the queue is idle, its blast-radius map, its conflict and failure hints.
---

# Merge thread: Sova

Read Sova's merge-thread method first (the first message names it: `playbooks/merge-queue/PLAYBOOK.md` in Sova's install); this file adds what is particular to Sova and wins where they differ. Paths are relative to this folder unless they start at the repo root.

## What's worth noting
Write the note from this list only (`references/noting.md` has the paths behind each line):
- **Restart:** the branch changes what the server only loads at its start (`server/restart-paths.ts` and `references/noting.md` list the paths: `server/**`, `shared/**`, `pi-config/**`, the `src/` files the server imports, the packages and the toolchain): "Changes server code; Sova restarts itself once the queue is idle." When it changes `pi-config/**`, add "Chats pick it up at their next reload."
- **Dependencies:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `mise.toml` changed: say which ("Adds a dependency: X." / "Bumps Bun to 1.x.").
- **State:** a new, renamed or reshaped file under the state root (`~/.pi/agent/sova/…`), a migration, a changed session-entry format: name it and whether old data is read.
- **Contracts:** `shared/protocol.ts`, `shared/harness*.ts`, a pi-config contract Sova parses, or a catalogue id (`shared/commands-ids.json`) changed: "Changes the wire contract (X)."
- **Spec drafts:** the landing turned drafts into docs: "Lands spec draft <name>." (the docs step's log names it).
- **Left for later:** a TODO, an off-by-default setting, a follow-up named in its commits.

Never: "restart" for page-only `src/**` (the build runs once the queue is idle, then open tabs offer the newer page), tests, docs or `.sova/spec/**`. Never tell the user to restart Sova: you do it (below).

## When the queue is idle
Sova sends **Idle** when the queue has nothing left to check and nothing runs. That is the one time you bring the live server up to date with what landed, and the one exception to the method's "never restart anything": one restart for every landing it still owes, never in the middle of a line. Sova does it for you with one verb, `merge.restart`, and you act on its answer, not on your own reading of the diff. Your sandbox reaches neither Sova's port nor systemd, and writes nothing in the main checkout: never try `curl`, `systemctl`, `pnpm` or a script for any of it.

1. `merge.status`: anything queued or checking means another Idle follows; end your turn. Then `release.status`: a release is open (a `release` that isn't published or abandoned): end your turn. Never restart during a release, and never for a release's own commit: trying it live stays the user's Apply. Later wakes catch up after it is published or abandoned. (`merge.restart` refuses both too.)
2. `merge.restart {project}`. Sova plans from the commit it runs (`merge.live` shows it, with the plan) to the target's head, then by its answer's `outcome`:
   - `nothing`: end your turn (`why` says why: nothing owed, the main checkout not on the target's head yet, a restart already on its way).
   - `built` (only page files landed): nothing restarts; open tabs offer the newer page. No note.
   - `failed`: Sova has already noted it on the newest landed entry ("The page build failed after landing {branch}: {first error line}" when only the page was built, otherwise "Not restarted: {install|build} failed after landing {branch}: {first error line}") and lifted the hold. Don't note it yourself: end your turn.
   - `restarting`: Sova held new starts, installed when the plan said `install`, built, and restarts `sova-runtime.service` a few seconds after answering (your chat runs in its own process and keeps running through it). At its start Sova checks it runs the expected commit, lifts the hold and puts on the newest landing's note, in place of an earlier restart outcome, "Restarted Sova after landing {branch}." or "Restart after landing {branch} didn't come back on {sha}: … Check sova-runtime.service.". Nothing is left for you: end your turn.
3. Never retry a failed restart yourself: the next Idle plans again.

## Asking
You decide on your own (the method's "On your own"). Ask the user, with `merge.ask` and the entry it is about, only what the branch, its commits and the logs can't settle; the private-names interview is the usual one. Never wait in this chat.

## Picks
The map is `references/blast-radius.json` (rules → check ids of `.sova/project.json`'s merge section: optional ones, or required ones that skip themselves). The method's `scripts/blast-radius.mjs` finds it on its own from the repo root. What each pick costs and when it is worth it: `references/blast-radius.md`. Extend the map in the same branch that adds a new area with its own tests.

## Conflicts: Sova's usual cases
- `shared/commands-ids.json`: ids are append-only; both sides appending different ids is a list extension (keep both, in the order master has them, the branch's after). The same id with two meanings is behaviour differs.
- `src/app.css`: both sides adding rules to one block is neighbouring edits; two values for one property is behaviour differs.
- `scripts/test-groups.mjs` triggers lists, `.sova/project.json` checks lists: list extensions.
- `.sova/spec/**` never conflicts in a landing (drafts are gitignored and become docs in the run); if it does, it's behaviour differs.
- `pnpm-lock.yaml`: never resolved by hand. Behaviour differs, with the proposal "regenerate the lockfile on the branch after merging master".

## Failures: Sova's usual causes
- Many unrelated tests failing at once with git temp-file errors: the host (`/tmp` out of inodes), not the branch. Sova calls that the machine's; if a run was blamed on the branch anyway, say so in the diagnosis.
- `server/harness-boundary.test.ts` failing: the branch imported a pi package outside `server/harness/pi/`. The fix is never to raise the baseline.
- The tier guard failing a unit file: it starts a process, binds or fetches; the fix is to rename it `.integration.test.ts`.
- A catalogue or inventory test failing: a user-visible action was added without its catalogue entry or `commands-ids.json` id.
