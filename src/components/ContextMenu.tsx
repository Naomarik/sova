/**
 * Every right-click or hold menu's shared piece (§design/context-menus): how it opens, sits and
 * closes, whatever place it belongs to. A place makes one menu (`createContextMenu`), mounts its
 * `Panel` with the items as the body, and gives each element that answers to it a door
 * (`menu.door`). The rules are lib/context-menu.
 *
 * Right-click and hold come only as a pair. A door is attached whole (`attach`), and its options
 * must say whose hold it is: `"shared"`, the hold this piece binds itself (a finger's or pen's
 * press kept still, timed, since iOS Safari sends no `contextmenu` for a long press), or the
 * place's own hold, whose release the place reports with `held` (lib/context-menu-rule.test.ts
 * holds that it does). There is no other way to open a menu: no `open` is exported.
 *
 * The body sees the same thing whatever opened it: the ask carries no pointer kind, so a menu can't
 * offer a finger different items from a mouse. It is drawn from ActionMenu's own pieces, the ⋯
 * menus' api shape and row markup, so a ⋯ menu's body can later be handed to a right-click as it is.
 *
 * The panel is ActionMenu's shell (`popover="auto"`, `.model-menu.action-menu`, so a bottom sheet
 * below 768px), placed at a point instead of under a trigger. `popover="auto"` keeps one menu open
 * at a time (a ⋯ menu's included), and one open-on-release waiter serves every menu.
 */
import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  contextMenuAction,
  contextPointerKind,
  createKeyMenuMark,
  createMenuHold,
  createOpenOnRelease,
  pointMenuRoom,
  pointMenuSpot,
  pressHeld,
} from "../lib/context-menu";
import type { ActionMenuApi, ActionMenuItemProps } from "./ActionMenu";
import { Icon } from "./ui";

/** A row of a right-click menu: the ⋯ menu's row props, as far as a place uses them so far. A row
    that goes somewhere (`href`), a trailing value (`end`, `endBadge`) and `keepFocus` come with the
    first place that needs them, under these names. */
export type ContextMenuItemProps = Pick<ActionMenuItemProps, "label" | "aria" | "icon" | "disabled" | "description" | "checked" | "stayOpen" | "onRun">;

/** What a menu's body is handed: ActionMenu's api, its rows limited as above. */
export type ContextMenuApi = Omit<ActionMenuApi, "Item"> & { Item(props: ContextMenuItemProps): JSX.Element };

/** One ask: which thing the menu is for, the point it opens at, and where focus goes back on close. */
interface Ask<K> {
  key: K;
  at: { x: number; y: number };
  returnTo: HTMLElement | null;
}

/** The place's own hold: whether it owns a `contextmenu` arriving now (its press is down, or its
    echo), and the kind of its last press (for a browser that doesn't say what made the event). */
export interface OwnHold {
  owned(): boolean;
  lastPointer(): string | null;
}

interface DoorOptions<K> {
  /** The thing the menu would be for, read when it opens. */
  key(): K;
  /** Where focus goes back when the menu closes. */
  returnTo(): HTMLElement | null;
}

/** Wires the door to the place's element: right-click (and the menu keys, which keep the browser's
    menu) and, for a shared hold, the hold. Removed when the place's owner is disposed. */
type Attach = (el: HTMLElement) => void;

/** One menu-waiting-for-its-release for the whole page: a newer ask, from any menu, replaces it. */
let opener: ReturnType<typeof createOpenOnRelease> | null = null;
const openOnRelease = (held: boolean, run: () => void) => {
  opener ??= createOpenOnRelease({
    win: window,
    doc: document,
    later: (fn) => {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    },
  });
  opener.request(held, run);
};

