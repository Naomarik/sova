---
title: Merge thread (Sova)
description: Sova's own additions to the merge thread's method: what's worth noting on a Sova landing, restarting Sova once the queue is idle, its blast-radius map, its conflict and failure hints.
---

# Merge thread: Sova

Read Sova's merge-thread method first (the first message names it: `playbooks/merge-queue/PLAYBOOK.md` in Sova's install); this file adds what is particular to Sova and wins where they differ. Paths are relative to this folder unless they start at the repo root.

## What's worth noting
Write the note from this list only (`references/noting.md` has the paths behind each line):
- **Restart:** the branch changes what the server only loads at its start (`scripts/restart-sova.mjs` and `references/noting.md` list the paths: `server/**`, `shared/**`, `pi-config/**`, the `src/` files the server imports, the packages and the toolchain): "Changes server code; Sova restarts itself once the queue is idle." When it changes `pi-config/**`, add "Chats pick it up at their next reload."
- **Dependencies:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `mise.toml` changed: say which ("Adds a dependency: X." / "Bumps Bun to 1.x.").
- **State:** a new, renamed or reshaped file under the state root (`~/.pi/agent/sova/…`), a migration, a changed session-entry format: name it and whether old data is read.
- **Contracts:** `shared/protocol.ts`, `shared/harness*.ts`, a pi-config contract Sova parses, or a catalogue id (`shared/commands-ids.json`) changed: "Changes the wire contract (X)."
- **Spec drafts:** the landing turned drafts into docs: "Lands spec draft <name>." (the docs step's log names it).
- **Left for later:** a TODO, an off-by-default setting, a follow-up named in its commits.

Never: "restart" for page-only `src/**` (the build runs once the queue is idle, then open tabs offer the newer page), tests, docs or `.sova/spec/**`. Never tell the user to restart Sova: you do it (below).

## When the queue is idle
Sova sends **Idle** when the queue has nothing left to check and nothing runs. That is the one time you bring the live server up to date with what landed, and the one exception to the method's "never restart anything": one restart for every landing it still owes, never in the middle of a line. Run `bun scripts/restart-sova.mjs <step>` (this folder's script; it prints JSON) and act on its answer, not on your own reading of the diff:

1. `merge.status`: anything queued or checking means another Idle follows; end your turn. Then `release.status`: a release is open (a `release` that isn't published or abandoned): end your turn. Never restart during a release, and never for a release's own commit: trying it live stays the user's Apply. Later wakes catch up after it is published or abandoned.
2. `plan`. It compares the commit the live server started on (`GET /api/health`'s `head`) with `master`'s tip, over every file landed since:
   - `nothing` or `unknown`: end your turn (`unknown` says why; a server that doesn't answer is restarted by systemd on its own).
   - `build` (only page files landed): `build`. On failure, note it on the newest landed entry (`merge.note`: "The page build failed after landing {branch}: {first error line}."). No restart; open tabs offer the newer page.
   - `restart`: go on.
3. `merge.hold {action: "set"}`. Waiting entries then show "Waiting: Sova is restarting"; it lifts by itself after 5 minutes.
4. `build` (`build --install` when `plan` said `install: true`): it runs `pnpm install --frozen-lockfile`, then `pnpm run build`, in the main checkout. On failure: `merge.hold {action: "clear"}`, no restart, and `merge.note` on the newest landed entry: "Not restarted: {install|build} failed after landing {branch}: {first error line}."
5. `merge.status` again: an entry queued meanwhile is fine (the hold kept it waiting), but anything checking means the hold came too late: clear it and end your turn.
6. `restart --expect <plan's tip>`. It restarts `sova-runtime.service` (`systemctl --user restart`; on macOS `launchctl kickstart -k gui/$UID/sova-runtime`) and waits up to 60 s for `/api/health` to answer with that commit. Your chat runs in its own process and keeps running through it.
7. `merge.hold {action: "clear"}` (the server's start already lifted it; clearing again is harmless). Then `merge.note` on the newest landed entry (the Idle message names it), keeping what its note already says: ok → "Restarted Sova after landing {branch}."; not ok → "Restart after landing {branch} didn't come back on {tip short}: {why}. Check sova-runtime.service." Never retry a failed restart yourself: the next Idle plans again.

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
