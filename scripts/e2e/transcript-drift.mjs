#!/usr/bin/env node
// E2E: the view doesn't move while rows are added or first drawn above it
// (§chat.transcript/rendering: "The view doesn't move while they're added").
//
// Every frame, the row that was the first fully visible one must keep its top relative to the
// scroller to the pixel, 0 px, through every prepend (a phone scrolling up into older rows fetched
// in chunks, a desktop's background prefetch, the idle backfill) and every row above the view
// drawn for the first time at its real height. A fraction of a pixel counts: scroll anchoring
// corrects by whole pixels, so fractions left over add up into the view stepping a pixel.
//
// Writes a fixture session (odd-sized images, text of many lengths) into the hermetic agent dir
// and drives a hermetic server — `pnpm run dev:hermetic` in THIS worktree, which serves the built
// app (`pnpm run build` first) on 4810 — through the playwright skill's own browser.
//
//   pnpm run build && pnpm run dev:hermetic        # in one terminal
//   pnpm run e2e:transcript-drift                  # in another
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't this
// worktree's .agent (a baseline build's own copy); SOVA_E2E_CDP, a browser already running (CDP
// URL) instead of starting one. The playwright skill needs its node_modules (`npm ci` in
// .claude/skills/playwright/scripts, or a symlink to another checkout's).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");

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
  const r = await fetch(`${BASE}${path}`);
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

// ---- the fixture: long enough for older rows, heights that come out fractional ----

/** A real grey PNG of this size (its box takes the image's aspect ratio). */
function png(w, h) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const IMAGES = [png(1237, 731), png(643, 1009), png(1511, 277)];
const words = (n, seed) => Array.from({ length: n }, (_, i) => ["drift", "anchor", "pixel", "row", "height", "scroll", "estimate", "frame"][(i * 7 + seed) % 8]).join(" ");

