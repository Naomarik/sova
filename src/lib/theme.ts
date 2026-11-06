/**
 * The client half of theming: the mode (Light, Dark or Auto), one pick per base, the theme the
 * window is wearing because of them, and the calls that change any of it.
 *
 * The server did the reading, the `$name` resolution and the validation (`shared/theme.ts`), so
 * everything here is already safe to paint. This module adds nothing to that judgement: a value
 * lands on its custom property VERBATIM — never parsed, normalized, or re-serialized — and the
 * key→property table is imported, never re-derived.
 *
 * The choice is the mode and the two ids, and it lives in `localStorage` alone. There is no server
 * write endpoint for it and there must never be one: a theme is this browser's, not the machine's.
 * The cache carries each pick's resolved tokens alongside its id for one reason — the ground rules
 * require the theme to be applied BEFORE first paint, and a fetch can't be.
 */

import { createSignal } from "solid-js";
import type { ThemeList, ThemeTokens } from "../../shared/protocol";
import { CSS_PROPERTY, DEFAULT_THEME_ID, type ThemeBase } from "../../shared/theme";
import {
  DEFAULT_TEXT_SIZE,
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
import { readKey, removeKey, writeKey } from "./storage-keys";

/** The ground rules: the choice persists here. */
export const THEME_KEY = "sova:theme";

/** One pick, as kept so the next load can paint it with no network. The id is the choice — the
    tokens are a cache of what the server said it resolved to, re-checked against the list on
    every boot (App.tsx) and dropped when the theme is gone or broken. */
export interface StoredTheme {
  id: string;
  base: ThemeBase;
  tokens: ThemeTokens;
}

/** Light and Dark wear that base's pick; Auto wears the one the system's light/dark setting asks for. */
export type ThemeMode = "light" | "dark" | "auto";

/** What a browser with nothing stored starts in: Dark, the dark-by-default rule. */
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

/** The record under `THEME_KEY`. A null pick is that base's built-in: for dark, no attribute and
    nothing written; for light, `data-theme="light"` and nothing written — `tokens.css` alone, which
    `light.json` reproduces value for value, so neither needs the list. A record without `v` is
    the single theme stored before there were two picks (`readStoredThemes`). */
interface StoredThemes {
  v: 2;
  mode: ThemeMode;
  light: StoredTheme | null;
  dark: StoredTheme | null;
}

const [themeMode, setThemeModeSignal] = createSignal<ThemeMode>(DEFAULT_THEME_MODE);
export { themeMode };

const [lightPick, setLightPick] = createSignal<StoredTheme | null>(null);
const [darkPick, setDarkPick] = createSignal<StoredTheme | null>(null);
const pickOf = (base: ThemeBase) => (base === "light" ? lightPick() : darkPick());

/** The id each section shows checked: the pick, or its base's built-in when there is none. */
export const lightThemeId = (): string => lightPick()?.id ?? "light";
export const darkThemeId = (): string => darkPick()?.id ?? DEFAULT_THEME_ID;

/** The system's light/dark setting, as `prefers-color-scheme: light` answers it: no preference
    reads as dark, the same rule as the share build (`src/share/theme.ts`). */
const [systemLight, setSystemLight] = createSignal(false);

/** The base the window is wearing: the mode, or under Auto the system's setting. */
export const shownBase = (): ThemeBase => {
  const mode = themeMode();
  return mode === "auto" ? (systemLight() ? "light" : "dark") : mode;
};

/** The id of the theme the window is wearing: the shown base's pick. */
export const activeThemeId = (): string => (shownBase() === "light" ? lightThemeId() : darkThemeId());

/** A pick we had to take off — the file was deleted, renamed, or broke since the cache was
    written — and the base whose section went back to its built-in. The copy deck's banner names
    it in the Themes panel, and a new pick in that section clears it: the notice is about the
    theme you lost, not the one you have. */
const [droppedTheme, setDroppedTheme] = createSignal<{ id: string; slot: ThemeBase } | null>(null);
export { droppedTheme };

/** Every property a theme can write — what `clearTheme` removes, so no key of the previous
    theme outlives it. `removeProperty` on one that was never set is a no-op. */
const ALL_PROPERTIES = Object.values(CSS_PROPERTY);

/**
 * The Typography choice (`typography.ts` for the catalogue): the faces this
 * browser puts OVER whatever theme it wears. It is painted here, after the theme's tokens, on
 * every apply and clear — that ordering is the precedence rule (pick > theme > default), and it
 * has to live in the one function that writes the properties, or a theme switch would take a
 * font pick off with the previous theme's keys.
 */
const [typography, setTypographySignal] = createSignal<Typography>(NO_TYPOGRAPHY);
export { typography };

/** The Text size choice: the same painter, the same precedence — written
    after the theme, so a Small or Large scales whatever sizes the theme set. */
const [textSize, setTextSizeSignal] = createSignal<TextSize>(DEFAULT_TEXT_SIZE);
export { textSize };

/** The stored choice, validated against the catalogue (an id that names nothing is no choice). */
export function readStoredTypography(): Typography {
  try {
    return parseTypography(readKey(localStorage, TYPOGRAPHY_KEY));
  } catch {
    return NO_TYPOGRAPHY;
  }
}

function writeStoredTypography(t: Typography): void {
  try {
    const raw = serializeTypography(t);
    if (raw === null) removeKey(localStorage, TYPOGRAPHY_KEY);
    else writeKey(localStorage, TYPOGRAPHY_KEY, raw);
  } catch {
    // Persistence is a convenience; the faces still hold for this page.
  }
}

export function readStoredTextSize(): TextSize {
  try {
    return parseTextSize(readKey(localStorage, TEXT_SIZE_KEY));
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

function writeStoredTextSize(size: TextSize): void {
  try {
    const raw = serializeTextSize(size);
    if (raw === null) removeKey(localStorage, TEXT_SIZE_KEY);
    else writeKey(localStorage, TEXT_SIZE_KEY, raw);
  } catch {
    // Persistence is a convenience; the size still holds for this page.
  }
}

/** The one painter, always for the shown base and its pick: every switch — a mode, a pick, the
    system's setting, a reconcile, a font or a size — comes through here. Theme tokens first, then
    the font pick on top: a kind left on Theme default writes nothing, so the theme's own face (or
    tokens.css's) is what stays. The text size goes after — Medium writes nothing, and the clear
    above takes a previous Small or Large off, since every `--fs-*` is a theme property too. The
    chrome color goes last, so the bar follows every switch the page does. */
function paint(): void {
  watchSystem();
  followOtherTabs();
  const base = shownBase();
  const theme = pickOf(base);
  const tokens = theme?.tokens ?? {};
  const root = document.documentElement;
  // Clear first: the theme being taken off may have set a key this one doesn't, and a leftover
  // would be a value from a theme nobody is wearing.
  for (const property of ALL_PROPERTIES) root.style.removeProperty(property);
  for (const [key, value] of Object.entries(tokens)) {
    const property = CSS_PROPERTY[key];
    if (property) root.style.setProperty(property, value); // verbatim, as authored
  }
  // No attribute is the built-in dark; a dark pick still says `dark`, as it always has.
  if (base === "dark" && !theme) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", base);
  for (const [property, value] of Object.entries(typographyProperties(typography()))) root.style.setProperty(property, value);
  for (const [property, value] of Object.entries(textSizeProperties(textSize(), tokens))) root.style.setProperty(property, value);
  setMetaThemeColor(tokens.surface ?? BASE_SURFACE[base]);
}

/** The system's setting, watched from the first paint on: under Auto a change repaints at once,
    with no reload; in Light or Dark it only keeps `systemLight` current for a later switch to
    Auto. Guarded, because a document without `matchMedia` (the unit tests') has no system. */
let systemQuery: MediaQueryList | null = null;
function watchSystem(): void {
  if (systemQuery || typeof matchMedia !== "function") return;
  systemQuery = matchMedia("(prefers-color-scheme: light)");
  setSystemLight(systemQuery.matches);
  systemQuery.addEventListener("change", (e) => {
    setSystemLight(e.matches);
    if (themeMode() === "auto") paint();
  });
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
  paint();
  return next;
}

/** Small, Medium or Large. Applies immediately and persists; Medium removes the key. Called from
    Settings → Themes → Typography. */
export function setTextSize(size: TextSize): void {
  setTextSizeSignal(size);
  writeStoredTextSize(size);
  paint();
}

/** Use Theme Fonts, and the `?theme=default` escape hatch: no pick at all, key removed. */
export function clearTypography(): void {
  setTypography({ text: null, mono: null });
}

/** Each base's `--color-surface` as tokens.css defines it — the chrome color for a theme that
    doesn't set `surface`. `dark`'s is also what index.html ships and what no theme goes back to. */
const BASE_SURFACE: Record<ThemeBase, string> = { dark: "#2C2C38", light: "#FFFFFF" };

/** The browser chrome color (the Android status bar), matched to the header's surface so the
    bar and the head under it read as one band. */
function setMetaThemeColor(value: string): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && value) meta.setAttribute("content", value);
}

/** One stored pick, validated as the single theme always was: a non-empty id, a base, a token
    map. A pick standing on the other base is no pick (each section lists its own base only). */
function readPick(value: unknown, slot: ThemeBase): StoredTheme | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<StoredTheme>;
  if (typeof parsed.id !== "string" || !parsed.id) return null;
  const base: ThemeBase = parsed.base === "light" ? "light" : "dark";
  if (base !== slot) return null;
  const tokens = parsed.tokens && typeof parsed.tokens === "object" ? (parsed.tokens as ThemeTokens) : {};
  return { id: parsed.id, base, tokens };
}

