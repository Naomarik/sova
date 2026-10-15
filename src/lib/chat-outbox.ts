// A message sent while its chat starts is the server's to deliver (§chat.transcript/send-while-starting).
//
// A chat view whose chat isn't running (closed while quiet, or opened asleep) writes what the person
// asks of it on the connection that wakes the chat, the moment that connection opens: the server
// holds it while the chat starts, and runs it even if the tab has gone by then (server/ws.ts). A
// browser WebSocket takes no frame while it is still connecting (`send` throws), so until it opens
// the view keeps the frames here, in order, and in localStorage too:
// - the view closes first (another chat, home, Back): `courier` opens a connection of its own, just
//   to deliver them, and stays to hear the answer, putting a refused message back in the draft;
// - the page goes first (a reload, a closed tab): the next page load delivers what was kept
//   (`deliverStranded`), or, kept for more than a day, puts its messages back in their drafts.
// A view that closes with sends still unanswered on an open connection hands that connection to
// `courier` too (`adopt`), so the answer still has someone to hear it.

import { HeldSends } from "../../shared/held-sends";

export type Frame = Record<string, unknown>;

/** What one view kept for its chat before a connection opened. */
export interface Parcel {
  id: string;
  path: string;
  frames: Frame[];
  /** When it was first kept (ms). */
  at: number;
}

const KEY = "sova:chat-outbox";
/** Kept longer than this, a parcel's messages go back to their draft instead of being sent. */
export const PARCEL_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a courier stays on its connection to hear what became of what it delivered. */
export const COURIER_LISTEN_MS = 120_000;

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
function writeParcels(store: ParcelStore | null, parcels: Parcel[]): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(parcels));
  } catch {
    // full or blocked: the in-memory copy still goes when the connection opens
  }
}
export function keepParcel(p: Parcel, store = browserStore()): void {
  writeParcels(store, [...readParcels(store).filter((x) => x.id !== p.id), p]);
}
export function dropParcel(id: string, store = browserStore()): void {
  const all = readParcels(store);
  if (all.some((p) => p.id === id)) writeParcels(store, all.filter((p) => p.id !== id));
}
/** Every parcel kept, and none kept after: the caller delivers them. */
export function takeParcels(store = browserStore()): Parcel[] {
  const all = readParcels(store);
  if (all.length) writeParcels(store, []);
  return all;
}

/** The prompt and steer texts among some frames, by client id, oldest first. */
export function sendsOf(frames: readonly Frame[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of frames)
    if ((f.type === "prompt" || f.type === "steer") && typeof f.clientId === "string" && f.clientId) out.set(f.clientId, typeof f.text === "string" ? f.text : "");
  return out;
}

let parcelSeq = 0;
const newParcelId = () => `${Date.now().toString(36)}-${(++parcelSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** One view's frames for its chat while no connection is open, kept in storage as they come. */
export class Outbox {
  private frames: Frame[] = [];
  private id = newParcelId();
  private at = 0;
  constructor(
    readonly path: string,
    private readonly store: ParcelStore | null = browserStore(),
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.frames.length;
  }

  push(frame: Frame): void {
    if (!this.frames.length) this.at = this.now();
    this.frames.push(frame);
    keepParcel({ id: this.id, path: this.path, frames: this.frames, at: this.at }, this.store);
  }

  /** Every frame, oldest first, and none kept after (here or in storage). */
  take(): Frame[] {
    const out = this.frames;
    this.frames = [];
    dropParcel(this.id, this.store);
    this.id = newParcelId();
    return out;
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

/** What a courier needs from the page: the chat socket's url and a WebSocket. */
export interface CourierDeps {
  url(path: string): string;
  open?(url: string): WebSocket;
  listenMs?: number;
}

/**
 * Deliver `frames` to the chat at `path` on a connection of its own (or `ws`, a view's open
 * connection it hands over), then stay to hear what became of each send in `held`: taken, or
 * refused and put back (to the chat's open view, else its draft). It leaves once every send is
 * answered, or after COURIER_LISTEN_MS; the server takes over from there (server/ws.ts). A
 * connection that never opens (the server unreachable) puts the messages back at once.
 */
export function courier(path: string, frames: Frame[], held: Map<string, string>, deps: CourierDeps, ws?: WebSocket): void {
  const sends = new HeldSends();
  for (const f of frames) sends.sent(f);
  for (const [clientId, text] of held) sends.sent({ type: "prompt", clientId, text });
  const all = new Map([...held, ...sendsOf(frames)]);
  if (!frames.length && !sends.size) {
    ws?.close(1000, "client closed");
    return;
  }
  noteOnTheWay(path, all);
  const sock = ws ?? (deps.open ? deps.open(deps.url(path)) : new WebSocket(deps.url(path)));
  let opened = sock.readyState === WebSocket.OPEN;
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
    for (const f of frames) sock.send(JSON.stringify(f));
    if (!sends.size) return finish();
    timer = setTimeout(finish, deps.listenMs ?? COURIER_LISTEN_MS);
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    const back = sends.heardJson(ev.data);
    if (back.length)
      putBack(
        path,
        back.map((u) => u.text),
        back.map((u) => u.id),
      );
    if (!sends.size) finish();
  };
  sock.onclose = () => {
    if (done) return;
    // Never opened: nothing reached the server, so the messages come back now.
    if (!opened) putBack(path, [...sendsOf(frames).values()], [...sendsOf(frames).keys()]);
    finish();
  };
  if (opened) deliver();
  else sock.onopen = deliver;
}

/** At page load: what an earlier page kept and never delivered goes now, or, kept for more than
    PARCEL_TTL_MS, back to its chat's draft. */
export function deliverStranded(deps: CourierDeps, store = browserStore(), now = Date.now()): void {
  for (const p of takeParcels(store)) {
    if (now - p.at > PARCEL_TTL_MS) {
      const sends = sendsOf(p.frames);
      putBack(p.path, [...sends.values()], [...sends.keys()]);
      continue;
    }
    courier(p.path, p.frames, new Map(), deps);
  }
}
