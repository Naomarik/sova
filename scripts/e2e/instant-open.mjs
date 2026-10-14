#!/usr/bin/env node
// E2E: a chat opens on its saved rows while it starts (§chat.transcript/instant-open), and a file
// read that never answers doesn't hold the chat's socket.
//
// The view reads the session's newest rows (GET /api/transcript?…&tail=1) before it opens /ws/chat,
// so the socket can name the last row it holds (`have=`). A read that hangs must not keep the chat
// from opening: past about 1.5 s the socket opens naming no row, the hello brings the rows, and Send
// works once that hello has come. Two runs on a cold chat (its process stopped first):
//   1. the read answered: the chat opens asleep over those rows, no /ws/chat and Send usable (the
//      server doesn't hold it, so reading it starts nothing); a wake (opening the mode menu) opens
//      /ws/chat with `have=`, and the hello says `after`.
//   2. the read held unanswered (the route is never fulfilled): no rows to show, so /ws/chat opens
//      at ~1.5 s with no `have=`, the hello is a whole one, and Send (with text typed) stays
//      aria-disabled until that hello and is enabled after it.
//
// Drives a hermetic server serving the built app, through the playwright skill's browser:
//
//   pnpm run build && pnpm run dev:hermetic        # in one terminal
//   pnpm run e2e:instant-open                       # in another
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't this
// worktree's .agent; SOVA_E2E_CDP, a browser already running (CDP URL); SOVA_E2E_CHROMIUM, a
// Chromium binary to launch directly instead of the skill's start-browser.sh.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";
import { whenListed } from "./listed.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");
/** src/lib/chat-wait.ts FILE_READ_WAIT_MS. */
const WAIT_MS = 1_500;

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
const api = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: tokenHeaders(AGENT) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- preflight: the server is the hermetic one on AGENT ----
try {
  const d = await api("/api/settings/decisions");
  assert(d.file.startsWith(AGENT + "/"), `the server on ${PORT} writes ${d.file}, not into ${AGENT}: start this worktree's hermetic server (pnpm run dev:hermetic)`);
} catch (err) {
  console.error(`preflight: ${err.message}`);
  process.exit(2);
}
if (!existsSync(join(SKILL, "node_modules", "playwright"))) {
  console.error(`preflight: no playwright in ${SKILL}/node_modules — run npm ci there, or symlink another checkout's`);
  process.exit(2);
}

// ---- the fixture: a short top-level chat ----

const cwd = join(AGENT, "e2e-instant-open-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const id = "01a0e2e0-0000-7000-8000-00000010a001";
const path = join(dir, `2026-09-28T00-00-00-000Z_${id}.jsonl`);
{
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-09-28T00:00:00.000Z", cwd }];
  let parent = null;
  for (let i = 0; i < 12; i++) {
    const at = `2026-09-28T00:00:${String(i).padStart(2, "0")}.000Z`;
    lines.push({ type: "message", id: `u${i}`, parentId: parent, timestamp: at, message: { role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: 0 } });
    lines.push({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }], provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 } });
    parent = `a${i}`;
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Written long ago: a file an unknown process wrote in the last 2 minutes opens read only.
  const old = new Date("2026-09-28T00:01:00.000Z");
  utimesSync(path, old, old);
}

/** The chat's process stopped, and the list saying so. */
async function makeCold() {
  spawnSync("bun", [join(ROOT, "scripts/stop-chats.ts"), "--agent-dir", AGENT], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 200; i++) {
    // A row not listed yet is no answer: only a listed row without `chat` says the chat stopped.
    if (!(await whenListed(api, [path], "path")).get(path).chat) return;
    await sleep(100);
  }
  throw new Error("the chat did not stop");
}

// ---- the browser ----

const { chromium } = createRequire(join(SKILL, "package.json"))("playwright");
let cdpPort = null;
let browser;
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

