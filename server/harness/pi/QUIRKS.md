# pi quirks

Sova embeds pi (`@earendil-works/pi-coding-agent`) and in places leans on behaviour pi does not promise:
a method it replaces on a live object, a private member it reads, an error it recognises by its text, an
order in which pi does two things, an API pi keeps for its own modes. This page lists every one of them.
`quirks.ts` is the same list as typed rows; this page is the human view (the model is
`docs/bun-quirks.md`).

The rules:

- **Every quirk has a canary** in `contract.test.ts`, titled with the quirk's id and name. The canary
  asserts that pi still behaves the way the Sova code relies on. It runs in every `pnpm test` against the
  pinned pi. Run it against another pi before a pin bump or a TUI pi upgrade:
  `PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" pnpm test -- server/harness/pi/contract.test.ts`
  (see `README.md`).
- **A failing canary is a triage, not a fix-the-test.** Find the row, read what Sova relies on, and look at
  the sites in "Where". If pi stopped needing the workaround (the canary's message usually says "fixed: …"),
  retire it: delete the workaround, the canary and the row. If pi changed shape, change the sites and the
  canary together.
- **Every reach into pi's internals has a row.** `quirks-meta.test.ts` fails on a private cast
  (`as unknown as { _…`), a method-table cast of an SDK object, or an assignment over an SDK member
  (`sm.appendCompaction = …`, `agent.streamFunction = …`) anywhere in `server/` or `shared/` (tests
  excluded) that is not inside a declaration some row names. It also keeps this table, `quirks.ts` and the
  canary titles in step, and checks that every cited symbol is declared in its file.
- **Sites are symbols, not lines.** "Where" names a function or `Class.method`. When a site moves (the M5
  moves into `server/harness/pi/`), the row's file and symbol move in the same change.

Kinds: **monkey-patch** (Sova replaces a pi member on a live object), **private-read**, **private-write**
(a test double), **error-text** (an error recognised by its message), **semantic** (a public method's
undocumented behaviour), **ordering** (the order or tick of two pi steps), **internal-API** (an API pi
keeps for its own modes).

## The quirks

Paths in "Where" are under `server/`.

| Quirk | Kind | Where | pi | Retire when |
|---|---|---|---|---|
| P1 open-writes-nothing | monkey-patch | `openPiSession` (harness/pi/open.ts), `ChatSession.flushDeferredAppends` (chat-manager.ts), `restatesRecordedModel` (harness/pi/open.ts) | `createAgentSession`, `SessionManager.appendModelChange`, `SessionManager.appendThinkingLevelChange` | pi stops appending at construction, or offers an open that writes nothing |
| P2 compaction-write-wrap | monkey-patch | `compactSession` (harness/pi/history-ops.ts), `PiHarnessSession.compact` (harness/pi/session.ts) | `AgentSession.compact`, `SessionManager.appendCompaction` | pi offers a pre-write hook for a compaction |
| P3 compaction-error-text | error-text | `compactSession` (harness/pi/history-ops.ts), `isCompactionInProgress` (harness/pi/history-ops.ts) | `AgentSession.compact`, `AgentSession.prompt` | pi throws typed errors |
| P4 already-processing | error-text | `isAlreadyProcessing` (harness/pi/session.ts), `ChatSession.linkToSdk` (chat-manager.ts) | `AgentSession.prompt`, `Agent.prompt` | pi throws a typed error |
| P5 settle-window | private-read | `PiHarnessSession.inSettleWindow` (harness/pi/session.ts), `ChatSession.deliverTopicBatch`, `ChatSession.acceptPrompt` (chat-manager.ts), `WebQueue.pumpOnce` (queue.ts) | `AgentSession._isEmittingAgentSettled`, `AgentSession.prompt`, `AgentSession._emitAgentSettled` | pi exposes the settle window, or stops deferring a prompt made inside it |
| P6 refresh-context | semantic | `PiHarnessSession.appendUserMessage` (harness/pi/session.ts), `PiHarnessSession.refreshContext` (harness/pi/session.ts), `ChatSession.enterQueued` (chat-manager.ts) | `AgentSession.refreshContext`, `SessionManager.appendMessage` | never: a contract worth keeping a canary for |
| P7 user-turns-wrap | monkey-patch | `watchUserMessages` (harness/pi/turns.ts), `UserTurns.watch` (user-turns.ts), `SendKeys.watch` (send-keys.ts) | `Agent.prompt`, `Agent.steer`, `Agent.followUp`, `AgentSession.prompt`, `AgentSession.steer`, `AgentSession.followUp` | pi offers an input-identity hook |
| P8 stream-function | monkey-patch | `useSlicedProviderReads` (runtime-quirks.ts), `PiChatHost.useSlicedProviderReads` (harness/pi/host.ts) | `Agent.streamFunction` | the fetch-read-size Bun quirk retires (docs/bun-quirks.md), or pi takes a fetch option |
| P9 queue-one-bit | semantic | `PiHarnessSession.queue` (harness/pi/session.ts), `SdkQueueView` (queue.ts), `WebQueue.sdkTookHanded` (queue.ts) | `Agent.hasQueuedMessages`, `Agent.continue`, `Agent.peekQueuedMessages`, `AgentSession.getSteeringMessages`, `AgentSession.getFollowUpMessages`, `AgentSession.clearQueue` | Sova adopts peekQueuedMessages(), or pi's mirror tracks delivery by identity |
| P10 leaf-is-last-line | semantic | `rewindSession` (harness/pi/history-ops.ts), `PiHarnessSession.rewindTo` (harness/pi/session.ts), `activeBranchLines` (harness/pi/fork.ts) | `AgentSession.navigateTree`, `SessionManager.open`, `SessionManager.getLeafId` | pi persists the leaf |
| P11 create-defers / open-flushed | semantic | `createSessionFile` (harness/pi/state.ts), `appendToClosedFile` (harness/pi/state.ts) | `SessionManager.create`, `SessionManager.open`, `SessionManager.appendCustomEntry` | never: the two creation paths depend on it; keep the canary |
| P12 message-end-before-persist | ordering | `PiHarnessSession.subscribe` (harness/pi/session.ts), `PiHarnessSession.persistedId` (harness/pi/session.ts), `ChatSession.markSend` (chat-manager.ts), `ChatSession.markTopic` (chat-manager.ts), `ChatSession.holdForEntryId` (chat-manager.ts) | `AgentSession.subscribe`, `AgentSession._handleAgentEvent`, `SessionManager.appendMessage` | pi emits after persisting, or gives the entry id with message_end |
| P13 no-entry-appended | semantic | `ChatSession.setThinking` (chat-manager.ts), `ChatSession.refreshAfterCompaction` (chat-manager.ts) | `AgentSession.setThinkingLevel`, `AgentSession.compact`, `ExtensionAPI.appendEntry` | pi emits entry_appended for them (then drop the synthesized row) |
| P14 command-direct-call | internal-API | `ownedCommand` (harness/pi/commands.ts), `commandContextOf` (harness/pi/commands.ts), `PiHarnessSession.command` (harness/pi/session.ts), `PiHarnessSession.commandContext` (harness/pi/session.ts), `ChatSession.applyMode` (chat-manager.ts), `ChatSession.syncModePrompt` (chat-manager.ts), `ChatSession.applyLoginPick` (chat-manager.ts), `ChatSession.sandboxHost` (chat-manager.ts), `ChatSession.resumeWorker` (chat-manager.ts) | `ExtensionRunner.getCommand`, `ExtensionRunner.createCommandContext`, `ResolvedCommand.sourceInfo` | pi offers a public run-command API for embedders |
| P15 accept-vs-complete | semantic | `PiHarnessSession.send` (harness/pi/session.ts), `ChatSession.linkToSdk` (chat-manager.ts) | `AgentSession.prompt`, `PromptOptions.preflightResult` | never: HarnessSession.send and its onAccepted mirror it; keep the canary |
| P16 custom-message-idle | semantic | `PiHarnessSession.appendNote` (harness/pi/session.ts), `ChatSession.appendNote` (chat-manager.ts) | `AgentSession.sendCustomMessage` | never: a contract worth keeping a canary for |
| P17 theme-global | private-read | `currentTheme` (harness/pi/ui-bridge.ts) | `initTheme`, `Symbol.for("@earendil-works/pi-coding-agent:theme")` | pi exports the theme instance |
| P18 warmup-shutdown | internal-API | `warmClaudeCodeProvider` (harness/pi/open.ts) | `AgentSession.bindExtensions`, `AgentSession.dispose`, `ExtensionRunner.emit`, `ExtensionRunner.hasHandlers` | dispose() emits session_shutdown (then the warm-up's own emit would double it) |
| P19 rebuild-prompt | semantic | `PiHarnessSession.refreshSystemPrompt` (harness/pi/session.ts), `hearRuns` (chat-manager.ts) | `AgentSession.setActiveToolsByName`, `AgentSession._rebuildSystemPrompt`, `DefaultResourceLoader.appendSystemPromptOverride` | pi adds a public refreshSystemPrompt(), or re-reads the parts at each run |
| P20 model-restore-gate | semantic | `recordedModelForEmptyBranch` (harness/pi/open.ts), `modelForSessionOpen` (harness/pi/open.ts), `legacyClaudeModelForOpen` (harness/pi/open.ts) | `createAgentSession`, `SessionManager.buildSessionContext` | pi restores a recorded model on any branch |
| P21 codemode-definition | semantic | `captureCodemode` (harness/pi/codemode.ts), `scriptRegistry` (harness/pi/codemode.ts) | `createCodemodeExtension`, `ExtensionAPI.registerTool`, `ExtensionContext.modelRegistry`, `ExtensionToolContext.executeTool` | pi exports the codemode tool definition and a model hook for scripts |
| P22 declared-tools | private-read | `PiHarnessSession.declaredTools` (harness/pi/session.ts), `toolSource` (harness/pi/session.ts) | `Agent.state.tools`, `AgentSession._hiddenDeclarations`, `AgentSession._applyToolLoadout`, `AgentSession.getAllTools`, `SourceInfo.path` | pi offers a public read of the declared tools as a request will send them |
| P23 turn-end-loadout | ordering | `join` (pi-config/extensions/link/index.ts) | `agentLoop`, `AgentSession._installAgentNextTurnRefresh`, `AgentSession._preparePromptAndToolLoadout`, `ExtensionAPI.registerTool` | pi offers a documented hook for changing the tool set before a run's next request |
| P24 own-code-discovery | monkey-patch | `patchResolve` (harness/pi/own-code.ts), `installOwnCode` (harness/pi/own-code.ts) | `DefaultPackageManager.resolve`, `DefaultResourceLoader.reload`, `DefaultResourceLoader.loadCurrentExtensionSet`, `createAgentSessionServices` | pi's loader takes a path-mapping hook for discovered extensions |
| P25 request-start | monkey-patch | `hearRequests` (harness/pi/session.ts), `keepHearingRequests` (harness/pi/session.ts), `PiHarnessSession.subscribe` (harness/pi/session.ts) | `Agent.streamFunction`, `StreamOptions.onPayload`, `createAgentSession` | pi emits a request-sent event of its own |
| P26 native-extension-load | semantic | `extensionDepDrift` (harness/pi/own-code.ts) | `loadExtensions`, `getAliases`, jiti `tryNative` | pi resolves an extension's pi imports to its own copies without translating, whatever node_modules holds |
| P27 headless-standins | monkey-patch | `installHeadless` (harness/pi/headless.ts), `standInSource` (harness/pi/headless.ts) | pi-tui `dist/` modules, `dist/modes/interactive/`, `dist/utils/syntax-highlight.js` | pi ships an entry point without its terminal drawing code |
| P28 steer-all | monkey-patch | `steerAllAtOnce` (harness/pi/queue-modes.ts), `servicesForCwd` (harness/pi/open.ts), `WebQueue.pumpOnce` (queue.ts) | `SettingsManager.getSteeringMode`, `AgentSession.reload`, `AgentSession.syncQueueModesFromSettings`, `createAgentSession`, `PendingMessageQueue.peek` | pi takes a steering mode per session that no settings reload resets |
| P29 steer-remove | monkey-patch | `tapSteers` (harness/pi/steer-ticket.ts), `laneOf` (harness/pi/steer-ticket.ts), `mirrorOf` (harness/pi/steer-ticket.ts), `takeSteerOut` (harness/pi/steer-ticket.ts), `PiHarnessSession.queue` (harness/pi/session.ts), `WebQueue.removeHanded` (queue.ts) | `Agent.steer`, `Agent.steeringQueue`, `PendingMessageQueue.messages`, `PendingMessageQueue.drain`, `AgentSession._steeringMessages`, `AgentSession._queueSteer`, `AgentSession._emitQueueUpdate`, `AgentSession.clearQueue`, `Agent.peekQueuedMessages` | pi offers removing one queued message by identity |
| T1 scripted-model (test-only) | private-write | `ScriptedModel.attach` (harness/pi/testing/scripted-model.ts) | `AgentSession._modelRuntime`, `Agent.getApiKey`, `Agent.streamFunction` | pi offers a public test model hook |

## What each one relies on

### P1 open-writes-nothing

Building a session on a branch with no messages (or no thinking entry) appends `model_change`/`thinking_level_change` through the session manager's own `appendModelChange`/`appendThinkingLevelChange` properties, so replacing them before construction defers those writes; Sova queues them until the first write and drops the one that restates the recorded model.

Canary: `P1 open-writes-nothing: building a session on a message-less file appends model and thinking through the manager's instance methods`.

### P2 compaction-write-wrap

`AgentSession.compact()` writes its entry through the instance property `sessionManager.appendCompaction`, so wrapping it runs Sova's write guards and the deferred-append flush at the moment of the write.

Canary: `P2 compaction-write-wrap: compact() writes through the session manager's appendCompaction instance property`.

### P3 compaction-error-text

`compact()` refuses with "Already compacted", "Nothing to compact…" and "Compaction cancelled"; `prompt()` during a compaction throws "Cannot submit a prompt while compaction is in progress…". Sova maps each to a refusal or a held send by that text.

Canary: `P3 compaction-error-text: pi's compaction refusals and its prompt-while-compacting error read as Sova matches them`.

### P4 already-processing

A prompt that meets a running turn (the session's without `streamingBehavior`, or the agent's own after the streaming check passed) fails with a message matching `/already processing/i` (`isAlreadyProcessing`); `linkToSdk` then steers into the turn that won.

Canary: `P4 already-processing: a prompt mid-run without streamingBehavior, and the agent's own prompt mid-run, fail /already processing/i`.

### P5 settle-window

`_isEmittingAgentSettled` is true while `agent_settled` is emitted, and a `prompt()` made then is deferred: it resolves at once and its turn runs after the emit, outside the async context of the call that made it. The driving session reads it as `inSettleWindow()`; topic delivery stays out of that window, and so does a keyed send (a worker's steer or follow-up, §app.chat-processes/worker-instructions): `acceptPrompt` queues one, and the queue holds a keyed item until the window has passed, so its message is labelled with its key (send-keys.ts). The canary pins both: the deferred prompt runs unlabelled, the held keyed hand-off labelled once.

Canary: `P5 settle-window: inside an agent_settled emit _isEmittingAgentSettled is true and a prompt resolves at once, its turn running after`.

### P6 refresh-context

A user entry appended outside a run (`sessionManager.appendMessage`, the driving session's `appendUserMessage`) reaches the agent's context only after the session re-reads its projection, which the public `refreshContext()` does; `enterQueued` calls it once after its appends.

Until M5-T2 `enterQueued` called the private `_refreshFinalizedContext()`, which `refreshContext()` wraps (pi 0.87.1); that private read is retired.

Canary: `P6 refresh-context: a user entry appended outside a run reaches the agent's context after refreshContext()`.

### P7 user-turns-wrap

`AgentSession` hands user input to `this.agent.prompt`/`steer`/`followUp` by property lookup, and the object it passes is the one later emitted in `message_start`, so wrapping those three tells a message the user sent from every other by identity. `watchUserMessages` wraps them once per agent; claimers registered later see the input first, as nested wraps did. `SendKeys.watch` claims the same way: a keyed send's message carries its key (§app.chat-processes/worker-instructions).

Canary: `P7 user-turns-wrap: prompt, steer and followUp reach the agent by property lookup, and the object passed is the one message_start carries`.

### P8 stream-function

`agent.streamFunction` is read at each provider request, so one assigned after construction (the slicing fetch, `docs/bun-quirks.md` fetch-read-size) answers the next turn.

Canary: `P8 stream-function: agent.streamFunction is read at each request, so one assigned after construction answers the next turn`.

### P9 queue-one-bit

`agent.hasQueuedMessages()` is the real queue; the session's steering/follow-up mirror is spliced on `message_start` by text only, so an image-only steer stays in it after delivery; `clearQueue()` returns and clears both kinds; `continue()` drains steering before follow-ups, so Sova never hands a steer in behind a follow-up of its own still in pi. With steering in all-mode (P26) a drain takes the whole steering lane, so an empty real queue proves every steer Sova handed in delivered. `peekQueuedMessages()` exists and is unused.

Canary: `P9 queue-one-bit: an image-only steer stays in the mirror after delivery while the agent's queue is empty; clearQueue() returns both kinds; continue() takes steering first`.

### P10 leaf-is-last-line

`navigateTree({summarize:false})` writes nothing and moves only the in-memory leaf, and `SessionManager.open` takes the file's last line as the leaf; a rewind therefore appends a marker so the move survives a reopen.

Canary: `P10 leaf-is-last-line: navigateTree({summarize:false}) writes nothing and moves only the in-memory leaf; open() takes the last line as the leaf`.

### P11 create-defers / open-flushed

A session `SessionManager.create()` makes stays unwritten until its first user or assistant message (pi 0.99.0+; through 0.87.1, its first assistant message), so Sova's creators write `[header, ...seed]` themselves; a file `SessionManager.open()` reads takes each append at once.

Canary: `P11 create-defers / open-flushed: a created session's appends stay unwritten until a user or assistant message; an opened header-only file writes each append at once`.

### P12 message-end-before-persist

Session listeners get `message_end` before pi appends the message's entry, and the append follows in the same tick, so one microtask later the entry is the leaf; the sender and topic markers and the held broadcasts wait that microtask.

Canary: `P12 message-end-before-persist: message_end listeners run before the entry is appended; one microtask later it is the leaf`.

### P13 no-entry-appended

`setThinkingLevel()` and a compaction write their entries without an `entry_appended` event (an extension's `appendEntry` emits one), so Sova synthesizes the thinking row and re-reads history after a compaction.

Canary: `P13 no-entry-appended: setThinkingLevel and a compaction write without entry_appended; an extension's appendEntry emits it`.

### P14 command-direct-call

`extensionRunner.getCommand(name)` returns the command with its handler and `sourceInfo.path` (Sova checks the owner by that path), and the handler runs outside `prompt()` with `extensionRunner.createCommandContext()`.

Canary: `P14 command-direct-call: getCommand finds an extension's command with its source path, and its handler runs outside prompt() with createCommandContext()'s ctx`.

### P15 accept-vs-complete

`prompt()` resolves when the turn ends, while `preflightResult("started")` fires when it is accepted (`"handled"` for a handled extension command or an input handler that swallows it, `"queued"` for a mid-run delivery); the driving session's `send` passes it as `onAccepted`, dropping the disposition, and a link delivery takes acceptance from it. A refused prompt ("already processing", a compaction in progress, no model or auth) gets no call, and `linkToSdk` settles on the rejection instead. pi 1.0.0 made the argument a disposition (`PromptDisposition`); through 0.87.1 it was a boolean, `preflightResult(false)` on a refusal, which the adapter ignored too, so `onAccepted` fired then as well.

Canary: `P15 accept-vs-complete: prompt() resolves at turn end while preflightResult("started") fires at acceptance ("handled" for a handled command, no call for a refused prompt)`.

### P16 custom-message-idle

`sendCustomMessage(…, {triggerTurn:false})` on an idle session appends the `custom_message` entry at once and emits `message_start` then `message_end`, with no turn.

Canary: `P16 custom-message-idle: sendCustomMessage with triggerTurn:false on an idle session appends at once and emits message_start then message_end`.

### P17 theme-global

`initTheme()` registers the theme on `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`, which Sova reads to hand extensions `ctx.ui.theme` (pi does not export the instance). Sova names the theme, `initTheme("dark", false)`: pi 1.0 (0.99.0) defaults to `system`, a theme built from the terminal's ANSI palette, where 0.87.1 detected `dark` or `light` from the environment (`dark` on a server). The built-in `dark` is pi's revised palette since 0.99.0, so its escape codes differ from 0.87.1's `dark` (accent 256-colour 140, was 109).

Canary: `P17 theme-global: initTheme registers the theme on globalThis under pi's Symbol.for key`.

### P18 warmup-shutdown

`bindExtensions()` emits `session_start`; a bare `dispose()` emits no `session_shutdown`, so the warm-up emits it through `extensionRunner.emit` before disposing.

Canary: `P18 warmup-shutdown: bindExtensions emits session_start; a bare dispose() skips session_shutdown, which the runner's emit delivers`.

### P19 rebuild-prompt

The resource loader's `appendSystemPromptOverride` parts are read when the base system prompt is rebuilt, which `setActiveToolsByName(getActiveToolNames())` does; a run alone keeps the prompt it was built with. The driving session's `refreshSystemPrompt()` is that call; the Overseer makes it at each run's start.

Canary: `P19 rebuild-prompt: setActiveToolsByName(getActiveToolNames()) re-reads the loader's appendSystemPrompt parts`.

### P20 model-restore-gate

`createAgentSession` restores the branch's recorded model only when the branch has messages; for a message-less session it builds (and appends) another model unless Sova passes the recorded one.

Canary: `P20 model-restore-gate: the SDK restores a recorded model only when the branch has messages`.

### P21 codemode-definition

`createCodemodeExtension()`'s factory registers exactly one tool, `codemode`, with `defaultActive: false`, through the API it is handed, so Sova runs it against its own extension's API with `registerTool` caught and registers the definition itself (§chat.mode-menu/codemode). A script's `models.classify` / `models.generateImages` reach the tool context's `modelRegistry`, where Sova's wrapper applies the model policy, the provider-limits slot and the chat's usage context. Nested calls go through `ctx.executeTool`: their `tool_execution_*` events carry `parentToolCallId` and ids `<parent>/<n>`, and they write no transcript entries (the result keeps `details.calls`).

Canary: `P21 codemode-definition: the factory registers one inactive codemode tool, its models.* reach ctx.modelRegistry, nested calls carry parentToolCallId`.

### P22 declared-tools

`agent.state.tools` is the set the next request declares, in its order, with the descriptions a `prepareLoadout` hook gave them (codemode's "Codemode: `tools.x(args)` resolves to …" line); `getAllTools()` keeps the registry's own descriptions. The private `_hiddenDeclarations` names the declarations requests leave out (codemode's `only` mode). A tool's `sourceInfo.path` is `builtin:<name>` for pi's own tools, `<inline:<name>>` for an extension factory (`<sdk:<name>>` for a custom tool), else the extension's file. The driving session's `declaredTools()` reads the three for the setup card's Tools group (§chat.transcript/setup-card-tools).

Canary: `P22 declared-tools: agent.state.tools is the declared set with the loadout's descriptions, _hiddenDeclarations what requests leave out, sourceInfo.path names the source`.

### P23 turn-end-loadout

Within one run pi (1.0.3, `pi-agent-core` `agent-loop.js`) emits `turn_end` (an extension's handler runs in the `finishTurn` boundary before it), then polls `getSteeringMessages`, then runs `prepareNextTurn` — `AgentSession._installAgentNextTurnRefresh` builds the next request's prompt and tool loadout there from `getActiveToolNames()` (`_preparePromptAndToolLoadout`) — and only then emits `turn_start`. So a tool an extension registers in a `turn_end` handler is declared (`toolsAdded`) in the very next request of the same run, the one that carries a message steered during the step; a tool registered at `turn_start` waits for the request after. The `link` extension turns the link tools on at `turn_end` for a session linked mid-run, so the partner's steered message arrives with the tools to answer it (§mesh.links/tools, §mesh.links/delivery).

Canary: `P23 turn-end-loadout: a tool registered at turn_end is declared in the next request of the same run, beside the steered message; one registered at turn_start is not`.

### P26 native-extension-load

Under Bun, pi's extension loader (`loadExtensions`, jiti with `moduleCache: false` and pi's `getAliases()`) leaves jiti's `tryNative` at its default, `"Bun" in globalThis`: it imports each extension natively first, which ignores the aliases, and translates it only when that throws. An extension whose bare imports resolve from its real path is then a plain module: Bun keys it by its real path, so extensions share one instance of a file they have in common, with each other and with Sova's own imports of it. One that can't resolve them is translated, with a private copy of every file it imports (and jiti's Babel stays resident). So Sova's package.json names pi-ai, pi-tui and typebox at pi's own versions, and `extensionDepDrift` checks that they resolve from the copy's extensions to pi's own copies (§app.chat-processes/extension-loading). `extension-deps.test.ts` also fails when an extension in `pi-config/` loads an `@earendil-works` package outside `EXTENSION_DEPS` (comments and type-only imports don't count). npm and git package extensions (pi-web-access) resolve pi from their own `node_modules`, bringing their own copies: they are outside both checks.

Canary: `P26 native-extension-load: under Bun pi's loader imports an extension natively first: two whose imports resolve share one instance of a common file with a direct import; one whose don't is translated, with its own`.

### P27 headless-standins

A chat process replaces pi's terminal drawing code with stand-ins (§app.chat-processes/no-terminal-drawing): a Bun plugin, installed by `server/chat-runtime/main.ts` before pi loads, answers each module `STANDIN_FILTER` matches (pi-tui's screen, terminal and components, marked, pi's `modes/interactive/` but its theme, pi's syntax highlighter) with a module of the same export names, each an inert stand-in. Sova relies on three things pi does not promise: pi-tui keeps its text, key and colour helpers (`utils`, `keys`, `keybindings`, `fuzzy`, `colors`, `terminal-image`, …) in modules apart from its drawing ones, and its index re-exports each name from one of them; pi's theme imports none of the drawing modules (only the highlighter, inside its code-highlighting functions); and outside its terminal mode pi's code takes a drawing module only in terminal renderers, its CLI and its entry's re-exports, none of which a Sova chat calls. The canary checks the three statically; `headless.integration.test.ts` runs a chat process with every extension and a turn, logs every module replaced and every call that reached a stand-in, and compares pi-tui's export names with and without the stand-ins. `headless-files.json` snapshots every file of the folders the stand-ins reach into (pi-tui's `dist/`, pi's `dist/modes/interactive/` and `dist/utils/`, marked's `lib/`), each marked stand-in or kept; `headless.test.ts` fails on a file it doesn't know, one it lists that is gone (a moved helper), or a file the filter treats otherwise, until a person classifies it. A chat process warns once (`[headless] pi's terminal drawing code was called in this chat`) at the first stand-in call that isn't a construct.

Canary: `P27 headless-standins: pi-tui keeps its text, key and colour helpers apart from its drawing modules, pi's theme takes only the highlighter, and outside its terminal mode pi takes a drawing module only in renderers, its CLI and its entry`.

### P28 steer-all

pi builds the agent's steering mode from `settingsManager.getSteeringMode()` when it creates a session (`createAgentSession`, `sdk.js`) and reads it again on every `AgentSession.reload()` (`syncQueueModesFromSettings`, right after `settingsManager.reload()` re-read settings.json). `steerAllAtOnce` replaces that getter on each runtime's own settings object (`servicesForCwd`), so the agent's steering queue (`PendingMessageQueue`) runs in `"all"` mode: every queued steer lands at the next step, each its own message, in the order queued, and a reload keeps it. `AgentSession.setSteeringMode` is never called: it saves into settings.json, which the user's terminal pi reads. Follow-ups keep pi's one-at-a-time. The web queue (`WebQueue.pumpOnce`) hands every waiting steer in behind the ones pi still holds, which only lands them together because of this mode.

Canary: `P28 steer-all: with the getter replaced, every queued steer lands in one step, the mode survives reload(), and settings.json holds no steeringMode`.

### P29 steer-remove

pi can only clear its queues whole, so a handed steer is taken back by reaching in (§chat.transcript/a-queued-message). `_queueSteer` pushes the steer's text onto the session's mirror `_steeringMessages`, emits `queue_update` and hands the message object to `this.agent.steer`, all in one synchronous block; the agent keeps that object in `steeringQueue.messages` (a `PendingMessageQueue`, whose `drain()` reassigns the array) until the loop drains it, and `message_start` splices the mirror by text. `tapSteers` wraps `agent.steer` once per agent, after the call, so the ticket (`steerTicket`, `server/harness/pi/steer-ticket.ts`) whose async context the hand-off runs in claims the first object queued (a second one in that context makes it `unknown`: refused, never guessed; another sender's steer runs in its own context). `takeSteerOut` splices that object out of the lane and one entry of its text out of the mirror, in one synchronous step, then calls `_emitQueueUpdate`: either the lane still holds it and it goes (the agent never gets it, `peekQueuedMessages()` and `clearQueue()` no longer list it, its twins stay), or the loop took it and it is a sent message. Splicing only the lane would leave the mirror longer by one, and Stop's `clearQueue()` would hand the removed text back. A removal asked for while the hand-off is still in its input handlers (an image being described) waits for the hand-off to settle: only then are its pushes all known, and the take-out happens only if the hand-off queued exactly one message (an input handler's own steer pushed in the same context makes it `unknown`, and nothing is spliced).

Canary: `P29 steer-remove: the object agent.steer is handed sits in steeringQueue.messages, and splicing it and its text out of both copies takes exactly that steer back`.

### T1 scripted-model (test-only)

The test double replaces `_modelRuntime.hasConfiguredAuth`, `agent.getApiKey` and `agent.streamFunction` on a live session, and pi then runs its turns on the script.

Canary: `T1 scripted-model: the members the test double replaces exist, and it runs a turn`.
