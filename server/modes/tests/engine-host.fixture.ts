// A fake pi host for Sova's mode engine (server/harness/pi/modes.ts's modesExtension, what modes-entry.ts loads):
// its hooks and commands driven directly, no model and no chat (engine-hooks.test.ts, engine-rules.test.ts).
// Importing this module sets PI_CODING_AGENT_DIR (and SOVA_CHAT_STATE_ROOT) to a throwaway dir first: import it,
// dynamically, before anything that computes its paths.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The parent session's own spec variables must not reach the engine (a worker's env names them).
for (const k of Object.keys(process.env)) if (/^(SPEC_AGREE_|SOVA_SPEC_|PI_SPEC_)/.test(k)) delete process.env[k];

export const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-engine-host-")));
export const agentDir = join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; // before the engine reads its agent dir
// The server's own agent dir (its state under it): the engine finds the trusted spec tools in this copy.
process.env.SOVA_CHAT_STATE_ROOT = join(agentDir, "sova");
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const { modesExtension } = await import("../../harness/pi/modes");
const { WEB_MODE_HOOK } = await import("../../../pi-config/extensions/mode/state.ts");
const { MODE_WORKER_EVENT } = await import("../../../pi-config/extensions/mode/events.ts");

export type Entry = { type: string; customType?: string; data?: unknown; content?: unknown; details?: unknown; message?: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;
export type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details?: unknown }>; [k: string]: unknown };
/** claude-code's model list in place of Sova's catalog. */
export type ClaudeModels = () => Promise<{ id: string; efforts: string[] }[]>;

const noop = () => {};

/** A pi as far as the engine uses it, on the chat's entries `entries`, in `cwd`, with launch flags `flags`. */
export function fakePi(entries: Entry[], opts: { cwd?: string; flags?: Record<string, string>; claudeModels?: ClaudeModels; models?: unknown[]; tools?: string[] } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void; getArgumentCompletions?: (prefix: string) => { value: string }[] | null }>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const tools = new Map<string, Tool>();
  let active: string[] = opts.tools ? [...opts.tools] : ["read", "bash", "edit", "write"];
  const notes: { text: string; level: string }[] = [];
  const sent: { customType: string; content: string; details: unknown }[] = [];
  const workerEvents: unknown[] = [];
  const registrations: string[] = [];
  const userMessages: { text: string; options: unknown }[] = [];
  const base: Record<string, unknown> = {
    on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: {
      on: (name: string, fn: (data: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
        return noop;
      },
      emit: (name: string, data: unknown) => {
        if (name === MODE_WORKER_EVENT) workerEvents.push(data);
        for (const fn of listeners.get(name) ?? []) fn(data);
      },
    },
    getFlag: (name: string) => opts.flags?.[name],
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
      registrations.push(tool.name);
    },
    sendUserMessage: (text: string, options: unknown) => userMessages.push({ text, options }),
    getAllTools: () => [...tools.values()].map((t) => ({ name: t.name })),
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => {
      active = [...next];
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: { customType: string; content: string; details: unknown }) => {
      sent.push(message);
      entries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details });
    },
  };
  // Anything else the engine's registrars call (renderers, flags) is a no-op.
  const pi = new Proxy(base, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : noop) });
  const ctx = {
    cwd: opts.cwd ?? scratch,
    hasUI: false,
    signal: undefined,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "s1", getSessionFile: () => undefined, getHeader: () => ({ timestamp: new Date().toISOString() }) },
    ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: noop, setWidget: noop, theme: { fg: (_t: string, s: string) => s, bold: (s: string) => s, bg: (_t: string, s: string) => s } },
    modelRegistry: { getAvailable: () => opts.models ?? [] },
  };
  const handle = modesExtension(pi as never, { claudeModels: opts.claudeModels ?? (async () => []) });
  const fire = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const fn of handlers.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
    return result;
  };
  return {
    notes,
    sent,
    tools,
    registrations,
    userMessages,
    commands,
    ctx,
    workerEvents,
    fire,
    /** The engine's background routing probe now in flight, its own promise (the engine's private `inflight`):
        resolves once that probe has landed, its routes and notices in; at once when none runs. */
    probed: () => (handle.engine as unknown as { inflight?: { done: Promise<void> } }).inflight?.done ?? Promise.resolve(),
    on: (event: string, fn: (data: unknown) => void) => (base.events as { on: (e: string, f: (d: unknown) => void) => void }).on(event, fn),
    activeTools: () => [...active],
    /** Another extension changing the loadout. */
    setTools: (next: string[]) => {
      active = [...next];
    },
    start: (reason = "startup") => fire("session_start", { type: "session_start", reason }),
    mode: (args: string) => commands.get("mode")!.handler(args, ctx),
    align: (args: string) => commands.get("align")!.handler(args, ctx),
    completions: (prefix: string) => (commands.get("mode")!.getArgumentCompletions?.(prefix) ?? []).map((item) => item.value),
    /** A user prompt on a host with prompt sections: its run's mode section, after the engine wrote it. */
    async prompt(): Promise<string | undefined> {
      entries.push({ type: "message", message: { role: "user" } });
      const sections: Record<string, string> = {};
      await fire("before_agent_start", { prompt: "go", systemPrompt: "base", systemPromptOptions: { sections } });
      await fire("agent_start");
      await fire("agent_settled");
      return sections.mode;
    },
    /** A user turn on a host with no sections: the whole system prompt the engine returns (undefined: untouched). */
    async turn(): Promise<string | undefined> {
      const out = (await fire("before_agent_start", { prompt: "go", systemPrompt: "base" })) as { systemPrompt?: string } | undefined;
      await fire("agent_start");
      await fire("agent_settled");
      return out?.systemPrompt;
    },
    compact: async () => {
      entries.push({ type: "compaction" });
      await fire("session_compact");
    },
  };
}

/** Run `fn` as Sova's server does: the hook installed, permitting the mode it is applying (or, `permits` false, none). */
export async function inSova<T>(fn: () => Promise<T>, permits = true): Promise<T> {
  const g = globalThis as Record<symbol, unknown>;
  g[WEB_MODE_HOOK] = () => permits;
  try {
    return await fn();
  } finally {
    delete g[WEB_MODE_HOOK];
  }
}

/** Lets the engine's background probes land. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
