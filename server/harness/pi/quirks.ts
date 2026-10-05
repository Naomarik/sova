// The pi quirk registry (§app.harness/boundary): every place Sova leans on pi behaviour pi does not
// promise — a monkey-patch, a private read or write, an error's text, an ordering, an internal API — with
// the code that relies on it and the canary in contract.test.ts that fails when pi changes under it.
// QUIRKS.md is the human view of the same rows; quirks-meta.test.ts keeps the two, the canaries and the
// code in step, and fails on a private cast or SDK method assignment at a site no row names.
//
// `where` cites symbols (a function, or Class.method), never line numbers: the M5 moves into
// server/harness/pi/ update the file and symbol here in the same change. `pi` names what pi side the
// quirk touches, as pi's own source spells it.

export type QuirkKind =
  /** Sova replaces a pi method or property on a live object. */
  | "monkey-patch"
  /** Sova reads a member pi marks private (a leading `_`) or an undocumented global. */
  | "private-read"
  /** Sova (a test double) writes a private member. */
  | "private-write"
  /** Sova classifies an error by its message text. */
  | "error-text"
  /** Sova relies on a public method behaving a particular, undocumented way. */
  | "semantic"
  /** Sova relies on the order or tick in which pi does two things. */
  | "ordering"
  /** Sova calls an API pi exposes for its own modes, not for embedders. */
  | "internal-API";

export interface QuirkSite {
  /** Repository-relative path. */
  file: string;
  /** The declaration that relies on the quirk: `name` or `Class.name`. */
  symbol: string;
}

export interface PiQuirk {
  /** `P<n>` for product code, `T<n>` for test-only doubles. */
  id: string;
  name: string;
  kind: QuirkKind;
  /** What Sova relies on, in one or two sentences. */
  relies: string;
  /** The pi members involved. */
  pi: readonly string[];
  where: readonly QuirkSite[];
  /** The canary's exact test title in contract.test.ts. */
  canary: string;
  /** What pi change lets Sova drop the quirk (or "never": a contract worth keeping a canary for). */
  retireWhen: string;
  note?: string;
}

const CM = "server/chat-manager.ts";
const SESSION = "server/harness/pi/session.ts";
const OPEN = "server/harness/pi/open.ts";

