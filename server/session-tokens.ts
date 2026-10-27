import type { SessionTokens } from "../shared/protocol";
import { encodeSessionTokens } from "../shared/session-tokens-wire";
import { alignRing, MAX_SLOT_TOKENS, parseTokenRing, TOKEN_BUCKET_MS, TOKEN_SLOTS } from "./llm-inflight";

/**
 * Each Sova-hosted session's output tokens, for the Agents board's Tokens/min column
 * (§app.insights/session-token-rate). Fed from what every chat process (workers included) already
 * reports with its state (server/chat-host.ts), in memory only: no disk, no git, nothing per token.
 *
 * The tracker's own sum (pi-config llm-inflight/tracker.ts) is anonymous: a forgotten child's ring
 * goes into one `retired` ring and a reload's process replaces its gauge. This keeps, per session,
 * the last ring of each process it had (`kept`), attributed to that session and rolled up to its
 * parent's row, until the tokens age out of the 30-minute ring.
 *
 * A board row is keyed by its main thread's session id (the board's rows carry it). The answer is
 * built once per change and per 30 s slot, and every poll in between reads that one copy.
 */

/** What a chat process reports with its state (its mirror's `llm`), as far as this reads it. */
export interface ProcessReport {
  producer: string;
  claudeTurns?: number;
  degraded?: boolean;
  /** Producers whose rings this report's ring already includes. */
  folded?: readonly string[];
  tokens?: unknown;
}

export interface SessionNote {
  /** The chat's session id: a main thread's row key. */
  sessionId: string;
  /** A worker's parent's session id (any kind of worker chat: its tokens roll up to that row). */
  parent?: string;
  /** A hidden chat that is no board row and nobody's worker: never sent. */
  hidden?: boolean;
}

interface Ring {
  end: number;
  out: number[];
}

interface Entry {
  parent?: string;
  hidden: boolean;
  /** The process reporting now, with its last ring. */
  live: { producer: string; ring: Ring | null; partial: boolean; folded: readonly string[] } | null;
  /** The rings of its processes that went (exited, stopped, reloaded), summed. */
  kept: Ring | null;
  keptPartial: boolean;
  /** Producers already folded into `kept`: a late report from one adds nothing again. */
  gone: Set<string>;
}

const slotOf = (ms: number): number => Math.floor(ms / TOKEN_BUCKET_MS);
/** The 5-minute window: a session sends its slots only while it has tokens in it. */
const RECENT_SLOTS = 10;
/** How many parents a worker chain may climb before it is cut (a cycle guard). */
const MAX_DEPTH = 32;
/** The most entries kept at once: a bound on a buggy stream of session ids. */
const MAX_ENTRIES = 2000;

function addInto(into: number[], ring: Ring, end: number): void {
  const add = alignRing(ring, end);
  for (let i = 0; i < TOKEN_SLOTS; i++) into[i] = Math.min(MAX_SLOT_TOKENS * 10, (into[i] ?? 0) + (add[i] ?? 0));
}

/** Nothing of `ring` is left in the 30-minute window ending at slot `end` (no copy made). */
function agedOut(ring: Ring, end: number): boolean {
  // Slot j of the ring is epoch slot ring.end - (TOKEN_SLOTS - 1 - j); the window keeps > end - TOKEN_SLOTS.
  for (let j = 0; j < TOKEN_SLOTS; j++) if ((ring.out[j] ?? 0) > 0 && ring.end - (TOKEN_SLOTS - 1 - j) > end - TOKEN_SLOTS) return false;
  return true;
}

/**
 * The report says exactly what the live process last said: the same producer, flags, folds and ring,
 * compared on the raw report (a stored slot is the raw one unless the raw one was out of bounds, which
 * then reads as different and takes the full path).
 */
