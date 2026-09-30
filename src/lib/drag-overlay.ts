// Dragging a session row opens a drop overlay (§app.session-list/drop-overlay): every place the
// row can go, all in view at once, instead of a target somewhere off screen in a scrolled list.
// Framework-free and clock-injected, like hold-select: the row wires pointer events to
// `createRowPress`, DropOverlay.tsx draws the tiles from `dropTiles` and hit-tests with `hitTile`.

import type { SessionGroup } from "../../shared/protocol";
import { type ArchiveDrag, archiveTileReason } from "./drag-archive";
import { createHoldGesture, HOLD_MOVE_PX, HOLD_MS } from "./hold-select";

/** How far a mouse press moves before it is a drag. No hold first: a mouse can't mean a scroll. */
export const DRAG_MOUSE_PX = 6;
/** How far a lifted row moves before it is a drag: the hold's own tolerance, so a still thumb stays a hold. */
export const DRAG_LIFTED_PX = HOLD_MOVE_PX;

export interface Point {
  x: number;
  y: number;
}

/**
 * One press on a row. `pressed`: down, not yet anything. `lifted`: held still past HOLD_MS, so a
 * release selects and a move drags. A move that starts the drag hands the press over (`onDrag`)
 * and the press is over: the drag lives outside the row, which a list poll may rebuild under it.
 */
export type PressPhase = "idle" | "pressed" | "lifted";

export interface RowPressOptions {
  /** The press was held still long enough: the row rises, and a release now selects it. */
  onLift(): void;
  /** The press became a drag at this point. */
  onDrag(at: Point): void;
  delayMs?: number;
  now?(): number;
  schedule?(fn: () => void, ms: number): unknown;
  unschedule?(handle: unknown): void;
}

export interface RowPress {
  /** A press began. `drag` is false where a row can't be dragged (selection mode). */
  start(at: Point, pointer: string, drag: boolean): void;
  move(at: Point): void;
  /** The press ended where it was. True when it had lifted: the caller selects. */
  finish(): boolean;
  /** The press is off without a choice: a scroll, a pointercancel, the window losing focus. */
  cancel(): void;
  phase(): PressPhase;
  /** Whether the click or context menu arriving now is the echo of a lift (see hold-select). */
  suppressed(): boolean;
}

export function createRowPress(opts: RowPressOptions): RowPress {
  let origin: Point | null = null;
  let mouse = false;
  let canDrag = false;
  let phase: PressPhase = "idle";
  const hold = createHoldGesture({
    delayMs: opts.delayMs ?? HOLD_MS,
    now: opts.now,
    schedule: opts.schedule,
    unschedule: opts.unschedule,
    onHold: () => {
      phase = "lifted";
      opts.onLift();
    },
  });
  const far = (at: Point, px: number) => !!origin && (Math.abs(at.x - origin.x) > px || Math.abs(at.y - origin.y) > px);
  const end = () => {
    origin = null;
    phase = "idle";
  };
  return {
    start(at, pointer, drag) {
      origin = at;
      mouse = pointer === "mouse";
      canDrag = drag;
      phase = "pressed";
      hold.start(at);
    },
    move(at) {
      if (phase === "idle" || !origin) return;
      if (phase === "pressed") {
        // A mouse drags before the hold's tolerance runs out; a thumb that moves is a scroll.
        if (mouse && canDrag && far(at, DRAG_MOUSE_PX)) {
          hold.cancel();
          end();
          opts.onDrag(at);
          return;
        }
        hold.move(at);
        if (far(at, HOLD_MOVE_PX)) {
          hold.cancel();
          end();
        }
        return;
      }
      // Lifted: a move is a drag, never a selection.
      if (far(at, DRAG_LIFTED_PX)) {
        hold.cancel(); // still inside the suppression window: the click this press leaves is swallowed
        end();
        if (canDrag) opts.onDrag(at);
      }
    },
    finish() {
      const lifted = phase === "lifted";
      hold.finish();
      end();
      return lifted;
    },
    cancel() {
      hold.cancel();
      end();
    },
    phase: () => phase,
    suppressed: () => hold.suppressed(),
  };
}

