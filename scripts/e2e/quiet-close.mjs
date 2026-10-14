#!/usr/bin/env node
// E2E: a chat closed while quiet stays closed when a tab opens it again, and a send starts it once
// (§chat.transcript/instant-open, "A chat closed while its tab is open"; §app.chat-processes/idle-stop).
//
// A tab that mounts the chat's view (a reload, a discarded tab coming back, a crash restore, a click
// in the list) while the server holds no chat for it opens asleep: the rows come from the file, no
// /ws/chat opens, and no chat process starts. A send wakes it: one socket, one process, one run.
//
//   1. the chat's process stopped (as an idle stop leaves it), the list saying so;
//   2. a fresh tab opens it, and the page reloads: for N s each, no /ws/chat and no process;
//   3. a send: exactly one /ws/chat, one process start, the message once in the file, one reply.
//
// Step 3 makes ONE model call: the fixture's model is zai/glm-5.3, so the hermetic agent dir needs
// a zai login (copy auth.json in by hand). Processes are counted from /proc (Linux): each process
// whose environment names this chat (SOVA_CHAT_ID).
//
//   pnpm run build && pnpm run dev:hermetic        # in one terminal
//   node scripts/e2e/quiet-close.mjs                # in another
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't this
// worktree's .agent; SOVA_E2E_CDP, a browser already running (CDP URL); SOVA_E2E_QUIET_S, how long
// each quiet look lasts (default 5).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";
import { whenListed } from "./listed.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");
const QUIET_MS = Number(process.env.SOVA_E2E_QUIET_S ?? 5) * 1000;

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

try {
  const d = await api("/api/settings/decisions");
  assert(d.file.startsWith(AGENT + "/"), `the server on ${PORT} writes ${d.file}, not into ${AGENT}: start this worktree's hermetic server`);
} catch (err) {
  console.error(`preflight: ${err.message}`);
  process.exit(2);
}
if (!existsSync(join(SKILL, "node_modules", "playwright"))) {
  console.error(`preflight: no playwright in ${SKILL}/node_modules`);
  process.exit(2);
}

// ---- the fixture: a short chat on zai/glm-5.3 ----
const cwd = join(AGENT, "e2e-quiet-close-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const id = `01a0e2e0-0000-7000-8000-${String(Date.now()).slice(-12)}`;
const path = join(dir, `2026-10-14T00-00-00-000Z_${id}.jsonl`);
{
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-10-14T00:00:00.000Z", cwd }];
  let parent = null;
  for (let i = 0; i < 4; i++) {
    const at = `2026-10-14T00:00:0${i}.000Z`;
    lines.push({ type: "message", id: `u${i}`, parentId: parent, timestamp: at, message: { role: "user", content: [{ type: "text", text: `question ${i}` }], timestamp: 0 } });
    lines.push({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }], provider: "zai", model: "glm-5.3", api: "openai-completions", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } });
    parent = `a${i}`;
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const old = new Date("2026-10-14T00:01:00.000Z");
  utimesSync(path, old, old);
}

/** The pids of every process now running this chat (its environment names it). */
function chatPids() {
  const out = [];
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (readFileSync(`/proc/${p}/environ`, "latin1").split("\0").includes(`SOVA_CHAT_ID=${id}`)) out.push(Number(p));
    } catch {}
  }
  return out;
}
/** Every pid of this chat seen while it runs, polled every 100 ms. */
const seenPids = new Set();
let watching = true;
void (async () => {
  while (watching) {
    for (const p of chatPids()) seenPids.add(p);
    await sleep(100);
  }
})();

async function makeCold() {
  spawnSync("bun", [join(ROOT, "scripts/stop-chats.ts"), "--agent-dir", AGENT], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 200; i++) {
    if (!(await whenListed(api, [path], "path")).get(path).chat && !chatPids().length) return;
    await sleep(100);
  }
  throw new Error("the chat did not stop");
}

const { chromium } = createRequire(join(SKILL, "package.json"))("playwright");
let cdpPort = null;
let cdp = process.env.SOVA_E2E_CDP;
if (!cdp) {
  const started = execFileSync(join(SKILL, "start-browser.sh"), ["--headless"], { cwd: SKILL, stdio: ["ignore", "pipe", "pipe"] }).toString();
  cdpPort = /PW_PORT=(\d+)/.exec(started)?.[1];
  if (!cdpPort) throw new Error(`start-browser.sh printed no PW_PORT:\n${started}`);
  cdp = `http://127.0.0.1:${cdpPort}`;
}
const browser = await chromium.connectOverCDP(cdp);

const userLines = () => readFileSync(path, "utf8").split("\n").filter((l) => l.includes('"role":"user"') && l.includes("QUIET-CLOSE-E2E"));
const repliesAfter = () => {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const at = lines.findIndex((l) => l.message?.role === "user" && JSON.stringify(l.message.content).includes("QUIET-CLOSE-E2E"));
  return at < 0 ? [] : lines.slice(at + 1).filter((l) => l.message?.role === "assistant" && l.message.stopReason !== "toolUse");
};

try {
  await makeCold();
  seenPids.clear();
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 820 } });
  await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
  const page = await ctx.newPage();
  const sockets = [];
  const frames = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws/chat")) return;
    sockets.push({ url: ws.url(), at: Date.now() });
    ws.on("framesent", (f) => frames.push(`> ${String(f.payload).slice(0, 160)}`));
    ws.on("framereceived", (f) => frames.push(`< ${String(f.payload).slice(0, 160)}`));
  });
  const target = encodeURIComponent(path);

  await page.goto(`${BASE}/#/s/${target}`);
  await page.waitForSelector(".thread > .entry[data-entry]", { timeout: 15_000 });
  await sleep(QUIET_MS);
  await check(`a fresh tab opens the closed chat over its rows from the file: no /ws/chat and no process within ${QUIET_MS / 1000} s`, async () => {
    assert(sockets.length === 0, `${sockets.length} /ws/chat opened`);
    assert(seenPids.size === 0, `a process started: ${[...seenPids]}`);
    assert(!(await whenListed(api, [path], "path")).get(path).chat, "the server holds the chat");
    assert(!(await page.locator(".chat-wait-note").count()), "a Connecting note shows");
  });

  await page.reload();
  await page.waitForSelector(".thread > .entry[data-entry]", { timeout: 15_000 });
  await sleep(QUIET_MS);
  await check(`a reload does the same: no /ws/chat and no process within ${QUIET_MS / 1000} s`, async () => {
    assert(sockets.length === 0, `${sockets.length} /ws/chat opened`);
    assert(seenPids.size === 0, `a process started: ${[...seenPids]}`);
  });

  const box = page.locator("textarea.composer-input");
  await box.fill("QUIET-CLOSE-E2E: reply with the single word ok");
  await box.press("Enter");
  for (let i = 0; i < 600 && repliesAfter().length === 0; i++) await sleep(100);
  await sleep(2_000);
  await check("a send wakes it: one /ws/chat, one process, the message once, one reply", () => {
    assert(sockets.length === 1, `${sockets.length} /ws/chat opened: ${JSON.stringify(sockets)}`);
    assert(seenPids.size === 1, `processes seen: ${[...seenPids]}`);
    assert(userLines().length === 1, `the message is in the file ${userLines().length} times`);
    assert(repliesAfter().length === 1, `${repliesAfter().length} replies after it`);
  });
  if (process.env.SOVA_E2E_DEBUG) console.log(frames.join("\n"), "\ncomposer:", await box.inputValue().catch(() => "?"));
  await ctx.close();
} finally {
  watching = false;
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
