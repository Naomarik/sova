import { createEffect, createSignal, onCleanup, type JSX, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon, type IconName } from "./ui";

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;
/** A panel squeezed below this scrolls and overlaps the trigger rather than becoming a sliver. */
const MIN_PANEL_HEIGHT = 140;

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
  /** A row that goes somewhere is a link, so it can be middle-clicked and copied like any other.
      The browser does the navigating; `onRun` is not called. */
  href?: string;
  onRun?(): void;
  /** The row moves focus itself, so the menu doesn't take it back to the trigger. */
  keepFocus?: boolean;
  /** The row replaces the menu's body with a screen instead of acting and closing. */
  stayOpen?: boolean;
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

/**
 * A "⋯" trigger and the popover menu it opens: the shape §14's pane head and §2's group sections
 * both need, in one place. The panel is a `popover="auto"`, so it lives in the top layer (no
 * ancestor can clip it), light-dismisses, and answers Escape for free; `place()` below anchors
 * it under the trigger's right edge when that fits in the window, and moves it when it doesn't.
 *
 * The body is a render prop rather than children, because every row needs the menu's own `run`
 * (close, then act) and a menu with a second screen needs `show`/`dismiss`.
 */
export function ActionMenu(props: {
  /** The trigger's accessible name, and the menu's: "Group actions · Work". */
  label: string;
  /** The trigger's tooltip: the kind of thing, without the name ("Group actions"). */
  title?: string;
  icon?: IconName;
  /** Extra classes on the trigger, for a head that reveals it on hover. */
  class?: string;
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
  children: (api: ActionMenuApi) => JSX.Element;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [screen, setScreen] = createSignal<string | null>(null);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  /**
   * Put the open panel inside the window, measured rather than guessed.
   *
   * A guess is what was wrong before: the panel was right-aligned to the trigger at the model
   * picker's 360px, so against a 350px sidebar its LEFT edge — icons and labels — sat outside
   * the window with no way to scroll to it. Nothing about the panel's own box was ever read.
   *
   * So: give it the room it has (`--menu-max`), measure what it then renders as, and clamp that
   * box on both axes. It is right-aligned to the trigger and below it WHEN THAT FITS, and
   * otherwise moves — not the other way round. Re-runs whenever the box can change: a screen
   * swap (rename/delete are a different height), a resize, a scroll under the panel.
   */
  const place = () => {
    if (!menu.isConnected || !menu.matches(":popover-open")) return;
    const r = trigger.getBoundingClientRect();
    const below = innerHeight - EDGE_GAP - (r.bottom + TRIGGER_GAP);
    const above = r.top - TRIGGER_GAP - EDGE_GAP;
    // Measure AFTER handing it the larger side's room, so the height read back is the height
    // it will paint at — a panel measured unclamped reports one that never happens.
    menu.style.setProperty("--menu-max", `${Math.round(Math.max(below, above, MIN_PANEL_HEIGHT))}px`);
    const box = menu.getBoundingClientRect();
    const fitsBelow = box.height <= below;
    const top = fitsBelow ? r.bottom + TRIGGER_GAP : r.top - TRIGGER_GAP - box.height;
    // The clamps are what make this true in the cases the preference can't cover: a trigger
    // near an edge, a window shorter than the panel, a panel wider than the viewport.
    const maxTop = Math.max(EDGE_GAP, innerHeight - EDGE_GAP - box.height);
    const maxLeft = Math.max(EDGE_GAP, innerWidth - EDGE_GAP - box.width);
    menu.style.setProperty("--menu-top", `${Math.round(Math.min(Math.max(top, EDGE_GAP), maxTop))}px`);
    menu.style.setProperty("--menu-left", `${Math.round(Math.min(Math.max(r.right - box.width, EDGE_GAP), maxLeft))}px`);
  };

  const openMenu = () => {
    menu.showPopover();
    place();
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  };
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
    if (!keepFocus) trigger.focus();
    act();
  };
  const dismiss = () => {
    setScreen(null);
    close();
    trigger.focus();
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
        {p.icon}
        <span class="mode-option-text">
          <span class="mode-option-id">{p.label}</span>
          <Show when={p.disabled}>
            <span class="mode-option-note">{p.disabled}</span>
          </Show>
        </span>
      </>
    );
    const shared = {
      class: "mode-option group-option",
      role: "menuitem",
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

  const api: ActionMenuApi = { close, run, screen, show: (name) => setScreen(name), dismiss, focusTrigger: () => trigger.focus(), Item };
  /** The trigger's own events, kept off the summary. The panel's are handled by moving it out. */
  const stop = (e: Event) => props.contain && e.stopPropagation();

  const panel = (
    <div
      ref={menu}
      class="model-menu action-menu"
      popover="auto"
      onToggle={(e) => {
        setOpen((e as ToggleEvent).newState === "open");
        if ((e as ToggleEvent).newState !== "open") setScreen(null);
      }}
    >
      {props.children(api)}
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={`button button-icon button-ghost${props.class ? ` ${props.class}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={props.label}
        title={props.title}
        onClick={(e) => {
          stop(e);
          open() ? close() : openMenu();
        }}
        onKeyDown={stop}
      >
        <Icon name={props.icon ?? "more"} />
      </button>
      <Show when={props.contain} fallback={panel}>
        <Portal>{panel}</Portal>
      </Show>
    </>
  );
}
