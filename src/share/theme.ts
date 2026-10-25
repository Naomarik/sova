/**
 * The share build's theme (§app.owner-page/page): until a visitor picks, it follows the device's light or dark setting
 * and changes with it; the toggle's pick (light or dark) is remembered in this browser for the share address
 * (`localStorage`), so every page of the build follows it from its first frame. An older stored `system` reads as no
 * pick. It only sets `data-theme` on <html> (the design tokens' switch, src/design/tokens.css); the operator app's
 * themes are the main listener's and never reach here.
 */
import { createSignal } from "solid-js";

export type Theme = "light" | "dark";
const KEY = "sova-share:theme";

const storage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const readPick = (): Theme | null => {
  try {
    const v = storage()?.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
};
const media = (): MediaQueryList | null => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null);
const device = (): Theme => (media()?.matches ? "light" : "dark");

const [pick, setPick] = createSignal<Theme | null>(readPick());
const [deviceTheme, setDeviceTheme] = createSignal<Theme>(device());

/** What the page draws now: the visitor's pick, or the device's setting. */
export const resolvedTheme = (): Theme => pick() ?? deviceTheme();

const apply = () => document.documentElement.setAttribute("data-theme", resolvedTheme());

/** Set the theme before the first render, and follow the device (and another tab's pick) after. */
export function startTheme(): void {
  apply();
  media()?.addEventListener("change", () => {
    setDeviceTheme(device());
    apply();
  });
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    setPick(readPick());
    apply();
  });
}

/** The toggle: draw the opposite of what shows now, and remember it in this browser. */
export function toggleTheme(): void {
  const next: Theme = resolvedTheme() === "dark" ? "light" : "dark";
  setPick(next);
  try {
    storage()?.setItem(KEY, next);
  } catch {
    // blocked storage: the pick holds for this page only
  }
  apply();
}
