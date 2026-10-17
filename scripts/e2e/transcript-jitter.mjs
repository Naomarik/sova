#!/usr/bin/env node
// E2E: building older rows above the view never fights the reader, and the line at the top of the
// transcript never appears after the rows were painted (§chat.transcript/rendering).
//
// - A reader scrolling (wheel input, repeated, while the idle fill builds chunks above): no write to
//   the transcript's scroll position comes between their first and last input. A write there stops a
//   fling or a smooth scroll.
// - A short chat (the whole branch in its first rows): from its first painted frame on, its first
//   row never moves and the older-edge line is never there.
// - A long chat, opened fresh and switched back to (its rows kept from the last visit): the
//   older-edge line is there from the first painted frame with rows, and stays.
// - A whole chat of 120 rows switched back to, built down to its top by the idle fill before
//   anything from the server lands (its hello is held back): the line goes, and the row at the top
//   of the view doesn't move.
//
// Writes three fixture sessions into the hermetic agent dir (dated ten minutes back, so they're in the
// sidebar's Recent there until other sessions are newer) and drives a hermetic server
// (`pnpm run build && pnpm run dev:hermetic` in THIS worktree; it serves the built app on 4810).
//
//   pnpm run e2e:transcript-jitter
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't this
// worktree's .agent; SOVA_E2E_CDP, a browser already running (CDP URL); SOVA_E2E_CHROMIUM, a Chrome
// or Chromium binary to launch directly instead of the skill's start-browser.sh, with
// SOVA_E2E_SCALE (default 1.25) as its --force-device-scale-factor: a ratio that isn't whole is
// where a row's move by part of a pixel shows.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");
const SCALE = process.env.SOVA_E2E_SCALE ?? "1.25";

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

// ---- the fixtures: a long chat (older rows to build) and a short one (the whole branch) ----

