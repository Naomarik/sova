import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
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
import type { ChatClientMessage, ChatModeResult, ChatServerMessage, ModeApplies, SlashCommand } from "../shared/protocol";
import { decodeUsageTotal, decodeWorkers } from "./insights";
import { readLive, readOwnLiveRecords, workerCountsOf } from "./live";
import { appliesAfter, mergeMode, MINOR_MODES, modeApplyPlan, modeInfo, readMode, resolveChatMode, type ModePatch, type ModeState } from "./mode-state";
import { toContextInfo } from "./models";
import { contextForBranch, normalizeEntries } from "./transcript";
import { ForeignWriteGuard, markOwned, recentForeignWriteAgeSec } from "./write-guard";

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

/**
 * A session that cannot be opened until something outside this server changes — today, a stored
 * `cwd` that no longer exists (the SDK refuses to build a runtime for it). Unlike BusyError this
 * is not worth retrying: reconnecting re-runs the same failure and appends another error to the
 * client's thread, which is how one reaped directory produced dozens of identical banners.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    /** The missing directory, re-checked to decide when the condition has cleared. */
    readonly cwd: string,
  ) {
    super(message);
  }
}

/**
 * Paths whose last open failed permanently, so repeat connects fail fast instead of re-running
 * the SDK open. Keyed by session path; dropped as soon as the cwd exists again, so recreating the
 * directory recovers without restarting the server.
 */
const configFailures = new Map<string, ConfigError>();

/**
 * The cached permanent failure for `path`, if it still applies. Exported because it is the whole
 * retry policy for permanent errors: acquireChat answers from it, and it is how a caller (or a
 * test) asks whether the condition has cleared.
 */
export function activeConfigFailure(path: string): ConfigError | undefined {
  const failure = configFailures.get(path);
  if (!failure) return undefined;
  if (existsSync(failure.cwd)) {
    configFailures.delete(path); // the directory came back: let the next open try for real
    return undefined;
  }
  return failure;
}

/**
 * The session's stored cwd, read straight from the JSONL header, so a missing directory can be
 * detected before doing any of the expensive open work (model runtime, extensions, SDK session).
 * Unreadable or headerless files return null and are left to the normal open path to report.
 */
