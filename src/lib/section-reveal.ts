/**
 * The sidebar's sections that hold the open session (each project, the Projects head, Folders, Organizations, each
 * org, the Done tails, the Archive and its date sections) open when you MOVE to a session inside them, once, then are
 * yours to close. A collapse you make while on that session sticks through every list refresh, running agent and new
 * message, until you open it again or move to a session again (back to the same one included).
 *
 * A "visit" is one stay on one open session: its number changes each time the open session changes, and never on a
 * refresh. A section's dismissal is the visit it was collapsed on; it reveals the open session only while that
 * dismissal is not the current visit. The rules are inputs only; `createSectionReveal` is the reactive state the sidebar
 * holds, in memory (no new persistence).
 */
import { type Accessor, createMemo, createSignal, type Signal } from "solid-js";

/** One stay on one open session. `n` is unique for the page's life. */
export type Visit = { readonly path: string | null; readonly n: number };

/** The visit after the open session became `path`: the same object while it hasn't changed (so a memo stays quiet on
    a refresh), else a fresh number from `mint`. */
export const nextVisit = (prev: Visit, path: string | null, mint: () => number): Visit =>
  prev.n !== 0 && prev.path === path ? prev : { path, n: mint() };

/** The dismissal a user's toggle leaves: a collapse made while the section holds the open session is remembered for
    this visit; an open, or a collapse of a section not holding it, leaves none (the choice alone answers). */
export const dismissalAfterToggle = (open: boolean, holdsSelected: boolean, visit: number): number | undefined =>
  !open && holdsSelected ? visit : undefined;

/** Whether the section opens for the open session: it holds it, and the user hasn't collapsed it on this visit. */
export const revealsSelected = (holdsSelected: boolean, dismissedAt: number | undefined, visit: number): boolean =>
  holdsSelected && dismissedAt !== visit;

/** Visit numbers, unique for the page's life (a remounted sidebar never reuses one). */
let visits = 0;
const mintVisit = () => ++visits;

/** The dismissals by section key: the sidebar passes module state, so a section rebuilt by a poll keeps its own. */
export type Dismissals = Signal<Record<string, number | undefined>>;
export const createDismissals = (): Dismissals => createSignal<Record<string, number | undefined>>({});

/**
 * The sidebar's reveal state over the open session `selected`. `dismissed(key)`: the user collapsed that section on
 * this visit (feed it to the section's open rule beside `holdsSelected`). `noteToggle(key, open, held)`: call on a
 * user's own toggle of the section (never on the sidebar's own `open` update), `held` whether it holds the open session
 * now. Call inside a reactive owner (a component).
 */
export function createSectionReveal(selected: Accessor<string | null>, [dismissals, setDismissals]: Dismissals = createDismissals()) {
  const visit = createMemo<Visit>((prev) => nextVisit(prev, selected(), mintVisit), { path: null, n: 0 });
  return {
    dismissed: (key: string): boolean => dismissals()[key] === visit().n,
    noteToggle: (key: string, open: boolean, held: boolean): void => {
      const at = dismissalAfterToggle(open, held, visit().n);
      setDismissals((m) => ({ ...m, [key]: at }));
    },
  };
}
