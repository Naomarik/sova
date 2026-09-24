# Development

[← Sova](README.md)

## Run a checkout

Requires Git, Node.js ≥22.19, and pnpm (the version `packageManager` in `package.json` pins;
`mise install` provides both Node and pnpm from `mise.toml`).

```sh
git clone https://github.com/Naomarik/sova.git
cd sova
pnpm install --frozen-lockfile
pnpm run build
pnpm start
```

Open <http://127.0.0.1:4800>. This runs your checkout; the release installer instead installs its
pinned tag. Provider login and network access are covered in [Getting started](docs/getting-started.md).

For frontend development, run `pnpm run dev:server` and `pnpm run dev:web` in separate terminals,
then open <http://localhost:5173>. Vite proxies API and WebSocket requests to port 4800.

**Development uses your real pi data by default.** Set `PI_CODING_AGENT_DIR` to a scratch
agent directory before starting the server if you don't want it using your sessions, credentials,
and extensions. Never commit that directory or copy credentials into test fixtures.

## Checks

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

Unit tests use `tsx --test`; plain `node --test` does not resolve their extensionless TypeScript
imports. Installer tests run with `bash scripts/install.test.sh` in temporary homes with stubbed
toolchains. Extensions have their own test instructions in [pi-config](pi-config/README.md).

For documentation-only changes, check commands against their implementations, verify relative
links and anchors, review the staged diff for private data, and distinguish shipped features from
plans. Don't run the installer against your real home merely to validate its documentation.

## Code map

| Path | Responsibility |
| --- | --- |
| `server/` | Hono REST API, WebSockets, and embedded pi SDK |
| `src/` | SolidJS frontend, built with Vite |
| `shared/` | Wire contracts and shared validation |
| `public/`, `src/design/` | Static assets and design system |
| `themes/` | Built-in JSON themes |
| `pi-config/` | Optional pi configuration and extensions |
| `scripts/install.sh` | Published-release installer |
| `.sova/spec/` | Product documentation, migrated from `spec/`; verify implementation before claiming a feature. Propose changes in a draft ([USAGE](.sova/spec/USAGE.md)) |
| `spec/` | Redirects from the old paths, and research in `spec/brainstorms/`; not requirements |

Use strict TypeScript and ESM; ask before adding dependencies. Read [CLAUDE.md](CLAUDE.md) for
architecture, ownership, and session-write safety before changing backend code. Treat live TUI
sessions as read-only: pi's SDK does not provide file locking.

## Live-server safety

Server-graph edits can restart the development server and kill workers spawned by hosted sessions.
Check for active work before editing. The default watcher gates restarts while sessions are busy;
do not force a restart during someone else's work. For backend work, running `pnpm start` without
watch avoids edit-triggered restarts. Frontend HMR does not restart the backend.

## Compatibility and extensions

Legacy `pi-web` strings remain where existing transcripts and browser state depend on them.
Do not bulk-rename them or rewrite transcripts to remove them. Current app state is written under
`~/.pi/agent/sova/`.

`pi-config/` is a standalone-installable bundle. Keep its installer and documentation
self-contained: its `install.sh` must work on a plain copy of the directory, with no imports from
Sova.
