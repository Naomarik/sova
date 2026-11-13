/**
 * The page's one pointer context menu (§app/context-menus). One panel for the whole page, mounted
 * once in App (`ContextMenuHost`), filled on demand: never a hidden menu per row. A place — a
 * session row, a group heading, a pane head or a worktree row — opens it from `onContextMenu` with
 * `openContextMenu`, or starts the same menu's 500ms touch/pen hold with `holdContextMenu`
 * (src/components/MenuPlace.tsx `openMenu` and `holdMenu`), handing over one declaration.
 *
 * Solid delegates `contextmenu`, so handlers run innermost first: the innermost place takes the
 * event (prevents its default) and every place around it sees it taken and does nothing. A
 * keyboard-made `contextmenu` is never taken: Sova has no keyboard context-menu gesture.
 */
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import {
  contextAction,
  type ContextAction,
  contextPointerKind,
  createMenuHold,
  createOpenOnRelease,
  createPressSelection,
  inPopover,
  inTextEntry,
  onContentLink,
  pointInRects,
  type PointerKind,
  pressHeld,
  startsPress,
} from "../lib/context-menu";
import type { MenuAnchor } from "../lib/menu-position";
import type { Point } from "../lib/drag-overlay";
import { type ActionMenuApi, MenuPanel, type MenuPanelControls } from "./ActionMenu";

/** What a place's menu is: where focus goes back to, and its body. */
export interface ContextMenuSpec {
  /** The thing's own focus target (its row link, heading, pane head): Escape and a row's action
      put focus back here. */
  origin: HTMLElement;
  /** The declaration's one body, handed the menu's API. */
  body(menu: ActionMenuApi): JSX.Element;
}

/** A place's side of a pointer menu gesture. */
export interface ContextPlace {
  /** The place's element: the row, the heading, the pane head. */
  el: Element;
  /** The place's own row link, which is the row itself, not a link inside content. */
  ownLink?: Element | null;
  /** The place's own mouse gesture owns the event (a session row's lift or drag). */
  holds?: boolean;
  /** A draggable session row's handoff if touch/pen moves after its lift. */
  drag?(at: Point): void;
  /** Show and settle the row's lifted state at the deadline and the gesture's end. */
  lift?(on: boolean): void;
  /** Built only when the menu opens. */
  menu(): ContextMenuSpec;
}

interface OpenMenu extends ContextMenuSpec {
  /** Read on every placement: the point follows its row when the list scrolls beneath the panel. */
  anchor(): MenuAnchor;
}

const [current, setCurrent] = createSignal<OpenMenu | null>(null);
let panel: MenuPanelControls | null = null;
/** The kind of the last pointer that went down, for a browser whose `contextmenu` doesn't say. */
let lastPointer: string | null = null;
/** A browser keyboard menu is passing through: never let Sova's places claim its mouse-labelled event. */
let nativeMenuKey = false;
/** A mouse's menu waits for the button's release (lib/context-menu `createOpenOnRelease`). */
let release: ReturnType<typeof createOpenOnRelease> | null = null;
/** The one touch/pen hold, including its click/contextmenu echo after release. */
let hold: ReturnType<typeof createMenuHold> | null = null;

/** The ranges selected now, copied so a later change to the selection leaves them as they were. */
function selectedRanges(): Range[] {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return [];
  return Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange());
}
const pressSelection = createPressSelection(selectedRanges);

/** Whether the pointer is on the text selected before this press (its boxes, not merely its nodes). */
function onSelectionAt(x: number, y: number): boolean {
  return pressSelection.counted().some((r) => pointInRects(x, y, Array.from(r.getClientRects())));
}

