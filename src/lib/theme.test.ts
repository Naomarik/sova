// Run: npx tsx --test src/lib/theme.test.ts (or npm test)
//
// The client theme store, against a hand-built document: what lands on the root element, what
// comes off it, and the answers the server's list can give about each pick.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeInfo, ThemeList } from "../../shared/protocol";

/** Just enough DOM for the store: it writes custom properties, one attribute, and one meta tag. */
const style = new Map<string, string>();
const attributes = new Map<string, string>();
const meta = { content: "unset", setAttribute: (_: string, v: string) => void (meta.content = v) };
const store = new Map<string, string>();
/** Every write to the store, so a test can tell "left alone" from "rewritten with the same value". */
let writes = 0;

/** The system's light/dark setting, as `matchMedia("(prefers-color-scheme: light)")` reports it. */
type Change = (e: { matches: boolean }) => void;
const system = { light: false, listeners: new Set<Change>() };
const setSystem = (light: boolean) => {
  system.light = light;
  for (const l of system.listeners) l({ matches: light });
};

Object.assign(globalThis, {
  document: {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => void style.set(k, v),
        removeProperty: (k: string) => void style.delete(k),
      },
      setAttribute: (k: string, v: string) => void attributes.set(k, v),
      removeAttribute: (k: string) => void attributes.delete(k),
    },
    querySelector: () => meta,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes++;
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  },
  addEventListener: () => {},
  matchMedia: (query: string) => {
    assert.equal(query, "(prefers-color-scheme: light)");
    return {
      media: query,
      get matches() {
        return system.light;
      },
      addEventListener: (_: string, l: Change) => void system.listeners.add(l),
      removeEventListener: (_: string, l: Change) => void system.listeners.delete(l),
    };
  },
});

const {
  activeThemeId,
  applyStoredTheme,
  clearTheme,
  clearTypography,
  darkThemeId,
  droppedTheme,
  lightThemeId,
  pickTheme,
  reconcileTheme,
  setTextSize,
  setThemeMode,
  setTypography,
  textSize,
  THEME_KEY,
  themeMode,
  typography,
} = await import("./theme");
const { TEXT_SIZE_KEY, TYPOGRAPHY_KEY, fontById } = await import("./typography");

const reset = () => {
  style.clear();
  attributes.clear();
  store.clear();
  setSystem(false); // through the listener, so the store's own reading of the system is reset too
  clearTheme();
  meta.content = "unset"; // no expected value, so a paint that skips the meta can't pass
  clearTypography();
  setTextSize("medium");
  store.clear(); // clearTypography persists "nothing" by removing the key; start every test empty
};

const stored = () => JSON.parse(store.get(THEME_KEY)!) as { v: number; mode: string; light: { id: string } | null; dark: { id: string } | null };

const info = (over: Partial<ThemeInfo> = {}): ThemeInfo => ({
  id: "dracula",
  name: "Dracula",
  source: "builtin",
  path: "/app/themes/dracula.json",
  base: "dark",
  tokens: { bg: "#282a36", accent: "rgb(189, 147, 249)", "font-body": '"Inter", sans-serif' },
  warnings: [],
  ...over,
});
const list = (themes: ThemeInfo[], error?: string): ThemeList => ({ dir: "/home/u/.pi/agent/sova/themes", themes, ...(error ? { error } : {}) });
const NORD_LIGHT = { id: "nord-light", base: "light" as const, tokens: { bg: "#eceff4", surface: "#e5e9f0" } };
const DRACULA = { id: "dracula", base: "dark" as const, tokens: info().tokens };

/* ---- Painting the shown pick ------------------------------------------ */

test("a pick in the shown base writes each key onto the property CSS_PROPERTY names, verbatim", () => {
  reset();
  pickTheme(DRACULA);
  assert.equal(style.get("--color-bg"), "#282a36");
  assert.equal(style.get("--color-accent"), "rgb(189, 147, 249)"); // spacing and case as authored
  assert.equal(style.get("--font-body"), '"Inter", sans-serif');
  assert.equal(attributes.get("data-theme"), "dark");
  assert.equal(meta.content, "#2C2C38", "no surface token: the dark base's surface, not its bg");
  assert.equal(activeThemeId(), "dracula");
  assert.deepEqual({ v: stored().v, mode: stored().mode, dark: stored().dark?.id, light: stored().light }, { v: 2, mode: "dark", dark: "dracula", light: null });
});

test("a switch drops the previous theme's keys: no value outlives the theme that set it", () => {
  reset();
  pickTheme({ id: "a", base: "dark", tokens: { bg: "#000", "font-mono": "Menlo" } });
  pickTheme({ id: "b", base: "light", tokens: { bg: "#fff" } });
  setThemeMode("light");
  assert.equal(style.get("--color-bg"), "#fff");
  assert.equal(style.has("--font-mono"), false);
  assert.equal(attributes.get("data-theme"), "light");
});

