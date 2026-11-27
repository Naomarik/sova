/**
 * A pane-foot menu's behaviour: a `popover="auto"` panel of menu items beside the button that opens it, as the host
 * menu (src/components/MeshHostMenu.tsx) and the person menu (src/components/ListPlace.tsx) draw them. It places the
 * panel below its trigger if it fits, else above, clamped inside the window, and follows a resize or a scroll while
 * open; it walks the items with the arrow keys, Home and End, picks with Enter or Space, and closes on Tab; and it
 * puts focus back on the trigger when the menu closes with focus inside, unless a choice placed it. Each menu draws
 * its own markup and wires `onKeyDown` and `onToggle` on its panel. Touches the DOM only when called, never at load.
 */
import { createSignal, onCleanup, type Accessor } from "solid-js";

/** The gap the panel keeps from the viewport edges and from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

export interface PopoverMenu {
  /** Whether the panel is open (its toggle event's word). */
  open: Accessor<boolean>;
  /** Lay the panel out again (its content changed size). */
  place(): void;
  openMenu(): void;
  closeMenu(): void;
  /** Close for a choice that places focus itself (a sheet, a dialog). */
  closeChosen(): void;
  /** Close for a pick: focus goes back to the trigger, then `then` runs. */
  choose(then: () => void): void;
  /** The panel's keydown. */
  onKeyDown(e: KeyboardEvent): void;
  /** The panel's toggle. */
  onToggle(e: Event): void;
}

export function createPopoverMenu(opts: {
  trigger: () => HTMLElement;
  menu: () => HTMLElement;
  /** The item to focus on opening (a missing one is the first). */
  startAt: () => number;
  /** After the panel opened and placed itself. */
  onOpen?: () => void;
}): PopoverMenu {
  const [open, setOpen] = createSignal(false);
  /** The menu closed because of a choice: focus is placed by the choice, not the toggle. */
  let chose = false;

  const items = () => [...opts.menu().querySelectorAll<HTMLElement>("[role^=menuitem]")];
  const focusItem = (i: number) => {
    const list = items();
    if (!list.length) return;
    list[((i % list.length) + list.length) % list.length]!.focus();
  };

  /** Below the trigger if it fits, else above (the foot's case), left edges aligned, clamped inside
   *  the window (measured, not guessed). */
  const place = () => {
    const menu = opts.menu();
    if (!menu.isConnected || !menu.matches(":popover-open")) return;
    const r = opts.trigger().getBoundingClientRect();
    const below = innerHeight - EDGE_GAP - (r.bottom + TRIGGER_GAP);
    const above = r.top - TRIGGER_GAP - EDGE_GAP;
    menu.style.setProperty("--menu-max", `${Math.round(Math.max(below, above, 140))}px`);
    const box = menu.getBoundingClientRect();
    const top = box.height <= below ? r.bottom + TRIGGER_GAP : r.top - TRIGGER_GAP - box.height;
    menu.style.setProperty("--menu-top", `${Math.round(Math.min(Math.max(top, EDGE_GAP), Math.max(EDGE_GAP, innerHeight - EDGE_GAP - box.height)))}px`);
    menu.style.setProperty("--menu-left", `${Math.round(Math.min(Math.max(r.left, EDGE_GAP), Math.max(EDGE_GAP, innerWidth - EDGE_GAP - box.width)))}px`);
  };

  const openMenu = () => {
    chose = false;
    opts.menu().showPopover();
    place();
    const at = opts.startAt();
    queueMicrotask(() => focusItem(Math.max(0, at)));
    opts.onOpen?.();
  };
  const closeMenu = () => {
    const menu = opts.menu();
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const closeChosen = () => {
    chose = true;
    closeMenu();
  };
  const choose = (then: () => void) => {
    closeChosen();
    opts.trigger().focus();
    then();
  };

  // Listeners exist only while the menu is open.
  const follow = () => place();
  const listen = (on: boolean) => {
    if (on) {
      addEventListener("resize", follow);
      addEventListener("scroll", follow, true);
    } else {
      removeEventListener("resize", follow);
      removeEventListener("scroll", follow, true);
    }
  };
  onCleanup(() => listen(false));

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem(at + 1),
      ArrowUp: () => focusItem(at - 1),
      Home: () => focusItem(0),
      End: () => focusItem(list.length - 1),
      Enter: () => (document.activeElement as HTMLElement | null)?.click(),
      " ": () => (document.activeElement as HTMLElement | null)?.click(),
      Tab: closeMenu,
    };
    const act = keys[e.key];
    if (!act) return;
    if (e.key !== "Tab") e.preventDefault();
    act();
  };

  const onToggle = (e: Event) => {
    const isOpen = (e as ToggleEvent).newState === "open";
    setOpen(isOpen);
    listen(isOpen);
    if (!isOpen && !chose && opts.menu().contains(document.activeElement)) opts.trigger().focus();
  };

  return { open, place, openMenu, closeMenu, closeChosen, choose, onKeyDown, onToggle };
}
