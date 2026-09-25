import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  OVERSEER_BRIEF_PREFIX,
  OVERSEER_ENTRY,
  type AttentionDigest,
  type AttentionItem,
  type OverseerInfo,
  type OverseerSaveResult,
  type OverseerSettings,
  type OverseerSettingsInfo,
} from "../shared/protocol";
import { setArchived } from "./archived-sessions";
import { type AttentionRow, blockerKey, buildDigest, workerErrorTime } from "./attention";
import {
  acquireChat,
  BusyError,
  disposeHeldChat,
  drainQueueThenAbort,
  getModelRuntime,
  heldChat,
  isSessionBusy,
  setOverseerRuntime,
} from "./chat-manager";
import { activityOf, failedWorkersOf, readLiveRecords, workerErrorTimesOf, workingSubagents } from "./live";
import { listModels, contextWindow } from "./models";
import { modelDenial, readModelPolicy } from "./model-policy";
import { mergeMode } from "./mode-state";
import {
  DEFAULT_CAPS,
  DEFAULT_EXPLORER,
  DEFAULT_QUICK_ACTIONS,
  overseerDir,
  overseerSettingsFile,
  parseSettings,
  patchOverseerSettings,
  readNotes,
  readOverseerSettings,
  readOverseerState,
  rotateState,
  writeOverseerSettings,
  writeOverseerState,
  overseerTurnFile,
} from "./overseer-store";
import { promptToc, readManifest } from "./overseer-ideas";
import type { SubagentTool } from "./overseer-idea-tools";
import { workerDenial } from "./delegate";
import { BUILTIN_ALLOWED, overseerTools, type OverseerToolHost, TurnLimits, UserTurns } from "./overseer-tools";
import { overseerFileTools } from "./overseer-file-tools";
import { type Redactor, redactExtensionMessages, serverRedactor } from "./overseer-redact";
import { canonicalPath, resolveSessionPath } from "./paths";
import { isViewing, markSeen, readSeen } from "./seen";
import { cleanupSessions, getSessionSummary, idOf, indexedSessionPaths, lastReplyAtOf, listSessionFiles, listSessions } from "./sessions-index";
import { getSessionInsight } from "./insights";
import { normalizeEntries, readActiveBranch } from "./transcript";
import { markOwned } from "./write-guard";

/**
 * The Overseer: ONE special Sova session that watches every other session and acts on them
 * (.overseer-design/DECISIONS.md). It is an ordinary webapp-owned pi session hosted here, with
 * four differences: a `sova-overseer` marker entry in its file, a fixed cwd `<stateRoot>/overseer/`,
 * a runtime loadout (its prompt, its sova_* tools, a tool allowlist, its own model), and an
 * identity that is not the file: `overseer-state.json` points at the current file, and /clear
 * rotates it. Settings, standing notes and the action log never key on the session id, so they
 * survive a clear.
 */

const PROMPT_FILE = fileURLToPath(new URL("./overseer-prompt.md", import.meta.url));

let dispatch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;

/** The header the Overseer's in-process tool calls carry, and its value: a secret made at server
    start, held only in memory, never written or sent to a client. A prompt carrying it is tagged
    as the Overseer's; any HTTP client can send the header, but not the value. */
export const OVERSEER_SENDER_HEADER = "x-sova-overseer";
const SENDER_SECRET = randomBytes(32).toString("hex");

/** The current Overseer's id when `header` is the sender secret (a tool call of its own), else undefined. */
export function overseerSender(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const got = Buffer.from(header);
  const want = Buffer.from(SENDER_SECRET);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  return readOverseerState()?.current || undefined;
}

/** index.ts hands over Hono's in-process dispatch at startup, so the tools call the same routes
    the browser does and this module never imports the app (the dependency points one way). */
export function setOverseerDispatch(fn: (path: string, init?: RequestInit) => Response | Promise<Response>): void {
  dispatch = async (path, init) => fn(path, init);
}

// ---- files ---------------------------------------------------------------------------------------