test("the reset (clearTheme, ?theme=default) removes the record: Dark mode, both built-ins, no attribute", () => {
  reset();
  pickTheme({ ...DRACULA, tokens: { ...DRACULA.tokens, surface: "#44475a" } });
  pickTheme(NORD_LIGHT);
  setThemeMode("auto");
  clearTheme();
  assert.equal(style.size, 0);
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(store.has(THEME_KEY), false);
  assert.equal(themeMode(), "dark");
  assert.equal(activeThemeId(), "dark");
  assert.equal(lightThemeId(), "light");
  assert.equal(darkThemeId(), "dark");
  assert.equal(meta.content, "#2C2C38");
});

test("the chrome color is the theme's surface (the header), verbatim — not its bg", () => {
  reset();
  pickTheme({ id: "tokyo-night-moon", base: "dark", tokens: { bg: "#222436", surface: "rgb(46, 50, 75)" } });
  assert.equal(meta.content, "rgb(46, 50, 75)");
});

test("a light theme with no surface gets the light base's surface; the built-in light writes nothing", () => {
  reset();
  setThemeMode("light");
  assert.equal(attributes.get("data-theme"), "light", "built-in light: tokens.css's light block");
  assert.equal(style.size, 0, "and no inline token at all");
  assert.equal(meta.content, "#FFFFFF");
  pickTheme({ id: "paper", base: "light", tokens: { bg: "#f5f5f0" } });
  assert.equal(meta.content, "#FFFFFF");
  assert.equal(style.get("--color-bg"), "#f5f5f0");
});


test("reconcileTheme: a dark id that no longer resolves falls back to dark and names itself", () => {
  reset();
  pickTheme(DRACULA);
  reconcileTheme(list([info({ id: "light", name: "Light", base: "light" })]));
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(activeThemeId(), "dark");
  assert.deepEqual(droppedTheme(), { id: "dracula", slot: "dark", reason: "gone" });
  assert.equal(stored().dark, null);
});

test("reconcileTheme: a theme that broke since we put it on comes off", () => {
  reset();
  pickTheme(DRACULA);
  reconcileTheme(list([info({ tokens: {}, error: "accent is image-set(…). A color is a hex value, or one call to rgb, …" })]));
  assert.equal(activeThemeId(), "dark");
  assert.deepEqual(droppedTheme(), { id: "dracula", slot: "dark", reason: "broken" });
});


test("reconcileTheme: an unreadable folder is not evidence a user theme is gone, for either pick", () => {
  reset();
  pickTheme({ id: "mine", base: "dark", tokens: { bg: "#010203" } });
  pickTheme({ id: "mine-light", base: "light", tokens: { bg: "#fefefe" } });
  reconcileTheme(list([info()], "EACCES: permission denied")); // built-ins only, and it says so
  assert.equal(style.get("--color-bg"), "#010203");
  assert.equal(activeThemeId(), "mine");
  assert.equal(lightThemeId(), "mine-light");
  assert.equal(droppedTheme(), null);
});

test("reconcileTheme: a file edited elsewhere re-applies; an unchanged one touches nothing", () => {
  reset();
  pickTheme({ id: "dracula", base: "dark", tokens: { bg: "#282a36" } });
  style.delete("--color-bg"); // if the store rewrites, this comes back
  const before = writes; // nor is the record rewritten
  reconcileTheme(list([info({ tokens: { bg: "#282a36" } })]));
  assert.equal(style.has("--color-bg"), false, "unchanged tokens must not be rewritten every poll");
  assert.equal(writes, before);
  reconcileTheme(list([info({ tokens: { bg: "#111111" } })]));
  assert.equal(style.get("--color-bg"), "#111111");
  assert.equal(stored().dark?.id, "dracula");
});

/* ---- Typography over the theme: pick > theme > default -------------- */

const INTER = fontById("text", "inter")!.stack;
const FIRA = fontById("mono", "fira-code")!.stack;

test("a font pick lands on body AND display (text) or mono, and persists under its own key", () => {
  reset();
  setTypography({ text: "inter" });
  assert.equal(style.get("--font-body"), INTER);
  assert.equal(style.get("--font-display"), INTER);
  assert.equal(style.has("--font-mono"), false);
  assert.equal(JSON.parse(store.get(TYPOGRAPHY_KEY)!).text, "inter");
  setTypography({ mono: "fira-code" });
  assert.equal(style.get("--font-mono"), FIRA);
  assert.deepEqual(typography(), { text: "inter", mono: "fira-code" });
});

test("the pick survives a theme switch, and beats a theme that names its own faces", () => {
  reset();
  setTypography({ mono: "fira-code" });
  pickTheme({ id: "a", base: "dark", tokens: { bg: "#000", "font-mono": '"Iosevka", monospace', "font-body": '"Iosevka Aile", sans-serif' } });
  assert.equal(style.get("--font-mono"), FIRA, "the pick is on top of the theme's mono");
  assert.equal(style.get("--font-body"), '"Iosevka Aile", sans-serif', "the kind left on Theme default shows the theme's face");
  pickTheme({ id: "b", base: "light", tokens: { bg: "#fff" } });
  setThemeMode("light");
  assert.equal(style.get("--font-mono"), FIRA, "a theme with no typography leaves the pick alone");
  assert.equal(style.has("--font-body"), false, "and the body goes back to tokens.css");
  clearTheme();
  assert.equal(style.get("--font-mono"), FIRA, "back to built-in dark, still in the picked mono");
  assert.equal(attributes.has("data-theme"), false);
});

