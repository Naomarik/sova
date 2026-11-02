// The session list kept current from the feed's `rows` frames (server/session-feed.ts) instead of a
// full GET /api/sessions per change. Pure: no DOM, no Solid (list-rows.test.ts drives it).
//
// The list is a snapshot (a full read, named by its `X-Sova-List-Version`) plus the deltas after it,
// applied only in order: a delta is applied when its `from` is the version held. Anything else asks
// for a full read (`refetch`) and keeps nothing it can't prove: a gap, an epoch it doesn't hold, a
// server that never said `rows_hello` (it re-reads on `list_changed`, as before), a snapshot with no
// version, `list_changed` on a rows socket (a change too big for a frame), and a `rows_check` digest
// that differs from its own. While a read is in flight, deltas wait and are replayed onto its answer.

import type { SessionFeedMessage, SessionSummary } from "../../shared/protocol";
import { byActivity, rowsDigest } from "./summary-diff";

export type ListVersion = { epoch: string; version: number };

export interface ListRowsHost {
  /** Re-read the whole list (the caller throttles). Its answer comes back through `snapshot`. */
  refetch(): void;
  /** A delta moved the list outside a read: these are its raw rows now, sorted as a full read
      sorts them. (A read's own answer comes back from `snapshot` / `fetchFailed` instead.) */
  publish(rows: SessionSummary[]): void;
}

type RowsFrame = Extract<SessionFeedMessage, { type: "rows" }>;

/** How much older than its arrival a delta's rows are taken to be (lib/composer-known stamps): the
    server built them from a list read up to about this long before. */
export const ROW_STAMP_SLACK_MS = 1000;

/** Frames kept while a read is in flight; past this the read's answer can't be caught up, re-read. */
const MAX_BUFFER = 256;
/** Snapshots in a row whose epoch isn't the socket's before the list gives up on rows (legacy). */
const MAX_EPOCH_MISSES = 3;

export class ListRows {
  /** What the socket said first: rows (`rows_hello`), legacy (anything else), or not yet. */
  private mode: "unknown" | "rows" | "legacy" = "legacy";
  private hello: ListVersion | null = null;
  /** The raw rows held and the version they are at (null: none, or unversioned). */
  private rows: SessionSummary[] | null = null;
  private at: ListVersion | null = null;
  private inFlight = 0;
  private buffer: RowsFrame[] = [];
  private epochMisses = 0;
  /** Full reads this asked for (tests, measurement). */
  refetches = 0;

  constructor(private readonly host: ListRowsHost) {}

  /** Whether the socket is a rows socket and the list follows its deltas. */
  get following(): boolean {
    return this.mode === "rows" && this.at !== null;
  }

  /** The version held, for tests. */
  get version(): ListVersion | null {
    return this.at;
  }

  /** The feed socket (re)opened: its first frame says what it speaks. Nothing earlier carries over. */
  socketOpened(): void {
    this.mode = "unknown";
    this.epochMisses = 0;
    this.hello = null;
    this.buffer = [];
  }

  /** The socket closed: until it reopens, the list is read the old way. */
  socketClosed(): void {
    this.mode = "legacy";
    this.hello = null;
    this.buffer = [];
  }

  /** A full read is about to be sent: deltas wait for its answer. */
  fetchStarted(): void {
    this.inFlight++;
  }

