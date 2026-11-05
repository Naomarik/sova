#!/usr/bin/env node
// The Release screen pass's browser driver: a headless Chromium through this tree's playwright-core (no download),
// one page per size. Each step is JSON on argv[2] (a file): [{name, url, wait?, act?: [..], full?: bool, aria?: bool}].
// `act` entries: {click: "<role>:<name>"} | {clickText: "<text>"} | {press: "Escape"} | {waitText: "<text>"} |
// {route: {url: "<substring>", json: {...}}} (answer that request with JSON: a stubbed API answer, named in the shot).
// Saves <out>/<name>-desktop.png and -phone.png, and <out>/<name>-<size>.aria.txt when aria is set.
//
//   TMPDIR=<short dir> node scripts/e2e-release/shoot.mjs <steps.json> <out dir> [chromium path]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "../../node_modules/playwright-core/index.mjs";

const [stepsFile, out, exe = "/usr/bin/chromium"] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
mkdirSync(out, { recursive: true });
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const [size, viewport] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(size === "phone" ? { isMobile: true, hasTouch: true } : {}) });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
    for (const s of steps) {
      if (s.only && s.only !== size) continue;
      const r = { name: s.name, size, ok: true, notes: [] };
      try {
        for (const a of s.act ?? []) if (a.route) await page.route((u) => u.toString().includes(a.route.url), (rt) => rt.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(a.route.json) }));
        await page.goto(s.url, { waitUntil: "domcontentloaded" });
        // Visible matches only: a phone keeps hidden copies (the collapsed sidebar's Needs you) in the page.
        const vis = (l) => l.filter({ visible: true }).first();
        if (s.wait) await vis(page.getByText(s.wait, { exact: false })).waitFor({ timeout: 20_000 });
        for (const a of s.act ?? []) {
          if (a.click) {
            const [role, ...rest] = a.click.split(":");
            await vis(page.getByRole(role, { name: rest.join(":"), exact: false })).click({ timeout: 10_000 });
          } else if (a.clickText) await vis(page.getByText(a.clickText, { exact: false })).click({ timeout: 10_000 });
          else if (a.press) await page.keyboard.press(a.press);
          else if (a.waitText) await vis(page.getByText(a.waitText, { exact: false })).waitFor({ timeout: 20_000 });
          else if (a.scroll) await vis(page.getByText(a.scroll, { exact: false })).evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 10_000 });
          else if (a.ms) await page.waitForTimeout(a.ms);
        }
        await page.waitForTimeout(400); // the last paint after the awaited text (an animation frame or two)
        const w = await page.evaluate(() => innerWidth);
        if (w !== viewport.width) r.notes.push(`innerWidth ${w} != ${viewport.width}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (overflow > 1) r.notes.push(`horizontal overflow ${overflow}px`);
        await page.screenshot({ path: join(out, `${s.name}-${size}.png`), fullPage: !!s.full });
        if (s.aria) writeFileSync(join(out, `${s.name}-${size}.aria.txt`), await page.locator("body").ariaSnapshot());
      } catch (e) {
        r.ok = false;
        r.notes.push(String(e.message ?? e).split("\n")[0]);
        await page.screenshot({ path: join(out, `${s.name}-${size}-FAILED.png`) }).catch(() => {});
      }
      if (errors.length) r.notes.push(`page errors: ${errors.splice(0).join(" | ").slice(0, 300)}`);
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      results.push(r);
      console.log(JSON.stringify(r));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
