# pi-web

Webapp interface for the pi coding agent (npm: `@earendil-works/pi-coding-agent`, pinned **0.86.1**).
Single local user. Goals: list all sessions, view transcripts, chat in webapp-owned sessions,
live-watch sessions that are open in the CLI/TUI, spawn new sessions.

## Layout & ownership

- `shared/protocol.ts` — the REST/WS wire contract. Change only with team coordination.
- `server/` — Node backend: Hono (REST) + `ws` (2 WS endpoints), embeds the pi SDK. Owned by **backend**.
- `src/` — SolidJS + TS frontend (Vite, vite-plugin-solid; HMR = live reload). Owned by **frontend**, except `src/design/`.
- `src/design/`, `spec/`, `public/` — design tokens, base CSS, fonts/icons, UX spec. Owned by **designer**.
- `.claude/skills/` — project skills, registered for pi by `.pi/settings.json` (`"skills": ["../.claude/skills"]`;
  the folder is also trusted in `~/.pi/agent/trust.json`, or pi prompts each session).
  `fold-ai-dev-design/` — the design system skill (copied from foldaidev). READ IT.
  `playwright/` — CDP browser automation via `scripts/start-browser.sh` + `scripts/pw.sh`; read its
  SKILL.md before any browser work (own browser per caller, `resize` must follow `navigate`, a bare
  `console` reloads the page).
- `pi-config/` — the user's pi config and extensions (merged in from Naomarik/pi-config with history;
  `~/pi-config` is a compat symlink to it). Shared, not owned by any team. `~/.pi/agent` symlinks into
  this directory, so an edit here changes the user's LIVE TUI on its next `/reload`, and every
  runtime pi-web embeds. Treat it like `shared/protocol.ts`: coordinate before changing any contract
  pi-web parses (sessions live registry `sessions/live/*.json`, usage-status cache, subagents
  teams/snapshots, topic-outline state, command-palette `model-favorites.json`, mode `mode.json` =
  the DEFAULT mode for new sessions; the active mode is per session, in the session's own `mode`
  custom entry, and pi-web restores it with `restoreActive` from `state.ts`).
  Not covered by pi-web's tsconfig, with two exceptions: `server/mode-state.ts` imports
  `pi-config/extensions/mode/state.ts` and `minor.ts` (hence `allowImportingTsExtensions`), and
  `server/targets.ts` imports `pi-config/extensions/remote/argv.ts` (the target schema,
  validation and the single argv builder that both the `remote` extension and the web server use to
  run a command on a target) and `pi-config/extensions/remote/mount.ts` (the ONE sshfs mount module:
  `mountArgv`/`mount`/`unmount`/`verifyMounted`/`isMounted`; `server/chat-manager.ts` imports it
  too, for its hung-mount guard), so an edit to any of the four can break pi-web's typecheck. Keep
  them pi-runtime-free (node builtins and, for the mode pair, each other only), and import nothing
  else from pi-config. `argv.ts` is also the quoting boundary: every path that reaches a far shell is
  single-quote-escaped there, and callers spawn its argv without a local shell. The web mode switch calls that extension's
  `/mode` command handler directly (`ChatSession.applyMode`), so its arguments are a contract too.
  **sshfs mounts** (a remote target's optional `mount: {remote, local}` config): every mount is
  created by `remote/mount.ts` with `reconnect` and the ServerAlive pair — a hung fuse mount
  blocks the syscall, and pi-web checks session cwds with sync fs calls **on the server's event
  loop**, so a bare `statSync`/`existsSync` into a hung mount freezes the whole webapp. Never
  bare-stat a path under a target's mount point: `isMounted` (a /proc read, never touches the
  mount) first, then the bounded child-process `verifyMounted`. The watcher does NOT watch
  `pi-config/extensions/remote/**`, so edits there (argv.ts, mount.ts) don't restart the running
  server — it keeps the old code until its next restart.
  Tests run per extension (see `pi-config/README.md`). `pi-config/install.sh` must stay standalone,
  needing nothing outside `pi-config/`.

## Commands

- `npm run dev:server` (port **4800**) and `npm run dev:web` (Vite, proxies /api + /ws to 4800)
- `npm run typecheck` — must pass. `npm run build` — must pass.
- `npm test` — unit tests (`server/*.test.ts`, `src/lib/*.test.ts`). They're ESM TypeScript with
  extensionless imports, so they run under `tsx --test`; plain `node --test <file>` fails with
  ERR_MODULE_NOT_FOUND.
- `pi-config/install.sh` links `pi-config/` into `~/.pi/agent`; `pi-config/install.sh --check` verifies
  that without changing anything.

## Dev-server restart pitfall (worker suicide)

