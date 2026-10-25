// Which code a chat in its own process runs, as its head and banner say it
// (§app.chat-processes/code-pickup): the chat socket's `code` message, read into words.
// No Solid, no DOM: the chat view holds the signal, this decides what it reads as.

import type { ChatCodeState, ChatServerMessage } from "../../shared/protocol";

/** The chat's code as last said; null = current (no `code` message since the hello, or one saying so). */
export interface CodeView {
  state: Exclude<ChatCodeState, "current">;
  /** A Reload Now waits for the chat's next quiet moment. */
  pending: boolean;
  /** Why the reload didn't start ("failed"). */
  detail?: string;
}

export function codeView(msg: Extract<ChatServerMessage, { type: "code" }>): CodeView | null {
  if (msg.state === "current") return null;
  return { state: msg.state, pending: !!msg.pending, ...(msg.detail ? { detail: msg.detail } : {}) };
}

/** The head's chip: "On older code" while older or after a failed start (the chat still runs it). */
export function codeChip(view: CodeView | null): { label: string; title: string } | null {
  if (!view) return null;
  if (view.state === "reloading") return { label: "Reloading", title: "Starting this chat on new code. It reconnects when it's ready." };
  return { label: "On older code", title: "This chat keeps the code it started with until its next quiet moment." };
}

/** What keeps a reload waiting, as the chat view knows it. */
export interface Quiet {
  running: boolean;
  workersWorking: number;
}

/**
 * The head's Reload Now button: offered while older; once pressed into a busy chat it waits, and says
 * for what. None while reloading, and none after a failed start: the banner's Try Again is that one.
 */
export function reloadButton(view: CodeView | null, quiet: Quiet): { label: string; waiting: boolean } | null {
  if (!view || view.state !== "older") return null;
  if (!view.pending) return { label: "Reload Now", waiting: false };
  if (!quiet.running && quiet.workersWorking > 0)
    return { label: quiet.workersWorking === 1 ? "Reloads when its worker finishes" : "Reloads when its workers finish", waiting: true };
  return { label: "Reloads after this reply", waiting: true };
}

/** What the chat view hands its head: the state as an accessor, what keeps a reload waiting, and Reload Now. */
export interface CodeControl {
  view(): CodeView | null;
  quiet(): Quiet;
  reload(): void;
}

/** The banner of a reload that didn't start: what happened, what it means, the reason. */
export function codeFailure(view: CodeView | null): { title: string; body: string } | null {
  if (view?.state !== "failed") return null;
  const why = view.detail?.trim();
  return { title: "Couldn't start this chat on new code.", body: `It keeps running on older code.${why ? ` ${why}` : ""}` };
}
