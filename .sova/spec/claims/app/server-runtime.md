# §app/server-runtime — The server's runtime: Bun, or Node on request

Sova's server runs on Bun. It runs on Node only when the operator asks for it explicitly
(§app.server-runtime/choice), and the unit suite follows the same switch. A launcher starts the
server on that runtime; when Bun is wanted but missing or the server fails to start on it, that is
an error, never a quiet start on Node (§app.server-runtime/fallback). The server says which
runtime it is on in `GET /api/health` (§app.server-runtime/health). There is no picker in Settings
and no setting file: the operator sets the environment or the launcher's option, and the change
takes effect at the server's next start.

## §app.server-runtime/choice — Choosing Node

- The runtime is Node only when `SOVA_RUNTIME=node` is in the environment or the launcher is
  started with `--node`. Anything else (unset, `bun`, any other value) means Bun. No file is read:
  a `<state root>/runtime.json` left from earlier versions is ignored.
- `scripts/start-server.sh [--node] [server arguments]` is the launcher: from the repository root it
  execs `bun server/index.ts` or, for Node, `node --import tsx server/index.ts` in place, so the
  server is the launcher's own process (a service manager's main pid stays the server's). A
  leading `--node` is taken by the launcher and the server gets `SOVA_RUNTIME=node`, so it and
  what it starts see the same choice. `pnpm start` runs the launcher.
- `pnpm run dev:server` (the gated watcher) and `pnpm run dev:hermetic` follow the same choice:
  each (re)start spawns `bun server/index.ts`, or the Node command when Node is asked for.
  `pnpm run dev:hermetic:node` is the hermetic server on Node.
- The unit suite follows it too: `pnpm test` and the project's test verb run on Bun, and on Node
  with `SOVA_RUNTIME=node` or through `pnpm run test:node`. The runner's own `--runtime node|bun`
  wins over the environment; `pnpm run test:bun` runs Bun whatever the environment says.
- The Bun binary is `$SOVA_BUN` when set, else `bun` on `PATH`, else what `mise which bun`
  answers. The Node binary the launcher uses is `$SOVA_NODE`, else `node` on `PATH`.

## §app.server-runtime/fallback — No fallback to Node

When Bun is wanted and no Bun binary is found (or `$SOVA_BUN` names one that is missing or not
executable), the launcher and the dev watcher print one line on stderr naming the reason and how
to ask for Node (`SOVA_RUNTIME=node` or `--node`), and exit with an error; nothing starts. The unit
test runner does the same, exiting 2 with one line that names `pnpm run test:node`, before any test
file runs. A Bun server that fails to start fails like any other: nothing counts its boots and
nothing switches to Node, and no `runtime-fallback.json` or `runtime-bun-boots` file is written.

## §app.server-runtime/health — The runtime in /api/health

`GET /api/health` adds `runtime: {name, version, chosen}` to its answer
(§chat.profiles/live-commit): `name` is the runtime this process runs on (`"bun"` when
`process.versions.bun` is set, else `"node"`), `version` that runtime's version, `chosen` the
runtime the choice asks for (`"node"` when its environment has `SOVA_RUNTIME=node`, else `"bun"`),
read once at start.

## §app.server-runtime/quirks — Runtime differences, worked around in one place

Where Bun behaves differently from Node in a way Sova depends on, the workaround lives in
`server/runtime-quirks.ts`. It detects the broken behaviour, never the runtime's name or version, and
no call site names a runtime. `docs/bun-quirks.md` lists every quirk with the Bun version, the
upstream issue, the workaround and a canary test, which runs under Bun only and fails once Bun
fixes the bug.

- **WebSocket size caps hold on both runtimes.** Every WebSocket the server accepts or dials is built
  through the capped factories. The first message over a socket's `maxPayload` (ws's 100 MiB when
  none is named) closes it with 1009, or ends a share hop as lost, and no listener sees that
  message or any after it.
- **A WebSocket's handshake timeout holds on both.** A dialed socket whose peer never answers the
  upgrade errors ("Opening handshake has timed out") and closes once, after its `handshakeTimeout`.
- **A stopped stream stops as soon on both.** Provider response bodies are read at most 64 KiB at a
  time, Node's own read size, with every byte unchanged, and no read follows an abort. So the
  runaway-stream guard's stop (§chat.transcript/runaway-stream) costs about the same on Bun as on
  Node. Google adapters, which refuse a custom fetch, read as their runtime does.
- **The event-loop delay reads the same on both.** See §app.resource-monitor/lightness-budget.
- **A refused connection is named "connection refused" on both.** The error is classified by its
  code (its own or its cause's), never by its message.
- **Imports are unambiguous.** No two module files or directories in one folder of `src/`,
  `server/`, `shared/` or `pi-config/extensions/` differ only by case once the extension is
  dropped; a repo test enforces it.
- **The unit suite runs on Bun** through `pnpm test` (§app.server-runtime/choice). Each test file runs in its own
  process with a throwaway home set in the environment before Bun starts. The test preload refuses
  to run where `os.homedir()` doesn't follow the HOME it set.
