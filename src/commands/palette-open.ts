// Who asked for the command palette, and for which chat (§app.command-palette/opening). The
// palette itself is a file of its own the browser fetches on first use; this tiny module is what
// the key (App) and a composer's `plus` button set, so neither imports the palette's code.

import { createSignal } from "solid-js";

/** How it was opened: Ctrl/⌘+K, or a composer's `plus`. */
export type PaletteOrigin = "key" | "plus";

export interface PaletteRequest {
  origin: PaletteOrigin;
  /** The chat its rows act on; null: the open chat (a workspace's focused pane). */
  path: string | null;
  /** What `Esc` and the scrim give focus back to; null: whatever had it before. */
  trigger: HTMLElement | null;
}

const [request, setRequest] = createSignal<PaletteRequest | null>(null);

/** The palette's opening now, or null while it's closed. */
export const paletteRequest = request;

/** Opens it from a composer's `plus`, on that composer's chat. */
export const openPaletteFrom = (path: string, trigger: HTMLElement): void => {
  setRequest({ origin: "plus", path, trigger });
};

/** The key: opens it on the open chat, or closes it whoever opened it. */
export const togglePaletteFromKey = (): void => {
  setRequest((cur) => (cur ? null : { origin: "key", path: null, trigger: null }));
};

export const closePalette = (): void => {
  setRequest(null);
};

/** A phone, where focusing a field raises the keyboard: a coarse pointer, or a window under 768px. */
export const isPhone = (): boolean =>
  typeof window !== "undefined" && ((window.matchMedia?.("(pointer: coarse)").matches ?? false) || window.innerWidth < 768);
