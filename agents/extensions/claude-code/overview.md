---
watches: ["pi-config/extensions/claude-code/**", "server/claude-accounts.ts", "server/claude-login-state.ts", "server/auth-status.ts", "server/claude-pool/**", "server/claude-models.ts", "server/claude-transcript.ts", "scripts/fake-claude.mjs", "scripts/claude-pool-e2e/**"]
alsoUpdate: ["pi-config/extensions/claude-code/README.md"]
---
# claude-code

The Claude Code model provider (`claude-code-cli`), which a Claude Code chat and a Claude Code worker (a pi
worker on it, `subagents/claude-workers.ts`) both run on. It drives the installed `claude` CLI, owns the Claude
logins and the pool's marks, and holds Sova's Claude model catalog.

## What lives here

- [`README.md`](../../../pi-config/extensions/claude-code/README.md) (logins, Claude Code workers, the
  provider and its limitations, tests),
  [`provider/DESIGN-bridge.md`](../../../pi-config/extensions/claude-code/provider/DESIGN-bridge.md) and
  [`protocol-probes.md`](../../../pi-config/extensions/claude-code/docs/protocol-probes.md).
- Requirements: §app/claude-code-provider. Before planning anything that changes what a Claude Code chat's model
  sees or which tools it has, read it: Sova owns the conversation and the tools; the CLI is only the model.
- Tests: `cd pi-config/extensions/claude-code && node tests/run.mjs && node tests/smoke.mjs`.

## What Sova relies on

**Imports.** The server imports these, and nothing else of claude-code:
- `catalog.ts` (imports nothing) with `context-window.ts` (its window rule, re-exported): Sova's own Claude
  model catalog (§app.claude-code-provider/catalog). One entry per real model: catalog id, CLI name, window,
  output cap and efforts; no aliases, no `[1m]` forms. Beside it, the frozen read-only table of old ids
  (§app.claude-code-provider/legacy-ids). Settings lists, worker windows, Usage rows, session open, every
  one-shot's `--model` and the built-in defaults read it. The provider, `agent_models`, the subagents roster,
  `mode/delegate.ts`, `subagents/team-defaults.ts`, `subagent-profiles.ts` and topic-outline import it too.
  The browser imports it through `src/lib/format.ts` only (`modelLabel`, §app.claude-code-provider/model-names), so it must import
  nothing at all. `pnpm run claude:catalog` diffs the catalog
  against the installed CLI's own table.
- `accounts.ts` (builtins plus its siblings `keychain.ts`, `fixed-settings.ts` and `claude-executable.ts`): the logins, below.
  Imported by `server/claude-accounts.ts` (Settings → Accounts, and the login the server's own `claude`
  spawns run on: model discovery, `--version`), `server/auth-status.ts`, `server/claude-login-state.ts`, the
  pool agent `server/claude-pool/`, and `usage-status/fetch.ts`.
- `claude-executable.ts` (builtins only): the one Claude program every `claude` spawn runs, an absolute path
  resolved from the host's own `PATH` (never a chat's cwd), else `~/.local/bin/claude`, or a plain-words "Claude
  program not found" (§app.claude-code-provider/one-program). The provider, `accounts.ts`, `server/decide-llm.ts`,
  `claude-models.ts`, `claude-status.ts` and `claude-accounts.ts` take their default from it.
- `fixed-settings.ts` (imports nothing): the `--settings` every `claude` spawn gets: no attribution, auto-memory
  off (§app.claude-code-provider/no-memory). `server/decide-llm.ts`, `session-autotitle.ts`, `claude-models.ts`
  and `memory/summarizer.ts` import it.
- `provider/memory-view.ts` (imports nothing): the memory view message's declared shape (the guide, the stable
  prefix, the newest lines), which `server/memory/engine.ts` builds and the bridge sends as written
  (§chat.memory/turn).
- `transcript-adapter.ts` and `provider/session-records.ts`: the Claude reader of the worker-transcript
  protocol (see [subagents](../subagents/overview.md)).
- `provider/fork-point.ts`, through `subagents/fork/claude.ts`: seeding a UI fork with its Claude Code
  source's live CLI session.
- Test only: `server/claude-models.test.ts` imports `transport.ts` (builtins only) to pin the server's
  model-discovery argv to the extension's.

claude-code imports nothing outside its own directory. For worker niceness it calls the server's
`Symbol.for("sova:lower-worker")` hook (§app.load-priority/workers); unset, as in the TUI, nothing changes.

**Logins** (`accounts.ts`; all paths under the agent dir):
- The registry `claude-accounts.json` `{version: 1, logins, devices}`. Each login's directory
  `claude-accounts/<id>/` (0700) symlinks `projects/`, `settings.json`, `CLAUDE.md`, `agents`, `commands`,
  `skills` and `plugins` to Claude Code's own directory, so `--resume` and every transcript reader keep one
  `projects/`.