function repeats(live: NonNullable<Entry["live"]>, r: ProcessReport): boolean {
  if (live.producer !== r.producer) return false;
  const partialFlags = (r.claudeTurns ?? 0) > 0 || r.degraded === true;
  const t = r.tokens as { bucketMs?: unknown; end?: unknown; out?: unknown; partial?: unknown } | null | undefined;
  const ring = live.ring;
  if (!ring || !t || typeof t !== "object" || t.bucketMs !== TOKEN_BUCKET_MS || t.end !== ring.end) return false;
  if (live.partial !== (partialFlags || t.partial === true)) return false;
  const f = r.folded;
  const nf = Array.isArray(f) ? f.length : 0;
  if (nf !== live.folded.length) return false;
  for (let i = 0; i < nf; i++) if ((f as unknown[])[i] !== live.folded[i]) return false;
  const out = t.out;
  if (!Array.isArray(out) || out.length !== TOKEN_SLOTS) return false;
  for (let i = 0; i < TOKEN_SLOTS; i++) if (out[i] !== ring.out[i]) return false;
  return true;
}

export class SessionTokenStore {
  private readonly entries = new Map<string, Entry>();
  /** Bumped by every change a view could show. */
  private rev = 0;
  private cached: { rev: number; slot: number; view: Record<string, SessionTokens>; wire: Record<string, string> } | null = null;
  /** The slot of the last sweep: entries left by gone processes are pruned at most once per 30 s slot,
      from the store's own calls (no timer), so they go as they age out even with no board asking. */
  private sweptSlot = -1;

  constructor(private readonly now: () => number = Date.now) {}

  /** A chat process's state: its ring replaces its last one; a new process keeps the old one's tokens. */
  note(n: SessionNote, report: ProcessReport | undefined): void {
    if (!report || typeof report.producer !== "string" || !report.producer) return;
    this.maybeSweep();
    let e = this.entries.get(n.sessionId);
    if (!e) {
      if (this.entries.size >= MAX_ENTRIES) this.sweep();
      if (this.entries.size >= MAX_ENTRIES) return;
      e = { hidden: !!n.hidden, live: null, kept: null, keptPartial: false, gone: new Set() };
      this.entries.set(n.sessionId, e);
      this.rev++;
    }
    if (e.hidden !== !!n.hidden || (n.parent && e.parent !== n.parent)) {
      e.hidden = !!n.hidden;
      if (n.parent) e.parent = n.parent;
      this.rev++;
    }
    if (e.gone.has(report.producer)) return;
    // Most state reports repeat the last ring: read in place, nothing parsed or allocated.
    if (e.live && repeats(e.live, report)) return;
    if (e.live && e.live.producer !== report.producer) this.retire(e);
    const parsed = parseTokenRing(report.tokens);
    const live = {
      producer: report.producer,
      ring: parsed ? { end: parsed.end, out: parsed.out } : null,
      partial: !parsed || !!parsed.partial || (report.claudeTurns ?? 0) > 0 || report.degraded === true,
      folded: Array.isArray(report.folded) ? report.folded.filter((f) => typeof f === "string") : [],
    };
    if (!e.live || !sameLive(e.live, live)) this.rev++;
    e.live = live;
  }

