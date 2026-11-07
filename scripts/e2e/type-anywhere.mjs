#!/usr/bin/env node
// E2E: Type anywhere (§chat.composer/type-anywhere), driven in a real browser with real key presses.
//
// A letter typed while focus is outside a text field lands in the chat's message box at its caret,
// the browser typing it there; nothing is sent. Focus view ends. Nothing moves while Session details
// covers the box (under 1280 wide), while a dialog is open, from a read-only box, or before the saved
// draft has arrived. "/" and "?" keep their own jobs, and Settings has no switch for it.
//
//   pnpm run build && pnpm run e2e:type-anywhere
//
// By default it hosts its own server (scripts/e2e/self-hosted.mjs). Against one already running:
// SOVA_E2E_PORT=<its port>, SOVA_E2E_AGENT its agent dir when it isn't this worktree's .agent.
// SOVA_E2E_CDP, a browser already running (CDP URL); SOVA_E2E_CHROMIUM, a Chromium binary to launch
// directly instead of the skill's start-browser.sh.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";
import { whenListed } from "./listed.mjs";
import { selfHosted } from "./self-hosted.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SELF = process.env.SOVA_E2E_PORT ? null : await selfHosted({ label: "e2e-type" }).catch((err) => {
  console.error(`self-hosted server: ${err.message}`);
  process.exit(2);
});
if (SELF) delete process.env.SOVA_TOKEN;
const AGENT = SELF ? SELF.agent : resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = SELF ? SELF.port : Number(process.env.SOVA_E2E_PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");
const exit = async (code) => {
  await SELF?.stop();
  process.exit(code);
};

let passed = 0;
const failures = [];
const skipped = [];
function skip(name, why) {
  skipped.push(name);
  console.log(`  SKIP ${name}\n       ${why}`);
}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err?.message ?? err).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: tokenHeaders(AGENT) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
};

try {
  const d = await api("/api/settings/decisions");
  assert(d.file.startsWith(AGENT + "/"), `the server on ${PORT} writes ${d.file}, not into ${AGENT}`);
} catch (err) {
  console.error(`preflight: ${err.message}`);
  await exit(2);
}
if (!existsSync(join(SKILL, "node_modules", "playwright"))) {
  console.error(`preflight: no playwright in ${SKILL}/node_modules — run npm ci there, or symlink another checkout's`);
  await exit(2);
}

