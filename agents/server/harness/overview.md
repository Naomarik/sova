---
watches: ["server/harness/**", "shared/harness*.ts", "shared/wire-v1.ts", "server/harness-boundary.test.ts", "package.json"]
alsoUpdate: ["server/harness/pi/QUIRKS.md", "server/harness/pi/quirks.ts", "agents/server/harness/overview.md"]
---
# The pi harness

Sova speaks its own harness contract; pi is its one harness, behind one adapter (§app/harness). This
guide holds the boundary's rules and ratchets, the pi SDK facts Sova relies on, and the SDK surprises
found so far (pi 1.0.3).

## What lives here, and its docs

- `shared/harness.ts`: the contract, a types-only barrel over `shared/harness-core.ts`, `-tools`,
  `-history`, `-wire`, `-state`, `-session` (each imports only its siblings, with `import type`, and
  emits no code). Owned by **backend**.
- `server/harness/pi/`: the pi adapter. Its own docs: [README.md](../../../server/harness/pi/README.md)
  (the contract suite, the reader) and [QUIRKS.md](../../../server/harness/pi/QUIRKS.md) (typed rows in
  `quirks.ts`).
- `server/harness/state-kinds.ts`: the registry of Sova's per-session state kinds.
- Pi package on disk: the repo-pinned copy Sova runs, `node_modules/@earendil-works/pi-coding-agent/`
  (call it `<pi>`; its `<pi>/docs/` and `<pi>/examples/sdk/` are authoritative: read them, not your
  memory). Under pnpm it is a link into `node_modules/.pnpm/`, and its own dependencies (pi-ai, pi-tui, pi-agent-core, typebox) sit
  BESIDE its real path, not nested under it: resolve them from `realpath` of the package. Sova's own
  `package.json` also names pi-ai, pi-tui and typebox, at exactly the versions pi depends on, so that
  `pi-config/` extensions resolve those very copies and load as plain modules under Bun (quirk P26,
  §app.chat-processes/extension-loading); no Sova code outside the adapter imports them. A chat process
  (never the server or the terminal pi) runs with stand-ins for pi's terminal drawing code: pi-tui's
  screen and components, marked, pi's `modes/interactive/` but its theme, and its syntax highlighter
  (`server/harness/pi/headless.ts`, quirk P27, §app.chat-processes/no-terminal-drawing). pi-tui's text,
  key and colour helpers stay real. The global pi
  the TUI runs (`$(npm root -g)/@earendil-works/pi-coding-agent`, under mise's node install) is a
  separate install and may be another version: a fact read there is not a fact about Sova.

## Rules and contracts

### The boundary

- The server drives a live session only through `HarnessSession` (`shared/harness-session.ts`; pi's is
  `PiHarnessSession`, `server/harness/pi/session.ts`): a `ChatSession` has `chat.harness` and holds its
  pi runtime as a `PiChatHost` (`server/harness/pi/host.ts`), never the `AgentSession`. Tests that
  drive or patch pi directly use `piSession(chat)`/`piRuntime(chat)`
  (`server/harness/pi/testing/handle.ts`). (§app.harness/session)
- **Every reach into pi's internals is a quirk** in `server/harness/pi/QUIRKS.md` (typed rows:
  `quirks.ts`): a monkey-patch, private read, error text, ordering or internal API, each with its sites
  and a canary (`P1`…`P20`, `T1`) in `contract.test.ts`. On a pin bump or a TUI pi upgrade, run the
  canaries against that pi (command below); a failing canary is a triage by its row, never a test edit.
  `quirks-meta.test.ts` fails on a private cast, method-table cast or SDK-member assignment no row
  names. A new reach adds its row, canary and sites in the same change.
- `server/harness/pi/` is the only code that may reach pi: an import of `@earendil-works/*` in any form
  (static, type, `import()`, `require`, `import.meta.resolve`, or any string naming the package)
  anywhere else in `server/`, `shared/`, `src/` (tests included), or in a pi-config file the server or
  the web app imports at runtime, fails `pnpm test`. Only the adapter may import
  `pi-config/extensions/subagents/adapters/pi.ts`.