const words = (n, seed) => Array.from({ length: n }, (_, i) => ["jitter", "anchor", "pixel", "row", "height", "scroll", "fling", "frame"][(i * 7 + seed) % 8]).join(" ");
function fixture(id, turns, name) {
  const cwd = join(AGENT, `e2e-jitter-${name}`);
  mkdirSync(cwd, { recursive: true });
  const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`);
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  const lines = [{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const push = (e) => {
    lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
    parent = e.id;
  };
  for (let i = 0; i < turns; i++) {
    push({ type: "message", id: `${name}u${i}`, message: { role: "user", content: [{ type: "text", text: `Question ${i}: ${words(5 + ((i * 37) % 90), i)}` }], timestamp: 0 } });
    const paras = Array.from({ length: 1 + (i % 4) }, (_, k) => words(20 + ((i * 53 + k * 29) % 140), i + k)).join("\n\n");
    push({
      type: "message",
      id: `${name}a${i}`,
      message: { role: "assistant", content: [{ type: "text", text: paras }], provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 },
    });
  }
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Written ten minutes ago, as far as the server can tell: recent enough for the sidebar's Recent,
  // whose sessions the page fetches ahead (§chat.transcript/recent-preload), and past the two minutes
  // in which server/write-guard.ts refuses a file written by something it doesn't hold.
  const at = new Date(Date.now() - 10 * 60_000);
  utimesSync(file, at, at);
}
const LONG = "01a0e2e0-0000-7000-8000-0000000071e1";
const SHORT = "01a0e2e0-0000-7000-8000-0000000071e2";
const MID = "01a0e2e0-0000-7000-8000-0000000071e3";
fixture(LONG, 400, "long");
fixture(SHORT, 3, "short");
// 120 rows: more than the 60 built with the first frame, all of them one hello's worth.
fixture(MID, 60, "mid");

// ---- the browser ----

const { chromium } = createRequire(join(SKILL, "package.json"))("playwright");
let cdpPort = null;
let browser;
const direct = !!process.env.SOVA_E2E_CHROMIUM;
if (direct)
  browser = await chromium.launch({
    executablePath: process.env.SOVA_E2E_CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--no-first-run", "--window-size=1440,900", `--force-device-scale-factor=${SCALE}`],
  });
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

/** Before the app runs: every write to a transcript's scroll position, and every painted frame's
    rows count, older-edge line and first row's top (a task posted from the frame's callback runs
    right after it is painted). */
const RECORDER = () => {
  const J = (window.__jit = { writes: [], frames: [] });
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(v) {
      if (this.matches?.("section.transcript")) J.writes.push({ t: performance.now(), from: desc.get.call(this), to: v, stack: new Error().stack.split("\n").slice(2, 6).join(" | ") });
      desc.set.call(this, v);
    },
  });
  // A session's socket (chat or watch) holds what the server sends while `hold.on`, and hands it
  // all over in order at `hold.release()`: rows kept from the last visit then paint, and the fill
  // builds them, before the hello says what is above them.
  const hold = (J.hold = { on: false, queue: [], release() {
    hold.on = false;
    for (const f of hold.queue.splice(0)) f();
  } });
  const onmessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  Object.defineProperty(WebSocket.prototype, "onmessage", {
    configurable: true,
    get() {
      return onmessage.get.call(this);
    },
    set(fn) {
      const session = /\/ws\/(chat|watch)\?path=/.test(this.url);
      onmessage.set.call(this, !session || typeof fn !== "function" ? fn : (ev) => (hold.on ? hold.queue.push(() => fn.call(this, ev)) : fn.call(this, ev)));
    },
  });
  J.inputs = [];
  for (const type of ["wheel", "scroll"]) addEventListener(type, (e) => J.inputs.push({ type, t: performance.now() }), { capture: true, passive: true });
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    const t = [...document.querySelectorAll("section.transcript")].find((s) => s.getBoundingClientRect().height > 0);
    const rows = t ? t.querySelectorAll(".thread > .entry") : [];
    const first = rows[0];
    J.frames.push({
      t: performance.now(),
      hash: location.hash,
      rows: rows.length,
      edge: !!t?.querySelector(".older-edge"),
      first: first?.dataset.entry ?? null,
      // Under any banner over the transcript (a chat that failed to start): the banner's own coming
      // and going is not what this measures.
      firstTop: first && t ? first.getBoundingClientRect().top - t.getBoundingClientRect().top + t.scrollTop - [...t.querySelectorAll(".transcript-banner")].reduce((h, b) => h + b.getBoundingClientRect().height, 0) : null,
      fromEnd: t ? t.scrollHeight - t.scrollTop : null,
      // The row the view's top is in, and its top below the view's top.
      ...(() => {
        const view = t?.getBoundingClientRect().top;
        const row = [...rows].find((r) => r.getBoundingClientRect().bottom > view);
        return { viewRow: row?.dataset.entry ?? null, viewTop: row ? row.getBoundingClientRect().top - view : null };
      })(),
    });
  };
  const loop = () => {
    ch.port2.postMessage(0);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

const sessions = await api("/api/sessions");
const pathOf = (id) => {
  const s = (sessions.sessions ?? sessions).find((x) => x.id === id);
  assert(s, `the fixture ${id} isn't listed by the server`);
  return s.path;
};
async function newPage() {
  const ctx = await browser.newContext({ serviceWorkers: "block", ...(direct ? { viewport: null } : { viewport: { width: 1440, height: 900 } }) });
  await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
  await ctx.addInitScript(RECORDER);
  const page = await ctx.newPage();
  const cdpSession = await ctx.newCDPSession(page);
  return { ctx, page, cdpSession };
}
const go = (page, id) => page.evaluate((p) => (location.hash = `#/s/${encodeURIComponent(p)}`), pathOf(id));
const rowsOf = (page) => page.evaluate(() => document.querySelectorAll("section.transcript .thread > .entry").length);
/** The frames painted while `hash` was shown, from its first frame with rows on. */
const shown = (frames, id) => {
  const mine = frames.filter((f) => f.hash.includes(encodeURIComponent(pathOf(id))));
  const i = mine.findIndex((f) => f.rows > 0);
  return i < 0 ? [] : mine.slice(i);
};

