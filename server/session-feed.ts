import type { SessionFeedMessage, SessionMarks, SessionSummary } from "../shared/protocol";
import { attentionChanged } from "./attention-memo";

/**
 * The session feed: WS /ws/watch?feed=sessions (shared/protocol.ts SessionFeedMessage). The server
 * PUSHES the list's decision overlays (`signals`, `workerSignals`, `tags`) and the turn-error mark
 * (`turnError`) so a mark appears or clears without waiting for the client's list poll.
 *
 * The overlays are read from the list itself (the caller's `list`, i.e. listSessions), never from
 * the stores directly: what the feed sends is exactly what the next poll would show, visibility
 * rules included (a signal is left out once seen, while viewed, while running). A re-diff runs only
 * on a nudge: a store wrote, a pane attached, the list generation moved (server/list-generation.ts),
 * or a watch saw a session file or a live record change (server/session-feed-watch.ts, so a turn
 * starting in a TUI still reaches it); a burst is one re-diff, at most one a second. A safety-net
 * re-diff runs once a minute while anyone listens. Nothing runs, and nothing is listed, while no
 * client is connected, nor while nothing changes.
 *
 * Each re-diff also builds the attention digest and the Overseer's state from its own list (`after`)
 * and sends each when it changed, so no window polls them.
 *
 * The same diff also sends `list_changed` when a row changed in a way the marks can't carry (a
 * session a TUI just created, one that went away, its live record, running state or last
 * activity): the client has no other way to learn of those short of its own focus or busy poll.
 */

type Send = (msg: SessionFeedMessage) => void;
const FIELDS = ["signals", "workerSignals", "tags", "turnError"] as const;

/** A row's overlays, or null when it has none. */
export function marksOf(s: SessionSummary): SessionMarks | null {
  const m: SessionMarks = { id: s.id, path: s.path };
  let any = false;
  for (const f of FIELDS) {
    if (s[f] === undefined) continue;
    (m as any)[f] = s[f];
    any = true;
  }
  return any ? m : null;
}

/**
 * What changed between the marks last sent and a fresh list: per session, only the fields that
 * differ (a value, or null when cleared); a session whose marks all went (or that left the list)
 * gets null for every field it had. `next` is the new baseline.
 */
export function diffMarks(prev: ReadonlyMap<string, SessionMarks>, list: readonly SessionSummary[]): { changes: SessionMarks[]; next: Map<string, SessionMarks> } {
  const next = new Map<string, SessionMarks>();
  for (const s of list) {
    const m = marksOf(s);
    if (m) next.set(s.id, m);
  }
  const changes: SessionMarks[] = [];
  for (const [id, now] of next) {
    const before = prev.get(id);
    const delta: SessionMarks = { id, path: now.path };
    let changed = false;
    for (const f of FIELDS) {
      const a = before?.[f];
      const b = now[f];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      (delta as any)[f] = b === undefined ? null : b;
      changed = true;
    }
    if (changed) changes.push(delta);
  }
  for (const [id, before] of prev) {
    if (next.has(id)) continue;
    const delta: SessionMarks = { id, path: before.path };
    for (const f of FIELDS) if (before[f] !== undefined) (delta as any)[f] = null;
    changes.push(delta);
  }
  return { changes, next };
}

/**
 * What of a row the marks can't carry but the sidebar shows: that it is listed at all, its live
 * record, whether it runs, its last activity, and a baton session's state (holder, Needs you,
 * waiting referrals: those change in the org's registry and roster, not the session file), and
 * its organization (an archived project leaves the Organizations region, §app.organizations/archive;
 * that changes in its project statechart, not the session file), and its title (a stored title changes in
 * Sova's title store, never in the file: the Overseer's rename, the automatic namer's,
 * §app.session-list/auto-titles), and its merge readiness (read from git in the background,
 * §chat.worktrees/readiness). A change to any of these is `list_changed` (the
 * client re-reads the list); a session a TUI just created is a new path here.
 */
export function rowSignature(s: SessionSummary): string {
  return JSON.stringify([s.live?.pid ?? null, s.live?.status ?? null, s.busy, s.activity?.state ?? null, s.lastActiveAt, s.archived, s.baton ?? null, s.org ?? null, s.title, s.readiness ?? null]);
}

/** Did the listed rows change beyond the marks: a path added or removed, or a signature changed. */
export function listChanged(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
  if (prev.size !== next.size) return true;
  for (const [path, sig] of next) if (prev.get(path) !== sig) return true;
  return false;
}

export interface SessionFeedOptions {
  list: () => Promise<SessionSummary[]>;
  /** The safety-net re-diff period while a client listens: for a change no source tells of. */
  intervalMs?: number;
  /** Debounce of nudges. */
  debounceMs?: number;
  /** The least time between the starts of two re-diffs (a burst of changes is one). */
  minGapMs?: number;
  /** What tells the feed that something a row reads may have changed (file watches, the live-record
      check): started with the first listener, stopped with the last. Returns its stop. */
  watch?: (changed: () => void) => () => void;
  /** Frames built from each re-diff's own list (the attention digest, the Overseer's state). Each
      is sent only when it differs from the last one of its type; the first is the baseline. */
  after?: (list: readonly SessionSummary[]) => Promise<SessionFeedMessage[]>;
  /** What of an `after` frame is compared (default: all of it): a build's own time is no change. */
  frameKey?: (frame: SessionFeedMessage) => string;
}

/** Once a minute: re-diffs are change-driven, this only catches what no source tells of. */
export const SAFETY_NET_MS = 60_000;