test("Theme default for a kind restores the theme's own face — a repaint, not a bare removeProperty", () => {
  reset();
  pickTheme({ id: "a", base: "dark", tokens: { "font-mono": '"Iosevka", monospace' } });
  setTypography({ mono: "source-code-pro" });
  assert.match(style.get("--font-mono")!, /^"Source Code Pro"/);
  setTypography({ mono: null });
  assert.equal(style.get("--font-mono"), '"Iosevka", monospace', "the theme's mono is back");
  assert.equal(store.has(TYPOGRAPHY_KEY), false, "nothing overridden, nothing stored");
});

test("reconcileTheme re-applying an edited theme keeps the pick on top", () => {
  reset();
  setTypography({ text: "noto-sans" });
  pickTheme({ id: "dracula", base: "dark", tokens: { bg: "#282a36" } });
  reconcileTheme(list([info({ tokens: { bg: "#111111", "font-body": '"Other", sans-serif' } })]));
  assert.equal(style.get("--color-bg"), "#111111");
  assert.equal(style.get("--font-body"), fontById("text", "noto-sans")!.stack);
});

test("boot: the stored pick is painted before first paint even with no stored theme", () => {
  reset();
  store.set(TYPOGRAPHY_KEY, JSON.stringify({ text: "ibm-plex-sans", mono: "ibm-plex-mono" }));
  applyStoredTheme();
  assert.match(style.get("--font-body")!, /^"IBM Plex Sans"/);
  assert.match(style.get("--font-mono")!, /^"IBM Plex Mono"/);
  assert.equal(attributes.has("data-theme"), false, "no theme stored: still the built-in dark");
});

test("boot: a stored value that isn't a catalogue id is no pick at all", () => {
  reset();
  store.set(TYPOGRAPHY_KEY, JSON.stringify({ text: '"Comic Sans", url(//evil)', mono: "not-a-font" }));
  applyStoredTheme();
  assert.equal(style.has("--font-body"), false);
  assert.equal(style.has("--font-mono"), false);
  assert.deepEqual(typography(), { text: null, mono: null });
});

test("clearTypography (Use Theme Fonts, ?theme=default) drops both kinds and the key", () => {
  reset();
  pickTheme({ id: "a", base: "dark", tokens: { "font-body": '"Other", sans-serif' } });
  setTypography({ text: "inter", mono: "fira-code" });
  clearTypography();
  assert.equal(style.get("--font-body"), '"Other", sans-serif');
  assert.equal(style.has("--font-mono"), false);
  assert.equal(store.has(TYPOGRAPHY_KEY), false);
  assert.equal(activeThemeId(), "a", "the theme itself is untouched");
});

/* ---- Text size over the theme ----------------------------------------- */

test("Medium writes no size; Small and Large write every --fs-* step and persist under both keys", () => {
  reset();
  assert.equal([...style.keys()].some((k) => k.startsWith("--fs-")), false);
  setTextSize("small");
  assert.equal(style.get("--fs-body"), "13.5px");
  assert.equal(style.get("--fs-micro"), "10.5px");
  assert.equal([...style.keys()].filter((k) => k.startsWith("--fs-")).length, 8);
  assert.equal(store.get(TEXT_SIZE_KEY), "small");
  setTextSize("large");
  assert.equal(style.get("--fs-body"), "15.5px");
  setTextSize("medium");
  assert.equal([...style.keys()].some((k) => k.startsWith("--fs-")), false, "Medium takes every size off");
  assert.equal(store.has(TEXT_SIZE_KEY), false, "and stores nothing");
});

test("a size scales the theme's own px sizes and survives a theme switch", () => {
  reset();
  setTextSize("large");
  pickTheme({ id: "a", base: "dark", tokens: { "fs-body": "16px", "fs-caption": "1em" } });
  assert.equal(style.get("--fs-body"), "17px", "16 × 1.07 = 17.12, to the half pixel");
  assert.equal(style.get("--fs-caption"), "calc(1em * 1.07)");
  assert.equal(style.get("--fs-mono"), "13.5px", "a step the theme leaves alone takes the table");
  pickTheme({ id: "b", base: "light", tokens: {} });
  setThemeMode("light");
  assert.equal(style.get("--fs-body"), "15.5px");
  setTextSize("medium");
  setThemeMode("dark");
  assert.equal(style.get("--fs-body"), "16px", "at Medium the theme's value is verbatim");
});

test("the stored size is painted by the pre-paint call; junk reads as Medium", () => {
  reset();
  store.set(TEXT_SIZE_KEY, "small");
  applyStoredTheme();
  assert.equal(textSize(), "small");
  assert.equal(style.get("--fs-body"), "13.5px");
  store.set(TEXT_SIZE_KEY, "huge");
  applyStoredTheme();
  assert.equal(textSize(), "medium");
  assert.equal(style.has("--fs-body"), false);
});