/** Every frame from the open on: when Send (with text typed) is enabled, and the rows on screen. */
const RECORDER = () => {
  const R = (window.__open = { sendEnabledAt: null, sendDisabledSeen: false, rowsAt: null, typed: false });
  const tick = () => {
    const box = document.querySelector("textarea.composer-input");
    if (box && !R.typed) {
      // Typed as a person would, so Send's state is the connection's, not an empty draft's.
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(box, "typed while it starts");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      R.typed = true;
    }
    const send = document.querySelector(".composer-actions .button-primary");
    if (R.typed && send) {
      if (send.getAttribute("aria-disabled") === "true") R.sendDisabledSeen = true;
      else if (R.sendEnabledAt === null) R.sendEnabledAt = Date.now();
    }
    if (R.rowsAt === null && document.querySelector(".thread > .entry[data-entry]")) R.rowsAt = Date.now();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** Opens the chat cold in a fresh tab (nothing kept), the file read held or not; what happened.
    `wake`: once Send is usable, wait, count the sockets, then open the mode menu (a wake). */
async function openCold(hold, wake = false) {
  await makeCold();
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 820 } });
  await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
  const page = await ctx.newPage();
  const seen = { readAt: null, ws: [] };
  const target = encodeURIComponent(path);
  await page.route(
    (url) => url.pathname === "/api/transcript" && url.search.includes(`path=${target}`) && url.searchParams.get("tail") === "1",
    (route) => {
      seen.readAt ??= Date.now();
      if (!hold) void route.continue();
      // held: never answered, as a stalled read would be
    },
  );
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws/chat")) return;
    const rec = { url: ws.url(), at: Date.now(), helloAt: null, hello: null };
    seen.ws.push(rec);
    ws.on("framereceived", (f) => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m.type === "hello" && rec.helloAt === null) {
          rec.helloAt = Date.now();
          rec.hello = { items: m.items.length, after: m.after ?? null };
        }
      } catch {}
    });
  });
  await page.addInitScript(RECORDER);
  const t0 = Date.now();
  await page.goto(`${BASE}/#/s/${target}`);
  await page.waitForFunction(() => window.__open?.sendEnabledAt !== null, null, { timeout: 30_000 }).catch(() => {});
  const rec = await page.evaluate(() => window.__open);
  let beforeWake = null;
  if (wake) {
    await sleep(2_500);
    beforeWake = seen.ws.length;
    await page.getByRole("button", { name: /^Mode:/ }).first().click();
    for (let i = 0; i < 100 && !seen.ws[0]?.helloAt; i++) await sleep(100);
    await page.keyboard.press("Escape");
  }
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  // Leave no draft behind for the next run.
  await page.evaluate(() => {
    const box = document.querySelector("textarea.composer-input");
    if (!box) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(300);
  await ctx.close();
  if (process.env.SOVA_E2E_DEBUG) console.log(JSON.stringify({ t0, beforeWake, ...seen, ...rec }, null, 1));
  return { t0, beforeWake, ...seen, ...rec };
}

try {
  const answered = await openCold(false, true);
  await check("an answered read on a chat the server doesn't hold: its rows, Send usable, and no socket (reading it starts nothing)", () => {
    assert(answered.readAt !== null && answered.rowsAt !== null, `read ${answered.readAt}, rows ${answered.rowsAt}`);
    assert(answered.sendEnabledAt !== null, "Send never usable");
    assert(answered.beforeWake === 0, `${answered.beforeWake} /ws/chat opened before any wake`);
  });
  await check("…a wake opens the socket naming the last row; the hello carries only what follows", () => {
    const ws = answered.ws[0];
    assert(ws, "no /ws/chat after the wake");
    assert(ws.url.includes("&have="), `no have= in ${ws.url}`);
    assert(ws.hello && ws.hello.after === "a11:0" && ws.hello.items === 0, `hello ${JSON.stringify(ws.hello)}`);
    assert(answered.rowsAt < ws.helloAt, "rows were on screen before the hello");
  });

  const held = await openCold(true);
  await check("a read held unanswered: /ws/chat still opens, at about 1.5 s, naming no row", () => {
    const ws = held.ws[0];
    assert(held.readAt !== null, "the file read was never asked");
    assert(ws, "no /ws/chat socket within 30 s");
    const after = ws.at - held.readAt;
    assert(after >= WAIT_MS - 100 && after <= WAIT_MS + 1_000, `opened ${after} ms after the read was asked`);
    assert(!ws.url.includes("have="), `named a row it never painted: ${ws.url}`);
  });
  await check("…its hello is the whole one, and Send waits for it, then enables", () => {
    const ws = held.ws[0];
    assert(ws?.helloAt, "no hello");
    assert(ws.hello.after === null && ws.hello.items > 0, `hello ${JSON.stringify(ws.hello)}`);
    assert(held.sendDisabledSeen, "Send was never aria-disabled while the chat started");
    assert(held.sendEnabledAt !== null, "Send never enabled");
    // helloAt is stamped in Node when CDP reports the frame, after the page already has it: allow that lag.
    assert(held.sendEnabledAt >= ws.helloAt - 25, `Send enabled ${ws.helloAt - held.sendEnabledAt} ms before the hello`);
    assert(held.rowsAt !== null && held.rowsAt >= ws.helloAt - 25, "rows came from the hello");
  });
} finally {
  await browser.close().catch(() => {});
  if (cdpPort) {
    try {
      execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
    } catch {}
  }
  spawnSync("bun", [join(ROOT, "scripts/stop-chats.ts"), "--agent-dir", AGENT], { cwd: ROOT, stdio: "ignore" });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
