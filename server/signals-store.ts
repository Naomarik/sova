import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionProviderId, SessionSignals, SignalKind } from "../shared/protocol";
import type { Answer } from "./decide";
import { stateRoot } from "./state-root";

/**
 * The attention-signals store: `<stateRoot>/signals.json`, the RAW answers of every classified
 * finished turn (one per session, the latest) and of every worker check (one per parent session and
 * worker id: `workerKey`; `ag_NN` alone repeats across sessions, and records keyed by it alone are
 * dropped on load).
 * Written only by server/attention-signals.ts; read by the session list's overlay (`signalsOverlay`,
 * `workerSignalsOverlay`). Never a byte of this goes into a session file.
 *
 * The thresholds live here and are applied at READ time, so moving one needs no re-classification.
 * Whether a turn FAILED is not a question here: that is the file's own stopReason, read by the
 * session list (SessionSummary.turnError). Whether a reply ASKS the user something is `asks_user`,
 * asked only of a session with no open alignment question (those are SessionSummary.align, counted
 * from the file). Records written before may still carry `outcome` or `work_failed` answers;
 * nothing reads them, and a worker "outcome" check is dropped on load.
 * Same store rules as seen.ts: re-read and merge before writing, atomic tmp+rename, ~1 s read cache.
 */

/** asks_user.p at or above → "asks-you". */
export const ASKS_USER_MIN = 0.5;
/** stuck score (0..2) at or above, with confidence at or above STUCK_CONFIDENCE_MIN → "looping". */
export const STUCK_SCORE_MIN = 1.5;
export const STUCK_CONFIDENCE_MIN = 0.5;
/** A worker's "looping" is current only this long after its check (checks repeat every 5 min while it runs). */
export const WORKER_STUCK_FRESH_MS = 11 * 60_000;
/** A worker counts as looping after this many looping answers in a row in one turn. */
export const WORKER_STRIKES = 2;

/** One classified main-thread turn. */
export interface StoredTurn {
  /** Id of the last assistant entry on the active branch: the cache key with the session id. */
  turnId: string;
  /** ms epoch of that reply (the list's lastReplyAt compares against it). */
  replyAt: number;
  /** ms epoch it was classified. */
  at: number;
  provider: DecisionProviderId;
  model: string;
  answers: Record<string, Answer>;
  /** The reply's asking sentence (when `asks_user` was asked), redacted and capped: the digest's
      detail. Local only: never on the list or the feed. */
  detail?: string;
  /** 2: written since `asks_user` came back (§app.decisions/asks-user). An older record's
      `asks_user` answer (asked of every turn, before 28 Sep 2026) is dropped on load. */
  schema?: 2;
}

/** One "stuck" check of a running subagent worker's current turn (repeated while it runs). */
export interface StoredWorker {
  /** The parent session's id. */
  sessionId: string;
  /** The worker's own id (ag_NN). */
  workerId?: string;
  kind: "stuck";
  at: number;
  /** The worker's name, for the digest's detail. */
  name?: string;
  /** ms epoch the checked turn started (its last task item): strikes count within one turn. */
  turnStart?: number;
  /** Counted in code as making progress: no model was asked (`answers` is empty). */
  mechanical?: true;
  /** Looping answers in a row in this turn, this one included; 0 when this one is not looping. */
  strikes?: number;
  provider?: DecisionProviderId;
  model?: string;
  answers: Record<string, Answer>;
}

/** A worker's store key: its parent session's id and its own. */
export const workerKey = (sessionId: string, workerId: string) => `${sessionId}:${workerId}`;

/** A session waiting on subagents that have all gone quiet (§app.decisions/team-stall), counted in
    code: no model, no answers. Re-checked every scan; absent once any condition fails. */
export interface StoredStall {
  /** ms epoch the quiet began: the later of the last reply and the subagents' last activity. */
  since: number;
  /** ms epoch of the scan that found it. */
  at: number;
  /** The quiet subagents' names, for the digest's detail. */
  names: string[];
}

export interface SignalsFile {
  version: 1;
  sessions: Record<string, StoredTurn>;
  workers: Record<string, StoredWorker>;
  /** By session id. Older files have none. */
  stalls: Record<string, StoredStall>;
}

