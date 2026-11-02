import { createSignal, type Accessor } from "solid-js";
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
