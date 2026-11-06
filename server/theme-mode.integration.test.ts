// Light, Dark and Auto in a real Chrome (§app.settings-dialog/themes): what the page wears before the app's own code runs
// (its entry module held back) is the stored theme, painted by index.html's pre-paint script, and the reset link paints
// nothing there; Auto follows the system to dark with no reload, the browser bar's colour with it; Settings → Themes holds
// Appearance and two sections, a pick in the hidden one changes nothing on screen, and arrows stay inside a section;
// the explanation thumbnails follow a live switch. The app's own build, served from a scratch build with every request
// answered here (no server, no network). Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { createServer } from "vite";
import type { ExplanationInfo, ThemeInfo } from "../shared/protocol";
import { BASE_SURFACE, CSS_PROPERTY } from "../shared/theme";
import { THEME_KEY } from "../src/lib/theme-prepaint";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  dist = process.env.SOVA_THEME_UI_DIST || join(scratchRoot("sova-theme-ui-"), "dist");
  if (!process.env.SOVA_THEME_UI_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const theme = (id: string, name: string, base: "dark" | "light", tokens: Record<string, string>): ThemeInfo => ({ id, name, base, tokens, source: "builtin", path: `/app/themes/${id}.json`, warnings: [] });
const THEMES: ThemeInfo[] = [
  theme("dark", "Dark", "dark", {}),
  theme("dracula", "Dracula", "dark", { bg: "#282a36", surface: "#343746" }),
  theme("nord-frost", "Nord Frost", "dark", { bg: "#2e3440", surface: "#3b4252" }),
  theme("tokyo-night", "Tokyo Night", "dark", { bg: "#1a1b26", surface: "#24283b" }),
  theme("light", "Light", "light", {}),
  theme("catppuccin-latte", "Catppuccin Latte", "light", { bg: "#eff1f5", surface: "#e6e9ef" }),
  theme("nord-light", "Nord Light", "light", { bg: "#eceff4", surface: "#e5e9f0" }),
];
const stored = (id: string) => {
  const t = THEMES.find((x) => x.id === id)!;
  return { id: t.id, base: t.base, tokens: t.tokens };
};
const EXPLAINED: ExplanationInfo[] = [
  { id: "ex1", topic: "How themes reach the page", summary: "The mode picks a theme.", createdAt: new Date().toISOString(), parentSessionId: "s1" },
  { id: "ex2", topic: "Where the picks are kept", summary: "In this browser.", createdAt: new Date().toISOString(), parentSessionId: "s1" },
];

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Opened {
  page: Page;
  ctx: BrowserContext;
  /** Lets the held entry module through (a no-op when nothing was held). */
  release(): void;
}

/** The built page's entry module: what `main.tsx` became. Held back, the page shows only what index.html itself painted. */
const entryModule = () => {
  const src = /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(readFileSync(join(dist, "index.html"), "utf8"))?.[1];
  assert.ok(src, "the built index.html loads one entry module");
  return new URL(src, ORIGIN).pathname;
};

async function open(o: { scheme: "light" | "dark"; record?: unknown; hash?: string; search?: string; width?: number; hold?: boolean; themes?: ThemeInfo[] }): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: 1000 }, reducedMotion: "reduce", colorScheme: o.scheme });
  if (o.record !== undefined) await ctx.addInitScript((r) => localStorage.setItem("sova:theme", JSON.stringify(r)), o.record);
  await ctx.addInitScript(() => sessionStorage.setItem("sova:launched", "1"));
  const page = await ctx.newPage();
  const entry = entryModule();
  let release = () => {};
  const held = o.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  // On the context, so a second tab in it (the same store) is answered the same way.
  await ctx.routeWebSocket(/.*/, () => {});
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/themes") return route.fulfill(json({ dir: "/t", themes: o.themes ?? THEMES }));
    if (p === "/api/explanations") return route.fulfill(json(EXPLAINED));
    if (p === "/api/sessions" || p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p.startsWith("/explain/")) return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title>" });
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    if (p === entry) await held;
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  // Held, the page never loads: wait only for the document to arrive.
  await page.goto(`${ORIGIN}/${o.search ?? ""}${o.hash ?? ""}`, { waitUntil: o.hold ? "commit" : "load" });
  return { page, ctx, release };
}

