// Run: npx tsx --test src/lib/spine.test.ts (or npm test)
//
// The collapsed sessions pane, against a hand-built document: the stored choice, the collapsed
// width's fallback, the expanded width it restores, and the recent tiles' monogram.
import assert from "node:assert/strict";
import { test } from "node:test";

/** Just enough DOM: one computed token, the inline style it's written to, and one media query. */
const style = new Map<string, string>();
const store = new Map<string, string>();
let computedSpine = "64px";
let wide = true;

const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as unknown as Storage;

Object.assign(globalThis, {
  document: {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => void style.set(k, v),
        removeProperty: (k: string) => void style.delete(k),
      },
    },
  },
  getComputedStyle: () => ({ getPropertyValue: (k: string) => (k === "--spine-width" ? computedSpine : "") }),
  matchMedia: () => ({ matches: wide }),
  localStorage: storage,
});

const {
  applyStoredSpine,
  FALLBACK_SPINE_WIDTH,
  LEGACY_SPINE_KEY,
  monogram,
  parseSpineWidth,
  readSpine,
  rememberedWidth,
  rememberExpandedWidth,
  setSpine,
  spine,
  SPINE_KEY,
  spineWidth,
  toggleSpine,
} = await import("./spine");
const { DEFAULT_SIDEBAR_WIDTH } = await import("./sidebar-width");

const reset = () => {
  style.clear();
  store.clear();
  computedSpine = "64px";
  wide = true;
};

test("only a stored \"1\" collapses: \"0\", absent and garbage all read as expanded", () => {
  reset();
  assert.equal(readSpine(storage), false);
  store.set(SPINE_KEY, "1");
  assert.equal(readSpine(storage), true);
  store.set(SPINE_KEY, "0");
  assert.equal(readSpine(storage), false);
  store.set(SPINE_KEY, "true");
  assert.equal(readSpine(storage), false);
  store.set(SPINE_KEY, "");
  assert.equal(readSpine(storage), false);
});

test("the legacy key answers only when the new one is absent", () => {
  reset();
  store.set(LEGACY_SPINE_KEY, "1");
  assert.equal(readSpine(storage), true);
  store.set(SPINE_KEY, "0"); // a stored "0" is a real choice and wins
  assert.equal(readSpine(storage), false);
});

test("setting the choice writes BOTH keys, and toggle flips it", () => {
  reset();
  setSpine(true);
  assert.equal(spine(), true);
  assert.equal(store.get(SPINE_KEY), "1");
  assert.equal(store.get(LEGACY_SPINE_KEY), "1");
  toggleSpine();
  assert.equal(spine(), false);
  assert.equal(store.get(SPINE_KEY), "0");
  assert.equal(store.get(LEGACY_SPINE_KEY), "0");
});

test("the collapsed width is the token, or 64 when the token can't be read", () => {
  reset();
  const root = document.documentElement;
  assert.equal(spineWidth(root), 64);
  computedSpine = " 72px";
  assert.equal(spineWidth(root), 72);
  computedSpine = "";
  assert.equal(spineWidth(root), FALLBACK_SPINE_WIDTH);
  assert.equal(parseSpineWidth("var(--nope)"), 64);
  assert.equal(parseSpineWidth("0px"), 64);
  assert.equal(parseSpineWidth("-8px"), 64);
});

test("the expanded width starts at the default and remembers the last write", () => {
  assert.equal(rememberedWidth(), DEFAULT_SIDEBAR_WIDTH);
  rememberExpandedWidth(412);
  assert.equal(rememberedWidth(), 412);
  rememberExpandedWidth(DEFAULT_SIDEBAR_WIDTH);
});

test("the pre-paint call restores the choice and writes the spine width only where it shows", () => {
  reset();
  store.set(SPINE_KEY, "1");
  applyStoredSpine();
  assert.equal(spine(), true);
  assert.equal(style.get("--sidebar-width"), "64px");

  reset();
  store.set(SPINE_KEY, "1");
  wide = false; // below 768px the folded layout owns the pane: no token write
  applyStoredSpine();
  assert.equal(spine(), true);
  assert.equal(style.has("--sidebar-width"), false);

  reset();
  applyStoredSpine();
  assert.equal(spine(), false);
  assert.equal(style.has("--sidebar-width"), false);
});

test("monogram: two words take their initials, uppercased", () => {
  assert.equal(monogram("fix the spine"), "FT");
  assert.equal(monogram("Refactor sidebar"), "RS");
  assert.equal(monogram("  leading and trailing  "), "LA");
  assert.equal(monogram("tabs\tand\nnewlines"), "TA");
});

test("monogram: one word keeps its first two code points, uppercased", () => {
  assert.equal(monogram("Untitled"), "UN");
  assert.equal(monogram("  spaced  "), "SP");
  assert.equal(monogram("x"), "X");
  assert.equal(monogram("🦉owl"), "🦉O");
});

test("monogram: digits count as letters", () => {
  assert.equal(monogram("2026 roadmap"), "2R");
  assert.equal(monogram("42"), "42");
  assert.equal(monogram("v2 migration"), "VM");
});

test("monogram: empty or blank gives nothing, for the icon fallback", () => {
  assert.equal(monogram(""), "");
  assert.equal(monogram("   "), "");
});
