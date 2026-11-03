// Where focus goes after an Overseer Quick Action, in a real Chrome (§chat.composer/focus, §app.overseer/quick-actions):
// the app's own build, served from a scratch build with every request answered here (no server, no model, no
// network). A phone that taps Quick Actions and then an action keeps its keyboard down: the composer's textarea is
// not focused afterwards. A mouse puts focus back in the box, as Send does, and so does a menu opened with a key.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { OverseerInfo, OverseerQuickAction } from "../shared/protocol";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_QA_FOCUS_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without the fix fails).
  dist = process.env.SOVA_QA_FOCUS_DIST || join(scratchRoot("sova-qa-focus-"), "dist");
  if (!process.env.SOVA_QA_FOCUS_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const NOW = new Date().toISOString();
const PATH = "/w/overseer/overseer-1.jsonl";
const ACTION: OverseerQuickAction = { id: "qa_moving", label: "Get Things Moving", description: "Nudge what is stuck.", prompt: "Nudge whatever is stuck." } as OverseerQuickAction;
const INFO: OverseerInfo = { path: PATH, id: "overseer-1", history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false };
const SETTINGS = {
  settings: { version: 2, model: null, thinking: null, quickActions: [ACTION] },
  defaults: { quickActions: [ACTION] },
  file: "/w/overseer.json",
};
const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

/** The Overseer open at `width`, on a phone (touch, mobile) or a desktop with a mouse. The chat's socket says hello and keeps
    every frame the page sends in `frames`: the prompt a pick sends lands there. */
async function open(width: number, phone: boolean): Promise<{ page: Page; ctx: BrowserContext; frames: string[] }> {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const frames: string[] = [];
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.onMessage((m) => frames.push(String(m)));
    ws.send(JSON.stringify({ type: "hello", items: [], isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/overseer") return route.fulfill(json(INFO));
    if (p === "/api/settings/overseer") return route.fulfill(json(SETTINGS));
    if (p === "/api/sessions") return route.fulfill(json([]));
    if (p === "/api/transcript") return route.fulfill(json({ items: [], context: null }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: Date.parse(NOW), counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/session-groups") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/overseer`);
  assert.equal(await page.evaluate(() => innerWidth), width);
  await page.getByRole("button", { name: "Quick Actions" }).waitFor({ timeout: 20_000 });
  return { page, ctx, frames };
}

/** The composer's textarea holds focus. */
const boxFocused = (page: Page) => page.evaluate(() => document.activeElement?.matches("textarea[id$='composer-input']") ?? false);

/** Waits until the pick's prompt went out on a socket, so the send happened and focus has settled after it. */
async function sent(page: Page, frames: string[]) {
  const t0 = Date.now();
  while (!frames.some((f) => f.includes(ACTION.prompt))) {
    assert.ok(Date.now() - t0 < 15_000, `the quick action's prompt never went out; frames: ${frames.join(" | ").slice(0, 400)}`);
    await page.waitForTimeout(50);
  }
  // The focus settles in a microtask after the send; one frame later it has.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

test("a phone: tapping Quick Actions, then an action, sends it and leaves the composer unfocused (the keyboard stays down)", async () => {
  const { page, ctx, frames } = await open(390, true);
  assert.equal(await boxFocused(page), false, "the box starts without focus on a phone");
  await page.getByRole("button", { name: "Quick Actions" }).tap();
  const item = page.getByRole("menuitem", { name: `${ACTION.label}: ${ACTION.description}` });
  await item.waitFor({ timeout: 10_000 });
  await item.tap();
  await sent(page, frames);
  assert.equal(await boxFocused(page), false, "a tap must not focus the textarea (it would raise the keyboard)");
  await ctx.close();
});

test("a phone with the menu opened by a key: it counts as Enter, and focus returns to the composer", async () => {
  const { page, ctx, frames } = await open(390, true);
  await page.getByRole("button", { name: "Quick Actions" }).focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", { name: `${ACTION.label}: ${ACTION.description}` });
  await item.waitFor({ timeout: 10_000 });
  await item.tap();
  await sent(page, frames);
  assert.equal(await boxFocused(page), true);
  await ctx.close();
});

test("a mouse: clicking Quick Actions, then an action, puts focus back in the composer", async () => {
  const { page, ctx, frames } = await open(1280, false);
  await page.getByRole("button", { name: "Quick Actions" }).click();
  const item = page.getByRole("menuitem", { name: `${ACTION.label}: ${ACTION.description}` });
  await item.waitFor({ timeout: 10_000 });
  await item.click();
  await sent(page, frames);
  assert.equal(await boxFocused(page), true);
  await ctx.close();
});