// ---------------------------------------------------------------------------
// What the overlay offers
// ---------------------------------------------------------------------------

/** The row in flight, as the drop needs it. Decided once, when the drag starts. */
export interface DragInfo {
  path: string;
  title: string;
  /** The group it is in now; null for none. A peer's group is its own host's, so null there too. */
  groupId: string | null;
  /** An organization's session: never joins a group (taking one out is fine). */
  org: boolean;
  /** The project an org session's archive toasts name (drag-archive's `orgProjectOf`). */
  orgProject: string | null;
  /** The peer's label, for a session that lives on another host; null on this one. */
  peer: string | null;
  archive: ArchiveDrag;
  archived: boolean;
}

/** A tile's id: a group id, or one of the fixed tiles. */
export type TileId = string;
export const NEW_TILE = "new";
export const REMOVE_TILE = "remove";
export const ARCHIVE_TILE = "archive";
export const CANCEL_TILE = "cancel";

export interface GroupTile {
  id: string;
  name: string;
  count: number;
  current: boolean;
  /** Why it can't take the row, or null. The overlay says it once, in the head's note. */
  disabled: string | null;
}

export interface DropTiles {
  /** Why no group can take this row — the one sentence the head says — or null. */
  groupNote: string | null;
  /** The New group tile's reason, or null when it works. */
  newDisabled: string | null;
  /** `Remove from “{name}”`, for a grouped row only. */
  remove: { name: string } | null;
  groups: GroupTile[];
  /** Why Archive can't take the row, or null when it archives. */
  archiveDisabled: string | null;
}

export const ORG_GROUP_REASON = "Organization sessions stay with their project.";
export const peerGroupReason = (peer: string) => `Groups hold this host's sessions only. That one lives on ${peer}.`;

/** Every tile the overlay shows for this row, in order, with what each would do. */
export function dropTiles(d: DragInfo, groups: readonly SessionGroup[], counts: ReadonlyMap<string, number>): DropTiles {
  const groupNote = d.peer ? peerGroupReason(d.peer) : d.org ? ORG_GROUP_REASON : null;
  const current = d.peer ? null : d.groupId;
  const currentGroup = current ? groups.find((g) => g.id === current) : undefined;
  return {
    groupNote,
    newDisabled: groupNote,
    remove: current ? { name: currentGroup?.name ?? "its group" } : null,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      count: counts.get(g.id) ?? 0,
      current: g.id === current,
      disabled: g.id === current ? null : groupNote,
    })),
    archiveDisabled: archiveTileReason(d.archive, d.archived),
  };
}

/** What a drop on `tile` does. `refused`: a disabled tile, which only says its reason. */
export type DropAction =
  | { kind: "none" }
  | { kind: "group"; groupId: string | null }
  | { kind: "new" }
  | { kind: "archive" }
  | { kind: "refused"; reason: string };

export function dropAction(tile: TileId | null, t: DropTiles): DropAction {
  if (tile === null || tile === CANCEL_TILE) return { kind: "none" };
  if (tile === NEW_TILE) return t.newDisabled ? { kind: "refused", reason: t.newDisabled } : { kind: "new" };
  if (tile === REMOVE_TILE) return t.remove ? { kind: "group", groupId: null } : { kind: "none" };
  if (tile === ARCHIVE_TILE) return t.archiveDisabled ? { kind: "refused", reason: t.archiveDisabled } : { kind: "archive" };
  const g = t.groups.find((x) => x.id === tile);
  if (!g || g.current) return { kind: "none" };
  return g.disabled ? { kind: "refused", reason: g.disabled } : { kind: "group", groupId: g.id };
}

/** The second line a tile shows under the pointer: what a drop does, in words, never hue alone. */
export function dropHint(tile: TileId, d: DragInfo): string {
  if (tile === NEW_TILE) return "Drop to name a new group";
  if (tile === REMOVE_TILE) return "Drop to remove";
  if (tile === ARCHIVE_TILE) return "Drop to archive";
  if (tile === CANCEL_TILE) return "Drop to cancel";
  return d.groupId && !d.peer ? "Drop to move here" : "Drop to add here";
}

