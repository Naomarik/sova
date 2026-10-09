import { createSignal, type Accessor } from "solid-js";

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