export function createContextMenu<K>() {
  let showHandler: ((ask: Ask<K>) => void) | null = null;
  const open = (ask: Ask<K>, held: boolean) => openOnRelease(held, () => showHandler?.(ask));

  /** The contextmenu half of every door: Shift and a key's menu keep the browser's, a hold's echo
      gets neither, a mouse's right-click opens at the pointer once its button is up. */
  const rightClick = (opts: DoorOptions<K>, owned: () => boolean, lastPointer: () => string | null) => {
    const keyMark = createKeyMenuMark();
    const onKeyDown = (e: KeyboardEvent) => keyMark.keydown(e);
    const onContextMenu = (e: MouseEvent) => {
      const kind = keyMark.take(e) ? "keyboard" : contextPointerKind(e as MouseEvent & { pointerType?: unknown }, lastPointer());
      const act = contextMenuAction({ owned: owned(), kind, shiftKey: e.shiftKey });
      if (act === "native") return;
      e.preventDefault();
      if (act !== "open") return;
      open({ key: opts.key(), at: { x: e.clientX, y: e.clientY }, returnTo: opts.returnTo() }, pressHeld(kind, e.buttons));
    };
    return (el: HTMLElement) => {
      el.addEventListener("keydown", onKeyDown);
      el.addEventListener("contextmenu", onContextMenu);
      onCleanup(() => {
        el.removeEventListener("keydown", onKeyDown);
        el.removeEventListener("contextmenu", onContextMenu);
      });
    };
  };

  /** A finger's or pen's hold let go in place: the menu opens there, on a later task (past the release's own events). */
  const heldAt = (opts: DoorOptions<K>) => (at: { x: number; y: number }, pointerType: string) => {
    if (pointerType !== "touch" && pointerType !== "pen") return;
    const ask = { key: opts.key(), at, returnTo: opts.returnTo() };
    setTimeout(() => open(ask, false), 0);
  };

  /** The shared hold, bound to the element: its press is watched on the window until it ends. */
  const sharedHold = (opts: DoorOptions<K>) => {
    const held = heldAt(opts);
    let lastPointer: string | null = null;
    const hold = createMenuHold({ onHold: () => navigator.vibrate?.(10), onHeld: (at, kind) => held(at, kind) });
    const onMove = (e: PointerEvent) => hold.move(e);
    const onUp = (e: PointerEvent) => {
      hold.up(e);
      if (!hold.pressing()) watch(false);
    };
    const onCancel = () => {
      hold.cancel();
      watch(false);
    };
    const watch = (on: boolean) => {
      const f = on ? addEventListener : removeEventListener;
      f("pointermove", onMove as EventListener, true);
      f("pointerup", onUp as EventListener, true);
      f("pointercancel", onCancel, true);
      // A scroll under the finger means the press was a scroll; a blur, that its release may never come.
      f("scroll", onCancel, true);
      f("blur", onCancel);
    };
    const onDown = (e: PointerEvent) => {
      lastPointer = e.pointerType;
      hold.down(e);
      if (hold.pressing()) watch(true);
    };
    /** The click a fired hold leaves behind is its echo, not a choice. */
    const onClick = (e: MouseEvent) => {
      if (!hold.suppressed()) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const attachRightClick = rightClick(opts, hold.owns, () => lastPointer);
    return (el: HTMLElement) => {
      attachRightClick(el);
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("click", onClick, true);
      onCleanup(() => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("click", onClick, true);
        onCancel();
      });
    };
  };

  /**
   * One element's door to the menu. Its hold is required: `"shared"` binds this piece's own, an
   * `OwnHold` is a place's existing press, which reports its release in place with `held`.
   */
  function door(opts: DoorOptions<K> & { hold: "shared" }): { attach: Attach };
  function door(opts: DoorOptions<K> & { hold: OwnHold }): { attach: Attach; held(at: { x: number; y: number }, pointerType: string): void };
  function door(opts: DoorOptions<K> & { hold: "shared" | OwnHold }) {
    const hold = opts.hold;
    if (hold === "shared") return { attach: sharedHold(opts) };
    return { attach: rightClick(opts, hold.owned, hold.lastPointer), held: heldAt(opts) };
  }

  /**
   * The menu's panel. Mount one beside the place, so the body lives in the place's tree. `live`
   * says whether a key still has its thing: one that goes away closes the menu. The body is handed
   * the open key (null while closed) and the api; it draws its rows with `api.Item`.
   */
  function Panel(props: { live(key: K): boolean; children(key: () => K | null, api: ContextMenuApi): JSX.Element }) {
    let menu!: HTMLDivElement;
    const [ask, setAsk] = createSignal<Ask<K> | null>(null);
    const [screen, setScreen] = createSignal<string | null>(null);
    const isOpen = () => menu?.matches(":popover-open") ?? false;
    const close = () => isOpen() && menu.hidePopover();
    /** The corner at the pointer, measured and kept inside the window. Below 768px the sheet rules
        own the position and these properties are not read. */
    const place = () => {
      const a = ask();
      if (!a || !isOpen()) return;
      const view = { width: innerWidth, height: innerHeight };
      menu.style.setProperty("--menu-max", `${pointMenuRoom(a.at, view)}px`);
      const spot = pointMenuSpot(a.at, menu.getBoundingClientRect(), view);
      menu.style.setProperty("--menu-top", `${spot.top}px`);
      menu.style.setProperty("--menu-left", `${spot.left}px`);
    };
    const focusFirst = () => menu.querySelector<HTMLElement>("[role^=menuitem], input")?.focus();
    const focusBack = () => {
      const back = ask()?.returnTo;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    const show = (a: Ask<K>) => {
      if (!props.live(a.key)) return;
      setScreen(null);
      setAsk(() => a);
      if (!isOpen()) menu.showPopover();
      place();
      queueMicrotask(focusFirst);
    };
    onMount(() => (showHandler = show));
    onCleanup(() => {
      if (showHandler === show) showHandler = null;
    });
    // A thing that goes away takes its menu with it.
    createEffect(() => {
      const a = ask();
      if (a && !props.live(a.key)) close();
    });
    // A screen is a different height from the rows: placed again once it has rendered, focus on its first control.
    createEffect(
      on(screen, () => {
        if (!isOpen()) return;
        queueMicrotask(() => {
          place();
          focusFirst();
        });
      }),
    );
    addEventListener("resize", place);
    onCleanup(() => removeEventListener("resize", place));

    /** Close, then act: focus goes back to where the menu was opened from unless the act moves it itself. */
    const run = (act: () => void) => {
      close();
      act();
    };
    const dismiss = () => {
      setScreen(null);
      close();
      focusBack();
    };
    const api: ContextMenuApi = { close, run, screen, show: setScreen, dismiss, focusTrigger: focusBack, Item: (p) => <Item {...p} run={run} /> };

    return (
      <Portal>
        <div
          ref={menu}
          class="model-menu action-menu"
          popover="auto"
          onToggle={() => {
            // Coalesced: a close followed at once by a reopen (another right-click) arrives as one open.
            if (isOpen()) return;
            const back = ask()?.returnTo;
            setAsk(null);
            setScreen(null);
            // Escape, or a click on nothing focusable: focus would be lost with the panel, so it goes back.
            const at = document.activeElement;
            if (back?.isConnected && (!at || at === document.body || menu.contains(at))) back.focus({ preventScroll: true });
          }}
        >
          {props.children(() => ask()?.key ?? null, api)}
        </div>
      </Portal>
    );
  }

  return { door, Panel };
}

/**
 * One menu row, as ActionMenu draws its rows: Enter and Space wired by hand (a `menuitem` is not a
 * button), and a disabled row says why under its label rather than going silently grey. A row
 * closes the menu and acts, unless it `stayOpen`s (it swaps the body for a screen).
 */
function Item(p: ContextMenuItemProps & { run(act: () => void): void }) {
  const act = () => {
    const onRun = p.onRun;
    if (p.disabled || !onRun) return;
    if (p.stayOpen) onRun();
    else p.run(onRun);
  };
  const detail = () => !!(p.disabled || p.description);
  return (
    <div
      class={detail() ? "popover-item popover-item-detail" : "popover-item"}
      role={p.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={p.checked === undefined ? undefined : p.checked ? "true" : "false"}
      tabindex={0}
      aria-label={p.aria}
      aria-disabled={p.disabled ? "true" : undefined}
      title={p.disabled || undefined}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        act();
      }}
    >
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
    </div>
  ) as JSX.Element;
}
