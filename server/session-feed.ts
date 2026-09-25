import type { SessionFeedMessage, SessionMarks, SessionSummary } from "../shared/protocol";

/**
 * The session feed: WS /ws/watch?feed=sessions (shared/protocol.ts SessionFeedMessage). The server
 * PUSHES the list's decision overlays (`signals`, `workerSignals`, `tags`) so a mark appears or
 * clears without waiting for the client's list poll.
 *
 * The overlays are read from the list itself (the caller's `list`, i.e. listSessions), never from
 * the stores directly: what the feed sends is exactly what the next poll would show, visibility
 * rules included (a signal is left out once seen, while viewed, while running). A re-diff runs on a
 * nudge (a store wrote, a pane attached) and every few seconds while anyone listens, so changes
 * the feed cannot be told about (a turn starting in a TUI) still reach it. Nothing runs, and
 * nothing is listed, while no client is connected.
 *
 * The same diff also sends `list_changed` when a row changed in a way the marks can't carry (a
 * session a TUI just created, one that went away, its live record, running state or last
 * activity): the client has no other way to learn of those short of its own focus or busy poll.
 */

type Send = (msg: SessionFeedMessage) => void;
const FIELDS = ["signals", "workerSignals", "tags"] as const;

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
 * record, whether it runs, and its last activity. A change to any of these is `list_changed` (the
 * client re-reads the list); a session a TUI just created is a new path here.
 */
export function rowSignature(s: SessionSummary): string {
  return JSON.stringify([s.live?.pid ?? null, s.live?.status ?? null, s.busy, s.activity?.state ?? null, s.lastActiveAt, s.archived]);
}

/** Did the listed rows change beyond the marks: a path added or removed, or a signature changed. */
export function listChanged(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
  if (prev.size !== next.size) return true;
  for (const [path, sig] of next) if (prev.get(path) !== sig) return true;
  return false;
}

export interface SessionFeedOptions {
  list: () => Promise<SessionSummary[]>;
  /** Re-diff period while a client listens. */
  intervalMs?: number;
  /** Debounce of nudges. */
  debounceMs?: number;
}

export class SessionFeed {
  private readonly clients = new Set<Send>();
  /** Listeners whose snapshot is still being built. */
  private joining = 0;
  private sent = new Map<string, SessionMarks>();
  /** rowSignature per listed path as of the last diff; null before the first (no baseline yet). */
  private rows: Map<string, string> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly opts: SessionFeedOptions) {}

  get size(): number {
    return this.clients.size;
  }

  /** A new listener: existing ones get any pending delta first, then it gets the full snapshot. */
  add(send: Send): () => void {
    let gone = false;
    this.joining++;
    if (!this.timer) {
      this.timer = setInterval(() => this.nudge(0), this.opts.intervalMs ?? 5000);
      this.timer.unref?.();
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
    if (this.clients.size === 0 || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.run(() => this.diff());
    }, delayMs);
    this.pending.unref?.();
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
    this.sent = new Map();
    this.rows = null;
  }

  private run(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => console.warn("[session-feed]", err instanceof Error ? err.message : String(err)));
  }

  private async diff(force = false): Promise<void> {
    if (this.clients.size === 0 && !force) return;
    const list = await this.opts.list();
    const { changes, next } = diffMarks(this.sent, list);
    this.sent = next;
    if (changes.length) this.publish({ type: "marks", sessions: changes });
    const rows = new Map(list.map((s) => [s.path, rowSignature(s)]));
    // The first diff is the baseline (a client that connects re-reads the list itself).
    if (this.rows && listChanged(this.rows, rows)) this.publish({ type: "list_changed" });
    this.rows = rows;
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
