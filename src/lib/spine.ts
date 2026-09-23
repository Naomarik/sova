/** The sessions pane's collapsed state — the 64px **spine** (≥768px only; below that the folded
 *  `data-view` layout already swaps columns). Collapsing is one knob: `--sidebar-width` on <html>
 *  is overwritten with `--spine-width`, and expanding writes back the last width the resizer
 *  applied. The choice persists; the expanded width does not (every load starts at the default,
 *  as `sidebar-width.ts` says). Pure where possible: the DOM is read in `spineWidth` and written
 *  only through `applySidebarWidth`, and `applyStoredSpine` is the pre-paint call for `main.tsx`. */

import { createSignal } from "solid-js";
import { applySidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "./sidebar-width";
import { dualGet, dualSet } from "./storage-keys";

/** "1" collapsed, "0" expanded. The legacy spelling is read and mirrored (storage-keys.ts). */
export const SPINE_KEY = "sova:sidebar-collapsed";
export const LEGACY_SPINE_KEY = "pi-web:sidebar-collapsed";

/** The collapsed width when the `--spine-width` token can't be read (tokens.css). */
export const FALLBACK_SPINE_WIDTH = 64;

/** The stored choice: only "1" collapses. Absent, "0" or anything else is the expanded pane. */
export function readSpine(store: Storage): boolean {
  return dualGet(store, SPINE_KEY, LEGACY_SPINE_KEY) === "1";
}

export function writeSpine(store: Storage, on: boolean): void {
  dualSet(store, SPINE_KEY, LEGACY_SPINE_KEY, on ? "1" : "0");
}

/** The user's choice, whatever the viewport. Collapsed-on-screen is `spine() && unfolded` (App.tsx). */
const [spine, setSpineSignal] = createSignal(false);
export { spine };

export function setSpine(on: boolean): void {
  setSpineSignal(on);
  try {
    writeSpine(localStorage, on);
  } catch {
    // No storage at all: the in-memory choice still holds.
  }
}

export function toggleSpine(): void {
  setSpine(!spine());
}

/** A computed `--spine-width` value as pixels, or the fallback when it is missing or nonsense. */
export function parseSpineWidth(raw: string): number {
  const px = parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : FALLBACK_SPINE_WIDTH;
}

/** The collapsed width, read from the token on `root`. */
export function spineWidth(root: HTMLElement): number {
  return parseSpineWidth(getComputedStyle(root).getPropertyValue("--spine-width"));
}

/** The expanded width to restore: the resizer's last applied write, in memory for the page's life. */
let expandedWidth = DEFAULT_SIDEBAR_WIDTH;

export function rememberExpandedWidth(width: number): void {
  expandedWidth = width;
}

export function rememberedWidth(): number {
  return expandedWidth;
}

/** Pre-paint (`main.tsx`), like the theme: the stored choice goes on now, so a reload of a
    collapsed window never flashes the 320px pane first. The token write happens only where the
    spine can show; App.tsx keeps it in step with the viewport afterwards. */
export function applyStoredSpine(): void {
  let on = false;
  try {
    on = readSpine(localStorage);
  } catch {
    // Blocked storage reads as the default, expanded.
  }
  setSpineSignal(on);
  if (on && matchMedia("(min-width: 768px)").matches) {
    const root = document.documentElement;
    applySidebarWidth(root, spineWidth(root));
  }
}

/** A recent tile's two letters: the first code point of each of the first two words; a one-word
    title keeps its first two code points. Uppercased here, in the string, not left to
    `text-transform` on `.spine-monogram`: the monogram is what the tile shows and what its test
    holds, so a restyle must not be able to change it. An empty title gives "" and the tile shows
    the `chat` icon instead. Code points, not UTF-16 units, so an emoji stays whole. */
export function monogram(title: string): string {
  const [first, second] = title.trim().split(/\s+/).filter(Boolean);
  if (!first) return "";
  if (!second) return Array.from(first).slice(0, 2).join("").toUpperCase();
  const initial = (w: string) => (Array.from(w)[0] ?? "").toUpperCase();
  return initial(first) + initial(second);
}