/** Whether the file carries the Overseer marker, from its first 16KB (the marker is line 2). */
export function hasOverseerMarker(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes(OVERSEER_ENTRY)) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type === "custom" && e.customType === OVERSEER_ENTRY) return true;
      } catch {
        // torn line: keep looking
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/** Session id → path: the listing cache first, else one walk of the sessions dir. */
export async function pathOfId(id: string): Promise<string | null> {
  const known = indexedSessionPaths().get(id);
  if (known) return known;
  for (const p of await listSessionFiles()) if (idOf(p) === id) return p;
  return null;
}

/** A new, empty Overseer file: header + marker, written now (like every web session), ours. */
function createOverseerFile(): { id: string; path: string } {
  const dir = overseerDir();
  mkdirSync(dir, { recursive: true });
  const sm = SessionManager.create(dir);
  const raw = sm.getSessionFile();
  const header = sm.getHeader();
  if (!raw || !header) throw new Error("SessionManager did not produce a session file");
  // The marker rides the hand-written file, like the fanout member marker: appended to the manager
  // first, then [header, ...entries] is the whole file (SessionManager.create defers its own write).
  sm.appendCustomEntry(OVERSEER_ENTRY, { v: 1 });
  writeFileSync(raw, `${[JSON.stringify(header), ...sm.getEntries().map((e) => JSON.stringify(e))].join("\n")}\n`, { flag: "wx" });
  const path = canonicalPath(raw);
  markOwned(path);
  markSeen(header.id);
  return { id: header.id, path };
}

/** Delete history files that fell off the end (>20). Through the cleanup "paths" mode, so the same
    bookkeeping runs as for any deleted session; the archive mark is what that mode requires. */
async function dropHistory(ids: string[]): Promise<void> {
  const paths: string[] = [];
  for (const id of ids) {
    const p = await pathOfId(id);
    if (!p) continue;
    setArchived(id, true);
    paths.push(p);
  }
  if (paths.length) await cleanupSessions({ mode: "paths", paths, dryRun: false }).catch(() => {});
}

/** The Overseer should run in the normal mode: Delegate would route its work to workers and the spec
    minor mode would start writing claims. A brand-new file is switched once; later the user's
    switch in its composer stands. */
async function normalMode(path: string): Promise<void> {
  try {
    const chat = await acquireChat(path);
    const s = chat.modeState;
    if (s.mode !== "normal" || s.minorModes.length) await chat.applyMode(mergeMode(s, { mode: "normal", minorModes: [] }));
  } catch (err) {
    console.warn("[overseer] could not set the normal mode:", err instanceof Error ? err.message : String(err));
  }
}

let ensuring: Promise<{ id: string; path: string }> | null = null;

/** The current Overseer file, created when there is none (or its file is gone). Single-flight. */
export function ensureOverseer(): Promise<{ id: string; path: string }> {
  ensuring ??= (async () => {
    const st = readOverseerState();
    if (st) {
      const p = await pathOfId(st.current);
      if (p && hasOverseerMarker(p)) return { id: st.current, path: p };
    }
    const made = createOverseerFile();
    const { state, dropped } = rotateState(st, made.id);
    writeOverseerState(state);
    await dropHistory(dropped);
    await normalMode(made.path);
    return made;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/**
 * /clear: stop any running turn, close the runtime, start a new marked file and point `current` at
 * it. Never refuses. Other tabs on the old file get `reloaded` and re-resolve the route.
 */
export async function clearOverseer(): Promise<OverseerInfo> {
  const st = readOverseerState();
  const oldPath = st ? await pathOfId(st.current) : null;
  if (oldPath) {
    const chat = heldChat(oldPath);
    if (chat?.session.isStreaming) await drainQueueThenAbort(chat.session, (m) => chat.broadcast(m), chat.queue).catch(() => {});
    await disposeHeldChat(oldPath, "The Overseer was cleared. Opening the new conversation.");
  }
  limits.reset();
  turns.reset();
  const made = createOverseerFile();
  const { state, dropped } = rotateState(readOverseerState(), made.id);
  writeOverseerState(state);
  await dropHistory(dropped);
  await normalMode(made.path);
  digestMemo = null;
  return overseerInfo();
}

// ---- info, unread ------------------------------------------------------------------------------

/** Final replies (not tool-use steps) in the Overseer's file newer than `since`. Cached per mtime. */
let unreadMemo: { path: string; mtimeMs: number; since: number; count: number } | null = null;
async function unreadReplies(path: string, since: number | undefined): Promise<number> {
  if (since === undefined) return 0;
  const st = await stat(path).catch(() => null);
  if (!st) return 0;
  if (unreadMemo && unreadMemo.path === path && unreadMemo.mtimeMs === st.mtimeMs && unreadMemo.since === since) return unreadMemo.count;
  let count = 0;
  for (const e of await readActiveBranch(path)) {
    const m = e.type === "message" ? e.message : null;
    if (m?.role !== "assistant" || m.stopReason === "toolUse") continue;
    const t = typeof m.timestamp === "number" ? m.timestamp : Date.parse(e.timestamp ?? "");
    if (Number.isFinite(t) && t > since) count++;
  }
  unreadMemo = { path, mtimeMs: st.mtimeMs, since, count };
  return count;
}

export async function overseerInfo(): Promise<OverseerInfo> {
  const cur = await ensureOverseer();
  const st = readOverseerState();
  const history: OverseerInfo["history"] = [];
  for (const id of st?.history ?? []) {
    const p = await pathOfId(id);
    if (!p) continue;
    const s = await getSessionSummary(p);
    if (s) history.push({ id, path: p, title: s.title, lastActiveAt: s.lastActiveAt });
  }
  const digest = await attentionDigest();
  const seenAt = readSeen()[cur.id];
  return {
    path: cur.path,
    id: cur.id,
    history,
    badge: digest.badge,
    unread: isViewing(cur.id) ? 0 : await unreadReplies(cur.path, seenAt),
    proactivity: readOverseerSettings().proactivity,
    busy: isSessionBusy(cur.path),
  };
}

// ---- attention digest ----------------------------------------------------------------------------

const DIGEST_MS = 3000;

/** Per session: its failed-worker count as last seen here, and when it was first seen or last rose.
    Stands in for error times whose worker rows were dropped from the live record for size. */
const failedRise = new Map<string, { failed: number; at: number }>();
function noteFailedRise(path: string, failed: number, now: number): number {
  const prev = failedRise.get(path);
  const at = !prev || failed > prev.failed ? now : prev.at;
  failedRise.set(path, { failed, at });
  return at;
}
let digestMemo: { at: number; value: Promise<ReturnType<typeof buildDigest>> } | null = null;

/** The digest, memoised ~3s (the badge rides a poll). */
export function attentionDigest(): Promise<ReturnType<typeof buildDigest>> {
  const now = Date.now();
  if (digestMemo && now - digestMemo.at < DIGEST_MS) return digestMemo.value;
  const value = (async () => {
    const sessions = await listSessions();
    const records = readLiveRecords({ includeOwn: true });
    const byPath = new Map<string, { failed: number; since: number; errorTimes: number[] }>();
    for (const r of records) {
      if (!r.sessionFile) continue;
      const prev = byPath.get(r.sessionFile);
      const failed = failedWorkersOf(r.rec);
      const since = activityOf(r.rec)?.since ?? 0;
      byPath.set(r.sessionFile, {
        failed: Math.max(failed, prev?.failed ?? 0),
        since: Math.max(since, prev?.since ?? 0),
        errorTimes: [...(prev?.errorTimes ?? []), ...workerErrorTimesOf(r.rec)],
      });
    }
    const nowMs = Date.now();
    for (const p of [...failedRise.keys()]) if (!byPath.get(p)?.failed) failedRise.delete(p);
    const rows: AttentionRow[] = sessions.map((s) => {
      const chat = heldChat(s.path);
      const live = byPath.get(s.path);
      return {
        summary: s,
        dialogs: chat ? chat.pendingDialogs().map((d) => d.title || d.method) : [],
        queued: chat ? chat.queue.size : 0,
        failedWorkers: live?.failed ?? 0,
        workerErrorAt: live?.failed ? workerErrorTime(live.failed, live.errorTimes, noteFailedRise(s.path, live.failed, nowMs)) : undefined,
        viewing: isViewing(s.id),
        activitySince: live?.since ?? 0,
        lastReplyAt: lastReplyAtOf(s.path),
      };
    });
    return buildDigest(rows, Date.now(), homedir());
  })();
  digestMemo = { at: now, value };
  value.catch(() => {
    if (digestMemo?.value === value) digestMemo = null;
  });
  return value;
}

/** The digest as the wire has it (no badge). */
export async function attentionForWire(): Promise<AttentionDigest> {
  const { badge: _badge, ...digest } = await attentionDigest();
  return digest;
}

// ---- settings ----------------------------------------------------------------------------------

export function overseerSettingsInfo(): OverseerSettingsInfo {
  return {
    settings: readOverseerSettings(),
    defaults: { quickActions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })), caps: { ...DEFAULT_CAPS }, explorer: { ...DEFAULT_EXPLORER } },
    file: overseerSettingsFile(),
  };
}

/**
 * PUT /api/settings/overseer: strict parse, the model checked against the user's policy and the
 * models this server can use (a claude-code-cli model is saved with a warning when it isn't listed
 * yet: the provider may simply not be registered), then applied to the held Overseer at once when
 * it is idle, else at its next turn boundary.
 */
export async function saveOverseerSettings(body: unknown): Promise<OverseerSaveResult | { error: string }> {
  const parsed = parseSettings(body, true);
  if ("error" in parsed) return parsed;
  const warnings: string[] = [];
  if (parsed.model) {
    const denial = modelDenial(readModelPolicy(), parsed.model);
    if (denial) return { error: denial };
    const known = (await listModels().catch(() => [])).some((m) => m.ref === parsed.model);
    if (!known) {
      if (parsed.model.startsWith("claude-code-cli/")) warnings.push(`${parsed.model} is not listed right now, so it could not be verified.`);
      else return { error: `Unknown model, or no credentials configured: ${parsed.model}` };
    }
  }
  // The explorer is a subagent: the policy's subagent view decides whether it may run. Saved either
  // way (spawn enforces it), with the reason shown.
  const denied = workerDenial(readModelPolicy(), parsed.explorer.backend, parsed.explorer.model);
  if (denied) warnings.push(`Exploratory agent: ${denied}; explorers will be refused until it is allowed.`);
  writeOverseerSettings(parsed);
  pendingApply = true;
  await applySettingsNow();
  digestMemo = null;
  return { ...overseerSettingsInfo(), warnings };
}

let pendingApply = false;

/** Bring the held, idle Overseer to overseer.json's model and thinking. Leaves `pendingApply` set
    while it is mid-turn, so the next tick applies it at the turn boundary. */
async function applySettingsNow(): Promise<void> {
  if (!pendingApply) return;
  const st = readOverseerState();
  const path = st ? await pathOfId(st.current) : null;
  const chat = path ? heldChat(path) : undefined;
  if (!chat) {
    pendingApply = false; // the next open syncs from the file (chat-manager syncOverseerModel)
    return;
  }
  if (chat.session.isStreaming) return;
  pendingApply = false;
  // A conversation that has written no model or thinking yet (nothing sent): reopen it rather than
  // switch it. A switch would first flush the open-time pi-default model/thinking entries and then
  // record the new model — three info rows before the first message. A reopen seeds the runtime
  // from overseer.json directly (chat-manager createRuntime), so the file only ever records the
  // chosen model, at the first prompt. Open tabs get "reloaded" and reconnect.
  const untouched = !chat.session.sessionManager
    .getEntries()
    .some((e) => e.type === "message" || e.type === "model_change" || e.type === "thinking_level_change");
  if (untouched) {
    await disposeHeldChat(chat.path, "The Overseer's model changed; reopening it.");
    return;
  }
  const s = readOverseerSettings();
  const cur = chat.session.model ? `${chat.session.model.provider}/${chat.session.model.id}` : null;
  try {
    if (s.model && s.model !== cur) await chat.setModelRef(s.model, { save: false });
    if (s.thinking && s.thinking !== chat.session.thinkingLevel) chat.setThinking(s.thinking, { save: false });
  } catch (err) {
    console.warn("[overseer] applying settings failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---- the runtime loadout ---------------------------------------------------------------------------

/** Per-turn caps, shared by the tools and the chat runtime's `userSend` (a user message resets
    them). Kept in a file, so a restart mid-sequence doesn't renew the budget. */
const limits = new TurnLimits(overseerTurnFile());
/** Who started the turn the Overseer is in: the caps' reset and the unattended read-only rule both
    read it, so they can never disagree. Starts unattended (fail closed), so does a restart. */
const turns = new UserTurns();
/** Whether the Overseer is answering the user right now. Exported for the tests. */
export const attendedForTest = () => turns.attended();

/** Sessions the Overseer created or prompted, for the running-at-once cap. */
const started = new Set<string>();
/** When the Overseer last sent a prompt to a session, until that session is seen running: its run
    reports streaming only after some async preflight, and it must count as running meanwhile. */
const promptedAt = new Map<string, number>();
export const STARTING_GRACE_MS = 15_000;

const running = (path: string) => isSessionBusy(path) || workingSubagents(path) > 0;

/** The Overseer runtime's session (watchSession): its extension runner holds the subagents
    extension's tools, which the explorer routes call in-process (overseer-idea-tools.ts). */
let overseerSession: AgentSession | null = null;

const host: OverseerToolHost = {
  request: (path, init) => {
    if (!dispatch) throw new Error("The Overseer's tools are not wired to the server yet.");
    const headers = new Headers(init?.headers);
    headers.set(OVERSEER_SENDER_HEADER, SENDER_SECRET);
    return dispatch(path, { ...init, headers });
  },
  overseerId: () => readOverseerState()?.current ?? "",
  caps: () => readOverseerSettings().caps,
  sessions: () => listSessions(),
  async session(ref) {
    const path = ref.includes("/") ? resolveSessionPath(ref) : await pathOfId(ref);
    if (!path) return null;
    const rt = await getModelRuntime().catch(() => null);
    return getSessionSummary(path, rt ? (r) => contextWindow(r, rt) : undefined);
  },
  digest: () => attentionForWire(),
  transcript: async (path) => normalizeEntries(await readActiveBranch(path)),
  insight: (path) => getSessionInsight(path),
  held(path) {
    const chat = heldChat(path);
    if (!chat) return null;
    return { streaming: chat.session.isStreaming, queued: chat.queue.size, dialogs: chat.pendingDialogs() };
  },
  answerDialog(path, dialogId, value, answer) {
    const chat = heldChat(path);
    if (!chat) throw new Error("That session isn't open on this server, so it has no dialog waiting here.");
    chat.answerDialog(dialogId, value, answer, host.overseerId());
  },
  open: async (path) => {
    await acquireChat(path);
  },
  setModel: async (path, ref) => {
    const chat = await acquireChat(path);
    await chat.setModelRef(ref);
  },
  setThinking: async (path, level) => (await acquireChat(path)).setThinking(level),
  running,
  started: (path, prompted) => {
    started.add(path);
    if (prompted) promptedAt.set(path, Date.now());
  },
  runningStarted: () => countRunning(started, running, promptedAt),
  attended: () => turns.attended(),
  explorer: () => readOverseerSettings().explorer,
  explorerCwd: () => overseerDir(),
  subagent: (name) => (overseerSession?.extensionRunner?.getToolDefinition(name) as SubagentTool | undefined) ?? null,
};

/** An in-process call exactly as the Overseer's tools make it. Exported for the tests. */
export const requestAsOverseerForTest = (path: string, init?: RequestInit) => host.request(path, init);

/** Overseer-started sessions that count as running: running now, or prompted within the grace and
    not yet seen running (seeing one running ends its grace). Exported for the tests. */
export function countRunning(paths: Iterable<string>, isRunning: (path: string) => boolean, prompted: Map<string, number>, now = Date.now()): number {
  let n = 0;
  for (const p of paths) {
    const at = prompted.get(p);
    if (isRunning(p)) {
      prompted.delete(p);
      n++;
    } else if (at !== undefined && now - at < STARTING_GRACE_MS) n++;
    else prompted.delete(p);
  }
  return n;
}

/** The tool catalogue for the prompt: one line per tool, from the same definitions the runtime registers. */
export function toolCatalogue(tools: { name: string; promptSnippet?: string; description: string }[]): string {
  return tools.map((t) => `- \`${t.name}\`: ${t.promptSnippet ?? t.description.split(". ")[0]}`).join("\n");
}

/** The Overseer's prompt, rendered from the repo's .md (the runtime reads the .md once, so an edit
    to it applies at the next open; notes and caps are whatever the files say now). */
export function renderOverseerPrompt(
  tools: { name: string; promptSnippet?: string; description: string }[],
  settings: OverseerSettings,
  template = readFileSync(PROMPT_FILE, "utf8"),
  now = new Date(),
  redactor: () => Redactor = serverRedactor,
): string {
  const notes = readNotes().trim();
  const c = settings.caps;
  const ideas = redactor().redact(promptToc(readManifest(), readOverseerState()?.current ?? ""));
  return template
    .replaceAll("{{TOOLS}}", toolCatalogue(tools))
    .replaceAll("{{IDEAS}}", ideas)
    .replaceAll("{{NOTES}}", notes ? redactor().redact(notes.slice(0, 4000)) : "(none yet)")
    .replaceAll("{{NOW}}", now.toString())
    .replaceAll("{{HOME}}", homedir())
    .replaceAll(
      "{{CAPS}}",
      `${c.createPerTurn} new sessions, ${c.promptsPerTurn} prompts to other sessions or explorers, ${c.archivesPerTurn} archive operations, ${c.explorePerTurn} explorers launched; at most ${c.concurrentSessions} sessions you started running at once`,
    );
}

/** The user's extra instructions (Settings → Overseer) as a prompt part, none when blank. Redacted
    like the notes (renderOverseerPrompt) and every tool's output. */
export function extraInstructions(extra: string, redactor: () => Redactor = serverRedactor): string[] {
  const t = extra.trim();
  return t ? [`# The user's extra instructions for you\n\n${redactor().redact(t)}`] : [];
}

/** The tools as the runtime registers them (exported for the prompt/tool set-equality test). */
export const buildOverseerTools = () => overseerTools(host, limits);

/**
 * The Overseer's appended prompt, kept live: the standing notes, the caps and the user's extra
 * instructions are re-read at the start of every run, so a `sova_note` or a Settings save applies
 * from the next run, with no /clear. The rest (the .md, the tool list, the time it was opened) is
 * fixed per runtime, so an unchanged prompt stays byte-identical and the provider's cache holds.
 *
 * Two places need it. A run started by a message (the user's, a brief, a wake-up) builds its prompt
 * from `before_agent_start`, which sets it. A run started by an extension's message
 * (`sendMessage(…, {triggerTurn:true})`) skips that hook and builds later requests from the
 * session's base options, which the SDK builds from the loader's parts: `parts` is that very array,
 * refilled in place, and `rebase` has the session rebuild them (at every run's start).
 */
class LivePrompt {
  /** The array the resource loader holds (the user's APPEND_SYSTEM.md parts, then ours). */
  readonly parts: string[] = [];
  private base: string[] = [];
  private readonly built = new WeakMap<object, string>();
  constructor(
    private readonly tools: { name: string; promptSnippet?: string; description: string }[],
    private readonly template: string,
    private readonly openedAt: Date,
  ) {}
  /** The resource loader's override: the user's own parts, then the Overseer's. */
  seed(base: string[]): string[] {
    this.base = base;
    this.refresh();
    return this.parts;
  }
  /** Re-read notes and settings into `parts`; returns the text the SDK joins them to. */
  refresh(): string {
    const settings = readOverseerSettings();
    const next = [...this.base, renderOverseerPrompt(this.tools, settings, this.template, this.openedAt), ...extraInstructions(settings.extraSystemPrompt)];
    this.parts.splice(0, this.parts.length, ...next);
    return next.join("\n\n");
  }
  /** A run starts: bring the session's base options to the current text (a no-op when unchanged). */
  rebase(session: Pick<AgentSession, "setActiveToolsByName" | "getActiveToolNames">): void {
    const text = this.refresh();
    if (this.built.get(session) === text) return;
    this.built.set(session, text);
    // The SDK's public way to rebuild the base prompt options (from the loader's parts); the tool
    // set is passed back unchanged.
    session.setActiveToolsByName(session.getActiveToolNames());
  }
}

/** The prompt of the runtime built last (there is one Overseer runtime at a time); taken by its session in watchSession. */
let livePrompt: LivePrompt | null = null;

setOverseerRuntime({
  async loadout(path) {
    const st = readOverseerState();
    if (!st || idOf(path) !== st.current)
      throw new BusyError("This is a previous Overseer conversation. It is read-only; the eye button opens the current one.", "busy");
    const settings = readOverseerSettings();
    const tools = buildOverseerTools();
    const prompt = new LivePrompt(tools, readFileSync(PROMPT_FILE, "utf8"), new Date());
    livePrompt = prompt;
    return {
      resourceLoaderOptions: {
        extensionFactories: [
          {
            name: "sova-overseer",
            factory: (pi) => {
              for (const t of tools) pi.registerTool(t);
              // A run started by a message: its prompt, with the notes and settings as they are now.
              pi.on("before_agent_start", (event) => {
                event.systemPromptOptions.appendSystemPrompt = prompt.refresh();
              });
              // Worker reports and other extension messages reach the model redacted, like every tool's output.
              pi.on("context", (event) => {
                const messages = redactExtensionMessages(event.messages, serverRedactor());
                return messages === event.messages ? undefined : { messages };
              });
            },
          },
        ],
        // The OVERRIDE, not appendSystemPrompt: passing appendSystemPrompt suppresses discovery of
        // the user's own APPEND_SYSTEM.md, and the override keeps it (resource-loader.js:386-396).
        appendSystemPromptOverride: (base) => prompt.seed(base),
      },
      tools: [...tools.map((t) => t.name), ...BUILTIN_ALLOWED],
      // read/grep/find/ls reach anywhere except secret files (overseer-deny.ts).
      customTools: overseerFileTools(overseerDir()),
      model: settings.model,
      thinking: settings.thinking,
    };
  },
  saveChoice(patch) {
    patchOverseerSettings(patch);
  },
  // The user's message goes to the SDK through userSend; the run becomes theirs (and the caps
  // renew) when the message that call produced enters the context. Every run starts unattended, and
  // a brief, a wake-up or an extension's message never goes through it: read-only, on the same budget.
  watchSession(session) {
    overseerSession = session;
    turns.watch(session.agent);
    const prompt = livePrompt;
    session.subscribe((event) => {
      if (event.type === "agent_start") prompt?.rebase(session);
      if (turns.observe(event)) limits.reset();
    });
  },
  userSend(send) {
    return turns.send(send);
  },
});

// ---- the idle-only prompt route (sova_send) -----------------------------------------------------------

export type PromptResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * POST /api/sessions/prompt: one message to one IDLE session — the one-session twin of the group
 * prompt. With `sentBy` (the current Overseer's id, vouched for by `overseerSender`) the message
 * is marked as the Overseer's in the target's file.
 */
export async function promptIdleSession(path: string, text: string, sentBy?: string): Promise<PromptResult> {
  if (!text.trim()) return { ok: false, status: 400, error: "text must not be blank" };
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  const overseerId = sentBy && sentBy === readOverseerState()?.current ? sentBy : undefined;
  if (s.overseer) return { ok: false, status: 409, error: "That is the Overseer's own conversation." };
  if (s.live) return { ok: false, status: 409, error: `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.` };
  if (running(path)) return { ok: false, status: 409, error: "It is mid-turn or has subagents working. A prompt here is never a steer: wait for it." };
  let chat;
  try {
    chat = await acquireChat(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  if (chat.session.isStreaming) return { ok: false, status: 409, error: "It started a turn just now. Wait for it." };
  try {
    chat.assertModelAllowed();
    const { turn } = chat.acceptPrompt(text, undefined, "server", undefined, overseerId ? { sentByOverseer: { overseerId } } : undefined);
    void turn.catch((err) => chat.reportTurnFailure(err));
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  digestMemo = null;
  return { ok: true };
}

// ---- proactivity: "Brief me" -----------------------------------------------------------------------

const TICK_MS = 20_000;
export const BRIEF_MIN_GAP_MS = 10 * 60_000;
export const BRIEF_MAX_UNATTENDED = 30;

/**
 * Which blockers are new, and whether to brief now. Pure, for the tests. `announced` is what the
 * user has been told about (or what was already there when watching began); a blocker that clears
 * leaves it, so a recurrence counts as new again.
 */
export function briefDecision(input: {
  current: string[];
  announced: Set<string> | null;
  proactivity: OverseerSettings["proactivity"];
  now: number;
  lastBriefAt: number;
  unattended: number;
  overseerIdle: boolean;
}): { announced: Set<string>; brief: string[] } {
  const current = new Set(input.current);
  if (input.announced === null || input.proactivity !== "brief") return { announced: current, brief: [] };
  const announced = new Set([...input.announced].filter((k) => current.has(k)));
  const fresh = input.current.filter((k) => !announced.has(k));
  const may = fresh.length > 0 && input.overseerIdle && input.now - input.lastBriefAt >= BRIEF_MIN_GAP_MS && input.unattended < BRIEF_MAX_UNATTENDED;
  if (!may) return { announced, brief: [] };
  for (const k of fresh) announced.add(k);
  return { announced, brief: fresh };
}

let announced: Set<string> | null = null;
let lastBriefAt = 0;
let unattended = 0;

/** The brief's message. Titles and details come from other sessions: redacted like any tool output. */
export function briefText(items: Pick<AttentionItem, "kind" | "title" | "id" | "detail">[], redactor: () => Redactor = serverRedactor): string {
  const lines = items.map((i) => `- ${i.kind}: [${i.title.replace(/[[\]]/g, "")}](sova://s/${i.id})${i.detail ? ` — ${i.detail}` : ""}`);
  return redactor().redact(`${OVERSEER_BRIEF_PREFIX} ${items.length === 1 ? "A new blocker" : `${items.length} new blockers`} appeared while you were idle:\n${lines.join("\n")}`);
}

async function tick(): Promise<void> {
  await applySettingsNow();
  const settings = readOverseerSettings();
  const st = readOverseerState();
  if (!st) return; // no Overseer yet: nothing to brief
  const path = await pathOfId(st.current);
  if (!path) return;
  // The user looked at the Overseer since the last brief: the unattended run starts over.
  if ((readSeen()[st.current] ?? 0) > lastBriefAt || isViewing(st.current)) unattended = 0;
  const digest = await attentionDigest();
  const act = digest.items.filter((i) => i.tier === "act");
  const chat = heldChat(path);
  const idle = !chat || (!chat.session.isStreaming && chat.queue.size === 0);
  const d = briefDecision({ current: act.map(blockerKey), announced, proactivity: settings.proactivity, now: Date.now(), lastBriefAt, unattended, overseerIdle: idle });
  announced = d.announced;
  if (!d.brief.length) return;
  const text = briefText(act.filter((i) => d.brief.includes(blockerKey(i))));
  try {
    const overseer = await acquireChat(path);
    overseer.assertModelAllowed();
    const { turn } = overseer.acceptPrompt(text, undefined, "server");
    void turn.catch((err) => overseer.reportTurnFailure(err));
    lastBriefAt = Date.now();
    unattended++;
  } catch (err) {
    console.warn("[overseer] brief skipped:", err instanceof Error ? err.message : String(err));
  }
}

let ticking = false;
/** Start the background loop (index.ts, once). Brief turns start only under "brief"; the loop also
    applies a Settings model change that arrived mid-turn. */
export function startOverseerLoop(): void {
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.warn("[overseer] tick failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref();
}

