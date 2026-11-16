// Sova's chat mode engine, pi's half (§chat.mode-menu/sova-runs-modes): the engine is harness-neutral
// (server/modes/engine.ts); this file is where pi's events, entries, messages and tools meet it.
//
// The engine is loaded IN THE SLOT the pi-config `mode` extension had, never beside it: the loader's
// resolve() rewrite (own-code.ts ownExtensions) answers a discovered `…/extensions/mode` with
// modes-entry.ts, always on, and adds it among the agent dir's extensions where a link would be found
// when there is none; a worker's listed mode paths are rewritten the same way (own-code.ts modesEntries,
// modeFileOf, workerModePaths). So the tools register in the same order, the `mode` section keeps its
// place among the prompt's sections, and every hook chains where it did: what the model sees is the
// extension's, byte for byte. The pi mode extension itself never loads in Sova.
//
// The tools are registered with the extension's own registrars (align-tool.ts, vis-guide-tool.ts,
// create-guide-tool.ts): the same names, descriptions, schemas and renderers. Raw branch reads and entry
// writes happen here only, through the extension's readers (state.ts, align.ts, spec-guard.ts).
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { foldAlignments } from "../../../pi-config/extensions/mode/align.ts";
import { registerAlignTool } from "../../../pi-config/extensions/mode/align-tool.ts";
import { registerCreateGuideTool } from "../../../pi-config/extensions/mode/create-guide-tool.ts";
import { WorkerProbe, type ClaudeModelSource } from "../../../pi-config/extensions/mode/discovery.ts";
import { MINOR_MODES } from "../../../pi-config/extensions/mode/minor.ts";
import { PROJECT_SNAPSHOT_TYPE } from "../../../pi-config/extensions/mode/project-format.ts";
import { bashCommands, procedureToldIn } from "../../../pi-config/extensions/mode/spec-guard.ts";
import { setAgreeSource } from "../../../pi-config/extensions/mode/spec-agree.ts";
import { MODE_ENTRY_TYPE, MODE_HEAD_TYPE, MODE_NOTE_TYPE, restoreActive, restoreHead, restoreProjectSnapshots, type Mode } from "../../../pi-config/extensions/mode/state.ts";
import { registerVisGuideTool } from "../../../pi-config/extensions/mode/vis-guide-tool.ts";
import { policyDenial, readPolicy } from "../../../pi-config/extensions/subagents/policy.ts";
import { pickEntryFor, restorePick } from "../../../pi-config/extensions/subagents/subagent-profiles.ts";
import type { MinorMode } from "../../../pi-config/extensions/mode/minor.ts";
import { ModeEngine, REVIEW_FLAG, VISUALS_FLAG, type ModeSource } from "../../modes/engine";
import type { ModeCtx, ModePort } from "../../modes/port";
import type { PiExtensionAPI } from "./extension-types";
import { ownSpecCore } from "./own-code";

/** The engine's handle on the runtime's bus, for the chat that hosts it (modesBridgeExtension). */
export const MODES_ENGINE_EVENT = "sova:modes-engine";
export const MODES_ENGINE_DISCOVER_EVENT = "sova:modes-engine-discover";

/** What a chat may ask its runtime's engine; `ctx` is the harness's command context (it carries the base prompt options). */
export interface ModesHandle {
  setMode(mode: Mode, ctx: unknown): Promise<void>;
  setMinor(minor: MinorMode, on: boolean, ctx: unknown): void;
  setProject(id: string, on: boolean, ctx: unknown): void;
  setStrict(on: boolean, ctx: unknown): void;
  setSubagentProfile(arg: string, ctx: unknown): void;
  /** `/mode sync`'s replacement: run at every bind. */
  sync(ctx: unknown): void;
  /** Typed `/mode <args>` as the composer's command. */
  command(args: string, ctx: unknown): Promise<void>;
  /** The engine itself (tests). */
  readonly engine: ModeEngine;
}

export interface ModesExtensionOptions {
  /** Replaces Sova's Claude catalog as claude-code's model list (tests). */
  claudeModels?: ClaudeModelSource;
  /** Where project (and personal) modes come from (server/modes/registry.ts); the checkout's alone without it. */
  modes?: () => ModeSource | undefined;
}

