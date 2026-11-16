// A sidebar session row's own menu (§app.session-list): a right-click on the row, or a finger's or
// pen's hold let go without moving. What the menu offers a session and why a row can't run, where
// the panel goes for a pointer, and when a right-click's menu may show. Pure and DOM-free at
// import, so the rules run under `pnpm test`; components/SessionContextMenu.tsx draws the panel and
// Sidebar.tsx's SessionRow reads the facts off its events.

import type { SessionSummary } from "../../shared/protocol";
import { gistTitle } from "./agents-board";
import { type ArchiveDrag, archiveTileReason } from "./drag-archive";
import type { DropTiles } from "./drag-overlay";
import { summaryLineOf } from "./summary-row";

// ---- what the menu offers ---------------------------------------------------------------------

/** The menu's rows for one session. A `disabled` string is the reason the row can't run; "" runs. */
export interface RowMenuModel {
  /** Rename…, Use Gist as Title and Reset to Original Title; null for a chat Sova names itself,
      which keeps its name (the Agents board's rule): no title rows at all. */
  title: {
    /** The title the gist would give, shown under its row; null when there is none to give. */
    gist: string | null;
    gistDisabled: string;
    /** The title it had before it was renamed, shown under Reset's row. */
    original: string | undefined;
    resetDisabled: string;
  } | null;
  /** Move to Group…: the drop panel's reason when no group can take it (an organization's or a peer's session). */
  moveDisabled: string;
  /** Archive, or Unarchive on an archived row; `act` null when Archive can't run (`disabled` says why). */
  archive: { label: "Archive" | "Unarchive"; act: "archive" | "unarchive" | null; disabled: string };
}

/**
 * The rows `s` gets. `drag` is the row's archive drag as the drop panel decides it (busy as the row
 * shows it), `tiles` the drop panel's tiles for it: the menu refuses exactly what the panel refuses,
 * in the panel's words.
 */
export function rowMenuOf(s: Pick<SessionSummary, "title" | "originalTitle" | "fixedName" | "archived" | "outlineGist" | "outlineNow">, drag: ArchiveDrag, tiles: Pick<DropTiles, "groupNote">): RowMenuModel {
  const gist = gistTitle(s);
  const title = s.fixedName
    ? null
    : {
        gist,
        gistDisabled: gist ? "" : summaryLineOf(s as SessionSummary) ? "The gist is already the title." : "No gist yet.",
        original: s.originalTitle,
        resetDisabled: s.originalTitle === undefined ? "Not renamed." : "",
      };
  const moveDisabled = tiles.groupNote ?? "";
  const archive: RowMenuModel["archive"] = s.archived
    ? { label: "Unarchive", act: "unarchive", disabled: "" }
    : drag.kind === "archive"
      ? { label: "Archive", act: "archive", disabled: "" }
      : { label: "Archive", act: null, disabled: archiveTileReason(drag, s.archived) ?? "" };
  return { title, moveDisabled, archive };
}

/** One row of Move to Group's list: `id` null is No group. `current`: the row is there now (checked, runs nothing). */
export interface GroupChoice {
  id: string | null;
  name: string;
  current: boolean;
  disabled: string;
}

/** Move to Group's rows, from the drop panel's tiles: No group, then each group, in the panel's order and words. */
export function groupChoices(t: Pick<DropTiles, "groups" | "remove">): GroupChoice[] {
  return [
    { id: null, name: "No group", current: !t.remove, disabled: "" },
    ...t.groups.map((g) => ({ id: g.id, name: g.name, current: g.current, disabled: g.disabled ?? "" })),
  ];
}

// ---- where the panel goes ---------------------------------------------------------------------

/** The gap the panel keeps from every window edge. */
export const EDGE_GAP = 8;
/** A panel squeezed below this scrolls rather than becoming a sliver. */
export const MIN_PANEL_HEIGHT = 140;

export interface Viewport {
  width: number;
  height: number;
}

