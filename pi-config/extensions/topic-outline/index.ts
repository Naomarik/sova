/**
 * topic-outline — live topical outline of the current conversation.
 *
 * NOT compaction: the outline is display-only. It never touches what the model
 * sees; it maintains topic headings (markdown-style) with short summaries of
 * what the agent did, and jumps the fullscreen transcript to a topic's original
 * message when selected.
 *
 * Summaries are produced by a configurable chain (see ~/.pi/agent/topic-outline.json):
 * Claude Code CLI (haiku) → Pi model registry fallback (ollama-cloud/deepseek-v4.1-flash).
 * Every layer degrades gracefully: missing models, limits, and failures leave the
 * last good outline in place, marked stale, and never block the session.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { locateMarker, markerOrdinalIndex, sameFingerprint, textOf } from "./anchors.ts";
import { loadConfig, DEFAULT_CONFIG } from "./config.ts";
import { SummarizerChain } from "./summarizers/chain.ts";
import { createClaudeCliSummarizer } from "./summarizers/claude-cli.ts";
import { createPiModelSummarizer } from "./summarizers/pi-model.ts";
import {
  CUSTOM_TYPE,
  NowLine,
  OutlineStore,
  existingOutlineJson,
  extractDelta,
  lastMessageEntryId,
  type DeltaMessage,
} from "./state.ts";
import { OutlinePanel, PeekPanel, type PanelResult } from "./ui.ts";
import type { Anchor, OutlineConfig, Summarizer } from "./types.ts";

const STATUS_KEY = "topic-outline";
const EVENT_SNAPSHOT = "topic-outline:snapshot";
const EVENT_REQUEST = "topic-outline:request";

interface JumpAttempt {
  heading: string;
  asFullscreen: boolean;
  ordinalFound: boolean;
  rowsCount?: number;
  markers?: number;
  fingerprintMatched?: boolean;
  row?: number;
  reason: string;
}

/** Opt-in (PI_TOPIC_OUTLINE_DEBUG=1) jump diagnostics; never includes message text. */
function logJump(attempt: JumpAttempt): void {
  if (process.env.PI_TOPIC_OUTLINE_DEBUG !== "1") return;
  try { appendFileSync(join(homedir(), ".pi", "agent", "topic-outline-debug.log"), `${JSON.stringify({ at: new Date().toISOString(), ...attempt })}\n`); }
  catch { /* diagnostics are best-effort */ }
}

/** Minimal capability view of pi's fullscreen renderer (undocumented; always guarded). */
interface FullscreenTui {
  mode: string;
  terminal: { columns: number; rows: number };
  scrollBy(lines: number): void;
  scrollToTop(): void;
  flash(message: string, durationMs?: number): void;
  requestRender(): void;
}

/** Pi-tui ScrollView surface used to read the full transcript (undocumented; always guarded). */
interface TranscriptView {
  primary?: boolean;
  render(width: number): string[];
}

/**
 * Full transcript rows in the primary ScrollView's coordinates — the same rows
 * scrollToTop/scrollBy move through. tui.render() can't be used: the fullscreen
 * VStack sizes the transcript to its basis (one row) outside a real layout pass.
 */
function transcriptLines(tui: FullscreenTui): string[] | undefined {
  const getView = (tui as { getPrimaryScrollView?: () => unknown }).getPrimaryScrollView;
  if (typeof getView !== "function") return undefined;
  const view = getView.call(tui) as Partial<TranscriptView> | undefined;
  if (!view || view.primary !== true || typeof view.render !== "function") return undefined;
  const lines = view.render(tui.terminal.columns);
  return Array.isArray(lines) ? lines : undefined;
}

function asFullscreen(tui: unknown): FullscreenTui | undefined {
  const value = tui as Partial<FullscreenTui> | undefined;
  if (!value || value.mode !== "fullscreen") return undefined;
  if (typeof value.scrollBy !== "function" ||
      typeof value.scrollToTop !== "function" || typeof value.flash !== "function") return undefined;
  if (!value.terminal || typeof value.terminal.columns !== "number") return undefined;
  return value as FullscreenTui;
}

interface SessionRuntime {
  ctx: ExtensionContext;
  config: OutlineConfig;
  store: OutlineStore;
  chain: SummarizerChain | undefined;
}

