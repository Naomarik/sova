---
watches: ["pi-config/install.sh", "pi-config/install.test.mjs", "pi-config/settings.json", "pi-config/keybindings.json", "pi-config/models.json", "pi-config/vision-delegate.json", "pi-config/extensions/*.ts"]
alsoUpdate: ["pi-config/README.md"]
---
# pi-config extensions

`pi-config/` holds the user's pi config and extensions. It has no other home, and it is live: the user's TUI
and every runtime Sova embeds load it. This guide covers what Sova relies on in it. Each extension below
with a guide of its own lists its contracts.

## What lives here

- [`pi-config/README.md`](../../pi-config/README.md): the layout table (one row per extension), install,
  credentials and the per-extension test commands (its "Tests" section). Each extension directory has its own
  README, and `extensions/spec/docs/` has a CHANGELOG. Read them; this guide doesn't repeat them.
- `~/pi-config` is a compatibility symlink to this directory. `~/.pi/agent` symlinks `keybindings.json`,
  `models.json`, `vision-delegate.json` and every extension into it.

| Extension | Guide | What Sova takes from it |
|---|---|---|
| `mode` | [modes](../modes/overview.md) | mode state, minor modes, Delegate routing, align, the spec text |
| `spec` | [modes/spec](../modes/spec/overview.md) | the `.sova/spec` tools (not a pi extension) |
| `claude-code` | [claude-code](claude-code/overview.md) | Claude logins and the pool, the model catalog, transcripts, `fixed-settings.ts` |
| `subagents` | [subagents](subagents/overview.md) | subagent profiles, team defaults, the worker-transcript protocol, the fork core, worker priority |
| `provider-limits` | [provider-limits](provider-limits/overview.md) | the request limits and the per-provider queue |
| `llm-inflight` | [llm-inflight](llm-inflight/overview.md) | the usage ledger, in-flight counts, call attribution |
| `sandbox` | [sandbox](sandbox/overview.md) | the `sandbox` entry and the session policy |
| `worktrees` | [worktrees](worktrees/overview.md) | the `worktrees` entry, the merge card, the merged-branch probe |
| `show-changes` | [show-changes](show-changes/overview.md) | the `show_changes` details (the browser imports it) |
| `remote` | [remote](remote/overview.md) | the target schema and the one argv builder |
| `model-levels` | [model-levels](model-levels/overview.md) | the thinking levels of models pi has no catalog for |
| `command-palette` | [command-palette](command-palette/overview.md) | `model-favorites.json` through `ModelFavorites` |
| `stamp` | [stamp](stamp/overview.md) | the clock and relative-time format (the browser imports it) |
| `link` | [link](link/overview.md) | the link tools, switched on by the server's `sova:link-live` hook |
| `usage-status` | [usage-status](usage-status/overview.md) | the subscription usage fetchers and cache |
| `sessions` | [sessions](sessions/overview.md) | the live registry `sessions/live/*.json` |

Extensions with no guide, and the contract Sova parses where there is one:
- `model-policy`: `model-policy.json` (what may be used at all, and what subagents may be given). The TUI,
  the palette, subagent spawning and Sova all read it; Sova's reader is its own `server/model-policy.ts`.
- `topic-outline`: its state, and its summarizer defaults, mirrored by hand in
  `server/topic-outline-settings.ts` (keep them equal). Its summarizer spawns `claude` on a login
  (see [claude-code](claude-code/overview.md)).
- `vision-delegate`, `btw`, `codefold`, `compact-handoff`, `explain`, `extension-toggle`, `wake-nudge.ts`,
  `working-subagent-count.ts`: Sova imports none of them. `dev:hermetic` leaves out `wake-nudge` once
  `.agent` holds copied sessions (see the testing guide).

## Rules

- **Self-contained.** `pi-config/` imports nothing from Sova. Its `install.sh` and README must keep working on
  a plain copy of the directory. Never copy Sova docs into it, and word its docs so they read right on a copy.
  It is shared: no team owns it.
