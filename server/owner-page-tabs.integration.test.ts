// The owner page's tabs, Home's Project Assistant card and the chat's suggestions in a real Chrome
// (§app.owner-page/content, /page, §app.project-assistant/abilities): the share build, served from a
// scratch build with every request answered here (no server, no network), at 390px and 1280px.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { OwnerHome } from "../shared/owner";
import type { AssistantView } from "../shared/project-assistant";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const TOKEN = "T".repeat(43);
const ORIGIN = "http://owner.test";
let dist = "";
let browser: Browser;

before(async () => {
  dist = join(scratchRoot("sova-owner-tabs-"), "dist-share");
  const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--mode", "share", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const NOW = new Date().toISOString();
const A = { id: "q_aaaaaaaa", name: "RakibaDesigns" };
const B = { id: "q_bbbbbbbb", name: "Rakiba Shop" };
const card = (p: { id: string; name: string }) => ({ ...p, status: "quiet" as const, lastActivityAt: "", latestNews: null, conversations: 0, people: 0, decisions: 0, finished: 0, inProgress: 0 });

function homeOf(x: Partial<OwnerHome> = {}): OwnerHome {
  return {
    org: { name: "Rakiba" },
    owner: { name: "Sara Rakiba", first: "Sara" },
    operator: { name: "Omar Hughes", first: "Omar" },
    updatedAt: NOW,
    waiting: [],
    projects: [card(A), card(B)],
    requests: [{ handle: "r_1", project: "RakibaDesigns", kind: "bug", title: "The cart is empty", status: "with-team", at: NOW }],
    versions: [],
    assistant: { ready: true },
    abilities: {
      photos: true,
      projects: [
        { project: A.id, fix: "held", version: "none", release: "team" },
        { project: B.id, fix: "team", version: "none", release: "team" },
      ],
    },
    ...x,
  };
}
const viewOf = (x: Partial<AssistantView> = {}): AssistantView => ({ ready: true, busy: false, messages: [], ...x });

/** A page at `width`, every request answered: the build's files, the Home answer, the chat's view. */
async function open(width: number, hash: string, o: { home?: OwnerHome; view?: AssistantView; touch?: boolean } = {}): Promise<{ page: Page; ctx: BrowserContext }> {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: !!o.touch, isMobile: !!o.touch });
  const page = await ctx.newPage();
  const home = o.home ?? homeOf();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === `/i/${TOKEN}`) return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html"), "utf8") });
    const asset = /\/assets\/([^/]+)$/.exec(url.pathname);
    if (asset) return route.fulfill({ path: join(dist, "assets", asset[1]!) });
    if (url.pathname === `/api/i/${TOKEN}/assistant`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o.view ?? viewOf()) });
    if (url.pathname === `/api/i/${TOKEN}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(home) });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`${ORIGIN}/i/${TOKEN}${hash}`);
  assert.equal(await page.evaluate(() => innerWidth), width);
  return { page, ctx };
}

/** OWNER_SHOTS=<dir>: keep a screenshot of each screen (by hand, for a look). */
const shot = async (page: Page, name: string) => {
  if (process.env.OWNER_SHOTS) await page.screenshot({ path: join(process.env.OWNER_SHOTS, `${name}.png`), fullPage: true });
};
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right, display: getComputedStyle(el).display };
});

test("390px, #r opened directly: the request's row shows and the Requests tab counts 1 (Home's family reads Home)", async () => {
  const { page, ctx } = await open(390, "#r");
  await page.getByText("The cart is empty").waitFor({ timeout: 10_000 });
  const tab = page.getByRole("link", { name: "Requests, 1 open" });
  assert.equal(await tab.count(), 1);
  assert.equal(await tab.getAttribute("aria-current"), "page");
  // The bar sits at the bottom of the window, each tab at least 44px tall.
  const bar = await box(page, ".owner-nav");
  assert.ok(Math.abs(bar.bottom - 800) <= 1, `bar bottom ${bar.bottom}`);
  for (const item of await page.locator(".owner-nav .navitem").all()) assert.ok((await item.boundingBox())!.height >= 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "nothing scrolls sideways");
  await shot(page, "390-requests");
  await ctx.close();
});

test("390px, Requests with none: the empty line and Open the Chat", async () => {
  const { page, ctx } = await open(390, "#r", { home: homeOf({ requests: [] }) });
  await page.getByText("Nothing asked yet. Ask the Project Assistant for a fix, a new feature or a release.").waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("link", { name: "Open the Chat" }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Requests", exact: true }).count(), 1, "no count with nothing open");
  await shot(page, "390-requests-empty");
  await ctx.close();
});

test("390px Home: the order, the card's lines, and a tapped line starts the chat's message box", async () => {
  const { page, ctx } = await open(390, "");
  await page.getByText("What it can do for you").waitFor({ timeout: 10_000 });
  const order = await page.evaluate(() =>
    ["Hi Sara.", "What it can do for you", "Your requests: 1 with the team", "Your projects"].map((t) => {
      const el = [...document.querySelectorAll(".owner *")].find((e) => e.childElementCount === 0 && e.textContent?.includes(t)) ?? [...document.querySelectorAll(".owner h1, .owner h2, .owner a")].find((e) => e.textContent?.includes(t));
      return el ? el.getBoundingClientRect().top + scrollY : -1;
    }),
  );
  assert.ok(order.every((y) => y >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "greeting, card, requests line, projects");
  const fix = page.getByRole("button", { name: "Get a problem fixed: on its own for RakibaDesigns, the team starts it for Rakiba Shop." });
  assert.equal(await fix.count(), 1);
  assert.equal(await page.getByRole("button", { name: /^Release a new version\. The team releases it\./ }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /Try the latest version/ }).count(), 0, "no version listed: no line");
  assert.equal(await page.getByText("You can add photos and screenshots.").count(), 1);
  for (const b of await page.locator(".owner-ability").all()) assert.ok((await b.boundingBox())!.height >= 44);
  await shot(page, "390-home");
  await page.getByRole("button", { name: /^Report a problem/ }).click();
  await page.waitForFunction(() => location.hash === "#a");
  const input = page.locator("#assistant-text");
  await input.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => (document.querySelector("#assistant-text") as HTMLTextAreaElement | null)?.value === "Something isn't working: ");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "assistant-text", "the cursor is in the box (not a touch screen)");
  assert.equal(await page.getByRole("link", { name: "Assistant" }).getAttribute("aria-current"), "page");
  // The composer sits above the bar.
  const composer = await box(page, ".owner-assistant-composer");
  const bar = await box(page, ".owner-nav");
  assert.ok(composer.bottom <= bar.y + 1, `composer ${composer.bottom} above bar ${bar.y}`);
  await shot(page, "390-chat-prefilled");
  await ctx.close();
});

test("390px chat, no messages: the suggestions under the greeting start the box; nothing is sent", async () => {
  const { page, ctx } = await open(390, "#a");
  const chip = page.locator(".owner-suggestion", { hasText: "Ask for something new" });
  await chip.waitFor({ timeout: 10_000 });
  const posts: string[] = [];
  page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
  await chip.click();
  await page.waitForFunction(() => (document.querySelector("#assistant-text") as HTMLTextAreaElement | null)?.value === "I'd like something new: ");
  assert.deepEqual(posts, []);
  assert.equal(await page.getByRole("button", { name: "What Can I Ask?" }).count(), 0, "no sheet button before the first message");
  await shot(page, "390-chat-suggestions");
  await ctx.close();
});

test("390px chat with messages: What Can I Ask? opens a sheet that keeps focus, a line in it starts the box", async () => {
  const view = viewOf({ messages: [{ n: 1, role: "owner", text: "Hello", at: NOW }, { n: 2, role: "assistant", text: "Hi there.", at: NOW }] });
  const { page, ctx } = await open(390, "#a", { view });
  const opener = page.getByRole("button", { name: "What Can I Ask?" });
  await opener.waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".owner-suggestion").count(), 0, "no suggestions once there are messages");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "What it can do for you" });
  await dialog.waitFor();
  // Focus stays in the sheet through more Tabs than it has controls.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement?.closest("dialog") || document.activeElement === document.body);
    assert.ok(inside, `tab ${i} left the sheet`);
  }
  // Folded: a sheet at the bottom.
  if (process.env.OWNER_SHOTS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(process.env.OWNER_SHOTS, "390-sheet.png") });
  }
  const sheet = await box(page, "dialog.owner-sheet");
  assert.ok(Math.abs(sheet.bottom - 800) <= 1 && sheet.x === 0, JSON.stringify(sheet));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "What Can I Ask?", "focus returns to the opener");
  await opener.click();
  await dialog.getByRole("button", { name: /^Ask about your projects/ }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => (document.querySelector("#assistant-text") as HTMLTextAreaElement | null)?.value === "How are my projects going?");
  await ctx.close();
});

test("390px on a touch screen: the bar hides while the owner types and comes back after", async () => {
  const { page, ctx } = await open(390, "#a", { touch: true });
  assert.equal(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches), true, "the context is a touch screen");
  const input = page.locator("#assistant-text");
  await input.waitFor({ timeout: 10_000 });
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), "assistant-text", "no keyboard springs up on opening");
  await input.focus();
  assert.equal((await box(page, ".owner-nav")).display, "none");
  const composer = await box(page, ".owner-assistant-composer");
  assert.ok(Math.abs(composer.bottom - 800) <= 1, `composer at the bottom: ${composer.bottom}`);
  await input.evaluate((el) => (el as HTMLElement).blur());
  assert.equal((await box(page, ".owner-nav")).display, "flex");
  await ctx.close();
});

// Found driving a real owner page on a phone: pressing Send took the focus from the box, the bar came back,
// the composer dropped under the finger and the release landed on a tab, so nothing was sent.
for (const how of ["tap", "click"] as const) {
  test(`390px on a touch screen: a ${how} on Send sends what was typed, and the box keeps the keyboard`, async () => {
    const { page, ctx } = await open(390, "#a", { touch: true });
    const input = page.locator("#assistant-text");
    await input.waitFor({ timeout: 10_000 });
    const posts: string[] = [];
    page.on("request", (r) => r.method() === "POST" && posts.push(r.postData() ?? ""));
    await input.focus();
    await page.keyboard.type("Can we add online booking?");
    await page.getByRole("button", { name: "Send", exact: true })[how]();
    await page.waitForTimeout(500);
    assert.deepEqual(posts.map((b) => (JSON.parse(b) as { text: string }).text), ["Can we add online booking?"]);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "assistant-text", "the box keeps the focus");
    assert.equal(page.url().endsWith("#a"), true, "no tab took the press");
    await ctx.close();
  });
}

test("1280px: the tabs are a left sidebar, the page beside it, no bottom bar", async () => {
  const { page, ctx } = await open(1280, "");
  await page.getByText("What it can do for you").waitFor({ timeout: 10_000 });
  await shot(page, "1280-home");
  const nav = await box(page, ".owner-nav");
  assert.equal(nav.x, 0);
  assert.ok(nav.h >= 790, `full height: ${nav.h}`);
  assert.ok(nav.w < 260, `a sidebar: ${nav.w}`);
  const main = await box(page, ".owner-shell > .owner");
  assert.ok(main.x >= nav.right, "the page is beside the sidebar");
  assert.ok(main.w > 720 && main.w <= 880, `a wider main pane: ${main.w}`);
  const items = await page.locator(".owner-nav .navitem").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
  assert.ok(items[0]! < items[1]! && items[1]! < items[2]!, "stacked");
  // A project opens inside Home: Home stays highlighted.
  await page.getByRole("link", { name: /RakibaDesigns/ }).first().click();
  await page.waitForFunction(() => location.hash.startsWith("#p/"));
  assert.equal(await page.getByRole("link", { name: "Home" }).getAttribute("aria-current"), "page");
  await page.goto(`${ORIGIN}/i/${TOKEN}#a`);
  await page.locator("#assistant-text").waitFor({ timeout: 10_000 });
  const thread = await box(page, ".owner-shell > .owner");
  assert.ok(thread.w <= 760, `the chat keeps a comfortable width: ${thread.w}`);
  const composer = await box(page, ".owner-assistant-composer");
  assert.ok(Math.abs(composer.bottom - 800) <= 1, `the composer at the window's foot: ${composer.bottom}`);
  await shot(page, "1280-chat");
  await ctx.close();
});

test("not ready: the card shows the not-ready line and no list; the chat no suggestions", async () => {
  const { page, ctx } = await open(390, "", { home: homeOf({ assistant: { ready: false }, abilities: undefined }), view: viewOf({ ready: false }) });
  await page.getByText("The Project Assistant isn't ready yet. Omar has to finish setting it up.").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".owner-ability").count(), 0);
  await page.getByRole("link", { name: "Open the Chat" }).click();
  await page.locator(".owner-assistant").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".owner-suggestion").count(), 0);
  await ctx.close();
});
