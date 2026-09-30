import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionSettings, SessionReadiness } from "../shared/protocol";
import { type Answer, DecisionError, type DecisionProvider, type JsonObject, type Question } from "./decide";
import { maySend } from "./decide-settings";
import { stateRoot } from "./state-root";

/**
 * One follow-up check per merge (§app.decisions/merge-followup): on the first reply that ends a turn
 * after a `worktree-merge` card, ask the decision seam whether that reply leaves real work open
 * beyond the routine restart, push and cleanup that merge readiness (server/merge-readiness.ts)
 * already knows mechanically, and how much. Runs only with attention signals on, through the same
 * privacy gate. Stored per merge card in `<stateRoot>/merge-followups.json`; the model never writes
 * the follow-up itself, the cue is the reply's own line.
 */

/** A reply older than this is never sent: switching the feature on doesn't check old merges. */
export const FOLLOW_UP_FRESH_MS = 24 * 60 * 60 * 1000;
/** A failed check is retried after this, at most FOLLOW_UP_ATTEMPTS times per card. */
export const FOLLOW_UP_RETRY_MS = 5 * 60 * 1000;
export const FOLLOW_UP_ATTEMPTS = 3;
/** Thresholds, fixed in code. */
export const FOLLOW_UP_P_MIN = 0.5;
export const FOLLOW_UP_SCORE_MIN = 0.5;
export const FOLLOW_UP_SIGNIFICANT = 1.5;
export const FOLLOW_UP_CONFIDENCE_MIN = 0.5;
export const REPLY_TAIL_MAX = 1500;

export const FOLLOW_UP_QUESTIONS: Record<"follow_up" | "follow_up_weight", Question> = {
  follow_up: {
    type: "boolean",
    instructions:
      "`reply` is a coding assistant's reply right after it merged a branch. Does it name work that is still to be done beyond restarting a server, pushing, or cleaning up worktrees: open gaps, a known regression or failure, parts it says are not verified or not covered, or something it says it would fix separately? `routine` lists the restart, push and cleanup follow-ups already known; never count those.",
    criteria: {
      true: "The reply leaves real work open.",
      false: "Nothing is left beyond routine restart, push or cleanup notes.",
    },
  },
  follow_up_weight: {
    type: "score",
    instructions: "How much known-unfinished work does this merge leave, beyond restart, push or cleanup? `reply` is the assistant's reply after the merge.",
    levels: ["none", "small", "significant"],
  },
};

export interface FollowUpRecord {
  /** ms epoch answered. */
  at: number;
  /** The reply it was asked about. */
  replyId: string;
  /** The reply's own line naming open work, else its Deferred: line, else "see the reply after merging <branch>". */
  cue: string;
  answers: { follow_up?: Answer; follow_up_weight?: Answer };
  provider: string;
  model: string;
}

interface Store {
  cards: Record<string, FollowUpRecord>;
}

export const followUpsFile = () => join(stateRoot(), "merge-followups.json");

/** Store key: one per merge card of one session. */
export const followUpKey = (sessionId: string, cardId: string) => `${sessionId}:${cardId}`;

function load(file: string): Store {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { cards?: unknown };
    if (v && typeof v.cards === "object" && v.cards && !Array.isArray(v.cards)) return { cards: v.cards as Record<string, FollowUpRecord> };
  } catch {
    // missing or unreadable: empty
  }
  return { cards: {} };
}

let cached: { file: string; store: Store } | null = null;
function readStore(file = followUpsFile()): Store {
  if (cached?.file !== file) cached = { file, store: load(file) };
  return cached.store;
}
function writeStore(store: Store, file = followUpsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
  cached = { file, store };
}

/** What the badge and the digest read from a record: work named, and how much; undefined = none. */
export function followUpOf(rec: FollowUpRecord | undefined): SessionReadiness["followUp"] {
  const f = rec?.answers.follow_up;
  const w = rec?.answers.follow_up_weight;
  if (f?.type !== "boolean" || f.p < FOLLOW_UP_P_MIN) return undefined;
  if (w?.type !== "score" || w.score < FOLLOW_UP_SCORE_MIN) return undefined;
  const weight = w.score >= FOLLOW_UP_SIGNIFICANT && w.confidence >= FOLLOW_UP_CONFIDENCE_MIN ? "significant" : "small";
  return { weight, cue: rec!.cue };
}

/** The stored answer for one card, as the badge reads it. */
export function followUpFor(sessionId: string, cardId: string): SessionReadiness["followUp"] {
  return followUpOf(readStore().cards[followUpKey(sessionId, cardId)]);
}

/** Lines that name open work; routine restart, push and cleanup lines are not a cue. */
const CUE_RE = /open gaps?|\bgaps?\b|not (?:yet )?(?:verified|covered|tested|checked|fixed|done)|regress|still fails?|fails on|i'?d fix|fix (?:it|that|this|them) separately|separately|follow-?up|left (?:open|to do)|\btodo\b|known (?:issue|problem|bug)|unfinished|not a clean pass/i;
const ROUTINE_RE = /\brestart|\bpush|clean ?up|worktree remove|rebuild/i;

/** The reply's own first line naming open work (≤120 characters), else its Deferred: line, else a
    pointer to the reply ("see the reply after merging <branch>"): a bare branch name tells nothing. */
