// Right-click menus (§app/context-menus): what a `contextmenu` event does — Sova's menu for the
// innermost thing that has one, the browser's own menu (including every keyboard-made event), or
// nothing (the echo of a gesture that already meant something). Framework-free and DOM-free at
// import, so the rules run under `pnpm test` with stand-in elements; components/ContextMenu.tsx
// reads the facts off a real event and acts on the answer.

import { createHoldGesture, HOLD_MOVE_PX, HOLD_MS, type HoldPoint } from "./hold-select";
import { isTextEntry } from "./text-entry";

/** What made the event: a mouse (or trackpad), a finger, a pen, or the browser's context-menu key. */
export type PointerKind = "mouse" | "touch" | "pen" | "keyboard";

/** Firefox's `mozInputSource` codes (MouseEvent.MOZ_SOURCE_*). */
const MOZ_SOURCE: Record<number, PointerKind> = { 1: "mouse", 2: "pen", 5: "touch", 6: "keyboard" };

/**
 * The input a `contextmenu` came from. Chromium sends it as a PointerEvent with a `pointerType`;
 * an empty one reads as a key. Linux Chromium can report a keyboard-made event as "mouse", so
 * ContextMenu.tsx also keeps that native event away from Sova's places. Firefox says the source
 * in `mozInputSource`. A browser that says neither (a plain MouseEvent) gets the kind of the last
 * pointer that went down, so a long press there is still a finger's.
 */
export function contextPointerKind(e: { pointerType?: unknown; mozInputSource?: unknown }, lastPointer: string | null): PointerKind {
  if (typeof e.pointerType === "string") {
    if (e.pointerType === "") return "keyboard";
    if (e.pointerType === "mouse" || e.pointerType === "touch" || e.pointerType === "pen") return e.pointerType;
  }
  if (typeof e.mozInputSource === "number" && MOZ_SOURCE[e.mozInputSource]) return MOZ_SOURCE[e.mozInputSource]!;
  return lastPointer === "touch" || lastPointer === "pen" ? lastPointer : "mouse";
}

/** What a place's `contextmenu` handler learns from the event, as plain facts. */
export interface ContextFacts {
  kind: PointerKind;
  shiftKey: boolean;
  /** A place inside this one already took the event (`defaultPrevented`): innermost wins. */
  taken: boolean;
  /** The place's own mouse gesture claims the event: a lift or drag. A touch/pen hold is captured by its controller. */
  holds: boolean;
  /** This is the shared controller's completed 500ms touch/pen hold, not a browser `contextmenu`. */
  held?: boolean;
  /** Inside an input, a text area, editable text or a select. */
  textEntry: boolean;
  /** Inside an open menu or popover, Sova's own right-click menu included. */
  inPopover: boolean;
  /** The pointer is on the text that is selected right now. */
  onSelection: boolean;
  /** On a link inside the place that isn't the place's own row link. */
  contentLink: boolean;
}

/**
 * - `open`: Sova's menu for this place (the handler prevents the browser's).
 * - `native`: the browser's own menu; the handler does nothing at all.
 * - `swallow`: neither menu: the event is the echo of a gesture that already acted (a hold, a drag).
 * - `taken`: an inner place already answered; this one does nothing.
 */
export type ContextAction = "open" | "native" | "swallow" | "taken";

/** The rule, in order (§app.context-menus/native, /touch). Pure. */
export function contextAction(f: ContextFacts): ContextAction {
  if (f.taken) return "taken";
  if (f.holds) return "swallow";
  // Sova has no keyboard gesture: the browser's own keyboard context menu is always its own.
  if (f.kind === "keyboard") return "native";
  // A touch/pen `contextmenu` alone is the browser's. The shared hold calls back with `held` at 500ms.
  if ((f.kind === "touch" || f.kind === "pen") && !f.held) return "native";
  if (f.shiftKey) return "native";
  if (f.textEntry || f.inPopover || f.contentLink) return "native";
  if (f.onSelection) return "native";
  return "open";
}

/**
 * Whether a pointerdown may start a row's press-and-hold. Only the main mouse button does, and not
 * with Ctrl held: on a Mac that is a right-click, elsewhere a click that opens a new tab — never a
 * hold or a drag. Touch and pen always may.
 */
