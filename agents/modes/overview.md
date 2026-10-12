---
watches: ["pi-config/extensions/mode/**", "server/mode-state.ts"]
alsoUpdate: ["pi-config/extensions/mode/README.md"]
---
# Modes

The `mode` extension: the per-session major mode (normal ↔ Delegate) and the minor modes (`align`, `spec`, `vis`,
`codemode`, `memory`). Sova imports more of it than of any other extension, and the dev watcher watches all of it.
This page is the extension's guide; each mode has its own below.

## What lives here

- [`pi-config/extensions/mode/README.md`](../../pi-config/extensions/mode/README.md) (usage, minor modes, alignments,
  Delegate routing, writing style and Visuals, the spec writer, workers, verification). The user-facing pages are
  `site/src/content/docs/modes/` (`index.md`, `delegate.md`, `spec.md`, `vis.md`, `codemode.md`, `align/`).
- Guides: [delegate](delegate/overview.md), [align](align/overview.md), [spec](spec/overview.md),
  [vis](vis/overview.md), [memory](memory/overview.md). `codemode` is a pi built-in Sova adds and this mode switches
  (§chat.mode-menu/codemode); see [the harness guide](../server/harness/overview.md).
- Tests: the `mode` line of `pi-config/README.md` "Tests" (`cd pi-config/extensions/mode && node --test index.test.ts …`;
  the README's Verification section says what each file covers). Sova-only, from the repo root:
  `node server/tests/spec-assessment.mjs`.

## What Sova relies on

**Imports.** The server imports `state.ts`, `minor.ts`, `delegate.ts`, `spec.ts` and `align-settings.ts`:
`server/mode-state.ts`, `server/delegate.ts`, `server/spec-settings.ts`, `server/align-settings.ts` and
`server/sync/docs.ts` (the files' mesh registration). `server/vis-check.ts` and `server/chat-manager.ts` take
`visToolsWanted`, the one rule for the vis tools, from `minor.ts`. `server/transcript.ts` and `server/align-state.ts`
import `align.ts`. Keep all of them pi-runtime-free: node builtins, each other, and (for `delegate.ts`)
claude-code's `catalog.ts`, which imports nothing. `minor.ts` also reads its
sibling `spec-mode.md` once at load and refuses to load if that file's shell block is malformed, so a malformed
guide stops pi and the server alike.

**The mode entry.** `mode.json` in the agent dir is the default mode for new sessions. The active mode is per
session, in the session's own `mode` custom entry; Sova restores it with `restoreActive` from `state.ts`. Sova also
writes that entry itself, `{mode, active: activeOf(state)}` (`pinEntryFor` in `server/mode-state.ts`), to pin the
sessions it starts with a mode: a project's coding sessions, and the Overseer's `sova_create_session` /
`sova_set_session`. So the entry's shape is a contract too.

**The `/mode` command.** The web's mode switch calls the extension's `/mode` command handler directly
(`ChatSession.applyMode` in `server/chat-manager.ts`), so its arguments are a contract.

**Settings files** (agent dir), each with one strict parse, a tolerant reader and an atomic writer here, synced by
`server/sync/docs.ts` and edited per profile by Settings → Subagents
([subagents](../extensions/subagents/overview.md)): `mode-delegate.json` ([delegate](delegate/overview.md)),
`mode-spec.json` ([spec](spec/overview.md)), `mode-align.json` ([align](align/overview.md)). Each is re-read at every
turn boundary, never snapshotted into a session (align's Visuals only at session start).

**Restart.** The dev watcher (`scripts/dev-server.mjs`) watches this whole directory and restarts on an edit; the
live unit restarts on nothing (AGENTS.md's restart rules).

## When you change it, also update

- A contract above: the README section that documents it, and Sova's reader in the same branch.
- What a mode does for the user: its page under `site/src/content/docs/modes/`.
- The injected text of a mode: its guide below says what else moves with it.
- `spec-guard.ts`: the merge round runs the spec replay suite ([spec](spec/overview.md)).