// ---- fixtures: plain sessions, long enough to scroll; one fresh, so it opens read-only ----
const cwd = join(AGENT, "e2e-type-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const words = (n, seed) => Array.from({ length: n }, (_, i) => ["typing", "reading", "letter", "draft", "caret", "message", "thread", "quiet"][(i * 3 + seed) % 8]).join(" ");
function writeSession(id, seed, title, { fresh = false } = {}) {
  const file = join(dir, `2026-10-21T00-00-0${seed}-000Z_${id}.jsonl`);
  const t0 = Date.parse("2026-10-21T00:00:00.000Z") + seed * 3_600_000;
  const lines = [{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const push = (e) => {
    lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
    parent = e.id;
  };
  for (let i = 0; i < 10; i++) {
    push({ type: "message", id: `u${seed}_${i}`, message: { role: "user", content: [{ type: "text", text: i === 0 ? title : `Question ${i}: ${words(10, i)}` }], timestamp: 0 } });
    push({ type: "message", id: `a${seed}_${i}`, message: { role: "assistant", content: [{ type: "text", text: words(60, i) }], provider: "zai", model: "glm-5.3", api: "openai-completions", stopReason: "stop", timestamp: 0 } });
  }
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (!fresh) {
    const past = new Date(t0);
    utimesSync(file, past, past);
  }
  return id;
}
const TITLES = {};
const session = (id, seed, title, opts) => ((TITLES[id] = title), writeSession(id, seed, title, opts));
const A = session("01a0e2e0-0000-7000-8000-0000000071a1", 1, "Type a letter while reading");
const B = session("01a0e2e0-0000-7000-8000-0000000071a2", 2, "A saved draft on a slow line");
const C = session("01a0e2e0-0000-7000-8000-0000000071a3", 3, "A session another process is writing", { fresh: true });
const paths = new Map();
for (const [id, s] of await whenListed(api, [A, B, C])) paths.set(id, s.path);
const hashOf = (id) => `#/s/${encodeURIComponent(paths.get(id))}`;

// ---- the browser ----
const { chromium } = createRequire(join(SKILL, "package.json"))("playwright");
let cdpPort = null;
let browser;
try {
  if (process.env.SOVA_E2E_CHROMIUM) browser = await chromium.launch({ executablePath: process.env.SOVA_E2E_CHROMIUM, args: ["--no-sandbox"] });
  else {
    let cdp = process.env.SOVA_E2E_CDP;
    if (!cdp) {
      const started = execFileSync(join(SKILL, "start-browser.sh"), ["--headless"], { cwd: SKILL, stdio: ["ignore", "pipe", "pipe"] }).toString();
      cdpPort = /PW_PORT=(\d+)/.exec(started)?.[1];
      if (!cdpPort) throw new Error(`start-browser.sh printed no PW_PORT:\n${started}`);
      cdp = `http://127.0.0.1:${cdpPort}`;
    }
    browser = await chromium.connectOverCDP(cdp);
  }
} catch (err) {
  console.error(`browser: ${err?.message ?? err}`);
  await exit(2);
}

const size = (width, height = 800) => ({ viewport: { width, height }, deviceScaleFactor: 1 });

async function newPage(device) {
  const ctx = await browser.newContext({ serviceWorkers: "block", ...device });
  await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
  const page = await ctx.newPage();
  return { ctx, page };
}
async function open(page, id) {
  if (page.url() === "about:blank") await page.goto(`${BASE}/${hashOf(id)}`);
  else await page.evaluate((h) => (location.hash = h), hashOf(id));
  await page.waitForFunction((title) => document.querySelector(".session-head-title")?.textContent?.includes(title) && document.querySelectorAll("#transcript .thread > .entry").length > 6, TITLES[id], { timeout: 30000 });
  await page.locator("#composer-input").waitFor({ timeout: 30000 });
}
/** Focus on the page itself, outside any field: the transcript's scroller, as a reader leaves it. */
const blur = (page) =>
  page.evaluate(() => {
    document.activeElement?.blur?.();
    document.body.focus();
  });
const look = (page) =>
  page.evaluate(() => {
    const box = document.getElementById("composer-input");
    const t = document.getElementById("transcript");
    return {
      draft: box?.value ?? null,
      inBox: document.activeElement === box,
      active: document.activeElement?.id || document.activeElement?.tagName || null,
      focus: document.querySelector(".app")?.getAttribute("data-focus") ?? null,
      userRows: document.querySelectorAll("#transcript .thread > .entry").length,
      scroll: t ? Math.round(t.scrollTop) : null,
    };
  });
const settle = () => sleep(300);

try {
  // ---------------- wide: the letter lands, the draft is kept, nothing is sent ----------------
  {
    const { ctx, page } = await newPage(size(1440));
    await open(page, A);
    await settle();

    await check("wide: a letter typed outside the box lands in it, at the end of the draft, and nothing is sent", async () => {
      await page.locator("#composer-input").fill("Hello ");
      await blur(page);
      await page.evaluate(() => (document.getElementById("transcript").scrollTop = 200));
      const before = await look(page);
      assert(!before.inBox, `focus stayed in the box: ${JSON.stringify(before)}`);
      await page.keyboard.type("wor");
      await settle();
      const s = await look(page);
      assert(s.draft === "Hello wor", `draft ${JSON.stringify(s.draft)}`);
      assert(s.inBox, `focus is on ${s.active}`);
      assert(s.userRows === before.userRows, `rows ${before.userRows} → ${s.userRows}: something was sent`);
      assert(s.scroll === before.scroll, `scroll moved ${before.scroll} → ${s.scroll}`);
    });

    await check("wide: the first letter goes in at the caret where the box was left", async () => {
      await page.locator("#composer-input").fill("ac");
      await page.locator("#composer-input").evaluate((b) => b.setSelectionRange(1, 1));
      await blur(page);
      await page.keyboard.press("b");
      const s = await look(page);
      assert(s.draft === "abc", `draft ${JSON.stringify(s.draft)}`);
    });

    await check("wide: / opens session search and ? the shortcut sheet; neither types in the box", async () => {
      await page.locator("#composer-input").fill("");
      await blur(page);
      await page.keyboard.press("/");
      await settle();
      let s = await look(page);
      assert(s.draft === "" && !s.inBox, `/ ${JSON.stringify(s)}`);
      const search = await page.evaluate(() => document.activeElement?.tagName === "INPUT" && document.activeElement.closest(".app-sidebar") !== null);
      assert(search, `/ focused ${s.active}`);
      await blur(page);
      await page.keyboard.press("Shift+Slash");
      await page.getByRole("dialog", { name: "Keyboard Shortcuts" }).waitFor({ timeout: 5000 });
      s = await look(page);
      assert(s.draft === "", `? typed: ${JSON.stringify(s.draft)}`);
    });

    await check("wide: with a dialog open (the shortcut sheet), a letter does nothing", async () => {
      await page.keyboard.press("x");
      await settle();
      const s = await look(page);
      assert(s.draft === "" && !s.inBox, JSON.stringify(s));
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "Keyboard Shortcuts" }).waitFor({ state: "detached", timeout: 5000 });
    });

    await check("wide: the shortcut sheet lists it as the message box's row", async () => {
      await blur(page);
      await page.keyboard.press("Shift+Slash");
      const sheet = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
      await sheet.waitFor({ timeout: 5000 });
      const text = await sheet.innerText();
      assert(/A character/.test(text) && /message box/.test(text), text);
      assert(!/turn(ed)? off|switch/i.test(text), `still mentions a switch: ${text}`);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 5000 });
    });

    await check("wide: Session details open beside the chat (1440) leaves the box free, so the letter lands", async () => {
      await page.locator("#composer-input").fill("");
      await page.locator(".session-details-open").first().click();
      await page.locator("#session-pane").waitFor({ timeout: 10000 });
      await page.locator("#session-pane button").first().focus();
      await page.keyboard.press("q");
      await settle();
      const s = await look(page);
      assert(s.draft === "q" && s.inBox, JSON.stringify(s));
      await page.locator(".session-details-open").first().click();
      await page.locator("#session-pane").waitFor({ state: "detached", timeout: 10000 });
    });

    await check("wide: a letter ends Focus view and lands in the box, the draft kept", async () => {
      await page.locator("#composer-input").fill("kept ");
      await page.locator(".transcript-wrap > .focus-toggle").click();
      await settle();
      let s = await look(page);
      assert(s.focus === "on", `Focus didn't turn on: ${JSON.stringify(s)}`);
      await blur(page);
      await page.keyboard.press("z");
      await settle();
      s = await look(page);
      assert(s.focus === null, `Focus is still ${s.focus}`);
      assert(s.draft === "kept z" && s.inBox, JSON.stringify(s));
    });

    await check("wide: Settings → General has no Type anywhere switch", async () => {
      await page.locator("#composer-input").fill("");
      await page.evaluate(() => (location.hash = "#/settings/general"));
      const dialog = page.getByRole("dialog").filter({ hasText: "Compress thinking" });
      await dialog.waitFor({ timeout: 10000 });
      const text = await dialog.innerText();
      assert(!/Type anywhere/i.test(text), "the switch is still there");
    });
    await ctx.close();
  }

  // ---------------- under 1280: Session details covers the box ----------------
  for (const width of [1000, 500]) {
    const { ctx, page } = await newPage(size(width));
    await open(page, A);
    await settle();
    await check(`${width}: with Session details over the box, a letter does nothing and Focus stays`, async () => {
      await page.locator("#composer-input").fill("");
      await page.locator(".session-details-open").first().click();
      await page.locator("#session-pane").waitFor({ timeout: 10000 });
      // Focus view hides the head's Session details button, so the panel opens first; the panel
      // covers the Focus toggle, so it is pressed programmatically.
      await page.locator(".transcript-wrap > .focus-toggle").evaluate((b) => b.click());
      await settle();
      assert((await look(page)).focus === "on", "Focus didn't turn on");
      // One of its tabs, as a reader clicks one (a button: the key would be free without the rule).
      const tab = page.locator("#session-pane [role=tab]").first();
      await ((await tab.count()) ? tab : page.locator("#session-pane button").last()).focus();
      await page.keyboard.type("hi");
      await settle();
      const s = await look(page);
      assert(s.draft === "" && !s.inBox, `the hidden box took it: ${JSON.stringify(s)}`);
      assert(s.focus === "on", `Focus changed to ${s.focus}`);
      assert(await page.locator("#session-pane").isVisible(), "the panel closed");
    });
    await ctx.close();
  }

  // ---------------- a read-only box ----------------
  {
    const { ctx, page } = await newPage(size(1440));
    await page.goto(`${BASE}/${hashOf(C)}`);
    const watched = await page
      .waitForFunction(() => document.querySelector(".app-main > .composer textarea")?.disabled === true && document.querySelectorAll("#transcript .thread > .entry").length > 6, null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!watched) skip("read-only: a letter does nothing", "the fresh fixture didn't open read-only here");
    else
      await check("read-only: a letter does nothing, and focus stays where it was", async () => {
        await blur(page);
        await page.keyboard.press("a");
        await settle();
        const s = await look(page);
        assert(!s.inBox && (s.draft ?? "") === "", JSON.stringify(s));
      });
    await ctx.close();
  }

  // ---------------- a saved draft on a slow line ----------------
  {
    const SAVED = "A saved draft that must survive";
    const put = await fetch(`${BASE}/api/sessions/draft`, {
      method: "PUT",
      headers: { ...tokenHeaders(AGENT), "content-type": "application/json" },
      body: JSON.stringify({ path: paths.get(B), text: SAVED, attachments: [] }),
    });
    const { ctx, page } = await newPage(size(1440));
    let release;
    const held = new Promise((r) => (release = r));
    await page.route(/\/api\/sessions\/draft\?/, async (route) => {
      if (route.request().method() === "GET") await held;
      await route.continue();
    });
    if (!put.ok) skip("slow draft: the saved draft survives a letter typed before it arrives", `PUT draft: ${put.status}`);
    else
      await check("slow draft: a letter typed before the saved draft arrives takes nothing, and the draft survives", async () => {
        await page.goto(`${BASE}/${hashOf(B)}`);
        await page.locator("#composer-input").waitFor({ timeout: 30000 });
        await page.waitForFunction((title) => document.querySelector(".session-head-title")?.textContent?.includes(title), TITLES[B], { timeout: 30000 });
        await blur(page);
        await page.keyboard.press("x");
        let s = await look(page);
        assert(s.draft === "" && !s.inBox, `the letter went in before the draft: ${JSON.stringify(s)}`);
        release();
        await page.waitForFunction((t) => document.getElementById("composer-input")?.value === t, SAVED, { timeout: 10000 });
        await blur(page);
        await page.keyboard.press("!");
        s = await look(page);
        assert(s.draft === SAVED + "!" && s.inBox, JSON.stringify(s));
      });
    release?.();
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  if (cdpPort) {
    try {
      execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
    } catch {}
  }
  await SELF?.stop();
}

console.log(`\n${passed} passed, ${failures.length} failed${skipped.length ? `, ${skipped.length} skipped (not passed)` : ""}`);
process.exit(failures.length ? 1 : 0);