export const startsPress = (e: { pointerType: string; button: number; ctrlKey: boolean }): boolean => !(e.pointerType === "mouse" && (e.button !== 0 || e.ctrlKey));

// ---- reading the facts, on anything shaped like an element ------------------------------------

/** The little of an Element the rules read; the tests pass stand-ins. */
export interface ElementLike {
  tagName?: string | null;
  type?: string | null;
  isContentEditable?: boolean;
  closest(selector: string): ElementLike | null;
}

/** Inside a field the user types in, or a select: the browser's menu (spelling, paste) is the useful one. */
export function inTextEntry(target: ElementLike | null): boolean {
  const field = target?.closest("input, textarea, select, [contenteditable]") ?? null;
  if (!field) return false;
  if ((field.tagName ?? "").toUpperCase() === "SELECT") return true;
  return isTextEntry(field);
}

/** Inside a popover (an open menu: one that isn't open can't be under the pointer). */
export const inPopover = (target: ElementLike | null): boolean => !!target?.closest("[popover]");

/**
 * On a link inside the place that isn't its own row link: a Markdown link in a message, a team chip
 * on a board row. The row's own link (a sidebar row, a board title) is the row: Sova's menu.
 */
export function onContentLink(target: ElementLike | null, inPlace: (link: ElementLike) => boolean, ownLink: unknown): boolean {
  const a = target?.closest("a[href]") ?? null;
  if (!a || a === ownLink) return false;
  return inPlace(a);
}

/** Whether the point is inside one of the selection's boxes (`Range.getClientRects()`). Pure. */
export function pointInRects(x: number, y: number, rects: Iterable<{ left: number; right: number; top: number; bottom: number }>): boolean {
  for (const r of rects) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  return false;
}

/**
 * What a pointer press's "on the selection" reads (§app.context-menus/native): the text selected when
 * its press went down. A Mac's browser selects the word (or the link) under a right press before
 * it sends `contextmenu`; that word was never the user's selection, so it doesn't hand the click to
 * the browser, and Sova's menu takes it back (`madeByPress`). Before any press: what is selected now.
 */
export function createPressSelection<R>(read: () => R[]) {
  let atPress: R[] | null = null;
  return {
    /** A pointer went down: remember what was selected before the browser handles the press. */
    pressed() {
      atPress = read();
    },
    /** The selection this right-click counts. */
    counted(): R[] {
      return atPress ?? read();
    },
    /** Whether the press itself made the selection there is now. */
    madeByPress(): boolean {
      return atPress !== null && atPress.length === 0 && read().length > 0;
    },
  };
}

// ---- a finger or pen's menu shows at 500ms -----------------------------------------------------

export interface MenuHoldPress {
  /** The place's element: its own contextmenu belongs to the hold; `echo` also recognizes the release click. */
  key: unknown;
  pointerId: number;
  at: HoldPoint;
  /** Open the place's menu. False means it stopped being eligible; nothing is then suppressed. */
  show(): boolean;
  /** A draggable row's handoff when the press moves past tolerance AFTER the lift. */
  drag?(at: HoldPoint): void;
  /** A draggable row's visual lift at the deadline, then its settle on release/cancel/drag. */
  lift?(on: boolean): void;
}

/**
 * The one touch/pen hold behind every menu place. Movement within 10px is still stationary. Before
 * the deadline, moving past it abandons the press to the browser's scroll. A draggable row lifts at
 * the deadline without opening its menu: post-lift movement drags, while a stationary release opens.
 * A place with no drag opens at the deadline. `owned` covers the place's native contextmenu; `echo` identifies
 * the fired pointer's release click even when the newly opened panel is under the finger.
 */
