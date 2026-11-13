import { createEffect, createSignal, onCleanup, type JSX, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { EDGE_GAP, type MenuAnchor, menuRoom, menuSpot } from "../lib/menu-position";
import { Icon, type IconName } from "./ui";

/**
 * One menu row, keyboard-complete: a `role="menuitem"` is not a button, so Enter and Space have to
 * be wired by hand or the row answers only to a pointer. `disabled` is the REASON it can't run,
 * said before the press (a disabled row with no words is a dead end).
 */
export interface ActionMenuItemProps {
  label: string;
  /** The row's accessible name: every row says which thing it acts on. */
  aria: string;
  title?: string;
  icon?: JSX.Element;
  /** Why the row can't run, or absent/"" when it can. Shown as the row's note and its title. */
  disabled?: string;
  /** One line under the label saying what the row does (a disabled row says why instead). */
  description?: string;
  /** A row that goes somewhere is a link, so it can be middle-clicked and copied like any other.
      The browser does the navigating; `onRun` is not called. */
  href?: string;
  onRun?(): void;
  /** The row moves focus itself, so the menu doesn't take it back to the trigger. */
  keepFocus?: boolean;
  /** The row replaces the menu's body with a screen instead of acting and closing. */
  stayOpen?: boolean;
  /** A choice row (§design/menu-rows): `menuitemradio` with its check first, tinted and checked
      while true. Absent: a plain `menuitem`. */
  checked?: boolean;
  /** A trailing value in words (`.popover-item-end`), never the row's only label. */
  end?: string;
  /** A trailing mark drawn in `.popover-item-end` instead of `end` (a count pill, say): its words
      belong in `aria`, so it is `aria-hidden` by its maker. */
  endBadge?: JSX.Element;
}

/** What a menu's body is handed: the rows it draws with, and the menu's own state. */
export interface ActionMenuApi {
  /** Close the menu, leaving focus where it is. */
  close(): void;
  /** Close the menu and run `act`; focus returns to the trigger unless the act moves it itself. */
  run(act: () => void, keepFocus?: boolean): void;
  /** The screen the body is showing, `null` for the rows. */
  screen(): string | null;
  /** Swap the body for a screen (a name field, a confirm question), or `null` for the rows again. */
  show(name: string | null): void;
  /** Leave the screen AND the menu, with focus back on the trigger — what Escape does. */
  dismiss(): void;
  /** Put focus back on the trigger without closing: a screen that returns to the rows. */
  focusTrigger(): void;
  Item(props: ActionMenuItemProps): JSX.Element;
}

/** What a panel's owner holds: open it where its anchor is, close it, ask whether it is open. */
export interface MenuPanelControls {
  /** `whileHeld`: a touch/pen hold opened this under a finger; its release must not light-dismiss it. */
  open(whileHeld?: boolean): void;
  /** Whether a touch/pen hold opened this panel; its host supplies outside-press and Escape dismissal. */
  isHeldOpen(): boolean;
  /** The host's pointerdown: a hold-opened panel closes outside itself. */
  dismissOutside(target: EventTarget | null): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * The menu itself, without a trigger: the popover panel, its rows' API, its placement and its focus.
 * ActionMenu below hangs it from a "⋯" trigger; the page's one pointer menu (ContextMenu.tsx) hangs
 * it from a pointer position that follows its place. The panel lives in the top layer (no ancestor
 * can clip it). Ordinarily it light-dismisses and answers Escape for free; a touch/pen hold's panel
 * is manual so the release can't dismiss it, and its host supplies those two endings.
 */
export function MenuPanel(props: {
  /** Where the panel hangs from, read each time it is placed. */
  anchor(): MenuAnchor;
  /** Where focus goes back to: the trigger, or the thing a right-click menu is about. */
  origin(): HTMLElement | undefined;
  /** Rendered through a `<Portal>`, out of a `<summary>`'s subtree (ActionMenu's `contain`). */
  contain?: boolean;
  onToggle?(open: boolean): void;
  menuName?: string;
  panelClass?: string;
  returnFocus?: boolean;
  span?: () => HTMLElement | undefined;
  /** Hands the owner its controls, once. */
  controls(c: MenuPanelControls): void;
  children: (api: ActionMenuApi) => JSX.Element;
}) {
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [screen, setScreen] = createSignal<string | null>(null);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const focusOrigin = () => props.origin()?.focus();
  /**
   * Put the open panel inside the window, measured rather than guessed.
   *
   * A guess is what was wrong before: the panel was right-aligned to the trigger at the model
   * picker's 360px, so against a 350px sidebar its LEFT edge — icons and labels — sat outside
   * the window with no way to scroll to it. Nothing about the panel's own box was ever read.
   *
   * So: give it the room it has (`--menu-max`), measure what it then renders as, and clamp that
   * box on both axes (lib/menu-position). It sits at its anchor WHEN THAT FITS, and otherwise
   * moves — not the other way round. Re-runs whenever the box can change: a screen swap
   * (rename/delete are a different height), a resize, a scroll under the panel.
   */
  const place = () => {
    if (!menu.isConnected || !menu.matches(":popover-open")) return;
    const anchor = props.anchor();
    const view = { width: innerWidth, height: innerHeight };
    const spanBox = spanning();
    if (spanBox) menu.style.setProperty("--menu-width", `${Math.round(Math.max(spanBox.width - 2 * EDGE_GAP, 0))}px`);
    // Measure AFTER handing it the larger side's room, so the height read back is the height
    // it will paint at — a panel measured unclamped reports one that never happens.
    menu.style.setProperty("--menu-max", `${menuRoom(anchor, view)}px`);
    const box = menu.getBoundingClientRect();
    const spot = menuSpot(anchor, box, view, spanBox?.left);
    menu.style.setProperty("--menu-top", `${spot.top}px`);
    menu.style.setProperty("--menu-left", `${spot.left}px`);
  };
  /** The pane's box while the panel spans it: only below 768px, where it would otherwise be a sheet. */
  const spanning = (): DOMRect | null => {
    const el = props.span?.();
    return el && matchMedia("(max-width: 767px)").matches ? el.getBoundingClientRect() : null;
  };

  const openMenu = (whileHeld = false) => {
    // A popover opened under a finger would otherwise be light-dismissed by that finger's release.
    // A hold-open panel stays manual for its lifetime; ContextMenuHost supplies outside-press/Escape.
    // Every other menu is auto throughout.
    menu.popover = whileHeld ? "manual" : "auto";
    // A menu that moves to another thing while open starts on its rows, not the last one's screen.
    setScreen(null);
    menu.showPopover();
    place();
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role^=menuitem]")?.focus());
  };
  const isHeldOpen = () => menu.popover === "manual" && menu.matches(":popover-open");
  const dismissOutside = (target: EventTarget | null) => {
    if (isHeldOpen() && !(target instanceof Node && menu.contains(target))) close();
  };
  props.controls({ open: openMenu, isHeldOpen, dismissOutside, close, isOpen: open });
  // A screen is a different height from the rows; the panel is re-placed once it has rendered.
  createEffect(() => {
    screen();
    if (open()) queueMicrotask(place);
  });
  // Capture, so a scroll of the sidebar (or any pane) under an open menu moves it with its trigger.
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  onCleanup(() => {
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
  });
  /** Every row closes the menu; the ones that move focus themselves don't take it back. */
  const run = (act: () => void, keepFocus = false) => {
    close();
    if (!keepFocus) focusOrigin();
    act();
  };
  const dismiss = () => {
    setScreen(null);
    close();
    focusOrigin();
  };

  const Item = (p: ActionMenuItemProps) => {
    const act = () => {
      const onRun = p.onRun;
      if (p.disabled || !onRun) return;
      if (p.stayOpen) onRun();
      else run(onRun, p.keepFocus);
    };
    const body = (
      <>
        <Show when={p.checked !== undefined}>
          <Icon name="check" small class="popover-item-check" />
        </Show>
        {p.icon}
        <span class="popover-item-text">
          <span class="popover-item-label">{p.label}</span>
          <Show when={p.disabled || p.description}>
            <span class="popover-item-desc">{p.disabled || p.description}</span>
          </Show>
        </span>
        <Show when={p.endBadge} fallback={<Show when={p.end}><span class="popover-item-end">{p.end}</span></Show>}>
          <span class="popover-item-end">{p.endBadge}</span>
        </Show>
      </>
    );
    const shared = {
      // A second line (the reason it can't run, or what it does) makes it a detail row.
      get class() { return p.disabled || p.description ? "popover-item popover-item-detail" : "popover-item"; },
      get role() { return p.checked === undefined ? "menuitem" : "menuitemradio"; },
      get "aria-checked"() { return p.checked === undefined ? undefined : p.checked ? "true" : "false"; },
      tabindex: 0,
      // Keep these reactive: groups initially render before their sessions load.
      get "aria-label"() { return p.aria; },
      get "aria-disabled"() { return p.disabled ? "true" : undefined; },
      get title() { return p.disabled || p.title || undefined; },
    } as const;
    return (
      <Show
        when={p.href !== undefined}
        fallback={
          <div
            {...shared}
            onClick={act}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              act();
            }}
          >
            {body}
          </div>
        }
      >
        {/* A link row: the browser navigates, we only get out of the way. A disabled one keeps its
            row and loses its href, so the reason is read rather than discovered by pressing. */}
        <a
          {...shared}
          href={p.disabled ? undefined : p.href}
          onClick={(e) => (p.disabled ? e.preventDefault() : close())}
          onKeyDown={(e) => {
            // Enter already activates a link; Space is ours to wire, as on every other row.
            if (e.key !== " ") return;
            e.preventDefault();
            if (!p.disabled) e.currentTarget.click();
          }}
        >
          {body}
        </a>
      </Show>
    );
  };

  const api: ActionMenuApi = { close, run, screen, show: (name) => setScreen(name), dismiss, focusTrigger: focusOrigin, Item };

  const panel = (
    <div
      ref={menu}
      class={`model-menu action-menu${props.span ? " action-menu-span" : ""}${props.panelClass ? ` ${props.panelClass}` : ""}`}
      popover="auto"
      role={props.menuName ? "menu" : undefined}
      aria-label={props.menuName}
      onToggle={(e) => {
        setOpen((e as ToggleEvent).newState === "open");
        if ((e as ToggleEvent).newState !== "open") {
          setScreen(null);
          // Escape, or a click on nothing focusable: focus would be lost with the panel, so it goes
          // back to the trigger. A click that focused something else keeps it there.
          const at = document.activeElement;
          if (props.returnFocus && (!at || at === document.body || menu.contains(at))) focusOrigin();
        }
        props.onToggle?.(open());
      }}
    >
      {props.children(api)}
    </div>
  );

  return (
    <Show when={props.contain} fallback={panel}>
      <Portal>{panel}</Portal>
    </Show>
  );
}

