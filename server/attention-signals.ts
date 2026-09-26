import { open, stat } from "node:fs/promises";
import type { DecisionSettings, SessionSummary, WorkerInfo } from "../shared/protocol";
import { isLinkMessage } from "../shared/link-message";
import type { WorkerTranscriptAdapters, WorkerTranscriptItem, WorkerTranscriptRef, WorkerTranscriptSummary } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { DecisionError, type DecisionProvider, type DecisionResult, type JsonObject, type Question } from "./decide";
import { maySend, terminalSession } from "./decide-settings";
import type { RawLiveRecord } from "./live";
import { readSignals, signalsFile, updateSignals } from "./signals-store";
import { activeBranch, parseLines } from "./transcript";

/**
 * Attention signals (Settings → Decisions → "needs you" marks): every FINISHED turn of a main
 * session, and subagent workers that run long, are classified through the decision seam
 * (server/decide.ts — this module never knows which provider answers) and the raw answers stored
 * in signals.json (server/signals-store.ts, which also owns the thresholds and the list overlay).
 *
 * Triggers:
 *  - a hosted chat's `agent_settled` (`turnSettled`, wired in index.ts from chat-manager);
 *  - a ticker for everything else (TUI-live sessions, sessions another process wrote): any
 *    main-thread session whose last reply is newer than its stored turn. Transcripts are read with
 *    Sova's own parser from the tail of the file — never SessionManager.open(), never a write;
 *  - the same ticker for workers: a "stuck" check for a worker running > 5 min, at most every
 *    5 min.
 * Whether a turn failed is never asked: that is a fact of the file (the last reply's stopReason
 * "error"), which the session list reads itself (SessionSummary.turnError). A turn that stopped
 * with an error is not classified at all.
 * Each (session id, last assistant entry id) is classified at most once. Nothing is sent while the
 * feature is off, for an excluded folder, for Overseer / worker / archived sessions, or — with
 * "never send TUI sessions" — for a session another process owns. Every state is capped and
 * redacted before it leaves the process.
 */

export const TICK_MS = 10_000;
/** A turn first seen by the ticker is classified only if it ended this recently: switching the
    feature on never classifies the whole archive. */
export const FRESH_MS = 30 * 60_000;
export const WORKER_STUCK_AFTER_MS = 5 * 60_000;
export const WORKER_STUCK_EVERY_MS = 5 * 60_000;
/** A hosted turn this long, or with this many tool calls, also gets the "stuck" question. */
export const LONG_TURN_MS = 5 * 60_000;
export const LONG_TURN_TOOLS = 20;
/** At most this many decisions per tick; the rest wait for the next one. */
export const TICK_BUDGET = 6;
/** A failed attempt at one key is retried after this long, at most MAX_ATTEMPTS times. */
export const RETRY_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
/** How much of a session file's end is read for the last turn. */
export const TAIL_BYTES = 1024 * 1024;

// Caps, in characters, of what one state may carry (≈ 6k tokens at most).
export const CAP = { title: 200, user: 2000, assistant: 4000, tool: 120, error: 300, tools: 8 } as const;

type Entry = Record<string, any>;

// ---- facts (pure) --------------------------------------------------------------------------------

/** One tool call of the turn, paired with its result when there is one. */
export interface ToolCallFact {
  name: string;
  /** The call's arguments, JSON. */
  args: string;
  /** false = the result is an error; undefined = unknown (no result, or the source doesn't say). */
  ok?: boolean;
  result: string;
}

