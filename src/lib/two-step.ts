import { createSignal } from "solid-js";

/**
 * A two-press destructive button's arming: the first press arms a key, the second runs it, and
 * leaving the button disarms it. A press elsewhere blurs the armed button before its own click
 * lands, and whatever the arming showed (a line under it) going away would move the pressed
 * button out from under the pointer: such a blur disarms after that click instead, and only the
 * arming it was for.
 */

let pressed = false;
let installed = false;
function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("pointerdown", () => (pressed = true), true);
  const release = () => setTimeout(() => (pressed = false));
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}

export function createArm<K = string>() {
  install();
  const [armed, setArmed] = createSignal<K | null>(null);
  /** Each arming's number: a disarm waiting for a click clears only the arming it was for. */
  let seq = 0;
  const arm = (key: K) => {
    seq++;
    setArmed(() => key);
  };
  const reset = () => {
    seq++;
    setArmed(null);
  };
  const disarm = (key: K) => {
    const at = seq;
    const clear = () => {
      if (armed() === key && seq === at) setArmed(null);
    };
    if (pressed) window.addEventListener("click", clear, { once: true });
    else clear();
  };
  return { armed, arm, reset, disarm };
}
