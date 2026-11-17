// Which chat's composer "+" opened the Commands dialog (§app.command-palette/opening). The dialog
// itself is a file of its own the browser fetches on first use; this tiny module is what a
// composer's `plus` button sets, so the composer never imports the dialog's code.

import { createSignal } from "solid-js";

export interface PaletteRequest {
  /** The chat its rows act on: the composer's own. */
  path: string;
  /** What `Esc` and the scrim give focus back to: the "+" it was opened from. */
  trigger: HTMLElement;
}

const [request, setRequest] = createSignal<PaletteRequest | null>(null);

/** The dialog's opening now, or null while it's closed. */
export const paletteRequest = request;

/** Opens it from a composer's `plus`, on that composer's chat. */
export const openPaletteFrom = (path: string, trigger: HTMLElement): void => {
  setRequest({ path, trigger });
};

export const closePalette = (): void => {
  setRequest(null);
};

/** A phone, where focusing a field raises the keyboard: a coarse pointer, or a window under 768px. */
export const isPhone = (): boolean =>
  typeof window !== "undefined" && ((window.matchMedia?.("(pointer: coarse)").matches ?? false) || window.innerWidth < 768);
