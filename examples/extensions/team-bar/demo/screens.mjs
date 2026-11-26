#!/usr/bin/env node
// Screenshots of the team-bar demonstration, on Kim's copy, with Sova's own playwright-core and a Chromium
// on this machine (CHROMIUM_BIN, else /usr/bin/chromium):
//
//   node examples/extensions/team-bar/demo/screens.mjs [--root <demo root>] --out <folder>
//
// Needs run-demo.mjs running (it reads <root>/demo.json and drives <root>/control) and a built page (`pnpm exec
// vite build`, since the copies serve this checkout's dist/). Each shot is a PNG in <out>:
//   1-bar-avatars.png       the bar with the owner avatars
//   2-person-menu.png       the person menu open
//   3-narrowed-to-lee.png   the list narrowed to one person
//   4-from-name.png         a server chat with "From {name}" on messages typed from other computers
//   5-phone.png             the bar at phone width
//   6-extension-off.png     the same bar with the user part turned off
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(arg("--root") ?? join(ROOT, ".cache", "team-bar-demo"));
const out = resolve(arg("--out") ?? join(root, "screens"));
mkdirSync(out, { recursive: true });
const demo = JSON.parse(readFileSync(join(root, "demo.json"), "utf8"));
const control = (cmd) => writeFileSync(join(root, "control"), cmd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = process.env.CHROMIUM_BIN ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable"].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const shots = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", serviceWorkers: "block" });
  const page = await context.newPage();
  const shot = async (name) => {
    const file = join(out, name);
    await page.screenshot({ path: file });
    shots.push(file);
    console.log(file);
  };
  /** The list holds the shared server's rows (they arrive on the mesh poll) and the avatars. */
  const listReady = async (withAvatars) => {
    await page.getByRole("navigation", { name: "Session list" }).getByText("Update the onboarding checklist").first().waitFor({ timeout: 60_000 });
    if (withAvatars) await page.locator("span.owner-mark").first().waitFor({ timeout: 30_000 });
    await sleep(800);
  };

  control("work");
  await page.goto(demo.kim.unlock);
  await listReady(true);
  await shot("1-bar-avatars.png");

  const menu = page.locator("button.person-menu-trigger").first();
  await menu.click();
  await sleep(300);
  await shot("2-person-menu.png");

  await page.locator('[role=menuitemradio][data-person-id="lee"]').first().click();
  await sleep(500);
  await shot("3-narrowed-to-lee.png");

  await page.getByRole("navigation", { name: "Session list" }).getByText("Update the onboarding checklist").first().click();
  await page.getByText(/From Lee Varga/).first().waitFor({ timeout: 30_000 });
  await sleep(800);
  await shot("4-from-name.png");

  // Back to everyone for the phone and the off shots (the choice is kept per browser).
  await page.evaluate(() => localStorage.removeItem("sova:person-filter"));
  await page.goto(demo.kim.base + "/");
  await listReady(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(800);
  const w = await page.evaluate(() => innerWidth);
  if (w !== 390) throw new Error(`phone width is ${w}, not 390`);
  await shot("5-phone.png");

  await page.setViewportSize({ width: 1440, height: 900 });
  control("off");
  await sleep(4000);
  await page.reload();
  await listReady(false);
  await sleep(1500);
  await shot("6-extension-off.png");
  control("on");
} finally {
  await browser.close();
}
console.log(`${shots.length} screenshots in ${out}`);
