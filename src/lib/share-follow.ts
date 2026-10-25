/**
 * The owner's Project Assistant chat (§app.owner-page/content), its pure parts. No DOM: the share
 * page passes its measurements and views.
 *
 * It follows its newest message as Sova's own chat does (§chat.transcript auto-follow): while the
 * page sits within this many pixels of its end it keeps scrolling there as an answer streams in;
 * once the owner has scrolled further up to read, nothing moves the page until they come back down
 * or send.
 */
export const FOLLOW_SLACK_PX = 80;

/** Whether a page scrolled to `top`, showing `height` of `total`, is at (or near) its end. */
export function nearEnd(top: number, height: number, total: number): boolean {
  return total - height - top <= FOLLOW_SLACK_PX;
}

/**
 * The next read's messages, each one that didn't change replaced by the object already on screen,
 * so a list keyed by identity redraws only what changed (an interactive drawing keeps its state
 * through the re-reads while a version starts).
 */
export function keepUnchanged<T>(prev: readonly T[], next: T[]): T[] {
  if (!prev.length) return next;
  return next.map((m, i) => (i < prev.length && prev[i] !== undefined && JSON.stringify(prev[i]) === JSON.stringify(m) ? prev[i]! : m));
}