  /** A full read failed, or its answer was dropped: what waited for it goes onto the rows held (a
      gap re-reads). Returns the rows when that moved them, else null. */
  fetchFailed(): SessionSummary[] | null {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight || !this.buffer.length) return null;
    return this.replay(this.drain()) ? this.rows : null;
  }

  /**
   * A full read's answer and the version its header named (null: none). Returns the rows to show:
   * the answer with every waiting delta after its version applied, or the rows already held when
   * this answer is older than them (two reads crossing).
   */
  snapshot(rows: SessionSummary[], at: ListVersion | null): SessionSummary[] {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (at && this.at && this.rows && at.epoch === this.at.epoch && at.version < this.at.version) {
      // An older read crossing a newer one: the newer state stands.
      return this.rows;
    }
    this.rows = rows;
    this.at = at;
    if (this.mode !== "rows") {
      this.buffer = [];
      return rows;
    }
    if (!at || (this.hello && at.epoch !== this.hello.epoch)) {
      // A read the socket's versions can't continue: a server without the header, or a feed run
      // other than the socket's. Try again a few times, then follow the old way.
      this.at = null;
      this.buffer = [];
      if (++this.epochMisses > MAX_EPOCH_MISSES) this.mode = "legacy";
      else this.ask();
      return rows;
    }
    this.epochMisses = 0;
    if (!this.inFlight) this.replay(this.drain());
    // Behind what the socket said it was at when it opened: a delta between them is lost.
    if (this.at && this.hello && this.at.version < this.hello.version && !this.inFlight) this.ask();
    return this.rows;
  }

  /** A feed frame. True when it was a rows frame (handled here). */
  message(msg: SessionFeedMessage): boolean {
    if (this.mode === "unknown") {
      if (msg.type === "rows_hello") {
        this.mode = "rows";
        this.hello = { epoch: msg.epoch, version: msg.version };
        // Held rows at another version or epoch can't be continued: re-read (a reconnect always
        // lands here, as does a first open whose read raced the socket).
        if (!this.inFlight && !(this.at && this.at.epoch === msg.epoch && this.at.version === msg.version)) {
          this.at = null;
          this.ask();
        }
        return true;
      }
      // An older server or peer: no rows on this socket.
      this.mode = "legacy";
    }
    if (msg.type === "rows_hello") return true;
    if (this.mode !== "rows") return msg.type === "rows" || msg.type === "rows_check";
    if (msg.type === "list_changed") {
      // Too big for a frame: the held rows' version is behind from here on.
      this.at = null;
      this.ask();
      return true;
    }
    if (msg.type === "rows") {
      if (!this.hello || msg.epoch !== this.hello.epoch) {
        this.at = null;
        this.ask();
        return true;
      }
      if (this.inFlight || !this.at || !this.rows) {
        this.buffer.push(msg);
        if (this.buffer.length > MAX_BUFFER) {
          this.buffer = [];
          this.at = null;
        }
        // Nothing to apply it to and no read coming: ask for one.
        if (!this.inFlight) this.ask();
        return true;
      }
      if (this.replay([msg])) this.host.publish(this.rows!);
      return true;
    }
    if (msg.type === "rows_check") {
      if (this.inFlight || !this.at || !this.rows || msg.epoch !== this.at.epoch) return true;
      if (msg.version !== this.at.version || msg.digest !== rowsDigest(this.rows)) {
        // A frame was lost (behind), or a row differs at the same version.
        this.at = null;
        this.ask();
      }
      return true;
    }
    return false;
  }

  private drain(): RowsFrame[] {
    const b = this.buffer;
    this.buffer = [];
    return b;
  }

  /** Applies frames in version order from the held version; a gap re-reads. True when the rows moved. */
  private replay(frames: RowsFrame[]): boolean {
    if (!this.at || !this.rows) {
      if (frames.length) this.ask();
      return false;
    }
    frames.sort((a, b) => a.from - b.from);
    let changed = false;
    let byPath: Map<string, SessionSummary> | null = null;
    for (const f of frames) {
      if (f.epoch !== this.at.epoch || f.to <= this.at.version) continue;
      if (f.from !== this.at.version) {
        this.at = null;
        this.ask();
        break;
      }
      byPath ??= new Map(this.rows.map((s) => [s.path, s]));
      for (const p of f.remove) byPath.delete(p);
      for (const s of f.upsert) byPath.set(s.path, s);
      this.at = { epoch: f.epoch, version: f.to };
      changed = true;
    }
    if (!changed || !byPath) return false;
    this.rows = [...byPath.values()].sort(byActivity);
    return true;
  }

  private ask(): void {
    this.refetches++;
    this.host.refetch();
  }
}