- `server/harness-boundary.test.ts` keeps five ratchets against
  `server/harness/boundary-baseline.json`, exact per file (tests are not counted for reads and writes):
  1. pi imports (runtime or type);
  2. raw pi entry reads: `calls` (the transcript's raw API by import binding: `parseLines`,
     `activeBranch`, `readActiveBranch`, `entryOf`, `normalizeEntries`, `normalizeEntry`, `rawOf`;
     `getBranch`/`getEntries`/`getEntry`/`rawBranch` by name), `shapes` (`.customType` reads, `.type`
     compared to a pi entry type, JSON-spelled `"type":"…"`/`"customType":"`/`"role":"` strings, and in
     `src/`/`shared/` pi event-name comparisons and `.meta` reads), `reaches` (`sessionManager`,
     members only pi's SessionManager has, the `SessionManager` class, and the `liveRead`/`stateOf`
     bridges);
  3. custom-entry writes (`appendCustomEntry`, `appendEntry`, `appendSpecialEntry`, every call site
     whatever its type argument, plus any function that forwards its own parameter as the entry type,
     listed in `wrappers`);
  4. pi agent-session reaches through `.session` (`chat.session.isStreaming`, a `.session.` member
     read; ask `chat.harness` instead);
  5. uses of `extensionEntries` (raw custom entries for pi-config cores), in its `extension` list.

  With no baseline at all, it fails a production import of `server/harness/pi/testing/` or
  `host-registry.ts`, a cast of `chat.harness` (or a string-named member on it), and a StateKind cast,
  declared or built outside `server/harness/state-kinds.ts`. Above the baseline fails, and so does
  below it: lower the baseline in the change that removes the hit. It also fails when a test file under
  `server/`, `shared/` or `src/` is matched by no glob in `scripts/run-tests.mjs`, or names itself an
  integration test other than `*.integration.test.ts` (each file is in exactly one tier).
- **The baseline only shrinks.** Never add a file, raise a count or list a new wrapper to make the test
  pass; if a change seems to need it, stop and ask the user. A working-tree baseline that grew past
  `HEAD`'s fails too. `SOVA_BOUNDARY_OUT=<absolute path> pnpm test -- server/harness-boundary.test.ts`
  writes the computed baseline for the diff; after a merge, regenerate it on the merged tree. One file
  entered the baseline by design: `shared/wire-v1.ts`, the v1 wire shim, which must read pi's v1 event
  names to turn an older server's or peer's frames into `SovaEvent`s; it stays pi-import-free, and no
  other file joins it.
- **New work is harness-neutral** (§app.harness/new-work): a server feature imports
  `shared/harness.ts` and `server/harness/`, never pi; new per-session state is a `StateKind`
  registered in `server/harness/state-kinds.ts` and written through `SessionState` (`ToolCtx.state()` /
  `StateView` to read), never `appendCustomEntry` or a raw custom entry with a new customType; history
  is read through the neutral reader, never `parseLines` plus a switch on `entry.type`; wire additions
  use `SovaEvent`/`RowFacts` (`shared/harness-wire.ts`), and `src/` never branches on pi entry or event
  names. A new Sova agent feature is never a new pi-config extension and never a new call to an
  extension's command handler; existing extensions are grandfathered, and the pi-config files the
  server imports stay pi-free (the import ratchet covers them).
- History is `HEntry`s (`shared/harness-history.ts`) from `server/harness/pi/reader.ts` (`readBranch`,
  `parsePi` + `branchOf`, the line scanners, `ctx.branch()`, `liveRead`), rows from `rowsOf(history)`.
  `parseLines`/`activeBranch`/`readActiveBranch` and `rawOf` are adapter-internal: outside it they are
  counted raw reads, and none is left outside the v1 shim (§app.harness/reader). State is read through
  a `StateView` (`stateView(history)`, `ToolCtx.state()`), never a fold over raw entries.
