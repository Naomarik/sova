// The overview on a phone (§app.shell/overview). At 768px and up it is the empty main column
// beside the list, as always. Folded (< 768px) `#/` is the list and the main column is hidden, so the
// overview gets a route of its own, opened from a button in the list's head.

export const OVERVIEW_HREF = "#/overview";

export const isOverviewHash = (hash: string): boolean => hash === OVERVIEW_HREF || hash === `${OVERVIEW_HREF}/`;

/** Whether this tab reached the overview from the list's own button, so the entry under it
    in history is the list. Only this tab's navigation sets it; a reload or a typed link doesn't. */
let fromList = false;

/** The list head's button: the overview, one history entry above the list. */
export function openOverview(): void {
  fromList = true;
  location.hash = OVERVIEW_HREF;
}

/**
 * Back to the list from the overview (its Sessions card): history.back() when the list's button
 * brought us here, so Back doesn't then return to the overview; otherwise a new `#/` entry.
 * `back` and `go` are the caller's (window.history.back, a hash write) so a test can stand in.
 */
export function leaveOverview(back: () => void = () => history.back(), go: (hash: string) => void = (h) => (location.hash = h)): void {
  if (fromList) {
    fromList = false;
    back();
  } else go("#/");
}
