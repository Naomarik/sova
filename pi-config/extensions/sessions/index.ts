import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPresenceChannel, type IntercomExtensionEvent, type PresenceChannel, type PresenceChannelOptions } from "./presence.ts";
import { checkFocusable, discoverFocusTarget, focusTarget, type FocusTarget } from "./focus.ts";
import { subscribeWorkers, type WorkerSummary } from "./workers.ts";
import { SessionsOverlay } from "./ui.ts";
import { clean, SessionStore, parseOutline, type Presence, type PresenceOutline } from "./state.ts";
import { countWorkers, fit, RECORD_BUDGET, SCHEMA_VERSION, SESSION_MODES, WORKER_SESSION_FILE_MAX, WORKER_SESSION_ID_MAX, type Activity, type SessionMeta, type SessionState } from "./schema.ts";

const OUTLINE_SNAPSHOT = "topic-outline:snapshot";
const OUTLINE_REQUEST = "topic-outline:request";
const BUCKETS = 16;
/** Same length as the channel's real endpointEpoch, for record-size accounting. */
const EPOCH_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const BUCKET_MS = 15_000;
/** Tools whose file path is shared as a basename; everything else shares no detail. */
const FILE_TOOLS = new Set(["read", "edit", "write"]);

export interface SessionsConfig { budgetBytes: number }
export interface SessionsDeps {
  /** Test seam: substitute a fake presence-channel factory. */
  createChannel?: (options: PresenceChannelOptions) => PresenceChannel;
  /** Test seam: defaults to ~/.pi/agent/sessions.json. */
  configPath?: string;
}

/** Sync, tolerant, never written back. Parse errors ⇒ defaults. */
export function loadConfig(path = join(homedir(), ".pi", "agent", "sessions.json")): SessionsConfig {
  const config: SessionsConfig = { budgetBytes: RECORD_BUDGET };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.budgetBytes === "number" && Number.isFinite(raw.budgetBytes)) {
      config.budgetBytes = Math.min(65_536, Math.max(4_096, Math.floor(raw.budgetBytes)));
    }
  } catch { /* absent or malformed: defaults */ }
  return config;
}

/** "edit · auth.ts" for file tools; never commands, arguments or full paths. */
export function toolDetail(toolName: string, args: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName) || !args || typeof args !== "object") return;
  const a = args as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined;
  const base = path && clean(path.split(/[\\/]/).filter(Boolean).pop() ?? "", 60).trim();
  return base ? `${toolName} · ${base}`.slice(0, 60) : undefined;
}

