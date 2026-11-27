// What happens to a chat as a whole, for the event stream (§app.events/names): `chat.created` when a new
// chat's home is made, `chat.removed` when a chat is deleted (or, with Transport, leaves this device).
// The sites that make and delete homes call `emitChatNews`; the hub listens only while someone
// subscribes, so with no listener this is one empty-set check.
export interface ChatNews {
  name: "chat.created" | "chat.removed";
  /** The top-level chat's id (its lead session's id). */
  chat: string;
  /** Its home folder, for a chat that has one. */
  home?: string;
}

const listeners = new Set<(n: ChatNews) => void>();

export function onChatNews(fn: (n: ChatNews) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitChatNews(n: ChatNews): void {
  if (!listeners.size) return;
  for (const fn of listeners) {
    try {
      fn(n);
    } catch {
      // a listener never stops the site that made or deleted the home
    }
  }
}
