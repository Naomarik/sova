import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionProviderId, SessionSignals, SignalKind, SignalOutcome } from "../shared/protocol";
import type { Answer } from "./decide";
import { stateRoot } from "./state-root";

/**
 * The attention-signals store: `<stateRoot>/signals.json`, the RAW answers of every classified
 * finished turn (one per session, the latest) and of every worker check (one per worker id).
 * Written only by server/attention-signals.ts; read by the session list's overlay (`signalsOverlay`,
 * `workerSignalsOverlay`). Never a byte of this goes into a session file.
 *
 * The thresholds live here and are applied at READ time, so moving one needs no re-classification.
 * Same store rules as seen.ts: re-read and merge before writing, atomic tmp+rename, ~1 s read cache.
 */

/** asks_user.p at or above → "asks-you". */
export const ASKS_USER_MIN = 0.7;
/** outcome "failed" with confidence at or above → "task-failed". */
export const FAILED_CONFIDENCE_MIN = 0.5;
/** work_failed.p at or above → "task-failed" too (the narrow question; see attention-signals.ts WORK_FAILED). */
export const WORK_FAILED_MIN = 0.7;
/** stuck score (0..2) at or above, with confidence at or above STUCK_CONFIDENCE_MIN → "looping". */
export const STUCK_SCORE_MIN = 1.5;
export const STUCK_CONFIDENCE_MIN = 0.5;
/** A worker's "looping" is current only this long after its check (checks repeat every 5 min while it runs). */
export const WORKER_STUCK_FRESH_MS = 11 * 60_000;

export const OUTCOMES: readonly SignalOutcome[] = ["done", "partial", "failed", "blocked_on_user"];

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
  /** The reply's last sentence (the asking one, when it asks), redacted and capped: the digest's
      detail. Local only: never on the list or the feed. */
  detail?: string;
}

/** One check of a subagent worker: "stuck" while it runs (repeated), "outcome" once it ended. */
export interface StoredWorker {
  /** The parent session's id. */
  sessionId: string;
  kind: "stuck" | "outcome";
  at: number;
  /** For "outcome": the worker's endedAt the check was for. */
  endedAt?: number;
  /** The worker's name, for the digest's detail. */
  name?: string;
  provider: DecisionProviderId;
  model: string;
  answers: Record<string, Answer>;
}

export interface SignalsFile {
  version: 1;
  sessions: Record<string, StoredTurn>;
  workers: Record<string, StoredWorker>;
}

const empty = (): SignalsFile => ({ version: 1, sessions: {}, workers: {} });
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
        if (isRec(t) && typeof t.turnId === "string" && typeof t.at === "number" && isRec(t.answers)) out.sessions[k] = t as StoredTurn;
    if (isRec(v.workers))
      for (const [k, w] of Object.entries(v.workers))
        if (isRec(w) && typeof w.sessionId === "string" && (w.kind === "stuck" || w.kind === "outcome") && typeof w.at === "number" && isRec(w.answers))
          out.workers[k] = w as StoredWorker;
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
const choiceOf = (a: Answer | undefined) => (a?.type === "choice" ? a : undefined);
const scoreOf = (a: Answer | undefined) => (a?.type === "score" ? a : undefined);

export function isLooping(answers: Record<string, Answer>): boolean {
  const s = scoreOf(answers.stuck);
  return !!s && s.score >= STUCK_SCORE_MIN && s.confidence >= STUCK_CONFIDENCE_MIN;
}

export function isFailed(answers: Record<string, Answer>): boolean {
  const o = choiceOf(answers.outcome);
  const w = boolP(answers.work_failed);
  return (!!o && o.choice === "failed" && o.confidence >= FAILED_CONFIDENCE_MIN) || (w !== undefined && w >= WORK_FAILED_MIN);
}

/** The kinds that fire for one turn's raw answers, most urgent first. */
export function signalKinds(answers: Record<string, Answer>): SignalKind[] {
  const out: SignalKind[] = [];
  const p = boolP(answers.asks_user);
  if (p !== undefined && p >= ASKS_USER_MIN) out.push("asks-you");
  if (isFailed(answers)) out.push("task-failed");
  if (isLooping(answers)) out.push("looping");
  return out;
}

/** A stored turn as the wire carries it. */
export function toWire(t: StoredTurn): SessionSignals {
  const p = boolP(t.answers.asks_user);
  const wf = boolP(t.answers.work_failed);
  const o = choiceOf(t.answers.outcome);
  const s = scoreOf(t.answers.stuck);
  return {
    at: t.at,
    turnId: t.turnId,
    provider: t.provider,
    ...(p !== undefined ? { asksUser: p } : {}),
    ...(wf !== undefined ? { workFailed: wf } : {}),
    ...(o && (OUTCOMES as string[]).includes(o.choice) ? { outcome: { choice: o.choice as SignalOutcome, confidence: o.confidence } } : {}),
    ...(s ? { stuck: { score: s.score, confidence: s.confidence } } : {}),
    kinds: signalKinds(t.answers),
  };
}

/**
 * The digest's words for a session's signals (server/attention.ts AttentionRow.signalText): the
 * stored reply sentence, and the names of workers whose stuck check is current and fires. Read only
 * to word items the list's overlay already decided to show.
 */
export function signalTextOf(id: string, now = Date.now(), data = readSignals()): { sentence?: string; stuckWorkers: string[] } {
  const t = data.sessions[id];
  const stuckWorkers = Object.values(data.workers)
    .filter((w) => w.sessionId === id && w.kind === "stuck" && now - w.at <= WORKER_STUCK_FRESH_MS && isLooping(w.answers))
    .map((w) => w.name ?? "unnamed");
  return { ...(t?.detail ? { sentence: t.detail } : {}), stuckWorkers };
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
 * fires, and the user has not looked since (seen stamp, or a pane open now), and no newer turn
 * is running. "Present" = "show the mark", for the sidebar, the feed and the digest alike.
 */
export function signalsOverlay(id: string, ctx: OverlayContext, data = readSignals()): SessionSignals | undefined {
  if (!ctx.enabled || ctx.running) return undefined;
  const t = data.sessions[id];
  if (!t || !unseen(t.at, ctx)) return undefined;
  const wire = toWire(t);
  return wire.kinds.length ? wire : undefined;
}

/**
 * `SessionSummary.workerSignals`: this session's workers whose latest check fires — "stuck" while
 * that check is fresh (a worker that stopped being checked stopped running), "failed" from an
 * outcome check — counting only checks newer than the user's last look. Absent when both are 0.
 */
export function workerSignalsOverlay(id: string, ctx: Omit<OverlayContext, "running">, now = Date.now(), data = readSignals()): { stuck: number; failed: number } | undefined {
  if (!ctx.enabled) return undefined;
  let stuck = 0;
  let failed = 0;
  for (const w of Object.values(data.workers)) {
    if (w.sessionId !== id || !unseen(w.at, { ...ctx, running: false })) continue;
    if (w.kind === "stuck" && now - w.at <= WORKER_STUCK_FRESH_MS && isLooping(w.answers)) stuck++;
    if (w.kind === "outcome" && isFailed(w.answers)) failed++;
  }
  return stuck || failed ? { stuck, failed } : undefined;
}
