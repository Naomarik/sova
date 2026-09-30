// The share page's slice model (§app.session-share/share-page): its route, the two-tap picking of a
// start and an end over the outline's rows, the hints that offer the missing half of a turn, and
// the range in words; and how the recipient page takes a pushed view. Pure: no DOM, no fetch.

import type { SessionShareSpan, SessionShareView } from "../../shared/session-share";

// ---- the route ----------------------------------------------------------------------------------

/** `#/share/<sessionId>[?host=<peer>][&share=<ss_id>][&from=<entryId>]`. */
export interface ShareRoute {
  sessionId: string;
  /** The peer that holds the session; null: this host. */
  host: string | null;
  /** Change this share's slice (Save Slice) instead of creating one. */
  share: string | null;
  /** The start, preselected (a message's Share from here). */
  from: string | null;
}

const SHARE_PREFIX = "#/share/";

export function shareHref(sessionId: string, opts: { host?: string | null; share?: string | null; from?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (opts.host) q.set("host", opts.host);
  if (opts.share) q.set("share", opts.share);
  if (opts.from) q.set("from", opts.from);
  const qs = q.toString();
  return `${SHARE_PREFIX}${encodeURIComponent(sessionId)}${qs ? `?${qs}` : ""}`;
}

export function shareRouteFromHash(hash: string): ShareRoute | null {
  if (!hash.startsWith(SHARE_PREFIX)) return null;
  const rest = hash.slice(SHARE_PREFIX.length);
  const qAt = rest.indexOf("?");
  const rawId = qAt < 0 ? rest : rest.slice(0, qAt);
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!sessionId || sessionId.includes("/")) return null;
  const q = new URLSearchParams(qAt < 0 ? "" : rest.slice(qAt + 1));
  return { sessionId, host: q.get("host") || null, share: q.get("share") || null, from: q.get("from") || null };
}

// ---- picking ------------------------------------------------------------------------------------

/** What a row needs for picking: its entry id and whose message it is. */
export interface SliceRow {
  id: string;
  kind: "user" | "reply";
}

/** The picked boundaries, as entry ids. null: the default, "From the first message" / "To the
    latest". A start and an end may be the same row (a slice of one message). */
export interface Slice {
  start: string | null;
  end: string | null;
}

export const WHOLE: Slice = { start: null, end: null };

const at = (rows: readonly SliceRow[], id: string | null) => (id === null ? -1 : rows.findIndex((r) => r.id === id));

/** A slice whose boundaries are all still rows, in order; a boundary that left the list goes back to
    its default. */
export function normalize(rows: readonly SliceRow[], s: Slice): Slice {
  const start = at(rows, s.start) >= 0 ? s.start : null;
  const end = at(rows, s.end) >= 0 ? s.end : null;
  if (start !== null && end !== null && at(rows, start) > at(rows, end)) return { start: end, end: start };
  return { start, end };
}

/**
 * One tap on a row. Tapping a boundary again clears it. With neither picked, the tap is the start;
 * with one picked, the tap is the other, and a pair in the wrong order swaps; with both picked, the
 * nearer boundary moves to it (a tie moves the end, so the start the operator picked first stays).
 */
export function tap(rows: readonly SliceRow[], cur: Slice, id: string): Slice {
  const s = normalize(rows, cur);
  const i = at(rows, id);
  if (i < 0) return s;
  if (id === s.start && id === s.end) return WHOLE;
  if (id === s.start) return { start: null, end: s.end };
  if (id === s.end) return { start: s.start, end: null };
  const a = at(rows, s.start);
  const b = at(rows, s.end);
  if (a < 0 && b < 0) return { start: id, end: null };
  if (b < 0) return i < a ? { start: id, end: s.start } : { start: s.start, end: id };
  if (a < 0) return i > b ? { start: s.end, end: id } : { start: id, end: s.end };
  if (i < a) return { start: id, end: s.end };
  if (i > b) return { start: s.start, end: id };
  return i - a < b - i ? { start: id, end: s.end } : { start: s.start, end: id };
}

/** The first and last row indexes the slice covers (whole list when nothing is picked). */
export function bounds(rows: readonly SliceRow[], cur: Slice): { first: number; last: number } {
  const s = normalize(rows, cur);
  const a = at(rows, s.start);
  const b = at(rows, s.end);
  return { first: a < 0 ? 0 : a, last: b < 0 ? rows.length - 1 : b };
}

export const inSlice = (rows: readonly SliceRow[], cur: Slice, i: number): boolean => {
  const { first, last } = bounds(rows, cur);
  return i >= first && i <= last;
};

// ---- hints --------------------------------------------------------------------------------------

