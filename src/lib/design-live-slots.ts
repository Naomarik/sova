/**
 * Who may hold a live page's connection. A page being written is one open response, and a browser
 * gives a host about 6 connections over HTTP/1.1, so a chat full of writing cards would stall the
 * app's own requests. At most this many frames connect; the rest wait their turn.
 */
export const DESIGN_LIVE_FRAMES = 4;

export interface LiveSlotHolder {
  /** The design open full-size: it goes ahead of the grid, taking the longest-held tile's place. */
  priority: boolean;
  grant(): void;
  /** Its connection was given to an open design: drop it and wait for the next grant. */
  revoke(): void;
}

export interface LiveSlots {
  /** Joins the line; the answer leaves it or gives the slot back. */
  ask(holder: LiveSlotHolder): () => void;
}

export function createLiveSlots(max = DESIGN_LIVE_FRAMES): LiveSlots {
  const held: LiveSlotHolder[] = [];
  const waiting: LiveSlotHolder[] = [];
  const pump = () => {
    while (held.length < max && waiting.length) {
      const i = waiting.findIndex((h) => h.priority);
      const [next] = waiting.splice(i < 0 ? 0 : i, 1);
      held.push(next!);
      next!.grant();
    }
  };
  return {
    ask(holder) {
      if (holder.priority && held.length >= max) {
        const i = held.findIndex((h) => !h.priority);
        if (i >= 0) {
          const [out] = held.splice(i, 1);
          waiting.unshift(out!);
          out!.revoke();
        }
      }
      waiting.push(holder);
      pump();
      return () => {
        for (const list of [held, waiting]) {
          const i = list.indexOf(holder);
          if (i >= 0) list.splice(i, 1);
        }
        pump();
      };
    },
  };
}

/** The page's one line of live frames. */
export const designLiveSlots = createLiveSlots();
