# Server hunks for detachable workers

The subagents extension already implements both worker transports
(`hosting.ts`). The pi-web server needs one small edit, plus one npm script.
Nothing here changes the default (`inline`) behavior.

## Hunk 1: set the detach flag on server shutdown (required for `host`)

File: `server/index.ts`. Current anchor text, verbatim:

```ts
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Replace it with:

```ts
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  // Hosted subagent workers (PI_WORKER_TRANSPORT=host) outlive this process: the
  // subagents extension's session_shutdown detaches them instead of killing them.
  // No-op for the default inline transport. See pi-config/extensions/subagents/hosting.ts.
  // Rename bridge: the extension reads "sova:detach-workers" first, legacy "pi-web:detach-workers"
  // second — the server sets BOTH so either side may be applied first.
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-web:detach-workers")] = true;
  (globalThis as Record<symbol, unknown>)[Symbol.for("sova:detach-workers")] = true;
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Why only here: the flag is read when `session_shutdown` runs. It must be true
only when the whole process is going away. If it were set earlier, an
archive/close (`disposeHeldChat`), a mode-switch `session.reload()` or a
foreign-write reload would detach workers instead of killing them. The
unconditional set is safe: with the inline transport there are no hosted
workers, so the detach path has nothing to do.

`scripts/dev-server.mjs` restarts the server with SIGTERM, and that also goes
through `shutdown()`, so hot restarts detach too. A crash or SIGKILL skips
`session_shutdown`. The hosts are detached processes and keep running anyway.
Their registry entries stay "running" with an adopt lock held by a dead pid,
and the next adopter treats that lock as stale. The consumed offset may lag by
up to 250 ms of output, so a completion from that window can be announced twice
(at-least-once).

## Hunk 2: npm script (orchestrator)

`dev:server:detached` only sets the env var. `scripts/dev-server.mjs` spawns
the server with `env: process.env`, so the variable is inherited:

```json
"dev:server:detached": "PI_WORKER_TRANSPORT=host node scripts/dev-server.mjs"
```

`PI_WORKER_TRANSPORT` values: unset or `inline` gives today's in-process
workers (the default). `host` gives detached hosts plus re-adoption. Any other
value falls back to `inline`.

## Not included (follow-ups to decide on)

- **Adoption happens at `session_start` of the owner session.** pi-web opens
  runtimes lazily (`acquireChat`), so after a restart a detached worker is only
  re-adopted, and its completion only announced, once its owner session's
  runtime is opened again. Until then the host keeps it running. The host stops
  it after 24 h with no manager attached. To adopt eagerly, the server could
  scan `~/.pi/agent/sova/workers/<ownerSessionId>/*/meta.json` (legacy pi-web/workers until the state move; defaultWorkersRoot() picks) at startup for
  `state` in {"running", "detached"} and `acquireChat(meta.ownerSessionFile)`
  for each. An already-open runtime can re-scan with
  `pi.events.emit("subagents:workers-adopt", { version: 1 })`.
- **dev-server restart gate.** With `host`, a restart no longer kills workers,
  so `scripts/dev-server.mjs` could skip holding restarts while
  `PI_WORKER_TRANSPORT=host`.
- **Mode-switch reload** (`session.reload()`, `session_shutdown` reason
  "reload") still kills workers in both transports, as before.
