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
export type EscKey = EnterKey & { altKey: boolean; repeat: boolean; defaultPrevented: boolean; keyCode: number };

/**
 * Whether this keydown in the message box stops the reply, as pressing Stop does: a plain Esc
 * (no modifier) while Stop is usable. An Esc something else took first never stops: a handler
 * that already prevented its default, an IME composition (Safari's composition-ending key arrives
 * with keyCode 229 and isComposing false), an open popover Esc closes, and a held key repeats
 * without stopping again. `popoverOpen` is read last, only for an Esc that would otherwise stop.
 * The / and @ menus need no check here: the composer gives them the key before it asks this.
 */
export function escStops(e: EscKey, stop: StopButton, popoverOpen: () => boolean): boolean {
  if (e.key !== "Escape" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.isComposing || e.keyCode === 229 || e.repeat || e.defaultPrevented) return false;
  return stop === "usable" && !popoverOpen();
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
