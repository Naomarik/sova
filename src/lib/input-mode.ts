import { createSignal, type Accessor } from "solid-js";
import type { StopButton } from "./compact";
import { keyboardIsUp } from "./voice/keyboard";

/** The fields of a keydown that decide whether Enter sends. */
export type EnterKey = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean };

/**
 * Whether this keydown sends. In touch mode Enter is the on-screen keyboard's line key and Send
 * sends; Ctrl/⌘+Enter sends everywhere, Shift+Enter never does, and an IME's Enter is its own.
 */
export function enterSends(e: EnterKey, touch: boolean): boolean {
  if (e.isComposing || e.key !== "Enter") return false;
  if (e.ctrlKey || e.metaKey) return true;
  if (e.shiftKey) return false;
  return !touch;
}

/** The fields of a keydown that decide whether Esc stops the reply. */
export type EscKey = EnterKey & { altKey: boolean; repeat: boolean; defaultPrevented: boolean; keyCode: number; timeStamp: number };

/** An Esc less than this long after the page's previous Esc never stops the reply. */
export const ESC_SETTLE_MS = 500;

/**
 * Whether an Esc at `at` came too soon after the page's previous Esc (`previous`; both are
 * `event.timeStamp`s, never compared with any other clock): the press that just closed a menu, the
 * palette, a pane or a dictation, or a second press to be sure. A gap that reads negative counts
 * as too soon; no previous Esc never does.
 */
export function escTooSoon(at: number, previous: number | null, ms = ESC_SETTLE_MS): boolean {
  return previous !== null && at - previous < ms;
}

/**
 * Whether this keydown in the message box stops the reply, as pressing Stop does: a plain Esc
 * (no modifier) while Stop is usable. An Esc something else took first never stops: a handler
 * that already prevented its default, an IME composition (Safari's composition-ending key arrives
 * with keyCode 229 and isComposing false), an open popover Esc closes, and a held key repeats
 * without stopping again. Nor does an Esc right after another one anywhere on the page
 * (`previousEsc`, escTooSoon), whatever that one closed. `popoverOpen` is read last, only for an
 * Esc that would otherwise stop. The / and @ menus need no check here: composerKey gives them the
 * key first.
 */
export function escStops(e: EscKey, stop: StopButton, popoverOpen: () => boolean, previousEsc: number | null): boolean {
  if (e.key !== "Escape" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.isComposing || e.keyCode === 229 || e.repeat || e.defaultPrevented) return false;
  if (escTooSoon(e.timeStamp, previousEsc)) return false;
  return stop === "usable" && !popoverOpen();
}

/** What one keydown in the message box does (composerKey). "default" leaves the key to the browser. */
export type ComposerKey =
  | "slash-move"
  | "slash-pick"
  | "slash-close"
  | "mention-move"
  | "mention-pick"
  | "mention-close"
  | "stop"
  | "send"
  | "default";

/** What the message box knows when a key goes down. */
export type ComposerKeyState = {
  /** The / menu: open, and how many rows it shows. */
  slash: { open: boolean; matches: number };
  /** The @ menu: open, and how many rows it shows. */
  mention: { open: boolean; matches: number };
  /** A bare local command runs on the Enter that would send, so the / menu leaves that Enter alone. */
  runsLocal: boolean;
  touch: boolean;
  stop: StopButton;
  /** Whether a popover Esc would close is open; read only for an Esc that would otherwise stop. */
  popoverOpen: () => boolean;
  /** When the page's Esc before this one went down (`event.timeStamp`), or null. */
  previousEsc: number | null;
};

/**
 * The message box's one key rule: what a keydown does, asked in this order. The / menu, then the @
 * menu, each takes its arrows (with rows to move through), Enter or Tab (with a row to pick) and
 * Esc (always: it closes, and never stops); an IME composition leaves both menus alone. Then Esc
 * may stop the reply (escStops), then Enter may send (enterSends). Anything else is "default".
 */
export function composerKey(e: EscKey, s: ComposerKeyState): ComposerKey {
  if (s.slash.open && !e.isComposing && !s.runsLocal) {
    const k = menuKey(e, s.slash.matches);
    if (k) return k === "default" ? k : `slash-${k}`;
  }
  if (s.mention.open && !e.isComposing) {
    const k = menuKey(e, s.mention.matches);
    if (k) return k === "default" ? k : `mention-${k}`;
  }
  if (escStops(e, s.stop, s.popoverOpen, s.previousEsc)) return "stop";
  if (enterSends(e, s.touch)) return "send";
  return "default";
}

/**
 * An open / or @ menu's share of a key. Arrows are the menu's even with no rows (they do nothing);
 * Tab with no row moves focus as usual; Enter with no row, and every other key, goes on (null).
 */
function menuKey(e: EscKey, matches: number): "move" | "pick" | "close" | "default" | null {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return matches > 0 ? "move" : "default";
  if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
    if (matches > 0) return "pick";
    if (e.key === "Tab") return "default";
  }
  if (e.key === "Escape") return "close";
  return null;
}

/**
 * Touch mode for one composer: how its textarea was last pressed. A tap turns it on, a mouse or
 * pen press turns it off, and keyboard or programmatic focus leaves it. Starts off.
 */
export function createTouchMode(): { touch: Accessor<boolean>; onPointerDown(e: PointerEvent): void } {
  const [touch, setTouch] = createSignal(false);
  return { touch, onPointerDown: (e) => setTouch(e.pointerType === "touch") };
}

/** How a Send, Steer or Stop press began: a touch, and whether the textarea had focus with the keyboard up. */
export type SendPress = { touch: boolean; focused: boolean; keyboardUp: boolean };

/**
 * Whether focus goes back to the textarea after a send or stop. A key send (no press), a mouse or
 * a pen always returns it; a tap only when the textarea had it with the keyboard up, so a
 * keyboard that was down stays down.
 */
export function refocusAfterSend(press: SendPress | null): boolean {
  if (!press || !press.touch) return true;
  return press.focused && press.keyboardUp;
}

/** What a press reads at pointerdown, before focus moves: the focused element and the keyboard. */
export type PressNow = { active: Element | null; keyboardUp: boolean };

/**
 * How a press began, read at its pointerdown (before the press moves focus): a touch, and whether
 * `input` had focus with the on-screen keyboard up.
 */
export function notePress(
  e: { pointerType: string },
  input: Element | null | undefined,
  now: PressNow = { active: document.activeElement, keyboardUp: keyboardIsUp() },
): SendPress {
  return { touch: e.pointerType === "touch", focused: !!input && now.active === input, keyboardUp: now.keyboardUp };
}

/**
 * The press behind the next send made on the user's behalf (a quick action, a card's button, a
 * panel's Send): every pointerdown on the page is noted in the capture phase, before it moves
 * focus, and any keydown forgets it, so an earlier tap never speaks for a key-made send. `take`
 * hands the press over once; null means a key or nothing, which counts as Enter.
 */
export function createPressTracker(
  note: (e: PointerEvent) => SendPress,
  target: EventTarget = document,
): { take(): SendPress | null; dispose(): void } {
  let last: SendPress | null = null;
  const down = (e: Event) => (last = note(e as PointerEvent));
  const key = () => (last = null);
  target.addEventListener("pointerdown", down, true);
  target.addEventListener("keydown", key, true);
  return {
    take: () => {
      const p = last;
      last = null;
      return p;
    },
    dispose: () => {
      target.removeEventListener("pointerdown", down, true);
      target.removeEventListener("keydown", key, true);
    },
  };
}