export function cueOf(reply: string, branch: string): string {
  const lines = reply.split("\n").map((l) => l.replace(/^[\s>*\-•\d.)]+/, "").replace(/[*_`]/g, "").trim()).filter(Boolean);
  const hit = lines.find((l) => CUE_RE.test(l) && !ROUTINE_RE.test(l) && !/^(?:deferred|also changes|plumbing):/i.test(l));
  const deferred = lines.find((l) => /^deferred:/i.test(l));
  const line = hit ?? deferred ?? `see the reply after merging ${branch}`;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** The reply's Deferred: line, when it has one. */
export function deferredOf(reply: string): string | undefined {
  return reply.split("\n").map((l) => l.trim()).find((l) => /^deferred:/i.test(l));
}

export interface FollowUpInput {
  sessionId: string;
  cardId: string;
  /** The session's folder and whether it is a terminal session (decide-settings terminalSession). */
  cwd: string;
  terminal: boolean;
  card: { branch: string; target: string; commits: number; added: number; removed: number };
  reply: { id: string; at: number; text: string };
  /** The mechanical follow-ups, so they are not judged again. */
  routine: { restart_pending: boolean; push_pending: boolean; cleanup: number };
}

export interface FollowUpDeps {
  provider: () => DecisionProvider;
  settings: () => DecisionSettings;
  ready?: () => boolean;
  now?: () => number;
  file?: () => string;
}

/** The state sent: small, and only what the question needs. */
export function followUpState(input: FollowUpInput): JsonObject {
  const text = input.reply.text;
  const deferred = deferredOf(text);
  // Readiness keeps the reply's body tail with its Deferred: line after it: that line goes apart.
  const body = deferred && text.endsWith(deferred) ? text.slice(0, -deferred.length).trimEnd() : text;
  return {
    merge: { ...input.card },
    reply: body.length > REPLY_TAIL_MAX ? body.slice(-REPLY_TAIL_MAX) : body,
    ...(deferred ? { deferred } : {}),
    routine: { ...input.routine },
  };
}

export class MergeFollowUps {
  /** In memory: attempts per card, so a failing check waits and gives up. */
  private readonly attempts = new Map<string, { n: number; at: number }>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: FollowUpDeps) {}

  private get file(): string {
    return this.deps.file?.() ?? followUpsFile();
  }

  /** The record for a card, if checked. */
  record(sessionId: string, cardId: string): FollowUpRecord | undefined {
    return readStore(this.file).cards[followUpKey(sessionId, cardId)];
  }

  /** Why this card is not sent now, or null when it may be. */
  skipReason(input: FollowUpInput): string | null {
    const now = this.deps.now?.() ?? Date.now();
    const key = followUpKey(input.sessionId, input.cardId);
    const rec = readStore(this.file).cards[key];
    if (rec && rec.replyId === input.reply.id) return "done";
    if (now - input.reply.at > FOLLOW_UP_FRESH_MS) return "old";
    const gate = maySend(this.deps.settings(), "attention", { cwd: input.cwd, terminal: input.terminal });
    if (!gate.ok) return gate.reason;
    if (this.deps.ready && !this.deps.ready()) return "unavailable";
    if (this.inFlight.has(key)) return "in-flight";
    const a = this.attempts.get(key);
    if (a && (a.n >= FOLLOW_UP_ATTEMPTS || now - a.at < FOLLOW_UP_RETRY_MS)) return "retry-later";
    return null;
  }

  /** Ask once for this card when allowed; true when a new answer was stored. Never throws. */
  async check(input: FollowUpInput): Promise<boolean> {
    if (this.skipReason(input) !== null) return false;
    const key = followUpKey(input.sessionId, input.cardId);
    const now = this.deps.now?.() ?? Date.now();
    this.inFlight.add(key);
    try {
      const result = await this.deps.provider().decide({ purpose: "merge-followup", state: followUpState(input), questions: FOLLOW_UP_QUESTIONS, dedupeKey: `merge-followup:${key}` });
      const store = readStore(this.file);
      store.cards[key] = {
        at: this.deps.now?.() ?? Date.now(),
        replyId: input.reply.id,
        cue: cueOf(input.reply.text, input.card.branch),
        answers: {
          ...(result.answers.follow_up ? { follow_up: result.answers.follow_up } : {}),
          ...(result.answers.follow_up_weight ? { follow_up_weight: result.answers.follow_up_weight } : {}),
        },
        provider: result.provider,
        model: result.model,
      };
      writeStore(store, this.file);
      this.attempts.delete(key);
      return true;
    } catch (err) {
      const prev = this.attempts.get(key);
      // A request the provider calls malformed is never retried.
      const n = err instanceof DecisionError && err.failure === "bad-request" ? FOLLOW_UP_ATTEMPTS : (prev?.n ?? 0) + 1;
      this.attempts.set(key, { n, at: now });
      console.warn(`[merge-followup] ${key}: ${(err as Error).message}`);
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Keep only the cards of listed sessions. */
  prune(sessionIds: ReadonlySet<string>): void {
    const store = readStore(this.file);
    let changed = false;
    for (const k of Object.keys(store.cards)) {
      if (sessionIds.has(k.slice(0, k.indexOf(":")))) continue;
      delete store.cards[k];
      changed = true;
    }
    if (changed) writeStore(store, this.file);
  }
}

/** Tests: forget the in-memory copy of the store. */
export function resetFollowUpCache(): void {
  cached = null;
}
