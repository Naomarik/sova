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
    connection is open now; once it ends, nothing of it is handed back again. */
export interface ChatWait {
  ready: boolean;
  lost: boolean;
  conn: number;
  open: boolean;
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

/** Why the composer can't send for the connection's sake, or null once its chat is ready. */
export function waitReason(status: SocketStatus, wait: ChatWait): ComposerReason | null {
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
export const waitOnOpen = (wait: ChatWait): ChatWait => ({ ready: false, lost: wait.lost, conn: wait.conn + 1, open: true });

/** The socket's status changed: the next wait, and the connection whose unacknowledged sends go
    back to the composer (one that ended before its chat's hello), or null. `everOpened`: some
    connection of this view opened, so a wait from here on is a reconnect. */
export function waitOnStatus(wait: ChatWait, status: SocketStatus, everOpened: boolean): { next: ChatWait; handBack: number | null } {
  if (status === "open") return { next: wait, handBack: null };
  return { next: { ready: false, lost: wait.lost || everOpened, conn: wait.conn, open: false }, handBack: wait.open && !wait.ready ? wait.conn : null };
}

/** This connection's hello: ready, and no longer a reconnect. */
export const waitOnHello = (wait: ChatWait): ChatWait => ({ ready: true, lost: false, conn: wait.conn, open: wait.open });

/** A server `error` this view hasn't handled as a refusal of its own: before the connection's
    hello it is the chat failing to open, and that connection's unacknowledged sends go back (its
    number), else null. */
export const errorHandsBack = (wait: ChatWait): number | null => (wait.open && !wait.ready ? wait.conn : null);
