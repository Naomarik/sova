// Run: npx tsx --test src/lib/theme.test.ts (or npm test)
//
// The client theme store, against a hand-built document: what lands on the root element, what
// comes off it, and the three answers the server's list can give about the theme you're wearing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeInfo, ThemeList } from "../../shared/protocol";

/** Just enough DOM for the store: it writes custom properties, one attribute, and one meta tag. */
const style = new Map<string, string>();
const attributes = new Map<string, string>();
const meta = { content: "#1E1E26", setAttribute: (_: string, v: string) => void (meta.content = v) };
const store = new Map<string, string>();

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
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { activeThemeId, applyTheme, clearTheme, droppedThemeId, reconcileTheme, THEME_KEY } = await import("./theme");

const reset = () => {
  style.clear();
  attributes.clear();
  store.clear();
  meta.content = "#1E1E26";
  clearTheme();
};

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
const list = (themes: ThemeInfo[], error?: string): ThemeList => ({ dir: "/home/u/.pi/agent/pi-web/themes", themes, ...(error ? { error } : {}) });

test("applyTheme writes each key onto the property CSS_PROPERTY names, verbatim", () => {
  reset();
  applyTheme({ id: "dracula", base: "dark", tokens: info().tokens });
  assert.equal(style.get("--color-bg"), "#282a36");
  assert.equal(style.get("--color-accent"), "rgb(189, 147, 249)"); // spacing and case as authored
  assert.equal(style.get("--font-body"), '"Inter", sans-serif');
  assert.equal(attributes.get("data-theme"), "dark");
  assert.equal(meta.content, "#282a36");
  assert.equal(activeThemeId(), "dracula");
  assert.deepEqual(JSON.parse(store.get(THEME_KEY)!).id, "dracula");
});

test("applyTheme drops the previous theme's keys: no value outlives the theme that set it", () => {
  reset();
  applyTheme({ id: "a", base: "dark", tokens: { bg: "#000", "font-mono": "Menlo" } });
  applyTheme({ id: "b", base: "light", tokens: { bg: "#fff" } });
  assert.equal(style.get("--color-bg"), "#fff");
  assert.equal(style.has("--font-mono"), false);
  assert.equal(attributes.get("data-theme"), "light");
});

test("clearTheme leaves no attribute at all — that is what renders the default dark", () => {
  reset();
  applyTheme({ id: "dracula", base: "dark", tokens: info().tokens });
  clearTheme();
  assert.equal(style.size, 0);
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(store.has(THEME_KEY), false);
  assert.equal(activeThemeId(), "dark");
  assert.equal(meta.content, "#1E1E26");
});

test("reconcileTheme: an id that no longer resolves falls back to dark and names itself", () => {
  reset();
  applyTheme({ id: "dracula", base: "dark", tokens: info().tokens });
  reconcileTheme(list([info({ id: "light", name: "Light", base: "light" })]));
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(activeThemeId(), "dark");
  assert.equal(droppedThemeId(), "dracula");
});

test("reconcileTheme: a theme that broke since we put it on comes off", () => {
  reset();
  applyTheme({ id: "dracula", base: "dark", tokens: info().tokens });
  reconcileTheme(list([info({ tokens: {}, error: "accent is image-set(…). A color is a hex value, or one call to rgb, …" })]));
  assert.equal(activeThemeId(), "dark");
  assert.equal(droppedThemeId(), "dracula");
});

test("reconcileTheme: an unreadable folder is not evidence a user theme is gone", () => {
  reset();
  applyTheme({ id: "mine", base: "dark", tokens: { bg: "#010203" } });
  reconcileTheme(list([info()], "EACCES: permission denied")); // built-ins only, and it says so
  assert.equal(style.get("--color-bg"), "#010203");
  assert.equal(activeThemeId(), "mine");
  assert.equal(droppedThemeId(), null);
});

test("reconcileTheme: a file edited elsewhere re-applies; an unchanged one touches nothing", () => {
  reset();
  applyTheme({ id: "dracula", base: "dark", tokens: { bg: "#282a36" } });
  style.delete("--color-bg"); // if the store rewrites, this comes back
  reconcileTheme(list([info({ tokens: { bg: "#282a36" } })]));
  assert.equal(style.has("--color-bg"), false, "unchanged tokens must not be rewritten every poll");
  reconcileTheme(list([info({ tokens: { bg: "#111111" } })]));
  assert.equal(style.get("--color-bg"), "#111111");
});