interface Painted {
  theme: string | null;
  meta: string | null;
  background: string;
  inline: string[];
}

/** What the page wears while its entry module is held: the body parsed and the stylesheet applied, the app not run. */
async function paintedBeforeApp(page: Page): Promise<Painted> {
  await page.waitForFunction(() => !!document.getElementById("root") && [...document.styleSheets].some((s) => s.href?.includes("/assets/")));
  return page.evaluate(() => {
    if (document.getElementById("root")!.childElementCount > 0) throw new Error("the app ran: the entry module wasn't held");
    const root = document.documentElement;
    return {
      theme: root.dataset.theme ?? null,
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
      background: getComputedStyle(document.body).backgroundColor,
      inline: [...root.style].filter((p) => p.startsWith("--")),
    };
  });
}

/** The app is up: its shell drew into #root. */
const appRan = (page: Page) => page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);

/** tokens.css's own page colours, as Chrome computes them. */
const BUILTIN_DARK_BG = "rgb(30, 30, 38)";

/** The table and surfaces injected into an index.html, read back from behind the script's `args` comment. */
function injectedArgs(html: string): unknown[] {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).filter((s) => s.includes("/*args*/"));
  assert.equal(scripts.length, 1, "one pre-paint script");
  const at = html.indexOf('<meta name="theme-color"');
  assert.ok(at >= 0 && html.indexOf(scripts[0]!) > at, "it comes after the theme-color meta it sets");
  assert.ok(html.indexOf(scripts[0]!) < html.indexOf("</head>"), "in the head");
  const args = scripts[0]!.slice(scripts[0]!.indexOf("/*args*/") + "/*args*/".length).replace(/\);?\s*$/, "");
  return JSON.parse(`[${args}]`) as unknown[];
}

const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
const metaColor = (page: Page) => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null);
const record = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("sova:theme") ?? "null") as { v: number; mode: string; light: { id: string } | null; dark: { id: string } | null } | null);
const AUTO = { v: 2, mode: "auto", light: stored("nord-light"), dark: stored("dracula") };

