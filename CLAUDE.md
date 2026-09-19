# pi-web

Webapp interface for the pi coding agent (npm: `@earendil-works/pi-coding-agent`, pinned **0.85.1**).
Single local user. Goals: list all sessions, view transcripts, chat in webapp-owned sessions,
live-watch sessions that are open in the CLI/TUI, spawn new sessions.

## Layout & ownership

- `shared/protocol.ts` — the REST/WS wire contract. Change only with team coordination.
- `server/` — Node backend: Hono (REST) + `ws` (2 WS endpoints), embeds the pi SDK. Owned by **backend**.
- `src/` — SolidJS + TS frontend (Vite, vite-plugin-solid; HMR = live reload). Owned by **frontend**, except `src/design/`.
- `src/design/`, `DESIGN_NOTES.md`, `public/` — design tokens, base CSS, fonts/icons, UX spec. Owned by **designer**.
- `.claude/skills/fold-ai-dev-design/` — the design system skill (copied from foldaidev). READ IT.

## Commands

- `npm run dev:server` (port **4800**) and `npm run dev:web` (Vite, proxies /api + /ws to 4800)
- `npm run typecheck` — must pass. `npm run build` — must pass.

## pi SDK facts (verified against the installed package)

Pi package on disk: `/home/user/.local/share/mise/installs/node/25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/`
(docs/ and examples/sdk/ there are authoritative — read them, not your memory).

- Sessions: `~/.pi/agent/sessions/--<cwd with /→->--/<iso-ts>_<uuidv7>.jsonl`.
  Line 1 header: `{"type":"session","version":3,id,timestamp,cwd}`.
  Entries have `id`/`parentId` (tree). Types: `message`, `custom`, `model_change`,
  `thinking_level_change`, `compaction`, `session_info`, `label`, `branch_summary`.
  Cheap listing: read only the first few lines; first user `message` = title; first `model_change` = model.
  Docs: `docs/session-format.md`.
- SDK: `createAgentSession`, `createAgentSessionRuntime`, `SessionManager.open(path)/create(cwd)`,
  `ModelRuntime.create()` (no args → reuses `~/.pi/agent` auth). Events via `session.subscribe`.
  Docs: `docs/sdk.md`; examples: `examples/sdk/11-sessions.ts`, `13-session-runtime.ts`.
- **CRITICAL: no file locking.** If a session is open in a TUI, the webapp must NEVER write to it
  (no prompt/steer). Detect via `~/.pi/agent/sessions/live/*.json`
  (schema: `~/pi-config/extensions/sessions/README.md`). Live sessions: read-only via `/ws/watch`
  (tail the JSONL with fs.watch + parse appended lines).
- Extension dialog bridge (ExtensionUIContext) pattern: `dist/modes/rpc/rpc-mode.js` lines ~60–260.

## Conventions

TS strict, ESM, no new dependencies without asking. Server normalizes JSONL entries into
`TranscriptItem`; frontend renders those, and renders live streaming from the raw passthrough events.
Frontend is SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.