export const PI_QUIRKS: readonly PiQuirk[] = [
  {
    id: "P1",
    name: "open-writes-nothing",
    kind: "monkey-patch",
    relies:
      "Building a session on a branch with no messages (or no thinking entry) appends model_change/thinking_level_change through the session manager's own appendModelChange/appendThinkingLevelChange properties, so replacing them before construction defers those writes; Sova queues them until the first write and drops the one that restates the recorded model.",
    pi: ["createAgentSession", "SessionManager.appendModelChange", "SessionManager.appendThinkingLevelChange"],
    where: [
      { file: OPEN, symbol: "openPiSession" },
      { file: CM, symbol: "ChatSession.flushDeferredAppends" },
      { file: OPEN, symbol: "restatesRecordedModel" },
    ],
    canary: "P1 open-writes-nothing: building a session on a message-less file appends model and thinking through the manager's instance methods",
    retireWhen: "pi stops appending at construction, or offers an open that writes nothing",
  },
  {
    id: "P2",
    name: "compaction-write-wrap",
    kind: "monkey-patch",
    relies: "AgentSession.compact() writes its entry through the instance property sessionManager.appendCompaction, so wrapping it runs Sova's write guards and the deferred-append flush at the moment of the write.",
    pi: ["AgentSession.compact", "SessionManager.appendCompaction"],
    where: [{ file: CM, symbol: "compactSession" }],
    canary: "P2 compaction-write-wrap: compact() writes through the session manager's appendCompaction instance property",
    retireWhen: "pi offers a pre-write hook for a compaction",
  },
  {
    id: "P3",
    name: "compaction-error-text",
    kind: "error-text",
    relies:
      'compact() refuses with "Already compacted", "Nothing to compact…" and "Compaction cancelled"; prompt() during a compaction throws "Cannot submit a prompt while compaction is in progress…". Sova maps each to a refusal or a held send by that text.',
    pi: ["AgentSession.compact", "AgentSession.prompt"],
    where: [
      { file: CM, symbol: "compactSession" },
      { file: CM, symbol: "isCompactionInProgress" },
    ],
    canary: "P3 compaction-error-text: pi's compaction refusals and its prompt-while-compacting error read as Sova matches them",
    retireWhen: "pi throws typed errors",
  },
  {
    id: "P4",
    name: "already-processing",
    kind: "error-text",
    relies: "A prompt that meets a running turn (the session's without streamingBehavior, or the agent's own after the streaming check passed) fails with a message matching /already processing/i; linkToSdk then steers into the turn that won.",
    pi: ["AgentSession.prompt", "Agent.prompt"],
    where: [
      { file: SESSION, symbol: "isAlreadyProcessing" },
      { file: CM, symbol: "ChatSession.linkToSdk" },
    ],
    canary: "P4 already-processing: a prompt mid-run without streamingBehavior, and the agent's own prompt mid-run, fail /already processing/i",
    retireWhen: "pi throws a typed error",
  },
  {
    id: "P5",
    name: "settle-window",
    kind: "private-read",
    relies: "_isEmittingAgentSettled is true while agent_settled is emitted, and a prompt() made then is deferred: it resolves at once and its turn runs after the emit. Topic delivery stays out of that window.",
    pi: ["AgentSession._isEmittingAgentSettled", "AgentSession.prompt", "AgentSession._emitAgentSettled"],
    where: [
      { file: SESSION, symbol: "PiHarnessSession.inSettleWindow" },
      { file: CM, symbol: "ChatSession.deliverTopicBatch" },
    ],
    canary: "P5 settle-window: inside an agent_settled emit _isEmittingAgentSettled is true and a prompt resolves at once, its turn running after",
    retireWhen: "pi exposes the settle window, or stops deferring a prompt made inside it",
  },
  {
    id: "P6",
    name: "refresh-context",
    kind: "semantic",
    relies: "A user entry appended outside a run (sessionManager.appendMessage) reaches the agent's context only after the session re-reads its projection, which the public refreshContext() does; enterQueued calls it once after its appends.",
    pi: ["AgentSession.refreshContext", "SessionManager.appendMessage"],
    where: [
      { file: SESSION, symbol: "PiHarnessSession.appendUserMessage" },
      { file: SESSION, symbol: "PiHarnessSession.refreshContext" },
      { file: CM, symbol: "ChatSession.enterQueued" },
    ],
    canary: "P6 refresh-context: a user entry appended outside a run reaches the agent's context after refreshContext()",
    retireWhen: "never: a contract worth keeping a canary for",
    note: "Until M5-T2 enterQueued called the private _refreshFinalizedContext(), which refreshContext() wraps (pi 0.87.1); that private read is retired.",
  },
  {
    id: "P7",
    name: "user-turns-wrap",
    kind: "monkey-patch",
    relies: "AgentSession hands user input to this.agent.prompt/steer/followUp by property lookup, and the object it passes is the one later emitted in message_start, so wrapping those three tells a message the user sent from every other by identity.",
    pi: ["Agent.prompt", "Agent.steer", "Agent.followUp", "AgentSession.prompt", "AgentSession.steer", "AgentSession.followUp"],
    where: [
      { file: "server/harness/pi/turns.ts", symbol: "watchUserMessages" },
      { file: "server/user-turns.ts", symbol: "UserTurns.watch" },
    ],
    canary: "P7 user-turns-wrap: prompt, steer and followUp reach the agent by property lookup, and the object passed is the one message_start carries",
    retireWhen: "pi offers an input-identity hook",
  },
  {
    id: "P8",
    name: "stream-function",
    kind: "monkey-patch",
    relies: "agent.streamFunction is read at each provider request, so one assigned after construction (the slicing fetch, docs/bun-quirks.md fetch-read-size) answers the next turn.",
    pi: ["Agent.streamFunction"],
    where: [{ file: "server/runtime-quirks.ts", symbol: "useSlicedProviderReads" }],
    canary: "P8 stream-function: agent.streamFunction is read at each request, so one assigned after construction answers the next turn",
    retireWhen: "the fetch-read-size Bun quirk retires (docs/bun-quirks.md), or pi takes a fetch option",
  },
  {
    id: "P9",
    name: "queue-one-bit",
    kind: "semantic",
    relies:
      "agent.hasQueuedMessages() is the real queue; the session's steering/follow-up mirror is spliced on message_start by text only, so an image-only steer stays in it after delivery; clearQueue() returns and clears both kinds; continue() drains steering before follow-ups. peekQueuedMessages() exists and is unused.",
    pi: ["Agent.hasQueuedMessages", "Agent.continue", "Agent.peekQueuedMessages", "AgentSession.getSteeringMessages", "AgentSession.getFollowUpMessages", "AgentSession.clearQueue"],
    where: [
      { file: SESSION, symbol: "PiHarnessSession.queue" },
      { file: "server/queue.ts", symbol: "SdkQueueView" },
      { file: "server/queue.ts", symbol: "WebQueue.sdkHolds" },
    ],
    canary: "P9 queue-one-bit: an image-only steer stays in the mirror after delivery while the agent's queue is empty; clearQueue() returns both kinds; continue() takes steering first",
    retireWhen: "Sova adopts peekQueuedMessages(), or pi's mirror tracks delivery by identity",
  },
  {
    id: "P10",
    name: "leaf-is-last-line",
    kind: "semantic",
    relies: "navigateTree({summarize:false}) writes nothing and moves only the in-memory leaf, and SessionManager.open takes the file's last line as the leaf; a rewind therefore appends a marker so the move survives a reopen.",
    pi: ["AgentSession.navigateTree", "SessionManager.open", "SessionManager.getLeafId"],
    where: [
      { file: CM, symbol: "rewindSession" },
      { file: "server/harness/pi/fork.ts", symbol: "activeBranchLines" },
    ],
    canary: "P10 leaf-is-last-line: navigateTree({summarize:false}) writes nothing and moves only the in-memory leaf; open() takes the last line as the leaf",
    retireWhen: "pi persists the leaf",
  },
  {
    id: "P11",
    name: "create-defers / open-flushed",
    kind: "semantic",
    relies: "A session SessionManager.create() makes stays unwritten until its first assistant message, so Sova's creators write [header, ...seed] themselves; a file SessionManager.open() reads takes each append at once.",
    pi: ["SessionManager.create", "SessionManager.open", "SessionManager.appendCustomEntry"],
    where: [
      { file: "server/harness/pi/state.ts", symbol: "createSessionFile" },
      { file: "server/harness/pi/state.ts", symbol: "appendToClosedFile" },
    ],
    canary: "P11 create-defers / open-flushed: a created session's appends stay unwritten until an assistant message; an opened header-only file writes each append at once",
    retireWhen: "never: the two creation paths depend on it; keep the canary",
  },
  {
    id: "P12",
    name: "message-end-before-persist",
    kind: "ordering",
    relies: "Session listeners get message_end before pi appends the message's entry, and the append follows in the same tick, so one microtask later the entry is the leaf; the sender and topic markers and the held broadcasts wait that microtask.",
    pi: ["AgentSession.subscribe", "AgentSession._handleAgentEvent", "SessionManager.appendMessage"],
    where: [
      { file: SESSION, symbol: "PiHarnessSession.subscribe" },
      { file: SESSION, symbol: "PiHarnessSession.persistedId" },
      { file: CM, symbol: "ChatSession.markSend" },
      { file: CM, symbol: "ChatSession.markTopic" },
      { file: CM, symbol: "ChatSession.holdForEntryId" },
    ],
    canary: "P12 message-end-before-persist: message_end listeners run before the entry is appended; one microtask later it is the leaf",
    retireWhen: "pi emits after persisting, or gives the entry id with message_end",
  },
  {
    id: "P13",
    name: "no-entry-appended",
    kind: "semantic",
    relies: "setThinkingLevel() and a compaction write their entries without an entry_appended event (an extension's appendEntry emits one), so Sova synthesizes the thinking row and re-reads history after a compaction.",
    pi: ["AgentSession.setThinkingLevel", "AgentSession.compact", "ExtensionAPI.appendEntry"],
    where: [
      { file: CM, symbol: "ChatSession.setThinking" },
      { file: CM, symbol: "ChatSession.refreshAfterCompaction" },
    ],
    canary: "P13 no-entry-appended: setThinkingLevel and a compaction write without entry_appended; an extension's appendEntry emits it",
    retireWhen: "pi emits entry_appended for them (then drop the synthesized row)",
  },
  {
    id: "P14",
    name: "command-direct-call",
    kind: "internal-API",
    relies: "extensionRunner.getCommand(name) returns the command with its handler and sourceInfo.path (Sova checks the owner by that path), and the handler runs outside prompt() with extensionRunner.createCommandContext().",
    pi: ["ExtensionRunner.getCommand", "ExtensionRunner.createCommandContext", "ResolvedCommand.sourceInfo"],
    where: [
      { file: CM, symbol: "ChatSession.modeCommand" },
      { file: CM, symbol: "ChatSession.claudeLoginCommand" },
      { file: CM, symbol: "ChatSession.applyMode" },
      { file: CM, symbol: "ChatSession.syncModePrompt" },
      { file: CM, symbol: "ChatSession.applyLoginPick" },
      { file: CM, symbol: "ChatSession.sandboxHost" },
      { file: CM, symbol: "ChatSession.resumeWorker" },
      { file: "server/sandbox-state.ts", symbol: "sandboxCommandOf" },
      { file: "server/worker-resume.ts", symbol: "resumeCommandOf" },
    ],
    canary: "P14 command-direct-call: getCommand finds an extension's command with its source path, and its handler runs outside prompt() with createCommandContext()'s ctx",
    retireWhen: "pi offers a public run-command API for embedders",
  },
  {
    id: "P15",
    name: "accept-vs-complete",
    kind: "semantic",
    relies: "prompt() resolves when the turn ends, while preflightResult(true) fires when it is accepted (also for a handled extension command); a link delivery takes acceptance from the preflight.",
    pi: ["AgentSession.prompt", "PromptOptions.preflightResult"],
    where: [
      { file: SESSION, symbol: "PiHarnessSession.send" },
      { file: CM, symbol: "ChatSession.linkToSdk" },
    ],
    canary: "P15 accept-vs-complete: prompt() resolves at turn end while preflightResult(true) fires at acceptance (and for a handled command)",
    retireWhen: "never: HarnessSession.send and its onAccepted mirror it; keep the canary",
  },
  {
    id: "P16",
    name: "custom-message-idle",
    kind: "semantic",
    relies: "sendCustomMessage(…, {triggerTurn:false}) on an idle session appends the custom_message entry at once and emits message_start then message_end, with no turn.",
    pi: ["AgentSession.sendCustomMessage"],
    where: [
      { file: SESSION, symbol: "PiHarnessSession.appendNote" },
      { file: CM, symbol: "ChatSession.appendNote" },
    ],
    canary: "P16 custom-message-idle: sendCustomMessage with triggerTurn:false on an idle session appends at once and emits message_start then message_end",
    retireWhen: "never: a contract worth keeping a canary for",
  },
  {
    id: "P17",
    name: "theme-global",
    kind: "private-read",
    relies: 'initTheme() registers the theme on globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")], which Sova reads to hand extensions ctx.ui.theme (pi does not export the instance).',
    pi: ["initTheme", 'Symbol.for("@earendil-works/pi-coding-agent:theme")'],
    where: [{ file: "server/harness/pi/ui-bridge.ts", symbol: "currentTheme" }],
    canary: "P17 theme-global: initTheme registers the theme on globalThis under pi's Symbol.for key",
    retireWhen: "pi exports the theme instance",
  },
  {
    id: "P18",
    name: "warmup-shutdown",
    kind: "internal-API",
    relies: "bindExtensions() emits session_start; a bare dispose() emits no session_shutdown, so the warm-up emits it through extensionRunner.emit before disposing.",
    pi: ["AgentSession.bindExtensions", "AgentSession.dispose", "ExtensionRunner.emit", "ExtensionRunner.hasHandlers"],
    where: [{ file: OPEN, symbol: "warmClaudeCodeProvider" }],
    canary: "P18 warmup-shutdown: bindExtensions emits session_start; a bare dispose() skips session_shutdown, which the runner's emit delivers",
    retireWhen: "dispose() emits session_shutdown (then the warm-up's own emit would double it)",
  },
  {
    id: "P19",
    name: "rebuild-prompt",
    kind: "semantic",
    relies: "The resource loader's appendSystemPromptOverride parts are read when the base system prompt is rebuilt, which setActiveToolsByName(getActiveToolNames()) does; a run alone keeps the prompt it was built with.",
    pi: ["AgentSession.setActiveToolsByName", "AgentSession._rebuildSystemPrompt", "DefaultResourceLoader.appendSystemPromptOverride"],
    where: [{ file: "server/harness/pi/session.ts", symbol: "PiHarnessSession.refreshSystemPrompt" }, { file: "server/overseer.ts", symbol: "LivePrompt.rebase" }],
    canary: "P19 rebuild-prompt: setActiveToolsByName(getActiveToolNames()) re-reads the loader's appendSystemPrompt parts",
    retireWhen: "pi adds a public refreshSystemPrompt(), or re-reads the parts at each run",
  },
  {
    id: "P20",
    name: "model-restore-gate",
    kind: "semantic",
    relies: "createAgentSession restores the branch's recorded model only when the branch has messages; for a message-less session it builds (and appends) another model unless Sova passes the recorded one.",
    pi: ["createAgentSession", "SessionManager.buildSessionContext"],
    where: [
      { file: OPEN, symbol: "recordedModelForEmptyBranch" },
      { file: OPEN, symbol: "modelForSessionOpen" },
    ],
    canary: "P20 model-restore-gate: the SDK restores a recorded model only when the branch has messages",
    retireWhen: "pi restores a recorded model on any branch",
  },
  {
    id: "T1",
    name: "scripted-model (test-only)",
    kind: "private-write",
    relies: "The test double replaces _modelRuntime.hasConfiguredAuth, agent.getApiKey and agent.streamFunction on a live session, and pi then runs its turns on the script.",
    pi: ["AgentSession._modelRuntime", "Agent.getApiKey", "Agent.streamFunction"],
    where: [{ file: "server/harness/pi/testing/scripted-model.ts", symbol: "ScriptedModel.attach" }],
    canary: "T1 scripted-model: the members the test double replaces exist, and it runs a turn",
    retireWhen: "pi offers a public test model hook",
  },
];