/** What a finished turn is judged on; counts are done here, in code (Jev does not count). */
export interface TurnFacts {
  /** Id of the last assistant entry on the active branch. */
  turnId: string;
  /** ms epoch of that reply. */
  replyAt: number;
  lastUser: string;
  assistantLast: string;
  tools: ToolCallFact[];
  stopReason: string;
  error?: string;
  durationMs: number;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
      : "";

function entryTime(e: Entry): number {
  const m = e?.message?.timestamp;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  const t = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

const role = (e: Entry) => (e?.type === "message" ? e.message?.role : undefined);

/**
 * The last finished turn of an active branch: from the last user message to the last assistant
 * message after it. null when there is none, or the branch ends mid-turn (the last reply asked for
 * a tool: the turn has not finished).
 */
export function turnFacts(branch: readonly Entry[]): TurnFacts | null {
  let ai = -1;
  for (let i = branch.length - 1; i >= 0; i--) if (role(branch[i]!) === "assistant") { ai = i; break; }
  const lastEntry = branch[ai];
  if (!lastEntry || typeof lastEntry.id !== "string") return null;
  const last = lastEntry.message;
  if (last?.stopReason === "toolUse") return null;
  let ui = -1;
  for (let i = ai - 1; i >= 0; i--) if (role(branch[i]!) === "user") { ui = i; break; }
  const userEntry = branch[ui];
  const turn = branch.slice(ui + 1, ai + 1);
  let assistantLast = textOf(last.content).trim();
  for (let i = turn.length - 1; !assistantLast && i >= 0; i--) if (role(turn[i]!) === "assistant") assistantLast = textOf(turn[i]!.message.content).trim();
  const tools: ToolCallFact[] = [];
  const byCall = new Map<string, ToolCallFact>();
  for (const e of turn) {
    const m = e.message;
    if (role(e) === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type !== "toolCall") continue;
        const call: ToolCallFact = { name: String(b.name ?? "tool"), args: JSON.stringify(b.arguments ?? {}), result: "" };
        tools.push(call);
        if (typeof b.id === "string") byCall.set(b.id, call);
      }
    } else if (role(e) === "toolResult") {
      const call = typeof m.toolCallId === "string" ? byCall.get(m.toolCallId) : undefined;
      if (!call) continue;
      call.ok = m.isError !== true;
      call.result = textOf(m.content);
    }
  }
  const replyAt = entryTime(lastEntry);
  const started = userEntry ? entryTime(userEntry) : 0;
  return {
    turnId: lastEntry.id,
    replyAt,
    lastUser: userEntry ? textOf(userEntry.message.content).trim() : "",
    assistantLast,
    tools,
    stopReason: String(last.stopReason ?? "stop"),
    ...(last.stopReason === "error" || last.errorMessage ? { error: String(last.errorMessage ?? "The turn stopped with an error.") } : {}),
    durationMs: started && replyAt >= started ? replyAt - started : 0,
  };
}