/** The one ModeCtx of an event's (or a command's) context. */
function modeCtx(ctx: ExtensionContext, probe: WorkerProbe): ModeCtx {
  const sm = ctx.sessionManager;
  const branch = () => sm.getBranch();
  return {
    sessionId: () => {
      try {
        return sm.getSessionId();
      } catch {
        return undefined;
      }
    },
    cwd: () => ctx.cwd,
    signal: () => ctx.signal,
    notify: (text, level) => {
      try {
        ctx.ui.notify(text, level);
      } catch {
        // Notices are best-effort.
      }
    },
    isIdle: () => ctx.isIdle(),
    branch: {
      active: () => restoreActive(branch()),
      head: () => restoreHead(branch()),
      snapshots: () => restoreProjectSnapshots(branch()),
      align: () => foldAlignments(branch()),
      pick: () => restorePick(branch() as never),
      pickEntry: (profile) => pickEntryFor(branch() as never, profile),
      procedureTold: () => procedureToldIn(branch()),
      bashCommands: () => bashCommands(branch()),
      setAgreeSource: (specOn) => setAgreeSource(sm, specOn),
    },
    sessionStartedAt: () => sm.getHeader()?.timestamp,
    hostOptions: () => {
      const get = (ctx as { getSystemPromptOptions?: unknown }).getSystemPromptOptions;
      return typeof get === "function" ? (get as () => { sections?: Record<string, string> }) : undefined;
    },
    discover: (backend) => probe.discover(ctx, backend),
  };
}

/**
 * index.ts's `context` filter: once the head is rebuilt after a compaction, the mode notes from before it that
 * the compaction kept repeat what the head says, so every request leaves them out (the same every request).
 */
export function withoutStaleNotes<M>(messages: M[], headFixed: boolean): M[] | undefined {
  if (!headFixed) return undefined;
  const ms = messages as { role?: string; customType?: string; timestamp?: number }[];
  let cut: number | undefined;
  for (let i = ms.length - 1; i >= 0 && cut === undefined; i--) {
    if (ms[i]?.role === "compactionSummary") cut = ms[i]?.timestamp;
  }
  if (cut === undefined) return undefined;
  const kept = messages.filter((_m, i) => !(ms[i]?.role === "custom" && ms[i]?.customType === MODE_NOTE_TYPE && (ms[i]?.timestamp ?? 0) < cut!));
  return kept.length === messages.length ? undefined : kept;
}

/** Where spec-mode.md's `$core` line resolves the trusted spec tools: SOVA_SPEC_CORE (a local chat's own copy of
    Sova, set at its launch), else this copy's on the server's own agent dir (the server, its in-process and hidden
    chats) and the agent dir's elsewhere (a worker on its worktree's own .agent): own-code.ts ownSpecCore. */
export function engineSpecCore(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.SOVA_SPEC_CORE || ownSpecCore(agentDir, env);
}