try {
  console.log(`transcript-jitter e2e against ${BASE} (agent dir ${AGENT}${direct ? `, scale ${SCALE}` : ""})`);

  await check("a reader's scroll under way while rows are built above: nothing writes the scroll position", async () => {
    const { ctx, page, cdpSession } = await newPage();
    await page.goto(`${BASE}/`);
    // Slow enough that the idle fill builds in small chunks across the whole scroll.
    await cdpSession.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await go(page, LONG);
    // The file's newest rows paint first; the fill starts once the chat's hello has said what is
    // above them (a local browser then fetches the rest too).
    await page.waitForFunction(() => document.querySelectorAll("section.transcript .thread > .entry").length > 62, null, { timeout: 60000 });
    const box = await page.locator("section.transcript").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Away from the end first, until Jump to Latest says the view isn't following: a following
    // view goes back to the end as rows change, which is following, not holding a line. The reader
    // is reading up the transcript when the long scroll starts.
    await page.waitForFunction(
      () => {
        const t = document.querySelector("section.transcript");
        if (document.querySelector(".jump-latest[data-shown]")) return true;
        t.scrollTop -= 1500;
        return false;
      },
      null,
      { timeout: 20000, polling: 300 },
    );
    // The browser's own scroll anchoring off, for this check only: it usually keeps the view itself,
    // leaving the transcript nothing to correct, so a correction written mid-scroll would rarely
    // show. Without it every build above needs one, and none may come while the reader scrolls.
    await page.addStyleTag({ content: "section.transcript { overflow-anchor: none !important; }" });
    const before = await rowsOf(page);
    const t0 = await page.evaluate(() => performance.now());
    // A long scroll up: a wheel notch every 50 ms for 3 s (each one's input keeps the scroll the
    // reader's, as a fling's or a smooth scroll's events do).
    for (let k = 0; k < 60; k++) {
      await page.mouse.wheel(0, -60);
      await new Promise((r) => setTimeout(r, 50));
    }
    const t1 = await page.evaluate(() => performance.now());
    const after = await rowsOf(page);
    const { writes, moved } = await page.evaluate(
      ([a, b]) => {
        const fs = window.__jit.frames.filter((f) => f.t >= a && f.t <= b);
        // Under way: within 300 ms of a wheel notch, and on through scroll events each within 300 ms
        // of the last (a smooth scroll's or a fling's go on a frame apart).
        const ins = window.__jit.inputs;
        const underWay = (t) => {
          let until = -Infinity;
          for (const x of ins) {
            if (x.t > t) break;
            if (x.type === "wheel" || x.t < until) until = x.t + 300;
          }
          return t < until;
        };
        return { writes: window.__jit.writes.filter((w) => w.t >= a && w.t <= b && underWay(w.t)), moved: fs.length ? fs.at(-1).fromEnd - fs[0].fromEnd : 0 };
      },
      [t0, t1],
    );
    await cdpSession.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await ctx.close();
    assert(after > before, `no rows were built while the reader scrolled (${before} → ${after}): the check compared nothing`);
    assert(moved > 300, `the view didn't scroll up from the end (${moved}px): the check compared nothing`);
    assert(writes.length === 0, `${writes.length} write(s) to the scroll position while the reader's scroll was under way: ${JSON.stringify(writes.slice(0, 5))}`);
  });

  await check("a short chat: its first row never moves after the first paint, and the older-edge line never shows", async () => {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/`);
    await go(page, SHORT);
    await page.waitForFunction(() => document.querySelectorAll("section.transcript .thread > .entry").length > 0, null, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));
    const frames = shown(await page.evaluate(() => window.__jit.frames), SHORT);
    await ctx.close();
    assert(frames.length > 10, `only ${frames.length} frame(s) recorded`);
    // Measured to a hundredth of a pixel: what layout's arithmetic leaves over is no move.
    const tops = [...new Set(frames.filter((f) => f.first === frames[0].first).map((f) => Math.round(f.firstTop * 100) / 100))];
    assert(tops.length === 1, `the first row moved: tops ${JSON.stringify(tops.slice(0, 6))}`);
    assert(!frames.some((f) => f.edge), "the older-edge line showed in a chat that holds the whole branch");
  });

  await check("a long chat, opened on rows fetched ahead and switched back to: the older-edge line is there from the first frame with rows, and stays", async () => {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/`);
    // Recent's sessions are fetched ahead, one at a time while the page is idle: the long chat's
    // newest rows are then in memory when it is first opened, and paint before anything says
    // what's above them (the case where the line used to come a frame late).
    await page.waitForTimeout(12000);
    const visit = async (id) => {
      const from = await page.evaluate(() => performance.now());
      await go(page, id);
      await page.waitForFunction(() => document.querySelectorAll("section.transcript .thread > .entry").length > 0, null, { timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2500));
      return shown(await page.evaluate((a) => window.__jit.frames.filter((f) => f.t >= a), from), id);
    };
    const fresh = await visit(LONG);
    await visit(SHORT);
    const back = await visit(LONG);
    await ctx.close();
    for (const [what, frames] of [
      ["opened on its rows fetched ahead", fresh],
      ["switched back", back],
    ]) {
      assert(frames.length > 10, `${what}: only ${frames.length} frame(s) recorded`);
      const missing = frames.filter((f) => !f.edge).length;
      assert(missing === 0, `${what}: the line was missing in ${missing} of ${frames.length} frame(s) (first painted frame: ${frames[0].edge ? "there" : "missing"})`);
    }
  });

  await check("a kept, whole chat built down to its top before anything says what is above: the older-edge line goes, and the view doesn't move", async () => {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/`);
    const all = (n) =>
      page.waitForFunction((k) => document.querySelectorAll("section.transcript .thread > .entry").length === k, n, { timeout: 30000 }).catch(async () => {
        throw new Error(`${await rowsOf(page)} row(s) built, not ${n}`);
      });
    const away = async () => {
      await go(page, SHORT);
      await page.waitForFunction(() => document.querySelectorAll("section.transcript .thread > .entry").length > 0, null, { timeout: 30000 });
      await page.waitForTimeout(1000);
    };
    /** Back to the chat, its rows kept: the frames painted from then on, once `settle` is done. */
    const back = async (settle) => {
      const from = await page.evaluate(() => performance.now());
      await go(page, MID);
      await all(120);
      await page.waitForTimeout(1500);
      await settle?.();
      return shown(await page.evaluate((a) => window.__jit.frames.filter((f) => f.t >= a), from), MID);
    };
    /** Whether the line was there from the first frame and went, and the view through its going. */
    const judge = (what, frames, dpr) => {
      assert(frames.length > 10, `${what}: only ${frames.length} frame(s) recorded`);
      assert(frames[0].edge && frames[0].rows < 120, `${what}: the first frame had ${frames[0].rows} row(s) built and the line ${frames[0].edge ? "there" : "missing"} (60 and there: rows to build): the check compared nothing`);
      assert(!frames.at(-1).edge, `${what}: the older-edge line stayed over a whole branch`);
      const i = frames.findIndex((f) => !f.edge);
      const [a, b] = [frames[i - 1], frames[i]];
      assert(a.viewRow === b.viewRow && Math.abs(a.viewTop - b.viewTop) < 1 / dpr, `${what}: the row at the top of the view moved as the line went: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    };
    // The first visit: the file's newest 60 rows, then the reader scrolls up to the rest (which
    // starts the chat); the whole branch is kept with the view's rows for the next visit.
    await go(page, MID);
    await page.waitForFunction(() => document.querySelectorAll("section.transcript .thread > .entry").length > 0, null, { timeout: 30000 });
    const box = await page.locator("section.transcript").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let k = 0; (await rowsOf(page)) < 120; k++) {
      assert(k < 300, `scrolled up for 30 s and ${await rowsOf(page)} row(s) are built, not 120`);
      await page.mouse.wheel(0, -2000);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);
    await away();
    // Back to the running chat, its hello held until the fill has built the kept rows to the top.
    await page.evaluate(() => (window.__jit.hold.on = true));
    let held = 0;
    const running = await back(async () => {
      held = await page.evaluate(() => window.__jit.hold.queue.length);
      await page.evaluate(() => window.__jit.hold.release());
      await page.waitForTimeout(1500);
    });
    const dpr = await page.evaluate(() => devicePixelRatio);
    await ctx.close();
    assert(held > 0, "nothing from the running chat's socket was held: its hello landed before the fill, the check compared nothing");
    judge("the running chat, its hello held", running, dpr);
  });
} finally {
  await browser.close().catch(() => {});
  // The chats the checks started.
  spawnSync("bun", [join(ROOT, "scripts/stop-chats.ts"), "--agent-dir", AGENT], { cwd: ROOT, stdio: "ignore" });
  if (cdpPort) {
    try {
      execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
    } catch {}
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
process.exit(0);
