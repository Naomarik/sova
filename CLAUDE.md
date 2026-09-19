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

## Backend notes (SDK surprises, pi 0.85.1)

- `SessionManager.open(path)` is NOT read-only: it appends `"\n"` to a trailing partial line and
  rewrites the file when migrating old versions. Never call it on a file a TUI may own —
  transcript/watch use our own parser (`server/transcript.ts`); `open()` only for webapp-owned chats.
- `SessionManager.create(cwd)` defers writing the file until the first assistant reply.
  `POST /api/sessions` writes the header line itself so the new session exists on disk immediately.
- pi's `theme` singleton is not exported (only `initTheme`). The ExtensionUIContext bridge calls
  `initTheme()` and reads `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`.
- The sessions extension also loads inside our embedded runtimes and writes `live/*.json` with the
  server's own pid. `server/live.ts` ignores own-pid and dead-pid records, otherwise every
  webapp-owned session would look TUI-busy.
- Unidentified writers (e.g. a headless/orchestrating pi, not in the live registry): `/ws/chat` refuses
  (`code:"busy"`, close 4409) a session the server doesn't hold whose mtime is < 120s old
  (`RECENT_WRITE_MS` in `server/write-guard.ts`, shared constant with the frontend) unless `&force=1`.
  While holding a runtime, `ForeignWriteGuard` checks appended lines carry ids our SessionManager knows;
  any foreign line → busy on every prompt/steer until a `&force=1` reconnect reloads the runtime from disk.
  TUI-live sessions stay refused even with force.
- `SessionSummary.origin`: ids of sessions spawned via `POST /api/sessions` persist in
  `~/.pi/agent/pi-web/web-sessions.json` (`server/web-sessions.ts`); everything else is "external".
  Writes re-read + merge (safe with several servers); reads use the startup copy plus this
  server's own adds, so ids another running server adds show as "web" here only after a restart.
- Opening a chat runtime must not write: the SDK appends model_change/thinking_level_change at
  construction (empty sessions, or no thinking entry on the branch). `openSession` defers those two
  appends and replays them right before the first prompt/steer; a never-prompted session stays untouched.
- Images: 0.85.1 `ImageContent` is `{type:"image", data, mimeType}` for prompt/steer/followUp AND storage
  (sdk.md's `source:{type:"base64"}` example is stale). Model favorites come READ-ONLY from the
  command-palette's `~/.pi/agent/model-favorites.json` (`{version:1, models:[{provider,id}]}`).
- Context fill = input+cacheRead+cacheWrite of the last assistant usage on the branch; a compaction after it → `context: null` until the next reply (window: SDK registry, else models-store.json).
