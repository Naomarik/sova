// A message sent while its chat starts is the server's to deliver (§chat.transcript/send-while-starting).
//
// A chat view whose chat isn't running (closed while quiet) writes what the person asks of it on the
// connection that wakes the chat, the moment that connection opens: the server holds it while the
// chat starts, and runs it even if the tab has gone by then (server/ws.ts). A browser WebSocket
// takes no frame while it is still connecting (`send` throws), so until it opens the view keeps the
// frames here, in order, and in localStorage too (a parcel, leased by this page):
// - the view closes first (another chat, home, Back): `courier` opens a connection of its own, just
//   to deliver them, and stays to hear the answer, putting a refused message back in the draft;
// - the page goes first (a reload, a closed tab): `handOverOnUnload` posts every frame not yet on
//   an open socket to the server with a request that outlives the page (POST /api/chat/frames,
//   keepalive), which runs them as a chat socket's own early frames. Only when that can't be made
//   (a body over the keepalive cap, a peer's chat, no fetch) does the parcel stay, for the next page
//   load (`deliverStranded`), which takes only parcels whose page's lease ran out; kept for more
//   than a day, their messages go back to their drafts instead.
// A view that closes with sends still unanswered on an open connection hands that connection to
// `courier` too, so the answer still has someone to hear it.

import { draftTexts, HeldSends } from "../../shared/held-sends";

export type Frame = Record<string, unknown>;

/** What one view kept for its chat before a connection opened. */
export interface Parcel {
  id: string;
  path: string;
  frames: Frame[];
  /** When it was first kept (ms). */
  at: number;
  /** The page holding it, and until when (ms) that page vouches it is alive: no other page takes a
      parcel whose lease runs, so a frame a live page will still send never goes twice. Absent: an
      older build's parcel, anyone's. */
  page?: string;
  lease?: number;
}

const KEY = "sova:chat-outbox";
/** Kept longer than this, a parcel's messages go back to their draft instead of being sent. */
export const PARCEL_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a courier stays on its connection to hear what became of what it delivered. */
export const COURIER_LISTEN_MS = 120_000;
/** A live page renews its parcels' lease this often, each for LEASE_MS. */
export const LEASE_RENEW_MS = 5_000;
export const LEASE_MS = 15_000;
/** The most a page hands over as it goes: keepalive requests share a 64 KB budget. */
export const HAND_OVER_MAX_BYTES = 60_000;

/** This page's id (one per page load). */
export const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The browser's storage, or none (a blocked or full localStorage never breaks a send). */
export interface ParcelStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const browserStore = (): ParcelStore | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

