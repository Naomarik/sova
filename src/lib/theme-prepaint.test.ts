// Run: pnpm test -- src/lib/theme-prepaint.test.ts
//
// index.html's pre-paint script (theme-prepaint.ts) against a hand-built document: what it puts on the
// root element before the first frame for each stored shape, the reset link that paints nothing, the
// serialised script running with nothing but its own body, and the same answer as the app's own painter
// (theme.ts) for every record, so the two can't drift apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { BASE_SURFACE, COLOR_MAP_KEYS, CSS_PROPERTY, TYPOGRAPHY_KEYS } from "../../shared/theme";

/** Just enough DOM: custom properties, one attribute, one meta tag, a store, the system's setting. */
const page = {
  style: new Map<string, string>(),
  attributes: new Map<string, string>(),
  meta: "#2C2C38",
  store: new Map<string, string>(),
  search: "",
  systemLight: false,
  storeThrows: false,
};
const globals = {
  location: {
    get search() {
      return page.search;
    },
  },
  URLSearchParams,
  localStorage: {
    getItem: (k: string) => {
      if (page.storeThrows) throw new Error("SecurityError: the store is blocked");
      return page.store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => void page.store.set(k, v),
    removeItem: (k: string) => void page.store.delete(k),
  },
  matchMedia: (query: string) => ({
    media: query,
    get matches() {
      return query === "(prefers-color-scheme: light)" && page.systemLight;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  document: {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => void page.style.set(k, String(v)),
        removeProperty: (k: string) => void page.style.delete(k),
      },
      setAttribute: (k: string, v: string) => void page.attributes.set(k, v),
      removeAttribute: (k: string) => void page.attributes.delete(k),
    },
    querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? { setAttribute: (_: string, v: string) => void (page.meta = v) } : null),
  },
};
Object.assign(globalThis, globals);

const { prepaintScript, prepaintTheme, THEME_KEY } = await import("./theme-prepaint");
const { applyStoredTheme } = await import("./theme");

/** A fresh page: index.html as it ships, the given record stored, the given system and address. */
const fresh = (o: { record?: unknown; raw?: string; systemLight?: boolean; search?: string } = {}) => {
  page.style.clear();
  page.attributes.clear();
  page.meta = "#2C2C38";
  page.store.clear();
  page.storeThrows = false;
  page.systemLight = o.systemLight ?? false;
  page.search = o.search ?? "";
  if (o.raw !== undefined) page.store.set(THEME_KEY, o.raw);
  else if (o.record !== undefined) page.store.set(THEME_KEY, JSON.stringify(o.record));
};
const prepaint = () => prepaintTheme(CSS_PROPERTY, BASE_SURFACE, THEME_KEY);
const painted = () => ({ theme: page.attributes.get("data-theme") ?? null, meta: page.meta, style: Object.fromEntries([...page.style].sort()) });

const DRACULA = { id: "dracula", base: "dark", tokens: { bg: "#282a36", surface: "#343746", accent: "rgb(189, 147, 249)" } };
const NORD_LIGHT = { id: "nord-light", base: "light", tokens: { bg: "#eceff4", surface: "#e5e9f0", "font-body": '"Inter", sans-serif' } };
const BLACK = { id: "all-black", base: "dark", tokens: Object.fromEntries(["bg", "surface", "ink", "accent"].map((k) => [k, "#000000"])) };

test("Auto on a light system: the light pick, its tokens verbatim and its surface on the bar", () => {
  fresh({ record: { v: 2, mode: "auto", light: NORD_LIGHT, dark: DRACULA }, systemLight: true });
  prepaint();
  assert.deepEqual(painted(), { theme: "light", meta: "#e5e9f0", style: { "--color-bg": "#eceff4", "--color-surface": "#e5e9f0", "--font-body": '"Inter", sans-serif' } });
  fresh({ record: { v: 2, mode: "auto", light: NORD_LIGHT, dark: DRACULA }, systemLight: false });
  prepaint();
  assert.equal(painted().theme, "dark", "and the dark pick on a dark system");
  assert.equal(page.style.get("--color-accent"), "rgb(189, 147, 249)", "spacing as authored");
});

test("the built-ins: Dark is no attribute and the shipped bar color, Light is the attribute and white", () => {
  fresh({ record: { v: 2, mode: "dark", light: NORD_LIGHT, dark: null } });
  prepaint();
  assert.deepEqual(painted(), { theme: null, meta: "#2C2C38", style: {} });
  fresh({ record: { v: 2, mode: "light", light: null, dark: DRACULA } });
  prepaint();
  assert.deepEqual(painted(), { theme: "light", meta: "#FFFFFF", style: {} });
});

test("nothing stored, a blocked store, junk or a newer shape leave the default Dark untouched", () => {
  for (const o of [{}, { raw: "{not json" }, { raw: "null" }, { record: { v: 3, mode: "light" } }, { record: { mode: "light" } }, { record: "light" }]) {
    fresh(o);
    prepaint();
    assert.deepEqual(painted(), { theme: null, meta: "#2C2C38", style: {} }, JSON.stringify(o));
  }
  fresh({ record: { v: 2, mode: "light", light: NORD_LIGHT, dark: null } });
  page.storeThrows = true;
  prepaint();
  assert.deepEqual(painted(), { theme: null, meta: "#2C2C38", style: {} });
});

test("the single theme stored before there were two picks paints its base", () => {
  fresh({ record: NORD_LIGHT });
  prepaint();
  assert.equal(painted().theme, "light");
  assert.equal(page.meta, "#e5e9f0");
  fresh({ record: { id: "", base: "light", tokens: {} } });
  prepaint();
  assert.equal(painted().theme, null, "an empty id is no pick");
});

test("a pick standing on the other base is no pick; a key the table doesn't name is never written", () => {
  fresh({ record: { v: 2, mode: "light", light: DRACULA, dark: null } });
  prepaint();
  assert.deepEqual(painted(), { theme: "light", meta: "#FFFFFF", style: {} });
  fresh({ record: { v: 2, mode: "dark", light: null, dark: { id: "x", base: "dark", tokens: { bg: "#111111", "not-a-key": "1px", constructor: "#222222", "--color-ink": "#333333" } } } });
  prepaint();
  assert.deepEqual(painted().style, { "--color-bg": "#111111" });
});

test("the reset link paints nothing: an unreadable cached dark pick stays off the page", () => {
  for (const search of ["?theme=default", "?theme=dark", "?x=1&theme=default"]) {
    fresh({ record: { v: 2, mode: "dark", light: null, dark: BLACK }, search });
    prepaint();
    assert.deepEqual(painted(), { theme: null, meta: "#2C2C38", style: {} }, search);
  }
  fresh({ record: { v: 2, mode: "dark", light: null, dark: BLACK }, search: "?theme=light" });
  prepaint();
  assert.equal(page.style.get("--color-bg"), "#000000", "any other value is no reset (main.tsx ignores it too)");
});

/** The arguments the script was serialised with, read back from behind its `args` comment. */
const argsOf = (script: string): unknown[] => {
  const at = script.indexOf("/*args*/");
  assert.ok(at > 0, "the script marks its arguments");
  return JSON.parse(`[${script.slice(at + "/*args*/".length).replace(/\);?\s*$/, "")}]`) as unknown[];
};

test("the serialised script carries the app's own table and surfaces, and runs with nothing but its own body", () => {
  const script = prepaintScript();
  assert.deepEqual(argsOf(script), [{ ...CSS_PROPERTY }, { ...BASE_SURFACE }, THEME_KEY]);
  // A fresh context has no module scope and no imports: only the page globals a browser gives it.
  const auto = { record: { v: 2, mode: "auto", light: NORD_LIGHT, dark: DRACULA }, systemLight: true };
  fresh(auto);
  runInNewContext(script, { ...globals });
  const viaScript = painted();
  fresh(auto);
  prepaint();
  assert.equal(viaScript.theme, "light", "the script painted (a missing global would have been swallowed)");
  assert.deepEqual(viaScript, painted());
});

test("every key the theme grammar allows lands on the property CSS_PROPERTY names", () => {
  const keys = [...COLOR_MAP_KEYS, ...TYPOGRAPHY_KEYS];
  fresh({ record: { v: 2, mode: "dark", light: null, dark: { id: "every", base: "dark", tokens: Object.fromEntries(keys.map((k) => [k, `v:${k}`])) } } });
  prepaint();
  const landed = Object.fromEntries([...page.style].map(([property, value]) => [value.slice(2), property]));
  assert.deepEqual(landed, { ...CSS_PROPERTY });
});

test("index.html carries no copy of the table: the script is injected at build time (vite.config.ts)", () => {
  const html = readFileSync(join(import.meta.dirname, "../../index.html"), "utf8");
  assert.doesNotMatch(html, /--color-|prepaintTheme|sova:theme/);
  assert.match(html, /<meta name="theme-color"[^>]*>/, "the meta the injection follows is there");
});

/* ---- The same answer as the app's own painter ---------------------------- */

const RECORDS: { name: string; raw?: string; record?: unknown; systemLight?: boolean }[] = [
  { name: "nothing stored" },
  { name: "Auto, light system", record: { v: 2, mode: "auto", light: NORD_LIGHT, dark: DRACULA }, systemLight: true },
  { name: "Auto, dark system", record: { v: 2, mode: "auto", light: NORD_LIGHT, dark: DRACULA } },
  { name: "Auto, light system, built-in light", record: { v: 2, mode: "auto", light: null, dark: DRACULA }, systemLight: true },
  { name: "Dark pick", record: { v: 2, mode: "dark", light: null, dark: DRACULA }, systemLight: true },
  { name: "Dark built-in", record: { v: 2, mode: "dark", light: NORD_LIGHT, dark: null } },
  { name: "Light pick", record: { v: 2, mode: "light", light: NORD_LIGHT, dark: null } },
  { name: "Light built-in", record: { v: 2, mode: "light", light: null, dark: DRACULA } },
  { name: "unknown mode", record: { v: 2, mode: "sepia", light: NORD_LIGHT, dark: DRACULA } },
  { name: "picks on the wrong base", record: { v: 2, mode: "light", light: DRACULA, dark: NORD_LIGHT } },
  { name: "a pick with no tokens", record: { v: 2, mode: "dark", light: null, dark: { id: "bare", base: "dark" } } },
  { name: "old single light theme", record: NORD_LIGHT },
  { name: "old single dark theme", record: DRACULA },
  { name: "old shape, no base", record: { id: "x", tokens: { bg: "#010101" } } },
  { name: "junk", raw: "{not json" },
  { name: "a newer shape", record: { v: 3, mode: "light" } },
];

test("for every stored shape the pre-paint script paints exactly what the app's startup paints", () => {
  for (const r of RECORDS) {
    fresh(r);
    prepaint();
    const before = painted();
    fresh(r);
    applyStoredTheme();
    assert.deepEqual(before, painted(), r.name);
  }
});