const ID = "01a0e2e0-0000-7000-8000-00000000d71f";
const cwd = join(AGENT, "e2e-drift-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const file = join(dir, `2026-09-28T00-00-00-000Z_${ID}.jsonl`);
{
  const t0 = Date.parse("2026-09-28T00:00:00.000Z");
  const lines = [{ type: "session", version: 3, id: ID, timestamp: new Date(t0).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const push = (e) => {
    lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
    parent = e.id;
  };
  for (let i = 0; i < 260; i++) {
    const content = [{ type: "text", text: `Question ${i}: ${words(5 + ((i * 37) % 90), i)}` }];
    if (i % 6 === 1) content.push({ type: "image", data: IMAGES[i % 3], mimeType: "image/png" });
    push({ type: "message", id: `u${i}`, message: { role: "user", content, timestamp: 0 } });
    const paras = Array.from({ length: 1 + (i % 4) }, (_, k) => words(20 + ((i * 53 + k * 29) % 140), i + k)).join("\n\n");
    push({
      type: "message",
      id: `a${i}`,
      message: { role: "assistant", content: [{ type: "text", text: paras }], provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 },
    });
  }
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Written long ago, as far as the server can tell: a file written in the last two minutes by
  // something it doesn't hold is refused as busy (server/write-guard.ts).
  const past = new Date(t0);
  utimesSync(file, past, past);
}

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

/** The frame recorder, before the app runs. `scroll(dy)` is the only input: the frame it lands
    in is measured from where the scroll put the row, so what anchoring leaves over still shows. */
const RECORDER = () => {
  const D = (window.__drift = { frames: [], on: false });
  let prev = null;
  const T = () => document.getElementById("transcript");
  const snap = () => {
    const t = T();
    if (!t) return (prev = null);
    const v = t.getBoundingClientRect().top;
    const rows = [...t.querySelectorAll(".thread > .entry")];
    const el = rows.find((e) => {
      const b = e.getBoundingClientRect();
      return b.height && b.top >= v - 0.01;
    });
    prev = el ? { el, top: el.getBoundingClientRect().top - v, n: rows.length, gap: t.scrollHeight - t.scrollTop - t.clientHeight } : null;
  };
  const tick = () => {
    if (!D.on) return;
    const t = T();
    if (t && prev?.el.isConnected) {
      const d = prev.el.getBoundingClientRect().top - t.getBoundingClientRect().top - prev.top;
      const n = t.querySelectorAll(".thread > .entry").length;
      // At the end a following view goes back there when the last row grows: that's following.
      const following = prev.gap <= 2;
      if (d !== 0 && !following) D.frames.push({ d: Math.round(d * 1000) / 1000, added: n - prev.n, row: prev.el.dataset.entry });
      D.prepends += n > prev.n ? 1 : 0;
    }
    snap();
    requestAnimationFrame(tick);
  };
  D.start = () => {
    D.on = true;
    D.frames = [];
    D.prepends = 0;
    prev = null;
    requestAnimationFrame(tick);
  };
  D.stop = () => {
    D.on = false;
    return { frames: D.frames, prepends: D.prepends };
  };
  D.scroll = (dy) => {
    const t = T();
    t.scrollTop += dy;
    snap();
    return t.scrollTop;
  };
};

async function open(viewport, { remote }) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport, deviceScaleFactor: 1 });
  // Through a proxy, as a phone on the tailnet reaches it: no background prefetch, chunks on scroll.
  if (remote) await ctx.setExtraHTTPHeaders({ "X-Forwarded-For": "100.64.0.9" });
  await ctx.addInitScript(RECORDER);
  const page = await ctx.newPage();
  const cdpSession = await ctx.newCDPSession(page);
  await cdpSession.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const list = await api("/api/sessions");
  const session = (list.sessions ?? list).find((s) => s.id === ID);
  assert(session, `the fixture ${ID} isn't listed by the server`);
  await page.goto(`${BASE}/#/s/${encodeURIComponent(session.path)}`);
  await page.waitForFunction(() => document.querySelectorAll("#transcript .thread > .entry").length > 5, null, { timeout: 30000 });
  return { ctx, page };
}
const rowsNow = (page) => page.evaluate(() => document.querySelectorAll("#transcript .thread > .entry").length);
const describe = (r) => `${r.frames.length} frame(s) moved over ${r.prepends} prepend(s): ${JSON.stringify(r.frames.slice(0, 6))}`;

try {
  console.log(`transcript-drift e2e against ${BASE} (agent dir ${AGENT})`);

  await check("desktop, opened at the end: the prefetch and the backfill never move the view", async () => {
    const { ctx, page } = await open({ width: 1440, height: 900 }, { remote: false });
    // Up from the end a little, so the view isn't following: rows above must hold it where it is.
    await page.evaluate(() => {
      window.__drift.start();
      window.__drift.scroll(-400);
    });
    let last = -1;
    for (let still = 0, t = 0; still < 6 && t < 80; t++) {
      await new Promise((r) => setTimeout(r, 250));
      const n = await rowsNow(page);
      still = n === last ? still + 1 : 0;
      last = n;
    }
    const r = await page.evaluate(() => window.__drift.stop());
    await ctx.close();
    assert(r.prepends > 0, "no rows were added above: the check compared nothing");
    assert(r.frames.length === 0, describe(r));
  });

  await check("phone, scrolling up into older rows fetched in chunks: rows added or drawn above never move the view", async () => {
    const { ctx, page } = await open({ width: 390, height: 844 }, { remote: true });
    await page.evaluate(() => window.__drift.start());
    for (let k = 0; k < 90; k++) {
      const top = await page.evaluate(() => window.__drift.scroll(-600));
      await new Promise((r) => setTimeout(r, top <= 0 ? 700 : 120));
    }
    const r = await page.evaluate(() => window.__drift.stop());
    await ctx.close();
    assert(r.prepends > 0, "no rows were added above: the check compared nothing");
    assert(r.frames.length === 0, describe(r));
  });
} finally {
  await browser.close().catch(() => {});
  if (cdpPort) {
    try {
      execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
    } catch {}
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
process.exit(0);