function storedCwd(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(8192);
    const read = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(firstLine);
    return header?.type === "session" && typeof header.cwd === "string" && header.cwd ? header.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/** The SDK throws MissingSessionCwdError; match by name so we don't depend on its class identity. */
function asConfigError(err: unknown, cwd: string): ConfigError | null {
  if (err instanceof ConfigError) return err;
  if (err instanceof Error && err.name === "MissingSessionCwdError") return new ConfigError(err.message, cwd);
  return null;
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
  private pendingUi = new Map<string, PendingUi>();
  private guard: ForeignWriteGuard | null = null;
  private guardTimer: NodeJS.Timeout | null = null;
  private workersTimer: NodeJS.Timeout | null = null;
  /** Wire-serialized last workers broadcast, so polls only send on change. */
  private lastWorkersJson: string | null = null;
  /** Set once another process is seen writing this file; all writes are refused after that. */
  foreignWrite: string | null = null;
  /** Open-time SDK bookkeeping appends, written right before the first prompt/steer. */
  deferredAppends: Array<() => void> = [];
  disposed = false;
  /** How the last switch of THIS chat applies (ModeApplies); set at bind and by applyMode. */
  modeApplies: ModeApplies = "now";
  /**
   * This chat's own mode — never another chat's, and never simply the file. bind() resolves it
   * from this session's branch (resolveChatMode), and applyMode replaces it. The file default
   * here is only a placeholder until bind() runs.
   */
  modeState: ModeState = readMode();

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
    this.workersTimer = setInterval(() => this.pushWorkers(), GUARD_POLL_MS);
    this.workersTimer.unref();
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
      if (event.type === "agent_settled" && this.modeApplies === "after-turn") {
        // A mid-turn switch reaches the next prompt from here on.
        this.modeApplies = "now";
        this.broadcast(this.modeMessage());
      }
    });
    this.broadcast(this.commands()); // extension commands exist only after bindExtensions
    // The same rule the extension's own session_start runs, so both agree on this session's mode.
    this.modeState = resolveChatMode(session.sessionManager.getBranch());
    this.modeApplies = this.modeCommand() ? "now" : "new-chats";
  }

  /**
   * The mode extension's own /mode command in this runtime, or undefined when it isn't loaded
   * (extension-toggle, a name clash). Checked by source so another extension's "mode" never runs.
   */
  private modeCommand() {
    const cmd = this.session.extensionRunner.getCommand("mode");
    return cmd && /[\\/]extensions[\\/]mode[\\/]index\.ts$/.test(cmd.sourceInfo?.path ?? "") ? cmd : undefined;
  }

  modeMessage(): ChatServerMessage {
    const s = this.modeState;
    return { type: "mode", mode: s.mode, minorModes: [...s.minorModes], strict: s.strict, applies: this.modeApplies };
  }

  /**
   * POST /api/mode?path=: merge the patch into THIS chat's mode and apply it here only. mode.json
   * (the default for new sessions) is not touched, and no other chat hears about it.
   */
  async switchMode(patch: ModePatch): Promise<ChatModeResult> {
    await this.applyMode(mergeMode(this.modeState, patch));
    return { ...modeInfo(this.modeState), applies: this.modeApplies };
  }

  /**
   * Make this runtime follow `state` from its next prompt (modeApplyPlan), and make it this
   * chat's mode. The /mode handler is called directly, never sent through prompt(), so no command
   * text can reach the model; it appends the marker entry this session later restores from.
   * Resolves once the switch is in the extension's memory; the claude-heavy planner probe it then
   * starts isn't awaited.
   */
  async applyMode(state: ModeState): Promise<void> {
    if (this.disposed) return;
    const session = this.session;
    const streaming = session.isStreaming;
    let live = false;
    try {
      assertNotLive(this.path);
    } catch {
      live = true;
    }
    const plan = modeApplyPlan({
      foreign: live || this.hasForeignWrites(),
      hasModeCommand: !!this.modeCommand(),
      pristine: !session.sessionManager.getBranch().some((e) => e.type === "message" && e.message.role === "user"),
      streaming,
    });
    let applies = appliesAfter(plan, streaming);
    if (plan === "command") {
      // getCommand + createCommandContext + handler(args, ctx) is the SDK's own extension-command
      // path (AgentSession._tryExecuteExtensionCommand, agent-session.js ~954 in pinned 0.85.1),
      // minus the prompt text that path falls back to when a command is missing. Internal-ish
      // API: re-check on SDK upgrades. The SDK reports handler errors via emitError; so do we.
      const cmd = this.modeCommand()!;
      const ctx = session.extensionRunner.createCommandContext();
      this.flushDeferredAppends(); // open-time entries go before the extension's mode marker
      try {
        for (const minor of MINOR_MODES) await cmd.handler(`${minor} ${state.minorModes.includes(minor) ? "on" : "off"}`, ctx);
        // Not awaited: after switching, setMode awaits the claude-heavy planner probe (up to 15s).
        cmd.handler(state.mode, ctx).catch((err) => {
          console.error("[chat] /mode handler failed", err);
          if (this.disposed) return;
          this.modeApplies = "new-chats";
          this.broadcast(this.modeMessage());
        });
      } catch (err) {
        console.error("[chat] /mode handler failed", err);
        applies = "new-chats";
      }
      if (!this.foreignWrite) markOwned(this.path); // the marker entry is our write
      this.modeState = state; // the runtime took it: this is now this chat's mode
    }
    this.modeApplies = applies;
    this.broadcast(this.modeMessage());
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
    client.send(this.hello());
    client.send(this.commands());
    client.send(this.modeMessage());
    const snap = this.workersSnapshot();
    if (snap) client.send(snap);
  }

  detach(client: ChatClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0) {
      // Nobody can answer open dialogs anymore: resolve them with defaults. The runtime stays
      // alive: a session closes when the user archives it, not when the last tab leaves.
      for (const p of this.pendingUi.values()) p.resolve(undefined);
      this.pendingUi.clear();
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

  /** Worker snapshot from this runtime's own live record (the sessions extension writes one
      even for embedded runtimes), as the wire message; null when the record or its counts
      are absent. The token Σ rides along: it is the record's own lifetime total, which covers
      workers the record no longer lists, so it is never summed from the rows. */
  private workersSnapshot(): ChatServerMessage | null {
    const rec = readOwnLiveRecords().get(this.path);
    const counts = rec ? workerCountsOf(rec.rec) : undefined;
    if (!rec || !counts) return null;
    const usageTotal = decodeUsageTotal(rec.rec?.presence);
    return { type: "workers", working: counts.working, total: counts.total,
      workers: decodeWorkers(rec.rec?.presence), ...(usageTotal ? { usageTotal } : {}) };
  }

  /** Broadcast the worker snapshot when it changed since the last send; a record that
      vanished after existing means workers went away, so send an explicit zero once. */
  private pushWorkers(): void {
    if (this.disposed || this.clients.size === 0) return;
    let msg: ChatServerMessage | null = null;
    try {
      msg = this.workersSnapshot();
    } catch {
      return; // live dir unreadable mid-write: retry next tick
    }
    const json = msg ? JSON.stringify(msg) : null;
    if (json === this.lastWorkersJson) return;
    this.lastWorkersJson = json;
    this.broadcast(msg ?? { type: "workers", working: 0, total: 0, workers: [] });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.guardTimer) clearInterval(this.guardTimer);
    if (this.workersTimer) clearInterval(this.workersTimer);
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

/** Close a held runtime for good (archive/close): any open tab is told to reconnect, and the
    session reopens on demand. A running turn is aborted and its workers die with it. */
export async function disposeHeldChat(path: string, message: string): Promise<boolean> {
  const chat = held.get(path);
  if (!chat || chat.disposed) return false;
  chat.broadcast({ type: "error", code: "reloaded", message });
  await chat.dispose();
  return true;
}

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
    // topic-outline only summarizes in the TUI unless its host opts in; opt in so web chats get
    // outlines. Boolean flag: the SDK sets it true whatever the value. Workers never get it.
    const services = await createAgentSessionServices({
      cwd,
      modelRuntime,
      extensionFlagValues: new Map([["topic-outline-headless", true]]),
    });
    for (const d of services.diagnostics) console.warn(`[chat] runtime ${d.type}: ${d.message}`);
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const sessionCwd = sessionManager.getCwd();
  // The runtime cannot be built against a directory that is gone. Check before doing the work, so
  // the failure is classified (ConfigError, not "internal") and cheap to repeat.
  if (sessionCwd && !existsSync(sessionCwd))
    throw new ConfigError(`Stored session working directory does not exist: ${sessionCwd}\nSession file: ${path}`, sessionCwd);
  try {
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionCwd,
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
  } catch (err) {
    const config = asConfigError(err, sessionCwd);
    throw config ?? err;
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
  // Permanent and already known: answer from the memo. Retrying would repeat the same SDK open and
  // hand the client another copy of an error it cannot act on. `force` does not apply — no flag
  // makes a deleted directory exist.
  const known = activeConfigFailure(path);
  if (known) throw known;
  // Detect it cheaply on the first connect too: the header's cwd is all it takes, and the open
  // below would otherwise build a model runtime before the SDK reached the same conclusion.
  const cwd = storedCwd(path);
  if (cwd && !existsSync(cwd)) {
    const failure = new ConfigError(`Stored session working directory does not exist: ${cwd}\nSession file: ${path}`, cwd);
    configFailures.set(path, failure);
    throw failure;
  }
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
  p.catch((err) => {
    // Transient failures are forgotten so the next connect retries; permanent ones are recorded so
    // it doesn't.
    if (err instanceof ConfigError) configFailures.set(path, err);
    forget();
  });
  return p;
}

/** Every fully opened runtime this server holds. Each keeps its own mode; there is no fan-out. */
export const heldChats = (): ChatSession[] => [...held.values()].filter((c) => !c.disposed);

/** The open chat for a session file (already through resolveSessionPath), for POST /api/mode?path=. */
export const heldChat = (path: string): ChatSession | undefined => heldChats().find((c) => c.path === path);

export async function disposeAllChats(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((p) => p.then((c) => c.dispose()).catch(() => {})));
}

export type { ChatSession };