/** The room to give the panel before it is measured (`--menu-max`): the larger side of the pointer's. */
export function pointMenuRoom(at: { x: number; y: number }, view: Viewport): number {
  return Math.round(Math.max(view.height - EDGE_GAP - at.y, at.y - EDGE_GAP, MIN_PANEL_HEIGHT));
}

/**
 * Where the measured panel goes (`--menu-top`, `--menu-left`): its corner on the pointer, below and
 * to the right when that fits, flipped up or left when it doesn't, then clamped inside the window
 * with EDGE_GAP to spare (what holds when neither side fits, or the window is smaller than the panel).
 */
export function pointMenuSpot(at: { x: number; y: number }, box: { width: number; height: number }, view: Viewport): { top: number; left: number } {
  const below = view.height - EDGE_GAP - at.y;
  const top = box.height <= below ? at.y : at.y - box.height;
  const left = box.width <= view.width - EDGE_GAP - at.x ? at.x : at.x - box.width;
  const maxTop = Math.max(EDGE_GAP, view.height - EDGE_GAP - box.height);
  const maxLeft = Math.max(EDGE_GAP, view.width - EDGE_GAP - box.width);
  return { top: Math.round(Math.min(Math.max(top, EDGE_GAP), maxTop)), left: Math.round(Math.min(Math.max(left, EDGE_GAP), maxLeft)) };
}

// ---- which menu a contextmenu gets --------------------------------------------------------------

/** What made a `contextmenu`: a mouse (or trackpad), a finger, a pen, or a key. */
export type PointerKind = "mouse" | "touch" | "pen" | "keyboard";

/**
 * The input a `contextmenu` came from. Chromium sends a PointerEvent with a `pointerType` ("" for a
 * key on some builds); Firefox says it in `mozInputSource`; a browser that says neither gets the kind
 * of the row's last press, so a long press there is still a finger's.
 */
export function contextPointerKind(e: { pointerType?: unknown; mozInputSource?: unknown }, lastPointer: string | null): PointerKind {
  if (typeof e.pointerType === "string") {
    if (e.pointerType === "") return "keyboard";
    if (e.pointerType === "mouse" || e.pointerType === "touch" || e.pointerType === "pen") return e.pointerType;
  }
  const moz: Record<number, PointerKind> = { 1: "mouse", 2: "pen", 5: "touch", 6: "keyboard" };
  if (typeof e.mozInputSource === "number" && moz[e.mozInputSource]) return moz[e.mozInputSource]!;
  return lastPointer === "touch" || lastPointer === "pen" ? lastPointer : "mouse";
}

/**
 * Whether the row's own gesture owns this `contextmenu`: a hold that fired (its suppression window),
 * a drag in flight, or a finger's or pen's press still down (Android sends its long-press menu
 * around the 500ms the hold fires at, sometimes before it). A mouse press in flight doesn't: a
 * right-click is a press of its own.
 */
export const holdOwns = (p: { suppressed: boolean; dragging: boolean; phase: string; pointerKind: string }): boolean =>
  p.suppressed || p.dragging || (p.phase !== "idle" && p.pointerKind !== "mouse");

/**
 * What a row's `contextmenu` gets. `swallow`: neither menu (the echo of a hold or a drag);
 * `native`: the browser's own (Shift held, a key's menu, or a finger's or pen's long press the row
 * doesn't own); `open`: the row's menu. Only a mouse's right-click opens it: a finger or pen opens
 * it by the hold's release instead, and the keyboard keeps the browser's.
 */
export function rowContextAction(f: { owned: boolean; kind: PointerKind; shiftKey: boolean }): "swallow" | "native" | "open" {
  if (f.owned) return "swallow";
  if (f.kind !== "mouse" || f.shiftKey) return "native";
  return "open";
}