function readParcels(store: ParcelStore | null): Parcel[] {
  if (!store) return [];
  try {
    const v: unknown = JSON.parse(store.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(
      (p): p is Parcel =>
        !!p && typeof p.id === "string" && typeof p.path === "string" && Array.isArray(p.frames) && typeof p.at === "number",
    );
  } catch {
    return [];
  }
}
function writeParcels(store: ParcelStore | null, parcels: Parcel[]): boolean {
  if (!store) return false;
  try {
    store.setItem(KEY, JSON.stringify(parcels));
    return true;
  } catch {
    // full or blocked: the in-memory copy still goes when the connection opens
    return false;
  }
}
/** Kept (or replaced); whether storage took it. */
export function keepParcel(p: Parcel, store = browserStore()): boolean {
  return writeParcels(store, [...readParcels(store).filter((x) => x.id !== p.id), p]);
}
export function dropParcel(id: string, store = browserStore()): void {
  const all = readParcels(store);
  if (all.some((p) => p.id === id)) writeParcels(store, all.filter((p) => p.id !== id));
}
const hasParcel = (id: string, store: ParcelStore | null) => readParcels(store).some((p) => p.id === id);

/** The parcels no live page holds (its lease ran out, or it has none), taken out of storage; the
    rest stay. `page` (this page) never takes its own: it delivers them itself. */
export function takeStranded(store = browserStore(), now = Date.now(), page = PAGE_ID): { taken: Parcel[]; held: Parcel[] } {
  const all = readParcels(store);
  const free = (p: Parcel) => p.page !== page && (p.lease === undefined || p.lease < now);
  const taken = all.filter(free);
  const held = all.filter((p) => !free(p));
  if (taken.length) writeParcels(store, held);
  return { taken, held };
}

/** The prompt and steer texts among some frames, by client id, oldest first. */
export function sendsOf(frames: readonly Frame[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of frames)
    if ((f.type === "prompt" || f.type === "steer") && typeof f.clientId === "string" && f.clientId) out.set(f.clientId, typeof f.text === "string" ? f.text : "");
  return out;
}

/** The typed sends among some frames, by client id, oldest first: a confirm card's click is never put
    back into a draft, where sending it again would approve nothing (lib/hand-back, §app.overseer/confirm). */
export function typedSendsOf(frames: readonly Frame[]): Map<string, string> {
  return sendsOf(frames.filter((f) => !f.confirm));
}

let parcelSeq = 0;
const newParcelId = () => `${Date.now().toString(36)}-${(++parcelSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---- This page's holders: what it keeps that no open socket carries yet ----------------------------

/** Frames this page holds for a chat that no open socket has taken yet. */
interface Holder {
  readonly path: string;
  /** Its frames, and none held after (here or in storage); empty when another page took them. */
  take(): Frame[];
  /** Its parcel's lease, renewed to `until`. */
  renew(until: number): void;
}
const holders = new Set<Kept>();
let renewTimer: ReturnType<typeof setInterval> | undefined;
const hold = (h: Kept) => {
  holders.add(h);
  if (renewTimer !== undefined) return;
  renewTimer = setInterval(() => {
    const until = Date.now() + LEASE_MS;
    for (const x of holders) x.renew(until);
  }, LEASE_RENEW_MS);
  (renewTimer as { unref?: () => void }).unref?.();
};
const release = (h: Kept) => {
  holders.delete(h);
  if (holders.size || renewTimer === undefined) return;
  clearInterval(renewTimer);
  renewTimer = undefined;
};

/** A parcel of this page's: kept in storage under a lease while held, never sent twice. */
class Kept implements Holder {
  frames: Frame[] = [];
  private id = newParcelId();
  private at = 0;
  /** Storage took it: if it is gone from there, another page took it and sends it. */
  private stored = false;
  constructor(
    readonly path: string,
    private readonly store: ParcelStore | null,
    private readonly now: () => number,
    private readonly page: string,
  ) {}
  private write(lease: number): void {
    this.stored = keepParcel({ id: this.id, path: this.path, frames: this.frames, at: this.at, page: this.page, lease }, this.store) || this.stored;
  }
  add(frames: Frame[]): void {
    if (!frames.length) return;
    if (!this.frames.length) this.at = this.now();
    this.frames.push(...frames);
    this.write(this.now() + LEASE_MS);
    hold(this);
  }
  renew(until: number): void {
    if (this.frames.length && (!this.stored || hasParcel(this.id, this.store))) this.write(until);
  }
  take(): Frame[] {
    const out = this.frames;
    const taken = this.stored && !hasParcel(this.id, this.store);
    this.frames = [];
    dropParcel(this.id, this.store);
    this.id = newParcelId();
    this.stored = false;
    release(this);
    return taken ? [] : out;
  }
  /** The page is going and couldn't hand these over: the next page load may take them at once. */
  strand(frames: Frame[]): void {
    if (!frames.length) return;
    keepParcel({ id: newParcelId(), path: this.path, frames, at: this.at || this.now(), page: this.page, lease: 0 }, this.store);
  }
}

/** One view's frames for its chat while no connection is open, kept in storage as they come. */
export class Outbox {
  private readonly kept: Kept;
  constructor(path: string, store: ParcelStore | null = browserStore(), now: () => number = Date.now, page = PAGE_ID) {
    this.kept = new Kept(path, store, now, page);
  }
  get path(): string {
    return this.kept.path;
  }
  get size(): number {
    return this.kept.frames.length;
  }
  push(frame: Frame): void {
    this.kept.add([frame]);
  }
  /** Every frame, oldest first, and none kept after (here or in storage); none when another page
      already took them (it delivers them). */
  take(): Frame[] {
    return this.kept.take();
  }
}

// ---- Messages on their way, for a view that comes back (§chat.transcript/send-while-starting) ----

type OnTheWay = Map<string, string>;
const onTheWay = new Map<string, OnTheWay>();
/** The sends a courier is delivering to this chat, by client id: a view opening it shows each as
    `Sending…` and connects at once. */
export const sendsOnTheWay = (path: string): ReadonlyMap<string, string> => onTheWay.get(path) ?? new Map();
const noteOnTheWay = (path: string, sends: Map<string, string>) => {
  if (!sends.size) return;
  const m = onTheWay.get(path) ?? new Map<string, string>();
  for (const [id, text] of sends) m.set(id, text);
  onTheWay.set(path, m);
};
const settleOnTheWay = (path: string, ids: Iterable<string>) => {
  const m = onTheWay.get(path);
  if (!m) return;
  for (const id of ids) m.delete(id);
  if (!m.size) onTheWay.delete(path);
};

/** Who takes a refused message back for a chat: its open view, if any (into its composer), else
    the draft store. Set by the app (registerPutBack) and by each open chat view (takeBackHere). */
type PutBack = (path: string, texts: string[], ids: string[]) => void;
let putBackToDraft: PutBack = () => {};
const views = new Map<string, (texts: string[], ids: string[]) => void>();
export function registerPutBack(fn: PutBack): void {
  putBackToDraft = fn;
}
/** An open chat view takes back what its chat refused; returns the unregister. */
export function takeBackHere(path: string, fn: (texts: string[], ids: string[]) => void): () => void {
  views.set(path, fn);
  return () => {
    if (views.get(path) === fn) views.delete(path);
  };
}
const putBack = (path: string, texts: string[], ids: string[]) => {
  const back = texts.filter((t) => t.trim());
  if (!back.length) return;
  const view = views.get(path);
  if (view) view(back, ids);
  else putBackToDraft(path, back, ids);
};

/** What a courier needs from the page: the chat socket's url and a WebSocket, and for a page that
    goes, the request that hands frames to the server as it does. */
export interface CourierDeps {
  url(path: string): string;
  open?(url: string): WebSocket;
  listenMs?: number;
  /** POST /api/chat/frames for `path` with `body`, as a request that outlives the page; false when
      it can't be made. Absent: frames stay in storage for the next page load. */
  post?(path: string, body: string): boolean;
  /** Whether the server here hosts `path` (a peer's chat on an older Sova may lack the route). */
  local?(path: string): boolean;
  store?: ParcelStore | null;
  page?: string;
}

/**
 * Deliver `frames` to the chat at `path` on a connection of its own (or `ws`, a view's open
 * connection it hands over), then stay to hear what became of each send in `held`: taken, or
 * refused and put back (to the chat's open view, else its draft). It leaves once every send is
 * answered, or after COURIER_LISTEN_MS; the server takes over from there (server/ws.ts). Until the
 * connection opens the frames are this page's parcel (the page going hands them over). A connection
 * that never opens (the server unreachable) puts the messages back at once.
 */
export function courier(path: string, frames: Frame[], held: Map<string, string>, deps: CourierDeps, ws?: WebSocket): void {
  if (!frames.length && !held.size) {
    ws?.close(1000, "client closed");
    return;
  }
  const all = new Map([...held, ...sendsOf(frames)]);
  noteOnTheWay(path, all);
  const sock = ws ?? (deps.open ? deps.open(deps.url(path)) : new WebSocket(deps.url(path)));
  let opened = sock.readyState === WebSocket.OPEN;
  const kept = new Kept(path, deps.store === undefined ? browserStore() : deps.store, Date.now, deps.page ?? PAGE_ID);
  if (opened) kept.frames = frames;
  else kept.add(frames);
  const sends = new HeldSends();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settleOnTheWay(path, all.keys());
    if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) sock.close(1000, "client closed");
  };
  const deliver = () => {
    opened = true;
    // Empty when the page handed them over as it went, or another page took them: sent there.
    const out = kept.take();
    for (const f of out) {
      sock.send(JSON.stringify(f));
      sends.sent(f);
    }
    for (const [clientId, text] of held) sends.sent({ type: "prompt", clientId, text });
    if (!sends.size) return finish();
    timer = setTimeout(finish, deps.listenMs ?? COURIER_LISTEN_MS);
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    // A card click is delivered as any send, never put back (draftTexts).
    const back = sends.heardJson(ev.data).filter((u) => u.card === undefined);
    if (back.length)
      putBack(
        path,
        draftTexts(back),
        back.map((u) => u.id),
      );
    if (!sends.size) finish();
  };
  sock.onclose = () => {
    if (done) return;
    // Never opened: nothing reached the server, so what is still held here comes back now.
    if (!opened) {
      const back = typedSendsOf(kept.take());
      putBack(path, [...back.values()], [...back.keys()]);
    }
    finish();
  };
  if (opened) deliver();
  else sock.onopen = deliver;
}

/** At page load: what a page that has gone kept and never delivered goes now, or, kept for more
    than PARCEL_TTL_MS, back to its chat's draft. A parcel a live page still holds (its lease runs)
    stays: that page sends it. One whose lease is still running is looked at again once it ends. */
export function deliverStranded(deps: CourierDeps, store = deps.store === undefined ? browserStore() : deps.store, now = Date.now(), again = true): void {
  const page = deps.page ?? PAGE_ID;
  const { taken, held } = takeStranded(store, now, page);
  for (const p of taken) {
    if (now - p.at > PARCEL_TTL_MS) {
      const sends = typedSendsOf(p.frames);
      putBack(p.path, [...sends.values()], [...sends.keys()]);
      continue;
    }
    courier(p.path, p.frames, new Map(), { ...deps, store });
  }
  const leases = held.filter((p) => p.page !== page).map((p) => p.lease ?? 0);
  if (!again || !leases.length) return;
  const t = setTimeout(() => deliverStranded(deps, store), Math.max(0, Math.min(...leases) - now) + 100);
  (t as { unref?: () => void }).unref?.();
}

/**
 * The page is going (pagehide, beforeunload): every frame it holds that no open socket carries
 * goes to the server now, on a request that outlives the page (deps.post), in each chat's order;
 * the server runs them as a chat socket's early frames. Frames over the keepalive budget, for a
 * peer's chat, or with no such request stay as a parcel the next page load may take at once.
 */
export function handOverOnUnload(deps: CourierDeps): void {
  let budget = HAND_OVER_MAX_BYTES;
  for (const h of [...holders]) {
    const frames = h.take();
    if (!frames.length) continue;
    const body = JSON.stringify({ frames });
    const bytes = new TextEncoder().encode(body).length;
    let sent = false;
    if (deps.post && (deps.local?.(h.path) ?? true) && bytes <= budget) {
      try {
        sent = deps.post(h.path, body);
      } catch {
        sent = false;
      }
    }
    if (sent) budget -= bytes;
    else h.strand(frames);
  }
}

/** Hands this page's frames over as it goes (handOverOnUnload); once per page. */
let handing = false;
export function handOverWhenGoing(deps: CourierDeps): void {
  if (handing || typeof window === "undefined") return;
  handing = true;
  const go = () => handOverOnUnload(deps);
  window.addEventListener("pagehide", go);
  window.addEventListener("beforeunload", go);
}