/** A one-tap offer to widen the slice by the other half of a turn; it never applies itself. */
export type SliceHint = { kind: "question"; id: string } | { kind: "reply"; id: string };

/**
 * The hints for a slice: a start on a reply offers its turn's user message; an end on a user
 * message offers the last reply of that turn. Nothing when the boundary is a default, or when the
 * other half doesn't exist (a reply before any user message, a question with no reply yet).
 */
export function hints(rows: readonly SliceRow[], cur: Slice): SliceHint[] {
  const s = normalize(rows, cur);
  const out: SliceHint[] = [];
  const a = at(rows, s.start);
  if (a >= 0 && rows[a]!.kind === "reply") {
    for (let i = a - 1; i >= 0; i--) {
      if (rows[i]!.kind === "user") {
        out.push({ kind: "question", id: rows[i]!.id });
        break;
      }
    }
  }
  const b = at(rows, s.end);
  if (b >= 0 && rows[b]!.kind === "user") {
    let reply: string | null = null;
    for (let i = b + 1; i < rows.length && rows[i]!.kind === "reply"; i++) reply = rows[i]!.id;
    if (reply) out.push({ kind: "reply", id: reply });
  }
  return out;
}

/** A hint taken: the start moves up to the question, or the end down to the reply. */
export function applyHint(cur: Slice, h: SliceHint): Slice {
  return h.kind === "question" ? { ...cur, start: h.id } : { ...cur, end: h.id };
}

export const HINT_WORDS: Record<SliceHint["kind"], { line: string; action: string }> = {
  question: { line: "Starts with a reply.", action: "Include the question?" },
  reply: { line: "Ends with your question.", action: "Include the reply?" },
};

// ---- words --------------------------------------------------------------------------------------

/** A slice's place in the whole: 1-based positions among the shown messages; `last` null while it
    follows live. The same shape as SessionShare.span, so the lists say it in the same words. */
export type SliceSpan = SessionShareSpan;

export function rangeLabel(span: SliceSpan): string {
  const { first, last, total } = span;
  if (last === null) return first <= 1 ? "All messages · follows live" : `From message ${first} · follows live`;
  if (total === 0) return "No messages yet";
  if (first === last) return `Message ${first} of ${total}`;
  if (first <= 1 && last >= total) return `All ${total} messages`;
  return `Messages ${first}–${last} of ${total}`;
}

/** The span of a picked slice over the outline's rows; `live` leaves the end open. */
export function spanOf(rows: readonly SliceRow[], cur: Slice, live: boolean): SliceSpan {
  const { first, last } = bounds(rows, cur);
  return { first: first + 1, last: live ? null : last + 1, total: rows.length };
}

/** The two ends in words: "From the first message · To the latest", "From message 12 · To message 18",
    "From message 12 · Follows live". */
export function endsLine(rows: readonly SliceRow[], cur: Slice, live: boolean): string {
  const s = normalize(rows, cur);
  const { first, last } = bounds(rows, s);
  const from = s.start === null ? "From the first message" : `From message ${first + 1}`;
  const to = live ? "Follows live" : s.end === null ? "To the latest" : `To message ${last + 1}`;
  return `${from} · ${to}`;
}

/**
 * The slice an existing share holds, over today's rows (Change Slice opens on it). The start is its
 * `from`. A snapshot's end is its cut when the cut is a row; else the row its span ends on; else the
 * last row written by the cut's time. Follow live has no end.
 */
export function sliceOfShare(
  rows: readonly (SliceRow & { at?: string })[],
  share: { mode: "snapshot" | "live"; from?: string; cut?: string; cutAt: string | null; span?: SliceSpan },
): Slice {
  const start = share.from !== undefined && at(rows, share.from) >= 0 ? share.from : null;
  if (share.mode === "live") return { start, end: null };
  let end: string | null = null;
  if (share.cut !== undefined && at(rows, share.cut) >= 0) end = share.cut;
  else if (share.span?.last) end = rows[share.span.last - 1]?.id ?? null;
  else if (share.cutAt) {
    const t = Date.parse(share.cutAt);
    for (const r of rows) if (r.at && Date.parse(r.at) <= t) end = r.id;
  }
  return normalize(rows, { start, end });
}

/** Follow live needs the end at the latest message: an end is always a snapshot. */
export const canFollowLive = (cur: Slice): boolean => cur.end === null;

// ---- the recipient page -------------------------------------------------------------------------

/**
 * A newest page (read, re-read or pushed), kept with the earlier pages the reader already opened
 * while it has the view's lineage: the same start on one path, so item numbers keep their meaning.
 * Another lineage, or `reset`, replaces the view whole: nothing of the old view stays.
 */