export default function topicOutline(pi: ExtensionAPI): void {
  let runtime: SessionRuntime | undefined;
  const nowLine = new NowLine();
  let ownPromptOpen = false;
  let panelOpen = false;
  let pendingRefresh = false;
  let liveTui: unknown;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runActive: AbortController | undefined;
  let runQueued = false;

  function updateStatus(rebuild = false): void {
    const ctx = runtime?.ctx;
    if (!ctx || !ctx.hasUI) return;
    let text = nowLine.text();
    if (runtime) {
      const store = runtime.store;
      const suffix = store.state === "failed-keeping-last" ? " · outline err"
        : store.state === "drafting" || store.state === "updating" ? " · outlining…"
        : "";
      text += suffix;
    }
    ctx.ui.setStatus(STATUS_KEY, text);
    if (rebuild && panelOpen) {
      const tui = liveTui as { requestRender?: () => void } | undefined;
      tui?.requestRender?.();
    }
  }

  function broadcast(): void {
    if (!runtime) return;
    const value = runtime.store.broadcast(runtime.ctx.sessionManager.getSessionId(), runtime.config.shareWithSessions, runtime.config.shareLastHeading);
    if (value) pi.events.emit(EVENT_SNAPSHOT, value);
  }

  function buildChain(ctx: ExtensionContext, config: OutlineConfig): SummarizerChain {
    const backends: Summarizer[] = [];
    for (const spec of config.summarizers) {
      if (spec.backend === "claude-code") backends.push(createClaudeCliSummarizer(spec, config.claudeBin));
      else backends.push(createPiModelSummarizer(spec, ctx));
    }
    return new SummarizerChain(backends);
  }

  /** Find an anchor's marker ordinal in the current context view, plus the number of marked messages. */
  function ordinalFor(ctx: ExtensionContext, anchor: Anchor): { ordinal: number; fingerprint: string; marked: number } | undefined {
    const entries = ctx.sessionManager.buildContextEntries();
    const index = markerOrdinalIndex(entries);
    const marked = index.size;
    const direct = index.get(anchor.entryId);
    if (direct) return { ...direct, marked };
    // Compaction copies kept messages under new ids; match by role + fingerprint instead.
    if (anchor.fingerprint) {
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const message = entry.message as { role?: string; content?: unknown } | undefined;
        if (!message || message.role !== anchor.role) continue;
        const row = index.get(entry.id);
        if (row && sameFingerprint(anchor.fingerprint, row.fingerprint)) return { ...row, marked };
      }
    }
    return undefined;
  }

  function peekBody(ctx: ExtensionContext, anchor: Anchor): string {
    const entries = ctx.sessionManager.getEntries();
    const entry = entries.find(item => item.id === anchor.entryId);
    const message = entry && entry.type === "message" ? entry.message : undefined;
    const text = message ? textOf(message) : "";
    if (text.trim()) return text;
    return "(the original message is no longer available — it may have been compacted or lives on another branch)";
  }

  async function showPeek(heading: string, body: () => string): Promise<void> {
    const ctx = runtime?.ctx;
    if (!ctx || ctx.mode !== "tui") return;
    try {
      await ctx.ui.custom<undefined>((tui, theme, _keys, done) => {
        ownPromptOpen = true;
        return new PeekPanel(theme, heading, body, () => tui.terminal.rows - 6, () => done(undefined));
      }, { overlay: true, overlayOptions: { anchor: "center", width: "70%", margin: 2 } });
    } catch { /* peek is best-effort */ }
    finally { ownPromptOpen = false; }
  }

  /** Scroll the fullscreen transcript to an anchor. Returns false to fall back to peek. */
  function jumpToAnchor(anchor: Anchor, heading: string): boolean {
    const attempt: JumpAttempt = { heading, asFullscreen: false, ordinalFound: false, reason: "" };
    const finish = (reason: string, ok = false) => { attempt.reason = reason; logJump(attempt); return ok; };
    const rt = runtime;
    if (!rt) return finish("no-runtime");
    const tui = asFullscreen(liveTui);
    if (!tui) return finish("not-fullscreen");
    attempt.asFullscreen = true;
    try {
      const located = ordinalFor(rt.ctx, anchor);
      if (!located) return finish("anchor-not-in-context");
      attempt.ordinalFound = true;
      const lines = transcriptLines(tui);
      if (!lines) return finish("no-transcript-view");
      attempt.rowsCount = lines.length;
      const found = locateMarker(lines, located.ordinal, located.fingerprint, located.marked);
      attempt.markers = found.markers;
      attempt.fingerprintMatched = found.fingerprintMatched;
      if (found.row === undefined) return finish(found.markers ? "marker-not-found" : "no-markers");
      attempt.row = found.row;
      // Two rows of context above the message; scrollBy clamps at the transcript end.
      tui.scrollToTop();
      tui.scrollBy(Math.max(0, found.row - 2));
      tui.flash(`§ ${heading}`, 1500);
      return finish(found.fingerprintMatched ? "ok" : "ok-ordinal-only", true);
    } catch (error) {
      // Undocumented path; never let it break the panel.
      return finish(`error:${error instanceof Error ? error.name : "unknown"}`);
    }
  }

  async function runSummarizer(force: boolean): Promise<void> {
    const rt = runtime;
    if (!rt || !rt.chain) return;
    if (runActive) { runQueued = true; return; }
    const entries = rt.ctx.sessionManager.buildContextEntries();
    const delta = extractDelta(entries, rt.store.basisLeafId);

    // `#`-headed user messages always become topics instantly, no model call.
    let manualFound = false;
    for (const message of delta) {
      if (message.role !== "user" || !message.anchor) continue;
      const text = message.line.replace(/^\[m\d+\] USER: /, "");
      const match = /^#{1,3}\s+(.{2,80})/.exec(text);
      if (!match) continue;
      const heading = match[1].replace(/#+\s*$/, "").trim();
      if (!heading) continue;
      if (rt.store.topics.some(topic => topic.heading.toLowerCase() === heading.toLowerCase())) {
        if (rt.store.lastManualHeading !== heading) { rt.store.noteManualHeading(heading); manualFound = true; }
        continue;
      }
      rt.store.addManualTopic(heading, message.anchor);
      manualFound = true;
    }
    if (manualFound) {
      persistSnapshot();
      updateStatus(true);
      broadcast();
    }

    if (!force && delta.length < rt.config.trigger.minNewMessages) {
      updateStatus(true);
      return;
    }
    if (!delta.length) { updateStatus(true); return; }

    const validRefs = new Set(delta.map(message => message.ref));
    const anchors = new Map<string, Anchor>();
    for (const message of delta) if (message.anchor) anchors.set(message.ref, message.anchor);
    const basisLeafId = lastMessageEntryId(entries);
    const leafBefore = rt.ctx.sessionManager.getLeafId();
    const hadContent = rt.store.topics.length > 0 || rt.store.now;

    runActive = new AbortController();
    rt.store.state = hadContent ? "updating" : "drafting";
    updateStatus(true);
    try {
      const { result } = await rt.chain.run({
        existingOutline: existingOutlineJson(rt.store.topics),
        newLines: delta.map(message => message.line),
        validRefs,
        signal: runActive.signal,
      });
      // The branch may have moved (tree navigation / compaction) while the model ran.
      if (runtime === rt && rt.ctx.sessionManager.getLeafId() === leafBefore) {
        rt.store.apply(result, anchors, basisLeafId, rt.config.limits);
        persistSnapshot();
        broadcast();
      }
    } catch {
      if (runtime === rt) {
        rt.store.markStale();
        if (hadContent) rt.store.state = "failed-keeping-last";
      }
    } finally {
      runActive = undefined;
      if (runtime === rt) updateStatus(true);
    }
    if (runQueued || pendingRefresh) {
      runQueued = false;
      return runSummarizer(pendingRefresh);
    }
  }

  function scheduleRun(force = false): void {
    // Summaries exist for the terminal UI; print/json/rpc sessions never trigger runs.
    if (runtime?.ctx.mode !== "tui") return;
    if (force) pendingRefresh = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    const delay = runtime?.config.trigger.debounceMs ?? DEFAULT_CONFIG.trigger.debounceMs;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const forceNext = pendingRefresh;
      pendingRefresh = false;
      void runSummarizer(forceNext);
    }, delay);
    debounceTimer.unref?.();
  }

  function persistSnapshot(): void {
    const rt = runtime;
    if (!rt) return;
    try {
      if (!rt.ctx.sessionManager.getSessionFile()) return; // ephemeral session: keep in memory only
      pi.appendEntry(CUSTOM_TYPE, rt.store.snapshot());
    } catch { /* persistence is best-effort; the outline still works in-memory */ }
  }

  async function openPanel(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || panelOpen) return;
    panelOpen = true;
    const rt = runtime;
    updateStatus();
    try {
      const result = await ctx.ui.custom<PanelResult | undefined>((tui, theme, _keys, done) => {
        ownPromptOpen = true;
        liveTui = tui;
        return new OutlinePanel(theme, {
          nowInstant: () => nowLine.text(),
          nowModel: () => runtime?.store.now ?? "",
          overall: () => runtime?.store.overall ?? "",
          state: () => runtime?.store.state ?? "none",
          generatedAt: () => runtime?.store.generatedAt ?? 0,
          topics: () => runtime?.store.topics ?? [],
          chainStatus: () => rt?.chain?.summarizeStatus() ?? "",
        }, () => (tui as { requestRender?: () => void }).requestRender?.(), () => tui.terminal.rows - 4, done);
      }, { overlay: true, overlayOptions: { anchor: "top-right", width: "45%", margin: 1 } });

      if (!result) return;
      if (result.refresh) {
        // Reopen after the refresh attempt; failures surface in the status line state.
        void runSummarizer(true).then(() => { if (runtime?.ctx === ctx) void openPanel(ctx); });
        return;
      }
      if (result.jump) {
        const topic = runtime?.store.topics.find(item => item.id === result.jump?.topicId);
        if (!topic) return;
        if (!jumpToAnchor(topic.anchor, topic.heading)) {
          void showPeek(topic.heading, () => peekBody(ctx, topic.anchor));
        }
      }
    } catch {
      // The overlay must never take the session down with it.
    } finally {
      panelOpen = false;
      ownPromptOpen = false;
    }
  }

  function handleCommand(args: string, ctx: ExtensionContext): Promise<void> | void {
    const sub = args.trim().split(/\s+/)[0] ?? "";
    if (sub === "rebuild" || sub === "refresh") {
      scheduleRun(true);
      if (ctx.hasUI) ctx.ui.notify("Outline: summary refresh queued", "info");
      return;
    }
    if (sub === "status") {
      const store = runtime?.store;
      const info = store
        ? `state=${store.state} topics=${store.topics.length} now="${store.now}" overall="${store.overall}" generated=${new Date(store.generatedAt).toLocaleTimeString()} ${runtime?.chain?.summarizeStatus() ?? ""}`
        : "no active runtime";
      if (ctx.hasUI) ctx.ui.notify(`Outline: ${info}`, "info");
      return;
    }
    return openPanel(ctx);
  }

  pi.registerCommand("outline", { description: "Conversation topic outline (jump to topics in the transcript)", handler: handleCommand });
  pi.registerShortcut("alt+o", { description: "Open topic outline panel", handler: ctx => openPanel(ctx) });

  // Registered once at module level; broadcast() is a no-op without a runtime.
  pi.events.on(EVENT_REQUEST, () => broadcast());

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const store = new OutlineStore();
    store.restore(ctx.sessionManager.getBranch());
    runtime = { ctx, config, store, chain: buildChain(ctx, config) };
    nowLine.agentSettled();
    updateStatus();
    broadcast();
  });

  pi.on("session_shutdown", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    runActive?.abort("session shutdown");
    try { runtime?.ctx.ui.setStatus(STATUS_KEY, undefined); } catch { /* shutting down */ }
    runtime = undefined;
    panelOpen = false;
    liveTui = undefined;
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!runtime) return;
    runtime.store.restore(ctx.sessionManager.getBranch());
    broadcast();
    updateStatus(true);
  });

  // --- Free now-line event wiring (no model involved) ---
  pi.on("agent_start", () => { nowLine.agentStart(); updateStatus(); });
  pi.on("agent_settled", () => {
    nowLine.agentSettled();
    updateStatus();
    scheduleRun(false);
  });
  pi.on("tool_execution_start", event => {
    nowLine.toolStart(event.toolCallId, event.toolName, event.args as Record<string, unknown> | undefined);
    updateStatus();
  });
  pi.on("tool_execution_end", event => { nowLine.toolEnd(event.toolCallId); updateStatus(); });
  pi.on("ui_prompt_start", event => { nowLine.promptStart(ownPromptOpen && event.kind === "custom"); updateStatus(); });
  pi.on("ui_prompt_end", () => { nowLine.promptEnd(); updateStatus(); });
  pi.on("message_end", event => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role === "assistant" && message.stopReason === "error") nowLine.errored(message.errorMessage);
    updateStatus();
  });
}