const EMPTY: StoredThemes = { v: 2, mode: DEFAULT_THEME_MODE, light: null, dark: null };

/**
 * The stored choice. Nothing stored, a blocked store or a record that isn't ours reads as the
 * starting setup: Dark, both built-ins. A single theme stored before there were two picks (an
 * `id`, no `v`) keeps its look: it becomes its base's pick, the other the built-in, and the mode
 * that base; `migrated` says the record still needs writing back in the new shape.
 */
function readStoredThemes(): { record: StoredThemes; migrated: boolean } {
  try {
    const raw = readKey(localStorage, THEME_KEY);
    if (!raw) return { record: EMPTY, migrated: false };
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return { record: EMPTY, migrated: false };
    if (parsed.v === undefined && "id" in parsed) {
      const base: ThemeBase = parsed.base === "light" ? "light" : "dark";
      const pick = readPick(parsed, base);
      if (!pick) return { record: EMPTY, migrated: false };
      return { record: { ...EMPTY, mode: base, [base]: pick }, migrated: true };
    }
    if (parsed.v !== 2) return { record: EMPTY, migrated: false };
    const mode: ThemeMode = parsed.mode === "light" || parsed.mode === "auto" || parsed.mode === "dark" ? parsed.mode : DEFAULT_THEME_MODE;
    return { record: { v: 2, mode, light: readPick(parsed.light, "light"), dark: readPick(parsed.dark, "dark") }, migrated: false };
  } catch {
    // A blocked, full or hand-edited localStorage means the default theme, never a broken boot.
    return { record: EMPTY, migrated: false };
  }
}