- `claude-accounts-state.json`: this host's standing of each login.
- The per-device order: each account's logins together (`groupByAccount`, which the pool's order reads too),
  `default` (Claude Code's own login) always last.
- The one resolver login → `CLAUDE_CONFIG_DIR` that every `claude` spawn uses.
- Written by Settings → Accounts and the pool agent. Read at each spawn by the chat provider, workers, model
  discovery and the topic-outline summarizer.

**The pool** (`server/claude-pool/`), on when the mesh is (`<agent dir>/sova/peers.json` lists a peer): logins
form one pool. A registry login's `device` is the device that holds it; `null` means kept here, free for lending,
never run while the mesh is on. `accounts.ts` owns the marks every spawn honours:
- `<login dir>/.sova-leaving` `{v: 1, at, reason}`: never chosen.
- Leases `<login dir>/.sova-leases/<pid>.json` `{v: 1, owner, users, busy, children, lastActiveAt, at}`, kept
  by `LoginUsers` (a `globalThis` singleton that also releases idle users of a leaving login).
- Hand-picks `<login dir>/.sova-picks/<pi session id>.json` `{v: 1, session, at}`: written by the provider on a
  pick, dropped when that chat leaves the login. The pool agent never returns a picked login for idleness.
- Borrow requests `<agent dir>/claude-pool/wants/*.json` `{v: 1, at, pid, excludeAccounts?, excludeLogins?,
  only?}`, written and waited on by `acquire`, `failoverAsync`, and `take` (a composer pick naming one login).
- The agent heartbeat `<agent dir>/claude-pool/agent.json` `{v: 1, pid, at, device}`.

**The session's `claude-login` custom entry** `{v: 1, login, label?, from?, fromLabel?, reason?, resetsAt?,
text?}`: `reason` is `limit`, `auth`, `manual` (the user's pick) or `moved` (its login stopped being usable here).
The provider writes it. Sova reads it and renders one with `from` as a note row. The web's login switch calls the
provider's `/claude-login <login id>` command handler directly, so its argument is a contract too.

**The `measurement-invalid` mark** (`MEASUREMENT_INVALID_DIAGNOSTIC` in `provider/stream.ts`): a message's `diagnostics` entry `{type: "measurement-invalid", timestamp, details: {reason: "invalid-tool-retry"}}` when the CLI retried after rejected tool input; read by `server/harness/pi/session.ts` (the reply summary's `invalid`) and `server/reply-timing.ts`, which records no speed sample for that reply.

**Restart.** The bridge is a `globalThis` singleton (`getSessionBridge()`, a `Symbol.for` registry): a fresh
session that reloads the extension still gets the bridge built from the code loaded first. Provider edits need a
server restart. Before trusting a live test, compare the unit's start time with the edited files' mtimes. The dev
watcher doesn't watch this directory either.

## Testing Claude logins without Anthropic

- `scripts/fake-claude.mjs` stands in for the `claude` CLI: auth login/logout/status, `--version`, a minimal
  stream-json turn. It never contacts Anthropic. In a hermetic run, put `$(scripts/fake-claude-path.sh)` first on
  `PATH` and point `CLAUDE_CONFIG_DIR` at a fixture directory under `.agent/` (the `default` login; the real
  `~/.claude` stays untouched).
- Two opt-in knobs on the fake, for checking what a model was sent: `FAKE_CLAUDE_ONESHOT=1` makes a one-shot
  `-p` run (no `--input-format stream-json`, such as a memory summary) answer a result envelope
  ("Fake summary: …"; `FAKE_CLAUDE_ONESHOT_MS=<ms>` holds each answer), and `FAKE_CLAUDE_RECORD=<file>`
  appends each run's argv with the initialize request, user frame or one-shot input it was sent. Unset,
  the fake behaves as before. Its `claude` shim execs `node` from PATH: where mise's shims refuse a
  folder (a chat's code copy), write the shim with the absolute node path.
- `SOVA_CLAUDE_ACCOUNTS_DEV=1` lets `.agent/claude-accounts-dev.json` (`{"forceLimit": [ids], "forceAuth":
  [ids]}`) force a login to fail, to drive failover end to end. The force reaches only a session on a
  registry-known login (`claude-accounts.json`). With no registry a session has no login and the force does
  nothing: use the login dir's own `FAKE_LIMIT` / `FAKE_AUTH` files (the fake's transport-level failure).
- The fake's initialize answer lists one model, `fake-opus`, so `claude-code-cli/fake-opus` can be a session's
  model. The provider is always on, and `<agent dir>/sova/settings.json` needs no key for it.
- The pool across devices: `node scripts/claude-pool-e2e/run.mjs` runs three Sova containers on an `--internal`
  Docker network in address-identity mode, with the fake `claude` and no Tailscale. `--down` removes it; `--keep`
  leaves desk on 127.0.0.1:4821. It needs the mesh lab's `sovamesh-plain:lab` image.
  `SOVA_CLAUDE_POOL_IDLE_MS` / `_CUT_MS` / `_TICK_MS` shorten the pool's 30-minute idle, drain bounds and 5 s
  tick for such runs.
- Every test runner starts in a throwaway home, `pi-config/extensions/claude-code/tests/hermetic-env.mjs`. A
  session running on an added login passes that login's directory down as `CLAUDE_CONFIG_DIR`, and tests that
  fell back to the host's agent dir once wrote leases into it. The rest is in [testing](../../testing/overview.md).

## When you change it, also update

- Any contract above: the README section that documents it (Logins, the provider), and its Sova
  reader in the same branch.
- `catalog.ts`: run `pnpm run claude:catalog`; models are named only by catalog ids.
- A new import from the server: this guide, and keep it builtins-only and pi-runtime-free.
- After landing a provider or `accounts.ts` change: the live server needs a restart.
