# §app/server-runtime — The server's runtime: Node or Bun

Sova's server runs on Node by default, or on Bun when the operator chooses it. The choice is one
setting per agent dir (§app.server-runtime/choice); a launcher reads it and starts the server on
that runtime, falling back to Node when Bun is missing or keeps failing to start
(§app.server-runtime/fallback). The server says which runtime it is on in `GET /api/health`
(§app.server-runtime/health). There is no picker in Settings: the operator edits the file or the
environment, and the change takes effect at the server's next start.

## §app.server-runtime/choice — The runtime setting

- `<state root>/runtime.json` (`<agent dir>/sova/runtime.json`; the agent dir is
  `$PI_CODING_AGENT_DIR` when set, so a hermetic `.agent` has its own) holds
  `{"runtime": "node" | "bun"}`. A missing file, unreadable JSON, or any other value means
  `node`.
- `SOVA_RUNTIME=node|bun` in the environment wins over the file. Any other value is ignored and
  the file decides.
- `scripts/start-server.sh` is the launcher: from the repository root it execs
  `node --import tsx server/index.ts` or `bun server/index.ts` in place, so the server is the
  launcher's own process (a service manager's main pid stays the server's).
- `pnpm run dev:server` (the gated watcher) and `pnpm run dev:hermetic` follow the same choice:
  on Bun each (re)start spawns `bun server/index.ts`.
- The Bun binary is `$SOVA_BUN` when set, else `bun` on `PATH`, else what `mise which bun`
  answers.

## §app.server-runtime/fallback — Falling back to Node

When Bun is chosen, the launcher starts Node instead, and records why, when:

- no Bun binary is found (or `$SOVA_BUN` names one that is missing or not executable), or
- Bun has started three times in a row without the server ever listening.

The second rule rests on a boot counter, `<state root>/runtime-bun-boots`: the launcher adds one
before each Bun start, and a server running on Bun deletes the file once it is listening. A boot
that finds the count already at three starts Node. Choosing Node (in the file or `SOVA_RUNTIME`)
resets the counter, so switching back to Bun later gets three fresh tries; deleting the file does
the same by hand.

A fallback writes `<state root>/runtime-fallback.json` `{at, reason}` (ISO time, one sentence)
and prints the reason on the launcher's stderr. The file is replaced at each fallback and left
alone otherwise.

## §app.server-runtime/health — The runtime in /api/health

`GET /api/health` adds `runtime: {name, version, chosen, fallback?}` to its answer
(§chat.profiles/live-commit): `name` is the runtime this process runs on (`"bun"` when
`process.versions.bun` is set, else `"node"`), `version` that runtime's version, `chosen` the
runtime the setting asks for, read once at start exactly as the launcher reads it. When `name`
differs from `chosen`, `fallback` is the `{at, reason}` of `runtime-fallback.json` (absent when
that file is missing or unreadable).
