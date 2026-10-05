import type { HEntry } from "../shared/harness";
import type { DecisionSettings, SessionSummary, TeamDuty, WorkerInfo } from "../shared/protocol";
import { isLinkMessage } from "../shared/link-message";
import { isTopicBatch } from "../shared/topic-message";
import { parseWakeNudge } from "../shared/wake";
import type { WorkerTranscriptAdapters, WorkerTranscriptItem, WorkerTranscriptRef, WorkerTranscriptSummary } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { DecisionError, type DecisionProvider, type DecisionResult, type JsonObject, type Question } from "./decide";
import { maySend, terminalSession } from "./decide-settings";
import type { RawLiveRecord } from "./live";
import { isLooping, readSignals, signalsFile, type StoredStall, updateSignals, workerKey } from "./signals-store";
import { joinedText, readTailBranch as readTail } from "./harness/pi/reader";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";

/**
 * Attention signals (Settings → Decisions → "needs you" marks): every FINISHED turn of a main
 * session, and subagent workers that run long, are classified through the decision seam
 * (server/decide.ts — this module never knows which provider answers) and the raw answers stored
 * in signals.json (server/signals-store.ts, which also owns the thresholds and the list overlay).
 *
 * A main session's turn is asked whether a LONG turn went in circles (`stuck`; never a turn that
 * mostly waited on workers), and, when the session has no open alignment question (those are a
 * fact of its file, SessionSummary.align) and the reply's end looks like it asks (counted in code,
 * `looksLikeAsk`), whether it asks the user something (`asks_user`). A turn with neither asks
 * nothing, makes no model call, and drops the turn before it.
 *
 * Triggers:
 *  - a hosted chat's `agent_settled` (`turnSettled`, wired in index.ts from chat-manager);
 *  - a ticker for everything else (TUI-live sessions, sessions another process wrote): any
 *    main-thread session whose last reply is newer than its stored turn. Transcripts are read with
 *    Sova's own parser from the tail of the file — never SessionManager.open(), never a write;
 *  - the same ticker for workers: a "stuck" check for a worker whose CURRENT turn (from its last
 *    task item) has run ≥ 5 min, at most every 5 min; never a monitor or coordinator, never a turn
 *    a wake nudge started. Only a turn that repeats itself or keeps failing (`workerSuspect`,
 *    counted in code) is sent; any other is stored as making progress without a call. A looping
 *    subagent counts only after two looping answers in a row in the same turn.
 *  - the same ticker, with no model, for a session waiting on subagents that have all gone quiet
 *    for STALL_MS (`quietTeam` + `waitsOnTeam`, §app.decisions/team-stall).
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
/** How many of a worker's transcript items are read (its current turn is cut from them). */
export const WORKER_ITEMS = 60;
/** The mechanical pre-gate before a worker's stuck question: this many identical calls in a row… */
export const WORKER_REPEAT_MIN = 3;
/** …or a turn this long whose last WORKER_ERROR_RUN tool results all read as errors. */
export const WORKER_ERRORING_MS = 15 * 60_000;
export const WORKER_ERROR_RUN = 3;
/** What looks like an ask is looked for in this much of the reply's end; the asks excerpt is longer. */
export const ASK_LOOK_CHARS = 1000;
export const ASK_TAIL_CHARS = 1500;
export const ASK_USER_CHARS = 600;
export const SENTENCE_MAX = 160;
/** A session waiting on subagents that have done nothing for this long has a stalled team. */
export const STALL_MS = 15 * 60_000;
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

/** An entry's text blocks, joined by newlines. */
const textOf = (h: HEntry): string => joinedText(h, { images: false });