function decide(e: MouseEvent | PointerEvent, place: ContextPlace, fromHold: boolean): { kind: PointerKind; action: ContextAction } {
  const kind: PointerKind = contextPointerKind(e as PointerEvent & { mozInputSource?: unknown }, lastPointer);
  const target = e.target instanceof Element ? e.target : null;
  const action = contextAction({
    kind,
    held: fromHold,
    shiftKey: e.shiftKey,
    // A prevented pointerdown is not an inner contextmenu place taking the event.
    taken: fromHold ? false : e.defaultPrevented,
    holds: !!place.holds,
    textEntry: inTextEntry(target),
    inPopover: inPopover(target),
    contentLink: onContentLink(target, (a) => place.el.contains(a as Element), place.ownLink ?? null),
    onSelection: onSelectionAt(e.clientX, e.clientY),
  });
  return { kind, action };
}

/**
 * A place's `contextmenu`, or its completed hold: opens Sova's menu when the shared rule answers
 * `open`. The browser's own menu is left alone unless the answer is `open` or `swallow`. One menu
 * at a time: a menu already open moves here. A mouse's menu still waits for its release where the
 * browser sends `contextmenu` during the press; a completed touch/pen hold shows immediately.
 */
export function openContextMenu(e: MouseEvent | PointerEvent, place: ContextPlace, fromHold = false): ContextAction {
  const { kind, action } = decide(e, place, fromHold);
  if (action === "swallow") e.preventDefault();
  if (action !== "open") return action;
  if (!panel || !release) return "native"; // no host on this page: the browser's menu, as before
  e.preventDefault();
  // The word a browser selected under this press isn't left selected under Sova's menu.
  if (pressSelection.madeByPress()) getSelection()?.removeAllRanges();
  const spec = place.menu();
  // Keep the pointer's offset within the place, not one viewport position captured forever: every
  // later scroll/resize placement reads the place's current box and follows the same row.
  const opened = spec.origin.getBoundingClientRect();
  const offset = { x: e.clientX - opened.left, y: e.clientY - opened.top };
  const anchor = (): MenuAnchor => {
    const now = spec.origin.getBoundingClientRect();
    return { kind: "point", x: now.left + offset.x, y: now.top + offset.y };
  };
  const origin = spec.origin;
  const show = () => {
    if (!panel) return;
    if (panel.isOpen()) panel.close();
    setCurrent({ ...spec, origin, anchor });
    // The panel is a popover: Escape hands focus back to what held it as the panel opened.
    origin.focus({ preventScroll: true });
    panel.open(fromHold);
  };
  const waiting = pressHeld(kind, e.buttons);
  // A mouse's press closes an open menu now; the new one shows on its release.
  if (waiting && panel.isOpen()) panel.close();
  release.request(waiting, origin, show);
  return "open";
}

/**
 * A place's touch/pen `pointerdown`: start the 500ms hold only where Sova's menu is eligible.
 * Nothing is prevented here, so lifting early remains an ordinary tap and movement can scroll or
 * become the row's drag. The host suppresses the native long-press echo once this press owns it.
 */
export function holdContextMenu(e: PointerEvent, place: ContextPlace): void {
  const kind = contextPointerKind(e, lastPointer);
  if ((kind !== "touch" && kind !== "pen") || !hold || !panel || e.isPrimary === false || !startsPress(e)) return;
  if (decide(e, place, true).action !== "open") return;
  hold.start({
    key: place.el,
    pointerId: e.pointerId,
    at: { x: e.clientX, y: e.clientY },
    drag: place.drag,
    lift: place.lift,
    show: () => openContextMenu(e, place, true) === "open",
  });
}

/** Whether this browser event is the active hold's, or the fired hold's echo on the same place. */
function ownedEvent(e: Event): boolean {
  const owned = hold?.owned();
  return owned instanceof Element && e.target instanceof Node && owned.contains(e.target);
}

/** A place going away closes the menu it opened and abandons its pending hold. */
export function closeContextMenuOf(origin: Element | undefined) {
  if (origin) release?.cancelOf((k) => k === origin || origin.contains(k as Node));
  const owned = hold?.owned();
  if (origin && owned instanceof Element && (owned === origin || origin.contains(owned))) hold?.cancel();
  const m = current();
  if (m && origin && (m.origin === origin || origin.contains(m.origin))) panel?.close();
}

