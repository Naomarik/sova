// A jump to a review card in another chat (a worker's queue card points to the review card in the chat that runs it):
// the pointer leaves the card's id here before the link opens that chat, and the card takes it once when it draws,
// landing on its top and taking focus as the same-chat jump does. One waits at a time and goes stale after a while,
// so a card scrolled into view much later never steals focus. Pure: no Solid, no DOM.

/** How long a jump waits for its card to draw. */
export const REVIEW_JUMP_MS = 15_000;

let pending: { id: string; at: number } | null = null;

/** The pointer was followed to another chat: its card should take the jump when it draws. */
export function leaveReviewJump(id: string, now: number = Date.now()): void {
  pending = { id, at: now };
}

/** Whether this card is the jump's target; a match is taken, so it lands once. */
export function takeReviewJump(id: string, now: number = Date.now()): boolean {
  if (!pending) return false;
  if (now - pending.at > REVIEW_JUMP_MS) {
    pending = null;
    return false;
  }
  if (pending.id !== id) return false;
  pending = null;
  return true;
}