const empty = (): SignalsFile => ({ version: 1, sessions: {}, workers: {}, stalls: {} });
export const signalsFile = () => join(stateRoot(), "signals.json");

const isRec = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Tolerant read: a malformed file or record is dropped, never thrown. */
function load(file: string): SignalsFile {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!isRec(v) || v.version !== 1) return empty();
    const out = empty();
    if (isRec(v.sessions))
      for (const [k, t] of Object.entries(v.sessions))
        if (isRec(t) && typeof t.turnId === "string" && typeof t.at === "number" && isRec(t.answers)) {
          if (t.schema !== 2 && "asks_user" in t.answers) {
            const { asks_user: _old, ...answers } = t.answers;
            out.sessions[k] = { ...(t as StoredTurn), answers };
          } else out.sessions[k] = t as StoredTurn;
        }
    if (isRec(v.workers))
      for (const [k, w] of Object.entries(v.workers))
        // A key without its session (a bare ag_NN, from before) collided across sessions: dropped.
        if (k.includes(":") && isRec(w) && typeof w.sessionId === "string" && w.kind === "stuck" && typeof w.at === "number" && isRec(w.answers))
          out.workers[k] = w as StoredWorker;
    if (isRec(v.stalls))
      for (const [k, t] of Object.entries(v.stalls))
        if (isRec(t) && typeof t.since === "number" && typeof t.at === "number" && Array.isArray(t.names))
          out.stalls[k] = { since: t.since, at: t.at, names: t.names.filter((n: unknown): n is string => typeof n === "string") };
    return out;
  } catch {
    return empty();
  }
}

let cache: { file: string; at: number; data: SignalsFile } | null = null;
const CACHE_MS = 1000;

export function readSignals(file = signalsFile()): SignalsFile {
  const now = Date.now();
  if (cache && cache.file === file && now - cache.at < CACHE_MS) return cache.data;
  const data = load(file);
  cache = { file, at: now, data };
  return data;
}

/** Re-read, apply `fn`, write atomically. Returns the written data (unchanged on a write failure). */
export function updateSignals(fn: (data: SignalsFile) => void, file = signalsFile()): SignalsFile {
  const data = load(file);
  fn(data);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
    cache = { file, at: Date.now(), data };
  } catch (err) {
    console.warn("[signals] write failed:", err instanceof Error ? err.message : String(err));
  }
  return data;
}

// ---- thresholds ---------------------------------------------------------------------------------

const boolP = (a: Answer | undefined) => (a?.type === "boolean" ? a.p : undefined);
const scoreOf = (a: Answer | undefined) => (a?.type === "score" ? a : undefined);

export function isLooping(answers: Record<string, Answer>): boolean {
  const s = scoreOf(answers.stuck);
  return !!s && s.score >= STUCK_SCORE_MIN && s.confidence >= STUCK_CONFIDENCE_MIN;
}

export function asksUser(answers: Record<string, Answer>): boolean {
  const p = boolP(answers.asks_user);
  return p !== undefined && p >= ASKS_USER_MIN;
}

/** A worker check that counts: fresh, and looping for the WORKER_STRIKES-th time in a row. */
export function workerStuck(w: StoredWorker, now: number): boolean {
  return w.kind === "stuck" && now - w.at <= WORKER_STUCK_FRESH_MS && isLooping(w.answers) && (w.strikes ?? 1) >= WORKER_STRIKES;
}

/** The kinds that fire for one turn's raw answers, most urgent first. */
export function signalKinds(answers: Record<string, Answer>): SignalKind[] {
  const out: SignalKind[] = [];
  if (asksUser(answers)) out.push("asks-you");
  if (isLooping(answers)) out.push("looping");
  return out;
}

/** A stored turn as the wire carries it. */
export function toWire(t: StoredTurn): SessionSignals {
  const p = boolP(t.answers.asks_user);
  const s = scoreOf(t.answers.stuck);
  return {
    at: t.at,
    turnId: t.turnId,
    provider: t.provider,
    ...(p !== undefined ? { asksUser: p } : {}),
    ...(s ? { stuck: { score: s.score, confidence: s.confidence } } : {}),
    kinds: signalKinds(t.answers),
  };
}

