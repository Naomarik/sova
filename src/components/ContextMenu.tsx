/**
 * The page's one right-click menu (§app/context-menus). One panel for the whole page, mounted once
 * in App (`ContextMenuHost`), filled on demand: never a hidden menu per row. A place — a session
 * row, a group heading, a pane head, a message — opens it from its own `onContextMenu` with
 * `openContextMenu` (src/components/MenuPlace.tsx `openMenu`), handing over the same declaration
 * its ⋯ draws, so the two doors can't drift.
 *
 * Solid delegates `contextmenu`, so handlers run innermost first: the innermost place takes the
 * event (prevents its default) and every place around it sees it taken and does nothing. A
 * keyboard-made `contextmenu` is never taken: Sova has no keyboard context-menu gesture.
 */
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { contextAction, type ContextAction, contextPointerKind, createOpenOnRelease, createPressSelection, inPopover, inTextEntry, onContentLink, pointInRects, type PointerKind, pressHeld } from "../lib/context-menu";
import type { MenuAnchor } from "../lib/menu-position";
import { type ActionMenuApi, MenuPanel, type MenuPanelControls } from "./ActionMenu";

/** What a place's menu is: where focus goes back to, and its body. */
export interface ContextMenuSpec {
  /** The thing's own focus target (its row link, heading, pane head): Escape and a row's action
      put focus back here. */
  origin: HTMLElement;
  /** The same body the place's ⋯ draws, handed the menu's API. */
  body(menu: ActionMenuApi): JSX.Element;
}

/** A place's side of one `contextmenu` event. */
export interface ContextPlace {
  /** The place's element: the row, the heading, the pane head. */
  el: Element;
  /** The place's own row link, which is the row itself, not a link inside content. */
  ownLink?: Element | null;
  /** The place's own gesture owns the event (a session row's hold or drag: lib/context-menu holdOwns). */
  holds?: boolean;
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
/** A mouse's menu waits for the button's release (lib/context-menu `createOpenOnRelease`); made by the host. */
let release: ReturnType<typeof createOpenOnRelease> | null = null;

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

/**
 * A place's `onContextMenu`: decides (lib/context-menu `contextAction`), and opens Sova's menu for
 * this place when the answer is `open`. The browser's own menu is left alone unless the answer is
 * `open` or `swallow`. One menu at a time: a menu already open moves here. With a mouse button
 * still held (Linux and macOS send `contextmenu` on the press) it shows on the release, so the
 * release can't light-dismiss it; Windows' (sent on the release) shows at once.
 */
export function openContextMenu(e: MouseEvent, place: ContextPlace): ContextAction {
  const kind: PointerKind = contextPointerKind(e as MouseEvent & { pointerType?: unknown; mozInputSource?: unknown }, lastPointer);
  const target = e.target instanceof Element ? e.target : null;
  const action = contextAction({
    kind,
    shiftKey: e.shiftKey,
    taken: e.defaultPrevented,
    holds: !!place.holds,
    textEntry: inTextEntry(target),
    inPopover: inPopover(target),
    contentLink: onContentLink(target, (a) => place.el.contains(a as Element), place.ownLink ?? null),
    onSelection: onSelectionAt(e.clientX, e.clientY),
  });
  if (action === "swallow") e.preventDefault();
  if (action !== "open") return action;
  if (!panel || !release) return "native"; // no host on this page: the browser's menu, as before
  e.preventDefault();
  // The word a Mac's browser selected under this press isn't left selected under Sova's menu.
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
    // The panel is a popover: Escape hands focus back to what held it as the panel opened, which
    // after a right-click is whatever the press focused. Holding the thing then makes that the thing.
    origin.focus({ preventScroll: true });
    panel.open();
  };
  const held = pressHeld(kind, e.buttons);
  // The press closes an open menu now; the new one shows on its release.
  if (held && panel.isOpen()) panel.close();
  release.request(held, origin, show);
  return "open";
}

/** A place going away closes the menu it opened: the menu acts on what is on screen. */
export function closeContextMenuOf(origin: Element | undefined) {
  if (origin) release?.cancelOf((k) => k === origin || origin.contains(k as Node));
  const m = current();
  if (m && origin && (m.origin === origin || origin.contains(m.origin))) panel?.close();
}

/** The page's one right-click menu. Mounted once, in App. */
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
    const onPointerDown = (e: PointerEvent) => {
      lastPointer = e.pointerType;
      nativeMenuKey = false;
      pressSelection.pressed();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      nativeMenuKey = (e.key === "F10" && e.shiftKey) || e.key === "ContextMenu";
    };
    // Linux Chromium labels the keyboard's own contextmenu as a mouse event. Keep it away from
    // Sova's handlers without preventing its default: whatever the browser does is what happens.
    const onContext = (e: MouseEvent) => {
      if (!nativeMenuKey) return;
      nativeMenuKey = false;
      e.stopImmediatePropagation();
    };
    addEventListener("pointerdown", onPointerDown, true);
    addEventListener("keydown", onKeyDown, true);
    addEventListener("contextmenu", onContext, true);
    onCleanup(() => {
      removeEventListener("pointerdown", onPointerDown, true);
      removeEventListener("keydown", onKeyDown, true);
      removeEventListener("contextmenu", onContext, true);
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