/** Every save re-reads the stored record and changes only its own part: another tab open on the same
    browser shares the record, and a write of this tab's whole memory would erase what that tab chose
    since (its storage event may not have arrived yet). */
function saveThemes(change: (record: StoredThemes) => StoredThemes): void {
  const record = change(readStoredThemes().record);
  try {
    writeKey(localStorage, THEME_KEY, JSON.stringify(record));
  } catch {
    // Persistence is a convenience; the choice still holds for this page.
  }
}

const withPick = (record: StoredThemes, slot: ThemeBase, theme: StoredTheme | null): StoredThemes =>
  slot === "light" ? { ...record, light: theme } : { ...record, dark: theme };

function setPick(slot: ThemeBase, theme: StoredTheme | null): void {
  if (slot === "light") setLightPick(theme);
  else setDarkPick(theme);
}

/** Another tab's save, followed at once: its mode and picks become this tab's, and the window repaints,
    with no reload. A cleared store (key null) reads as the starting setup, as a reload would. Installed
    once, from the first paint on; guarded, because the unit tests' document has no window events. */
let followingTabs = false;
function followOtherTabs(): void {
  if (followingTabs || typeof addEventListener !== "function") return;
  followingTabs = true;
  addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    const { record } = readStoredThemes();
    setThemeModeSignal(record.mode);
    setLightPick(record.light);
    setDarkPick(record.dark);
    const dropped = droppedTheme();
    if (dropped && pickOf(dropped.slot)) setDroppedTheme(null); // that list has a pick again
    paint();
  });
}