function entryTime(h: HEntry): number {
  const m = "sentAt" in h ? h.sentAt : undefined;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  const t = typeof h.at === "string" ? Date.parse(h.at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * The last finished turn of an active branch: from the last user message to the last assistant
 * message after it. null when there is none, or the branch ends mid-turn (the last reply asked for
 * a tool: the turn has not finished).
 */
export function turnFacts(branch: readonly HEntry[]): TurnFacts | null {
  let ai = -1;
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i]!.kind === "assistant") { ai = i; break; }
  const last = branch[ai];
  if (!last || last.kind !== "assistant" || last.id === null) return null;
  if (last.stop === "toolUse") return null;
  let ui = -1;
  for (let i = ai - 1; i >= 0; i--) if (branch[i]!.kind === "user") { ui = i; break; }
  const userEntry = branch[ui];
  const turn = branch.slice(ui + 1, ai + 1);
  let assistantLast = textOf(last).trim();
  for (let i = turn.length - 1; !assistantLast && i >= 0; i--) if (turn[i]!.kind === "assistant") assistantLast = textOf(turn[i]!).trim();
  const tools: ToolCallFact[] = [];
  const byCall = new Map<string, ToolCallFact>();
  for (const h of turn) {
    if (h.kind === "assistant") {
      for (const b of h.blocks) {
        if (b.type !== "toolCall") continue;
        const call: ToolCallFact = { name: String(b.name ?? "tool"), args: JSON.stringify(b.arguments ?? {}), result: "" };
        tools.push(call);
        if (typeof b.id === "string") byCall.set(b.id, call);
      }
    } else if (h.kind === "tool-result") {
      const call = typeof h.callId === "string" ? byCall.get(h.callId) : undefined;
      if (!call) continue;
      call.ok = h.isError !== true;
      call.result = textOf(h);
    }
  }
  const replyAt = entryTime(last);
  const started = userEntry ? entryTime(userEntry) : 0;
  return {
    turnId: last.id,
    replyAt,
    lastUser: userEntry ? textOf(userEntry).trim() : "",
    assistantLast,
    tools,
    stopReason: String(last.stop ?? "stop"),
    ...(last.stop === "error" || last.error ? { error: String(last.error ?? "The turn stopped with an error.") } : {}),
    durationMs: started && replyAt >= started ? replyAt - started : 0,
  };
}

/** A tool result that reads as a failure (worker transcripts carry no error flag on results). */
const ERROR_RESULT_RE = /^\s*(?:error\b|Error:|\w*Error:|Exit code [1-9]|Command failed|ENOENT|fatal:)/;

/** A worker transcript's items as tool-call facts: each `tool` item paired with the next result
    (`ok` false when the result reads as an error, or an error item follows the call). */
export function workerTools(items: readonly WorkerTranscriptItem[]): ToolCallFact[] {
  const out: ToolCallFact[] = [];
  let open: ToolCallFact | null = null;
  for (const it of items) {
    if (it.kind === "tool") {
      open = { name: it.toolName ?? "tool", args: it.text, result: "" };
      out.push(open);
    } else if ((it.kind === "tool-result" || it.kind === "error") && open) {
      open.result = it.text;
      open.ok = it.kind === "tool-result" && !ERROR_RESULT_RE.test(it.text);
      open = null;
    }
  }
  return out;
}

/** A worker's current turn: the items from its last task or steer item on (the tail read may not
    reach back that far: then every item, and the start is the first item's time, a lower bound). */
export interface WorkerTurn {
  items: WorkerTranscriptItem[];
  /** ms epoch the turn started; 0 unknown. */
  startedAt: number;
  startedBy: "task" | "steer" | "wake_nudge" | "unknown";
}

export function currentWorkerTurn(items: readonly WorkerTranscriptItem[]): WorkerTurn {
  let i = items.length - 1;
  while (i >= 0 && items[i]!.kind !== "task" && items[i]!.kind !== "steer") i--;
  if (i < 0) return { items: [...items], startedAt: items.find((it) => it.at)?.at ?? 0, startedBy: "unknown" };
  const start = items[i]!;
  const startedBy = parseWakeNudge(start.text) ? "wake_nudge" : start.kind === "steer" ? "steer" : "task";
  return { items: items.slice(i), startedAt: start.at ?? 0, startedBy };
}

