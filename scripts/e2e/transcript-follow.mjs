#!/usr/bin/env node
// E2E: a transcript left at the end comes back at the end, following, with no Jump to Latest
// (§chat.transcript/rendering "Switching back", §chat.transcript/live-watch "Auto-follow"), and
// following still stops only for the reader.
//
// Rows drawn with a disclosure already open (an alignment's approach) fire `toggle` as they're
// built; that once read as the reader opening a disclosure, so a switch back to a session ending in
// alignments stopped following and showed Jump to Latest, short of the end. Fixture sessions end in
// alignment cards and are switched back and forth; every frame after each open is sampled. Then the
// regressions: a wheel or key scrolling up stops following, opening a disclosure by mouse or key
// keeps the view, a Timeline jump stops following, the view narrowing or widening keeps it.
//
// Live rows count as read: a chat left at the end while a turn ran, or with a message queued,
// comes back at the end with no Jump to Latest (the running turn's rows and the queued message were
// drawn when the reader left), while a turn that started and ended while away still stops at the
// last row read with "· 2 new". These run real turns, on scripts/fake-claude.mjs: start the server
// with `PATH="$(scripts/fake-claude-path.sh):$PATH" CLAUDE_CONFIG_DIR=<fixture login dir>` (the
// Claude Code provider is always on; CLAUDE.md, "Claude logins in a hermetic run"). Without the fake they are skipped, never passed.
//
// Writes its fixtures into the hermetic agent dir and drives a hermetic server — `pnpm run
// dev:hermetic` in THIS worktree, serving the built app (`pnpm run build` first) — through the
// playwright skill's own browser.
//
//   pnpm run build && pnpm run dev:hermetic        # in one terminal
//   pnpm run e2e:transcript-follow                  # in another
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't this
// worktree's .agent; SOVA_E2E_CDP, a browser already running (CDP URL) instead of starting one.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");

let passed = 0;
const failures = [];
const skipped = [];
/** A check that can't run here: said, and counted apart, never as passed. */
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

// ---- the fixtures: long sessions ending in alignment cards (and one without) ----

