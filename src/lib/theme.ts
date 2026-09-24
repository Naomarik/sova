/**
 * The client half of theming (spec/00-ground-rules.md §0, spec/12-settings-dialog.md §12): the
 * theme the window is wearing, and the two calls that put one on and take it off.
 *
 * The server did the reading, the `$name` resolution and the validation (`shared/theme.ts`), so
 * everything here is already safe to paint. This module adds nothing to that judgement: a value
 * lands on its custom property VERBATIM — never parsed, normalized, or re-serialized — and the
 * key→property table is imported, never re-derived.
 *
 * The choice is the id and it lives in `localStorage` alone. There is no server write endpoint
 * for it and there must never be one: a theme is this browser's, not the machine's. The cache
 * carries the resolved tokens alongside the id for one reason — §0 requires the theme to be
 * applied BEFORE first paint, and a fetch can't be.
 */

import { createSignal } from "solid-js";
import type { ThemeList, ThemeTokens } from "../../shared/protocol";
import { CSS_PROPERTY, DEFAULT_THEME_ID, type ThemeBase } from "../../shared/theme";
import {
  DEFAULT_TEXT_SIZE,
  LEGACY_TEXT_SIZE_KEY,
  LEGACY_TYPOGRAPHY_KEY,
  NO_TYPOGRAPHY,
  parseTextSize,
  parseTypography,
  serializeTextSize,
  serializeTypography,
  TEXT_SIZE_KEY,
  type TextSize,
  textSizeProperties,
  TYPOGRAPHY_KEY,
  type Typography,
  typographyProperties,
} from "./typography";
import { dualGet, dualRemove, dualSet } from "./storage-keys";

/** §0: the choice persists here. `LEGACY_THEME_KEY` is the pre-rebrand spelling: while the
    rename bridge is open, reads fall back to it and writes mirror to it (storage-keys.ts). */
export const THEME_KEY = "sova:theme";
export const LEGACY_THEME_KEY = "pi-web:theme";

/** What we keep so the next load can paint the theme with no network. The id is the choice —
    the tokens are a cache of what the server said it resolved to, re-checked against the list
    on every boot (App.tsx) and dropped when the theme is gone or broken. */
export interface StoredTheme {
  id: string;
  base: ThemeBase;
  tokens: ThemeTokens;
}

/** The id the picker shows checked. `dark` is the default, and what a vanished id falls back to. */
const [activeThemeId, setActiveThemeId] = createSignal<string>(DEFAULT_THEME_ID);
export { activeThemeId };

/** The id of a theme we were wearing and had to take off — the file was deleted, renamed, or
    broke since the cache was written. §09's banner names it in the Themes panel, and putting any
    theme on clears it: the notice is about the theme you lost, not the one you have. */
const [droppedThemeId, setDroppedThemeId] = createSignal<string | null>(null);
export { droppedThemeId };

/** Every property a theme can write — what `clearTheme` removes, so no key of the previous
    theme outlives it. `removeProperty` on one that was never set is a no-op. */
const ALL_PROPERTIES = Object.values(CSS_PROPERTY);

/**
 * The Typography choice (§12 "Typography", `typography.ts` for the catalogue): the faces this
 * browser puts OVER whatever theme it wears. It is painted here, after the theme's tokens, on
 * every apply and clear — that ordering is the precedence rule (pick > theme > default), and it
 * has to live in the one function that writes the properties, or a theme switch would take a
 * font pick off with the previous theme's keys.
 */
const [typography, setTypographySignal] = createSignal<Typography>(NO_TYPOGRAPHY);
export { typography };

/** The Text size choice (§12 "Typography"): the same painter, the same precedence — written
    after the theme, so a Small or Large scales whatever sizes the theme set. */
const [textSize, setTextSizeSignal] = createSignal<TextSize>(DEFAULT_TEXT_SIZE);
export { textSize };

/** The theme currently on the document, so a typography change can repaint it. Null is the
    built-in dark with nothing written. */
