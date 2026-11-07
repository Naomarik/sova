// Typing anywhere starts a message: a character typed while focus is outside a text field moves
// focus into the chat's message box during that same keydown, and the browser types the character
// there (no preventDefault), so an accent key's composition, the @ menu and Undo work as typing in
// the box does. Its key row is commands/keys ("compose.type"); App owns it and picks the box.
// It is always on: there is no switch. The row's own scope (keys.ts) already leaves out a key typed
// in a caret field and an input method's composing keydown; this file adds the rest. Everything here
// is pure, so the unit tier covers it.

/** The parts of a keydown the character rule reads. */
export interface CharKeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}

/** Apple's systems, where Option types characters and Ctrl never does. Read once; tests set it. */
export const keyPlatform = { mac: typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") };

/** One visible character, as a text field would take it. Space scrolls and presses, so it isn't one. */
const isOneCharacter = (key: string) => key !== " " && [...key].length === 1 && !/\p{Cc}/u.test(key);

/**
 * Whether a keydown types a character (or starts one, an accent key's "Dead"): a letter, digit or
 * symbol, with Shift, an Option character on a Mac, or an AltGr character (Windows reports AltGr as
 * Ctrl+Alt; Linux as the AltGraph modifier alone). Named keys (Enter, Tab, the arrows…) are words,
 * not one character. Ctrl and ⌘ chords are shortcuts, and plain Alt off a Mac is a menu key. An
 * input method's keys are its own: keyCode 229 and the words "Process" and a soft keyboard's
 * "Unidentified" (a composing keydown is the row's `composing` rule, keys.ts). An accent key is the exception to 229: Chrome and Safari on a Mac
 * report its first keydown that way, and its key still says "Dead".
 */
export function typesCharacter(e: CharKeyLike, mac: boolean = keyPlatform.mac): boolean {
  if (e.keyCode === 229 && e.key !== "Dead") return false;
  if (e.key !== "Dead" && !isOneCharacter(e.key)) return false;
  if (e.metaKey) return false;
  const altGraph = e.getModifierState?.("AltGraph") === true;
  if (e.ctrlKey) return !mac && (e.altKey || altGraph);
  if (e.altKey) return mac || altGraph;
  return true;
}

/** The parts of an element the place rules read. */
export interface ElementLike {
  tagName?: string | null;
  type?: string | null;
  isContentEditable?: boolean;
  parentElement?: ElementLike | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  matches?(selector: string): boolean;
}

/** Roles whose widgets take letters (type-ahead, a value) or hold the user (a dialog, a menu). A tablist doesn't: letters do nothing there. */
const KEEPS_KEYS = new Set(["dialog", "alertdialog", "menu", "menubar", "listbox", "tree", "treegrid", "grid", "combobox", "radiogroup", "slider", "spinbutton"]);

/**
 * Whether a key typed on `target` belongs where it was typed: a select, or anything inside a dialog,
 * a popover, a menu or a list that jumps as you type (a caret field is the row's `textEntry` rule,
 * keys.ts). A button or a link doesn't take letters, so a key typed on one is free.
 */
export function keyBelongsToTarget(target: ElementLike | null | undefined): boolean {
  for (let el = target; el; el = el.parentElement) {
    const tag = (el.tagName ?? "").toUpperCase();
    if (tag === "SELECT" || tag === "DIALOG" || el.hasAttribute?.("popover")) return true;
    const role = el.getAttribute?.("role");
    if (role && KEEPS_KEYS.has(role)) return true;
  }
  return false;
}

const matches = (el: ElementLike, selector: string) => {
  try {
    return el.matches?.(selector) === true;
  } catch {
    return false; // a browser without the pseudo-class has none of those open
  }
};

/** Whether `el` is an open overlay: a modal dialog, a scrim dialog (aria-modal, mounted only while open), or an open popover that isn't a tooltip. */
export function isOpenOverlay(el: ElementLike): boolean {
  if (el.getAttribute?.("aria-modal") === "true") return true;
  if ((el.tagName ?? "").toUpperCase() === "DIALOG") return matches(el, ":modal");
  if (el.hasAttribute?.("popover")) return el.getAttribute?.("role") !== "tooltip" && matches(el, ":popover-open");
  return false;
}

/** The candidates `isOpenOverlay` judges. */
export const OVERLAY_CANDIDATES = 'dialog, [aria-modal="true"], [popover]';

/** A box that may take the typing: true once focus is in it. */
export interface TypingBox {
  take(): boolean;
}

/**
 * The key's owner (App): with a key no widget already used (a diff's n and p prevent theirs), on a
 * free target, no overlay open and a box on screen that takes typing, focus moves into the box.
 * True when it did. Its bound owner returns false either way, so the browser's default stays and
 * types the key in the box (keys.ts KeyRun).
 */
export function startTyping(e: { target?: unknown; defaultPrevented?: boolean }, ctx: { overlays(): Iterable<ElementLike>; box(): TypingBox | null }): boolean {
  if (e.defaultPrevented) return false;
  if (keyBelongsToTarget(e.target as ElementLike | null)) return false;
  for (const el of ctx.overlays()) if (isOpenOverlay(el)) return false;
  const box = ctx.box();
  return !!box && box.take();
}

/**
 * A chat's textarea taking the typing: a read-only one (a TUI-live session, an earlier
 * conversation, a baton not held) takes nothing; one Focus hides has Focus ended first, so it is
 * visible and no longer inert when it is focused. True when focus landed in it.
 */
export function takeTyping(t: { readOnly: boolean; el: { focus(): void }; active(): unknown; hiddenByFocus: boolean; endFocus(): void }): boolean {
  if (t.readOnly) return false;
  if (t.hiddenByFocus) t.endFocus();
  t.el.focus();
  return t.active() === t.el;
}
