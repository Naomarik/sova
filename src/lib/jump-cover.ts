/**
 * Jump to Latest never covers any part of a playbook's card standing in the conversation, a setup
 * card or a run's record (§chat.playbooks/run-card): while its box would lie over a card's, it isn't
 * shown. The rule is the two boxes' overlap, whatever put the card there: the view inside a tall
 * card, a card's end in view a little short of the conversation's end, an opened record.
 */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Whether two boxes share any area. Boxes that only touch at an edge don't, nor does an empty box. */
export function boxesOverlap(a: Box, b: Box): boolean {
  if (a.bottom <= a.top || a.right <= a.left || b.bottom <= b.top || b.right <= b.left) return false;
  return a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
}

/** Whether Jump to Latest, where it stands, would cover any of the cards. */
export function jumpCovers(jump: Box | null, cards: readonly Box[]): boolean {
  return !!jump && cards.some((card) => boxesOverlap(jump, card));
}

/** The transcript's box says so while any of its cards is under the button (PlaybookCard.css hides it then). */
const COVER_ATTR = "data-pb-under-jump";
const cardsOf = new WeakMap<HTMLElement, Set<HTMLElement>>();

/**
 * Watches one card in a transcript until the returned function is called: as the view scrolls or
 * anything changes size, the transcript is marked while Jump to Latest's box lies over any watched
 * card of it. The button's box is read where it stands, lifted or not, shown or not. DOM only.
 */
export function watchJumpCover(card: HTMLElement): () => void {
  const wrap = card.closest<HTMLElement>(".transcript-wrap");
  if (!wrap) return () => {};
  let cards = cardsOf.get(wrap);
  if (!cards) cardsOf.set(wrap, (cards = new Set()));
  cards.add(card);
  const watched = cards;
  let frame = 0;
  const check = () => {
    frame = 0;
    const jump = wrap.querySelector<HTMLElement>(":scope > .jump-latest");
    const boxes = [...watched].filter((c) => c.isConnected).map((c) => c.getBoundingClientRect());
    wrap.toggleAttribute(COVER_ATTR, jumpCovers(jump ? jump.getBoundingClientRect() : null, boxes));
  };
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  document.addEventListener("scroll", soon, { capture: true, passive: true });
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
  ro?.observe(card);
  ro?.observe(wrap);
  // The button moves without anything changing size or scrolling when a pinned bar lifts it.
  const moved = typeof MutationObserver === "undefined" ? null : new MutationObserver(soon);
  moved?.observe(wrap, { attributes: true, attributeFilter: ["style", "data-design-pinned", "data-pb-strip"] });
  soon();
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("scroll", soon, true);
    ro?.disconnect();
    moved?.disconnect();
    watched.delete(card);
    check();
  };
}
