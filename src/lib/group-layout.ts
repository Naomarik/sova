// How one workspace is laid out (spec/14-workspaces.md "Layout: split" / "Layout: tabs"): split
// (panes side by side in one horizontally scrolled row) or tabs (one pane shown, all of them
// mounted so every stream keeps running).
//
// What is persisted, and what isn't, is deliberate:
//   - the layout is remembered per group for the browser session
//     (`sessionStorage["sova:group-view-{id}"]`, read and mirrored at the legacy `pi-web:`
//     spelling while the rename bridge is open), because it is a posture, not a setting;
//   - a pane's width is memory only, for the same reason §1's sessions pane isn't persisted;
//   - the member ORDER is the server's (`SessionGroup.members`), never storage — it is what the
//     group is, and every tab and every server must see the same one.
//
// The pure helpers here are what the tests cover; the storage wrapper never throws, because a
// blocked or full sessionStorage must not break a render.

export type GroupLayoutMode = "split" | "tabs";

import { dualGet, dualSet } from "./storage-keys";

/** A pane narrower than this can't hold a transcript and a composer; the floor for every width. */
export const PANE_MIN_WIDTH = 440;
/** Past this one pane hides its neighbours, which is the opposite of what a workspace is for. */
export const PANE_MAX_WIDTH = 1040;
/** What Wider/Narrower move by. */
export const PANE_WIDTH_STEP = 120;
/** Below this viewport width a split row has no room for two panes: the workspace is tabs only. */
export const TABS_ONLY_WIDTH = 768;
/** Below this the head's tools can't stand beside the group's name, and become one menu (§14). */
export const HEAD_MENU_WIDTH = 640;

const KEY = (id: string) => `sova:group-view-${id}`;
/** The pre-rebrand spelling, read and mirrored while the rename bridge is open (storage-keys.ts). */
const LEGACY_KEY = (id: string) => `pi-web:group-view-${id}`;

export const clampWidth = (px: number): number => Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, Math.round(px)));

/** The width a pane starts at: `--workspace-pane-width`, clamp(440px, 34vw, 720px), in JS. */
export function defaultPaneWidth(viewport: number): number {
  if (!Number.isFinite(viewport) || viewport <= 0) return PANE_MIN_WIDTH;
  return Math.min(720, Math.max(PANE_MIN_WIDTH, Math.round(viewport * 0.34)));
}

/** Wider (+1) / Narrower (-1), clamped. Returns the current width when it can't move. */
export const stepWidth = (current: number, direction: 1 | -1): number => clampWidth(current + direction * PANE_WIDTH_STEP);

/**
 * The one direction a width below the floor can move: UP, back to the stepped range. `Narrower`
 * cannot — below `PANE_MIN_WIDTH` the only writer is `Fit all` (see `fitPaneWidth`), and a step
 * that reported "narrower" while raising a fitted 320px pane to the 440 floor would be the
 * announcement lying about what just happened. So a below-floor width is a dead end for
 * `Narrower` and a springboard for `Wider`, which is exactly how a posture you asked for should
 * leave the stepped world: deliberately, not by one press of a labelled button.
 */
export const stepFrom = (current: number, direction: 1 | -1): number =>
  current < PANE_MIN_WIDTH && direction === -1 ? current : stepWidth(current, direction);

/**
 * `Fit all` (spec/14-workspaces.md "Layout: split"): the one width at which `count` panes stand
 * in the row with no scrollbar — the row's inner width divided by the pane count. Panes are
 * `border-box` and the seam is a pane's own left border, so there is nothing to subtract: N of
 * these widths never exceed the row. Floored, not rounded, for the same reason.
 *
 * NOT floored at `PANE_MIN_WIDTH`, and that is the whole point of the action: 440 was chosen for
 * a transcript and a composer each on their own, and 4×440 = 1760px means a 4-way comparison
 * never fits any viewport this product is used at. A fit the user asked for is allowed to trade
 * solo readability for side-by-side reading — the reason the row exists — and says the number it
 * landed on out loud (the announcement, and the width a later `Wider`/`Narrower` starts from).
 * The stepped floor still bounds every width nobody asked to fit.
 */
export function fitPaneWidth(rowWidth: number, count: number): number {
  if (!Number.isFinite(rowWidth) || rowWidth <= 0 || !Number.isInteger(count) || count < 1) return PANE_MIN_WIDTH;
  return Math.min(PANE_MAX_WIDTH, Math.max(1, Math.floor(rowWidth / count)));
}

/**
 * `list` with one item moved a step in `direction`; unchanged at either end. The result is always
 * the WHOLE order, because that is what `PATCH {order}` means: the ids listed first, in that
 * order, and anything left out behind them.
 */
export function movePane(list: readonly string[], id: string, direction: 1 | -1): string[] {
  const from = list.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}

/** The pane to focus after `removed` leaves: its right-hand neighbour, else its left, else null. */
export function neighbourOf(list: readonly string[], removed: string): string | null {
  const i = list.indexOf(removed);
  if (i < 0) return null;
  return list[i + 1] ?? list[i - 1] ?? null;
}

/** The stored layout for this group, or null when it has never been chosen here. */
export function readMode(id: string): GroupLayoutMode | null {
  try {
    const v = dualGet(sessionStorage, KEY(id), LEGACY_KEY(id));
    return v === "split" || v === "tabs" ? v : null;
  } catch {
    return null;
  }
}

export function writeMode(id: string, mode: GroupLayoutMode): void {
  try {
    dualSet(sessionStorage, KEY(id), LEGACY_KEY(id), mode);
  } catch {
    // The choice still holds for this page; remembering it is a convenience.
  }
}
