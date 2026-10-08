#!/usr/bin/env node
// E2E: a jump lands at once in the middle of the view and its row never moves while the rows
// around it are first drawn (§chat.transcript/jump-landing).
//
// A jump from the Timeline, at 1440 and at 390 wide, to a row already built near the end, a built
// row far up (never drawn, a row whose estimate is far off right above it), a row not built yet,
// and the first row of the list; at 390 through a proxy, as a phone reaches it, so the far rows
// aren't even fetched and the jump fetches down to them. Sampled in every frame as it is
// painted (after the transcript's own corrections), from the click:
//   - landed: the row's center is at the view's center within 1 px in the first frame the row
//     is painted in (the first row the list holds: at the top of the view), so no smooth scroll
//     and no second aim;
//   - still: it then moves by less than 1 px for 1.5 s, and for 1 s after the first rows built
//     above it after the jump (a chunk the view nearing the top builds, rows fetched above), whichever
//     ends later;
//   - a lazy image above it that the jump brings into view and that finishes loading mid-hold (a
//     path attachment opened beforehand, its response held back) doesn't move it either, for 1.5 s
//     after the load;
//   - following: a jump that leaves the view within 80 px of the end follows what lands there once
//     its hold is over; one that leaves it above the end doesn't.
//
// Writes a fixture session (odd-sized images, a table whose rows wrap far past their estimate, a
// path attachment served over HTTP) into the hermetic agent dir and drives a hermetic server —
// `pnpm run dev:hermetic` in THIS worktree, which serves the built app (`pnpm run build` first) on
// 4810 — through the playwright skill's own browser.
//
//   pnpm run build && pnpm run dev:hermetic        # in one terminal
//   pnpm run e2e:jump-settle                       # in another
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't this
// worktree's .agent; SOVA_E2E_CDP, a browser already running (CDP URL) instead of starting one;
// SOVA_E2E_SESSIONS, ids of other sessions in that agent dir to measure too (comma-separated; their
// numbers are printed, never asserted): SOVA_E2E_PICK names one of their jumps ("1440 unbuilt"; near, far,
// unbuilt), SOVA_E2E_REMOTE=1 opens them through a proxy (no background fetch), SOVA_E2E_MS sets
// how long each jump is sampled (default 2600). SOVA_E2E_ONLY runs only the checks whose name holds it. The playwright skill needs its node_modules (`npm ci` in
// .claude/skills/playwright/scripts, or a symlink to another checkout's).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { tokenHeaders } from "../sova-token.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");
const EXTRA = (process.env.SOVA_E2E_SESSIONS ?? "").split(",").filter(Boolean);
const PICK = process.env.SOVA_E2E_PICK;
const EXTRA_REMOTE = process.env.SOVA_E2E_REMOTE === "1";
const SAMPLE_MS = Number(process.env.SOVA_E2E_MS ?? 2600);

let passed = 0;
const failures = [];
const ONLY = process.env.SOVA_E2E_ONLY;
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
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

// ---- the fixture ----

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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const IMAGES = [png(1237, 731), png(643, 1009), png(1511, 277), png(333, 517)].map((b) => b.toString("base64"));
const words = (n, seed) => Array.from({ length: n }, (_, i) => ["jump", "anchor", "pixel", "row", "height", "scroll", "estimate", "frame", "middle"][(i * 7 + seed) % 9]).join(" ");

const ID = "01a0e2e0-0000-7000-8000-0000000015e7";
const TURNS = 330;
/** The jump targets, by turn: each is that turn's user row (a Timeline input row). */
const NEAR = TURNS - 8;
const FAR = TURNS - 150;
const LAZY = TURNS - 110;
const UNBUILT = 70;
/** Turns whose reply is a table of long cells: one row of its markdown per table line, each
    wrapping to many lines, so its estimate is far under its real height. Right above FAR and UNBUILT. */
const TABLES = new Set([FAR - 1, UNBUILT - 1, FAR - 3, UNBUILT - 3]);

