/**
 * The share build's theme (§app.owner-page/page): `System` follows the device's light or dark setting and changes with
 * it; `Light` and `Dark` are a visitor's pick, remembered in this browser for the share address (`localStorage`), so
 * every page of the build follows it from its first frame. It only sets `data-theme` on <html> (the design tokens'
 * switch, src/design/tokens.css); the operator app's themes are the main listener's and never reach here.
 */
import { createSignal } from "solid-js";

export type ThemePick = "system" | "light" | "dark";
export const THEME_PICKS: readonly ThemePick[] = ["system", "light", "dark"];
const KEY = "sova-share:theme";

const storage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const readPick = (): ThemePick => {
  try {
    const v = storage()?.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};
const media = (): MediaQueryList | null => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null);

const [pick, setPickSignal] = createSignal<ThemePick>(readPick());
export { pick as themePick };

/** What the page draws now: the pick, or the device's setting under System. */
export const resolvedTheme = (p: ThemePick = pick()): "light" | "dark" => (p === "system" ? (media()?.matches ? "light" : "dark") : p);

const apply = () => document.documentElement.setAttribute("data-theme", resolvedTheme());

/** Set the theme before the first render, and follow the device (and another tab's pick) after. */
export function startTheme(): void {
  apply();
  media()?.addEventListener("change", () => {
    if (pick() === "system") apply();
  });
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    setPickSignal(readPick());
    apply();
  });
}

/** The visitor's pick: drawn at once, remembered in this browser. */
export function setThemePick(p: ThemePick): void {
  setPickSignal(p);
  try {
    if (p === "system") storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, p);
  } catch {
    // blocked storage: the pick holds for this page only
  }
  apply();
}
