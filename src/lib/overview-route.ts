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

/** The tab's mark that Sova was opened in it once already: a reload keeps where it is. */
export const LAUNCH_KEY = "sova:launched";

/** Whether opening Sova at this address lands on Home: a narrow viewport (a phone, a folded Fold) at the plain address. */
export const homeOnBoot = (hash: string, narrow: boolean): boolean => narrow && (hash === "" || hash === "#" || hash === "#/");

/**
 * A fresh launch on a narrow viewport (§app.shell/overview): once per tab, the plain address becomes the list with Home
 * one history entry above it, as if the four-squares button had been pressed, so Back (and the Sessions card) reach the
 * list and Back from Home never closes the app. A reload or a later visit to the list never redirects: the tab's
 * sessionStorage mark says Sova was already opened. Returns whether it went to Home. Run before routes are read.
 */
export function launchHome(env: {
  hash: string;
  narrow: boolean;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  replace(hash: string): void;
  push(hash: string): void;
}): boolean {
  try {
    if (env.storage?.getItem(LAUNCH_KEY)) return false;
    env.storage?.setItem(LAUNCH_KEY, "1");
  } catch {
    // No storage: every load is a launch.
  }
  if (!homeOnBoot(env.hash, env.narrow)) return false;
  env.replace("#/");
  env.push(OVERVIEW_HREF);
  fromList = true;
  return true;
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