/** `+ New group`'s resting second line when there is no group yet: the live fact, then what to do. */
export const NO_GROUPS_LINE = "No groups yet. Drop here to start one.";

/** A group tile's resting second line. */
export const groupCountLabel = (n: number) => (n === 0 ? "Empty" : n === 1 ? "1 session" : `${n} sessions`);

/**
 * The line under the floating card: where a drop right now would put the row, so the eye never
 * has to leave the card to know. A refused or inert tile says so; nothing under the pointer cancels.
 */
export function ghostTarget(tile: TileId | null, t: DropTiles, d: DragInfo): { text: string; refused: boolean } {
  const q = (name: string) => `“${name}”`;
  if (tile === null || tile === CANCEL_TILE) return { text: tile === null ? "Let go to cancel" : "Cancel", refused: false };
  if (tile === NEW_TILE) return t.newDisabled ? { text: "Can't drop here", refused: true } : { text: "Into a new group", refused: false };
  if (tile === REMOVE_TILE) return { text: t.remove ? `Remove from ${q(t.remove.name)}` : "Let go to cancel", refused: false };
  if (tile === ARCHIVE_TILE) return t.archiveDisabled ? { text: "Can't archive", refused: true } : { text: "Archive", refused: false };
  const g = t.groups.find((x) => x.id === tile);
  if (!g) return { text: "Let go to cancel", refused: false };
  if (g.current) return { text: `Already in ${q(g.name)}`, refused: true };
  if (g.disabled) return { text: "Can't drop here", refused: true };
  return { text: `${d.groupId && !d.peer ? "Move to" : "Add to"} ${q(g.name)}`, refused: false };
}

// ---------------------------------------------------------------------------
// How big the targets are
// ---------------------------------------------------------------------------

export interface DropListFit {
  /** A target's height at rest — a session row's — and the least it shrinks to (the touch floor). */
  rowHeight: number;
  minRowHeight: number;
  /** A column's width: the sessions pane's; never below the minimum, or it takes fewer columns. */
  columnWidth: number;
  minColumnWidth: number;
  maxColumns: number;
  gap: number;
}

export const DROP_LIST_FIT: DropListFit = { rowHeight: 52, minRowHeight: 44, columnWidth: 320, minColumnWidth: 260, maxColumns: 3, gap: 4 };

export interface DropListLayout {
  columns: number;
  /** Targets per column: they fill a column top to bottom, then continue in the next. */
  rows: number;
  rowHeight: number;
  columnWidth: number;
  /** The list's own size (without scrolling), and whether it is taller than the box and scrolls. */
  width: number;
  height: number;
  scroll: boolean;
}

/**
 * How `n` row-shaped targets sit in a box of at most `box` (the room the window leaves the list).
 * One column of session-row-sized targets first; when a column would be taller than the box they
 * continue in a 2nd, then a 3rd column (as many as the box's width allows at the minimum column
 * width); only once the widest list still doesn't fit do the rows shrink, down to the 44px floor,
 * and past that the list scrolls. The list is its own size, never stretched: the caller centres it.
 */
export function dropListLayout(n: number, box: { width: number; height: number }, fit: DropListFit = DROP_LIST_FIT): DropListLayout {
  const count = Math.max(1, n);
  const { gap } = fit;
  const widest = Math.max(1, Math.min(fit.maxColumns, Math.floor((box.width + gap) / (fit.minColumnWidth + gap))));
  const size = (columns: number, rowHeight: number, scroll: boolean): DropListLayout => {
    const rows = Math.ceil(count / columns);
    const columnWidth = Math.max(0, Math.min(fit.columnWidth, Math.floor((box.width - gap * (columns - 1)) / columns)));
    return { columns, rows, rowHeight, columnWidth, width: columns * columnWidth + gap * (columns - 1), height: rows * rowHeight + gap * (rows - 1), scroll };
  };
  // Not measured yet: one column at rest, so the first frame is already the right shape.
  if (box.width <= 0 || box.height <= 0) return size(1, fit.rowHeight, false);
  const fits = (rowHeight: number) => Math.max(1, Math.floor((box.height + gap) / (rowHeight + gap)));
  for (let c = 1; c <= widest; c++) if (count <= c * fits(fit.rowHeight)) return size(c, fit.rowHeight, false);
  const rows = Math.ceil(count / widest);
  const shrunk = Math.floor((box.height + gap) / rows - gap);
  if (shrunk >= fit.minRowHeight) return size(widest, shrunk, false);
  return size(widest, fit.minRowHeight, true);
}