export function createMenuHold(opts: { delayMs?: number; now?(): number; schedule?(fn: () => void, ms: number): unknown; unschedule?(handle: unknown): void } = {}) {
  let active: MenuHoldPress | null = null;
  let released: unknown = null;
  let releasedPointer: number | null = null;
  const hold = createHoldGesture({
    delayMs: opts.delayMs ?? HOLD_MS,
    now: opts.now,
    schedule: opts.schedule,
    unschedule: opts.unschedule,
    onHold: () => {
      const press = active;
      if (!press) return;
      if (press.drag) {
        press.lift?.(true);
        return;
      }
      if (press.show()) return;
      active = null;
      released = null;
      releasedPointer = null;
      hold.cancel();
    },
  });
  const end = (fired: boolean, key: unknown, pointerId: number) => {
    active?.lift?.(false);
    active = null;
    released = fired ? key : null;
    releasedPointer = fired ? pointerId : null;
  };
  return {
    /** Innermost place wins if pointerdown bubbles through another registered place. */
    start(press: MenuHoldPress): boolean {
      if (active?.pointerId === press.pointerId) return false;
      if (active) {
        const old = active;
        const fired = hold.held();
        hold.cancel();
        end(fired, old.key, old.pointerId);
      }
      released = null;
      releasedPointer = null;
      active = press;
      hold.start(press.at);
      return true;
    },
    move(pointerId: number, at: HoldPoint) {
      const press = active;
      if (!press || press.pointerId !== pointerId) return;
      const near = Math.abs(at.x - press.at.x) <= HOLD_MOVE_PX && Math.abs(at.y - press.at.y) <= HOLD_MOVE_PX;
      if (hold.held()) {
        if (!press.drag || near) return;
        end(true, press.key, press.pointerId);
        hold.cancel();
        press.drag(at);
        return;
      }
      if (near) return hold.move(at);
      // Before the lift this is the browser's scroll, never the row's drag.
      end(false, press.key, press.pointerId);
      hold.cancel();
    },
    finish(pointerId: number) {
      const press = active;
      if (!press || press.pointerId !== pointerId) return;
      const fired = hold.finish();
      end(fired && press.drag ? press.show() : fired, press.key, press.pointerId);
    },
    /** Pointer cancellation, scroll, blur, hidden page, lost capture or teardown. */
    cancel(pointerId?: number) {
      const press = active;
      if (!press || (pointerId !== undefined && press.pointerId !== pointerId)) return;
      const fired = hold.held();
      hold.cancel();
      end(fired, press.key, press.pointerId);
    },
    /** This pointer's release click, even when the newly opened panel is now under the finger. */
    echo(pointerId: number): boolean {
      if (active && hold.held()) return active.pointerId === pointerId;
      return releasedPointer === pointerId && hold.suppressed();
    },
    /** The place whose browser events belong to this press or its fired aftermath. */
    owned(): unknown {
      return active?.key ?? (released !== null && hold.suppressed() ? released : null);
    },
    /** A menu has opened under a finger still down: its touchmove must not pan the page. */
    held: () => !!active && hold.held(),
  };
}

// ---- a mouse's menu shows on the release ------------------------------------------------------

/**
 * Whether a `contextmenu` came while a mouse button is still held (`buttons` not 0): Linux and macOS
 * browsers send it on the press, Windows on the release (`buttons` 0). Shown during the press, the
 * menu sits under the pointer with its corner (or, flipped, its far edge) at it, so the release lands
 * on the row beneath and the browser's light dismiss closes it. A held press's menu waits for the
 * release instead (§app.context-menus/placement). Pure.
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
  /** Runs `fn` on a later task (the page's: setTimeout 0), past the release's light dismiss, mouseup
      and click; answers how to cancel it. */
  later(fn: () => void): () => void;
}

/**
 * At most one menu waiting for its press to finish. `request` shows a menu at once when no button
 * is held, or else once every button is back up (the first `pointerup` with `buttons` 0, then one
 * task later). It waits with no deadline, and is abandoned, opening nothing, on `pointercancel`, the
 * window's blur, the page turning hidden, an Escape keydown, a newer `contextmenu`, a newer
 * request, or `cancelOf` its place (a place going away). Listens only while one waits.
 */
export function createOpenOnRelease(env: ReleaseEnv) {
  let waiting: { key: unknown; run: () => void } | null = null;
  let cancelLater: (() => void) | null = null;
  const onUp = (e: Event) => {
    if (!waiting || cancelLater || (e as Event & { buttons?: number }).buttons) return;
    const run = waiting.run;
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
    /** Show a place's menu (`run`) now, or on the release when `held`; `key` names the place for `cancelOf`. */
    request(held: boolean, key: unknown, run: () => void) {
      stop();
      if (!held) return run();
      waiting = { key, run };
      listen(true);
    },
    /** Abandon the waiting menu when `match` says it is this place's. */
    cancelOf(match: (key: unknown) => boolean) {
      if (waiting && match(waiting.key)) stop();
    },
    /** A menu is waiting for its release. */
    waiting: () => waiting !== null,
  };
}
