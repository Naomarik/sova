// How every right-click or hold menu opens (§design/context-menus), whatever place it belongs to:
// where the panel goes for a pointer, which menu a `contextmenu` gets, that a held right-click's
// menu waits for the release, and the finger's or pen's hold a place without one of its own uses.
// Pure and DOM-free at import, so the rules run under `pnpm test`; components/ContextMenu.tsx
// draws the panel and binds these to a place's element.

import { createHoldGesture, HOLD_MOVE_PX, HOLD_SUPPRESS_MS, type HoldOptions, type HoldPoint } from "./hold-select";

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
 * of the place's last press, so a long press there is still a finger's.
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
 * Whether a place's own hold owns this `contextmenu`: a hold that fired (its suppression window),
 * a drag in flight, or a finger's or pen's press still down (Android sends its long-press menu
 * around the 500ms the hold fires at, sometimes before it). A mouse press in flight doesn't: a
 * right-click is a press of its own.
 */
export const holdOwns = (p: { suppressed: boolean; dragging: boolean; phase: string; pointerKind: string }): boolean =>
  p.suppressed || p.dragging || (p.phase !== "idle" && p.pointerKind !== "mouse");

/**
 * What a place's `contextmenu` gets. `swallow`: neither menu (the echo of a hold or a drag);
 * `native`: the browser's own (Shift held, a key's menu, or a finger's or pen's long press the place
 * doesn't own); `open`: the place's menu. Only a mouse's right-click opens it: a finger or pen opens
 * it by the hold's release instead, and the keyboard keeps the browser's.
 */
