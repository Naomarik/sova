// Whether the on-screen keyboard is up (§chat.voice/button), read from the visual viewport: the
// keyboard is the one thing that takes a large bite out of its height at a fixed width. The bar
// at 80% of the tallest height seen clears a collapsing URL bar (about 60 px, under 10% of a
// phone) and sits far above any phone keyboard (35% or more of the screen; 823 → 473 px on a Fold).

export interface Tallest {
  width: number;
  height: number;
}

/** The keyboard counts as up when the viewport is under this share of its tallest height. */
export const KEYBOARD_UP_BELOW = 0.8;

/** The tallest height at the current width; a new width (rotation, a fold) starts over. */
export const nextTallest = (prev: Tallest | null, width: number, height: number): Tallest =>
  prev && prev.width === width ? { width, height: Math.max(prev.height, height) } : { width, height };

export const keyboardUp = (tallest: Tallest, height: number): boolean => height < tallest.height * KEYBOARD_UP_BELOW;

let tallest: Tallest | null = null;
let watching = false;

const sample = (vv: VisualViewport) => (tallest = nextTallest(tallest, Math.round(vv.width), vv.height));

/** Starts following the visual viewport, once per page, so a press can tell later. */
export function watchKeyboard(): void {
  const vv = typeof window === "undefined" ? undefined : window.visualViewport;
  if (watching || !vv) return;
  watching = true;
  sample(vv);
  vv.addEventListener("resize", () => sample(vv));
}

/** Whether the keyboard is up now. Without `visualViewport` it counts as down. */
export function keyboardIsUp(): boolean {
  const vv = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!vv) return false;
  watchKeyboard();
  return keyboardUp(sample(vv), vv.height);
}
