#!/usr/bin/env node
// E2E: the running commands' bar (§chat.shell-mode/card), driven in a real browser.
//
// With exactly 1 `!` command running, the bar above the message box offers Show Output and Stop
// Command and no Show All. With 2 or more it offers Show All (the list, with Stop All) and no Show
// Output. With the list open, the count falling to 1 collapses the bar to the single command's form:
// the list closes and focus goes to the bar's Show Output, never to the page. At a phone's width
// (390×844) and a desktop's (1280×800). It stops every command it starts.
//
//   pnpm run build && pnpm run e2e:shell-bar
//
// By default it hosts its own server (scripts/e2e/self-hosted.mjs). Against one already running
// (say `pnpm run dev:hermetic`): SOVA_E2E_PORT=<its port>, SOVA_E2E_AGENT its agent dir when it
// isn't this worktree's .agent. SOVA_E2E_SHOTS=<dir> also writes {phone,desktop}-{one,two,collapsed}.png
// there. SOVA_E2E_CDP, a browser already running (CDP URL); SOVA_E2E_CHROMIUM, a Chromium binary to
// launch directly instead of the skill's start-browser.sh.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";
import { whenListed } from "./listed.mjs";
import { selfHosted } from "./self-hosted.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SELF = process.env.SOVA_E2E_PORT ? null : await selfHosted({ label: "e2e-shell-bar" }).catch((err) => {
  console.error(`self-hosted server: ${err.message}`);
  process.exit(2);
});
if (SELF) delete process.env.SOVA_TOKEN;
const AGENT = SELF ? SELF.agent : resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = SELF ? SELF.port : Number(process.env.SOVA_E2E_PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SOVA_E2E_SHOTS ? resolve(process.env.SOVA_E2E_SHOTS) : null;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");
const exit = async (code) => {
  await SELF?.stop();
  process.exit(code);
};

let passed = 0;
const failures = [];
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
/** Playwright: the skill's, else the copy this checkout installed (playwright-core). */
function loadPlaywright() {
  if (existsSync(join(SKILL, "node_modules", "playwright"))) return createRequire(join(SKILL, "package.json"))("playwright");
  try {
    return createRequire(join(ROOT, "package.json"))("playwright-core");
  } catch {
    return null;
  }
}
const playwright = loadPlaywright();
if (!playwright) {
  console.error(`preflight: no playwright in ${SKILL}/node_modules nor playwright-core in this checkout`);
  await exit(2);
}

// ---- fixture: one plain session in a folder of its own ----
const cwd = join(AGENT, "e2e-shell-bar-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const ID = "01a0e2e0-0000-7000-8000-0000005be11a";
const file = join(dir, `2026-10-20T00-00-00-000Z_${ID}.jsonl`);
const t0 = Date.parse("2026-10-20T00:00:00.000Z");
writeFileSync(
  file,
  [
    { type: "session", version: 3, id: ID, timestamp: new Date(t0).toISOString(), cwd },
    { type: "message", id: "u0", parentId: null, timestamp: new Date(t0 + 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: "Shell bar walkthrough" }], timestamp: 0 } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n",
);
// A fresh write from no process Sova knows opens read-only (a watched session, "recent").
utimesSync(file, new Date(t0), new Date(t0));
const [[, summary]] = [...(await whenListed(api, [ID]))];
const HASH = `#/s/${encodeURIComponent(summary.path)}`;

// ---- the browser ----
const { chromium } = playwright;
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

/** A command that runs a minute unless stopped, its output one line a second. */
const loop = (name) => `for i in $(seq 1 60); do echo ${name} line $i; sleep 1; done`;
/** What the bar shows, read in the page. */
const barState = (page) =>
  page.evaluate(() => ({
    buttons: [...document.querySelectorAll(".shell-bar .button")].map((b) => b.textContent.trim()),
    toggle: !!document.querySelector(".shell-bar-toggle"),
    rows: document.querySelectorAll(".shell-list-row").length,
    running: document.querySelector(".shell-bar .chip")?.textContent?.trim() ?? null,
    active: document.activeElement === document.body ? "body" : document.activeElement?.textContent?.trim() ?? null,
  }));
async function runCommand(page, command) {
  const box = page.locator("#composer-input");
  await box.click();
  await page.keyboard.type(`!${command}`);
  await page.keyboard.press("Enter");
}
async function waitRunning(page, n) {
  await page.waitForFunction((n) => document.querySelector(".shell-bar .chip")?.textContent?.trim() === `${n} running`, n, { timeout: 30000 });
}
/** Stops whatever still runs: Stop Command on the bar, else Stop All from the open list. */
async function stopEverything(page) {
  for (let i = 0; i < 5; i++) {
    const s = await barState(page);
    if (!s.running) return;
    if (s.toggle && s.rows === 0) await page.locator(".shell-bar-toggle").click();
    const stop = page.locator(".shell-bar .button", { hasText: /^(Stop Command|Stop All \d+)$/ });
    if (await stop.count()) await stop.first().click();
    await sleep(2000);
  }
}

const sizes = [
  ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }],
  ["desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }],
];
try {
  for (const [name, device] of sizes) {
    console.log(`${name}:`);
    const ctx = await browser.newContext({ serviceWorkers: "block", ...device });
    await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/${HASH}`);
      await page.locator("#composer-input").waitFor({ timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector(".composer-reason")?.textContent?.match(/onnect/), null, { timeout: 30000 });

      await check("1 running: Show Output and Stop Command on the bar, no Show All", async () => {
        await runCommand(page, loop(`${name}-a`));
        await waitRunning(page, 1);
        const s = await barState(page);
        assert(!s.toggle, "no Show All toggle with 1 running");
        assert(s.buttons.join(",") === "Show Output,Stop Command", `bar buttons: ${s.buttons.join(", ")}`);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-one.png`) });
      });

      await check("2 running: Show All and no Show Output; Stop All once the list is open", async () => {
        await runCommand(page, loop(`${name}-b`));
        await waitRunning(page, 2);
        let s = await barState(page);
        assert(s.toggle, "Show All toggle with 2 running");
        assert(!s.buttons.includes("Show Output"), `bar buttons: ${s.buttons.join(", ")}`);
        await page.locator(".shell-bar-toggle").click();
        await page.waitForFunction(() => document.querySelectorAll(".shell-list-row").length === 2, null, { timeout: 10000 });
        s = await barState(page);
        assert(s.buttons.join(",") === "Stop All 2", `bar buttons with the list open: ${s.buttons.join(", ")}`);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-two.png`) });
      });

      await check("2 to 1 with the list open: the list closes, the bar is the single command's, focus on its Show Output", async () => {
        await page.locator(".shell-list-row").first().getByRole("button", { name: "Stop Command" }).click();
        await waitRunning(page, 1);
        await page.waitForFunction(() => document.querySelectorAll(".shell-list-row").length === 0, null, { timeout: 10000 });
        await sleep(300);
        const s = await barState(page);
        assert(!s.toggle, "no Show All after the collapse");
        assert(s.buttons.join(",") === "Show Output,Stop Command", `bar buttons: ${s.buttons.join(", ")}`);
        assert(s.active === "Show Output", `focus on ${s.active}`);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-collapsed.png`) });
      });
    } finally {
      await stopEverything(page).catch(() => {});
      await ctx.close();
    }
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

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
