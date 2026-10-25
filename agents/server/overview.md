---
watches: ["server/runtime-choice.ts", "server/runtime-quirks.ts", "scripts/start-server.sh", "scripts/dev-server.mjs", "scripts/fetch-bun.sh", "mise.toml", "scripts/prices-update.mjs", "shared/model-prices/**"]
alsoUpdate: ["agents/server/overview.md", "docs/running-as-a-service.md", "docs/bun-quirks.md"]
---
# Server

The backend in `server/` and the contracts in `shared/`: how it runs (Bun), how it restarts, the dev
watcher, the price seed and the share listener. The pi harness boundary has its own guide,
[harness/overview.md](harness/overview.md).

## What lives here, and its docs

- `server/`: Hono (REST) + `ws` (2 WS endpoints), embeds the pi SDK. Owned by **backend**.
- `shared/protocol.ts` is the REST/WS wire contract (team coordination to change it);
  `shared/harness*.ts` is the harness contract ([harness/overview.md](harness/overview.md)).
- Docs: [docs/running-as-a-service.md](../../docs/running-as-a-service.md) (the systemd unit and
  launchd examples, the Node switch), [docs/bun-quirks.md](../../docs/bun-quirks.md) (the Bun quirk
  registry), [server/harness/pi/README.md](../../server/harness/pi/README.md) and
  [QUIRKS.md](../../server/harness/pi/QUIRKS.md). The restart rules every task follows are in
  [AGENTS.md](../../AGENTS.md#live-server-restart).
- Spec: `§app/server-runtime`.
- The command catalogue, the `scripts/sova.mjs` command line and what extensions may add:
  [commands/overview.md](commands/overview.md).
- What the server imports from `pi-config/` and `src/`: [agents/extensions/overview.md](../extensions/overview.md)
  and [agents/frontend/overview.md](../frontend/overview.md).

## Rules and contracts

### The live unit

- `sova-runtime.service` lives in `~/.config/systemd/user/` (`Restart=always`). Its ExecStart is
  `scripts/start-server.sh` (Bun); `node --import tsx server/index.ts` on a unit not yet switched.
  Without a watcher, the process keeps the code it loaded at start.
- Chats, workers (pi or claude-code, from agent_spawn/team_create), team members and hidden chats run
  in processes of their own (§app/chat-processes) and keep running through a restart; the webapp
  reconnects. A permanent stop of the server doesn't stop them either: each exits on its own once it
  has been idle with no server for its idle time. To stop them for good (a teardown, a removed install),
  `bun scripts/stop-chats.ts [--agent-dir <dir>]` stops every chat the install's state root records,
  each as an operator stop, through the supervisor's records, never a process found by name.
- On macOS the live server is the launchd agent `sova-runtime` (`~/Library/LaunchAgents/sova-runtime.plist`,
  the launchd example in docs/running-as-a-service.md), and every restart rule holds. Its restart is
  `launchctl kickstart -k gui/$(id -u)/sova-runtime`; the verb form
  (`sova-project apply --checkout ~/webapps/sova --confirm`) runs it 3 s later from a process detached
  from the server. Pid and state: `launchctl print gui/$(id -u)/sova-runtime`; start time:
  `ps -o lstart= -p <pid>`; log: `~/Library/Logs/sova-runtime.log`.
- The claude-code bridge's `globalThis` singleton is a `Symbol.for` registry entry in each chat's
  process: a chat gets a bridge from new code only when it reloads onto that code.

### Dev watcher (`pnpm run dev:server`, not the live unit)

`scripts/dev-server.mjs` is the dev watcher over the server's import graph (non-test `server/**`,
`shared/**`, and the whole `pi-config/extensions/mode/` directory). It restarts the server 300 ms after
the last edit, whatever the sessions are doing: chats and workers run in processes of their own and
keep running through it. The `r` key restarts at once. `dev:server:tsx` is the plain `tsx watch`. Which `pi-config/` files the watcher does not watch (so an edit reaches the server only at
its restart): [agents/extensions/overview.md](../extensions/overview.md).

### Runtime: Bun; Node on request

The server runs on Bun (`bun server/index.ts`, Bun 1.4.2, pinned in `mise.toml`), and on Node
(`node --import tsx server/index.ts`) only when asked for. One module decides,
`server/runtime-choice.ts` (node builtins only, run as a plain `node` script by the launcher).

- **See what runs:** `GET /api/health` → `runtime: {name, version, chosen}`: `name` is this process
  (`process.versions.bun`), `chosen` what the environment asked for at its start. The start log line
  names it too (`sova server on http://… (bun 1.4.2)`).
- **Asking for Node:** `SOVA_RUNTIME=node` in the environment, or `--node` as the launcher's first
  argument (it then sets `SOVA_RUNTIME=node`). Anything else = Bun. No setting file and no Settings
  picker: a `runtime.json` in the state root is ignored.
