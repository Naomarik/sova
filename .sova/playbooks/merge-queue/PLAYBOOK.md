---
title: Merge thread (Sova)
description: Sova's own additions to the merge thread's method: what's worth noting on a Sova landing, its blast-radius map, its conflict and failure hints.
---

# Merge thread: Sova

Read Sova's merge-thread method first (the first message names it: `playbooks/merge-queue/PLAYBOOK.md` in Sova's install); this file adds what is particular to Sova and wins where they differ. Paths are relative to this folder unless they start at the repo root.

## What's worth noting
Write the note from this list only (`references/noting.md` has the paths behind each line):
- **Restart:** the branch changes `server/**`, `shared/**` or `pi-config/**` (runtime code): "Changes server code; restart Sova to pick it up." For `pi-config/**` alone: "Changes pi-config; chats pick it up at their next reload." Both when both.
- **Dependencies:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `mise.toml` changed: say which ("Adds a dependency: X." / "Bumps Bun to 1.x.").
- **State:** a new, renamed or reshaped file under the state root (`~/.pi/agent/sova/…`), a migration, a changed session-entry format: name it and whether old data is read.
- **Contracts:** `shared/protocol.ts`, `shared/harness*.ts`, a pi-config contract Sova parses, or a catalogue id (`shared/commands-ids.json`) changed: "Changes the wire contract (X)."
- **Spec drafts:** the landing turned drafts into docs: "Lands spec draft <name>." (the docs step's log names it).
- **Left for later:** a TODO, an off-by-default setting, a follow-up named in its commits.
- **A conflict you resolved:** what, and why it changes no behaviour.

Never: "restart required" for `src/**` alone (the web app reloads itself), the build, tests, docs or `.sova/spec/**`.

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
