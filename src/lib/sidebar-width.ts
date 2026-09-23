/** The sessions pane's width, as the `--sidebar-width` token (tokens.css:262).
 *  Pure arithmetic: the one DOM-touching helper is `applySidebarWidth`, named for it.
 *  Nothing here persists — every load starts at DEFAULT_SIDEBAR_WIDTH (the collapsed spine, and the
 *  in-memory width it restores, are `spine.ts`). */

export const DEFAULT_SIDEBAR_WIDTH = 320;
/** The head's floor: brand, New Session and the 44px collapse toggle need 299px of pane. */
export const MIN_SIDEBAR_WIDTH = 300;
export const MAX_SIDEBAR_WIDTH = 560;

/** The session pane's floor while the subagents pane is a column (`--main-min`, tokens.css:266). */
const MAIN_MIN_WIDTH = 440;

/** The widest the sessions pane may be: the token cap, the viewport minus the main pane's floor
    (--main-min, 440px), and whatever the Subagents pane is already occupying. */
export function maxSidebarWidth(viewport: number, subagentsWidth = 0): number {
  const room = viewport - MAIN_MIN_WIDTH - subagentsWidth;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, room));
}

/** Rounded, clamped width for a drag. */
export function clampSidebarWidth(width: number, viewport: number, subagentsWidth = 0): number {
  const max = maxSidebarWidth(viewport, subagentsWidth);
  return Math.round(Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, width)));
}

/** Write the token on the root element. The only DOM in this module. */
export function applySidebarWidth(root: HTMLElement, width: number): void {
  root.style.setProperty("--sidebar-width", `${Math.round(width)}px`);
}