- **Who follows it:** `scripts/start-server.sh` (the launcher, also `pnpm start`; it `exec`s the
  server, so a unit's MainPID is the server), `pnpm run dev:server` (each watcher restart decides
  again), `pnpm run dev:hermetic` (`dev:hermetic:node` = the same on Node), and both test tiers
  (`pnpm test`, `pnpm test:int`, the project's test verb, merge-round's master re-runs). Helper scripts
  the server spawns follow `process.execPath`, so on Bun they run on Bun. `dev:server:tsx` is Node by
  name.
- **Bun binary:** `$SOVA_BUN`, else `bun` on PATH, else `mise which bun`. `SOVA_NODE` names the node
  binary the launcher uses (default `node` on PATH). Installed copies (install.sh, mesh-vps,
  mesh-termux) get Bun from `scripts/fetch-bun.sh`: bumping `bun` in `mise.toml` needs that release's
  checksum lines in `scripts/bun-release.txt`, or fetch-bun refuses.
- **No fallback:** Bun not found = the launcher (and the dev watcher) print
  `[runtime] bun not found: …` and exit 1; nothing starts. A Bun server that crashes at boot just fails
  (the unit's `Restart=` retries it); nothing switches to Node, nothing counts boots.
- **Switch the live unit:** set `Environment=SOVA_RUNTIME=node` (or `--node` on its ExecStart),
  `systemctl --user daemon-reload`, then restart under the AGENTS.md restart rules. An agent never
  edits the unit.
- **The live unit** runs `scripts/start-server.sh`, so it is on Bun. docs/running-as-a-service.md
  has the complete unit example (`%h` paths, the same ExecStartPre, PATH, Restart and TimeoutStopSec
  as the live unit) and the switch steps.
- **Testing a server:** in a worktree, `pnpm run dev:hermetic` (Bun) or
  `SOVA_PORT=48xx pnpm run dev:hermetic`; check `curl -s 127.0.0.1:<port>/api/health`. On Node only
  when asked: `pnpm run dev:hermetic:node`. `SOVA_BUN=/nonexistent` drives the "bun not found" error.
- **Bun quirks:** the registry is `docs/bun-quirks.md` (each quirk's Bun version, upstream issue,
  workaround, canary and repro). Workarounds live only in `server/runtime-quirks.ts`, probe the
  behaviour and never name a runtime. Every WebSocket in `server/` is built with its
  `cappedWebSocketServer` / `cappedWebSocket` (ws `maxPayload` and `handshakeTimeout` aren't enforced
  on Bun; Sova enforces both itself). How tests run on Bun: [agents/testing/overview.md](../testing/overview.md).
  A `mise.toml` change needs `mise trust <worktree>` again.
- **Chat processes run without Bun's GC timer:** `chatEnv` puts `BUN_GC_TIMER_DISABLE=1` in each
  chat's environment (`server/chat-runtime/gc-timer.ts`; an idle chat spent most of its CPU on that
  timer, and its memory still comes back down after a reply). The chat deletes it from its own
  environment as it boots, so the programs its tools run (tests, a hermetic server) keep the timer.
  `gc-timer.test.ts` holds the canary that the pinned Bun still names it: on a Bun bump that drops
  it, remove the setting.
- **A kept regex capture keeps its whole source string** (JSC substrings point into their source):
  code that keeps a small piece of a big string for long copies it, as `lineHead`
  (`server/harness/pi/reader.ts`) does; `server/harness/pi/reader-retention.test.ts` fails when the
  session list's scans keep whole lines again.

### Prices and the share listener

- `pnpm run prices:update` regenerates the checked-in price seed `shared/model-prices/seed.json` from
  models.dev and prints the changes and any unpriced model (`--from <api.json>` offline, `--check`
  writes nothing). Aliases are hand-kept in `shared/model-prices/aliases.json`. Servers keep their own
  price history in `<state root>/model-prices.json`: the usage helper (`server/usage-helper/`) pulls
  models.dev every 6 hours and on Refresh Prices, a pull only adds dated periods, and the seed is
  copied there only when the file is missing; `SOVA_PRICES_FETCH=off` stops pulling.
- The share listener serves the share page (`/h/`, `/i/`, `/h/assets/`) from `dist-share/`
  (`vite build --mode share`); `SOVA_SHARE_DIST=<dir>` names another build, read per request (tests
  point it at a stub page). With no built page it answers 503.

## When you change X, also update Y

| You change | Also |
| --- | --- |
| `server/runtime-choice.ts`, `scripts/start-server.sh`, the unit's shape | docs/running-as-a-service.md; this guide; `§app.server-runtime/*` through a spec draft |
| a Bun workaround (`server/runtime-quirks.ts`) | its row in docs/bun-quirks.md (version, issue, canary, repro) |
| `bun` in `mise.toml` | `scripts/bun-release.txt` checksum lines; `mise trust <worktree>` |
| `scripts/dev-server.mjs` watch set | this guide's watcher paragraph and the extensions guide's "not watched" list |
| `shared/protocol.ts` | coordinate with the frontend first; `shared/wire-v1.ts` if v1 frames are affected |
| anything in `server/**` or `shared/**` | say the live server needs a restart (AGENTS.md) |

While working: `pnpm test` constantly, `pnpm test:int --changed` before asking to land, `pnpm run
typecheck`. Landing (the merge round) runs both tiers in full.
