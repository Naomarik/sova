/**
 * Whether a popover's focus loss means the user left it (close) or not, decided once focus has settled.
 * DOM-free: the caller reads the facts. A focusout with no next target comes from a click on nothing, a
 * window switch, or the popover swapping out the focused button itself (a step change), which drops focus to
 * <body>; only the first is leaving.
 */
export interface FocusSettled {
  /** Where focus is now is inside the popover's wrapper. */
  inside: boolean;
  /** Focus is on nothing (document.body or null). */
  onBody: boolean;
  /** The element that lost focus is still in the document. */
  fromConnected: boolean;
  /** The window still has focus (false: the user switched away, which is not leaving the popover). */
  windowFocused: boolean;
}

export function leftPopover(f: FocusSettled): boolean {
  if (f.inside) return false;
  if (!f.fromConnected && f.onBody) return false;
  if (!f.windowFocused) return false;
  return true;
}
