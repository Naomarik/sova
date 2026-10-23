import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASK_KINDS, type AskKind, type DecisionProviderId, TURN_OUTCOMES, type TurnOutcome } from "../shared/protocol";
import type { Answer } from "./decide";
import { stateRoot } from "./state-root";

/**
 * The per-turn outcomes (§app.decisions/attention-signals): every turn card's answers, kept by
 * session and turn id with the reply's time, in `<stateRoot>/turn-outcomes.json` — the durable
 * "work finished" record a branch's merge readiness can read (`latestOutcome`), unlike signals.json,
 * which keeps only a session's latest turn and drops it when a newer one has nothing to say.
 * The last KEEP_PER_SESSION turns per session; pruned when a session leaves the list. A sidecar:
 * never a byte into a session file. Atomic tmp+rename; a malformed record is dropped on read.
 */

export const KEEP_PER_SESSION = 20;
export const turnOutcomesFile = () => join(stateRoot(), "turn-outcomes.json");

export interface TurnOutcomeRecord {
  turnId: string;
  /** ms epoch of the reply the card judged. */
  replyAt: number;
  /** ms epoch it was judged. */
  at: number;
  provider: DecisionProviderId;
  model: string;
  outcome?: TurnOutcome;
  askKind?: AskKind;
  claimsUnverified?: number;
  leftOpen?: number;
}

interface OutcomesFile {
  version: 1;
  sessions: Record<string, TurnOutcomeRecord[]>;
}

const isRec = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanRecord(v: unknown): TurnOutcomeRecord | null {
  if (!isRec(v) || typeof v.turnId !== "string" || !fin(v.replyAt) || !fin(v.at) || typeof v.provider !== "string") return null;
  return {
    turnId: v.turnId,
    replyAt: v.replyAt,
    at: v.at,
    provider: v.provider as DecisionProviderId,
    model: typeof v.model === "string" ? v.model : "",
    ...((TURN_OUTCOMES as readonly string[]).includes(v.outcome) ? { outcome: v.outcome as TurnOutcome } : {}),
    ...((ASK_KINDS as readonly string[]).includes(v.askKind) ? { askKind: v.askKind as AskKind } : {}),
    ...(fin(v.claimsUnverified) ? { claimsUnverified: v.claimsUnverified } : {}),
    ...(fin(v.leftOpen) ? { leftOpen: v.leftOpen } : {}),
  };
}

function load(file: string): OutcomesFile {
  const out: OutcomesFile = { version: 1, sessions: Object.create(null) };
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!isRec(v) || v.version !== 1 || !isRec(v.sessions)) return out;
    for (const [id, list] of Object.entries(v.sessions)) {
      if (!Array.isArray(list)) continue;
      const recs = list.map(cleanRecord).filter((r): r is TurnOutcomeRecord => !!r);
      if (recs.length) out.sessions[id] = recs;
    }
  } catch {
    // missing or corrupt: empty
  }
  return out;
}

function write(file: string, data: OutcomesFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch (err) {
    console.warn("[turn-outcomes] write failed:", err instanceof Error ? err.message : String(err));
  }
}

const choiceOf = (a: Answer | undefined) => (a?.type === "choice" ? a.choice : undefined);
const pOf = (a: Answer | undefined) => (a?.type === "boolean" ? a.p : undefined);

/** One card's answers as a record. Pure. */
export function outcomeRecord(base: { turnId: string; replyAt: number; at: number; provider: DecisionProviderId; model: string; answers: Record<string, Answer> }): TurnOutcomeRecord {
  const a = base.answers;
  return cleanRecord({
    turnId: base.turnId,
    replyAt: base.replyAt,
    at: base.at,
    provider: base.provider,
    model: base.model,
    outcome: choiceOf(a.outcome),
    askKind: choiceOf(a.ask_kind),
    claimsUnverified: pOf(a.claims_unverified),
    leftOpen: pOf(a.left_open),
  })!;
}

/** Keep one card's answers for a session (the same turn again replaces its record). */
export function recordTurnOutcome(sessionId: string, base: Parameters<typeof outcomeRecord>[0], file = turnOutcomesFile()): void {
  const data = load(file);
  const rec = outcomeRecord(base);
  const list = (data.sessions[sessionId] ?? []).filter((r) => r.turnId !== rec.turnId);
  list.push(rec);
  list.sort((x, y) => x.replyAt - y.replyAt);
  data.sessions[sessionId] = list.slice(-KEEP_PER_SESSION);
  write(file, data);
}

/** A session's kept turn outcomes, oldest first. */
export function turnOutcomesOf(sessionId: string, file = turnOutcomesFile()): TurnOutcomeRecord[] {
  return load(file).sessions[sessionId] ?? [];
}

/** A session's newest outcome, optionally the newest whose reply came at or before `atOrBefore`. */
export function latestOutcome(sessionId: string, atOrBefore?: number, file = turnOutcomesFile()): TurnOutcomeRecord | undefined {
  const list = turnOutcomesOf(sessionId, file).filter((r) => atOrBefore === undefined || r.replyAt <= atOrBefore);
  return list[list.length - 1];
}

/** Drop the sessions not in `keep` (the listed ones). An empty listing is a failed one: nothing dropped. */
export function pruneTurnOutcomes(keep: ReadonlySet<string>, file = turnOutcomesFile()): void {
  if (!keep.size) return;
  const data = load(file);
  const gone = Object.keys(data.sessions).filter((id) => !keep.has(id));
  if (!gone.length) return;
  for (const id of gone) delete data.sessions[id];
  write(file, data);
}
