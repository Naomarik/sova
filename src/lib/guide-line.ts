// A group's guide line collapses it (§app.session-list/guide-lines). The line is a direct child of the group it draws
// beside: a <details> (an org, a user group, a folder, a Done, an Archive day), whose head is its <summary>, or a
// Projects-region project's block, whose head is `.org-project-head` and whose fold is its arrow button.
//
// Pressing the line closes the group through the head's own path: `details.open = false` fires the same `toggle` the
// head's press fires, so the sidebar's toggle handlers remember the choice exactly as they do for the head, and a
// project's fold calls the arrow's own handler. Then, if the head had scrolled out of view above the list's top, the
// list scrolls so the collapsed head sits at the top; a head in view never moves (lib/list-scroll-hold holds it).

/** The class every guide line carries, and what the list's scroll hold looks for under a press. */
export const GUIDE_LINE = "guide-line";

/** The head of the group a guide line belongs to, or null. */
export function guideHeadOf(line: Element): HTMLElement | null {
  return line.parentElement?.querySelector<HTMLElement>(":scope > summary, :scope > .org-project-head") ?? null;
}

/**
 * How far to scroll the list (added to its scrollTop) so a head that ended up above the list's top sits at the top;
 * 0 when the head's top is at or below it (half a pixel of rounding counts as there).
 */
export function headRevealDelta(headTop: number, listTop: number): number {
  return headTop < listTop - 0.5 ? headTop - listTop : 0;
}

/** The nearest ancestor that scrolls vertically, else null. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const y = getComputedStyle(n).overflowY;
    if ((y === "auto" || y === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** Scrolls the list so `head` is at its top when it is above it; leaves the list alone otherwise. */
export function revealHead(head: HTMLElement): void {
  const list = scrollerOf(head);
  if (!list) return;
  const d = headRevealDelta(head.getBoundingClientRect().top, list.getBoundingClientRect().top);
  if (d !== 0) list.scrollTop += d;
}

/**
 * A press on a guide line: closes its group as a press on the head would, then brings the head into view if it had
 * scrolled out above. `fold` is a project's own fold handler (its head is a button, not a <summary>); a <details>
 * group is closed by its `open`, which fires its `toggle`. A closed group's line does nothing.
 */
export function collapseFromLine(line: HTMLElement, fold?: () => void): void {
  const host = line.parentElement;
  if (!host) return;
  if (fold) fold();
  else if (host instanceof HTMLDetailsElement) {
    if (!host.open) return;
    host.open = false;
  } else return;
  const head = guideHeadOf(line);
  if (head) revealHead(head);
}