- Paths under the agent directory come from `agentRoot()` (`server/state-root.ts`), never `getAgentDir`
  (§app.harness/agent-root). A Sova tool is a `ToolSpec` (`shared/harness-tools.ts`); register it with
  `toPiTool`, read pi's context in a Sova hook only through `toolCtx(ctx)` (a `HookCtx`), and hand a pi
  tool to Sova code with `fromPiTool` (`server/harness/pi/tools.ts`, §app.harness/tools).
- A test that pins pi behaviour lives in `server/harness/pi/` (`contract.test.ts`), imports pi only
  through `server/harness/pi/testing/load-pi.ts`, and runs against another pi with
  `PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" pnpm test -- server/harness/pi/contract.test.ts`
  (run it on every pin bump and TUI pi upgrade). `server/harness/**/*.test.ts` is in the runner's GLOBS.
- The wire: the frontend asks for `wire=2` and renders live streaming from `SovaEvent`s;
  `shared/wire-v1.ts` maps an older server's v1 frames and rows.

### pi SDK facts (verified against the installed package, 1.0.3)

- **CRITICAL: no file locking.** If a session is open in a TUI, the webapp must NEVER write to it (no
  prompt/steer). Detect via `~/.pi/agent/sessions/live/*.json` (schema:
  `pi-config/extensions/sessions/public/SCHEMA.md`). Live sessions are read-only via `/ws/watch` (tail
  the JSONL with fs.watch + parse appended lines).
- Sessions: `~/.pi/agent/sessions/--<cwd with /→->--/<iso-ts>_<uuidv7>.jsonl`. Line 1 header:
  `{"type":"session","version":3,id,timestamp,cwd}`. Entries have `id`/`parentId` (tree). Types:
  `message`, `custom`, `model_change`, `thinking_level_change`, `usage` (0.86.0+), `compaction`,
  `session_info`, `label`, `branch_summary`, `context_edit` (0.87.0+) (`SessionEntry` union,
  `<pi>/dist/core/session-manager.d.ts:128`). Cheap listing: read only the first few lines; first user
  `message` = title; first `model_change` = model. Docs: `<pi>/docs/session-format.md`.
