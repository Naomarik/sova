/**
 * The pre-paint script: the stored theme on the document before the first frame.
 *
 * The app's own startup (`main.tsx` → `applyStoredTheme`) is a module, and a module runs only after
 * the page has painted at least once: a reload of a light window showed the built-in Dark for a few
 * hundred milliseconds first. So `index.html` carries this function as a classic script in its
 * <head>, after the theme-color meta, where it runs before the body is even parsed. `vite.config.ts`
 * injects it (`prepaintScript`), into the app's page only, never the share build's.
 *
 * It paints what `theme.ts`'s `paint` would for the stored record: the shown base's pick (under Auto
 * the system's setting), its cached tokens on their custom properties verbatim, `data-theme`, and the
 * browser bar's color. Fonts and text size are left to the app's startup. The app repaints the same
 * values a moment later and owns everything after.
 *
 * The function runs as the page's first script, with no module system: it may use nothing from
 * outside its own body. The key→property table and the base surfaces arrive as arguments, serialised
 * from the very constants the app paints with, so there is no second copy of either to drift.
 */

import { BASE_SURFACE, CSS_PROPERTY, type ThemeBase } from "../../shared/theme";

/** The ground rules: the choice persists here. */
export const THEME_KEY = "sova:theme";

/** Paint the stored theme now, or leave the document on its default Dark. Anything unexpected (no
    storage, junk in it, a shape from a newer build) is the default Dark, never a broken page; so is
    the reset link, `?theme=default` or `?theme=dark`, which `main.tsx` carries out. */
export function prepaintTheme(property: Readonly<Record<string, string>>, surface: Readonly<Record<ThemeBase, string>>, key: string): void {
  try {
    const asked = new URLSearchParams(location.search).get("theme");
    if (asked === "default" || asked === "dark") return;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    // A pick as `theme.ts`'s readPick takes it: a non-empty id, standing on its own list's base.
    const pickOf = (value: unknown, slot: ThemeBase): Record<string, unknown> | null => {
      if (!value || typeof value !== "object") return null;
      const p = value as { id?: unknown; base?: unknown; tokens?: unknown };
      if (typeof p.id !== "string" || !p.id) return null;
      if ((p.base === "light" ? "light" : "dark") !== slot) return null;
      return p.tokens && typeof p.tokens === "object" ? (p.tokens as Record<string, unknown>) : {};
    };
    let mode: unknown;
    let light: Record<string, unknown> | null = null;
    let dark: Record<string, unknown> | null = null;
    if (parsed.v === undefined && "id" in parsed) {
      // The single theme stored before there were two picks: its base is the mode.
      mode = parsed.base === "light" ? "light" : "dark";
      const pick = pickOf(parsed, mode as ThemeBase);
      if (!pick) return;
      if (mode === "light") light = pick;
      else dark = pick;
    } else if (parsed.v === 2) {
      mode = parsed.mode === "light" || parsed.mode === "auto" ? parsed.mode : "dark";
      light = pickOf(parsed.light, "light");
      dark = pickOf(parsed.dark, "dark");
    } else return;
    const systemLight = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
    const base: ThemeBase = mode === "auto" ? (systemLight ? "light" : "dark") : (mode as ThemeBase);
    const tokens = base === "light" ? light : dark;
    const root = document.documentElement;
    if (tokens) {
      for (const k of Object.keys(tokens)) {
        if (Object.prototype.hasOwnProperty.call(property, k)) root.style.setProperty(property[k]!, String(tokens[k]));
      }
    }
    // No attribute is the built-in dark; a dark pick still says `dark`.
    if (base === "light" || tokens) root.setAttribute("data-theme", base);
    const color = tokens && typeof tokens.surface === "string" ? tokens.surface : surface[base];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && color) meta.setAttribute("content", color);
  } catch {
    // The page stays on its default Dark; the app's startup repaints from the store in a moment.
  }
}

/** The classic script `index.html` runs: the function above, called with the table and surfaces the
    app paints with. The `args` comment before the arguments lets a test read back exactly what was
    injected. */
export function prepaintScript(): string {
  return `(${prepaintTheme.toString()})(/*args*/${JSON.stringify(CSS_PROPERTY)},${JSON.stringify(BASE_SURFACE)},${JSON.stringify(THEME_KEY)});`;
}