/** The page's one pointer context menu. Mounted once, in App. */
export function ContextMenuHost() {
  onMount(() => {
    release = createOpenOnRelease({
      win: window,
      doc: document,
      later: (fn) => {
        const t = setTimeout(fn, 0);
        return () => clearTimeout(t);
      },
    });
    hold = createMenuHold();
    const onPointerDown = (e: PointerEvent) => {
      panel?.dismissOutside(e.target);
      lastPointer = e.pointerType;
      nativeMenuKey = false;
      pressSelection.pressed();
      if (e.pointerType === "mouse") hold?.cancel();
    };
    const onPointerMove = (e: PointerEvent) => hold?.move(e.pointerId, { x: e.clientX, y: e.clientY });
    const onPointerUp = (e: PointerEvent) => hold?.finish(e.pointerId);
    const onPointerCancel = (e: PointerEvent) => hold?.cancel(e.pointerId);
    // Implicit touch capture may be lost on release; that ends the press but needs no other act.
    const onLostPointerCapture = (e: PointerEvent) => hold?.cancel(e.pointerId);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        hold?.cancel();
        if (panel?.isHeldOpen()) {
          e.preventDefault();
          panel.close();
        }
      }
      nativeMenuKey = (e.key === "F10" && e.shiftKey) || e.key === "ContextMenu";
    };
    // Linux Chromium labels the keyboard's own contextmenu as a mouse event. Keep it away from
    // Sova's handlers without preventing its default: whatever the browser does is what happens.
    const onContext = (e: MouseEvent) => {
      if (nativeMenuKey) {
        nativeMenuKey = false;
        e.stopImmediatePropagation();
      } else if (ownedEvent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    // A completed hold's release must not follow the row's own link or activate the panel beneath it.
    const onClick = (e: MouseEvent) => {
      const id = (e as PointerEvent).pointerId;
      const echo = typeof id === "number" ? hold?.echo(id) : ownedEvent(e);
      if (!echo) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const abandonHold = (close = false) => {
      hold?.cancel();
      if (close && panel?.isHeldOpen()) panel.close();
    };
    // A scroll abandons the press without closing the menu it already opened.
    const onScroll = () => abandonHold();
    const onBlur = () => abandonHold(true);
    const onVisibility = () => document.visibilityState === "hidden" && abandonHold(true);
    const onDragStart = () => abandonHold();
    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable && hold?.held()) e.preventDefault();
    };
    addEventListener("pointerdown", onPointerDown, true);
    addEventListener("pointermove", onPointerMove, true);
    addEventListener("pointerup", onPointerUp, true);
    addEventListener("pointercancel", onPointerCancel, true);
    addEventListener("lostpointercapture", onLostPointerCapture, true);
    addEventListener("keydown", onKeyDown, true);
    addEventListener("contextmenu", onContext, true);
    addEventListener("click", onClick, true);
    addEventListener("scroll", onScroll, true);
    addEventListener("blur", onBlur);
    addEventListener("dragstart", onDragStart, true);
    addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      removeEventListener("pointerdown", onPointerDown, true);
      removeEventListener("pointermove", onPointerMove, true);
      removeEventListener("pointerup", onPointerUp, true);
      removeEventListener("pointercancel", onPointerCancel, true);
      removeEventListener("lostpointercapture", onPointerCancel, true);
      removeEventListener("keydown", onKeyDown, true);
      removeEventListener("contextmenu", onContext, true);
      removeEventListener("click", onClick, true);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("blur", onBlur);
      removeEventListener("dragstart", onDragStart, true);
      removeEventListener("touchmove", onTouchMove, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      hold?.cancel();
      hold = null;
      release?.cancelOf(() => true);
      release = null;
    });
  });
  onCleanup(() => (panel = null));
  return (
    <MenuPanel
      anchor={() => current()?.anchor() ?? { kind: "point", x: 0, y: 0 }}
      origin={() => current()?.origin}
      returnFocus
      onToggle={(open) => !open && setCurrent(null)}
      controls={(c) => (panel = c)}
    >
      {(menu) => (
        <Show when={current()} keyed>
          {(m) => m.body(menu)}
        </Show>
      )}
    </MenuPanel>
  );
}