export function mergeNewest(cur: SessionShareView | null, next: SessionShareView, reset = false): SessionShareView {
  const first = next.items[0]?.n;
  if (!cur || reset || cur.lineage !== next.lineage || first === undefined) return next;
  const earlier = cur.items.filter((i) => i.n < first);
  if (earlier.length === 0) return next;
  return { ...next, items: [...earlier, ...next.items], before: cur.before };
}

/** An earlier page (Show Earlier) put above the view, or null when it is of another lineage: it is
    dropped, and the page reads the newest page again. */
export function mergeEarlier(cur: SessionShareView, page: SessionShareView): SessionShareView | null {
  if (page.lineage !== cur.lineage) return null;
  const first = cur.items[0]?.n ?? Infinity;
  return { ...cur, items: [...page.items.filter((i) => i.n < first), ...cur.items], before: page.before };
}

/** The recipient's "Earlier messages aren't part of this share." line: only above the slice's first
    item, so not while earlier pages of the slice itself remain to be read. */
export const earlierLine = (v: Pick<SessionShareView, "earlier" | "before">): boolean => v.earlier === true && v.before === undefined;

/** What one HTTP read of the share answered, before anything acts on it. */
export type ShareAnswer =
  | { kind: "view"; view: SessionShareView }
  | { kind: "gone"; why?: unknown }
  | { kind: "unknown" }
  | { kind: "busy" }
  | { kind: "offline" }
  | { kind: "failed" };

/** Where the keeper's accepted results go: the page's signals. */
export interface ShareViewSink {
  view(v: SessionShareView): void;
  /** A dead link (`gone`), an unknown token, or too busy with nothing on screen yet. */
  problem(a: Extract<ShareAnswer, { kind: "gone" | "unknown" | "busy" }>): void;
  offline(on: boolean): void;
}

/**
 * The recipient page's view, and the order its reads and pushes act in. Lineage says whether two
 * views may merge, never which is newer: so every read takes a ticket when it starts, and a read
 * acts (its view, or its gone, busy or offline answer) only when no newer view was accepted since:
 * a push, or a newest-page read that started later. A superseded answer is dropped whole, so a
 * late answer of a wider, older slice never comes back over a narrower push.
 */
export class ShareViewKeeper {
  private current: SessionShareView | null = null;
  /** Counts read starts and pushes; `origin` is the tick of the view on screen. */
  private tick = 0;
  private origin = 0;
  constructor(
    private readonly read: (before?: number) => Promise<ShareAnswer>,
    private readonly sink: ShareViewSink,
  ) {}

  get view(): SessionShareView | null {
    return this.current;
  }

  private set(v: SessionShareView) {
    this.current = v;
    this.sink.view(v);
  }

  /** A read's answer that isn't a view, acted on only while that read is current. */
  private answerProblem(a: Exclude<ShareAnswer, { kind: "view" }>): void {
    if (a.kind === "offline") this.sink.offline(true);
    else if (a.kind === "gone" || a.kind === "unknown") this.sink.problem(a);
    else if (a.kind === "busy" && !this.current) this.sink.problem(a);
  }

  /** A pushed view: the newest there is, so every read begun before it is superseded. */
  push(v: SessionShareView, reset = false): void {
    this.origin = ++this.tick;
    this.set(mergeNewest(this.current, v, reset));
  }

  /** Reads the newest page; `false` when its answer was superseded or wasn't a view. */
  async newest(): Promise<boolean> {
    const t = ++this.tick;
    const a = await this.read();
    if (t <= this.origin) return false;
    if (a.kind !== "view") {
      this.answerProblem(a);
      return false;
    }
    this.sink.offline(false);
    this.origin = t;
    this.set(mergeNewest(this.current, a.view));
    return true;
  }

  /**
   * Reads the page before the view (Show Earlier). `failed`: say so and let the reader retry.
   * `dropped`: superseded, or of another lineage (then the newest page is read again, under the
   * same ordering). `none`: nothing earlier, or a problem that the sink now shows.
   */
  async earlier(): Promise<"ok" | "failed" | "dropped" | "none"> {
    const before = this.current?.before;
    if (before === undefined) return "none";
    const t = ++this.tick;
    const a = await this.read(before);
    if (t <= this.origin || !this.current) return "dropped";
    if (a.kind !== "view") {
      this.answerProblem(a);
      return a.kind === "gone" || a.kind === "unknown" ? "none" : "failed";
    }
    this.sink.offline(false);
    const merged = mergeEarlier(this.current, a.view);
    if (!merged) {
      void this.newest();
      return "dropped";
    }
    this.set(merged);
    return "ok";
  }
}
