import { createRoot, createSignal } from "solid-js";

/**
 * A new chat whose Send is held for decisions (asking mode): its setup card says what waits, its
 * composer reads it, and the composer's Review asks the card to open. Per session file, in this tab.
 */

export interface Hold {
  context: number;
  skills: number;
}

const store = createRoot(() => {
  const [holds, setHolds] = createSignal<Record<string, Hold>>({});
  const [review, setReview] = createSignal<{ path: string; n: number } | null>(null);
  const [reread, setReread] = createSignal<{ path: string; n: number } | null>(null);
  return { holds, setHolds, review, setReview, reread, setReread };
});

/** What waits in this chat, or null when Send isn't held for it. */
export const holdOf = (path: string): Hold | null => store.holds()[path] ?? null;

/** The setup card's word: `hold` null (or empty) clears it. */
export function setHold(path: string, hold: Hold | null): void {
  const cur = store.holds()[path];
  const empty = !hold || hold.context + hold.skills <= 0;
  if (empty ? !cur : cur && cur.context === hold!.context && cur.skills === hold!.skills) return;
  store.setHolds((all) => {
    const next = { ...all };
    if (empty) delete next[path];
    else next[path] = hold!;
    return next;
  });
}

let asks = 0;
/** Review, from the composer: the chat's setup card opens its list and comes into view. */
export const askReview = (path: string): void => void store.setReview({ path, n: ++asks });
/** The latest Review asked of a chat (a fresh object per ask, so the same chat can ask twice). */
export const reviewAsked = () => store.review();

/** The chat's setup should be read again (a send refused for decisions, a decision made elsewhere). */
export const askReread = (path: string): void => void store.setReread({ path, n: ++asks });
export const rereadAsked = () => store.reread();