- **Live.** An edit here reaches the user's live TUI at its next `/reload`, and every runtime Sova embeds.
  Treat it like `shared/protocol.ts`: coordinate before changing any contract Sova parses. Each guide below
  lists them: files, entry and message shapes, tool `details`, and command handlers Sova calls directly
  (`/mode`, `/claude-login`), whose arguments are contracts too.
- **What Sova imports.** Sova's tsconfig doesn't cover `pi-config/`, except the files the server or the web
  app imports (hence `allowImportingTsExtensions`). Each guide names them. Every such file stays
  pi-runtime-free: node builtins and the named siblings only, never `@earendil-works/*`. A file the browser
  bundles (`stamp/format.ts`, `claude-code/catalog.ts`, `show-changes/details.ts`) imports nothing at all.
  Import nothing else from pi-config at runtime. An edit to any of them can break Sova's typecheck, so run
  `pnpm run typecheck` too. To list today's imports:
  `git grep -n "pi-config/extensions/<name>/" -- server src shared scripts`.
- **Restart.** The live unit has no watcher: no edit reaches it before its restart. The dev watcher
  (`scripts/dev-server.mjs`) watches only `server/`, `shared/` and `pi-config/extensions/mode/`. An edit to
  any other pi-config file the server imports reaches a running server only at its next restart. Each chat
  runs the copy of the code it started with, so an extension edit (a `globalThis` singleton such as the
  claude-code bridge, the provider-limits gate or `LoginUsers` included) reaches a chat when it reloads onto
  the new code after that restart, never before. Say a change is not live yet, and restart under AGENTS.md's
  restart rules.
- **Plain-module imports.** In a Sova chat (Bun) pi imports each extension natively and translates it
  only when that fails, at a cost in memory and open time (quirk P26). So an extension imports by name only
  what Sova's `package.json` lists (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `typebox`), and
  only from an entry that exports the name: pi-ai's legacy names (`getApiProvider`, `getModel`, …) are on
  `@earendil-works/pi-ai/compat`, not its root. A new dependency is added to Sova's `package.json` at pi's
  own version. `server/harness/pi/extension-deps.integration.test.ts` fails on any extension pi translates.
- **No new extension for Sova features.** A new Sova agent feature is never a new pi-config extension, and
  never a new call to an extension's command handler; the existing ones are grandfathered (see
  [the harness guide](../server/harness/overview.md)).
- **Tests run per extension**, from its own directory, with its line in `pi-config/README.md` "Tests" (the
  extension's README explains each file). Run it while working. A runner that spawns `claude` imports
  `pi-config/extensions/claude-code/tests/hermetic-env.mjs` first (see [testing](../testing/overview.md)).

### install.sh

- `pi-config/install.sh` must stay standalone, needing nothing outside `pi-config/`.
- It links `pi-config/` into `~/.pi/agent`, except `settings.json`. That file is a seed, deep-merged into the real
  `~/.pi/agent/settings.json`: seed keys win, and runtime keys (the chosen model) stay there, never in the repo.
- `--check` verifies the links and the seed keys and changes nothing. `--save` copies the live values of
  seed-declared keys back into the seed. `--links` refreshes only the extension links.
- Moving the worktree breaks the absolute symlinks in `~/.pi/agent`. Re-run `install.sh` after a move.
- A new extension isn't loaded until it is linked (`install.sh --links`).
- Its tests: `node --test install.test.mjs` from `pi-config/`.

## When you change something here, also update

- A new or removed extension, or a changed config file: the layout table and "Tests" in
  `pi-config/README.md`, and the table above.
- `install.sh` behavior: `pi-config/README.md` "Install", and `install.test.mjs`.
- An import Sova adds or drops: the extension's guide here, and its README where it names Sova's import.
- A contract Sova parses: the extension's README, its guide here, and the Sova reader in the same branch.
- Landing (the merge round's `check`) runs the typecheck, `pnpm test`, `pnpm test:int`, the build, and, for each
  extension the branch changed, that extension's line in `pi-config/README.md` "Tests" (the line starting
  `cd extensions/<name> && `, split on ` && ` and run without a shell). So that line is a contract: one per
  extension, plain commands only. A branch that changes `pi-config/` outside `*.md` and tests needs the live
  server restarted after landing.