let worn: StoredTheme | null = null;

/** The stored choice, validated against the catalogue (an id that names nothing is no choice). */
export function readStoredTypography(): Typography {
  try {
    return parseTypography(dualGet(localStorage, TYPOGRAPHY_KEY, LEGACY_TYPOGRAPHY_KEY));
  } catch {
    return NO_TYPOGRAPHY;
  }
}

function writeStoredTypography(t: Typography): void {
  try {
    const raw = serializeTypography(t);
    if (raw === null) dualRemove(localStorage, TYPOGRAPHY_KEY, LEGACY_TYPOGRAPHY_KEY);
    else dualSet(localStorage, TYPOGRAPHY_KEY, LEGACY_TYPOGRAPHY_KEY, raw);
  } catch {
    // Persistence is a convenience; the faces still hold for this page.
  }
}

export function readStoredTextSize(): TextSize {
  try {
    return parseTextSize(dualGet(localStorage, TEXT_SIZE_KEY, LEGACY_TEXT_SIZE_KEY));
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

function writeStoredTextSize(size: TextSize): void {
  try {
    const raw = serializeTextSize(size);
    if (raw === null) dualRemove(localStorage, TEXT_SIZE_KEY, LEGACY_TEXT_SIZE_KEY);
    else dualSet(localStorage, TEXT_SIZE_KEY, LEGACY_TEXT_SIZE_KEY, raw);
  } catch {
    // Persistence is a convenience; the size still holds for this page.
  }
}

/** The one painter. Theme tokens first, then the pick on top: a kind left on Theme default
    writes nothing, so the theme's own face (or tokens.css's) is what stays. The text size goes
    last — Medium writes nothing, and the clear above takes a previous Small or Large off, since
    every `--fs-*` is a theme property too. */
function paint(theme: StoredTheme | null): void {
  const root = document.documentElement;
  // Clear first: the theme being taken off may have set a key this one doesn't, and a leftover
  // would be a value from a theme nobody is wearing.
  for (const property of ALL_PROPERTIES) root.style.removeProperty(property);
  if (theme) {
    for (const [key, value] of Object.entries(theme.tokens)) {
      const property = CSS_PROPERTY[key];
      if (property) root.style.setProperty(property, value); // verbatim, as authored
    }
    root.setAttribute("data-theme", theme.base);
  } else {
    root.removeAttribute("data-theme");
  }
  for (const [property, value] of Object.entries(typographyProperties(typography()))) root.style.setProperty(property, value);
  for (const [property, value] of Object.entries(textSizeProperties(textSize(), theme?.tokens ?? {}))) root.style.setProperty(property, value);
  setMetaThemeColor(theme?.tokens.bg ?? DEFAULT_THEME_COLOR);
  worn = theme;
}

/**
 * Change one or both faces. A kind set to null goes back to the theme's own face — which is a
 * repaint of the theme, not a `removeProperty`, because the theme may have set that key itself.
 * Applies immediately and persists; called from Settings → Themes → Typography.
 */
export function setTypography(patch: Partial<Typography>): Typography {
  const next: Typography = { ...typography(), ...patch };
  setTypographySignal(next);
  writeStoredTypography(next);
  paint(worn);
  return next;
}

/** Small, Medium or Large. Applies immediately and persists; Medium removes the key. Called from
    Settings → Themes → Typography. */
export function setTextSize(size: TextSize): void {
  setTextSizeSignal(size);
  writeStoredTextSize(size);
  paint(worn);
}

/** Use Theme Fonts, and the `?theme=default` escape hatch: no pick at all, key removed. */
export function clearTypography(): void {
  setTypography({ text: null, mono: null });
}

/** `dark`'s `bg` as index.html ships it — what the chrome color goes back to. */
const DEFAULT_THEME_COLOR = "#1E1E26";

/** The browser chrome color, so a themed page doesn't sit under the default theme's bar. */
function setMetaThemeColor(value: string): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && value) meta.setAttribute("content", value);
}