- **Sova writes `custom` entries with `customType: "sova-rewind"`** (`data: {targetId, fromLeafId}`)
  into webapp-owned session files. `navigateTree(id, {summarize:false})` only moves the in-memory leaf
  and `SessionManager.open()` takes the file's LAST entry as the leaf, so without this marker a reload
  or restart reverts a rewind (quirk P10). It is invisible (the transcript's `entryRows`,
  `server/transcript.ts`, gives no row for it; the TUI ignores it too), never LLM context, no usage.
  It is the `REWIND` kind of `server/harness/state-kinds.ts`, written through `SessionState` (pi
  adapter: `server/harness/pi/state.ts`) by `rewindSession` (`server/harness/pi/history-ops.ts`, the
  chat's `HarnessSession.rewindTo`), parented on the new leaf; the open-time deferred appends are
  flushed AFTER navigating (before, they would land on the abandoned branch). Every other Sova custom
  entry works the same way (§app.harness/state).
- SDK: `createAgentSession`, `createAgentSessionRuntime`, `SessionManager.open(path)/create(cwd)`,
  `ModelRuntime.create()` (no args → reuses `~/.pi/agent` auth). Events via `session.subscribe`. Docs:
  `<pi>/docs/sdk.md`; examples: `<pi>/examples/sdk/11-sessions.ts`, `13-session-runtime.ts`.
- Extension dialog bridge (ExtensionUIContext) pattern: `<pi>/dist/modes/rpc/rpc-mode.js`
  (`createExtensionUIContext` at line 83, bound via `bindExtensions({uiContext, mode:"rpc", ...})` at
  line 231). Sova's is `createPiUiContext`/`bindPiExtensions` (`server/harness/pi/ui-bridge.ts`), bound
  by `PiChatHost.bindExtensions` (`server/harness/pi/host.ts`).

### SDK surprises (pi 1.0.3)

`<pi>` is the pi package directory above; `<pi-ai>` is pi-ai beside its real path.

- `SessionManager.open(path)` is NOT read-only: `loadEntriesFromFile` appends `"\n"` to a trailing
  partial line (`<pi>/dist/core/session-manager.js:367`) and `_rewriteFile()` (`:754`) rewrites the whole
  file when migrating old versions (`:722`). Never call it on a file a TUI may own: transcript/watch
  use our own parser (`server/harness/pi/reader.ts`); `open()` only for webapp-owned chats.
- `SessionManager.create(cwd)` defers writing the file until the first user or assistant message
  (`_persist()`/`_hasConversation()`, `<pi>/dist/core/session-manager.js:791-800`, since 0.99.0; through
  0.87.1 it waited for the first assistant reply; quirk P11). `POST /api/sessions` writes the header
  line itself so the new session exists on disk immediately.
- Opening a chat runtime must not write: the SDK appends model_change/thinking_level_change at
  construction (empty sessions, or no thinking entry on the branch; `<pi>/dist/core/sdk.js:281-289`, the
  same since 0.85.1). `openPiSession` (`server/harness/pi/open.ts`, quirk P1) defers those two appends
  and the chat replays them right before its first write (`ChatSession.flushDeferredAppends`); a
  never-prompted session stays untouched.
- pi's `theme` singleton is not re-exported from the package entry (`<pi>/dist/index.d.ts` exports
  `initTheme`/`Theme` only, though `theme` exists on `<pi>/dist/modes/interactive/theme/theme.ts`). The
  ExtensionUIContext bridge (`currentTheme`, `server/harness/pi/ui-bridge.ts`, quirk P17) calls
  `initTheme()` and reads `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`, the key pi
  sets in `<pi>/dist/modes/interactive/theme/theme.js:524`. It asks for `"dark"`: pi 1.0 (0.99.0) defaults
  `initTheme()` to `system` (the terminal's ANSI palette), and its `dark` is 0.99.0's revised palette.
- The sessions extension also loads inside our embedded runtimes and writes `live/*.json` with the
  server's own pid. `server/live.ts` ignores own-pid and dead-pid records, otherwise every
  webapp-owned session would look TUI-busy.
- pi 0.86.0 writes two entry shapes 0.85.1 never emitted, and our OWN runtimes write them too:
  `message` entries with `role:"system"` (the prompt/tool loadout: `content`, `sections`,
  `toolsAdded`/`toolsRemoved`; `SystemMessage` in `<pi-ai>/dist/types.d.ts:331`) and top-level
  `type:"usage"` entries (`UsageEntry`, `session-manager.d.ts:36`, written by
  `SessionManager.appendUsage()`; only caller `<pi>/dist/core/cache-warmer.js:249` with `kind:"cache_warm"`).
  Cache warming is ON by default (`getCacheWarmingMode()` → `"streaming"`,
  `<pi>/dist/core/settings-manager.js:637`), so expect these in webapp-owned sessions. The webapp hides both
  (their `system` and `usage-record` kinds give no rows, `server/transcript.ts` `entryRows`) and never
  counts them: a cache warm's spend is the usage ledger's record, written when the warm call ends
  (llm-inflight `runtime.ts`). They never move context fill: `contextForBranch` reads
  assistant-message usage only (`messageContextTokens`, `server/harness/pi/usage.ts`). `compaction`
  entries also gained a `systemMessage` field (additive; we ignore it).
- Context fill = input+cacheRead+cacheWrite of the last assistant usage on the branch; a compaction
  after it → `context: null` until the next reply (window: SDK registry, else models-store.json).
- **`steer()`/`followUp()` run extension `input` handlers** (`source` defaults to `"interactive"`,
  `<pi>/dist/core/agent-session.js` `_queueUserInput`); on 0.85.1 they bypassed them (`steer()` went
  straight to `_queueSteer`). Narrow blast radius: `prompt()` ALREADY ran them on 0.85.1
  (`agent-session.js:842`), and `ChatSession.handOffQueued` (`server/chat-manager.ts`) only calls
  `harness.steer()` while streaming, for a steer item whose text is not a `/command`; every other web
  send goes through `harness.send()` (pi's `prompt()`). So the pi-config handlers (`vision-delegate`,
  which describes attached images for non-vision models, and `wake-nudge`) have always run against our
  runtimes; the new case is the mid-stream steer. A handler returning `{action:"handled"}` silently
  swallows the message (`<pi>/dist/core/extensions/runner.js:1112`); `null`/`undefined` is the safe
  fall-through, and neither of ours returns `handled`. A mid-stream steer that CARRIES IMAGES while the
  model cannot see them waits on `vision-delegate`'s describe call before it is queued
  (`pi-config/extensions/vision-delegate/index.ts:180-191`), so it can land after the turn it meant to
  interrupt: nothing is dropped, and plain steers are unaffected.
- Unidentified writers (e.g. a headless/orchestrating pi, not in the live registry): `/ws/chat`
  refuses (`code:"busy"`, close 4409) a session the server doesn't hold whose mtime is < 120 s old
  (`RECENT_WRITE_MS` in `server/write-guard.ts`, shared with the frontend) unless `&force=1`. While
  holding a runtime, `ForeignWriteGuard` checks appended lines carry ids our session knows
  (`harness.hasEntry`); any foreign line → busy on every prompt/steer until a `&force=1` reconnect
  reloads the runtime from disk. TUI-live sessions stay refused even with force.
- `SessionSummary.origin`: ids of sessions spawned via `POST /api/sessions` persist in
  `~/.pi/agent/sova/web-sessions.json` (`server/web-sessions.ts`); everything else is "external".
  Writes re-read + merge (safe with several servers); reads use the startup copy plus this server's
  own adds, so ids another running server adds show as "web" here only after a restart.
- Images: 1.0.3 `ImageContent` is still `{type:"image", data, mimeType}` (`<pi-ai>/dist/types.d.ts:277`)
  for prompt/steer/followUp AND storage (`<pi>/docs/sdk.md`'s `source:{type:"base64"}` example is stale).
- Model favorites are the command-palette's `~/.pi/agent/model-favorites.json`
  (`{version:1, models:[{provider,id}]}`), read and written through that extension's own
  `ModelFavorites` (`server/model-favorites.ts`; the picker's star and Ctrl+F →
  `PUT /api/models/favorite`). A malformed file lists no favorites and refuses every write; it is
  never overwritten.
- pi 0.87.0 made the `SessionManager` canonical for model context: every request is built from
  `sessionManager.buildSessionProjection()` (`<pi>/dist/core/agent-session.js`
  `prepareNextTurnWithContext`), and `agent.state.messages` is overwritten from it
  (`_refreshFinalizedContext`, `:418`). ASSIGNING `agent.state.messages` no longer reaches the model:
  append through the session's SessionManager and call `session.refreshContext()`
  (`agent-session.d.ts:314`); the `btw` extension's side-thread seed does exactly that
  (`seedBtwSession`), and so does the chat's `enterQueued` through
  `HarnessSession.appendUserMessage`/`refreshContext` (quirk P6). Sova assigns it nowhere.
- pi 0.87.0 `context_edit` entries (`ContextEditEntry`, `session-manager.d.ts`: `targetId`,
  `replacement: {content} | null`) change what an earlier entry sends the model, never raw history. pi
  writes one ITSELF on every auto-retry and overflow recovery (`_omitRecoveryAttempt`,
  `agent-session.js:667`, emitted as `entry_appended`), so webapp-owned sessions get them. The
  transcript renders nothing for them (`entryRows`) and the edited message keeps its row;
  `contextForBranch` does not treat one as staleness (pi's own accounting does: usage before a later
  edit is not the context size). In practice pi's only trailing edit is followed by a retry reply or a
  compaction, both of which already reset the fill.
- pi 0.87.0 defers a `prompt()` made while `agent_settled` is being emitted (session listeners
  included, `agent-session.js:531-553`): it resolves at once, and its turn runs inside the PREVIOUS
  `prompt()`'s promise, whose rejection then carries the deferred turn's error. An item still held when
  the queue wakes on `agent_settled` is handed off synchronously inside that window, so its turn takes
  this path (quirk P5): it still starts, and its failure surfaces through the previous call's failure
  handling, which every `harness.send()` call site in `server/chat-manager.ts` attaches (`.catch`, or
  the returned `turn`). Topic batches (`server/topic-delivery.ts`, `ChatSession.deliverTopicBatch`)
  stay out of that window on purpose: a settle only schedules a drain on a timer, after the web queue's
  own hand-off, and a batch counts as delivered at its user entry's `message_end` (the
  `sova-topic-delivered` marker), never when its `prompt()` resolves.
- `Agent.peekQueuedMessages()` exists from 0.87.0 (pi-agent-core `agent.d.ts:102`) but Sova's queue
  deliberately does not use it; `server/chat-queue-clients.test.ts` pins its presence.
- pi 1.0 `PromptOptions.preflightResult` gets a disposition, `"started" | "queued" | "handled"`
  (`PromptDisposition`), not a boolean, and a refused prompt (already processing, compaction, no model
  or auth) gets no call at all; through 0.87.1 it was `preflightResult(false)`. The adapter drops the
  disposition: `SendOptions.onAccepted` stays `() => void` (quirk P15).
- pi 1.0 `steer()`/`followUp()` resolve to a `QueuedInputDisposition` (`"queued" | "handled"`,
  `agent-session.js:1680`); `PiHarnessSession.steer` drops it and stays `Promise<void>`.
- pi 1.0's built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:mcp`,
  `builtin:llama.cpp`, `<pi>/dist/extensions/index.js`) load only in the CLI (`<pi>/dist/main.js` adds them); SDK
  runtimes such as Sova's do not get them (`<pi>/docs/sdk.md` "codemode-mcp"), so no MCP, tool_search or
  llama.cpp provider in webapp-owned sessions unless Sova adds the factories. Sova adds one: codemode
  (`server/harness/pi/codemode.ts`, in `DEFAULT_EXTENSION_FACTORIES`, quirk P21), registered inactive
  and switched by the mode extension's `codemode` minor mode (§chat.mode-menu/codemode), the same in
  Claude Code chats (off: nowhere in the loadout; a toggle restarts the CLI). Its scripts run in a
  `node:worker_threads` Worker with QuickJS; nested calls carry `parentToolCallId` (`HarnessEvent`
  `nested`, `SovaEvent` `parentCallId`) and are no rows or live tools.

