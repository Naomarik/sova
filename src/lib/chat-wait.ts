// A chat view waiting for its chat (§chat.transcript/instant-open): every connection waits for its
// own `hello` before Send and the composer's controls work, and says so in a note over the
// transcript's end rather than in the composer. What the pane sent on a connection that ends (or
// whose chat fails to open) before that hello never reached a chat: it goes back to the composer.
// Only that connection's sends: one made on an earlier connection after its hello may well have
// been taken by the chat, so a later start failing never hands it back. Pure, for the unit tier;
// ChatView keeps the state in a signal.

import type { ComposerReason } from "../components/Composer";
import type { SocketStatus } from "./socket";

/** `ready`: this connection's chat said its hello. `lost`: the connection ended (or its chat didn't
    open) since the last hello, so the wait reads "Reconnecting". `conn`: which connection this is
    (1 for the first that opened; 0 before any did): every send is tagged with it. `open`: that
    connection is open now; once it ends, nothing of it is handed back again. `asleep`: the chat
    closed for being quiet and the view holds no socket until something needs the chat; `waking`:
    something did, and the connection that wakes it hasn't opened yet (it reads Connecting, not
    Reconnecting). Both absent otherwise. */
export interface ChatWait {
  ready: boolean;
  lost: boolean;
  conn: number;
  open: boolean;
  asleep?: true;
  waking?: true;
}

export const WAIT_START: ChatWait = { ready: false, lost: false, conn: 0, open: false };

/** How long a chat's first connect waits for its rows from the file (§chat.transcript/instant-open):
    past it, the socket opens without naming a row, and the read, if it ever lands, is ignored. */
export const FILE_READ_WAIT_MS = 1_500;

/** The chat connecting or starting, and the connection retrying: said by the note over the
    transcript's end, so the composer's reason is for assistive technology only (`quiet`). */
export const CONNECTING: ComposerReason = { icon: "clock", text: "Connecting to chat…", soft: true, quiet: true };
export const RECONNECTING: ComposerReason = { icon: "clock", text: "Reconnecting. Your draft is kept.", quiet: true };
export const NOT_CONNECTED: ComposerReason = { icon: "clock", text: "Not connected." };

/** Why the composer can't send for the connection's sake, or null once its chat is ready. A chat
    closed while quiet waits for nothing: Send is what wakes it. */
export function waitReason(status: SocketStatus, wait: ChatWait): ComposerReason | null {
  if (wait.asleep) return null;
  switch (status) {
    case "connecting":
      return wait.lost ? RECONNECTING : CONNECTING;
    case "reconnecting":
      return RECONNECTING;
    case "failed":
    case "closed":
      return NOT_CONNECTED;
  }
  return wait.ready ? null : wait.lost ? RECONNECTING : CONNECTING;
}

/** A new connection opened: it waits for its own hello, and its sends are its own. */
export const waitOnOpen = (wait: ChatWait): ChatWait => ({ ready: false, lost: wait.lost, conn: wait.conn + 1, open: true, ...(wait.waking ? { waking: true as const } : {}) });

/** The socket's status changed: the next wait, and the connection whose unacknowledged sends go
    back to the composer (one that ended before its chat's hello), or null. `everOpened`: some
    connection of this view opened, so a wait from here on is a reconnect. */
export function waitOnStatus(wait: ChatWait, status: SocketStatus, everOpened: boolean): { next: ChatWait; handBack: number | null } {
  if (status === "open") return { next: wait, handBack: null };
  // Asleep, the view closed its socket itself; waking, the connection is a first one again until it opens.
  const quietly = wait.asleep || (wait.waking && !wait.open);
  const next: ChatWait = { ready: false, lost: wait.lost || (everOpened && !quietly), conn: wait.conn, open: false };
  if (wait.asleep) next.asleep = true;
  else if (wait.waking && !wait.open) next.waking = true;
  return { next, handBack: wait.open && !wait.ready ? wait.conn : null };
}

/** This connection's hello: ready, and no longer a reconnect. */
export const waitOnHello = (wait: ChatWait): ChatWait => ({ ready: true, lost: false, conn: wait.conn, open: wait.open });

/** The chat closed for being quiet (§app.chat-processes/idle-stop): asleep, its socket closed by the
    view, nothing to hand back (each send it took was acknowledged or refused before it closed). */
export const waitOnSleep = (wait: ChatWait): ChatWait => ({ ready: false, lost: false, conn: wait.conn, open: false, asleep: true });

/** Something needs the chat: the view connects, and says Connecting until that connection's hello. */
export const waitOnWake = (wait: ChatWait): ChatWait => ({ ready: false, lost: false, conn: wait.conn, open: false, waking: true });

/** A server `error` this view hasn't handled as a refusal of its own: before the connection's
    hello it is the chat failing to open, and that connection's unacknowledged sends go back (its
    number), else null. */
export const errorHandsBack = (wait: ChatWait): number | null => (wait.open && !wait.ready ? wait.conn : null);

/**
 * What a tab asks of a chat closed while quiet (§chat.transcript/instant-open, "A chat closed while
 * its tab is open"): a send, a model or thinking change, a row's request, a mode or sandbox switch.
 * Each is held, in order, and done once at the hello of the connection that wakes the chat. `id`:
 * a send's client id, its row already shown, whose text goes back to the composer when the tab gives
 * up instead; `dropped`: told when it gives up. Pure, for the unit tier.
 */
export class WakeQueue {
  private acts: { run: () => void; id?: string; dropped?: () => void }[] = [];

  get size(): number {
    return this.acts.length;
  }

  hold(run: () => void, o: { id?: string; dropped?: () => void } = {}): void {
    this.acts.push({ run, ...o });
  }

  /** The woken connection's hello: each held act runs once, oldest first; a later hello runs none of them again. */
  flush(): void {
    const acts = this.acts;
    this.acts = [];
    for (const a of acts) a.run();
  }

  /** The chat refused, or the tab gave up connecting: nothing runs; each act is told so, and the held
      sends' ids come back, once. */
  drop(): string[] {
    const acts = this.acts;
    this.acts = [];
    for (const a of acts) a.dropped?.();
    return acts.flatMap((a) => (a.id === undefined ? [] : [a.id]));
  }
}

/** While asleep, the list's word on whether the server holds the chat (its `chat` field): once it
    said not, a hold seen after that is someone else's open (another tab, a worker's report), so the
    tab connects; a hold not yet seen gone is the closed process's own, still listed. */
export function heldWhileAsleep(sawGone: boolean, held: boolean): { sawGone: boolean; connect: boolean } {
  if (!held) return { sawGone: true, connect: false };
  return { sawGone, connect: sawGone };
}
