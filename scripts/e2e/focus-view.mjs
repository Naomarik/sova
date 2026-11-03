#!/usr/bin/env node
// E2E: Focus (§chat.transcript/focus-view), driven in a real browser.
//
// The Focus button is in the single view's transcript corner, a toggle with aria-pressed. On, the
// head keeps Back (folded) and the title, the strips under it and the composer collapse out of
// sight while the composer stays mounted and inert, so a half-written draft is there when Focus
// turns off. The choice survives a reload and a switch to another session. The thread's end and
// Jump to Latest leave the button's corner free. At the Fold's cover screen (475×670, touch,
// DPR 2.625) and unfolded (933×620): a following view stays at the end through the change.
//
//   pnpm run build && pnpm run e2e:focus-view
//
// By default it hosts its own server (scripts/e2e/self-hosted.mjs). Against one already running
// (say `pnpm run dev:hermetic`): SOVA_E2E_PORT=<its port>, SOVA_E2E_AGENT its agent dir when it
// isn't this worktree's .agent. SOVA_E2E_SHOTS=<dir> also writes after-{cover,unfolded}-{off,on}-
// {dark,light}.png there. SOVA_E2E_CDP, a browser already running (CDP URL); SOVA_E2E_CHROMIUM, a
// Chromium binary to launch directly instead of the skill's start-browser.sh.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";
import { whenListed } from "./listed.mjs";
import { selfHosted } from "./self-hosted.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SELF = process.env.SOVA_E2E_PORT ? null : await selfHosted({ label: "e2e-focus" }).catch((err) => {
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

// ---- fixtures: two plain sessions, long enough to scroll ----
const cwd = join(AGENT, "e2e-focus-cwd");
mkdirSync(cwd, { recursive: true });
const dir = join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
mkdirSync(dir, { recursive: true });
const words = (n, seed) => Array.from({ length: n }, (_, i) => ["focus", "reading", "corner", "draft", "header", "composer", "thread", "quiet"][(i * 3 + seed) % 8]).join(" ");
function writeSession(id, seed, title, { fresh = false } = {}) {
  const file = join(dir, `2026-10-20T00-00-0${seed}-000Z_${id}.jsonl`);
  const t0 = Date.parse("2026-10-20T00:00:00.000Z") + seed * 3_600_000;
  const lines = [{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd }];
  let parent = null;
  let n = 0;
  const push = (e) => {
    lines.push({ ...e, parentId: parent, timestamp: new Date(t0 + n++ * 1000).toISOString() });
    parent = e.id;
  };
  for (let i = 0; i < 14; i++) {
    push({ type: "message", id: `u${seed}_${i}`, message: { role: "user", content: [{ type: "text", text: i === 0 ? title : `Question ${i}: ${words(8 + (i % 5) * 4, i)}` }], timestamp: 0 } });
    push({ type: "message", id: `a${seed}_${i}`, message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 1 + (i % 3) }, (_, k) => words(30 + ((i * 13 + k * 7) % 50), i + k)).join("\n\n") }], provider: "zai", model: "glm-5.3", api: "openai-completions", stopReason: "stop", timestamp: 0 } });
  }
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // A fresh write from no process Sova knows opens read-only (a watched session, "recent").
  if (!fresh) {
    const past = new Date(t0);
    utimesSync(file, past, past);
  }
  return id;
}
const A = writeSession("01a0e2e0-0000-7000-8000-00000000f0c1", 1, "Read the conversation without the chrome");
const B = writeSession("01a0e2e0-0000-7000-8000-00000000f0c2", 2, "A second session to switch to");
const C = writeSession("01a0e2e0-0000-7000-8000-00000000f0c3", 3, "A session another process is writing", { fresh: true });
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