describe("Light, Dark and Auto", () => {
  test("Auto on a light system wears the light pick before the app runs, then follows the system to dark with no reload", async () => {
    const o = await open({ scheme: "light", record: AUTO, hold: true });
    try {
      const first = await paintedBeforeApp(o.page);
      assert.deepEqual(
        { theme: first.theme, meta: first.meta, background: first.background },
        { theme: "light", meta: "#e5e9f0", background: "rgb(236, 239, 244)" },
        "the light pick, its page colour and its surface are on before any of the app's code",
      );
      o.release();
      await appRan(o.page);
      assert.equal(await dataTheme(o.page), "light", "the app takes over the same theme");
      assert.equal(await o.page.evaluate(() => document.documentElement.style.getPropertyValue("--color-bg")), "#eceff4");
      await o.page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));
      await o.page.emulateMedia({ colorScheme: "dark" });
      await o.page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      assert.equal(await metaColor(o.page), "#343746", "the browser bar follows");
      assert.equal(await o.page.evaluate(() => document.documentElement.style.getPropertyValue("--color-bg")), "#282a36");
      assert.equal(await o.page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument), true, "no reload");
      await o.page.emulateMedia({ colorScheme: "light" });
      await o.page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    } finally {
      o.release();
      await o.ctx.close();
    }
  });

  test("nothing stored is Dark on a light system; an old single theme keeps its look and is rewritten as v2", async () => {
    const fresh = await open({ scheme: "light", hold: true });
    try {
      assert.deepEqual(await paintedBeforeApp(fresh.page), { theme: null, meta: "#2C2C38", background: BUILTIN_DARK_BG, inline: [] });
    } finally {
      fresh.release();
      await fresh.ctx.close();
    }
    // The old shape is the single pick itself, as server/needs-you-rows-ui.integration.test.ts still writes it.
    const old = await open({ scheme: "dark", record: stored("nord-light"), hold: true });
    try {
      const first = await paintedBeforeApp(old.page);
      assert.deepEqual({ theme: first.theme, meta: first.meta }, { theme: "light", meta: "#e5e9f0" }, "a light theme stored the old way still wears light on a dark system");
      old.release();
      await appRan(old.page);
      await old.page.waitForFunction(() => JSON.parse(localStorage.getItem("sova:theme") ?? "{}").v === 2);
      const r = await record(old.page);
      assert.equal(r?.v, 2);
      assert.equal(r?.mode, "light");
      assert.equal(r?.light?.id, "nord-light");
      assert.equal(r?.dark, null);
    } finally {
      old.release();
      await old.ctx.close();
    }
  });

  test("the reset link paints nothing before the reset: an all-black dark pick never reaches the page", async () => {
    const black = { id: "all-black", base: "dark", tokens: Object.fromEntries(["bg", "surface", "ink", "ink-2", "accent", "border"].map((k) => [k, "#000000"])) };
    const o = await open({ scheme: "dark", record: { v: 2, mode: "dark", light: null, dark: black }, search: "?theme=default", hold: true });
    try {
      assert.deepEqual(await paintedBeforeApp(o.page), { theme: null, meta: "#2C2C38", background: BUILTIN_DARK_BG, inline: [] }, "no data-theme, no inline --color-*, the shipped bar colour");
      o.release();
      await appRan(o.page);
      assert.equal(await record(o.page), null, "the app carried the reset out: nothing stored");
      assert.equal(await o.page.evaluate(() => location.search), "", "and the reset is off the address");
      assert.equal(await dataTheme(o.page), null);
    } finally {
      o.release();
      await o.ctx.close();
    }
  });

  test("the table injected into index.html is the app's own, in the build and in the dev server", async () => {
    assert.deepEqual(injectedArgs(readFileSync(join(dist, "index.html"), "utf8")), [{ ...CSS_PROPERTY }, { ...BASE_SURFACE }, THEME_KEY], "vite build");
    // In-process, no port and no watcher: only the page transform `vite dev` runs on each request for index.html.
    const server = await createServer({
      root: ROOT,
      configFile: join(ROOT, "vite.config.ts"),
      logLevel: "error",
      cacheDir: join(scratchRoot("sova-theme-vite-"), "cache"),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "spa",
    });
    try {
      const html = await server.transformIndexHtml("/index.html", readFileSync(join(ROOT, "index.html"), "utf8"));
      assert.deepEqual(injectedArgs(html), [{ ...CSS_PROPERTY }, { ...BASE_SURFACE }, THEME_KEY], "vite dev");
      const share = await server.transformIndexHtml("/src/share/index.html", readFileSync(join(ROOT, "src/share/index.html"), "utf8"));
      assert.doesNotMatch(share, /\/\*args\*\//, "the share page gets no pre-paint script");
    } finally {
      await server.close();
    }
  });

  test("Settings → Themes: Appearance, two sections, a pick in the hidden one waits, arrows stay in their section", async () => {
    const o = await open({ scheme: "light", hash: "#/settings/themes" });
    try {
      const page = o.page;
      const appearance = page.getByRole("group", { name: "Appearance" });
      await appearance.waitFor();
      assert.equal(await appearance.getByRole("radio", { name: "Dark" }).isChecked(), true, "Dark is the starting mode");
      const lightList = page.getByRole("radiogroup", { name: "Light theme" });
      const darkList = page.getByRole("radiogroup", { name: "Dark theme" });
      await lightList.getByRole("radio").first().waitFor();
      assert.equal(await lightList.getByRole("radio").count(), 3, "light themes only");
      assert.equal(await darkList.getByRole("radio").count(), 4, "dark themes only");
      assert.equal(await lightList.locator('[aria-checked="true"]').getAttribute("id"), "theme-row-light-light");
      assert.equal(await darkList.locator('[aria-checked="true"]').getAttribute("id"), "theme-row-dark-dark");
      assert.equal(await page.locator('.settings-theme-list [tabindex="0"]').count(), 2, "one tab stop per section");
      const panel = page.locator("#settings-panel-themes");
      assert.match(await panel.innerText(), /Light theme\s*Shows in Light mode/);
      assert.match(await panel.innerText(), /Dark theme\s*Showing now/);

      // A pick in the section that isn't showing is saved and changes nothing on screen.
      await lightList.getByRole("radio", { name: /^Nord Light/ }).click();
      assert.equal(await lightList.getByRole("radio", { name: /^Nord Light/ }).getAttribute("aria-checked"), "true");
      assert.equal(await dataTheme(page), null, "still the built-in dark");
      assert.equal((await record(page))?.light?.id, "nord-light");

      // Arrows move within the light section and wrap there, never into the dark one.
      await lightList.getByRole("radio", { name: /^Nord Light/ }).focus();
      await page.keyboard.press("End");
      const last = await page.evaluate(() => document.activeElement?.id);
      assert.equal(last, "theme-row-light-nord-light");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "theme-row-light-light", "wrapped to the section's first card");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute("aria-label")), "Light theme");
      assert.equal(await dataTheme(page), null, "moving the light pick by keyboard changes nothing on screen either");
      await lightList.getByRole("radio", { name: /^Nord Light/ }).click();

      // In the shown section a pick applies at once.
      await darkList.getByRole("radio", { name: /^Dracula/ }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      assert.equal(await metaColor(page), "#343746");

      // Appearance shows the other pick, and under Auto the notes say when each shows.
      await appearance.getByText("Light", { exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      assert.equal((await record(page))?.mode, "light");
      assert.equal(await metaColor(page), "#e5e9f0", "the saved light pick, Nord Light");
      await appearance.getByText("Auto", { exact: true }).click();
      await page.getByText("Appearance is now Auto.").waitFor({ state: "attached" }); // the polite region
      assert.equal((await record(page))?.mode, "auto");
      assert.equal(await dataTheme(page), "light", "the context's system is light");
      assert.match(await panel.innerText(), /Dark theme\s*Shows while your system is dark/);
      assert.match(await panel.innerText(), /Light theme\s*Showing now/);
    } finally {
      await o.ctx.close();
    }
  });

  test("a user file holding the built-in's id isn't checked while nothing is picked; the notice names the list and why", async () => {
    const mine: ThemeInfo = { ...theme("light", "My Light", "light", { bg: "#fafafa", surface: "#f0f0f0" }), source: "user", path: "/t/light.json", replacesBuiltin: true };
    const themes = [...THEMES.filter((t) => t.id !== "light"), mine];
    const gone = { id: "gone-dark", base: "dark", tokens: { bg: "#123123" } };
    const o = await open({ scheme: "dark", record: { v: 2, mode: "light", light: null, dark: gone }, hash: "#/settings/themes", themes });
    try {
      const page = o.page;
      const lightList = page.getByRole("radiogroup", { name: "Light theme" });
      await lightList.getByRole("radio").first().waitFor();
      assert.equal(await lightList.locator('[aria-checked="true"]').count(), 0, "no light card is checked: the window wears the built-in Light");
      assert.equal(await lightList.locator('[tabindex="0"]').count(), 1, "the list keeps one tab stop, its first usable card");
      assert.equal(await dataTheme(page), "light");
      assert.deepEqual(await page.evaluate(() => [...document.documentElement.style].filter((p) => p.startsWith("--color-"))), [], "and nothing of My Light is painted");
      const panel = page.locator("#settings-panel-themes");
      await page.getByText("gone-dark", { exact: true }).waitFor();
      assert.match(await panel.innerText(), /gone-dark isn't there anymore, so your dark theme is back on the built-in Dark\./);
      assert.match(await panel.innerText(), /A pick in the list that's showing applies at once; the other list's pick shows when its mode does\. The choice is remembered in this browser\./);
      await lightList.getByRole("radio", { name: /^My Light/ }).click();
      assert.equal(await lightList.getByRole("radio", { name: /^My Light/ }).getAttribute("aria-checked"), "true", "picked, it is worn and checked");
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--color-bg")), "#fafafa");
    } finally {
      await o.ctx.close();
    }
  });

  test("an open tab follows a change made in another tab at once, and neither erases the other's pick", async () => {
    const a = await open({ scheme: "dark", hash: "#/settings/themes" });
    try {
      const b = await a.ctx.newPage(); // the same browser, so the same store
      await b.goto(`${ORIGIN}/#/settings/themes`);
      const darkA = a.page.getByRole("radiogroup", { name: "Dark theme" });
      const lightB = b.getByRole("radiogroup", { name: "Light theme" });
      await darkA.getByRole("radio").first().waitFor();
      await lightB.getByRole("radio").first().waitFor();
      // The review's sequence: A picks Dracula; B, opened before that, then picks Catppuccin Latte and Auto.
      await darkA.getByRole("radio", { name: /^Dracula/ }).click();
      await b.waitForFunction(() => document.documentElement.style.getPropertyValue("--color-bg") === "#282a36"); // B wears it at once
      await lightB.getByRole("radio", { name: /^Catppuccin Latte/ }).click();
      await b.getByRole("group", { name: "Appearance" }).getByText("Auto", { exact: true }).click();
      const r = await record(b);
      assert.deepEqual({ mode: r?.mode, light: r?.light?.id, dark: r?.dark?.id }, { mode: "auto", light: "catppuccin-latte", dark: "dracula" }, "A's dark pick is still stored");
      await a.page.waitForFunction(() => (document.querySelector('input[type="radio"][value="auto"]') as HTMLInputElement | null)?.checked === true);
      assert.equal(await a.page.evaluate(() => document.documentElement.style.getPropertyValue("--color-bg")), "#282a36", "A, on a dark system under Auto, wears Dracula");
      await a.page.emulateMedia({ colorScheme: "light" });
      await a.page.waitForFunction(() => document.documentElement.style.getPropertyValue("--color-bg") === "#eff1f5"); // and B's light pick on a light one
      assert.equal(await lightB.getByRole("radio", { name: /^Catppuccin Latte/ }).getAttribute("aria-checked"), "true");
      assert.equal(await a.page.getByRole("radiogroup", { name: "Light theme" }).getByRole("radio", { name: /^Catppuccin Latte/ }).getAttribute("aria-checked"), "true", "A's list shows B's pick checked");
    } finally {
      await a.ctx.close();
    }
  });

  test("the explanation thumbnails and links follow a live switch", async () => {
    const o = await open({ scheme: "dark", hash: "#/explanations" });
    try {
      const page = o.page;
      await page.locator(".explain-thumb-frame").first().waitFor({ state: "attached" });
      const srcs = () => page.locator(".explain-thumb-frame").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
      const links = () => page.locator(".explain-tile-link").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
      assert.equal((await srcs()).length, 2);
      for (const s of await srcs()) assert.match(s, /\?theme=dark$/);
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.waitForFunction(() => [...document.querySelectorAll(".explain-thumb-frame")].every((f) => f.getAttribute("src")?.endsWith("?theme=light")));
      for (const s of await srcs()) assert.match(s, /\?theme=light$/);
      for (const h of await links()) assert.match(h, /\?theme=light$/, "a page opened after the switch opens in it");
      const schemes = await page.locator(".explain-thumb-frame").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.colorScheme));
      assert.deepEqual(schemes, ["light", "light"]);
      await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
      await page.waitForFunction(() => [...document.querySelectorAll(".explain-thumb-frame")].every((f) => f.getAttribute("src")?.endsWith("?theme=dark")));
    } finally {
      await o.ctx.close();
    }
  });
});
