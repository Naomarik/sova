import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  getAgentDir,
  ModelRuntime,
  initTheme,
  SessionManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { ChatClientMessage, ChatServerMessage } from "../shared/protocol";
import { readLive } from "./live";
import { normalizeEntries } from "./transcript";

const IDLE_DISPOSE_MS = 10 * 60 * 1000;

// Extensions may read ctx.ui.theme; pi's `theme` singleton isn't exported, so initialize
// it and read the global instance it registers (same key as pi's theme.js).
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
function currentTheme(): Theme {
  const g = globalThis as Record<symbol, Theme | undefined>;
  if (!g[THEME_KEY]) initTheme(undefined, false);
  return g[THEME_KEY] as Theme;
}

export class BusyError extends Error {}

/** Minimal client interface so ws.ts owns the socket details. */
export interface ChatClient {
  send(msg: ChatServerMessage): void;
}

let modelRuntimePromise: Promise<ModelRuntime> | null = null;
function getModelRuntime(): Promise<ModelRuntime> {
  modelRuntimePromise ??= ModelRuntime.create().catch((err) => {
    modelRuntimePromise = null;
    throw err;
  });
  return modelRuntimePromise;
}

/** Throws BusyError if another process (TUI/CLI) currently owns the session file. */
export function assertNotLive(path: string): void {
  const rec = readLive().get(path);
  if (rec) {
    throw new BusyError(
      `Session is open in another pi process (pid ${rec.pid}, ${rec.mode ?? "tui"}); it is read-only here. Use watch instead.`,
    );
  }
}

/** Strip the per-delta `partial` snapshot (same as pi's rpc toJsonEvent) to keep frames small. */
function toWireEvent(event: any): unknown {
  if (event?.type !== "message_update") return event;
  const ame = event.assistantMessageEvent ?? {};
  let wire = ame;
  if ("partial" in ame) {
    const { partial, ...rest } = ame;
    wire = rest;
    if (ame.type === "toolcall_start") {
      const tc = partial?.content?.[ame.contentIndex];
      if (tc?.type === "toolCall") wire = { ...rest, id: tc.id, toolName: tc.name };
    }
  }
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: wire };
}

function modelLabel(session: AgentSession): string | null {
  const m = session.model;
  return m ? `${m.provider}/${m.id}` : null;
}

interface PendingUi {
  resolve: (value: unknown) => void;
}

/** One embedded pi runtime for one session file, shared by all connected chat clients. */
class ChatSession {
  readonly clients = new Set<ChatClient>();
  private unsubscribe: (() => void) | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;
  private pendingUi = new Map<string, PendingUi>();
  disposed = false;

  constructor(
    readonly path: string,
    readonly runtime: AgentSessionRuntime,
    private readonly onDisposed: () => void,
  ) {}

  get session(): AgentSession {
    return this.runtime.session;
  }