const COVER = { viewport: { width: 475, height: 670 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 };
const UNFOLDED = { viewport: { width: 933, height: 620 }, hasTouch: true, deviceScaleFactor: 1 };
const WIDE = { viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 1 };

async function newPage(device, { theme } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", ...device });
  await ctx.setExtraHTTPHeaders(tokenHeaders(AGENT));
  if (theme === "light")
    await ctx.addInitScript(() => {
      if (!localStorage.getItem("sova:theme")) localStorage.setItem("sova:theme", JSON.stringify({ id: "light", base: "light", tokens: {} }));
    });
  const page = await ctx.newPage();
  return { ctx, page };
}
async function open(page, id) {
  if (page.url() === "about:blank") await page.goto(`${BASE}/${hashOf(id)}`);
  else await page.evaluate((h) => (location.hash = h), hashOf(id));
  await page.waitForFunction((title) => document.querySelector(".session-head-title")?.textContent?.includes(title) && document.querySelectorAll("#transcript .thread > .entry").length > 6, id === A ? "Read the conversation" : id === B ? "A second session" : "another process", { timeout: 30000 });
  await page.locator("#composer-input").waitFor({ timeout: 30000 });
}
const toggle = (page) => page.locator(".transcript-wrap > .focus-toggle");
/** What the screen shows of everything Focus decides, measured in the page. */
const state = (page) =>
  page.evaluate(() => {
    const shown = (el) => !!el && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" && el.getBoundingClientRect().height > 0;
    const head = document.querySelector(".app-main > .session-head");
    const composer = document.querySelector(".app-main > .composer");
    const t = document.getElementById("transcript");
    const btn = document.querySelector(".transcript-wrap > .focus-toggle");
    return {
      focus: document.querySelector(".app")?.getAttribute("data-focus") ?? null,
      pressed: btn?.getAttribute("aria-pressed") ?? null,
      label: btn?.getAttribute("aria-label") ?? null,
      headShown: [...(head?.children ?? [])].filter(shown).map((el) => [...el.classList].find((c) => c.startsWith("app-") || c.startsWith("session-")) ?? el.className),
      metaShown: shown(head?.querySelector(".session-head-meta")),
      titleShown: shown(head?.querySelector(".session-head-title")),
      composerShown: shown(composer),
      composerMounted: !!composer?.isConnected,
      composerInert: !!composer?.inert,
      composerHeight: composer?.getBoundingClientRect().height ?? -1,
      draft: document.getElementById("composer-input")?.value ?? null,
      gap: t ? Math.round(t.scrollHeight - t.scrollTop - t.clientHeight) : null,
      btn: btn?.getBoundingClientRect().toJSON(),
      wrap: document.querySelector(".app-main > .transcript-wrap")?.getBoundingClientRect().toJSON(),
      h: innerHeight,
      w: innerWidth,
    };
  });
const settle = () => sleep(450);

try {
  // ---------------- the cover screen ----------------
  {
    const { ctx, page } = await newPage(COVER);
    await open(page, A);

    await check("cover: one Focus button, named and off, in the transcript's bottom-right corner", async () => {
      const s = await state(page);
      assert(s.w === 475, `width ${s.w}`);
      assert(s.label === "Focus" && s.pressed === "false" && s.focus === null, JSON.stringify(s));
      assert((await toggle(page).count()) === 1, "exactly one button");
      assert((await toggle(page).getAttribute("title")) === "Focus", "title Focus");
      assert(Math.round(s.btn.width) === 32 && Math.round(s.btn.height) === 32, `drawn ${s.btn.width}×${s.btn.height}`);
      assert(Math.abs(s.wrap.right - s.btn.right - 12) <= 1 && Math.abs(s.wrap.bottom - s.btn.bottom - 12) <= 1, `corner: wrap ${JSON.stringify(s.wrap)} btn ${JSON.stringify(s.btn)}`);
      assert(s.composerShown && s.metaShown, "the composer and the path line show while off");
    });

    await check("cover: its target is 44px (the ::after)", async () => {
      const after = await toggle(page).evaluate((b) => {
        const a = getComputedStyle(b, "::after");
        return { content: a.content, inset: a.top };
      });
      assert(after.content !== "none" && after.inset === "-6px", JSON.stringify(after));
    });

    await check("cover: the last message and its actions end above the button", async () => {
      const r = await page.evaluate(() => {
        const t = document.getElementById("transcript");
        t.scrollTop = t.scrollHeight;
        const last = [...document.querySelectorAll("#transcript .message-actions")].at(-1);
        return { actions: last?.getBoundingClientRect().bottom, btn: document.querySelector(".focus-toggle").getBoundingClientRect().top };
      });
      assert(r.actions !== undefined && r.actions <= r.btn, JSON.stringify(r));
    });

    const DRAFT = "A half-written thought about focus";
    await page.locator("#composer-input").fill(DRAFT);

    await check("cover: Focus on hides the head's extras, the composer, and keeps Back, the title and the draft", async () => {
      await toggle(page).click();
      await settle();
      const s = await state(page);
      assert(s.focus === "on" && s.pressed === "true", JSON.stringify(s));
      assert(JSON.stringify(s.headShown) === JSON.stringify(["app-back", "session-head-main"]), `head shows ${JSON.stringify(s.headShown)}`);
      assert(!s.metaShown && s.titleShown, "title only");
      assert(!s.composerShown && s.composerMounted && s.composerInert && s.composerHeight === 0, JSON.stringify(s));
      assert(s.draft === DRAFT, `draft ${s.draft}`);
    });

    await check("cover: Focus on puts the button at the bottom edge, in the same corner, and the view stays at the end", async () => {
      const s = await state(page);
      assert(Math.abs(s.h - s.btn.bottom - 12) <= 1 && Math.abs(s.w - s.btn.right - 12) <= 1, `btn ${JSON.stringify(s.btn)} in ${s.w}×${s.h}`);
      assert(s.gap <= 2, `gap from the end ${s.gap}`);
      const r = await page.evaluate(() => {
        const last = [...document.querySelectorAll("#transcript .message-actions")].at(-1);
        return { actions: last?.getBoundingClientRect().bottom, btn: document.querySelector(".focus-toggle").getBoundingClientRect().top };
      });
      assert(r.actions <= r.btn, `last actions ${r.actions} vs button top ${r.btn}`);
    });

    await check("cover: a strip under the head collapses too (stand-in Current goal and baton strips)", async () => {
      const r = await page.evaluate(() => {
        const main = document.querySelector(".app-main");
        const head = main.querySelector(":scope > .session-head");
        const made = ["outline", "baton-strip", "po-status", "po-status po-status-error"].map((cls) => {
          const el = document.createElement(cls === "outline" ? "details" : "section");
          el.className = cls;
          el.textContent = "stand-in";
          head.after(el);
          return el;
        });
        const out = made.map((el) => ({ cls: el.className, vis: getComputedStyle(el).visibility, h: el.getBoundingClientRect().height }));
        made.forEach((el) => el.remove());
        return out;
      });
      for (const x of r.slice(0, 3)) assert(x.vis === "hidden" && x.h === 0, JSON.stringify(x));
      assert(r[3].vis === "visible" && r[3].h > 0, `the status error stays: ${JSON.stringify(r[3])}`);
    });

    await check("cover: a notice in the transcript still shows in Focus (stand-in banner)", async () => {
      const r = await page.evaluate(() => {
        const slot = document.querySelector("#transcript .transcript-banner");
        if (!slot) return { slot: false };
        const b = document.createElement("div");
        b.className = "banner banner-error";
        b.textContent = "Lost the connection. Reconnecting.";
        (slot.firstElementChild ?? slot).appendChild(b);
        const out = { slot: true, display: getComputedStyle(slot).display, h: b.getBoundingClientRect().height, vis: getComputedStyle(b).visibility };
        b.remove();
        return out;
      });
      assert(r.slot && r.display !== "none" && r.h > 0 && r.vis === "visible", JSON.stringify(r));
    });

    await check("cover: Jump to Latest and the button never overlap", async () => {
      const t = page.locator("#transcript");
      const box = await t.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -400);
      await page.waitForSelector(".jump-latest[data-shown]", { timeout: 5000 });
      const r = await page.evaluate(() => [".jump-latest", ".focus-toggle"].map((s) => document.querySelector(s).getBoundingClientRect().toJSON()));
      const [j, f] = r;
      assert(j.right <= f.left || j.bottom <= f.top || j.top >= f.bottom, `jump ${JSON.stringify(j)} focus ${JSON.stringify(f)}`);
      await page.locator(".jump-latest").click();
      await settle();
    });

    await check("cover: Focus persists across a reload", async () => {
      await page.reload();
      await page.locator("#composer-input").waitFor({ state: "attached", timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll("#transcript .thread > .entry").length > 6, null, { timeout: 30000 });
      const s = await state(page);
      assert(s.focus === "on" && s.pressed === "true" && !s.composerShown, JSON.stringify(s));
      assert((await page.evaluate(() => localStorage.getItem("sova:focus"))) === "true", "stored as true");
    });

    await check("cover: Focus persists across a switch to another session, through the list", async () => {
      await page.evaluate(() => (location.hash = "#/"));
      await page.waitForFunction(() => document.querySelector(".app")?.getAttribute("data-view") === "list", null, { timeout: 10000 });
      await page.evaluate((h) => (location.hash = h), hashOf(B));
      await page.waitForFunction(() => document.querySelector(".session-head-title")?.textContent?.includes("A second session") && document.querySelectorAll("#transcript .thread > .entry").length > 6, null, { timeout: 30000 });
      await settle();
      const s = await state(page);
      assert(s.focus === "on" && s.pressed === "true" && !s.composerShown, JSON.stringify(s));
      assert(JSON.stringify(s.headShown) === JSON.stringify(["app-back", "session-head-main"]), `head shows ${JSON.stringify(s.headShown)}`);
    });

    await check("cover: the keyboard reaches the button and toggles it; the draft comes back", async () => {
      await page.evaluate((h) => (location.hash = h), hashOf(A));
      await page.waitForFunction(() => document.querySelector(".session-head-title")?.textContent?.includes("Read the conversation"), null, { timeout: 30000 });
      await settle();
      await toggle(page).focus();
      await page.keyboard.press("Enter");
      await settle();
      const s = await state(page);
      assert(s.focus === null && s.pressed === "false" && s.composerShown && !s.composerInert, JSON.stringify(s));
      assert(s.draft === DRAFT, `the draft after the round trip: ${s.draft}`);
      assert(await toggle(page).evaluate((b) => document.activeElement === b), "focus stays on the button");
    });
    await ctx.close();
  }

  // ---------------- a watched session ----------------
  {
    const { ctx, page } = await newPage(COVER);
    await page.goto(`${BASE}/${hashOf(C)}`);
    const watched = await page
      .waitForFunction(() => document.querySelector(".app-main > .composer textarea")?.disabled === true && document.querySelectorAll("#transcript .thread > .entry").length > 6, null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!watched) skip("watch: Focus hides the read-only composer", "the fresh fixture didn't open read-only here");
    else
      await check("watch: the button is there, and Focus hides the read-only composer and its reason", async () => {
        assert((await toggle(page).count()) === 1, "one button");
        await toggle(page).click();
        await settle();
        const s = await state(page);
        assert(s.focus === "on" && !s.composerShown && s.composerMounted, JSON.stringify(s));
        await toggle(page).click();
        await settle();
      });
    await ctx.close();
  }

  // ---------------- unfolded ----------------
  {
    const { ctx, page } = await newPage(UNFOLDED);
    await open(page, A);
    await check("unfolded: Focus on leaves the title alone in the head; the sessions pane is untouched", async () => {
      const before = await page.evaluate(() => document.querySelector(".app-sidebar").getBoundingClientRect().toJSON());
      await toggle(page).click();
      await settle();
      const s = await state(page);
      assert(s.w === 933, `width ${s.w}`);
      assert(JSON.stringify(s.headShown) === JSON.stringify(["session-head-main"]), `head shows ${JSON.stringify(s.headShown)}`);
      assert(!s.composerShown && s.gap <= 2, JSON.stringify(s));
      const after = await page.evaluate(() => document.querySelector(".app-sidebar").getBoundingClientRect().toJSON());
      assert(JSON.stringify(before) === JSON.stringify(after), `sidebar moved: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    });
    await check("unfolded: the composer collapses over about 0.2 s, and comes back the same way", async () => {
      // Focus is on from the check above: turn it off and on, sampling the composer mid-way.
      const sample = () =>
        page.evaluate(
          () =>
            new Promise((done) => {
              const c = document.querySelector(".app-main > .composer");
              const hs = [];
              const t0 = performance.now();
              document.querySelector(".focus-toggle").click();
              const tick = () => {
                hs.push(Math.round(c.getBoundingClientRect().height));
                if (performance.now() - t0 < 400) requestAnimationFrame(tick);
                else done(hs);
              };
              requestAnimationFrame(tick);
            }),
        );
      const opening = await sample();
      const full = opening.at(-1);
      assert(full > 60 && opening.some((h) => h > 0 && h < full), `back: ${opening.join(",")}`);
      const closing = await sample();
      assert(closing.at(-1) === 0 && closing.some((h) => h > 0 && h < full), `away: ${closing.join(",")}`);
    });

    await check("unfolded: switching sessions from the sidebar keeps Focus on", async () => {
      await page.evaluate((h) => (location.hash = h), hashOf(B));
      await page.waitForFunction(() => document.querySelector(".session-head-title")?.textContent?.includes("A second session"), null, { timeout: 30000 });
      await settle();
      const s = await state(page);
      assert(s.focus === "on" && s.pressed === "true" && !s.composerShown, JSON.stringify(s));
      await toggle(page).click();
      await settle();
    });
    await ctx.close();
  }

  // ---------------- a wide desktop ----------------
  {
    const { ctx, page } = await newPage(WIDE);
    await open(page, A);
    await settle();
    await check("wide: the button's right edge lines up with the composer column's, off the scrollbar", async () => {
      const r = await page.evaluate(() => ({
        btn: document.querySelector(".transcript-wrap > .focus-toggle").getBoundingClientRect().right,
        col: document.querySelector(".composer-inner").getBoundingClientRect().right,
        wrap: document.querySelector(".transcript-wrap").getBoundingClientRect().right,
      }));
      assert(Math.abs(r.btn - r.col) <= 1, JSON.stringify(r));
      assert(r.wrap - r.btn > 100, `clear of the scrollbar: ${JSON.stringify(r)}`);
    });
    await check("wide: Focus on keeps the button in the column's right edge", async () => {
      const col = await page.evaluate(() => document.querySelector(".composer-inner").getBoundingClientRect().right);
      await toggle(page).click();
      await settle();
      const btn = await page.evaluate(() => document.querySelector(".transcript-wrap > .focus-toggle").getBoundingClientRect().right);
      assert(Math.abs(btn - col) <= 1, `btn ${btn} col ${col}`);
      await toggle(page).click();
      await settle();
    });
    await ctx.close();
  }

  // ---------------- the Overseer ----------------
  {
    const { ctx, page } = await newPage(UNFOLDED);
    await page.goto(`${BASE}/#/overseer`);
    const ready = await page
      .locator(".app-main > .transcript-wrap > .focus-toggle")
      .waitFor({ timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) skip("overseer: Focus on its page", "the Overseer didn't open on this server within 30 s");
    else
      await check("overseer: its page has the button, and Focus leaves its head the title alone", async () => {
        await toggle(page).click();
        await settle();
        const s = await state(page);
        assert(s.focus === "on", JSON.stringify(s));
        assert(JSON.stringify(s.headShown) === JSON.stringify(["session-head-main"]), `head shows ${JSON.stringify(s.headShown)}`);
        assert(!s.composerShown && s.composerMounted, JSON.stringify(s));
        await toggle(page).click();
        await settle();
      });
    await ctx.close();
  }

  // ---------------- screenshots ----------------
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const theme of ["dark", "light"])
      for (const [name, device] of [["cover", COVER], ["unfolded", UNFOLDED], ["wide", WIDE]]) {
        const { ctx, page } = await newPage(device, { theme });
        await open(page, A);
        await settle();
        await page.screenshot({ path: join(SHOTS, `after-${name}-off-${theme}.png`) });
        await toggle(page).click();
        await settle();
        await page.screenshot({ path: join(SHOTS, `after-${name}-on-${theme}.png`) });
        await toggle(page).click();
        await settle();
        await ctx.close();
      }
    console.log(`  shots in ${SHOTS}`);
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