/** A worker transcript's tail items as tool-call facts: each `tool` item paired with the next result. */
export function workerTools(items: readonly WorkerTranscriptItem[]): ToolCallFact[] {
  const out: ToolCallFact[] = [];
  let open: ToolCallFact | null = null;
  for (const it of items) {
    if (it.kind === "tool") {
      open = { name: it.toolName ?? "tool", args: it.text, result: "" };
      out.push(open);
    } else if (it.kind === "tool-result" && open) {
      open.result = it.text;
      open = null;
    }
  }
  return out;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename"];

/** Counted in code and handed over as named facts. */
export function repeats(tools: readonly ToolCallFact[]): { same_tool_and_args_in_a_row: number; distinct_files_touched: number } {
  let run = 0;
  let best = 0;
  let prev = "";
  const files = new Set<string>();
  for (const t of tools) {
    const key = `${t.name}\n${t.args}`;
    run = key === prev ? run + 1 : 1;
    prev = key;
    best = Math.max(best, run);
    try {
      const a = JSON.parse(t.args);
      for (const k of PATH_KEYS) if (typeof a?.[k] === "string") files.add(a[k]);
    } catch {
      // args cut short or not JSON: no file
    }
  }
  return { same_tool_and_args_in_a_row: best, distinct_files_touched: files.size };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** The first `n` characters, marked when cut. */
export const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The last `n` characters (a reply's end is where it asks), marked when cut. */
export const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);

function recentTools(tools: readonly ToolCallFact[]): JsonObject[] {
  return tools.slice(-CAP.tools).map((t) => ({ tool: t.name, summary: head(squash(t.result || t.args), CAP.tool) }));
}

export const SENTENCE_MAX = 160;

/**
 * The sentence a digest item quotes: of the reply's last three sentences, the last one that asks
 * (ends in "?"), else the very last. Whitespace-collapsed, capped at SENTENCE_MAX.
 */
export function lastSentence(text: string): string {
  const flat = squash(text.replace(/```[\s\S]*?```/g, " "));
  if (!flat) return "";
  // A sentence ends at . ! ? (and any closing quote or bracket) followed by whitespace or the end:
  // the dot in `notes.md`, `v1.2` or `e.g` is not an end.
  const parts = flat.split(/(?<=[.!?]+["'`)\]]*)\s+/).map((p) => p.trim()).filter(Boolean);
  const recent = parts.slice(-3);
  const pick = [...recent].reverse().find((p) => p.endsWith("?")) ?? recent[recent.length - 1] ?? "";
  return head(pick, SENTENCE_MAX);
}

/** The state of one main-session turn, capped. The caller redacts it. */
export function turnState(title: string, f: TurnFacts): JsonObject {
  return {
    title: head(squash(title), CAP.title),
    last_user_message: head(f.lastUser, CAP.user),
    assistant_last: tail(f.assistantLast, CAP.assistant),
    tool_calls_recent: recentTools(f.tools),
    repeats: repeats(f.tools),
    turn: {
      stop_reason: f.stopReason,
      ...(f.error ? { error: head(squash(f.error), CAP.error) } : {}),
      duration_s: Math.round(f.durationMs / 1000),
      tool_calls: f.tools.length,
    },
  };
}

/** The state of one worker, capped. The caller redacts it. */
export function workerState(w: Pick<WorkerInfo, "name" | "status" | "startedAt" | "endedAt" | "preview">, s: Pick<WorkerTranscriptSummary, "lastAssistantText" | "lastOutcome" | "partialTurn" | "items">, now: number): JsonObject {
  const items = s.items ?? [];
  const tools = workerTools(items);
  const task = [...items].reverse().find((i) => i.kind === "task")?.text ?? w.preview ?? "";
  const errors = items.filter((i) => i.kind === "error").map((i) => i.text);
  const end = w.endedAt ?? now;
  return {
    title: head(squash(w.name), CAP.title),
    task: head(task, CAP.user),
    assistant_last: tail(s.lastAssistantText ?? "", CAP.assistant),
    tool_calls_recent: recentTools(tools),
    repeats: repeats(tools),
    worker: {
      status: w.status,
      ...(s.lastOutcome ? { last_outcome: s.lastOutcome } : {}),
      ...(errors.length ? { error: head(squash(errors[errors.length - 1] ?? ""), CAP.error) } : {}),
      ended_mid_turn: s.partialTurn,
      running_min: w.startedAt ? Math.round((end - w.startedAt) / 60_000) : 0,
    },
  };
}

// ---- questions (ids are the store's contract) ----------------------------------------------------

export const ASKS_USER: Question = {
  type: "boolean",
  instructions:
    "Does `assistant_last` end by asking the user a question, or for a decision, an approval or information it needs before it can continue?",
  criteria: {
    true: "It waits on the user: a question, a choice to make, a confirmation, or something missing only the user can give.",
    false: "It reports what it did or found, or carries on by itself. A closing courtesy such as 'let me know if you want more' is not waiting.",
  },
};

export const STUCK: Question = {
  type: "score",
  instructions:
    "Is the agent making progress or going in circles? `repeats.same_tool_and_args_in_a_row` is the longest run of identical consecutive tool calls; `repeats.distinct_files_touched` is how many different files it touched.",
  levels: ["making progress", "some repetition", "clearly looping or stuck"],
};

/** A main session's questions: the stuck one only for a long turn (fewer tokens otherwise). A turn
    a partner's link message opened never asks whether it asks the user: its question is to the
    partner, so it never puts the session in Needs you (§mesh.links/transcript). */
export function turnQuestions(f: TurnFacts): Record<string, Question> {
  const long = f.durationMs >= LONG_TURN_MS || f.tools.length >= LONG_TURN_TOOLS;
  return { ...(isLinkMessage(f.lastUser) ? {} : { asks_user: ASKS_USER }), ...(long ? { stuck: STUCK } : {}) };
}

// ---- eligibility (pure) --------------------------------------------------------------------------

/**
 * Why a session is never sent, or null when it may be. "TUI" = a live record of another process
 * (a TUI, another server), and, while this server doesn't hold it, a session Sova didn't start
 * (its turns were written by a TUI or a headless pi, even if that process has since exited).
 */
export function exclusionReason(
  s: Pick<SessionSummary, "cwd" | "overseer" | "workerSession" | "archived" | "live" | "origin" | "baton" | "projectOverseer">,
  settings: DecisionSettings,
  held: boolean,
  home?: string,
): string | null {
  if (s.overseer) return "overseer";
  if (s.projectOverseer) return "project overseer";
  // Its Needs-you item comes from the baton itself (§app.baton/needs-you), and outsiders' words
  // are not sent to a decision model.
  if (s.baton) return "baton session";
  if (s.workerSession) return "worker session";
  if (s.archived) return "archived";
  const gate = maySend(settings, "attention", { cwd: s.cwd, terminal: terminalSession(s, held) }, home);
  return gate.ok ? null : gate.reason;
}

// ---- file reads (read-only) ----------------------------------------------------------------------

/**
 * The active branch as far as the file's last `maxBytes` reach: the leaf is the last entry (pi's
 * rule), walked back by parentId until an entry falls outside the window. Enough for the last
 * turn; a turn longer than the window is judged on its end.
 */
export async function readTailBranch(path: string, maxBytes = TAIL_BYTES): Promise<Entry[]> {
  const st = await stat(path);
  const start = Math.max(0, st.size - maxBytes);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // the first line is cut
    return activeBranch(parseLines(text));
  } finally {
    await fh.close();
  }
}

/** A live worker's transcript ref (the same two kinds worker-restore reads), or null. */
export function workerRef(w: Pick<WorkerInfo, "backend" | "sessionFile" | "sessionId">): WorkerTranscriptRef | null {
  if (w.backend === "claude-code") return w.sessionId ? { v: 1, backend: "claude-code", kind: "claude-session-id", locator: w.sessionId } : null;
  return w.sessionFile ? { v: 1, backend: w.backend ?? "pi", kind: "pi-session-file", locator: w.sessionFile } : null;
}

// ---- the runtime ---------------------------------------------------------------------------------

export interface SignalsDeps {
  settings: () => DecisionSettings;
  /** The decision chain; null while it has no provider at all. */
  provider: () => DecisionProvider | null;
  list: () => Promise<SessionSummary[]>;
  summary: (path: string) => Promise<SessionSummary | null>;
  /** The list's cached last finished reply of a file (sessions-index lastReplyOf): when, and how it stopped. */
  lastReply: (path: string) => { at: number; stopReason: string } | undefined;
  /** This server holds a runtime for it. */
  held: (path: string) => boolean;
  /** Every live record, this server's own included. */
  liveRecords: () => RawLiveRecord[];
  decodeWorkers: (presence: Record<string, any> | undefined) => WorkerInfo[];
  adapters: () => WorkerTranscriptAdapters;
  /** The Redactor over any JSON value. */
  redact: <T>(value: T) => T;
  /** The store changed: push (server/session-feed.ts). */
  changed: () => void;
  file?: string;
  now?: () => number;
  home?: string;
  /** Delay between agent_settled and the read (the reply's line is flushed by then). */
  settleDelayMs?: number;
}

interface Attempt {
  count: number;
  at: number;
  /** bad-request: our own defect, never retried. */
  final: boolean;
}

export class AttentionSignals {
  private readonly inFlight = new Set<string>();
  private readonly attempts = new Map<string, Attempt>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  constructor(private readonly d: SignalsDeps) {}

  private now = () => (this.d.now ?? Date.now)();
  private file = () => this.d.file ?? signalsFile();

  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A hosted chat's turn settled: classify it shortly (the ticker would also, within 10 s). */
  turnSettled(path: string): void {
    if (!this.d.settings().features.attention) return;
    const t = setTimeout(() => {
      this.d
        .summary(path)
        .then((s) => (s ? this.classifySession(s, true) : false))
        .catch((err) => console.warn("[signals]", err instanceof Error ? err.message : String(err)));
    }, this.d.settleDelayMs ?? 1500);
    t.unref?.();
  }

  /** One pass over the list and the live workers. Returns how many decisions it made. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    const settings = this.d.settings();
    if (!settings.features.attention || !this.d.provider()) return 0;
    this.ticking = true;
    try {
      const list = await this.d.list();
      let budget = TICK_BUDGET;
      for (const s of list) {
        if (budget <= 0) break;
        if (await this.classifySession(s, false)) budget--;
      }
      if (budget > 0) budget -= await this.checkWorkers(list, budget);
      this.prune(list);
      return TICK_BUDGET - budget;
    } finally {
      this.ticking = false;
    }
  }

  /** Classify a session's last finished turn if it has a new one. true = a decision was made. */
  async classifySession(s: SessionSummary, settled: boolean): Promise<boolean> {
    const settings = this.d.settings();
    if (exclusionReason(s, settings, this.d.held(s.path), this.d.home)) return false;
    if (s.busy || s.activity?.state === "working") return false;
    const stored = readSignals(this.file()).sessions[s.id];
    const reply = this.d.lastReply(s.path);
    const now = this.now();
    // Cheap gates before any read: nothing newer than what is stored; a first sight of an old turn;
    // a turn that stopped with an error (the list's turn-error mark says so, not a classifier).
    if (!settled) {
      if (reply === undefined) return false;
      if (reply.stopReason === "error") {
        this.forgetBefore(s.id, reply.at);
        return false;
      }
      if (stored ? reply.at <= stored.replyAt : now - reply.at > FRESH_MS) return false;
    }
    let facts: TurnFacts | null;
    try {
      facts = turnFacts(await readTailBranch(s.path));
    } catch {
      return false;
    }
    if (!facts || stored?.turnId === facts.turnId) return false;
    if (facts.stopReason === "error") {
      this.forgetBefore(s.id, facts.replyAt);
      return false;
    }
    if (!stored && now - facts.replyAt > FRESH_MS) return false;
    const questions = turnQuestions(facts);
    // A short turn a link message opened has nothing to ask: no model call, and like an errored
    // turn it replaces the turn before it, so an older "asks you" does not stay on the row.
    if (!Object.keys(questions).length) {
      this.forgetBefore(s.id, facts.replyAt);
      return false;
    }
    const key = `${s.id}:${facts.turnId}`;
    const result = await this.decide(key, "attention", turnState(s.title, facts), questions);
    if (!result) return false;
    // The feature or the session's eligibility may have changed while the call ran: then drop it.
    if (exclusionReason(s, this.d.settings(), this.d.held(s.path), this.d.home)) return true;
    const f = facts;
    const detail = this.d.redact(lastSentence(f.assistantLast || f.error || ""));
    updateSignals((data) => {
      data.sessions[s.id] = {
        turnId: f.turnId, replyAt: f.replyAt, at: this.now(), provider: result.provider, model: result.model, answers: result.answers,
        ...(detail ? { detail } : {}),
      };
    }, this.file());
    this.d.changed();
    return true;
  }

  /**
   * A turn that stopped with an error (or a short link-opened one) is not classified; the stored
   * answers of the turn before it are dropped, since a newer turn replaces them and they would otherwise mark the row still.
   */
  private forgetBefore(id: string, replyAt: number): void {
    const stored = readSignals(this.file()).sessions[id];
    if (!stored || stored.replyAt >= replyAt) return;
    updateSignals((data) => void delete data.sessions[id], this.file());
    this.d.changed();
  }

  /** Stuck checks for long-running workers. */
  private async checkWorkers(list: readonly SessionSummary[], budget: number): Promise<number> {
    const byPath = new Map(list.map((s) => [s.path, s]));
    const settings = this.d.settings();
    const now = this.now();
    let used = 0;
    const seen = new Set<string>();
    for (const r of this.d.liveRecords()) {
      if (used >= budget) break;
      const parent = r.sessionFile ? byPath.get(r.sessionFile) : undefined;
      // Workers of an ineligible parent are never sent. The parent may be mid-turn: workers are checked anyway.
      if (!parent || exclusionReason({ ...parent, archived: false }, settings, this.d.held(parent.path), this.d.home)) continue;
      for (const w of this.d.decodeWorkers(r.rec?.presence)) {
        if (used >= budget) break;
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        const stored = readSignals(this.file()).workers[w.id];
        if (!w.working || !w.startedAt || now - w.startedAt < WORKER_STUCK_AFTER_MS) continue;
        if (stored && now - stored.at < WORKER_STUCK_EVERY_MS) continue;
        if (await this.checkWorker(parent, w)) used++;
      }
    }
    return used;
  }

  private async checkWorker(parent: SessionSummary, w: WorkerInfo): Promise<boolean> {
    const ref = workerRef(w);
    if (!ref) return false;
    const adapter = this.d.adapters().get(ref.backend);
    const caps = adapter.capabilities();
    if (!caps.read) return false;
    let summary: WorkerTranscriptSummary;
    try {
      summary = await adapter.read(ref, caps.items ? { items: "tail", limit: 24 } : { items: "none" });
    } catch {
      return false;
    }
    if (!summary.found) return false;
    const now = this.now();
    // A stuck check is keyed by its time slot.
    const key = `${w.id}:stuck:${Math.floor(now / WORKER_STUCK_EVERY_MS)}`;
    const result = await this.decide(key, "worker", workerState(w, summary, now), { stuck: STUCK });
    if (!result) return false;
    updateSignals((data) => {
      data.workers[w.id] = {
        sessionId: parent.id,
        kind: "stuck",
        at: this.now(),
        name: head(squash(w.name), 80),
        provider: result.provider,
        model: result.model,
        answers: result.answers,
      };
    }, this.file());
    this.d.changed();
    return true;
  }

  /** One decision, redacted, deduplicated in flight and retried with a bound. null = no answer. */
  private async decide(key: string, purpose: "attention" | "worker", state: JsonObject, questions: Record<string, Question>): Promise<DecisionResult | null> {
    const provider = this.d.provider();
    if (!provider || this.inFlight.has(key)) return null;
    const prev = this.attempts.get(key);
    const now = this.now();
    if (prev && (prev.final || prev.count >= MAX_ATTEMPTS || now - prev.at < RETRY_MS)) return null;
    this.inFlight.add(key);
    try {
      const result = await provider.decide({ purpose, state: this.d.redact(state), questions, dedupeKey: key });
      this.attempts.delete(key);
      return result;
    } catch (err) {
      const failure = err instanceof DecisionError ? err.failure : "server";
      this.attempts.set(key, { count: (prev?.count ?? 0) + 1, at: this.now(), final: failure === "bad-request" });
      if (failure === "bad-request") console.error(`[signals] ${purpose} question rejected:`, err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.inFlight.delete(key);
      if (this.attempts.size > 2000) this.attempts.clear();
    }
  }

  /** Drop sessions whose file is gone, and workers whose parent is. */
  private prune(list: readonly SessionSummary[]): void {
    if (!list.length) return; // an empty listing is a failed one, not an empty archive
    const ids = new Set(list.map((s) => s.id));
    const data = readSignals(this.file());
    const gone = Object.keys(data.sessions).filter((id) => !ids.has(id));
    const goneWorkers = Object.entries(data.workers)
      .filter(([, w]) => !ids.has(w.sessionId))
      .map(([id]) => id);
    if (!gone.length && !goneWorkers.length) return;
    updateSignals((d) => {
      for (const id of gone) delete d.sessions[id];
      for (const id of goneWorkers) delete d.workers[id];
    }, this.file());
    this.d.changed();
  }
}