const words = (n, seed) => Array.from({ length: n }, (_, i) => ["follow", "bottom", "switch", "align", "approach", "toggle", "frame", "end"][(i * 5 + seed) % 8]).join(" ");
const cwd = join(AGENT, "e2e-follow-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });

/** An align tool call and its result: the row drawn as an alignment card, approach open. */
function alignPair(push, k, seed) {
  const call = `call_f${seed}_${k}`;
  const doc = {
    id: `al_${k + 1}`,
    title: `Fixture alignment ${k + 1}`,
    summary: words(18, seed + k),
    findings: Array.from({ length: 3 }, (_, i) => ({ id: `f${i + 1}`, text: words(25 + i * 9, seed + i) })),
    approach: Array.from({ length: 3 + (k % 3) }, (_, i) => ({ id: `a${i + 1}`, text: words(30 + i * 7, seed + k + i) })),
    rejected: [],
    questions: [{ id: "q1", topic: "Layout", ask: `${words(9, seed)}?`, recommendation: { choice: "B", why: words(12, seed) }, options: [{ label: "A", tradeoff: words(14, seed) }, { label: "B", tradeoff: words(16, seed + 1) }] }],
    phase: "aligning",
    next: { f: 4, a: 7, x: 1, q: 2 },
    rev: 1,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
  push({
    type: "message",
    id: `ac${seed}_${k}`,
    message: { role: "assistant", content: [{ type: "toolCall", id: call, name: "align", arguments: { doc: "new", ops: [] } }], provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "toolUse", timestamp: 0 },
  });
  push({
    type: "message",
    id: `ar${seed}_${k}`,
    message: { role: "toolResult", toolCallId: call, toolName: "align", content: [{ type: "text", text: `${doc.id} "${doc.title}" · aligning · 1 open · v1` }], details: { v: 1, changes: [], line: "", doc }, isError: false, timestamp: 0 },
  });
}

/** Each fixture's file, by session id. */
const FILES = new Map();
function writeSession(id, seed, { aligns }) {
  const file = join(dir, `2026-09-28T00-00-0${seed}-000Z_${id}.jsonl`);
  FILES.set(id, file);
  const t0 = Date.parse("2026-09-28T00:00:00.000Z") + seed * 3_600_000;
  const lines = [{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const push = (e) => {
    lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
    parent = e.id;
  };
  for (let i = 0; i < 160; i++) {
    push({ type: "message", id: `u${seed}_${i}`, message: { role: "user", content: [{ type: "text", text: `Question ${i}: ${words(6 + ((i * 31) % 60), i + seed)}` }], timestamp: 0 } });
    const content = [{ type: "text", text: Array.from({ length: 1 + (i % 3) }, (_, k) => words(25 + ((i * 41 + k * 17) % 120), i + k + seed)).join("\n\n") }];
    // The last answer thinks first: a closed disclosure near the end, for the regressions.
    if (i === 159) content.unshift({ type: "thinking", thinking: Array.from({ length: 12 }, (_, k) => words(40, k)).join("\n\n") });
    push({ type: "message", id: `a${seed}_${i}`, message: { role: "assistant", content, provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 } });
    if (aligns && (i % 40 === 20 || (i > 120 && i % 6 === 0))) alignPair(push, i, seed);
  }
  if (aligns) for (let k = 0; k < aligns; k++) alignPair(push, 200 + k, seed);
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  // Rewritten only when it differs: a server already holding it reloads on a foreign write.
  if (existsSync(file) && readFileSync(file, "utf8") === text) return id;
  writeFileSync(file, text);
  // Written long ago, as far as the server can tell (server/write-guard.ts refuses a fresh foreign write).
  const past = new Date(t0);
  utimesSync(file, past, past);
  return id;
}
const SESSIONS = [
  writeSession("01a0e2e0-0000-7000-8000-0000000f0a11", 1, { aligns: 2 }),
  writeSession("01a0e2e0-0000-7000-8000-0000000f0a12", 2, { aligns: 3 }),
  writeSession("01a0e2e0-0000-7000-8000-0000000f0a13", 3, { aligns: 1 }),
  writeSession("01a0e2e0-0000-7000-8000-0000000f0a14", 4, { aligns: 0 }),
  // Rows are appended to this one while it is away: rewritten every run.
  writeSession("01a0e2e0-0000-7000-8000-0000000f0a15", 5, { aligns: 0 }),
];

// ---- the browser ----

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

/** Every frame, once that frame's own callbacks (the transcript's settle) have run: how far the
    view is from the end and whether Jump to Latest shows. Restarts for each new transcript. */
const RECORDER = () => {
  const R = (window.__follow = { gen: 0, log: [], at: 0 });
  let el = null;
  const sample = (t) => {
    if (t !== el) return;
    const pill = t.parentElement?.querySelector(".jump-latest");
    R.log.push({ t: Math.round(performance.now() - R.at), gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight), pill: !!pill?.hasAttribute("data-shown"), rows: t.querySelectorAll(".thread > .entry").length });
  };
  const tick = () => {
    const t = document.getElementById("transcript");
    if (t && t !== el) {
      el = t;
      R.gen++;
      R.at = performance.now();
      R.log = [];
    }
    if (t) setTimeout(() => sample(t), 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const paths = new Map();
async function newPage() {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
  await ctx.addInitScript(RECORDER);
  const page = await ctx.newPage();
  if (!paths.size) {
    const list = await api("/api/sessions");
    for (const s of list.sessions ?? list) if (SESSIONS.includes(s.id)) paths.set(s.id, s.path);
    for (const id of SESSIONS) assert(paths.has(id), `the fixture ${id} isn't listed by the server`);
  }
  return { ctx, page };
}
const hashOf = (id) => `#/s/${encodeURIComponent(paths.get(id))}`;
/** Opens a session (a switch, in the same tab) and waits for its transcript's rows. */
async function open(page, id) {
  if (page.url() === "about:blank") await page.goto(`${BASE}/${hashOf(id)}`);
  else {
    const gen = await page.evaluate(() => window.__follow.gen);
    await page.evaluate((h) => (location.hash = h), hashOf(id));
    await page.waitForFunction((g) => window.__follow.gen > g, gen, { timeout: 30000 });
  }
  await page.waitForFunction(() => window.__follow.log.at(-1)?.rows > 5, null, { timeout: 30000 });
}
/** Waits until no rows are added for a while (the idle build has stopped). */
async function filled(page) {
  let last = -1;
  for (let still = 0, k = 0; still < 6 && k < 80; k++) {
    await sleep(250);
    const n = await page.evaluate(() => window.__follow.log.at(-1)?.rows ?? 0);
    still = n === last ? still + 1 : 0;
    last = n;
  }
}
const now = (page) => page.evaluate(() => window.__follow.log.at(-1));
const frames = (page) => page.evaluate(() => window.__follow.log);
/** Back to the end the way a reader goes: Jump to Latest when it shows, since a scroll the reader
    didn't make never follows again (§chat.transcript/turn-end-keeps-reader). */
const toEnd = async (page) => {
  const pill = page.locator(".jump-latest[data-shown]").first();
  if (await pill.count()) await pill.click({ timeout: 2000 }).catch(() => {});
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    t.scrollTop = t.scrollHeight;
  });
};

try {
  console.log(`transcript-follow e2e against ${BASE} (agent dir ${AGENT})`);

  for (const dwell of [50, 400]) {
    await check(`switching between sessions ending in alignments (${dwell} ms away): each opens at the end, no Jump to Latest`, async () => {
      const { ctx, page } = await newPage();
      const [a, b, c, plain] = SESSIONS;
      const bad = [];
      const order = [a, b, a, b, c, a, plain, b, c, a];
      for (const [k, id] of order.entries()) {
        await open(page, id);
        await sleep(dwell);
        // Away quickly, a page still loading may not have reached the end yet; the last open, and
        // every open given time, must.
        const settled = dwell > 100 || k === order.length - 1;
        if (settled) await filled(page);
        // The first frames of an open may come before its rows are scrolled to: from the frame
        // that first reaches the end on, the view stays there (a row growing is put back within a
        // frame or two, as while following anywhere); Jump to Latest never shows.
        const log = await frames(page);
        const reached = log.findIndex((f) => f.rows > 5 && f.gap < 2);
        const after = reached < 0 ? [] : log.slice(reached);
        const left = after.find((f, i) => after.slice(i, i + 4).length === 4 && after.slice(i, i + 4).every((g) => g.gap >= 2));
        const pill = log.find((f) => f.pill);
        const off = settled && (reached < 0 || log.at(-1).gap >= 2) ? log.at(-1) : null;
        if (pill || left || off) bad.push(`${id.slice(-4)}: ${JSON.stringify(pill ?? left ?? off)}`);
        await toEnd(page);
        await sleep(60);
      }
      await ctx.close();
      assert(bad.length === 0, `left the end or showed Jump to Latest: ${bad.join("; ")}`);
    });
  }

  await check("left at the end, rows added while away: it opens at the last row read with Jump to Latest · N new; with none, at the end", async () => {
    const { ctx, page } = await newPage();
    const away = SESSIONS[4];
    const other = SESSIONS[3];
    await open(page, away);
    await filled(page);
    await toEnd(page);
    await sleep(300);
    const lastRead = await page.evaluate(() => [...document.querySelectorAll("#transcript .thread > .entry")].filter((e) => e.getBoundingClientRect().height > 0).at(-1)?.dataset.entry);
    assert(lastRead, "no last row at the end");
    await open(page, other);
    await filled(page);
    // Four rows, each taller than the view's following margin together.
    const lines = readFileSync(FILES.get(away), "utf8").trim().split("\n");
    let parent = JSON.parse(lines.at(-1)).id;
    const added = [0, 1, 2, 3].map((i) => {
      const id = `away${Date.now().toString(36)}${i}`;
      const e = { type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message: i % 2 ? { role: "assistant", content: [{ type: "text", text: words(120, i) }], provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 } : { role: "user", content: [{ type: "text", text: `Added while away ${i}: ${words(30, i)}` }], timestamp: 0 } };
      parent = id;
      return JSON.stringify(e);
    });
    writeFileSync(FILES.get(away), lines.concat(added).join("\n") + "\n");
    await sleep(1500);
    await open(page, away);
    await filled(page);
    const r = await page.evaluate((id) => {
      const t = document.getElementById("transcript");
      const row = t.querySelector(`.thread > .entry[data-entry="${CSS.escape(id)}"]`);
      const pill = t.parentElement.querySelector(".jump-latest");
      return { off: row ? Math.round(row.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom) : null, pill: pill.hasAttribute("data-shown") ? pill.textContent : null, gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight) };
    }, lastRead);
    assert(r.pill === "Jump to Latest · 4 new", `the pill reads ${JSON.stringify(r.pill)}, wanted "Jump to Latest · 4 new" (${JSON.stringify(r)})`);
    assert(r.off !== null && Math.abs(r.off) <= 2, `the last row read isn't at the bottom of the view: ${JSON.stringify(r)}`);
    await page.locator(".jump-latest").click();
    await sleep(400);
    let s = await now(page);
    assert(!s.pill && s.gap < 2, `after Jump to Latest: ${JSON.stringify(s)}`);
    // Away again with nothing added: back at the end, following.
    await open(page, other);
    await filled(page);
    await open(page, away);
    await filled(page);
    s = await now(page);
    const log = await frames(page);
    assert(!log.some((f) => f.pill) && s.gap < 2, `with no rows added: ${JSON.stringify(s)}`);
    await ctx.close();
  });

  // ---- live rows: a running turn's and a queued message's rows were read when the reader left ----
  const fake = await api("/api/settings/claude-status").catch((err) => ({ error: String(err?.message ?? err) }));
  const LIVE = [
    "a queued message: six switches back with a turn running and a message queued each open at the end, the queued message in view, no Jump to Latest",
    "left mid-turn, back after the turn ended: at the end, no Jump to Latest",
    "a turn started and ended while away: it stops at the last row read with Jump to Latest · 2 new",
  ];
  if (!/fake/i.test(fake.version ?? "")) {
    for (const name of LIVE) skip(name, `the server's claude isn't scripts/fake-claude.mjs (${JSON.stringify(fake)}): start it with PATH="$(scripts/fake-claude-path.sh):$PATH" (see this file's head)`);
  } else {
    const liveCwd = join(AGENT, "e2e-follow-live-cwd");
    mkdirSync(liveCwd, { recursive: true });
    const liveDir = join(AGENT, "sessions", `--${liveCwd.replace(/^\//, "").replace(/\//g, "-")}--`);
    mkdirSync(liveDir, { recursive: true });
    /** A fresh chat on the claude-code provider (the fake answers it), 40 turns long; its path. */
    let made = 0;
    const liveSession = async () => {
      const k = `${Date.now().toString(16)}${made++}`.padStart(12, "0").slice(-12);
      const id = `01a0e2e1-0000-7000-8000-${k}`;
      const file = join(liveDir, `2026-09-29T00-00-00-000Z_${id}.jsonl`);
      const t0 = Date.parse("2026-09-29T00:00:00.000Z");
      const lines = [{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: liveCwd }];
      let parent = null;
      let n = 0;
      const push = (e) => {
        lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
        parent = e.id;
      };
      push({ type: "model_change", id: `m${k}`, provider: "claude-code-cli", modelId: "sonnet" });
      // A reply the provider builds its next request from carries its usage.
      const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      for (let i = 0; i < 40; i++) {
        push({ type: "message", id: `u${k}_${i}`, message: { role: "user", content: [{ type: "text", text: `Q${i}: ${words(8 + ((i * 31) % 50), i)}` }], timestamp: 0 } });
        push({ type: "message", id: `a${k}_${i}`, message: { role: "assistant", content: [{ type: "text", text: words(30 + ((i * 41) % 120), i) }], provider: "claude-code-cli", model: "sonnet", api: "anthropic-messages", stopReason: "stop", usage, timestamp: 0 } });
      }
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      utimesSync(file, new Date(t0), new Date(t0));
      for (let i = 0; i < 50; i++) {
        const list = await api("/api/sessions");
        if ((list.sessions ?? list).some((s) => s.path === file)) return file;
        await sleep(300);
      }
      throw new Error(`the server never listed ${file}`);
    };
    const openPath = async (page, path) => {
      const hash = `#/s/${encodeURIComponent(path)}`;
      if (page.url() === "about:blank") await page.goto(`${BASE}/${hash}`);
      else {
        const gen = await page.evaluate(() => window.__follow.gen);
        await page.evaluate((h) => (location.hash = h), hash);
        await page.waitForFunction((g) => window.__follow.gen > g, gen, { timeout: 30000 });
      }
      await page.waitForFunction(() => window.__follow.log.at(-1)?.rows > 5, null, { timeout: 30000 });
    };
    /** Until the view, its rows and the pill have stopped changing. */
    const still = async (page) => {
      let last = "";
      for (let n = 0, k = 0; n < 5 && k < 40; k++) {
        await sleep(200);
        const s = await page.evaluate(() => {
          const t = document.getElementById("transcript");
          return JSON.stringify([t.scrollHeight, t.scrollTop, t.querySelectorAll(".thread > *").length, window.__follow.log.at(-1)?.pill]);
        });
        n = s === last ? n + 1 : 0;
        last = s;
      }
    };
    const sendText = async (page, text) => {
      const box = page.locator("textarea").first();
      await box.click();
      await box.fill(text);
      await page.keyboard.press("Enter");
      await page.locator("textarea").first().blur().catch(() => {});
    };
    const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i}: ${words(9, i)}`).join("\n");
    /** The view against the end, the pill, and where the row holding `mark` (if any) sits. */
    const view = (page, mark) =>
      page.evaluate((mark) => {
        const t = document.getElementById("transcript");
        const box = t.getBoundingClientRect();
        const pill = t.parentElement.querySelector(".jump-latest");
        const host = mark ? [...t.querySelectorAll(".message-actions-host")].filter((h) => h.textContent.includes(mark)).at(-1) : null;
        const msg = host ? (host.querySelector(".message") ?? host.firstElementChild)?.getBoundingClientRect() : null;
        return {
          gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight),
          pill: pill.hasAttribute("data-shown") ? pill.textContent : null,
          marked: msg ? { top: Math.round(msg.top - box.top), below: Math.round(msg.bottom - box.bottom), h: Math.round(msg.height) } : null,
        };
      }, mark);
    const stop = (page) => page.locator('button[aria-label="Stop"]').first().click({ timeout: 3000 }).catch(() => {});

    await check(LIVE[0], async () => {
      const { ctx, page } = await newPage();
      const [mine, other] = [await liveSession(), await liveSession()];
      await openPath(page, other);
      await openPath(page, mine);
      await still(page);
      await sendText(page, `[fake-slow 120000] ${lines(8, "running")}`);
      await sleep(1500);
      await sendText(page, `QUEUED-MARK ${lines(6, "queued follow-up")}`);
      await sleep(1500);
      await toEnd(page);
      await sleep(400);
      const before = await view(page, "QUEUED-MARK");
      assert(before.marked && before.gap < 2 && !before.pill, `before leaving, not at the end with the queued row drawn: ${JSON.stringify(before)}`);
      const bad = [];
      for (const [k, dwell] of [50, 400, 1500, 50, 600, 200].entries()) {
        await openPath(page, other);
        await sleep(dwell);
        await openPath(page, mine);
        await still(page);
        const r = await view(page, "QUEUED-MARK");
        if (r.gap >= 2 || r.pill || !r.marked || r.marked.below > 1) bad.push(`#${k} (${dwell} ms away): ${JSON.stringify(r)}`);
        await toEnd(page);
        await sleep(200);
      }
      await stop(page);
      await sleep(500);
      await ctx.close();
      assert(bad.length === 0, `came back short of the end: ${bad.join("; ")}`);
    });

    await check(LIVE[1], async () => {
      const { ctx, page } = await newPage();
      const [mine, other] = [await liveSession(), await liveSession()];
      await openPath(page, other);
      await openPath(page, mine);
      await still(page);
      await sendText(page, `[fake-slow 3000] ${lines(10, "mid-turn")}`);
      await sleep(1200);
      const before = await view(page);
      assert(before.gap < 2 && !before.pill, `before leaving: ${JSON.stringify(before)}`);
      await openPath(page, other);
      await sleep(4500);
      await openPath(page, mine);
      await still(page);
      const r = await view(page);
      await ctx.close();
      assert(r.gap < 2 && !r.pill, `came back short of the end: ${JSON.stringify(r)}`);
    });

    await check(LIVE[2], async () => {
      const { ctx, page } = await newPage();
      const [mine, other] = [await liveSession(), await liveSession()];
      await openPath(page, other);
      await openPath(page, mine);
      await still(page);
      await toEnd(page);
      await sleep(300);
      const lastRead = await page.evaluate(() => [...document.querySelectorAll("#transcript .thread > .entry")].filter((e) => e.getBoundingClientRect().height > 0).at(-1)?.dataset.entry);
      await openPath(page, other);
      // The turn, from another tab while this one is away.
      const second = await newPage();
      await openPath(second.page, mine);
      await still(second.page);
      await sendText(second.page, lines(12, "sent from another tab"));
      await second.page.waitForFunction(() => document.getElementById("transcript")?.textContent.includes("Fake answer from login"), null, { timeout: 15000 });
      await sleep(1000);
      await second.ctx.close();
      await openPath(page, mine);
      await still(page);
      const r = await page.evaluate((id) => {
        const t = document.getElementById("transcript");
        const row = t.querySelector(`.thread > .entry[data-entry="${CSS.escape(id)}"]`);
        const pill = t.parentElement.querySelector(".jump-latest");
        return { off: row ? Math.round(row.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom) : null, pill: pill.hasAttribute("data-shown") ? pill.textContent : null };
      }, lastRead);
      await ctx.close();
      assert(r.pill === "Jump to Latest · 2 new", `the pill reads ${JSON.stringify(r.pill)}, wanted "Jump to Latest · 2 new" (${JSON.stringify(r)})`);
      assert(r.off !== null && Math.abs(r.off) <= 2, `the last row read isn't at the bottom of the view: ${JSON.stringify(r)}`);
    });
  }

  // ---- regressions: following still stops for the reader, and only for the reader ----
  const { ctx, page } = await newPage();
  await open(page, SESSIONS[0]);
  await filled(page);
  await toEnd(page);
  await sleep(100);

  await check("a row growing at the end with a disclosure drawn open keeps following (no Jump to Latest)", async () => {
    // What a row built with its approach open does, in a task of its own (a socket message): the
    // disclosure's `toggle` comes before the frame that settles the growth.
    const bad = [];
    for (let k = 0; k < 5; k++) {
      const r = await page.evaluate(async () => {
        const t = document.getElementById("transcript");
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        t.scrollTop = t.scrollHeight;
        for (let i = 0; i < 3; i++) await frame();
        await new Promise((r) => setTimeout(r, 0));
        const last = [...t.querySelectorAll(".thread > .entry")].at(-1);
        const d = document.createElement("details");
        d.innerHTML = `<summary>drawn open</summary><div style="height:300px"></div>`;
        last.append(d);
        d.open = true;
        for (let i = 0; i < 4; i++) await frame();
        await new Promise((r) => setTimeout(r, 50));
        const out = { gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight), pill: t.parentElement.querySelector(".jump-latest").hasAttribute("data-shown") };
        d.remove();
        return out;
      });
      if (r.pill || r.gap >= 2) bad.push(JSON.stringify(r));
      await page.locator(".jump-latest").click({ timeout: 1000 }).catch(() => {});
      await sleep(100);
    }
    assert(bad.length === 0, `left the end: ${bad.join("; ")}`);
  });

  await check("a wheel scrolling up stops following and shows Jump to Latest; clicking it goes back to the end", async () => {
    const box = await page.locator("#transcript").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await sleep(400);
    let s = await now(page);
    assert(s.pill && s.gap >= 80, `after the wheel: ${JSON.stringify(s)}`);
    await page.locator(".jump-latest").click();
    await sleep(300);
    s = await now(page);
    assert(!s.pill && s.gap < 2, `after Jump to Latest: ${JSON.stringify(s)}`);
  });

  await check("a key scrolling up (Page Up) stops following and shows Jump to Latest", async () => {
    await page.locator("#transcript").focus();
    await page.keyboard.press("PageUp");
    await sleep(600);
    const s = await now(page);
    assert(s.pill && s.gap >= 80, `after Page Up: ${JSON.stringify(s)}`);
    await page.locator(".jump-latest").click();
    await sleep(300);
  });

  await check("a view the browser takes to the end (rows below leave) doesn't follow again; a wheel down there does", async () => {
    // Rows below the reader leaving, as a turn's streamed rows do at its end: the browser clamps
    // the view to the end with no input of the reader's.
    await page.evaluate(() => {
      const last = [...document.querySelectorAll("#transcript .thread > .entry")].at(-1);
      const d = document.createElement("div");
      d.id = "e2e-below";
      d.style.height = "3000px";
      last.append(d);
    });
    await toEnd(page);
    await sleep(300);
    const box = await page.locator("#transcript").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await sleep(1600); // past the reader's input
    let s = await now(page);
    assert(s.pill && s.gap >= 80, `after the wheel: ${JSON.stringify(s)}`);
    await page.evaluate(() => document.getElementById("e2e-below").remove());
    await sleep(1000); // a lower end counts for the reader's moves once it has stood 600 ms
    s = await now(page);
    assert(s.gap < 2 && s.pill, `clamped to the end, Jump to Latest must stay: ${JSON.stringify(s)}`);
    // Not following: content landing below leaves the view where it is.
    const grow = () =>
      page.evaluate(() => {
        const d = document.createElement("div");
        d.className = "e2e-grow";
        d.style.height = "300px";
        [...document.querySelectorAll("#transcript .thread > .entry")].at(-1).append(d);
      });
    await grow();
    await sleep(400);
    s = await now(page);
    assert(s.gap >= 290 && s.pill, `followed content it wasn't following: ${JSON.stringify(s)}`);
    // The reader's own scroll down to the end follows again; a wheel down there too. By key: after
    // the clamp, headless Chrome scrolls a wheel down nowhere until the view has moved once.
    await page.locator("#transcript").focus();
    await page.keyboard.press("End");
    await sleep(800);
    s = await now(page);
    assert(s.gap < 2 && !s.pill, `the reader's wheel down to the end: ${JSON.stringify(s)}`);
    await page.mouse.wheel(0, -200);
    await sleep(1600);
    await page.evaluate(() => document.querySelectorAll(".e2e-grow").forEach((d) => d.remove()));
    await sleep(1000);
    s = await now(page);
    assert(s.gap < 2 && s.pill, `clamped again: ${JSON.stringify(s)}`);
    await page.mouse.wheel(0, 200);
    await sleep(400);
    await grow();
    await sleep(400);
    s = await now(page);
    assert(s.gap < 2 && !s.pill, `a wheel down at the end follows again: ${JSON.stringify(s)}`);
    await page.evaluate(() => document.querySelectorAll(".e2e-grow").forEach((d) => d.remove()));
    await sleep(300);
  });

  /** The last closed disclosure in view (the last answer's thinking): its summary's top before
      and after `act`, the view's scrollTop, and whether the disclosure opened. */
  const disclosureKeeps = async (act) => {
    await toEnd(page);
    await sleep(150);
    const sel = await page.evaluate(() => {
      const t = document.getElementById("transcript");
      const view = t.getBoundingClientRect();
      const all = [...t.querySelectorAll("details:not([open]) > summary")].filter((s) => {
        const b = s.getBoundingClientRect();
        return b.height > 0 && b.top >= view.top && b.bottom <= view.bottom;
      });
      const s = all.at(-1);
      if (!s) return null;
      s.setAttribute("data-e2e-summary", "");
      return true;
    });
    assert(sel, "no closed disclosure in view at the end: the check compared nothing");
    const summary = page.locator("[data-e2e-summary]");
    const before = await page.evaluate(() => ({ top: document.getElementById("transcript").scrollTop, at: document.querySelector("[data-e2e-summary]").getBoundingClientRect().top }));
    await act(summary);
    await sleep(500);
    const after = await page.evaluate(() => {
      const s = document.querySelector("[data-e2e-summary]");
      return { top: document.getElementById("transcript").scrollTop, at: s.getBoundingClientRect().top, open: s.parentElement.open };
    });
    await page.evaluate(() => {
      const s = document.querySelector("[data-e2e-summary]");
      s.parentElement.open = false;
      s.removeAttribute("data-e2e-summary");
    });
    assert(after.open, "the disclosure didn't open");
    assert(Math.abs(after.top - before.top) < 1 && Math.abs(after.at - before.at) < 1, `the view moved: ${JSON.stringify({ before, after })}`);
    const s = await now(page);
    assert(s.pill === s.gap >= 80, `following wasn't re-read from where the view is: ${JSON.stringify(s)}`);
    await page.locator(".jump-latest").click({ timeout: 2000 }).catch(() => {});
    await sleep(300);
  };
  await check("opening a disclosure with the mouse keeps the view (even while following)", () => disclosureKeeps((s) => s.click()));
  await check("opening a disclosure with Enter keeps the view", () => disclosureKeeps(async (s) => (await s.focus(), await page.keyboard.press("Enter"))));
  await check("opening a disclosure with Space keeps the view", () => disclosureKeeps(async (s) => (await s.focus(), await page.keyboard.press(" "))));

  await check("the view narrowing and widening keeps following", async () => {
    await toEnd(page);
    await sleep(150);
    for (const width of [900, 1440, 700, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(500);
      const s = await now(page);
      const w = await page.evaluate(() => innerWidth);
      assert(w === width, `innerWidth ${w}, wanted ${width}`);
      assert(!s.pill && s.gap < 2, `at ${width}px: ${JSON.stringify(s)}`);
    }
  });

  await check("a Timeline jump stops following and shows Jump to Latest", async () => {
    await toEnd(page);
    await sleep(150);
    await page.locator(".run-status-link").first().click({ timeout: 15000 });
    const body = page.locator(".timeline-body").nth(3);
    await body.waitFor({ timeout: 10000 });
    await body.click();
    await sleep(2500);
    const s = await now(page);
    assert(s.pill && s.gap >= 80, `after the jump: ${JSON.stringify(s)}`);
  });
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
  if (cdpPort) {
    try {
      execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
    } catch {}
  }
}

console.log(`\n${passed} passed, ${failures.length} failed${skipped.length ? `, ${skipped.length} skipped (not passed)` : ""}`);
if (failures.length) process.exit(1);
process.exit(0);
