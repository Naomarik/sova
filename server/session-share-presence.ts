import type { WebSocket } from "ws";
import {
  SESSION_SHARE_GONE_CLOSE,
  SESSION_SHARE_SOCKETS_PER_LINK,
  type SessionSharePresence,
  type SessionShareServerMessage,
  type SessionShareView,
} from "../shared/session-share";
import { socketClosed, socketOpened, type VisitHandle } from "./visits";

/**
 * Who is looking at a session share now (§app.session-share/presence), in memory on the minting
 * host: every `/ws/s` socket ends here, through the gateway or not (§mesh.public/routing), so this
 * host alone sees every open page. Nothing is persisted; the visit log (server/visits.ts) keeps
 * the history.
 *
 * - Up to SESSION_SHARE_SOCKETS_PER_LINK sockets per link (a reload, a second tab); beyond that
 *   the oldest is closed.
 * - The page sends one kind of frame, `{"t":"vis","on":true|false}` on visibilitychange, at most
 *   MAX_FRAME bytes. Anything else closes the socket: 1009 when too big, 1003 otherwise.
 * - A recipient is `viewing` while a socket of theirs is open and visible, `open` while one is open
 *   but hidden, and `away` otherwise. A socket counts as visible until it says otherwise.
 * - A socket continues its link's visit (never starts one) and writes its last seen at close.
 */

export interface ViewerKey {
  shareId: string;
  recipientId: string;
  /** The link's token hash: sockets are counted and closed per link. */
  hash: string;
}

/** The largest frame a page may send. */
export const MAX_FRAME = 1024;

interface Viewer {
  key: ViewerKey;
  socket: WebSocket;
  visible: boolean;
  openedAt: number;
}

/** Open viewers by share id. */
const viewers = new Map<string, Set<Viewer>>();

function send(v: Viewer, msg: SessionShareServerMessage): void {
  if (v.socket.readyState === v.socket.OPEN) v.socket.send(JSON.stringify(msg));
}

function drop(v: Viewer): void {
  const set = viewers.get(v.key.shareId);
  if (!set) return;
  set.delete(v);
  if (!set.size) viewers.delete(v.key.shareId);
}

/** The one frame a page may send, strictly: `{"t":"vis","on":<boolean>}` and nothing more. */
export function parseFrame(data: string): { on: boolean } | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2 || o.t !== "vis" || typeof o.on !== "boolean") return null;
  return { on: o.on };
}

/**
 * A page's socket opened on a live link (the caller has checked the token). `tab` and `userAgent`
 * continue the link's visit (server/visits.ts); neither is kept here.
 */
export function addViewer(key: ViewerKey, socket: WebSocket, opts: { tab?: string | null; userAgent?: string | null } = {}): void {
  let set = viewers.get(key.shareId);
  if (!set) viewers.set(key.shareId, (set = new Set()));
  const same = [...set].filter((v) => v.key.hash === key.hash).sort((a, b) => a.openedAt - b.openedAt);
  for (const old of same.slice(0, Math.max(0, same.length - SESSION_SHARE_SOCKETS_PER_LINK + 1))) {
    drop(old);
    old.socket.close(4000, "Opened elsewhere");
  }
  const v: Viewer = { key: { ...key }, socket, visible: true, openedAt: Date.now() };
  set.add(v);
  let visit: VisitHandle | null = null;
  try {
    visit = socketOpened({ via: "session", shareId: key.shareId, recipientId: key.recipientId }, { tab: opts.tab, userAgent: opts.userAgent });
  } catch (err) {
    console.warn(`[session-share] visit log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  socket.on("message", (data, isBinary) => {
    const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length;
    if (size > MAX_FRAME) return socket.close(1009, "Too big");
    const frame = isBinary ? null : parseFrame(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8"));
    if (!frame) return socket.close(1003, "Unsupported");
    v.visible = frame.on;
  });
  socket.on("close", () => {
    drop(v);
    if (!visit) return;
    try {
      socketClosed(visit);
    } catch (err) {
      console.warn(`[session-share] visit log failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** One recipient's presence now. */
export function presenceOf(shareId: string, recipientId: string): SessionSharePresence {
  let open = false;
  for (const v of viewers.get(shareId) ?? []) {
    if (v.key.recipientId !== recipientId) continue;
    if (v.visible) return "viewing";
    open = true;
  }
  return open ? "open" : "away";
}

function gone(v: Viewer, why?: "expired"): void {
  drop(v);
  send(v, { type: "error", code: "gone", ...(why ? { why } : {}) });
  v.socket.close(SESSION_SHARE_GONE_CLOSE, "gone");
}

/** A link died (revoked, relinked, expired): its open pages close with 4410. Returns how many. */
export function closeLink(hash: string, why?: "expired"): number {
  let n = 0;
  for (const set of [...viewers.values()])
    for (const v of [...set])
      if (v.key.hash === hash) {
        gone(v, why);
        n++;
      }
  return n;
}

/** A share stopped (or its session is gone): every open page of it closes with 4410. */
export function closeShare(shareId: string): number {
  const set = [...(viewers.get(shareId) ?? [])];
  for (const v of set) gone(v);
  return set.length;
}

/** Push every open page of a share its view (Update to now, a mode switch, a live share's growth).
    One view for all: a share's view never depends on who holds the link. */
export function pushView(shareId: string, view: SessionShareView, reset = false): number {
  const set = [...(viewers.get(shareId) ?? [])];
  for (const v of set) send(v, { type: "view", view, ...(reset ? { reset: true as const } : {}) });
  return set.length;
}

/** Open pages of a share (a live share's file is watched only while it has any). */
export const viewerCount = (shareId: string): number => viewers.get(shareId)?.size ?? 0;

/**
 * Close every open page whose link no longer reads (`check` answers from the store: expired, or
 * turned off by a path that closed nothing). Run on a ticker by the caller; returns how many closed.
 */
export function sweepViewers(check: (key: ViewerKey) => { ok: true } | { ok: false; why?: "expired" }): number {
  let n = 0;
  for (const set of [...viewers.values()])
    for (const v of [...set]) {
      let r: { ok: true } | { ok: false; why?: "expired" };
      try {
        r = check(v.key);
      } catch {
        continue;
      }
      if (r.ok) continue;
      gone(v, r.why);
      n++;
    }
  return n;
}

/** Forget every viewer without closing anything (tests). */
export function resetViewers(): void {
  viewers.clear();
}