/** How far above a fingertip the card floats: clear of the finger's own pad. */
export const GHOST_LIFT_PX = 32;
/** How far below and right of a mouse pointer's tip the card trails. */
export const GHOST_TRAIL = { x: 16, y: 20 };
const GHOST_MARGIN = 8;

/**
 * Where the floating card's top-left goes for a pointer at `p`. A finger gets it above, centred,
 * so the finger never covers it (below, when there is no room above); a mouse gets it trailing
 * below and right of the tip, flipped left or up at the window's edge. Always inside the window.
 */
export function ghostPlacement(p: Point, size: { width: number; height: number }, view: { width: number; height: number }, touch: boolean): Point {
  let x: number;
  let y: number;
  if (touch) {
    x = p.x - size.width / 2;
    y = p.y - GHOST_LIFT_PX - size.height;
    if (y < GHOST_MARGIN) y = p.y + GHOST_LIFT_PX;
  } else {
    x = p.x + GHOST_TRAIL.x;
    y = p.y + GHOST_TRAIL.y;
    if (x + size.width > view.width - GHOST_MARGIN) x = p.x - GHOST_TRAIL.x - size.width;
    if (y + size.height > view.height - GHOST_MARGIN) y = p.y - GHOST_TRAIL.y - size.height;
  }
  const clamp = (v: number, max: number) => Math.max(GHOST_MARGIN, Math.min(v, max - GHOST_MARGIN));
  return { x: clamp(x, view.width - size.width), y: clamp(y, view.height - size.height) };
}

// ---------------------------------------------------------------------------
// Where the pointer is
// ---------------------------------------------------------------------------

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const inside = (r: Rect, p: Point) => p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;

/**
 * The tile under the point, or null. A grid tile counts only inside its `clip` — the scrolling
 * grid's own box — so a tile scrolled half under the head or the bar isn't hit where it's hidden.
 * Disabled tiles are hit too: dropping there says why.
 */
export function hitTile(tiles: readonly { id: TileId; rect: Rect; clip?: Rect }[], p: Point): TileId | null {
  for (const t of tiles) if (inside(t.rect, p) && (!t.clip || inside(t.clip, p))) return t.id;
  return null;
}

/** How near the grid's top or bottom edge the pointer scrolls it. */
export const AUTO_SCROLL_EDGE = 56;
/** The fastest it scrolls, in px per frame, at the very edge. */
export const AUTO_SCROLL_MAX = 18;

/**
 * How far to scroll the grid this frame for a pointer at `y`: negative near the top, positive near
 * the bottom, faster the nearer the edge, 0 elsewhere (and outside the grid's rows altogether).
 */
export function autoScrollStep(y: number, box: { top: number; bottom: number }, edge = AUTO_SCROLL_EDGE, max = AUTO_SCROLL_MAX): number {
  if (y < box.top - edge || y > box.bottom + edge) return 0;
  const fromTop = y - box.top;
  const fromBottom = box.bottom - y;
  if (fromTop < edge) return -Math.ceil(max * Math.min(1, (edge - fromTop) / edge));
  if (fromBottom < edge) return Math.ceil(max * Math.min(1, (edge - fromBottom) / edge));
  return 0;
}

/** What opening the overlay announces. */
export const openAnnouncement = (title: string) => `Moving “${title}”. Drop it on a group, Archive, New group, or Cancel.`;
