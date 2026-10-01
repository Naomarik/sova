import { createContext, useContext } from "solid-js";

/**
 * Card refs (§app.overseer/links): the Overseer names a card as `[c_5](#c_5)`. The markdown renderer
 * turns such an href into an in-app link that never changes the route; a click asks the chat that
 * holds the thread to jump to that card (its newest snapshot, older rows built down to it first).
 */

/** The card id a `#c_N` href names, else null; any other `#…` href is not a card ref. */
export function cardRefId(href: string): string | null {
  return /^#(c_[1-9]\d*)$/.exec(href)?.[1] ?? null;
}

/** How a chat jumps to one of its cards by id; absent outside a chat (a ref then only scrolls). */
export const CardJumpContext = createContext<((id: string) => void) | null>(null);
export const useCardJump = () => useContext(CardJumpContext);

/** Scrolls the thread on screen to a card's full rendering; false when it isn't there. */
export function scrollToCardId(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  return !!el;
}
