// A chat view waiting for its chat (§chat.transcript/instant-open): every connection waits for its
// own `hello` before Send and the composer's controls work, and says so in a note over the
// transcript's end rather than in the composer. What the pane sent on a connection that ends (or
// whose chat fails to open) before that hello never reached a chat: it goes back to the composer.
// Pure, for the unit tier; ChatView keeps the state in a signal.

import type { ComposerReason } from "../components/Composer";
import type { SocketStatus } from "./socket";

/** `ready`: this connection's chat said its hello. `lost`: the connection ended (or its chat didn't
    open) since the last hello, so the wait reads "Reconnecting". */
export interface ChatWait {
  ready: boolean;
  lost: boolean;
}

export const WAIT_START: ChatWait = { ready: false, lost: false };

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

/** The socket's status changed: the next wait, and whether the pane's unacknowledged sends go back
    to the composer (a connection that ended before its chat's hello). `everOpened`: some
    connection of this view opened, so a wait from here on is a reconnect. */
export function waitOnStatus(wait: ChatWait, status: SocketStatus, everOpened: boolean): { next: ChatWait; handBack: boolean } {
  if (status === "open") return { next: wait, handBack: false };
  return { next: { ready: false, lost: wait.lost || everOpened }, handBack: !wait.ready };
}

/** This connection's hello: ready, and no longer a reconnect. */
export const waitOnHello = (): ChatWait => ({ ready: true, lost: false });

/** A server `error` this view hasn't handled as a refusal of its own: before the connection's
    hello it is the chat failing to open, and the pane's unacknowledged sends go back. */
export const errorHandsBack = (wait: ChatWait): boolean => !wait.ready;