`npm run dev:server` is `tsx watch`: editing ANY file in the server's live import graph —
non-test `server/**` files, `shared/**`, and ANY non-test file under `pi-config/extensions/mode/`
(`scripts/dev-server.mjs` watches that whole directory, not just the two files pi-web imports) —
restarts the server process within ~100ms. Workers spawned by a session hosted in that server
(pi or claude-code backend from agent_spawn/team_create) are CHILD PROCESSES of it with piped
stdio: the restart kills them mid-task and zeroes the in-memory subagent registry (agent_list
returns empty; the dead worker's transcript is "unavailable"). Hosted chat sessions themselves
survive (JSONL persistence; the webapp reconnects and the runtime reopens). Workers don't.

Rules:
- Before ANY server-graph edit: check for live workers in ANY hosted session (read
  `~/.pi/agent/sessions/live/p<server-pid>-*.json`, heartbeat ≤ 30s: `workerCounts.working > 0`,
  or another session's `activity.state === "working"` — your own turn counts too). Hold the edit
  if busy: background workers from earlier turns and other web sessions die with the restart.
- While the watch server runs, delegate only `src/**`, test files (`server/*.test.ts`), and docs.
- Apply server-graph edits from the orchestrator session itself, batched into as few write bursts
  as possible and as the LAST step of a turn — the restart may cut the turn, but the edits persist.
- `npm run dev:server` runs `scripts/dev-server.mjs`: a gated watcher that holds restarts while
  any live record shows working subagents or in-flight turns (`r` key or SIGUSR2 forces).
  `dev:server:tsx` is the old plain watch. Hosted runtimes are never idle-disposed: they live
  until archived (the close gesture — running subagents die with it), a foreign-writer reload,
  or server shutdown.
- Or run the server without watch (`npx tsx server/index.ts`) for the duration of server-side work.

## pi-config mirror

The public repo github.com/Naomarik/pi-config is a `git subtree split` of `pi-config/`, so it stays
installable without pi-web. After committing pi-config changes on `master`, refresh it with:

```sh
git subtree split --prefix=pi-config -b pi-config-mirror   # creates, or fast-forwards, the local branch
git push git@github.com:Naomarik/pi-config.git pi-config-mirror:master
```

The split is deterministic, and it reproduces the original pi-config commit hashes (the import used
`git filter-repo --to-subdirectory-filter`), so pushes fast-forward. Never use `--force`. If a push is
rejected, pi-web history under `pi-config/` was rewritten, and that needs a look first. Keep anything the mirror needs, such as README/LICENSE/install.sh, inside `pi-config/`.

## pi SDK facts (verified against the installed package, 0.86.1)

Pi package on disk: `/home/user/.local/share/mise/installs/node/25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/`
(docs/ and examples/sdk/ there are authoritative — read them, not your memory).

- Sessions: `~/.pi/agent/sessions/--<cwd with /→->--/<iso-ts>_<uuidv7>.jsonl`.
  Line 1 header: `{"type":"session","version":3,id,timestamp,cwd}`.
  Entries have `id`/`parentId` (tree). Types: `message`, `custom`, `model_change`,
  `thinking_level_change`, `usage` (0.86.0+), `compaction`, `session_info`, `label`, `branch_summary`
  (`SessionEntry` union, `dist/core/session-manager.d.ts:117`).
  Cheap listing: read only the first few lines; first user `message` = title; first `model_change` = model.
  Docs: `docs/session-format.md`.
- **pi-web writes `custom` entries with `customType: "pi-web-rewind"`** (`data: {targetId, fromLeafId}`)
  into webapp-owned session files. `navigateTree(id, {summarize:false})` only moves the in-memory
  leaf and `SessionManager.open()` takes the file's LAST entry as the leaf, so without this marker a
  reload or restart reverts a rewind. It is invisible (normalizeEntry renders unknown custom types as
  nothing; the TUI ignores it too), never LLM context, no usage. Written by `rewindSession` in
  `server/chat-manager.ts`, parented on the new leaf; the open-time deferred appends are flushed
  AFTER navigating (before, they would land on the abandoned branch).
- SDK: `createAgentSession`, `createAgentSessionRuntime`, `SessionManager.open(path)/create(cwd)`,
  `ModelRuntime.create()` (no args → reuses `~/.pi/agent` auth). Events via `session.subscribe`.
  Docs: `docs/sdk.md`; examples: `examples/sdk/11-sessions.ts`, `13-session-runtime.ts`.
- **CRITICAL: no file locking.** If a session is open in a TUI, the webapp must NEVER write to it
  (no prompt/steer). Detect via `~/.pi/agent/sessions/live/*.json`
  (schema: `pi-config/extensions/sessions/public/SCHEMA.md`). Live sessions: read-only via `/ws/watch`
  (tail the JSONL with fs.watch + parse appended lines).
- Extension dialog bridge (ExtensionUIContext) pattern: `dist/modes/rpc/rpc-mode.js` —
  `createExtensionUIContext` at line 83, bound via `bindExtensions({uiContext, mode:"rpc", ...})` at line 231.

## Conventions

TS strict, ESM, no new dependencies without asking. Server normalizes JSONL entries into
`TranscriptItem`; frontend renders those, and renders live streaming from the raw passthrough events.
Frontend is SolidJS (NOT React): signals/stores, `<For>/<Show>`, `onCleanup` for WS teardown.

## Backend notes (SDK surprises, pi 0.86.1)

- `SessionManager.open(path)` is NOT read-only: `loadEntriesFromFile` appends `"\n"` to a trailing
  partial line (`dist/core/session-manager.js:322`) and `_rewriteFile()` (`:709`) rewrites the whole
  file when migrating old versions (`:677`). Never call it on a file a TUI may own —
  transcript/watch use our own parser (`server/transcript.ts`); `open()` only for webapp-owned chats.
- `SessionManager.create(cwd)` defers writing the file until the first assistant reply
  (`_persist()`, `dist/core/session-manager.js:740` — byte-identical to 0.85.1).
  `POST /api/sessions` writes the header line itself so the new session exists on disk immediately.
- pi's `theme` singleton is not re-exported from the package entry (`dist/index.d.ts` exports
  `initTheme`/`Theme` only, though `theme` exists on `modes/interactive/theme/theme.ts`). The
  ExtensionUIContext bridge calls `initTheme()` and reads
  `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` — same key pi sets in
  `dist/modes/interactive/theme/theme.js:536`.
- The sessions extension also loads inside our embedded runtimes and writes `live/*.json` with the
  server's own pid. `server/live.ts` ignores own-pid and dead-pid records, otherwise every
  webapp-owned session would look TUI-busy.
- pi 0.86.0 writes two entry shapes 0.85.1 never emitted, and since the pin moved our OWN runtimes
  write them too: `message` entries with `role:"system"` (the prompt/tool loadout — `content`,
  `sections`, `toolsAdded`/`toolsRemoved`; `SystemMessage` in pi-ai `dist/types.d.ts:331`) and
  top-level `type:"usage"` entries (`UsageEntry`, `session-manager.d.ts:36`, written by
  `SessionManager.appendUsage()`; only caller is `dist/core/cache-warmer.js:241` with
  `kind:"cache_warm"`). Cache warming is ON by default (`getCacheWarmingMode()` →`"streaming"`,
  `dist/core/settings-manager.js:637`), so expect these in webapp-owned sessions. The webapp hides
  both from the transcript (`server/transcript.ts:165` and `:292`) and counts only the usage ones in
  session totals (`server/transcript-usage.ts:66`, deduped by entry id). They never move context
  fill: `contextForBranch` reads assistant-message usage only (`server/transcript.ts:361`).
  `compaction` entries also gained a `systemMessage` field (additive; we ignore it).
- **`steer()`/`followUp()` now run extension `input` handlers** (`source` defaults to `"interactive"`,
  `dist/core/agent-session.js` `_queueUserInput`); on 0.85.1 they bypassed them entirely
  (0.85.1 `steer()` went straight to `_queueSteer`). Narrow blast radius: `prompt()` ALREADY ran them
  on 0.85.1 (`agent-session.js:842`), and `server/chat-manager.ts:499-501` only calls `steer()` when
  `isStreaming && !text.startsWith("/")` — every other web send already went through `prompt()`. So
  the pi-config handlers (`vision-delegate`, which describes attached images for non-vision models,
  and `wake-nudge`) have always run against our runtimes; the genuinely new case is the mid-stream
  steer. A handler returning `{action:"handled"}` silently swallows the message
  (`dist/core/extensions/runner.js:1008`); returning `null`/`undefined` is the safe fall-through, and
  neither of ours returns `handled`. A mid-stream steer that CARRIES IMAGES while the active model
  cannot see them waits on `vision-delegate`'s describe call before it is queued
  (`pi-config/extensions/vision-delegate/index.ts:150-161`), so it can land after the turn it meant
  to interrupt — nothing is dropped, and plain steers are unaffected.
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
  construction (empty sessions, or no thinking entry on the branch — `dist/core/sdk.js:260-272`,
  unchanged from 0.85.1). `openSession` defers those two
  appends and replays them right before the first prompt/steer; a never-prompted session stays untouched.
- Images: 0.86.1 `ImageContent` is still `{type:"image", data, mimeType}` (pi-ai `dist/types.d.ts:256`)
  for prompt/steer/followUp AND storage
  (sdk.md's `source:{type:"base64"}` example is stale). Model favorites come READ-ONLY from the
  command-palette's `~/.pi/agent/model-favorites.json` (`{version:1, models:[{provider,id}]}`).
- Context fill = input+cacheRead+cacheWrite of the last assistant usage on the branch; a compaction after it → `context: null` until the next reply (window: SDK registry, else models-store.json).