/** Light, Dark or Auto: persists, and repaints whatever that mode shows. Settings → Themes → Appearance. */
export function setThemeMode(mode: ThemeMode): void {
  setThemeModeSignal(mode);
  saveThemes((record) => ({ ...record, mode }));
  paint();
}

/**
 * Make `theme` its base's pick and persist it. The window changes only when that base is the one
 * showing: a pick in the other section waits there until its base shows. Called on every card
 * a person checks, so it clears that section's fallback notice.
 */
export function pickTheme(theme: StoredTheme): void {
  setPick(theme.base, theme);
  if (droppedTheme()?.slot === theme.base) setDroppedTheme(null);
  saveThemes((record) => withPick(record, theme.base, theme));
  if (theme.base === shownBase()) paint();
}

/** Back to the starting setup, the `?theme=default` reset: the record removed, so Dark mode with
    both built-ins, every written property off and no `data-theme` attribute at all. */
export function clearTheme(): void {
  setThemeModeSignal(DEFAULT_THEME_MODE);
  setLightPick(null);
  setDarkPick(null);
  setDroppedTheme(null);
  try {
    removeKey(localStorage, THEME_KEY);
  } catch {
    // Nothing stored that we could reach; the page is back on the default either way.
  }
  paint();
}

/** The pre-paint call (`main.tsx`): apply the cached choice synchronously — under Auto with the
    system's setting read in the same step — or leave the document on its default dark. Nothing is
    fetched here — a flash of the other theme is exactly what the ground rules forbid, and a
    reconcile against the server happens after boot (App.tsx). */
export function applyStoredTheme(): void {
  setTypographySignal(readStoredTypography());
  setTextSizeSignal(readStoredTextSize());
  const { record, migrated } = readStoredThemes();
  setThemeModeSignal(record.mode);
  setLightPick(record.light);
  setDarkPick(record.dark);
  setDroppedTheme(null);
  if (migrated) saveThemes((stored) => stored); // read again, as every save does: written back in the v2 shape
  if (systemQuery) setSystemLight(systemQuery.matches);
  paint(); // with no theme too: the font pick and text size still have to be on before first paint
}

/** Two token maps hold the same values — the poll's answer against what we're wearing. */
function sameTokens(a: ThemeTokens, b: ThemeTokens): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * Each pick against the server's list: once at boot (App.tsx), and on every poll while the
 * Themes tab is open. A pick whose id no longer resolves — or resolves to a theme we can't wear,
 * or to one that now stands on the other base — goes back to its own base's built-in, and the
 * banner says which id went and where. Only that pick: the other base's stays. The fallback is a
 * null pick, never a lookup of `light` or `dark` in the list, because a user file may hold that
 * id and be the broken one. A pick still there whose file changed is re-cached, and repainted
 * when it is the one showing, so an edit saved in another window shows up where the list does.
 * A built-in (null) pick isn't checked: like the single theme before it, a user file that takes
 * the id `light` or `dark` applies only once it is picked.
 *
 * Two lists say nothing about the picks and must not take one off. A fetch that FAILS never gets
 * here at all — the cache keeps being worn, which is the point of it. And a list carrying `error`
 * is INCOMPLETE: the user folder couldn't be read, so it holds the built-ins alone, and a user
 * theme missing from it is missing for that reason.
 */
export function reconcileTheme(list: ThemeList): void {
  let repaint = false;
  for (const slot of ["light", "dark"] as const) {
    const pick = pickOf(slot);
    if (!pick) continue;
    const match = list.themes.find((t) => t.id === pick.id);
    if (!match && list.error) continue; // the folder, not the theme, is what's gone
    let next: StoredTheme | null;
    if (!match || match.error || match.base !== slot) {
      next = null;
      setDroppedTheme({ id: pick.id, slot });
    } else if (sameTokens(match.tokens, pick.tokens)) {
      continue; // unchanged is the common case, twice a second: don't rewrite 30 properties to say so
    } else {
      next = { id: match.id, base: slot, tokens: match.tokens };
    }
    setPick(slot, next);
    // This list's pick only, and only while the stored one is still the pick checked here: a newer pick
    // another tab saved wins, and its storage event brings it here.
    saveThemes((record) => (record[slot]?.id === pick.id ? withPick(record, slot, next) : record));
    if (slot === shownBase()) repaint = true;
  }
  if (repaint) paint();
}
