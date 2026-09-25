// Screenshots of the main screens, through the playwright skill's own browser (start-browser.sh:
// an isolated Chromium on a freshly claimed CDP port, stopped at the end).
//
// Mesh UI is allowed to differ and nothing else: the app marks the root of each mesh-only element
// with `data-mesh-ui`. Per screen the harness COUNTS those nodes (the count must equal what the run
// expects — a marker on the wrong thing, or a missing one, fails), removes them, and then compares
// the rest pixel for pixel and by innerText.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const SKILL = resolve(import.meta.dirname, "../../.claude/skills/playwright/scripts");
const skillRequire = createRequire(join(SKILL, "package.json"));

export async function startBrowser() {
  const out = execFileSync(join(SKILL, "start-browser.sh"), ["--headless"], { cwd: SKILL, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const port = /PW_PORT=(\d+)/.exec(out)?.[1];
  if (!port) throw new Error(`start-browser.sh printed no PW_PORT:\n${out}`);
  const { chromium } = skillRequire("playwright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return {
    browser,
    port,
    stop: async () => {
      try { await browser.close(); } catch {}
      try { execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: port }, stdio: "ignore" }); } catch {}
    },
  };
}

const FREEZE_CSS = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`;

/** The screens: [name, hash, viewport, action?]. `action(page)` opens a dialog after the load. */
export function screenList(f) {
  const s = (p) => `#/s/${encodeURIComponent(p)}`;
  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 390, height: 844 };
  const click = (name) => async (page) => {
    await page.getByRole("button", { name, exact: true }).first().click({ timeout: 5000 });
    await page.waitForTimeout(800);
  };
  return [
    ["home-desktop", "#/", desktop],
    ["home-mobile", "#/", mobile],
    ["session-real-chat", s(f["real-chat"]), desktop],
    ["session-compacted", s(f.compacted), desktop],
    ["session-branched", s(f.branched), desktop],
    ["session-mobile", s(f["real-chat"]), mobile],
    ["usage", "#/usage", desktop],
    ["agents", "#/agents", desktop],
    ["settings", "#/", desktop, click("Settings")],
    ["new-session", "#/", desktop, click("New Session")],
  ];
}

/** Capture every screen of one side into dir; returns name → { png, text, meshUi, width, url, error? }. */
export async function captureScreens(browser, base, f, dir) {
  mkdirSync(dir, { recursive: true });
  const shots = {};
  // One context per side: its own localStorage, so a theme or a sidebar width one side saved
  // cannot leak into the other.
  const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  try {
    // Two passes, the first one discarded: it warms the icon sprites and fonts, whose first load
    // could otherwise race the screenshot (measured: an icon missing on the first session page).
    const passes = [...screenList(f).map(([n, h, v, a]) => [n, h, v, a, true]), ...screenList(f)];
    for (const [name, hash, viewport, action, warmup] of passes) {
      const page = await context.newPage();
      try {
        await page.setViewportSize(viewport);
        await page.goto(`${base}/${hash}`, { waitUntil: "load" });
        await page.addStyleTag({ content: FREEZE_CSS });
        await page.waitForTimeout(2500);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        if (warmup) continue;
        if (action) await action(page);
        await page.evaluate(() => document.fonts.ready);
        const width = await page.evaluate(() => innerWidth);
        if (width !== viewport.width) throw new Error(`viewport is ${width}, wanted ${viewport.width}`);
        const meshUi = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll("[data-mesh-ui]")];
          for (const n of nodes) n.remove();
          return nodes.length;
        });
        await page.waitForTimeout(300);
        const png = join(dir, `${name}.png`);
        await page.screenshot({ path: png, fullPage: false });
        const text = await page.evaluate(() => document.body.innerText);
        writeFileSync(join(dir, `${name}.txt`), text);
        // The accessibility tree: names, roles and states that neither pixels nor innerText show
        // (an aria-label, a title, aria-expanded).
        const aria = await page.locator("body").ariaSnapshot({ timeout: 5000 }).catch((e) => `<ariaSnapshot failed: ${e.message}>`);
        const titles = await page.evaluate(() => [...document.querySelectorAll("[title],[aria-label]")].map((e) => `${e.tagName.toLowerCase()} title=${e.getAttribute("title") ?? ""} label=${e.getAttribute("aria-label") ?? ""}`).join("\n"));
        writeFileSync(join(dir, `${name}.aria.txt`), `${aria}\n--- titles/labels\n${titles}\n`);
        shots[name] = { png, text, aria: `${aria}\n${titles}`, meshUi, width, url: page.url() };
      } catch (err) {
        shots[name] = { error: String(err?.message ?? err) };
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
  return shots;
}

const TOLERANCE = 32;
const MAX_FAINT = 0.005;

/** Pixel comparison with sharp (the skill's own dependency). Writes a diff mask when they differ. */
export async function comparePng(a, b, diffPath) {
  const sharp = skillRequire("sharp");
  const [ra, rb] = await Promise.all([a, b].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height)
    return { same: false, reason: `size ${ra.info.width}x${ra.info.height} vs ${rb.info.width}x${rb.info.height}` };
  const { width, height } = ra.info;
  const mask = Buffer.alloc(width * height * 4);
  let diff = 0;
  let touched = 0;
  let box = null;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const delta = Math.max(Math.abs(ra.data[o] - rb.data[o]), Math.abs(ra.data[o + 1] - rb.data[o + 1]), Math.abs(ra.data[o + 2] - rb.data[o + 2]), Math.abs(ra.data[o + 3] - rb.data[o + 3]));
    if (delta > 0) touched++;
    if (delta <= TOLERANCE) {
      mask[o] = mask[o + 1] = mask[o + 2] = ra.data[o] >> 2;
      mask[o + 3] = 255;
    } else {
      diff++;
      mask[o] = 255;
      mask[o + 3] = 255;
      const x = i % width, y = Math.floor(i / width);
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    }
  }
  // Glyph antialiasing jitters by up to ~17/255 between two renders of the same page (A/A measured),
  // so a pixel within TOLERANCE is equal; but many faint changes are a real change (a colour token
  // nudged), so they may touch at most MAX_FAINT of the image.
  const faintTooMany = touched > width * height * MAX_FAINT;
  const same = diff === 0 && !faintTooMany;
  if (!same) await sharp(mask, { raw: { width, height, channels: 4 } }).png().toFile(diffPath);
  return { same, diffPixels: diff, faintPixels: touched, box, reason: faintTooMany && diff === 0 ? `${touched} faint pixel changes (> ${MAX_FAINT * 100}% of the image)` : undefined, diffPath: same ? undefined : diffPath };
}
