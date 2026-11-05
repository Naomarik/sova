/**
 * The page's one right-click menu (§app/context-menus). One panel for the whole page, mounted once
 * in App (`ContextMenuHost`), filled on demand: never a hidden menu per row. A place — a session
 * row, a group heading, a pane head, a message — opens it from its own `onContextMenu` with
 * `openContextMenu`, handing over the same menu body its ⋯ (or action strip) draws, so the two
 * doors can't drift. Shift+F10 and the Menu key reach the same handlers: the key's owner sends a
 * `contextmenu` to the focused element, and the place under it answers as for a right-click.
 *
 * Solid delegates `contextmenu`, so handlers run innermost first: the innermost place takes the
 * event (prevents its default) and every place around it sees it taken and does nothing.
 */
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { bindKey } from "../commands/keys";
import { contextAction, type ContextAction, contextPointerKind, createKeyEcho, inPopover, inTextEntry, onContentLink, pointInRects, type PointerKind } from "../lib/context-menu";
import type { MenuAnchor } from "../lib/menu-position";
import { type ActionMenuApi, MenuPanel, type MenuPanelControls } from "./ActionMenu";

/** What a place's menu is: its name, where focus goes back to, and its body. */
export interface ContextMenuSpec {
  /** The menu's accessible name, the ⋯ trigger's ("Actions for “Fix the build”"). */
  label: string;
  /** The thing's own focus target (its row link, heading, pane head): Escape and a row's action
      put focus back here. Opened from the keyboard, the focused element is used instead. */
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
  anchor: MenuAnchor;
}

const [current, setCurrent] = createSignal<OpenMenu | null>(null);
let panel: MenuPanelControls | null = null;
/** The kind of the last pointer that went down, for a browser whose `contextmenu` doesn't say. */
let lastPointer: string | null = null;
/** True only while the key's owner hands its `contextmenu` to the focused element. */
let fromKey = false;
const echo = createKeyEcho();

/** Whether the pointer is on the text selected right now (its boxes, not merely its nodes). */
function onSelectionAt(x: number, y: number): boolean {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) if (pointInRects(x, y, Array.from(sel.getRangeAt(i).getClientRects()))) return true;
  return false;
}

/**
 * A place's `onContextMenu`: decides (lib/context-menu `contextAction`), and opens Sova's menu for
 * this place when the answer is `open`. The browser's own menu is left alone unless the answer is
 * `open` or `swallow`. One menu at a time: a menu already open moves here.
 */
export function openContextMenu(e: MouseEvent, place: ContextPlace): ContextAction {
  const kind: PointerKind = fromKey ? "keyboard" : contextPointerKind(e as MouseEvent & { pointerType?: unknown; mozInputSource?: unknown }, lastPointer);
  const target = e.target instanceof Element ? e.target : null;
  const action = contextAction({
    kind,
    shiftKey: e.shiftKey,
    taken: e.defaultPrevented,
    holds: !!place.holds,
    textEntry: inTextEntry(target),
    inPopover: inPopover(target),
    contentLink: onContentLink(target, (a) => place.el.contains(a as Element), place.ownLink ?? null),
    onSelection: kind !== "keyboard" && onSelectionAt(e.clientX, e.clientY),
  });
  if (action === "swallow") e.preventDefault();
  if (action !== "open") return action;
  if (!panel) return "native"; // no host on this page: the browser's menu, as before
  e.preventDefault();
  const spec = place.menu();
  // From a key: under the focused element, and focus goes back to it.
  const focused = kind === "keyboard" && target instanceof HTMLElement ? target : null;
  const anchor: MenuAnchor = kind === "keyboard" ? { kind: "rect", rect: (focused ?? spec.origin).getBoundingClientRect(), align: "start" } : { kind: "point", x: e.clientX, y: e.clientY };
  if (panel.isOpen()) panel.close();
  setCurrent({ ...spec, origin: focused ?? spec.origin, anchor });
  panel.open();
  return "open";
}

/** A place going away closes the menu it opened: the menu acts on what is on screen. */
export function closeContextMenuOf(origin: Element | undefined) {
  const m = current();
  if (m && origin && (m.origin === origin || origin.contains(m.origin))) panel?.close();
}

/** The page's one right-click menu. Mounted once, in App. */
export function ContextMenuHost() {
  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      lastPointer = e.pointerType;
      echo.pointerDown();
    };
    // Capture, ahead of every place: the browser's own keyboard menu after a key already opened
    // Sova's is that key's echo, and reaches no place at all.
    const onContext = (e: MouseEvent) => {
      if (fromKey || !echo.isEcho()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKeyUp = (e: KeyboardEvent) => (e.key === "ContextMenu" || e.key === "F10") && echo.keyUp();
    addEventListener("pointerdown", onPointerDown, true);
    addEventListener("contextmenu", onContext, true);
    addEventListener("keyup", onKeyUp, true);
    // Shift+F10 and the Menu key: the focused element's place answers, as for a right-click. When
    // no place takes it, the key stays the browser's.
    const offKey = bindKey("menu.context", (e) => {
      if (e.repeat) return !!panel?.isOpen(); // a held key opens once
      const at = document.activeElement;
      if (!at || at === document.body) return false;
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true });
      fromKey = true;
      try {
        at.dispatchEvent(ev);
      } finally {
        fromKey = false;
      }
      if (!ev.defaultPrevented) return false;
      echo.opened();
      return true;
    });
    onCleanup(() => {
      removeEventListener("pointerdown", onPointerDown, true);
      removeEventListener("contextmenu", onContext, true);
      removeEventListener("keyup", onKeyUp, true);
      offKey();
    });
  });
  onCleanup(() => (panel = null));
  return (
    <MenuPanel
      anchor={() => current()?.anchor ?? { kind: "point", x: 0, y: 0 }}
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
