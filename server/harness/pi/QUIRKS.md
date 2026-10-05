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
| P5 settle-window | private-read | `PiHarnessSession.inSettleWindow` (harness/pi/session.ts), `ChatSession.deliverTopicBatch` (chat-manager.ts) | `AgentSession._isEmittingAgentSettled`, `AgentSession.prompt`, `AgentSession._emitAgentSettled` | pi exposes the settle window, or stops deferring a prompt made inside it |
| P6 refresh-context | semantic | `PiHarnessSession.appendUserMessage` (harness/pi/session.ts), `PiHarnessSession.refreshContext` (harness/pi/session.ts), `ChatSession.enterQueued` (chat-manager.ts) | `AgentSession.refreshContext`, `SessionManager.appendMessage` | never: a contract worth keeping a canary for |
| P7 user-turns-wrap | monkey-patch | `watchUserMessages` (harness/pi/turns.ts), `UserTurns.watch` (user-turns.ts) | `Agent.prompt`, `Agent.steer`, `Agent.followUp`, `AgentSession.prompt`, `AgentSession.steer`, `AgentSession.followUp` | pi offers an input-identity hook |
| P8 stream-function | monkey-patch | `useSlicedProviderReads` (runtime-quirks.ts) | `Agent.streamFunction` | the fetch-read-size Bun quirk retires (docs/bun-quirks.md), or pi takes a fetch option |
| P9 queue-one-bit | semantic | `PiHarnessSession.queue` (harness/pi/session.ts), `SdkQueueView` (queue.ts), `WebQueue.sdkHolds` (queue.ts) | `Agent.hasQueuedMessages`, `Agent.continue`, `Agent.peekQueuedMessages`, `AgentSession.getSteeringMessages`, `AgentSession.getFollowUpMessages`, `AgentSession.clearQueue` | Sova adopts peekQueuedMessages(), or pi's mirror tracks delivery by identity |
| P10 leaf-is-last-line | semantic | `rewindSession` (harness/pi/history-ops.ts), `PiHarnessSession.rewindTo` (harness/pi/session.ts), `activeBranchLines` (harness/pi/fork.ts) | `AgentSession.navigateTree`, `SessionManager.open`, `SessionManager.getLeafId` | pi persists the leaf |
| P11 create-defers / open-flushed | semantic | `createSessionFile` (harness/pi/state.ts), `appendToClosedFile` (harness/pi/state.ts) | `SessionManager.create`, `SessionManager.open`, `SessionManager.appendCustomEntry` | never: the two creation paths depend on it; keep the canary |
| P12 message-end-before-persist | ordering | `PiHarnessSession.subscribe` (harness/pi/session.ts), `PiHarnessSession.persistedId` (harness/pi/session.ts), `ChatSession.markSend` (chat-manager.ts), `ChatSession.markTopic` (chat-manager.ts), `ChatSession.holdForEntryId` (chat-manager.ts) | `AgentSession.subscribe`, `AgentSession._handleAgentEvent`, `SessionManager.appendMessage` | pi emits after persisting, or gives the entry id with message_end |
| P13 no-entry-appended | semantic | `ChatSession.setThinking` (chat-manager.ts), `ChatSession.refreshAfterCompaction` (chat-manager.ts) | `AgentSession.setThinkingLevel`, `AgentSession.compact`, `ExtensionAPI.appendEntry` | pi emits entry_appended for them (then drop the synthesized row) |
| P14 command-direct-call | internal-API | `ownedCommand` (harness/pi/commands.ts), `commandContextOf` (harness/pi/commands.ts), `PiHarnessSession.command` (harness/pi/session.ts), `PiHarnessSession.commandContext` (harness/pi/session.ts), `ChatSession.applyMode` (chat-manager.ts), `ChatSession.syncModePrompt` (chat-manager.ts), `ChatSession.applyLoginPick` (chat-manager.ts), `ChatSession.sandboxHost` (chat-manager.ts), `ChatSession.resumeWorker` (chat-manager.ts) | `ExtensionRunner.getCommand`, `ExtensionRunner.createCommandContext`, `ResolvedCommand.sourceInfo` | pi offers a public run-command API for embedders |
| P15 accept-vs-complete | semantic | `PiHarnessSession.send` (harness/pi/session.ts), `ChatSession.linkToSdk` (chat-manager.ts) | `AgentSession.prompt`, `PromptOptions.preflightResult` | never: HarnessSession.send and its onAccepted mirror it; keep the canary |
| P16 custom-message-idle | semantic | `PiHarnessSession.appendNote` (harness/pi/session.ts), `ChatSession.appendNote` (chat-manager.ts) | `AgentSession.sendCustomMessage` | never: a contract worth keeping a canary for |
| P17 theme-global | private-read | `currentTheme` (harness/pi/ui-bridge.ts) | `initTheme`, `Symbol.for("@earendil-works/pi-coding-agent:theme")` | pi exports the theme instance |
| P18 warmup-shutdown | internal-API | `warmClaudeCodeProvider` (harness/pi/open.ts) | `AgentSession.bindExtensions`, `AgentSession.dispose`, `ExtensionRunner.emit`, `ExtensionRunner.hasHandlers` | dispose() emits session_shutdown (then the warm-up's own emit would double it) |
| P19 rebuild-prompt | semantic | `LivePrompt.rebase` (overseer.ts) | `AgentSession.setActiveToolsByName`, `AgentSession._rebuildSystemPrompt`, `DefaultResourceLoader.appendSystemPromptOverride` | pi adds a public refreshSystemPrompt(), or re-reads the parts at each run |
| P20 model-restore-gate | semantic | `recordedModelForEmptyBranch` (harness/pi/open.ts), `modelForSessionOpen` (harness/pi/open.ts) | `createAgentSession`, `SessionManager.buildSessionContext` | pi restores a recorded model on any branch |
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

`_isEmittingAgentSettled` is true while `agent_settled` is emitted, and a `prompt()` made then is deferred: it resolves at once and its turn runs after the emit. The driving session reads it as `inSettleWindow()`; topic delivery stays out of that window.

Canary: `P5 settle-window: inside an agent_settled emit _isEmittingAgentSettled is true and a prompt resolves at once, its turn running after`.

### P6 refresh-context

A user entry appended outside a run (`sessionManager.appendMessage`, the driving session's `appendUserMessage`) reaches the agent's context only after the session re-reads its projection, which the public `refreshContext()` does; `enterQueued` calls it once after its appends.

Until M5-T2 `enterQueued` called the private `_refreshFinalizedContext()`, which `refreshContext()` wraps (pi 0.87.1); that private read is retired.

Canary: `P6 refresh-context: a user entry appended outside a run reaches the agent's context after refreshContext()`.

### P7 user-turns-wrap

`AgentSession` hands user input to `this.agent.prompt`/`steer`/`followUp` by property lookup, and the object it passes is the one later emitted in `message_start`, so wrapping those three tells a message the user sent from every other by identity. `watchUserMessages` wraps them once per agent; claimers registered later see the input first, as nested wraps did.

Canary: `P7 user-turns-wrap: prompt, steer and followUp reach the agent by property lookup, and the object passed is the one message_start carries`.

### P8 stream-function

`agent.streamFunction` is read at each provider request, so one assigned after construction (the slicing fetch, `docs/bun-quirks.md` fetch-read-size) answers the next turn.

Canary: `P8 stream-function: agent.streamFunction is read at each request, so one assigned after construction answers the next turn`.

### P9 queue-one-bit

`agent.hasQueuedMessages()` is the real queue; the session's steering/follow-up mirror is spliced on `message_start` by text only, so an image-only steer stays in it after delivery; `clearQueue()` returns and clears both kinds; `continue()` drains steering before follow-ups. `peekQueuedMessages()` exists and is unused.

Canary: `P9 queue-one-bit: an image-only steer stays in the mirror after delivery while the agent's queue is empty; clearQueue() returns both kinds; continue() takes steering first`.

### P10 leaf-is-last-line

`navigateTree({summarize:false})` writes nothing and moves only the in-memory leaf, and `SessionManager.open` takes the file's last line as the leaf; a rewind therefore appends a marker so the move survives a reopen.

Canary: `P10 leaf-is-last-line: navigateTree({summarize:false}) writes nothing and moves only the in-memory leaf; open() takes the last line as the leaf`.

### P11 create-defers / open-flushed

A session `SessionManager.create()` makes stays unwritten until its first assistant message, so Sova's creators write `[header, ...seed]` themselves; a file `SessionManager.open()` reads takes each append at once.

Canary: `P11 create-defers / open-flushed: a created session's appends stay unwritten until an assistant message; an opened header-only file writes each append at once`.

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

`prompt()` resolves when the turn ends, while `preflightResult(true)` fires when it is accepted (also for a handled extension command); the driving session's `send` passes it as `onAccepted`, and a link delivery takes acceptance from it.

Canary: `P15 accept-vs-complete: prompt() resolves at turn end while preflightResult(true) fires at acceptance (and for a handled command)`.

### P16 custom-message-idle

`sendCustomMessage(…, {triggerTurn:false})` on an idle session appends the `custom_message` entry at once and emits `message_start` then `message_end`, with no turn.

Canary: `P16 custom-message-idle: sendCustomMessage with triggerTurn:false on an idle session appends at once and emits message_start then message_end`.

### P17 theme-global

`initTheme()` registers the theme on `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`, which Sova reads to hand extensions `ctx.ui.theme` (pi does not export the instance).

Canary: `P17 theme-global: initTheme registers the theme on globalThis under pi's Symbol.for key`.

### P18 warmup-shutdown

`bindExtensions()` emits `session_start`; a bare `dispose()` emits no `session_shutdown`, so the warm-up emits it through `extensionRunner.emit` before disposing.

Canary: `P18 warmup-shutdown: bindExtensions emits session_start; a bare dispose() skips session_shutdown, which the runner's emit delivers`.

### P19 rebuild-prompt

The resource loader's `appendSystemPromptOverride` parts are read when the base system prompt is rebuilt, which `setActiveToolsByName(getActiveToolNames())` does; a run alone keeps the prompt it was built with.

Canary: `P19 rebuild-prompt: setActiveToolsByName(getActiveToolNames()) re-reads the loader's appendSystemPrompt parts`.

### P20 model-restore-gate

`createAgentSession` restores the branch's recorded model only when the branch has messages; for a message-less session it builds (and appends) another model unless Sova passes the recorded one.

Canary: `P20 model-restore-gate: the SDK restores a recorded model only when the branch has messages`.

### T1 scripted-model (test-only)

The test double replaces `_modelRuntime.hasConfiguredAuth`, `agent.getApiKey` and `agent.streamFunction` on a live session, and pi then runs its turns on the script.

Canary: `T1 scripted-model: the members the test double replaces exist, and it runs a turn`.
