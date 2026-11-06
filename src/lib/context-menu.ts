// Right-click menus (§app/context-menus): what a `contextmenu` event, Shift+F10 or the Menu key
// does — Sova's menu for the innermost thing that has one, the browser's own menu, or nothing (the
// echo of a gesture that already meant something). Framework-free and DOM-free at import, so the
// rules run under `pnpm test` with stand-in elements; components/ContextMenu.tsx reads the facts
// off a real event and acts on the answer.

import { isTextEntry } from "./text-entry";

/** What made the event: a mouse (or trackpad), a finger, a pen, or a key. */
export type PointerKind = "mouse" | "touch" | "pen" | "keyboard";

/** Firefox's `mozInputSource` codes (MouseEvent.MOZ_SOURCE_*). */
const MOZ_SOURCE: Record<number, PointerKind> = { 1: "mouse", 2: "pen", 5: "touch", 6: "keyboard" };

/**
 * The input a `contextmenu` came from. Chromium sends it as a PointerEvent with a `pointerType`, but
 * for a key that can't be relied on: some builds send the empty string, read here as a key, and
 * Linux Chromium sends "mouse". So a key is never known by it: Sova's own Shift+F10 and Menu key are
 * known by their keydown (ContextMenu.tsx `fromKey`), and the browser's menu after them is their
 * echo. A key-made event read as "mouse" has no button down, so it opens at once, as a key's does.
 * Firefox says it in `mozInputSource`. A browser that says neither (a plain MouseEvent) gets the kind
 * of the last pointer that went down, so a long press there is still a finger's.
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
  /** The place's own gesture claims the event: a session row's hold or drag, or a finger's press still down. */
  holds: boolean;
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
  // A finger or a pen never opens Sova's menu: whatever the browser does with a long press stays.
  if (f.kind === "touch" || f.kind === "pen") return "native";
  // Shift+F10 is a key's own chord, not a request for the browser's menu.
  if (f.shiftKey && f.kind !== "keyboard") return "native";
  if (f.textEntry || f.inPopover || f.contentLink) return "native";
  // A key has no pointer to be on the selection with.
  if (f.onSelection && f.kind !== "keyboard") return "native";
  return "open";
}

/**
 * Whether a session row's own gesture owns this `contextmenu` (§app.session-list/drop-overlay): a
 * hold that fired (its suppression window), a drag in flight, or a finger's or pen's press still
 * down — Android sends its long-press menu around the same 500ms the hold fires at, sometimes
 * before it. A mouse press in flight doesn't: a right-click is a press of its own.
 */
export function holdOwns(p: { suppressed: boolean; dragging: boolean; phase: string; pointerKind: string }): boolean {
  return p.suppressed || p.dragging || (p.phase !== "idle" && p.pointerKind !== "mouse");
}

/**
 * Whether a pointerdown may start a row's press-and-hold. Only the main mouse button does, and not
 * with Ctrl held: on a Mac that is a right-click, elsewhere a click that opens a new tab — never a
 * hold or a drag. Touch and pen always may.
 */
export const startsPress = (e: { pointerType: string; button: number; ctrlKey: boolean }): boolean => !(e.pointerType === "mouse" && (e.button !== 0 || e.ctrlKey));

/** Shift+F10, or the Menu key alone (§app.context-menus/keyboard). Any other modifier is another chord. */
export function isContextMenuKey(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return (e.key === "F10" && e.shiftKey) || (e.key === "ContextMenu" && !e.shiftKey);
}

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

// ---- one press of the key opens one menu ------------------------------------------------------

/**
 * How long after a key opened Sova's menu (or after that key came back up) the browser's own
 * keyboard menu may still arrive. Chromium on Windows sends it on the Menu key's keyup.
 */
export const KEYBOARD_ECHO_MS = 1000;

/**
 * Shift+F10 and the Menu key open Sova's menu on their keydown; Windows and Linux browsers then send
 * a `contextmenu` of their own for the same press, which must not open (or move) a second one.
 * `isEcho` answers once per keyboard open: the first `contextmenu` in the window that no pointer
 * press came before is the key's echo. A real right-click always has its pointerdown first.
 */
export function createKeyEcho(now: () => number = () => Date.now()) {
  let pendingAt: number | null = null;
  return {
    /** A key opened Sova's menu just now. */
    opened() {
      pendingAt = now();
    },
    /** The key came back up: the window runs from here, for a key held down a while. */
    keyUp() {
      if (pendingAt !== null) pendingAt = now();
    },
    /** A pointer went down: what follows is a pointer's, not the key's echo. */
    pointerDown() {
      pendingAt = null;
    },
    /** Whether a `contextmenu` arriving now is the echo; answers true at most once per open. */
    isEcho(): boolean {
      if (pendingAt === null) return false;
      const echo = now() - pendingAt <= KEYBOARD_ECHO_MS;
      pendingAt = null;
      return echo;
    },
  };
}

/**
 * What a right-click's "on the selection" reads (§app.context-menus/native): the text selected when
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

// ---- a mouse's menu shows on the release ------------------------------------------------------

/**
 * Whether a `contextmenu` came while a mouse button is still held (`buttons` not 0): Linux and macOS
 * browsers send it on the press, Windows on the release (`buttons` 0), and a key's has no button.
 * Shown during the press, the menu sits under the pointer with its corner (or, flipped, its far
 * edge) at it, so the release lands on the row beneath and the browser's light dismiss closes it.
 * A held press's menu waits for the release instead (§app.context-menus/placement). Pure.
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