/** The mechanical pre-gate: does this turn look like it could be stuck? Same tool and arguments
    WORKER_REPEAT_MIN times in a row, or a turn of WORKER_ERRORING_MS whose last WORKER_ERROR_RUN
    tool results are all errors. Anything else is progress without asking a model. */
export function workerSuspect(tools: readonly ToolCallFact[], runningMs: number): boolean {
  if (repeats(tools).same_tool_and_args_in_a_row >= WORKER_REPEAT_MIN) return true;
  const last = tools.slice(-WORKER_ERROR_RUN);
  return runningMs >= WORKER_ERRORING_MS && last.length === WORKER_ERROR_RUN && last.every((t) => t.ok === false);
}

/** Tool names that wait (on workers, a team, a scheduled wake), MCP-prefixed or not. */
const WAIT_TOOL_RE = /^(?:mcp__\w+?__)?(?:agent_wait|wake_nudge|team_\w+)$/;

/** A turn whose tool calls are mostly (more than half) waits: long because it waited, not looping. */
export function mostlyWaits(tools: readonly ToolCallFact[]): boolean {
  if (!tools.length) return false;
  return tools.filter((t) => WAIT_TOOL_RE.test(t.name)).length * 2 > tools.length;
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

/** A reply's closing spec lines (the spec mode's footer): cut before looking for an ask. */
const FOOTER_RE = /(?:^|\n|\s{2,})(?:Also changes:|Deferred:|Spec check override:|Plumbing:)[^\n]*$/;

/** The reply without its closing spec lines. */
export function withoutFooter(text: string): string {
  let t = text.trimEnd();
  for (let m = FOOTER_RE.exec(t); m; m = FOOTER_RE.exec(t)) t = t.slice(0, m.index).trimEnd();
  return t;
}

/** What makes a reply's end look like it asks: a question mark, or an asking phrase. Loose on
    purpose: it only decides whether a model is asked. */
const ASK_RE =
  /\?(?=[\s"'”’)*_`\]]|$)|\b(?:should i|shall i|want me to|do you want|would you like|tell me|let me know|say (?:if|when|which|whether|go)|if you(?:'d|’d)? (?:want|like|prefer)|your call|up to you|confirm(?: and|,| to| it| that| this)|(?:once|after|when) you (?:say|confirm|approve|decide|answer)|say yes|your go\b|which (?:one|option|do you)|can i|may i|ok(?:ay)? to|waiting (?:for|on) your?|your (?:answer|go-ahead|ok|approval|decision))\b/i;

/** Counted in code: does the end of a reply (its last ASK_LOOK_CHARS, footer cut) look like it asks? */
export function looksLikeAsk(reply: string): boolean {
  return ASK_RE.test(withoutFooter(reply).slice(-ASK_LOOK_CHARS));
}

/** What a reply that waits on its subagents says (§app.decisions/team-stall). Read in code, never
    by a model; loose on purpose, since the subagents' own quiet is the stronger fact. A phrase
    whose subject is "you" ("When you report a bug…") is advice to the user, never a wait. */
const WAITS_ON_TEAM_RE =
  /\b(?:still (?:running|in progress|working|going)|in progress|(?:when|once) (?:it|they|that|the \w+|(?!you\b)\w+) (?:arrives?|lands?|finish(?:es)?|is done|are done|reports?(?: back)?|comes? (?:back|in)|signs? off)|reports? (?:back )?to me|(?:will|'ll) (?:send|report to|ping|tell) me|as they come|(?:waiting|wait) (?:on|for) (?:the )?(?:team|workers?|members?|subagents?|coordinator|verifier|reviewer|lead|builder|results?|report))\b/i;

/** Does the end of a reply (its last ASK_LOOK_CHARS, footer cut) say it waits on its subagents? */
export function waitsOnTeam(reply: string): boolean {
  return WAITS_ON_TEAM_RE.test(withoutFooter(reply).slice(-ASK_LOOK_CHARS));
}

/**
 * The facts of a stalled team apart from the reply's words (`waitsOnTeam`), or null
 * (§app.decisions/team-stall): an idle session whose counted subagents have all been quiet for
 * STALL_MS. A subagent counts only when its last activity came after the session's last reply and
 * it has not delivered a finished report (idle with a successful outcome): a leftover worker of a
 * finished session — restored idle when an old session is opened again — never counts. Monitors
 * and coordinators (`duties`) count neither as quiet members nor as activity; a killed worker is
 * gone. Pure.
 */
export function quietTeam(
  s: Pick<SessionSummary, "busy" | "activity" | "archived" | "overseer" | "projectOverseer" | "workerSession" | "baton">,
  workers: readonly Pick<WorkerInfo, "id" | "name" | "status" | "working" | "startedAt" | "lastActivity" | "endedAt" | "outcome">[],
  duties: ReadonlyMap<string, TeamDuty>,
  reply: { at: number; stopReason: string } | undefined,
  now: number,
): { since: number; names: string[] } | null {
  if (s.overseer || s.projectOverseer || s.workerSession || s.baton || s.archived) return null;
  if (s.busy || s.activity?.state === "working" || !reply || reply.stopReason !== "stop") return null;
  const members = workers.filter((w) => !duties.has(w.id));
  if (members.some((w) => w.working)) return null;
  const activeAt = (w: (typeof members)[number]) => w.lastActivity ?? w.endedAt ?? w.startedAt ?? 0;
  const quiet = members.filter((w) => w.status !== "killed" && w.outcome !== "success" && activeAt(w) > reply.at);
  if (!quiet.length) return null;
  const since = Math.max(...quiet.map(activeAt));
  return now - since >= STALL_MS ? { since, names: quiet.map((w) => head(squash(w.name), 40)) } : null;
}

/**
 * What a digest item quotes: of the reply's last six sentences (footer cut), the last one that
 * asks (ends in "?"), else the last with an asking phrase, else the very last; read on from its
 * start, so a "Still waiting on you:" heading keeps the list after it. Markdown emphasis dropped,
 * whitespace collapsed, capped at SENTENCE_MAX.
 */
export function lastSentence(text: string): string {
  const flat = squash(withoutFooter(text).replace(/```[\s\S]*?```/g, " ").replace(/\*\*|__/g, ""));
  if (!flat) return "";
  // A sentence ends at . ! ? (and any closing quote or bracket) followed by whitespace or the end:
  // the dot in `notes.md`, `v1.2` or `e.g` is not an end.
  const parts = flat.split(/(?<=[.!?]+["'`)\]]*)\s+/).map((p) => p.trim()).filter(Boolean);
  const recent = parts.slice(-6).reverse();
  const pick = recent.find((p) => p.endsWith("?")) ?? recent.find((p) => ASK_RE.test(p)) ?? recent[0] ?? "";
  return head(flat.slice(flat.lastIndexOf(pick)), SENTENCE_MAX);
}

function recentTools(tools: readonly ToolCallFact[]): JsonObject[] {
  return tools.slice(-CAP.tools).map((t) => ({ tool: t.name, summary: head(squash(t.result || t.args), CAP.tool) }));
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

/** The state of an asks-only check: the title, the ask's context and the reply's end, footer cut. */
export function asksState(title: string, f: Pick<TurnFacts, "lastUser" | "assistantLast">): JsonObject {
  return {
    title: head(squash(title), CAP.title),
    last_user_message: head(f.lastUser, ASK_USER_CHARS),
    assistant_last: tail(withoutFooter(f.assistantLast), ASK_TAIL_CHARS),
  };
}

/** The state of one worker's CURRENT turn, capped. The caller redacts it. */
export function workerState(w: Pick<WorkerInfo, "name" | "status" | "preview">, s: Pick<WorkerTranscriptSummary, "lastAssistantText" | "lastOutcome" | "partialTurn" | "items">, now: number): JsonObject {
  const turn = currentWorkerTurn(s.items ?? []);
  const items = turn.items;
  const tools = workerTools(items);
  const task = [...(s.items ?? [])].reverse().find((i) => i.kind === "task" && !parseWakeNudge(i.text))?.text ?? w.preview ?? "";
  const errors = items.filter((i) => i.kind === "error").map((i) => i.text);
  const assistantLast = [...items].reverse().find((i) => i.kind === "assistant")?.text ?? "";
  return {
    title: head(squash(w.name), CAP.title),
    task: head(task, CAP.user),
    assistant_last: tail(assistantLast, CAP.assistant),
    tool_calls_recent: recentTools(tools),
    repeats: repeats(tools),
    worker: {
      status: w.status,
      ...(s.lastOutcome ? { last_outcome: s.lastOutcome } : {}),
      ...(errors.length ? { error: head(squash(errors[errors.length - 1] ?? ""), CAP.error) } : {}),
      ended_mid_turn: s.partialTurn,
      turn_started_by: turn.startedBy,
      turn_running_min: turn.startedAt ? Math.round((now - turn.startedAt) / 60_000) : 0,
    },
  };
}

// ---- questions (ids are the store's contract) ----------------------------------------------------

export const STUCK: Question = {
  type: "score",
  instructions:
    "Is the agent making progress or going in circles? `repeats.same_tool_and_args_in_a_row` is the longest run of identical consecutive tool calls; `repeats.distinct_files_touched` is how many different files it touched. Waiting is not looping: a scheduled wake-up, checking a roster or inbox and then scheduling the next check, or waiting on other workers is progress if each cycle is short and ends by going back to wait. Judge only this turn.",
  levels: ["making progress", "some repetition", "clearly looping or stuck"],
};

export const ASKS_USER: Question = {
  type: "boolean",
  instructions:
    "Does `assistant_last` end by asking the user a question, or for a decision, an approval or information it needs before it can continue?",
  criteria: {
    true: "It waits on the user: a question, a choice to make, a confirmation, or something missing only the user can give.",
    false: "It reports what it did or found, or carries on by itself. A closing courtesy such as 'let me know if you want more' is not waiting.",
  },
};

/**
 * A main session's questions. `stuck` only for a long turn that did not mostly wait on workers;
 * `asks_user` only when the session has no open alignment question, a partner's link message did
 * not open the turn, and the reply's end looks like it asks. None: no model call.
 */
export function turnQuestions(f: TurnFacts, ctx: { openQuestions?: number } = {}): Record<string, Question> {
  const long = (f.durationMs >= LONG_TURN_MS || f.tools.length >= LONG_TURN_TOOLS) && !mostlyWaits(f.tools);
  const asks = !(ctx.openQuestions && ctx.openQuestions > 0) && !isLinkMessage(f.lastUser) && !isTopicBatch(f.lastUser) && looksLikeAsk(f.assistantLast);
  return { ...(long ? { stuck: STUCK } : {}), ...(asks ? { asks_user: ASKS_USER } : {}) };
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
export function readTailBranch(path: string, maxBytes = TAIL_BYTES): Promise<HEntry[]> {
  return readTail(path, maxBytes);
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
  /** A parent session's team members' standing duties, by worker id (server/insights.ts). Absent:
      no worker is known to have one. */
  duties?: (parentPath: string) => Promise<Map<string, TeamDuty>>;
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
  /** A worker (workerKey) not worth reading again before this time: its turn is young, or a wake
      nudge started it. In memory: after a restart it is read once more. */
  private readonly nextLook = new Map<string, number>();
  /** Per session file: whether its last reply (at `replyAt`) waits on its subagents. */
  private readonly waitsCache = new Map<string, { replyAt: number; waits: boolean }>();
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
    if (!settings.features.attention) return 0;
    this.ticking = true;
    try {
      const list = await this.d.list();
      // Counted in code: runs with no provider too.
      await this.scanStalls(list);
      if (!this.d.provider()) return 0;
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
    const questions = turnQuestions(facts, { openQuestions: s.align?.openQuestions });
    // A turn with nothing to ask: no model call, and like an errored turn it replaces the turn
    // before it, so an older mark does not stay on the row.
    if (!Object.keys(questions).length) {
      this.forgetBefore(s.id, facts.replyAt);
      return false;
    }
    const key = `${s.id}:${facts.turnId}`;
    const state = questions.stuck ? turnState(s.title, facts) : asksState(s.title, facts);
    // The usage ledger: this decision is the session's one-shot.
    const result = await withUsageContext({ owner: s.id, cwd: s.cwd, kind: "oneshot" }, () => this.decide(key, "attention", state, questions));
    if (!result) return false;
    // The feature or the session's eligibility may have changed while the call ran: then drop it.
    if (exclusionReason(s, this.d.settings(), this.d.held(s.path), this.d.home)) return true;
    const f = facts;
    const detail = questions.asks_user ? this.d.redact(lastSentence(f.assistantLast)) : "";
    updateSignals((data) => {
      data.sessions[s.id] = {
        turnId: f.turnId,
        replyAt: f.replyAt,
        at: this.now(),
        provider: result.provider,
        model: result.model,
        answers: result.answers,
        ...(detail ? { detail } : {}),
        schema: 2,
      };
    }, this.file());
    this.d.changed();
    return true;
  }

  /**
   * A turn that stopped with an error (or a short one) is not classified; the stored
   * answers of the turn before it are dropped, since a newer turn replaces them and they would otherwise mark the row still.
   */
  private forgetBefore(id: string, replyAt: number): void {
    const stored = readSignals(this.file()).sessions[id];
    if (!stored || stored.replyAt >= replyAt) return;
    updateSignals((data) => void delete data.sessions[id], this.file());
    this.d.changed();
  }

  /** Every session waiting on a stalled team, stored; one that no longer is, dropped. */
  private async scanStalls(list: readonly SessionSummary[]): Promise<void> {
    const byPath = new Map(list.map((s) => [s.path, s]));
    const now = this.now();
    const found = new Map<string, { since: number; names: string[] }>();
    for (const r of this.d.liveRecords()) {
      const s = r.sessionFile ? byPath.get(r.sessionFile) : undefined;
      if (!s || found.has(s.id)) continue;
      const workers = this.d.decodeWorkers(r.rec?.presence);
      const reply = this.d.lastReply(s.path);
      // Cheap facts first: the duties are read only for an idle session with subagents.
      if (!workers.length || reply?.stopReason !== "stop" || s.busy || s.activity?.state === "working") continue;
      const duties = this.d.duties ? await this.d.duties(s.path).catch(() => new Map<string, TeamDuty>()) : new Map<string, TeamDuty>();
      const stall = quietTeam(s, workers, duties, reply, now);
      if (!stall || !(await this.waitsOnTeam(s.path, reply.at))) continue;
      found.set(s.id, stall);
    }
    const stored = readSignals(this.file()).stalls;
    const same = (a: StoredStall | undefined, b: { since: number; names: string[] }) => !!a && a.since === b.since && a.names.join("\n") === b.names.join("\n");
    const gone = Object.keys(stored).filter((id) => !found.has(id));
    const fresh = [...found].filter(([id, st]) => !same(stored[id], st));
    if (!gone.length && !fresh.length) return;
    updateSignals((data) => {
      for (const id of gone) delete data.stalls[id];
      for (const [id, st] of fresh) data.stalls[id] = { ...st, at: now };
    }, this.file());
    this.d.changed();
  }

  /** Whether a session's last reply waits on its subagents: read once per reply. */
  private async waitsOnTeam(path: string, replyAt: number): Promise<boolean> {
    const hit = this.waitsCache.get(path);
    if (hit?.replyAt === replyAt) return hit.waits;
    let waits = false;
    try {
      const facts = turnFacts(await readTailBranch(path));
      waits = !!facts && waitsOnTeam(facts.assistantLast);
    } catch {
      // unreadable: not stalled this scan
    }
    if (this.waitsCache.size > 500) this.waitsCache.clear();
    this.waitsCache.set(path, { replyAt, waits });
    return waits;
  }

  /** Stuck checks for workers whose current turn runs long. */
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
      let duties: Map<string, TeamDuty> | undefined;
      for (const w of this.d.decodeWorkers(r.rec?.presence)) {
        if (used >= budget) break;
        // ag_NN repeats across sessions: a worker is its parent's id and its own.
        const key = workerKey(parent.id, w.id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!w.working) continue;
        const stored = readSignals(this.file()).workers[key];
        if (stored && now - stored.at < WORKER_STUCK_EVERY_MS) continue;
        if ((this.nextLook.get(key) ?? 0) > now) continue;
        // A monitor or coordinator polls on purpose: never checked.
        duties ??= this.d.duties ? await this.d.duties(parent.path).catch(() => new Map<string, TeamDuty>()) : new Map<string, TeamDuty>();
        if (duties.has(w.id)) continue;
        if (await this.checkWorker(parent, w, key)) used++;
      }
    }
    if (this.nextLook.size > 2000) this.nextLook.clear();
    return used;
  }

  private async checkWorker(parent: SessionSummary, w: WorkerInfo, key: string): Promise<boolean> {
    const ref = workerRef(w);
    if (!ref) return false;
    const adapter = this.d.adapters().get(ref.backend);
    const caps = adapter.capabilities();
    // Without items there is no current turn to judge.
    if (!caps.read || !caps.items) return false;
    let summary: WorkerTranscriptSummary;
    try {
      summary = await adapter.read(ref, { items: "tail", limit: WORKER_ITEMS });
    } catch {
      return false;
    }
    if (!summary.found) return false;
    const now = this.now();
    const turn = currentWorkerTurn(summary.items ?? []);
    // A turn a wake nudge started is a scheduled check-in: not judged (looked at again next turn).
    if (turn.startedBy === "wake_nudge") {
      this.nextLook.set(key, now + WORKER_STUCK_EVERY_MS);
      return false;
    }
    // The gate is the CURRENT turn's age, not the worker's since its first spawn.
    const running = turn.startedAt ? now - turn.startedAt : 0;
    if (running < WORKER_STUCK_AFTER_MS) {
      this.nextLook.set(key, turn.startedAt ? turn.startedAt + WORKER_STUCK_AFTER_MS : now + WORKER_STUCK_EVERY_MS);
      return false;
    }
    const prev = readSignals(this.file()).workers[key];
    const sameTurn = !!prev && prev.turnStart === turn.startedAt;
    const base = { sessionId: parent.id, workerId: w.id, kind: "stuck" as const, name: head(squash(w.name), 80), turnStart: turn.startedAt };
    // Counted in code first: a turn that neither repeats itself nor keeps failing is progress, and
    // no model is asked.
    if (!workerSuspect(workerTools(turn.items), running)) {
      updateSignals((data) => {
        data.workers[key] = { ...base, at: this.now(), mechanical: true, answers: {} };
      }, this.file());
      this.d.changed();
      return false;
    }
    // A stuck check is keyed by its time slot.
    const dedupe = `${key}:stuck:${Math.floor(now / WORKER_STUCK_EVERY_MS)}`;
    // The usage ledger: a worker's stuck check is a one-shot of the session that runs it.
    const result = await withUsageContext({ owner: parent.id, cwd: parent.cwd, kind: "oneshot" }, () => this.decide(dedupe, "worker", workerState(w, summary, now), { stuck: STUCK }));
    if (!result) return false;
    // Two strikes: a looping answer counts only after a looping one before it in the same turn.
    const strikes = isLooping(result.answers) ? (sameTurn && prev && isLooping(prev.answers) ? (prev.strikes ?? 1) : 0) + 1 : 0;
    updateSignals((data) => {
      data.workers[key] = { ...base, at: this.now(), provider: result.provider, model: result.model, answers: result.answers, strikes };
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