/** The stored choice, or null when there is none (or storage is blocked, or it's not ours). */
export function readStoredTheme(): StoredTheme | null {
  try {
    const raw = dualGet(localStorage, THEME_KEY, LEGACY_THEME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTheme>;
    if (typeof parsed?.id !== "string" || !parsed.id) return null;
    const base: ThemeBase = parsed.base === "light" ? "light" : "dark";
    const tokens = parsed.tokens && typeof parsed.tokens === "object" ? (parsed.tokens as ThemeTokens) : {};
    return { id: parsed.id, base, tokens };
  } catch {
    // A blocked, full or hand-edited localStorage means the default theme, never a broken boot.
    return null;
  }
}

function writeStoredTheme(theme: StoredTheme): void {
  try {
    dualSet(localStorage, THEME_KEY, LEGACY_THEME_KEY, JSON.stringify(theme));
  } catch {
    // Persistence is a convenience; the theme still holds for this page.
  }
}

/**
 * Wear a theme: its tokens onto `documentElement`, `data-theme` set to the base it stands on
 * (that's what `tokens.css` paints under, and what a theme's omitted keys come from), and the
 * choice cached. Called before first paint from `main.tsx` and again on every pick.
 */
export function applyTheme(theme: StoredTheme): void {
  paint(theme);
  setActiveThemeId(theme.id);
  setDroppedThemeId(null);
  writeStoredTheme(theme);
}

/** Back to the built-in dark: every written property removed, the cache dropped, and no
    `data-theme` attribute at all — no attribute is what `tokens.css` renders dark under. */
export function clearTheme(): void {
  paint(null);
  setActiveThemeId(DEFAULT_THEME_ID);
  try {
    dualRemove(localStorage, THEME_KEY, LEGACY_THEME_KEY);
  } catch {
    // Nothing to undo: the properties are already off.
  }
}

/** The pre-paint call (`main.tsx`): apply the cached theme synchronously, or leave the document
    on its default dark. Nothing is fetched here — a flash of the default is exactly what §0
    forbids, and a reconcile against the server happens after boot (App.tsx). */
export function applyStoredTheme(): void {
  setTypographySignal(readStoredTypography());
  setTextSizeSignal(readStoredTextSize());
  const stored = readStoredTheme();
  if (stored) applyTheme(stored);
  else paint(null); // no theme, but the font pick and text size still have to be on before first paint
}

/** Two token maps hold the same values — the poll's answer against what we're wearing. */
function sameTokens(a: ThemeTokens, b: ThemeTokens): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * The cache against the server's list: once at boot (App.tsx), and on every poll while the
 * Themes tab is open. An id that no longer resolves — or that resolves to a theme we can't wear
 * — falls back to `dark` (§0), and the banner says which id went. A theme still there whose file
 * changed is re-applied, so an edit saved in another window shows up where the list does.
 *
 * Two lists say nothing about the theme you're wearing and must not take it off. A fetch that
 * FAILS never gets here at all — the cache keeps being worn, which is the point of it. And a
 * list carrying `error` is INCOMPLETE: the user folder couldn't be read, so it holds the
 * built-ins alone (§12), and a user theme missing from it is missing for that reason.
 */
export function reconcileTheme(list: ThemeList): void {
  const stored = readStoredTheme();
  if (!stored) return;
  const match = list.themes.find((t) => t.id === stored.id);
  if (!match) {
    if (list.error) return; // the folder, not the theme, is what's gone
    clearTheme();
    setDroppedThemeId(stored.id);
    return;
  }
  if (match.error) {
    clearTheme();
    setDroppedThemeId(stored.id);
    return;
  }
  // Unchanged is the common case, twice a second: don't rewrite 30 properties to say so.
  if (match.base === stored.base && sameTokens(match.tokens, stored.tokens)) return;
  applyTheme({ id: match.id, base: match.base, tokens: match.tokens });
}