## When you change X, also update Y

| You change | Also |
| --- | --- |
| a new reach into pi internals (patch, private read, error text, ordering) | its row in `server/harness/pi/QUIRKS.md` + `quirks.ts`, its canary in `contract.test.ts`, its sites, same change |
| a hit removed from a ratchet | lower `server/harness/boundary-baseline.json` in the same change (never raise it: ask) |
| new per-session state | a `StateKind` in `server/harness/state-kinds.ts` |
| the pi pin in `package.json`, or the TUI's pi | run the contract suite against that pi; triage failures by QUIRKS.md row; refresh this guide's SDK facts |
| the pi pin in `package.json` | pin `@earendil-works/pi-ai`, `@earendil-works/pi-tui` and `typebox` beside it to the exact versions the new pi depends on, then `pnpm install` (`server/harness/pi/extension-deps.test.ts` fails on any mismatch or second copy); run `pnpm test:int -- server/harness/pi/headless.integration.test.ts` (pi-tui's export names with and without the stand-ins, and a chat turn's stand-in log) |
| a new test file under `server/`, `shared/`, `src/` | make sure a glob in `scripts/run-tests.mjs` matches it |
| after a merge touching the boundary | regenerate the baseline on the merged tree |

While working: `pnpm test` (the boundary and quirk tests are unit tier). Landing runs both tiers.