const cwd = join(AGENT, "e2e-jump-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const file = join(dir, `2026-10-01T00-00-00-000Z_${ID}.jsonl`);
// The image the row above LAZY names by path: drawn from GET /api/attachment, its size unknown
// until it loads, so its row grows when it does.
const attachDir = join(AGENT, "sova", "attachments", ID);
mkdirSync(attachDir, { recursive: true });
const attachment = join(attachDir, "shot-lazy.png");
writeFileSync(attachment, png(700, 420));
{
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  const lines = [{ type: "session", version: 3, id: ID, timestamp: new Date(t0).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const push = (e) => {
    lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
    parent = e.id;
  };
  const table = (i) => {
    const cell = (k) => words(30 + ((i * 13 + k * 7) % 25), i + k);
    const rows = Array.from({ length: 14 }, (_, r) => `| ${cell(r)} | ${cell(r + 1)} | ${cell(r + 2)} |`);
    return [`Table ${i}:`, "", "| one | two | three |", "|---|---|---|", ...rows].join("\n");
  };
  for (let i = 0; i < TURNS; i++) {
    // The lazy image's row has no reply (a turn stopped before one), and it and the row jumped to
    // under it are short, so landing on that row brings the image into view: an image above a
    // scroller's view isn't loaded early.
    const text = i === LAZY ? `Question ${i}.` : i === LAZY - 1 ? `Look at ${attachment}` : `Question ${i}: ${words(5 + ((i * 37) % 60), i)}`;
    const content = [{ type: "text", text }];
    if (i % 3 === 1) content.push({ type: "image", data: IMAGES[i % 4], mimeType: "image/png" });
    push({ type: "message", id: `u${i}`, message: { role: "user", content, timestamp: 0 } });
    const paras = Array.from({ length: 1 + (i % 4) }, (_, k) => words(20 + ((i * 53 + k * 29) % 140), i + k)).join("\n\n");
    if (i === LAZY - 1) continue;
    // The last reply is short, so a jump to the last input leaves the view at the end at 390 too.
    const reply = TABLES.has(i) ? table(i) : i === TURNS - 1 ? "Done." : paras;
    push({
      type: "message",
      id: `a${i}`,
      message: { role: "assistant", content: [{ type: "text", text: reply }], provider: "e2e", model: "m", api: "anthropic-messages", stopReason: "stop", timestamp: 0 },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a session at `viewport` and waits for its rows to stop being built (the idle fill, and
    a desktop's background fetch). `lazyMs` holds back each path attachment's response. */
async function open(viewport, sessionId, { remote = false, lazyMs = 0 } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport, deviceScaleFactor: 1 });
  // The token on every request, and through a proxy, as a phone on the tailnet reaches it.
  await ctx.setExtraHTTPHeaders({ ...tokenHeaders(AGENT), ...(remote ? { "X-Forwarded-For": "100.64.0.9" } : {}) });
  if (lazyMs > 0)
    await ctx.route((url) => url.pathname === "/api/attachment", async (route) => {
      await sleep(lazyMs);
      await route.continue();
    });
  const page = await ctx.newPage();
  const cdpSession = await ctx.newCDPSession(page);
  await cdpSession.send("Emulation.setCPUThrottlingRate", { rate: 2 });
  const list = await api("/api/sessions");
  const session = (list.sessions ?? list).find((s) => s.id === sessionId);
  assert(session, `the session ${sessionId} isn't listed by the server`);
  await page.goto(`${BASE}/#/s/${encodeURIComponent(session.path)}`);
  await page.waitForFunction(() => document.querySelectorAll("#transcript .thread > .entry").length > 5, null, { timeout: 30000 });
  await settled(page);
  // The Timeline, where a row's body jumps to it: a column beside the transcript at 1440, a
  // drawer over it at 390 (which closes on the jump).
  await page.getByRole("button", { name: "Session details" }).first().click();
  await page.getByRole("tab", { name: "Timeline" }).first().click();
  await page.waitForSelector("li.timeline-row[data-input] button.timeline-body", { timeout: 30000 });
  await settled(page);
  return { ctx, page };
}
const rowsNow = (page) => page.evaluate(() => document.querySelectorAll("#transcript .thread > .entry").length);
async function settled(page) {
  let last = -1;
  for (let still = 0, t = 0; still < 6 && t < 120; t++) {
    await sleep(250);
    const n = await rowsNow(page);
    still = n === last ? still + 1 : 0;
    last = n;
  }
}

/**
 * Clicks the Timeline row of `entryId` and samples its row in each frame as it is painted, for `ms`. Each sample: time
 * since the click, rows built, the row's center and top against the view's, and whether it is the
 * first row the list holds. `openId`: a row whose path attachment is opened first, off screen, so
 * its image is requested only once the jump brings it into view (`opened`: open, its image not loaded).
 */
async function jump(page, entryId, { ms = SAMPLE_MS, openId = null } = {}) {
  return page.evaluate(
    async ({ entryId, ms, openId }) => {
      const T = document.getElementById("transcript");
      const button = document.querySelector(`li.timeline-row[data-input="${CSS.escape(entryId)}"] button.timeline-body`);
      if (!T || !button) return { error: `no transcript or no Timeline row for ${entryId}` };
      const rowOf = () => T.querySelector(`.thread > .entry[data-entry="${CSS.escape(entryId)}"]`)?.firstElementChild ?? null;
      const builtBefore = !!rowOf();
      let opened = false;
      if (openId) {
        const summary = T.querySelector(`.thread > .entry[data-entry="${CSS.escape(openId)}"] details.message-attachment > summary`);
        summary?.click();
        // Its `toggle` (a task of its own) draws the image's box: settled before the click, so
        // no sample after the click reads a change from before it.
        await new Promise((r) => setTimeout(r, 200));
        const img = summary?.parentElement?.querySelector("img");
        opened = !!summary?.parentElement?.open && !!img && !img.complete;
      }
      const frames = [];
      const loads = [];
      const onLoad = (e) => {
        if (e.target instanceof HTMLImageElement && e.target.src.includes("/api/attachment")) loads.push(performance.now() - t0);
      };
      document.addEventListener("load", onLoad, true);
      const sample = () => {
        const row = rowOf();
        const n = T.querySelectorAll(".thread > .entry").length;
        if (!row?.isConnected) return frames.push({ t: performance.now() - t0, n, has: false });
        const v = T.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        frames.push({ t: performance.now() - t0, n, has: true, firstInList: T.querySelector(".thread > .entry") === row.parentElement, center: (b.top + b.bottom) / 2 - (v.top + v.bottom) / 2, top: b.top - v.top, h: b.height, vh: v.height, st: T.scrollTop });
      };
      // Read where the frame is final: in a resize observer made after the transcript's own, so after
      // its corrections and before the paint. A 1px probe that changes width every frame makes it
      // run in every frame. (A task posted after the paint would also read changes made by tasks
      // that run before it, which the next frame corrects before painting.)
      let done = false;
      const probe = document.createElement("div");
      probe.style.cssText = "position: fixed; left: 0; top: 0; width: 1px; height: 1px; visibility: hidden; pointer-events: none";
      document.body.append(probe);
      const observer = new ResizeObserver(() => !done && t0 !== undefined && sample());
      let t0;
      let flip = false;
      const tick = () => {
        if (done) return;
        flip = !flip;
        probe.style.width = flip ? "2px" : "1px";
        requestAnimationFrame(tick);
      };
      t0 = performance.now();
      button.click();
      observer.observe(probe);
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, ms));
      done = true;
      observer.disconnect();
      probe.remove();
      document.removeEventListener("load", onLoad, true);
      const images = openId ? [...T.querySelectorAll(`.thread > .entry[data-entry="${CSS.escape(openId)}"] img`)].map((i) => ({ complete: i.complete, h: i.getBoundingClientRect().height, top: i.getBoundingClientRect().top - T.getBoundingClientRect().top, vh: T.clientHeight, loading: i.loading, cv: getComputedStyle(i.closest(".entry")).contentVisibility, open: i.closest("details")?.open })) : [];
      return { builtBefore, opened, frames, loads, images };
    },
    { entryId, ms, openId },
  );
}

/**
 * What a run says: the first painted frame holding the row, where the row was in it, how far it
 * moved after, and when rows were first built above it after that frame.
 */
function judge(r, { atTop = false, remote = false, after = [] } = {}) {
  const first = r.frames.find((f) => f.has);
  if (!first) return { first: null };
  // A row fetched down to (a phone, through a proxy) is the first the list holds: it sits at the top.
  // (A browser on this machine holds the whole list: there, only the first row is.)
  atTop ||= remote && !!first.firstInList;
  const base = first.n;
  const chunk = r.frames.find((f) => f.t > first.t && f.n > base);
  const ends = [first.t + 1500, ...(chunk ? [chunk.t + 1000] : []), ...after.map((t) => t + 1500)];
  const until = Math.max(...ends);
  const window = r.frames.filter((f) => f.t >= first.t && f.t <= until);
  const gone = window.some((f) => !f.has);
  const moved = Math.max(0, ...window.filter((f) => f.has).map((f) => Math.abs(f.center - first.center)));
  const worst = window.filter((f) => f.has).reduce((w, f) => (Math.abs(f.center - first.center) > Math.abs(w.center - first.center) ? f : w), first);
  const off = atTop ? first.top : first.center;
  // Where it came to rest, and when it last moved: the miss a smooth scroll leaves, and its second aim.
  const shown = r.frames.filter((f) => f.has);
  const final = shown.at(-1);
  const restAt = [...shown].reverse().find((f) => Math.abs(f.center - final.center) >= 1)?.t ?? first.t;
  return { atTop, first, off, moved, gone, worst, final: atTop ? final.top : final.center, restAt: Math.round(restAt), chunkAt: chunk ? Math.round(chunk.t) : null, until: Math.round(until), lastT: Math.round(r.frames.at(-1)?.t ?? 0) };
}
const fmt = (j) =>
  j.first
    ? `first painted at ${Math.round(j.first.t)} ms, ${j.off.toFixed(1)} px off; moved ${j.moved.toFixed(1)} px within ${j.until} ms` +
      (j.moved >= 1 ? ` (worst at ${Math.round(j.worst.t)} ms)` : "") +
      (j.atTop ? " (at the top: the first row the list holds)" : "") +
      `; at rest ${j.final.toFixed(1)} px off, last moved at ${j.restAt} ms` +
      (j.chunkAt !== null ? `; rows built above at ${j.chunkAt} ms` : "; no rows built above meanwhile")
    : "the row never painted";

/** One jump at `viewport`: the row lands in the middle (`atTop`: at the top) at once and stays. */
async function landsAndStays(viewport, entryId, { built, remote = false, atTop = false, lazyMs = 0, openId = null, sessionId = ID } = {}) {
  const { ctx, page } = await open(viewport, sessionId, { remote, lazyMs });
  try {
    const r = await jump(page, entryId, { openId });
    assert(!r.error, r.error);
    if (openId) assert(r.opened, `precondition: the attachment of ${openId} didn't open`);
    if (built !== undefined) assert(r.builtBefore === built, `precondition: the row was ${r.builtBefore ? "" : "not "}built before the jump`);
    if (lazyMs > 0) assert(r.loads.length > 0, `the lazy image above the row never loaded during the run: ${JSON.stringify(r.images)}`);
    const j = judge(r, { atTop, remote, after: r.loads });
    console.log(`       ${viewport.width}: ${fmt(j)}${r.loads.length ? `; lazy image loaded at ${r.loads.map(Math.round).join(", ")} ms` : ""}`);
    assert(j.first, "the row never painted after the jump");
    if (j.atTop) assert(j.off >= -1 && j.off <= 120, `the first row should sit at the top of the view; its top is ${j.off.toFixed(1)} px below the view's`);
    else assert(Math.abs(j.off) <= 1, `in its first painted frame the row's center is ${j.off.toFixed(1)} px from the view's`);
    assert(!j.gone, "the row left the page mid-hold");
    assert(j.moved < 1, `the row moved ${j.moved.toFixed(1)} px after it landed (at ${Math.round(j.worst.t)} ms)`);
    return j;
  } finally {
    await ctx.close();
  }
}

/** A jump, then the reader's wheel while its row is still held: the wheel moves the view, and the
    hold lets go of it rather than pulling the row back. */
async function wheelTakesIt(viewport, entryId) {
  const { ctx, page } = await open(viewport, ID);
  try {
    const center = () =>
      page.evaluate((id) => {
        const T = document.getElementById("transcript");
        const b = T.querySelector(`.thread > .entry[data-entry="${CSS.escape(id)}"]`).firstElementChild.getBoundingClientRect();
        const v = T.getBoundingClientRect();
        return { center: (b.top + b.bottom) / 2 - (v.top + v.bottom) / 2, x: (v.left + v.right) / 2, y: (v.top + v.bottom) / 2 };
      }, entryId);
    await page.evaluate((id) => document.querySelector(`li.timeline-row[data-input="${CSS.escape(id)}"] button.timeline-body`).click(), entryId);
    await sleep(60);
    const landed = await center();
    await page.mouse.move(landed.x, landed.y);
    await page.mouse.wheel(0, -400);
    await sleep(900);
    const after = await center();
    console.log(`       ${viewport.width}: landed ${landed.center.toFixed(1)} px off; after a 400 px wheel up, ${after.center.toFixed(1)} px`);
    assert(Math.abs(landed.center) <= 1, `the row landed ${landed.center.toFixed(1)} px off center`);
    assert(after.center > 300, `the wheel up should have moved the row down by about 400 px; it is ${after.center.toFixed(1)} px off center`);
  } finally {
    await ctx.close();
  }
}

/**
 * A jump, its hold over, then content landing at the end (a row growing below, as a streamed reply
 * does): a jump that left the view within 80 px of the end follows it, with no Jump to Latest
 * (§chat.transcript/turn-end-keeps-reader, "when a jump's own scroll lands there"); one that left
 * it well above the end doesn't, and Jump to Latest shows.
 */
async function followsAfter(viewport, entryId, follows) {
  const { ctx, page } = await open(viewport, ID);
  try {
    const now = () =>
      page.evaluate(() => {
        const t = document.getElementById("transcript");
        return { gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight), pill: !!t.parentElement.querySelector(".jump-latest[data-shown]") };
      });
    await page.evaluate((id) => document.querySelector(`li.timeline-row[data-input="${CSS.escape(id)}"] button.timeline-body`).click(), entryId);
    await sleep(1500);
    const landed = await now();
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.height = "300px";
      [...document.querySelectorAll("#transcript .thread > .entry")].at(-1).append(d);
    });
    await sleep(500);
    const after = await now();
    console.log(`       ${viewport.width}: after the jump ${JSON.stringify(landed)}; after 300 px landed at the end ${JSON.stringify(after)}`);
    if (follows) {
      assert(landed.gap < 80, `precondition: the jump should leave the view within 80 px of the end; it is ${landed.gap} px`);
      assert(after.gap < 80 && !after.pill, `a jump that left the view at the end should follow: ${JSON.stringify(after)}`);
    } else {
      assert(landed.gap >= 80, `precondition: the jump should leave the view above the end; it is ${landed.gap} px from it`);
      assert(after.gap >= 290 && after.pill, `a jump above the end should not follow: ${JSON.stringify(after)}`);
    }
  } finally {
    await ctx.close();
  }
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

try {
  console.log(`jump-settle e2e against ${BASE} (agent dir ${AGENT})`);
  for (const [vp, remote] of [
    [DESKTOP, false],
    [PHONE, true],
  ]) {
    const w = vp.width;
    await check(`${w}: a built row near the end lands in the middle at once and stays`, () => landsAndStays(vp, `u${NEAR}`, { built: remote ? undefined : true, remote }));
    await check(`${w}: a built row far up, under a row drawn far taller than its estimate, lands in the middle at once and stays`, () => landsAndStays(vp, `u${FAR}`, { built: remote ? undefined : true, remote }));
    await check(`${w}: a row not built yet lands in the middle at once and stays, through the rows built above it after`, () => landsAndStays(vp, `u${UNBUILT}`, { built: remote ? undefined : false, remote }));
    await check(`${w}: the first row lands at the top of the view and stays`, () => landsAndStays(vp, "u0", { built: remote ? undefined : false, remote, atTop: true }));
    await check(`${w}: a jump that leaves the view at the end follows what lands there, no Jump to Latest`, () => followsAfter(vp, `u${TURNS - 1}`, true));
    await check(`${w}: a jump that leaves the view above the end doesn't follow; Jump to Latest shows`, () => followsAfter(vp, `u${NEAR}`, false));
    await check(`${w}: a lazy image above the row loading mid-hold doesn't move it`, () => landsAndStays(vp, `u${LAZY}`, { built: true, lazyMs: 450, openId: `u${LAZY - 1}` }));
  }
  await check("1440: the reader's wheel while the row is held moves the view, and the hold lets go", () => wheelTakesIt(DESKTOP, `u${FAR}`));
  // Other sessions in the agent dir (real ones copied in): measured, never asserted.
  for (const sid of EXTRA) {
    const ids = await (async () => {
      const { ctx, page } = await open(DESKTOP, sid);
      const all = await page.evaluate(() => {
        const built = new Set([...document.querySelectorAll("#transcript .thread > .entry")].map((e) => e.dataset.entry));
        return [...document.querySelectorAll("li.timeline-row[data-input]")].map((li) => ({ id: li.dataset.input, built: built.has(li.dataset.input) }));
      });
      await ctx.close();
      return all;
    })();
    const builtIds = ids.filter((x) => x.built);
    const picks = [
      ["near", builtIds[Math.min(3, builtIds.length - 1)]],
      ["far", builtIds.at(-Math.min(builtIds.length, 6))],
      ["unbuilt", ids.filter((x) => !x.built)[Math.floor(ids.filter((x) => !x.built).length / 2)]],
    ].filter(([, x]) => x);
    for (const vp of [DESKTOP, PHONE])
      for (const [what, x] of picks) {
        if (PICK && `${vp.width} ${what}` !== PICK) continue;
        try {
          await landsAndStays(vp, x.id, { sessionId: sid, remote: EXTRA_REMOTE });
          console.log(`  info ${sid.slice(0, 8)} ${vp.width} ${what}: ok`);
        } catch (err) {
          console.log(`  info ${sid.slice(0, 8)} ${vp.width} ${what}: ${String(err.message).split("\n")[0]}`);
        }
      }
  }
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