/**
 * The raw `asks_user` answer of a session's last classified turn, whatever the user has seen:
 * undefined when that turn was not asked (a newer turn with nothing to ask drops the record).
 * For merge readiness (a branch waiting on the user's go-ahead).
 */
export function asksUserOf(sessionId: string, data = readSignals()): { turnId: string; replyAt: number; p: number; asks: boolean } | undefined {
  const t = data.sessions[sessionId];
  const p = t ? boolP(t.answers.asks_user) : undefined;
  return t && p !== undefined ? { turnId: t.turnId, replyAt: t.replyAt, p, asks: p >= ASKS_USER_MIN } : undefined;
}

/**
 * The digest's words for a session's signals (server/attention.ts AttentionRow.signalText): the
 * stored asking sentence, and the names of workers whose stuck check counts. Read only to word
 * items the list's overlay already decided to show.
 */
export function signalTextOf(id: string, now = Date.now(), data = readSignals()): { sentence?: string; stuckWorkers: string[] } {
  const t = data.sessions[id];
  const stuckWorkers = Object.values(data.workers)
    .filter((w) => w.sessionId === id && workerStuck(w, now))
    .map((w) => w.name ?? "unnamed");
  return { ...(t?.detail ? { sentence: t.detail } : {}), stuckWorkers };
}

/** A session's stalled team (§app.decisions/team-stall), for the digest: when the quiet began and
    who is quiet. The scan keeps it current; undefined when it does not hold. */
export function teamStallOf(id: string, data = readSignals()): { since: number; names: string[] } | undefined {
  const t = data.stalls[id];
  return t ? { since: t.since, names: t.names } : undefined;
}

// ---- the list overlay ---------------------------------------------------------------------------

export interface OverlayContext {
  /** The attention feature is on (Settings → Decisions). Off: nothing shows. */
  enabled: boolean;
  seenAt?: number;
  /** A pane has the session on screen. */
  viewing: boolean;
  /** The session is mid-turn (a signal is about the turn that finished before it). */
  running: boolean;
}

/** Newer than the user's last look. A never-stamped session has not been looked at. */
const unseen = (at: number, ctx: OverlayContext) => !ctx.viewing && (ctx.seenAt === undefined || ctx.seenAt < at);

/**
 * `SessionSummary.signals`, present only while it should show: the feature is on, some kind
 * fires, no newer turn is running, and — for every kind but "asks-you", which stays until the
 * user answers — the user has not looked since (seen stamp, or a pane open now). "Present" =
 * "show the mark", for the sidebar, the feed and the digest alike.
 */
export function signalsOverlay(id: string, ctx: OverlayContext, data = readSignals()): SessionSignals | undefined {
  if (!ctx.enabled || ctx.running) return undefined;
  const t = data.sessions[id];
  if (!t) return undefined;
  const wire = toWire(t);
  // A reply that asks waits on the user until they answer (a newer turn replaces or drops it), like
  // open questions: a look does not clear it. The other kinds are news, gone once seen.
  const kinds = unseen(t.at, ctx) ? wire.kinds : wire.kinds.filter((k) => k === "asks-you");
  return kinds.length ? { ...wire, kinds } : undefined;
}

/**
 * `SessionSummary.workerSignals`: this session's workers whose latest "stuck" check counts (fresh:
 * a worker that stopped being checked stopped running; and looping twice in a row in one turn),
 * counting only checks newer than the user's last look. Absent when 0.
 */
export function workerSignalsOverlay(id: string, ctx: Omit<OverlayContext, "running">, now = Date.now(), data = readSignals()): { stuck: number } | undefined {
  if (!ctx.enabled) return undefined;
  let stuck = 0;
  for (const w of Object.values(data.workers)) {
    if (w.sessionId !== id || !unseen(w.at, { ...ctx, running: false })) continue;
    if (workerStuck(w, now)) stuck++;
  }
  return stuck ? { stuck } : undefined;
}