/** The Menu key alone, or Shift+F10: the keys that make a `contextmenu`. */
export const isContextMenuKey = (e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean =>
  !e.altKey && !e.ctrlKey && !e.metaKey && ((e.key === "F10" && e.shiftKey) || (e.key === "ContextMenu" && !e.shiftKey));

/** How long after a menu key's keydown the `contextmenu` it makes may arrive (Windows sends it on the key's release). */
export const KEY_MENU_MS = 1500;

/**
 * Tells a key-made `contextmenu` from a right-click. Chromium on Linux sends a key's as a mouse's,
 * so the row marks the menu key's keydown and the next `contextmenu` takes the mark (once, and
 * only within KEY_MENU_MS, so a mark whose event never came can't turn a later right-click into a
 * key's). An event at (0, 0) is a key's too.
 */
export function createKeyMenuMark(now: () => number = Date.now) {
  let at: number | null = null;
  return {
    /** A keydown on the row: marked when it is a menu key. */
    keydown(e: Parameters<typeof isContextMenuKey>[0]) {
      if (isContextMenuKey(e)) at = now();
    },
    /** The `contextmenu` now arriving came from a key. Consumes the mark. */
    take(e: { clientX: number; clientY: number }): boolean {
      const marked = at !== null && now() - at <= KEY_MENU_MS;
      at = null;
      return marked || (e.clientX === 0 && e.clientY === 0);
    },
  };
}

// ---- a mouse's menu shows on the release ------------------------------------------------------

/**
 * Whether a `contextmenu` came while a mouse button is still held (`buttons` not 0): Linux and macOS
 * send it on the press, Windows on the release, and a key's has no button. Shown during the press,
 * the menu would sit under the pointer, and the release would land outside it and light-dismiss it.
 */
export const pressHeld = (kind: PointerKind, buttons: number | undefined): boolean => kind === "mouse" && !!buttons;

/** The little of a window or document the waiting open listens on; the tests pass stand-ins. */
export interface ListenerTarget {
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
}

export interface ReleaseEnv {
  /** The window: pointerup, pointercancel, keydown and a newer contextmenu (capture), and its own blur. */
  win: ListenerTarget;
  /** The document, for visibilitychange. */
  doc: ListenerTarget & { visibilityState: string };
  /** Runs `fn` on a later task (past the release's light dismiss, mouseup and click); answers how to cancel it. */
  later(fn: () => void): () => void;
}

/**
 * At most one menu waiting for its press to finish. `request` shows it at once when no button is
 * held, else once every button is back up (the first `pointerup` with `buttons` 0, then one task
 * later). It waits with no deadline and is abandoned, opening nothing, on `pointercancel`, the
 * window's blur, the page turning hidden, an Escape keydown, a newer `contextmenu` or a newer
 * request. Listens only while one waits.
 */
export function createOpenOnRelease(env: ReleaseEnv) {
  let waiting: (() => void) | null = null;
  let cancelLater: (() => void) | null = null;
  const onUp = (e: Event) => {
    if (!waiting || cancelLater || (e as Event & { buttons?: number }).buttons) return;
    const run = waiting;
    cancelLater = env.later(() => {
      cancelLater = null;
      stop();
      run();
    });
  };
  const onKey = (e: Event) => (e as Event & { key?: string }).key === "Escape" && stop();
  const onVisibility = () => env.doc.visibilityState === "hidden" && stop();
  const stop = () => {
    if (!waiting) return;
    waiting = null;
    cancelLater?.();
    cancelLater = null;
    listen(false);
  };
  const listen = (on: boolean) => {
    const m = on ? "addEventListener" : "removeEventListener";
    env.win[m]("pointerup", onUp, true);
    env.win[m]("pointercancel", stop, true);
    env.win[m]("keydown", onKey, true);
    // Added while the opening contextmenu bubbles: a window capture listener first hears the next one.
    env.win[m]("contextmenu", stop, true);
    // Not capture: the window's own blur only (an element's blur doesn't bubble).
    env.win[m]("blur", stop);
    env.doc[m]("visibilitychange", onVisibility);
  };
  return {
    /** Show the menu (`run`) now, or on the release when `held`. */
    request(held: boolean, run: () => void) {
      stop();
      if (!held) return run();
      waiting = run;
      listen(true);
    },
    /** A menu is waiting for its release. */
    waiting: () => waiting !== null,
  };
}
