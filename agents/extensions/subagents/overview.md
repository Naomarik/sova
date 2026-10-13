---
watches: ["pi-config/extensions/subagents/**", "server/subagent-profiles.ts", "server/team-defaults.ts", "server/process-priority.ts", "server/worker-adapters.ts", "server/worker-restore.ts", "server/chat-workers.ts", "server/session-fork-routes.ts", "server/harness/pi/fork.ts", "shared/subagent-profiles.ts"]
alsoUpdate: ["pi-config/extensions/subagents/README.md"]
---
# subagents

Background workers and native coordinated teams (`agent_spawn`, `team_create`, …). Sova imports its subagent
profiles, team defaults, the worker-transcript protocol, the fork core's server half and the worker-priority hook.

## What lives here

- [`README.md`](../../../pi-config/extensions/subagents/README.md) and
  [`pi-config/docs/native-teams.md`](../../../pi-config/docs/native-teams.md).
- Settings → Subagents and the Delegate side: [modes/delegate](../../modes/delegate/overview.md).
- Tests: `cd pi-config/extensions/subagents && node tests/run.mjs && node tests/smoke.mjs && node tests/team-smoke.mjs`.

## What Sova relies on

Teams and their snapshots are a contract Sova parses: coordinate before changing them.

**Subagent profiles.** One module, `subagent-profiles.ts` (builtins only, plus `mode/delegate.ts`, `mode/spec.ts`,
`mode/align-settings.ts` and `subagents/team-defaults.ts`), owns three things:
- `subagent-profiles.json`, the library of named setups. A profile bundles Delegate's four routes, the standing
  coordinator and monitor, the members default, the spec writer, and optionally the reviewer and the align writing
  style / Visuals override.
- `subagent-profiles-default.json`, this device's default. Never synced. The library syncs profile by profile: the newest edit per profile wins, deletions are recorded in Sova's sync state (never in the file), and a seeded starter's mtime is the epoch, so it yields to a library edited elsewhere.
- Each chat's hidden `subagent-profile` custom entry `{v: 1, profile}`: an id or `"off"`, newest on the branch wins.
  It is an id reference, not a snapshot: editing a profile reaches every chat on it from its next turn or team action.

The module holds the shapes, the strict parses, the atomic writers, the pick entries (`restorePick`,
`pickEntryFor`) and the seeding: an absent file is seeded from the legacy files, so nothing changes until the user
switches, and a malformed legacy `team-defaults.json` postpones seeding. One resolver, `resolveSubagents`, goes
pick → this device's default → legacy files. A dangling pick falls to the default; a missing, malformed or dangling
default reads as Off; an unusable library falls to the legacy files.
- Written by the mode menu, Settings → Subagents, `/mode subagents <id|off>`, the Overseer and the limit row.
- Read by the mode extension (Delegate routing and the spec writer at each turn boundary, either major mode), by
  this extension (`team_create`, `team_add`, `team_succeed`, roster answers, `/team defaults`), and by the server:
  `server/subagent-profiles.ts` (Settings → Subagents, the `/api/subagents` pick route, the session-create field;
  `server/sessions-configure.ts` and `server/overseer-tools.ts` validate through it), `server/sync/docs.ts` (the
  library's mesh registration; the default file is deliberately absent), `server/chat-manager.ts` (the pick entry
  helpers and `saveModeDefault`), and `shared/subagent-profiles.ts` (types only).

**Team defaults.** `team-defaults.json` is the legacy standing coordinator and monitor every new team gets
(absent = off). It seeds Settings → Subagents' Teams section and is read here at team creation.
`team-defaults.ts` (builtins only: types, defaults, strict parse, reader, atomic writer) is imported by
`server/team-defaults.ts`.

**Worker priority.** `priority.ts` (builtins only) is the `Symbol.for("sova:worker-nice")` hook through which the
server sets the niceness its hosted sessions' workers and tool commands start at, and the lowering this extension
does (§app.load-priority/workers). `server/process-priority.ts` imports it. Unset, as in the TUI, nothing changes.

**Usage parent.** A worker's loadout names its parent session and worker id (`WorkerSpec.parent`); Sova's chat
manager registers the worker's session with them, so its usage records name their parent (see
[llm-inflight](../llm-inflight/overview.md)).

**The worker-transcript protocol.** `worker-transcript.ts` (types, the one manifest fold `readWorkerManifests`,
usage helpers), `adapters/index.ts` and `adapters/pi.ts`, with claude-code's `transcript-adapter.ts` and
`provider/session-records.ts`: the per-backend readers that locate a worker's transcript and read its turns, model
and context fill for restored workers. `server/insights.ts`, `worker-restore.ts`, `worker-adapters.ts` and
`claude-transcript.ts` import them. Only the pi adapter (`server/harness/pi/`) may import `adapters/pi.ts`.

**The fork core**, `fork/`: the one owner of every fork's cache logic, for Sova's "Fork from here" and the
background forks `/explain` runs. Its server half:
- `fork/cache.ts` (runtime builtins only, pi types): a fork's inherited prompt-cache key and its `sova-fork-cache`
  entry, the `prompt_cache_key` hook and the Codex `session-id` affinity routing. `server/chat-manager.ts`,
  `server/harness/pi/fork.ts` and their tests import it.
- `fork/claude.ts` (builtins only, through `claude-code/provider/fork-point.ts`): seeding a UI fork with its Claude
  Code source's live CLI session. `server/session-fork-routes.ts` imports it.
- The rest of `fork/` (copy, mirror, child extension, background runner) needs the pi runtime and stays out of the
  server.

**Where workers run.** Every worker, team member and hidden chat (/explain, /compact-handoff, /btw) is a chat
process of its own, started through the server's `WorkerRegistry` (`server/chat-workers.ts`) from the `WorkerSpec`
this extension computes (`worker-host.ts`, `chat-worker.ts`). Every chat, worker and team member runs in a process
of its own, so a server restart never ends them. A parent's reload never ends them: its next manager reattaches. The dev watcher doesn't watch
this directory, so an edit to any file above reaches the server at its restart, and a running chat process at its
next code reload.

## When you change it, also update

- A profile, team-defaults or entry shape: the README, Settings → Subagents' reader in `server/`, and the site page
  `site/src/content/docs/subagent-profiles.md` when what the user sees changes.
- The worker-transcript protocol: both backends' readers (here and in claude-code) in the same branch.
- `spec-brief.ts` quotes `mode/spec-mode.md` by anchor: when the guide moves, run its test
  (`spec-brief.test.ts`; see [modes/spec](../../modes/spec/overview.md)).
