// The help button's card (components/HelpPopover.tsx, §chat.memory/help): where the card sits and
// where focus goes when it closes. Pure, so the rules are tested without a DOM.

/** The gap the card keeps from every viewport edge, and the one it keeps from its button. */
export const HELP_EDGE_GAP = 8;
export const HELP_TRIGGER_GAP = 6;

export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * The card's top-left: under the button, its left edge on the button's, when that fits; above the
 * button when only that side has the room; always inside the window. A card taller than both sides
 * sits at the top edge and scrolls (its max height is the window's).
 */
export function placeHelpCard(trigger: Box, card: { width: number; height: number }, view: { width: number; height: number }): { top: number; left: number } {
  const below = view.height - HELP_EDGE_GAP - (trigger.bottom + HELP_TRIGGER_GAP);
  const above = trigger.top - HELP_TRIGGER_GAP - HELP_EDGE_GAP;
  const top = card.height <= below || below >= above ? trigger.bottom + HELP_TRIGGER_GAP : trigger.top - HELP_TRIGGER_GAP - card.height;
  const maxTop = Math.max(HELP_EDGE_GAP, view.height - HELP_EDGE_GAP - card.height);
  const maxLeft = Math.max(HELP_EDGE_GAP, view.width - HELP_EDGE_GAP - card.width);
  return {
    top: Math.round(Math.min(Math.max(top, HELP_EDGE_GAP), maxTop)),
    left: Math.round(Math.min(Math.max(trigger.left, HELP_EDGE_GAP), maxLeft)),
  };
}

/** How the card closed: Escape, its × button, a press outside it, or focus moving elsewhere. */
export type HelpCloseReason = "escape" | "close-button" | "outside" | "focus-left";

/**
 * Whether closing hands focus back to the `?`. Escape and × always do. A press outside or a Tab
 * away leaves focus where the user put it, unless it fell to nowhere (the page body) or is still
 * inside the closing card — then the `?` takes it, so the keyboard never loses its place.
 */
export function refocusAfterClose(reason: HelpCloseReason, focus: "inside" | "body" | "elsewhere"): boolean {
  if (reason === "escape" || reason === "close-button") return true;
  return focus !== "elsewhere";
}