/**
 * A "⋯" trigger and the popover menu it opens, shared by the model picker, split buttons and other
 * visible menu triggers. The panel (MenuPanel above) anchors under the trigger's right edge
 * when that fits in the window, and moves when it doesn't.
 *
 * The body is a render prop rather than children, because every row needs the menu's own `run`
 * (close, then act) and a menu with a second screen needs `show`/`dismiss`.
 */
export function ActionMenu(props: {
  /** The trigger's accessible name, and the menu's. */
  label: string;
  /** The trigger's tooltip: the kind of thing it opens. */
  title?: string;
  /** The trigger's icon. `null` skips it: a word-plus-caret trigger for a narrow row. */
  icon?: IconName | null;
  /** The word trigger's dropdown caret. `false` skips it: the narrowest rows keep only the word. */
  caret?: boolean;
  /** Extra classes on the trigger, for a head that reveals it on hover. */
  class?: string;
  /** A toolbar trigger says what it opens in words: the icon-only "⋯" is the default, and this
      turns it into a labelled button with a chevron, like every other menu trigger with room. */
  text?: string;
  /** Which trigger edge the panel lines up with. "end" (default) suits a trailing "⋯"; "start"
      suits a leading trigger, whose panel would otherwise hang off to the left and be clamped. */
  align?: "start" | "end";
  /**
   * The trigger lives inside a `<summary>`. Two things follow, and both are load-bearing:
   *
   * - The panel is rendered through a `<Portal>`, OUT of the summary's subtree. A popover paints
   *   in the top layer but stays where it is in the DOM, and a `<details>` toggles for a click on
   *   anything inside its summary that has no activation behaviour of its own — which is exactly
   *   what a `role="menuitem"` div is. Measured: clicking `Rename…` collapsed the group under the
   *   menu. `stopPropagation` does NOT fix it (Solid delegates click at the document, and
   *   activation behaviour survives a stopped propagation anyway); `preventDefault` would fix it
   *   and break the link row. Moving the panel out is the fix that can't be half-applied.
   * - Click and keydown on the trigger itself stop there, so a press can't read as a press on the
   *   summary.
   */
  contain?: boolean;
  /** Called as the panel opens and closes: a trigger that would otherwise unmount can stay while open. */
  onToggle?(open: boolean): void;
  /** The panel is a `role="menu"` named this (a menu of rows only, no screens). */
  menuName?: string;
  /** More classes on the panel. */
  panelClass?: string;
  /** Escape or a click outside puts focus back on the trigger, unless the click focused something else. */
  returnFocus?: boolean;
  /** Below 768px the panel drops as a dropdown under the trigger, as wide as this element (the pane),
      not as the bottom sheet every other menu becomes there. */
  span?: () => HTMLElement | undefined;
  /** `false`: an icon trigger with its border (a split button's ▾), not the ghost "⋯". */
  ghost?: boolean;
  /** Drawn inside the trigger after its icon: a dot, say. Its words belong in `label`. */
  badge?: JSX.Element;
  children: (api: ActionMenuApi) => JSX.Element;
}) {
  let trigger!: HTMLButtonElement;
  let panel!: MenuPanelControls;
  const [open, setOpen] = createSignal(false);
  /** The trigger's own events, kept off the summary. The panel's are handled by moving it out. */
  const stop = (e: Event) => props.contain && e.stopPropagation();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={`button${props.text ? "" : props.ghost === false ? " button-icon" : " button-icon button-ghost"}${props.class ? ` ${props.class}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={props.label}
        title={props.title}
        onClick={(e) => {
          stop(e);
          open() ? panel.close() : panel.open();
        }}
        onKeyDown={stop}
      >
        {props.icon === null ? null : <Icon name={props.icon ?? "more"} />}
        {props.badge}
        <Show when={props.text}>
          {(text) => (
            <span class="action-menu-text">
              {text()}
              {props.caret !== false && <Icon name="chevron-down" small />}
            </span>
          )}
        </Show>
      </button>
      <MenuPanel
        anchor={() => ({ kind: "rect", rect: trigger.getBoundingClientRect(), align: props.align ?? "end" })}
        origin={() => trigger}
        contain={props.contain}
        onToggle={(o) => {
          setOpen(o);
          props.onToggle?.(o);
        }}
        menuName={props.menuName}
        panelClass={props.panelClass}
        returnFocus={props.returnFocus}
        span={props.span}
        controls={(c) => (panel = c)}
      >
        {(api) => props.children(api)}
      </MenuPanel>
    </>
  );
}
