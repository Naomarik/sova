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
import type { ChatClientMessage, ChatServerMessage, SlashCommand } from "../shared/protocol";
import { readLive } from "./live";
import { toContextInfo } from "./models";
import { contextForBranch, normalizeEntries } from "./transcript";
import { ForeignWriteGuard, markOwned, recentForeignWriteAgeSec } from "./write-guard";

const IDLE_DISPOSE_MS = 10 * 60 * 1000;
const GUARD_POLL_MS = 3000;

// Extensions may read ctx.ui.theme; pi's `theme` singleton isn't exported, so initialize
// it and read the global instance it registers (same key as pi's theme.js).
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
function currentTheme(): Theme {
  const g = globalThis as Record<symbol, Theme | undefined>;
  if (!g[THEME_KEY]) initTheme(undefined, false);
  return g[THEME_KEY] as Theme;
}

/** A refusal to write. code per shared/protocol.ts: busy = TUI owns it (force never helps),
 *  recent = unknown writer (reconnect with &force=1), reloaded = another client reloaded the runtime. */
export class BusyError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "recent" | "reloaded" = "busy",
  ) {
    super(message);
  }
}

/** Minimal client interface so ws.ts owns the socket details. */
export interface ChatClient {
  send(msg: ChatServerMessage): void;
}