export default function sessions(pi: ExtensionAPI, deps: SessionsDeps = {}) {
  const createChannel = deps.createChannel ?? createPresenceChannel;
  const sessionStartedAt = Date.now();
  let ctx: ExtensionContext | undefined;
  let live = false;
  let config: SessionsConfig = { budgetBytes: RECORD_BUDGET };
  let channel: PresenceChannel | undefined;
  const store = new SessionStore(process.pid);
  let target: FocusTarget | undefined;
  let focusable: boolean | undefined;
  let focusReason: string | undefined;
  const titleMarker = `[pi:${process.pid}:${randomUUID().slice(0, 8)}]`;
  let discovering = false;
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let workers: WorkerSummary[] = [];
  let stopWorkers: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pendingPublish: ReturnType<typeof setTimeout> | undefined;
  let overlay: SessionsOverlay | undefined;
  let overlayOpen = false;
  let closeOverlay: (() => void) | undefined;
  // Latest topic-outline snapshot from this process's outline extension.
  // Strictly optional: everything renders without it.
  let outlineCache: PresenceOutline | undefined;
  let busy = false;
  let waiting = false;
  let failed = false;
  let errorText: string | undefined;
  let preview = "No assistant response yet.";
  let previewAt: number | undefined;
  // Pi's ExtensionAPI has no synchronous model getter (pi.getModel does not
  // exist at runtime): track it from the session context and model_select.
  let modelName = "unknown";
  // Legacy v1 fields: free-text status and its change time.
  let status = "Idle";
  let since = Date.now();
  let completed = 0;
  // v2 activity: coarse state and its change time.
  let state: SessionState = "idle";
  let stateSince = Date.now();
  let turns = 0;
  let lastAssistantAt: number | undefined;
  let lastToolAt: number | undefined;
  let lastPromptAt: number | undefined;
  let rosterVersion = 0;
  const tools = new Map<string, { name: string; detail?: string }>();
  // Ring of tool completions per BUCKET_MS; the last slot is bucket index `bucketAt`.
  let buckets: number[] = Array(BUCKETS).fill(0);
  let bucketAt = Math.floor(Date.now() / BUCKET_MS);

  function realign(index: number) {
    if (index <= bucketAt) return;
    const shift = index - bucketAt;
    buckets = shift >= BUCKETS ? Array(BUCKETS).fill(0) : [...buckets.slice(shift), ...Array(shift).fill(0)];
    bucketAt = index;
  }
  function countTool(at: number) {
    const index = Math.floor(at / BUCKET_MS);
    realign(index);
    const slot = BUCKETS - 1 - (bucketAt - index);
    if (slot >= 0) buckets[slot]++;
  }

  async function discover() {
    // Focus targets only matter to peers, and peers only see us via the bus.
    if (!live || ctx?.mode !== "tui" || discovering || !channel?.snapshot().connected) return;
    discovering = true;
    const title = `π · ${clean(pi.getSessionName() ?? ctx.cwd.split("/").pop() ?? "session", 80).replace(/\n/g, " ")} ${titleMarker}`;
    ctx.ui.setTitle(title);
    try {
      // Give Ghostty/Hyprland time to receive OSC 2 before querying clients.
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!live) return;
      const result = await discoverFocusTarget(title);
      if (live) {
        target = result; focusable = !!result;
        focusReason = result ? undefined : "no focus target discovered";
      }
    } catch (error) {
      if (live) {
        target = undefined; focusable = false;
        focusReason = clean(error instanceof Error ? error.message : String(error), 120);
      }
    }
    finally { discovering = false; if (live) publish(); }
  }
  function scheduleDiscover(delay: number) {
    if (discoveryTimer) clearTimeout(discoveryTimer);
    discoveryTimer = setTimeout(() => { discoveryTimer = undefined; void discover(); }, delay);
    discoveryTimer.unref();
  }
  const selfId = () => [...store.peers.values()].find(p => p.pid === process.pid)?.id;
  function connectionLabel() {
    return store.connected || channel?.snapshot().connected
      ? "Live · local presence · Alt+S sessions · Alt+Shift+S previous"
      : "Local presence starting…";
  }
  function render() {
    if (!live || !ctx) return;
    const views = store.views();
    overlay?.update(views, connectionLabel());
    if (ctx.mode !== "tui") return;
    if (!store.connected) { ctx.ui.setStatus("sessions", "Sessions: disconnected"); return; }
    const count = (group: string) => views.filter(v => v.group === group).length;
    const parts: Array<[string, number]> = [
      ["busy", count("working")], ["input", count("needs-input")],
      ["unseen", views.filter(v => v.unseen).length],
    ];
    const labels = parts.filter(([, n]) => n).map(([label, n]) => `${n} ${label}`);
    const liveCount = views.length - count("unreachable");
    ctx.ui.setStatus("sessions", `Sessions: ${[`${liveCount} live`, ...labels].join(" · ")}`);
  }
  function meta(): Omit<SessionMeta, "id" | "endpointEpoch"> {
    const c = ctx!;
    const optional = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
    const sessionId = optional(() => c.sessionManager.getSessionId?.());
    const sessionFile = optional(() => c.sessionManager.getSessionFile?.());
    const host = optional(() => clean(hostname(), 64));
    return {
      name: clean(pi.getSessionName() ?? c.cwd.split("/").filter(Boolean).pop() ?? "session", 80),
      cwd: c.cwd,
      model: modelName,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status,
      ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
      ...(typeof sessionFile === "string" && sessionFile ? { sessionFile } : {}),
      ...((SESSION_MODES as readonly unknown[]).includes(c.mode) ? { mode: c.mode as SessionMeta["mode"] } : {}),
      ...(host ? { host } : {}),
    };
  }
  function snapshot(): Presence {
    const now = Date.now();
    realign(Math.floor(now / BUCKET_MS));
    const names = [...new Set([...tools.values()].map(t => t.name))].slice(0, 6);
    const detail = [...tools.values()].reverse().find(t => t.detail)?.detail;
    const activity: Activity = { state, since: stateSince, turns, buckets: [...buckets], bucketMs: BUCKET_MS,
      ...(names.length ? { tools: names } : {}), ...(detail ? { toolDetail: detail } : {}),
      ...(state === "error" && errorText ? { error: errorText } : {}),
      ...(lastAssistantAt ? { lastAssistantAt } : {}), ...(lastToolAt ? { lastToolAt } : {}),
      ...(lastPromptAt ? { lastPromptAt } : {}) };
    const value: Presence = { type: "presence", version: 1, status, since, completed,
      preview: clean(preview, 2000), outline: outlineCache ? structuredClone(outlineCache) : undefined, target,
      workers: workers.slice(0, 40).map(w => ({
        id: clean(w.id, 100), name: clean(w.name, 80), status: clean(w.status, 40),
        model: w.model ? clean(w.model, 80) : undefined, preview: w.preview ? clean(w.preview, 180) : undefined,
        backend: w.backend ? clean(w.backend, 32) : undefined,
        sessionFile: w.sessionFile ? clean(w.sessionFile, WORKER_SESSION_FILE_MAX) : undefined,
        sessionId: w.sessionId ? clean(w.sessionId, WORKER_SESSION_ID_MAX) : undefined,
        startedAt: w.startedAt, lastActivity: w.lastActivity, endedAt: w.endedAt, outcome: w.outcome,
      })),
      activity, workerCounts: countWorkers(workers), previewAt, focusable, focusReason };
    // Presence files are re-read by every peer every couple of seconds, so keep
    // the whole record bounded in UTF-8 bytes. The channel re-fits the exact
    // record it writes; fitting here too keeps the local view identical.
    if (ctx) fit({ v: 1, schemaVersion: SCHEMA_VERSION, heartbeat: now, presence: value,
      session: { ...meta(), id: selfId() ?? `p${process.pid}-00000000`, endpointEpoch: EPOCH_PLACEHOLDER } }, config.budgetBytes);
    return value;
  }
  function publish() {
    if (!live) return;
    // Also called from a bare setInterval: a presence bug must never crash pi.
    try {
      const value = snapshot();
      const id = selfId();
      if (id) store.receive(id, value);
      if (channel?.snapshot().connected && channel.snapshot().supported) {
        try { channel.publish(value, { audience: "capable" }); } catch { /* reconnect heartbeat retries */ }
      }
      render();
    } catch { /* presence is best-effort */ }
  }
  function schedule() {
    if (!live || pendingPublish) return;
    pendingPublish = setTimeout(() => { pendingPublish = undefined; publish(); }, 150);
    pendingPublish.unref();
  }
  function activity() {
    const next = waiting ? "Needs input" : busy ? tools.size
      ? `Running: ${[...new Set([...tools.values()].map(t => t.name))].join(", ")}` : "Running" : failed ? "Error" : "Idle";
    if (next !== status) { status = next; since = Date.now(); }
    const nextState: SessionState = waiting ? "needs-input" : busy ? "working" : failed ? "error" : "idle";
    if (nextState !== state) { state = nextState; stateSince = Date.now(); }
    schedule();
  }
  async function refreshRoster() {
    if (!live || !channel?.snapshot().connected) return false;
    const version = ++rosterVersion;
    try {
      const peers = await channel.listSessions();
      if (!live || version !== rosterVersion || !channel.snapshot().connected) return false;
      store.connected = true;
      store.roster(peers);
      publish();
      return true;
    } catch { return false; /* Don't incorrectly mark idle on a failed roster request. */ }
  }
  function onChannelEvent(event: IntercomExtensionEvent) {
    if (!live) return;
    if (event.type === "connection") {
      if (!event.connected) { rosterVersion++; store.disconnect(); render(); }
      else { void refreshRoster(); publish(); }
    } else if (event.type === "session_joined" || event.type === "presence_update") {
      rosterVersion++; // A queued older list must not overwrite this live event.
      store.upsert(event.session, { legacy: event.legacy }); render();
      if (event.type === "session_joined") schedule();
    } else if (event.type === "session_left") {
      rosterVersion++;
      store.remove(event.sessionId); render();
    } else if (event.type === "message") {
      const payload = event.payload as { type?: string; to?: string; from?: string } | null;
      if (payload?.type === "hello") schedule();
      else if (payload?.type === "visited" && payload.to === selfId()) {
        // A focus action happened elsewhere; enable the target's back shortcut.
        if (store.peers.has(event.fromSessionId)) store.pushRecent(event.fromSessionId);
        const id = selfId(); if (id) store.markSeen(id);
      } else { store.receive(event.fromSessionId, event.payload, Date.now(), event.heartbeat); render(); }
    }
  }
  function register() {
    if (!live || channel || !ctx) return;
    channel = createChannel({ onEvent: onChannelEvent, info: meta, budgetBytes: config.budgetBytes });
    void refreshRoster();
    // Ask the outline extension to rebroadcast its latest snapshot.
    try { pi.events.emit(OUTLINE_REQUEST, {}); } catch { /* outline extension may be absent */ }
  }
  const unsubscribeOutline = pi.events.on(OUTLINE_SNAPSHOT, value => {
    // parseOutline bounds and cleans; anything malformed is dropped, presence untouched.
    outlineCache = parseOutline(value);
    schedule();
  });

  async function focus(id: string) {
    if (!ctx || !live) return;
    if (id === selfId()) { store.markSeen(id); render(); return; }
    // Refresh membership first: never resume JSONL or focus a dead endpoint.
    if (!await refreshRoster()) throw new Error("Could not read the live session registry yet. Try again in a moment.");
    const presence = store.fresh(id);
    const peerTarget = presence && checkFocusable(presence).ok ? presence.target : undefined;
    if (!peerTarget) throw new Error("No safe focus target. Reload that session; headless or ambiguous terminal sessions are preview-only.");
    if (peerTarget.origin?.pid !== store.peers.get(id)?.pid) throw new Error("Focus target does not match the live session process.");
    await focusTarget(peerTarget);
    if (!live) return;
    store.pushRecent(id);
    store.markSeen(id);
    try { channel?.publish({ type: "visited", to: id, from: selfId() }, { audience: "capable" }); } catch { /* cosmetic only */ }
    render();
  }
  async function open(context: ExtensionContext, query = "") {
    if (context.mode !== "tui" || overlayOpen) return;
    overlayOpen = true;
    try {
      // Do not block opening on directory I/O; the overlay updates in-place.
      void refreshRoster();
      const id = await context.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        closeOverlay = () => done(undefined);
        overlay = new SessionsOverlay(theme, () => tui.requestRender(), () => tui.terminal.rows - 2, done, _keys, {
          onMarkAllSeen: () => { for (const view of store.views()) if (view.unseen) store.markSeen(view.id); render(); },
        });
        if (query.trim()) overlay.setQuery?.(query.trim());
        overlay.update(store.views(), connectionLabel());
        return overlay;
      }, { overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", minWidth: 40, anchor: "center", margin: 1 } });
      overlay = undefined;
      closeOverlay = undefined;
      if (id && live) await focus(id);
    } catch (error) {
      if (live) context.ui.notify(`Sessions: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally { overlayOpen = false; overlay = undefined; closeOverlay = undefined; }
  }
  async function back(context: ExtensionContext) {
    const previous = store.nextRecent(selfId());
    if (!previous) { context.ui.notify("No previous session yet. Switch using /sessions first.", "info"); return; }
    try { await focus(previous); }
    catch (error) { context.ui.notify(`Sessions: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  }
  pi.registerCommand("sessions", { description: "Live sessions, worker status, previews and terminal switching", handler: (args, context) => open(context, typeof args === "string" ? args : "") });
  pi.registerCommand("sessions-back", { description: "Focus the previous live session", handler: (_args, context) => back(context) });
  pi.registerShortcut("alt+s", { description: "Open live session switcher", handler: context => open(context) });
  pi.registerShortcut("alt+shift+s", { description: "Focus previous live session", handler: back });

  pi.on("session_start", async (_event, context) => {
    ctx = context; live = true; config = loadConfig(deps.configPath);
    modelName = context.model?.id ?? "unknown";
    busy = !context.isIdle(); activity();
    // Latest response is enough for a bounded preview; never broadcast prompts,
    // thinking text, full tool output, or an entire conversation.
    for (const entry of [...context.sessionManager.getBranch()].reverse()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const text = entry.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        if (text) {
          preview = clean(text);
          const at = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
          if (Number.isFinite(at)) previewAt = at;
          break;
        }
      }
    }
    stopWorkers = subscribeWorkers(pi, next => {
      const active = new Set(workers.filter(w => /^(running|starting|busy|working)$/i.test(w.status)).map(w => w.id));
      if (next.some(w => active.has(w.id) && !/^(running|starting|busy|working)$/i.test(w.status))) completed = Date.now();
      workers = next; schedule();
    });
    register();
    heartbeat = setInterval(() => {
      if (!channel) return;
      try {
        void refreshRoster(); void discover(); publish();
      } catch { /* presence is best-effort; never crash the host */ }
    }, 5000);
    heartbeat.unref();
    // Pi restores its own title after session_start; apply ours after binding.
    scheduleDiscover(500);
  });
  pi.on("session_shutdown", () => {
    live = false; rosterVersion++;
    if (heartbeat) clearInterval(heartbeat);
    if (discoveryTimer) clearTimeout(discoveryTimer);
    if (pendingPublish) clearTimeout(pendingPublish);
    stopWorkers?.(); unsubscribeOutline(); closeOverlay?.();
    channel?.close();
    outlineCache = undefined;
    ctx?.ui.setStatus("sessions", undefined);
    ctx = undefined; channel = undefined;
  });
  pi.on("session_info_changed", () => {
    // Renames propagate to peers and to the title marker quickly.
    schedule(); if (live) scheduleDiscover(300);
  });
  pi.on("model_select", event => { modelName = event.model?.id ?? modelName; schedule(); });
  pi.on("agent_start", () => { busy = true; failed = false; errorText = undefined; tools.clear(); activity(); });
  pi.on("agent_settled", () => { busy = false; tools.clear(); completed = Date.now(); turns++; activity(); });
  pi.on("tool_execution_start", event => {
    lastToolAt = Date.now();
    tools.set(event.toolCallId, { name: event.toolName, detail: toolDetail(event.toolName, event.args) });
    activity();
  });
  pi.on("tool_execution_end", event => { tools.delete(event.toolCallId); countTool(Date.now()); activity(); });
  pi.on("ui_prompt_start", event => {
    if (!(overlayOpen && event.kind === "custom")) { waiting = true; lastPromptAt = Date.now(); activity(); }
  });
  pi.on("ui_prompt_end", () => { if (waiting) { waiting = false; activity(); } });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    lastAssistantAt = Date.now();
    const text = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (text) { preview = clean(text); previewAt = lastAssistantAt; }
    failed = event.message.stopReason === "error";
    errorText = failed ? clean(event.message.errorMessage || "error", 200) : undefined;
    if (failed && event.message.errorMessage) { preview = clean(event.message.errorMessage); previewAt = lastAssistantAt; }
    // Like the v1 status, the error state surfaces at the next transition (usually agent_settled).
    schedule();
  });
}