/** The engine for one runtime, wired to pi (the factory modes-entry.ts exports). */
export function modesExtension(pi: PiExtensionAPI, options: ModesExtensionOptions = {}): ModesHandle {
  const agentDir = getAgentDir();
  const probe = new WorkerProbe(pi, options.claudeModels);
  const port: ModePort = {
    recordSwitch: (data) => pi.appendEntry(MODE_ENTRY_TYPE, data),
    recordHead: (data) => pi.appendEntry(MODE_HEAD_TYPE, data),
    recordProjectCopy: (copy) => pi.appendEntry(PROJECT_SNAPSHOT_TYPE, copy),
    recordPick: (entry) => pi.appendEntry(entry.customType, entry.data),
    denial: () => {
      const policy = readPolicy();
      return (choice) => policyDenial(policy, choice.backend, choice.model);
    },
    note: (message, nextTurn) => (nextTurn ? pi.sendMessage(message, { deliverAs: "nextTurn" }) : pi.sendMessage(message)),
    sendUser: (text, followUp) => pi.sendUserMessage(text, followUp ? { deliverAs: "followUp" } : undefined),
    activeTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    registerAlign: (form) => registerAlignTool(pi, engine.alignHost, form),
    registerTool: (definition) => pi.registerTool(definition as never),
    emit: (event, data) => pi.events?.emit(event, data),
    on: (event, listener) => {
      pi.events?.on(event, listener);
    },
    flag: (name) => pi.getFlag(name),
  };
  const engine = new ModeEngine(port, {
    agentDir,
    specCore: () => engineSpecCore(agentDir),
    ...(options.modes?.() ? { modes: options.modes()! } : {}),
  });
  const ctxOf = (ctx: unknown) => modeCtx(ctx as ExtensionContext, probe);

  // The flags the mode extension declared, so Sova's launch flags (and a worker's --minor) are accepted as before.
  pi.registerFlag("major", { description: "Start in a mode: normal | delegate", type: "string" });
  pi.registerFlag(REVIEW_FLAG, { description: "Adversarial review of alignments", type: "boolean", default: false });
  pi.registerFlag(VISUALS_FLAG, { description: "Align visuals for this session: on | off (default: mode-align.json)", type: "string" });
  pi.registerFlag("minor", { description: `Start with minor modes on (comma-separated): ${MINOR_MODES.join(" | ")}, or none`, type: "string" });
  engine.listen();

  registerAlignTool(pi, engine.alignHost);
  engine.onReviewNeeded = () =>
    pi.registerCommand("review", {
      description: "Ask for an alignment's adversarial review: /review plan|implementation [al_N]",
      getArgumentCompletions: (argumentPrefix) => {
        const items = ["plan", "implementation"].filter((value) => value.startsWith(argumentPrefix.trim())).map((value) => ({ value, label: value }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => engine.reviewCommand(args, ctxOf(ctx)),
    });
  registerVisGuideTool(pi);
  registerCreateGuideTool(pi);

  pi.registerCommand("align", {
    description: "Turn the align minor mode on or off: /align on|off",
    getArgumentCompletions: (argumentPrefix) => {
      const items = ["on", "off"].filter((value) => value.startsWith(argumentPrefix.trim())).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => engine.alignCommand(args, ctxOf(ctx)),
  });
  pi.registerCommand("mode", {
    description: "Set a mode: /mode <mode> | strict on|off | <minor mode> [on|off] | subagents <profile>",
    getArgumentCompletions: (argumentPrefix) => engine.modeCompletions(argumentPrefix),
    handler: async (args, ctx) => engine.modeCommand(args, ctxOf(ctx)),
  });

  pi.on("tool_execution_start", async (event) => engine.toolExecutionStart(event.toolName, event.args));
  pi.on("turn_end", async (event) => engine.turnEnd(event.message));
  pi.on("agent_before_settle", async (event) => engine.beforeSettle(event as never) as never);
  pi.on("agent_settled", async () => engine.agentSettled());
  pi.on("session_compact", async () => engine.compact());
  pi.on("context", async (event) => {
    const kept = withoutStaleNotes(event.messages, engine.headFixed());
    return kept ? { messages: kept } : undefined;
  });
  pi.on("session_tree", async (_event, ctx) => engine.tree(ctxOf(ctx)));
  pi.on("tool_call", async (event, ctx) => engine.toolCall(event, ctxOf(ctx)));
  // index.ts's two tool_execution_end handlers (the align count, then the census close), in their order.
  pi.on("tool_execution_end", async (event) => engine.toolExecutionEnd(event as never));
  pi.on("tool_result", async (event, ctx) => (await engine.toolResult(event as never, ctxOf(ctx))) as never);
  pi.on("session_shutdown", async () => engine.shutdown());
  pi.on("before_agent_start", async (event, ctx) => {
    const sections = (event.systemPromptOptions as { sections?: Record<string, string> } | undefined)?.sections;
    return engine.beforeAgentStart({ prompt: event.prompt, systemPrompt: event.systemPrompt, ...(sections ? { sections } : {}) }, ctxOf(ctx)) as never;
  });
  pi.on("agent_start", async (_event, ctx) => engine.agentStart(ctxOf(ctx)));

  const handle: ModesHandle = {
    engine,
    setMode: (mode, ctx) => engine.setMode(mode, ctxOf(ctx)),
    setMinor: (minor, on, ctx) => engine.setMinor(minor, on, ctxOf(ctx)),
    setProject: (id, on, ctx) => engine.setProject(id, on, ctxOf(ctx)),
    setStrict: (on, ctx) => engine.setStrict(on, ctxOf(ctx)),
    setSubagentProfile: (arg, ctx) => engine.setSubagentProfile(arg, ctxOf(ctx)),
    sync: (ctx) => engine.sync(ctxOf(ctx).hostOptions()),
    command: (args, ctx) => engine.modeCommand(args, ctxOf(ctx)),
  };
  const announce = () => pi.events?.emit(MODES_ENGINE_EVENT, { version: 1, handle });
  pi.events?.on(MODES_ENGINE_DISCOVER_EVENT, announce);

  pi.on("session_start", async (event, ctx) => {
    engine.sessionStart((event as { reason?: string } | undefined)?.reason, ctxOf(ctx));
    announce();
  });
  return handle;
}

/** The chat's side of the handle: an inline extension that only listens (no tool, section or hook). */
export function modesBridgeExtension(onHandle: (handle: ModesHandle) => void) {
  return {
    name: "sova-modes-bridge",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      pi.events?.on(MODES_ENGINE_EVENT, (data: unknown) => {
        const e = data as { version?: unknown; handle?: ModesHandle } | undefined;
        if (e?.version === 1 && e.handle) onHandle(e.handle);
      });
      pi.on("session_start", async () => {
        pi.events?.emit(MODES_ENGINE_DISCOVER_EVENT, { version: 1 });
      });
    },
  };
}