  async bind(): Promise<void> {
    const session = this.session;
    await session.bindExtensions({
      uiContext: this.createUiContext(),
      mode: "rpc",
      onError: (err) =>
        this.broadcast({ type: "error", code: "internal", message: `Extension error (${err.extensionPath}): ${err.error}` }),
    });
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      try {
        this.broadcast({ type: "event", event: toWireEvent(event) });
      } catch (err) {
        console.error("[chat] failed to forward event", err);
      }
      if (event.type === "agent_settled" && this.clients.size === 0) this.scheduleDispose();
    });
  }

  hello(): ChatServerMessage {
    const session = this.session;
    return {
      type: "hello",
      items: normalizeEntries(session.sessionManager.getBranch()),
      isStreaming: session.isStreaming,
      model: modelLabel(session),
    };
  }

  attach(client: ChatClient): void {
    this.clients.add(client);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    client.send(this.hello());
  }

  detach(client: ChatClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0) {
      // Nobody can answer open dialogs anymore: resolve them with defaults.
      for (const p of this.pendingUi.values()) p.resolve(undefined);
      this.pendingUi.clear();
      this.scheduleDispose();
    }
  }

  handle(client: ChatClient, msg: ChatClientMessage): void {
    const fail = (err: unknown) => {
      const busy = err instanceof BusyError;
      client.send({ type: "error", code: busy ? "busy" : "internal", message: err instanceof Error ? err.message : String(err) });
    };
    try {
      switch (msg.type) {
        case "prompt": {
          // Never write if a TUI grabbed this file after we opened it.
          assertNotLive(this.path);
          const text = String(msg.text ?? "");
          if (!text.trim()) return;
          // While streaming, a plain prompt is queued as a follow-up.
          const opts = this.session.isStreaming ? { streamingBehavior: "followUp" as const } : undefined;
          this.session.prompt(text, opts).catch(fail);
          return;
        }
        case "steer": {
          assertNotLive(this.path);
          const text = String(msg.text ?? "");
          if (!text.trim()) return;
          const p = this.session.isStreaming ? this.session.steer(text) : this.session.prompt(text);
          p.catch(fail);
          return;
        }
        case "abort":
          this.session.abort().catch(fail);
          return;
        case "ui_response": {
          const pending = this.pendingUi.get(msg.id);
          if (pending) {
            this.pendingUi.delete(msg.id);
            pending.resolve(msg.value);
          }
          return;
        }
        default:
          client.send({ type: "error", code: "internal", message: `Unknown message type: ${(msg as any)?.type}` });
      }
    } catch (err) {
      fail(err);
    }
  }

  broadcast(msg: ChatServerMessage): void {
    for (const c of this.clients) c.send(msg);
  }

  private scheduleDispose(): void {
    if (this.disposeTimer || this.disposed) return;
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      if (this.clients.size > 0) return;
      if (this.session.isStreaming) {
        // Let the run finish; agent_settled reschedules.
        return;
      }
      void this.dispose();
    }, IDLE_DISPOSE_MS);
    this.disposeTimer.unref();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.unsubscribe?.();
    for (const p of this.pendingUi.values()) p.resolve(undefined);
    this.pendingUi.clear();
    this.onDisposed();
    try {
      await this.runtime.dispose();
    } catch (err) {
      console.error("[chat] runtime dispose failed", err);
    }
  }

  /**
   * Extension dialog bridge (pattern from pi's rpc-mode): select/confirm/input/editor are
   * broadcast as ui_request and resolved by the first ui_response. notify/setStatus are
   * forwarded fire-and-forget (request.fireAndForget = true). TUI-only features are no-ops.
   */
  private createUiContext(): ExtensionUIContext {
    const dialog = <T>(
      opts: ExtensionUIDialogOptions | undefined,
      fallback: T,
      request: Record<string, unknown>,
      parse: (value: unknown) => T,
    ): Promise<T> => {
      if (opts?.signal?.aborted || this.clients.size === 0) return Promise.resolve(fallback);
      const id = randomUUID();
      return new Promise<T>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (value: T) => {
          if (timer) clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          this.pendingUi.delete(id);
          resolve(value);
        };
        const onAbort = () => done(fallback);
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        if (opts?.timeout) timer = setTimeout(() => done(fallback), opts.timeout);
        this.pendingUi.set(id, {
          resolve: (v) => {
            // Accept bare values or pi rpc-style {value}|{confirmed}|{cancelled:true}.
            if (v && typeof v === "object") {
              const o = v as Record<string, unknown>;
              v = o.cancelled ? undefined : "confirmed" in o ? o.confirmed : "value" in o ? o.value : v;
            }
            try {
              done(v === undefined || v === null ? fallback : parse(v));
            } catch {
              done(fallback);
            }
          },
        });
        this.broadcast({ type: "ui_request", id, request: { ...request, timeout: opts?.timeout } });
      });
    };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const fireAndForget = (request: Record<string, unknown>) =>
      this.broadcast({ type: "ui_request", id: randomUUID(), request: { ...request, fireAndForget: true } });

    return {
      select: (title, options, opts) => dialog(opts, undefined, { method: "select", title, options }, str),
      confirm: (title, message, opts) => dialog(opts, false, { method: "confirm", title, message }, (v) => v === true),
      input: (title, placeholder, opts) => dialog(opts, undefined, { method: "input", title, placeholder }, str),
      editor: (title, prefill) => dialog(undefined, undefined, { method: "editor", title, prefill }, str),
      notify: (message, type) => fireAndForget({ method: "notify", message, notifyType: type }),
      setStatus: (key, text) => fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined as never,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return currentTheme();
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching not supported in pi-web" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
}

const sessions = new Map<string, Promise<ChatSession>>();

async function openSession(path: string, onDisposed: () => void): Promise<ChatSession> {
  if (!existsSync(path)) throw new Error(`Session file not found: ${path}`);
  const modelRuntime = await getModelRuntime();
  const sessionManager = SessionManager.open(path);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, modelRuntime });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir: getAgentDir(),
    sessionManager,
  });
  const chat = new ChatSession(path, runtime, onDisposed);
  try {
    await chat.bind();
  } catch (err) {
    await chat.dispose();
    throw err;
  }
  return chat;
}

/**
 * Get (or open) the shared runtime for a session file. Throws BusyError when a TUI owns it.
 * Concurrent callers share one open attempt; failures are not cached.
 */
export async function acquireChat(path: string): Promise<ChatSession> {
  const existing = sessions.get(path);
  if (existing) {
    const chat = await existing;
    if (!chat.disposed) {
      assertNotLive(path);
      return chat;
    }
  }
  assertNotLive(path);
  const forget = () => {
    if (sessions.get(path) === p) sessions.delete(path);
  };
  const p = openSession(path, forget);
  sessions.set(path, p);
  p.catch(forget);
  return p;
}

export async function disposeAllChats(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((p) => p.then((c) => c.dispose()).catch(() => {})));
}

export type { ChatSession };
