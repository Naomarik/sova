// Light, Dark and Auto in a real Chrome (§app.settings-dialog/themes): Auto wears the light pick from the first frame on a
// light system and follows the system to dark with no reload, the browser bar's colour with it; Settings → Themes holds
// Appearance and two sections, a pick in the hidden one changes nothing on screen, and arrows stay inside a section;
// the explanation thumbnails follow a live switch. The app's own build, served from a scratch build with every request
// answered here (no server, no network). Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ExplanationInfo, ThemeInfo } from "../shared/protocol";
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
}

async function open(o: { scheme: "light" | "dark"; record?: unknown; hash?: string; width?: number }): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: 1000 }, reducedMotion: "reduce", colorScheme: o.scheme });
  if (o.record !== undefined) await ctx.addInitScript((r) => localStorage.setItem("sova:theme", JSON.stringify(r)), o.record);
  await ctx.addInitScript(() => sessionStorage.setItem("sova:launched", "1"));
  // What the first frame can wear: the document as it stands when the parser is done, before any fetch has answered.
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { atReady: unknown }).atReady = {
        theme: document.documentElement.dataset.theme ?? null,
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
      };
    });
  });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/themes") return route.fulfill(json({ dir: "/t", themes: THEMES }));
    if (p === "/api/explanations") return route.fulfill(json(EXPLAINED));
    if (p === "/api/sessions" || p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p.startsWith("/explain/")) return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title>" });
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/${o.hash ?? ""}`);
  return { page, ctx };
}

const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
const metaColor = (page: Page) => page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null);
const record = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("sova:theme") ?? "null") as { v: number; mode: string; light: { id: string } | null; dark: { id: string } | null } | null);
const AUTO = { v: 2, mode: "auto", light: stored("nord-light"), dark: stored("dracula") };

describe("Light, Dark and Auto", () => {
  test("Auto on a light system wears the light pick from the first frame, then follows the system to dark with no reload", async () => {
    const o = await open({ scheme: "light", record: AUTO });
    try {
      await o.page.waitForFunction(() => (window as unknown as { atReady?: unknown }).atReady);
      const ready = await o.page.evaluate(() => (window as unknown as { atReady: { theme: string | null; meta: string | null } }).atReady);
      assert.deepEqual(ready, { theme: "light", meta: "#e5e9f0" }, "the light pick and its surface are on before the first frame");
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
      await o.ctx.close();
    }
  });

  test("nothing stored is Dark on a light system; an old single theme keeps its look and is rewritten as v2", async () => {
    const fresh = await open({ scheme: "light" });
    try {
      await fresh.page.waitForFunction(() => (window as unknown as { atReady?: unknown }).atReady);
      assert.deepEqual(await fresh.page.evaluate(() => (window as unknown as { atReady: unknown }).atReady), { theme: null, meta: "#2C2C38" });
    } finally {
      await fresh.ctx.close();
    }
    // The old shape is the single pick itself, as server/needs-you-rows-ui.integration.test.ts still writes it.
    const old = await open({ scheme: "dark", record: stored("nord-light") });
    try {
      await old.page.waitForFunction(() => (window as unknown as { atReady?: unknown }).atReady);
      assert.deepEqual(await old.page.evaluate(() => (window as unknown as { atReady: unknown }).atReady), { theme: "light", meta: "#e5e9f0" }, "a light theme stored the old way still wears light on a dark system");
      const r = await record(old.page);
      assert.equal(r?.v, 2);
      assert.equal(r?.mode, "light");
      assert.equal(r?.light?.id, "nord-light");
      assert.equal(r?.dark, null);
    } finally {
      await old.ctx.close();
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