  /** Its process is gone (an exit, a stop, an idle stop, a lost link): its tokens stay until they age out. */
  release(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e?.live) this.retire(e);
    this.maybeSweep();
  }

  private maybeSweep(): void {
    const slot = slotOf(this.now());
    if (slot === this.sweptSlot) return;
    this.sweptSlot = slot;
    this.sweep();
  }

  private retire(e: Entry): void {
    const live = e.live!;
    e.live = null;
    this.rev++;
    e.gone.add(live.producer);
    if (!live.ring) return;
    const end = Math.max(slotOf(this.now()), live.ring.end, e.kept?.end ?? 0);
    const out = e.kept ? alignRing(e.kept, end) : new Array<number>(TOKEN_SLOTS).fill(0);
    addInto(out, live.ring, end);
    e.kept = { end, out };
    e.keptPartial ||= live.partial;
  }

  /** Entries with no process and nothing left in the window go. */
  private sweep(): void {
    const end = slotOf(this.now());
    for (const [id, e] of this.entries) {
      if (e.live) continue;
      if (!e.kept || agedOut(e.kept, end)) {
        this.entries.delete(id);
        this.rev++;
      }
    }
  }

  /** How many sessions it holds (tests). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Per board row (the root session's id), its own and its workers' tokens at `now`: only rows
   * with tokens in the last 5 minutes, each with those 5 minutes' slots (from the oldest non-zero
   * one) and each part's 30 minutes' total, sent even when that part's 5 minutes are empty: what
   * the row's figures need, and no more.
   */
  view(): Record<string, SessionTokens> {
    return this.current().view;
  }

  /** The same, each row as one string (shared/session-tokens-wire.ts): what GET /api/insights/agents sends. */
  wire(): Record<string, string> {
    return this.current().wire;
  }

  private current(): { view: Record<string, SessionTokens>; wire: Record<string, string> } {
    const slot = slotOf(this.now());
    const c = this.cached;
    if (c && c.rev === this.rev && c.slot === slot) return c;
    const view = this.build(slot);
    const wire: Record<string, string> = {};
    for (const [id, t] of Object.entries(view)) wire[id] = encodeSessionTokens(t);
    this.cached = { rev: this.rev, slot, view, wire };
    return this.cached;
  }

  private build(end: number): Record<string, SessionTokens> {
    this.sweep();
    if (this.entries.size === 0) return {};
    // A process whose ring another's already includes is counted there only.
    const foldedAway = new Set<string>();
    for (const e of this.entries.values()) for (const f of e.live?.folded ?? []) if (f !== e.live!.producer) foldedAway.add(f);
    const rows = new Map<string, { own: number[] | null; workers: number[] | null; partial: boolean }>();
    for (const [id, e] of this.entries) {
      const live = e.live && !foldedAway.has(e.live.producer) ? e.live : null;
      const partial = !!live?.partial || e.keptPartial;
      if (!live?.ring && !e.kept && !partial) continue;
      const root = this.rootOf(id, e);
      if (!root) continue;
      let row = rows.get(root.id);
      if (!row) rows.set(root.id, (row = { own: null, workers: null, partial: false }));
      if (partial) row.partial = true;
      if (!live?.ring && !e.kept) continue;
      const key = root.self ? "own" : "workers";
      const into = (row[key] ??= new Array<number>(TOKEN_SLOTS).fill(0));
      if (live?.ring) addInto(into, live.ring, end);
      if (e.kept) addInto(into, e.kept, end);
    }
    const out: Record<string, SessionTokens> = {};
    for (const [rootId, row] of rows) {
      const own = recent(row.own);
      const workers = recent(row.workers);
      if (!own && !workers) continue;
      // Each part's 30-minute total goes whenever it has one, even when that part wrote nothing in
      // the last 5 minutes: the row's 30-minute figure counts both parts whole.
      const t: SessionTokens = { end };
      if (own) t.own = own;
      const own30 = row.own ? sum(row.own) : 0;
      if (own30 > 0) t.own30 = own30;
      if (workers) t.workers = workers;
      const workers30 = row.workers ? sum(row.workers) : 0;
      if (workers30 > 0) t.workers30 = workers30;
      if (row.partial) t.partial = true;
      out[rootId] = t;
    }
    return out;
  }

  /** The board row a session's tokens land on: itself unless it is a worker, then its topmost parent's. */
  private rootOf(id: string, e: Entry): { id: string; self: boolean } | null {
    if (!e.parent) return e.hidden ? null : { id, self: true };
    let cur = e.parent;
    const seen = new Set([id]);
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const up = this.entries.get(cur);
      if (!up?.parent) return up?.hidden ? null : { id: cur, self: false };
      cur = up.parent;
    }
    return null;
  }
}

/** The last 5 minutes' slots, oldest first, from the oldest non-zero one; null when all are 0. */
function recent(r: number[] | null): number[] | null {
  if (!r) return null;
  const last = r.slice(TOKEN_SLOTS - RECENT_SLOTS);
  const i = last.findIndex((n) => n > 0);
  return i < 0 ? null : last.slice(i);
}

const sum = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0);

const sameRing = (a: Ring | null, b: Ring | null): boolean => (!a || !b ? a === b : a.end === b.end && a.out.every((n, i) => n === b.out[i]));
const sameLive = (a: NonNullable<Entry["live"]>, b: NonNullable<Entry["live"]>): boolean =>
  a.producer === b.producer && a.partial === b.partial && sameRing(a.ring, b.ring) && a.folded.length === b.folded.length && a.folded.every((f, i) => f === b.folded[i]);

let shared: SessionTokenStore | null = null;

/** The server's one store (chat-host.ts feeds it, insights.ts reads it). */
export function sessionTokens(): SessionTokenStore {
  return (shared ??= new SessionTokenStore());
}