export class SessionFeed {
  private readonly clients = new Set<Send>();
  /** Listeners whose snapshot is still being built. */
  private joining = 0;
  private sent = new Map<string, SessionMarks>();
  /** rowSignature per listed path as of the last diff; null before the first (no baseline yet). */
  private rows: Map<string, string> | null = null;
  /** The last `after` frame per type, as JSON. */
  private extras = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  /** When the last re-diff started (the min gap counts from it). */
  private lastStart = 0;
  /** Set while the feed itself announces a change, so its own announcement is no new change. */
  private announcing = false;
  /** Re-diffs run (tests, measurement). */
  diffs = 0;
  /** Change signals heard, and the count as of the last finished re-diff's start, with its list. */
  private heard = 0;
  private last: { heard: number; at: number; list: SessionSummary[] } | null = null;
  constructor(private readonly opts: SessionFeedOptions) {}

  get size(): number {
    return this.clients.size;
  }

  /** A new listener: existing ones get any pending delta first, then it gets the full snapshot. */
  add(send: Send): () => void {
    let gone = false;
    this.joining++;
    if (!this.timer) {
      this.timer = setInterval(() => this.nudge(0), this.opts.intervalMs ?? SAFETY_NET_MS);
      this.timer.unref?.();
      try {
        this.unwatch = this.opts.watch?.(() => this.nudge()) ?? null;
      } catch (err) {
        console.warn("[session-feed] watch failed:", err instanceof Error ? err.message : String(err));
      }
    }
    this.run(async () => {
      try {
        await this.diff(true);
      } finally {
        this.joining--;
      }
      if (gone) return;
      this.clients.add(send);
      send({ type: "marks", full: true, sessions: [...this.sent.values()] });
    });
    return () => {
      gone = true;
      this.clients.delete(send);
      if (this.clients.size === 0 && this.joining === 0) this.stop();
    };
  }

  /** Something the overlays read changed: re-diff soon (coalesced). A no-op with no listener. */
  nudge(delayMs = this.opts.debounceMs ?? 250): void {
    if (this.clients.size === 0 || this.announcing) return;
    this.heard++;
    if (this.pending) return;
    const gap = this.lastStart + (this.opts.minGapMs ?? 1000) - Date.now();
    this.pending = setTimeout(() => {
      this.pending = null;
      this.run(() => this.diff());
    }, Math.max(delayMs, gap, 0));
    this.pending.unref?.();
  }

  /** The last re-diff's list while nothing has signalled a change since it started and it is younger
      than two safety nets (one renews it every period), else null: a timer that wants the list (the merge board) reads this
      instead of building one while nothing changes. Never while no client listens. */
  cleanList(now = Date.now()): Promise<SessionSummary[]> | null {
    const rows = this.cleanRows(now);
    return rows ? Promise.resolve([...rows]) : null;
  }

  /** cleanList's rows themselves (the same array while it stays clean, so a memo can match it). */
  cleanRows(now = Date.now()): readonly SessionSummary[] | null {
    const l = this.last;
    if (!l || this.clients.size === 0 || this.pending || l.heard !== this.heard || now - l.at >= 2 * (this.opts.intervalMs ?? SAFETY_NET_MS)) return null;
    return l.list;
  }

  /** Sent to every listener as is (tags backfill progress). */
  publish(msg: SessionFeedMessage): void {
    for (const send of this.clients) send(msg);
  }

  /** Settles once every queued diff has run (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = this.pending = null;
    const unwatch = this.unwatch;
    this.unwatch = null;
    try {
      unwatch?.();
    } catch {
      // a watch already gone
    }
    this.sent = new Map();
    this.rows = null;
    this.extras = new Map();
    this.last = null;
  }

  private run(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => console.warn("[session-feed]", err instanceof Error ? err.message : String(err)));
  }

  private async diff(force = false): Promise<void> {
    if (this.clients.size === 0 && !force) return;
    this.lastStart = Date.now();
    this.diffs++;
    const heard = this.heard;
    const list = await this.opts.list();
    this.last = { heard, at: this.lastStart, list };
    const { changes, next } = diffMarks(this.sent, list);
    this.sent = next;
    if (changes.length) this.publish({ type: "marks", sessions: changes });
    const rows = new Map(list.map((s) => [s.path, rowSignature(s)]));
    // The first diff is the baseline (a client that connects re-reads the list itself).
    if (this.rows && listChanged(this.rows, rows)) {
      // What changed a row (a Get Link, a share-page reply, a hand-off) may be on the attention
      // digest too, which is memoized: its next read, the one list_changed prompts, is fresh.
      this.announcing = true;
      try {
        attentionChanged();
      } finally {
        this.announcing = false;
      }
      this.publish({ type: "list_changed" });
    }
    this.rows = rows;
    if (!this.opts.after) return;
    const frames = await this.opts.after(list);
    for (const f of frames) {
      const json = this.opts.frameKey ? this.opts.frameKey(f) : JSON.stringify(f);
      // The first of each type is the baseline: a client reads the value itself when it connects.
      const before = this.extras.get(f.type);
      this.extras.set(f.type, json);
      if (before !== undefined && before !== json) this.publish(f);
    }
  }
}

let shared: SessionFeed | null = null;

/** The server's one feed; `list` is bound once at startup (index.ts), so this module imports no store. */
export function configureSessionFeed(opts: SessionFeedOptions): SessionFeed {
  shared?.stop();
  shared = new SessionFeed(opts);
  return shared;
}

export function sessionFeed(): SessionFeed | null {
  return shared;
}

/** A store changed or a pane attached: re-diff soon. Safe before configuration and in tests. */
export function nudgeMarks(): void {
  shared?.nudge();
}

/** Send a message to every feed listener (tags backfill progress). A no-op with none. */
export function publishFeed(msg: SessionFeedMessage): void {
  shared?.publish(msg);
}