let modelRuntimePromise: Promise<ModelRuntime> | null = null;
export function getModelRuntime(): Promise<ModelRuntime> {
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

type SdkImage = NonNullable<Parameters<AgentSession["steer"]>[1]>[number];

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_RE = /^image\/[\w.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validate client OutboundImage[] and convert to pi's ImageContent {type:"image", data, mimeType}
 * (the stored/SDK shape in 0.85.1; docs' `source:{type:"base64"}` wrapper is not what the types take).
 */
function parseImages(raw: unknown): SdkImage[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("images must be an array of {data, mimeType}");
  let total = 0;
  const out: SdkImage[] = [];
  raw.forEach((img, i) => {
    const data = img?.data;
    const mimeType = img?.mimeType;
    if (typeof data !== "string" || !data || typeof mimeType !== "string" || !MIME_RE.test(mimeType)) {
      throw new Error(`images[${i}] must be {data: base64 string, mimeType: "image/…"}`);
    }
    if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      throw new Error(`images[${i}].data is not valid base64 (send it without the data: prefix)`);
    }
    total += (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (total > MAX_IMAGE_BYTES) throw new Error("images exceed the 20MB total limit");
    out.push({ type: "image", data, mimeType });
  });
  return out.length ? out : undefined;
}

/** pi SourceInfo.scope → rpc get_commands `location` ("temporary" = explicit CLI/settings path). */
function sourceLocation(info: { scope: string } | undefined): string | undefined {
  if (!info) return undefined;
  return info.scope === "temporary" ? "path" : info.scope;
}

/** Same enumeration as pi's rpc get_commands (rpc-mode.js "get_commands"), per runtime/cwd. */
function listCommands(session: AgentSession): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const c of session.extensionRunner.getRegisteredCommands()) {
    out.push({ name: c.invocationName, description: c.description, source: "extension", path: c.sourceInfo?.path });
  }
  for (const t of session.promptTemplates) {
    out.push({ name: t.name, description: t.description, source: "prompt", location: sourceLocation(t.sourceInfo), path: t.filePath });
  }
  for (const s of session.resourceLoader.getSkills().skills) {
    out.push({ name: `skill:${s.name}`, description: s.description, source: "skill", location: sourceLocation(s.sourceInfo), path: s.filePath });
  }
  return out;
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
  private guard: ForeignWriteGuard | null = null;
  private guardTimer: NodeJS.Timeout | null = null;
  /** Set once another process is seen writing this file; all writes are refused after that. */
  foreignWrite: string | null = null;
  /** Open-time SDK bookkeeping appends, written right before the first prompt/steer. */
  deferredAppends: Array<() => void> = [];
  disposed = false;

  constructor(
    readonly path: string,
    readonly runtime: AgentSessionRuntime,
    private readonly onDisposed: () => void,
  ) {}

  get session(): AgentSession {
    return this.runtime.session;
  }

  /** Throws BusyError if a foreign writer was detected (now or earlier). */
  assertNoForeignWrites(): void {
    if (!this.foreignWrite && this.guard) {
      let reason: string | null;
      try {
        reason = this.guard.check();
      } catch (err) {
        reason = `session file unreadable: ${err instanceof Error ? err.message : err}`;
      }
      if (reason) {
        this.foreignWrite = reason;
        this.broadcast({ type: "error", code: "recent", message: this.busyMessage() });
      }
    }
    if (this.foreignWrite) throw new BusyError(this.busyMessage(), "recent");
  }

  private flushDeferredAppends(): void {
    for (const append of this.deferredAppends.splice(0)) append();
  }

  hasForeignWrites(): boolean {
    try {
      this.assertNoForeignWrites();
      return false;
    } catch {
      return true;
    }
  }

  busyMessage(): string {
    return `modified by another process while open here (${this.foreignWrite}); reconnect with force to reload`;
  }

  async bind(): Promise<void> {
    const session = this.session;
    const sm = session.sessionManager;
    this.guard = new ForeignWriteGuard(this.path, (id) => sm.getEntry(id) !== undefined);
    this.guardTimer = setInterval(() => {
      if (this.foreignWrite) return;
      // A TUI that grabs the file mid-run: stop writing now (busy: force must never help).
      const live = readLive().get(this.path);
      if (live) {
        this.foreignWrite = `opened by another pi process (pid ${live.pid})`;
        this.broadcast({
          type: "error",
          code: "busy",
          message: `Session was opened in another pi process (pid ${live.pid}) while held here; stopped writing. Use watch instead.`,
        });
        if (this.session.isStreaming) this.session.abort().catch(() => {});
        return;
      }
      if (this.clients.size === 0) return;
      try {
        this.assertNoForeignWrites();
      } catch {
        // already broadcast
      }
    }, GUARD_POLL_MS);
    this.guardTimer.unref();
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
    this.broadcast(this.commands()); // extension commands exist only after bindExtensions
  }

  commands(): ChatServerMessage {
    try {
      return { type: "commands", commands: listCommands(this.session) };
    } catch (err) {
      console.error("[chat] listing commands failed", err);
      return { type: "commands", commands: [] };
    }
  }

  hello(): ChatServerMessage {
    const session = this.session;
    const branch = session.sessionManager.getBranch();
    return {
      type: "hello",
      items: normalizeEntries(branch),
      isStreaming: session.isStreaming,
      model: modelLabel(session),
      context: toContextInfo(contextForBranch(branch), this.runtime.services.modelRuntime),
    };
  }

  attach(client: ChatClient): void {
    this.clients.add(client);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    client.send(this.hello());
    client.send(this.commands());
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
      const code = err instanceof BusyError ? err.code : "internal";
      client.send({ type: "error", code, message: err instanceof Error ? err.message : String(err) });
    };
    if (this.disposed) {
      client.send({ type: "error", code: "reloaded", message: "Session runtime was closed; reconnect" });
      return;
    }
    try {
      switch (msg.type) {
        case "prompt": {
          // Never write if a TUI grabbed this file, or anyone else wrote it, after we opened it.
          assertNotLive(this.path);
          this.assertNoForeignWrites();
          const text = String(msg.text ?? "");
          const images = parseImages(msg.images);
          if (!text.trim() && !images) return;
          this.flushDeferredAppends();
          // While streaming, a plain prompt is queued as a follow-up.
          const streamingBehavior = this.session.isStreaming ? ("followUp" as const) : undefined;
          this.session.prompt(text, { images, streamingBehavior }).catch(fail);
          return;
        }
        case "steer": {
          assertNotLive(this.path);
          this.assertNoForeignWrites();
          const text = String(msg.text ?? "");
          const images = parseImages(msg.images);
          if (!text.trim() && !images) return;
          this.flushDeferredAppends();
          // steer() throws on extension commands; prompt() runs them immediately (even mid-stream)
          // and otherwise queues as steer with the same skill/template expansion.
          const p =
            this.session.isStreaming && !text.startsWith("/")
              ? this.session.steer(text, images)
              : this.session.prompt(text, { images, streamingBehavior: this.session.isStreaming ? "steer" : undefined });
          p.catch(fail);
          return;
        }
        case "abort":
          this.session.abort().catch(fail);
          return;
        case "set_model": {
          // setModel appends a model_change entry: same write guards as prompt.
          assertNotLive(this.path);
          this.assertNoForeignWrites();
          if (this.session.isStreaming) throw new Error("Cannot switch models while the agent is running; wait or abort first");
          const ref = String(msg.ref ?? "");
          // Resolve against models with configured auth (= GET /api/models) BEFORE writing anything,
          // so a rejected switch leaves the file untouched.
          this.runtime.services.modelRuntime
            .getAvailable()
            .then(async (available) => {
              const model = available.find((m) => `${m.provider}/${m.id}` === ref);
              if (!model) {
                const known = this.runtime.services.modelRuntime.getModel(ref.split("/")[0] ?? "", ref.slice(ref.indexOf("/") + 1));
                throw new Error(known ? `No credentials configured for ${ref}` : `Unknown model: ${ref || "(empty ref)"}`);
              }
              // Re-check after the async lookup: a TUI/foreign writer may have appeared meanwhile.
              // BusyError propagates to `fail`, which maps it to its busy/recent code.
              assertNotLive(this.path);
              this.assertNoForeignWrites();
              if (this.session.isStreaming) throw new Error("Cannot switch models while the agent is running; wait or abort first");
              this.flushDeferredAppends(); // keep open-time entries before this model_change
              await this.session.setModel(model);
              this.broadcast({ type: "model", model: modelLabel(this.session) ?? ref });
            })
            .catch(fail);
          return;
        }
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
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.unsubscribe?.();
    for (const p of this.pendingUi.values()) p.resolve(undefined);
    this.pendingUi.clear();
    if (held.get(this.path) === this) held.delete(this.path); // a reload may already hold a newer one
    this.onDisposed();
    try {
      await this.runtime.dispose();
    } catch (err) {
      console.error("[chat] runtime dispose failed", err);
    }
    // Remember the state we left the file in, so reopening soon isn't mistaken for a foreign write.
    if (!this.foreignWrite) markOwned(this.path);
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
/** Fully opened runtimes by canonical path (pending opens are not here), for sync busy lookups. */
const held = new Map<string, ChatSession>();

/** SessionSummary.busy: this server holds the runtime and an agent run is in progress. */
export function isSessionBusy(path: string): boolean {
  const chat = held.get(path);
  return !!chat && !chat.disposed && chat.session.isStreaming;
}

async function openSession(path: string, onDisposed: () => void): Promise<ChatSession> {
  if (!existsSync(path)) throw new Error(`Session file not found: ${path}`);
  const modelRuntime = await getModelRuntime();
  const sessionManager = SessionManager.open(path);
  // The SDK records model/thinking-level entries while constructing a session (for sessions with
  // no messages yet, or no thinking entry on the branch). Queue them and write them just before
  // the first prompt, so merely opening (browsing) a session never modifies its file.
  const deferred: Array<() => void> = [];
  const appendModelChange = sessionManager.appendModelChange;
  const appendThinkingLevelChange = sessionManager.appendThinkingLevelChange;
  sessionManager.appendModelChange = (...args: Parameters<typeof appendModelChange>) => {
    deferred.push(() => appendModelChange.apply(sessionManager, args));
    return "";
  };
  sessionManager.appendThinkingLevelChange = (...args: Parameters<typeof appendThinkingLevelChange>) => {
    deferred.push(() => appendThinkingLevelChange.apply(sessionManager, args));
    return "";
  };
  const restore = () => {
    sessionManager.appendModelChange = appendModelChange;
    sessionManager.appendThinkingLevelChange = appendThinkingLevelChange;
  };
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, modelRuntime });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  try {
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
    chat.deferredAppends = deferred;
    held.set(path, chat);
    return chat;
  } finally {
    restore();
  }
}

/**
 * Get (or open) the shared runtime for a session file. Throws BusyError when a TUI owns it,
 * or (unless `force`) when another process may be writing it. Concurrent callers share one
 * open attempt; failures are not cached.
 */
export async function acquireChat(path: string, force = false): Promise<ChatSession> {
  const existing = sessions.get(path);
  if (existing) {
    const chat = await existing.catch(() => null);
    if (chat && !chat.disposed) {
      assertNotLive(path);
      if (chat.hasForeignWrites()) {
        if (!force) throw new BusyError(chat.busyMessage(), "recent");
        // "Chat anyway": our in-memory tree is stale, so reload from disk instead of appending to it.
        chat.broadcast({ type: "error", code: "reloaded", message: "Session was reloaded by another client; reconnect" });
        await chat.dispose();
      } else {
        return chat;
      }
    }
  }
  assertNotLive(path);
  if (!force) {
    // Shared constant with the frontend: RECENT_WRITE_MS (120s) in server/write-guard.ts.
    const age = recentForeignWriteAgeSec(path);
    if (age !== null) throw new BusyError(`modified ${age}s ago by a process we can't identify`, "recent");
  }
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