export function contextMenuAction(f: { owned: boolean; kind: PointerKind; shiftKey: boolean }): "swallow" | "native" | "open" {
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
 * so the place marks the menu key's keydown and the next `contextmenu` takes the mark (once, and
 * only within KEY_MENU_MS, so a mark whose event never came can't turn a later right-click into a
 * key's). An event at (0, 0) is a key's too.
 */
export function createKeyMenuMark(now: () => number = Date.now) {
  let at: number | null = null;
  return {
    /** A keydown on the place: marked when it is a menu key. */
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

// ---- a press outside the open menu closes it --------------------------------------------------

/** The little of a `pointerdown` the outside rule reads. */
export interface OutsideDown {
  /** The menu is open now. */
  open: boolean;
  /** The press started inside the menu's panel. */
  inside: boolean;
  /** The `pointerType`: "mouse", "touch", "pen" (anything else counts as a mouse). */
  kind: string;
  /** The `button`: 0 the primary (a finger's and a pen's contact too), 1 the middle, 2 the right. */
  button: number;
}

/**
 * How a press that starts outside an open menu closes it. `down` answers "close" the moment such a
 * press starts, whatever it turns into; a primary press (a finger, a pen, a mouse's left button) also
 * arms the rule, so a plain tap or click that follows is spent on the closing: `takeClick` answers
 * true once for the click that arrives within HOLD_SUPPRESS_MS of its release, and `mouseDown` says
 * to stop a finger's or pen's compatibility mousedown (it comes only for a tap), so focus and the
 * keyboard don't move to what was under it. A mouse's own mousedown is left alone (a text-selection
 * drag still starts). A press that becomes a scroll ends in `cancel`, which disarms: the scroll goes
 * on and no click is waited for. A right or middle press closes without arming, so its own
 * `contextmenu` or auxclick still reaches what it was on. Every new press disarms the last one's.
 */
export function createOutsidePress(opts: { now?(): number } = {}) {
  const now = opts.now ?? Date.now;
  /** The kind of the armed press, or null when none is armed. */
  let armed: string | null = null;
  let releasedAt: number | null = null;
  const disarm = () => {
    armed = null;
    releasedAt = null;
  };
  return {
    /** A press started anywhere on the page. */
    down(p: OutsideDown): "close" | "none" {
      disarm();
      if (!p.open || p.inside) return "none";
      if (p.button === 0) armed = p.kind;
      return "close";
    },
    /** The press became a scroll or was taken away (`pointercancel`): nothing of it is spent. */
    cancel: disarm,
    /** The press let go. */
    up() {
      if (armed !== null) releasedAt = now();
    },
    /** A `mousedown` arrives: whether to prevent it (a finger's or pen's tap that closed the menu). */
    mouseDown: (): boolean => armed === "touch" || armed === "pen",
    /** A `click` arrives: whether it is the closing tap's, to be swallowed. Answers true once. */
    takeClick(): boolean {
      const take = armed !== null && releasedAt !== null && now() - releasedAt <= HOLD_SUPPRESS_MS;
      if (take) disarm();
      return take;
    },
  };
}

// ---- a finger's or pen's hold, for a place without one ----------------------------------------

/** The little of a PointerEvent the hold reads. */
export interface HoldPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface MenuHoldOptions extends Pick<HoldOptions, "now" | "schedule" | "unschedule" | "delayMs"> {
  /** The hold fired: the press is now a hold (a place may buzz). */
  onHold?(): void;
  /** A fired hold was let go where it fired: the menu opens there. */
  onHeld(at: HoldPoint, kind: "touch" | "pen"): void;
}

/**
 * The hold a place with none of its own opens its menu by: a finger or pen kept still for HOLD_MS
 * (hold-select's timer, so a long press is timed the same everywhere and needs no `contextmenu`,
 * which iOS Safari never sends for one), then let go within HOLD_MOVE_PX of where it fired. A mouse
 * is never a hold here (its right-click is the menu's door), and only the press that started it
 * counts. A press that moves before firing is a scroll; one that moves after firing, then lets go,
 * opens nothing. `owns()` is what the place's `contextmenu` asks (Android's long-press menu arrives
 * while the press is down), `suppressed()` what its click asks (the hold's echo).
 */
export function createMenuHold(opts: MenuHoldOptions) {
  let id: number | null = null;
  let kind: "touch" | "pen" = "touch";
  /** Where the pointer is now, and where it was when the hold fired. */
  let last: HoldPoint = { x: 0, y: 0 };
  let firedAt: HoldPoint | null = null;
  /** The fired hold moved away from where it fired: its release opens nothing. */
  let strayed = false;
  const hold = createHoldGesture({
    ...opts,
    onHold: () => {
      firedAt = last;
      opts.onHold?.();
    },
  });
  const mine = (e: HoldPointer) => id !== null && e.pointerId === id;
  const away = (at: HoldPoint) => !!firedAt && (Math.abs(at.x - firedAt.x) > HOLD_MOVE_PX || Math.abs(at.y - firedAt.y) > HOLD_MOVE_PX);
  return {
    /** A press began. Only a finger's or a pen's starts a hold. */
    down(e: HoldPointer) {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      id = e.pointerId;
      kind = e.pointerType;
      last = { x: e.clientX, y: e.clientY };
      firedAt = null;
      strayed = false;
      hold.start(last);
    },
    move(e: HoldPointer) {
      if (!mine(e)) return;
      last = { x: e.clientX, y: e.clientY };
      if (hold.held()) strayed ||= away(last);
      else hold.move(last);
    },
    /** The press let go: a fired hold that stayed put opens the menu at the release point. */
    up(e: HoldPointer) {
      if (!mine(e)) return;
      id = null;
      const at = { x: e.clientX, y: e.clientY };
      if (hold.finish() && !strayed && !away(at)) opts.onHeld(at, kind);
    },
    /** The press is off (a pointercancel, a scroll, the window's blur, an unmount): no menu. */
    cancel() {
      id = null;
      hold.cancel();
    },
    /** A press of the hold's is down, or a fired one was just let go: its `contextmenu` is the hold's. */
    owns: () => id !== null || hold.suppressed(),
    /** The click arriving now is a fired hold's echo. */
    suppressed: () => hold.suppressed(),
    /** A press of the hold's is down. */
    pressing: () => id !== null,
  };
}
