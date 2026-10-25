#!/usr/bin/env node
// E2E: flow drawings in a real browser (§chat.markdown/vis-flow-text, §chat.markdown/vis-flow-focus).
//
// Serves scripts/e2e/flow-focus/ (Sova's figure shell and flow View, as the chat mounts them) with
// Vite and drives it in Chromium at a desktop width and a 390px phone: no drawn text ends in "…";
// each figure is one Tab stop, a panelled one included; a tap picks a shape (aria-pressed, ring,
// neighbours lit, the rest faded) and opens the reading panel; its buttons move the pick; a second
// tap clears it; Escape clears it and goes no further, and with nothing picked reaches the page;
// the arrow keys walk a wide drawing's shapes and scroll its box to them; start and end dots take a
// 32px tap area.
//
//   node scripts/e2e/flow-focus.mjs [--shots <dir>]
//
// SOVA_E2E_CHROMIUM names the browser (default: chromium, then google-chrome-stable on PATH).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const require = createRequire(join(ROOT, "package.json"));
const { chromium } = require("playwright-core");
const { createServer } = await import(require.resolve("vite"));
const solid = (await import(require.resolve("vite-plugin-solid"))).default;

const at = process.argv.indexOf("--shots");
const SHOTS = at > 0 ? resolve(process.argv[at + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const which = (name) => {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
};
const BIN = process.env.SOVA_E2E_CHROMIUM ?? which("chromium") ?? which("google-chrome-stable");
if (!BIN) {
  console.error("no chromium or google-chrome-stable on PATH (SOVA_E2E_CHROMIUM names one)");
  process.exit(2);
}

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  plugins: [solid()],
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  optimizeDeps: { entries: ["scripts/e2e/flow-focus/main.tsx"] },
});
await server.listen();
const url = `${server.resolvedUrls.local[0]}scripts/e2e/flow-focus/index.html`;
const browser = await chromium.launch({ executablePath: BIN, headless: true });

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err?.message ?? err).split("\n").join("\n       ")}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const fig = (id) => `[data-case="${id}"] .vis-flow`;
/** The shape whose accessible name ends with `text` (names are "<Kind>: <its whole text>"). */
const shape = (page, id, text) => page.locator(`${fig(id)} [role="button"][aria-label$="${text}"]`).first();

async function run(width, height, tag) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector(`${fig("login")} svg`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  console.log(`at ${width}px (${tag})`);

  await check(`${tag}: nothing drawn ends in "…", and every shape's whole text is drawn`, async () => {
    const cut = await page.$$eval(".vis-flow svg text", (ts) => ts.map((t) => t.textContent ?? "").filter((t) => t.includes("…")));
    assert(cut.length === 0, `cut: ${JSON.stringify(cut)}`);
    const proj = await page.$eval(`${fig("login")} svg`, (svg) => [...svg.querySelectorAll(".vis-node-label")].map((t) => [...t.querySelectorAll("tspan")].map((s) => s.textContent).join(" ")));
    assert(proj.includes("Project has a login? (its own, else its org's)"), JSON.stringify(proj));
    const tooltips = await page.$$eval(".vis-flow .vis-node title", (t) => t.length);
    assert(tooltips === 0, `${tooltips} shape tooltips`);
  });

  await check(`${tag}: questions are hexagons`, async () => {
    const pts = await page.$eval(`${fig("login")} [aria-label^="Question: Ready here"] > polygon`, (p) => p.getAttribute("points"));
    assert(pts && pts.trim().split(/\s+/).length === 6, `points ${pts}`);
  });

  await check(`${tag}: each figure is one Tab stop, the panelled one included`, async () => {
    await page.focus("#before");
    const stops = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      stops.push(await page.evaluate(() => document.activeElement?.closest("[data-case]")?.getAttribute("data-case") ?? document.activeElement?.id ?? "?"));
    }
    assert(JSON.stringify(stops) === JSON.stringify(["login", "sections", "wide", "state", "after", "?"]) || JSON.stringify(stops.slice(0, 5)) === JSON.stringify(["login", "sections", "wide", "state", "after"]), `stops ${JSON.stringify(stops)}`);
  });

  if (SHOTS) await page.locator('[data-case="login"]').screenshot({ path: join(SHOTS, `login-${tag}-before.png`) });

  await check(`${tag}: a tap picks a shape, lights its neighbours, fades the rest and opens the panel`, async () => {
    await shape(page, "login", "to borrow in the pool?").click();
    const pressed = await page.$$eval(`${fig("login")} [aria-pressed="true"]`, (g) => g.map((x) => x.getAttribute("aria-label")));
    assert(pressed.length === 1 && pressed[0].startsWith("Question: Ready here"), JSON.stringify(pressed));
    const cls = await page.$$eval(`${fig("login")} .vis-node`, (g) => Object.fromEntries(g.map((x) => [x.getAttribute("aria-label"), ["sel", "near", "dim"].find((c) => x.classList.contains(`vis-flow-${c}`))])));
    const near = Object.entries(cls).filter(([, c]) => c === "near").map(([n]) => n.split(":")[0] + ":" + n.split(":")[1].slice(0, 14));
    assert(near.length === 3, `near ${JSON.stringify(near)}`);
    assert(Object.values(cls).filter((c) => c === "dim").length === 5, JSON.stringify(cls));
    const lit = await page.$$eval(`${fig("login")} .vis-edge.vis-flow-near`, (e) => e.length);
    assert(lit === 3, `${lit} lit arrows`);
    const opacity = await page.$eval(`${fig("login")} .vis-node.vis-flow-dim`, (g) => getComputedStyle(g).opacity);
    assert(Number(opacity) < 0.5, `dim opacity ${opacity}`);
    const panel = await page.locator(`${fig("login")} .vis-flow-read`).innerText();
    assert(/QUESTION/i.test(panel) && panel.includes("Ready here, or free") && panel.includes("From") && panel.includes("Leads to"), panel);
    const chips = await page.$$eval(`${fig("login")} .vis-flow-read button`, (b) => b.map((x) => x.textContent));
    assert(JSON.stringify(chips) === JSON.stringify(["Project has a login? (its own, else its org's)", "yes → The project's login", "no → Limit choice (question 2)"]), JSON.stringify(chips));
    const order = await page.$eval(`[data-case="login"]`, (c) => {
      const p = c.querySelector(".vis-flow-read");
      const notes = c.querySelector(".vis-notes");
      return !!p && !!notes && !!(p.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert(order, "the panel sits above the notes");
  });

  if (SHOTS) await page.locator('[data-case="login"]').screenshot({ path: join(SHOTS, `login-${tag}-picked.png`) });

  await check(`${tag}: a panel button moves the pick; its mark note shows with its number`, async () => {
    await page.locator(`${fig("login")} .vis-flow-read button`, { hasText: "no → Limit choice" }).click();
    const pressed = await page.$$eval(`${fig("login")} [aria-pressed="true"]`, (g) => g.map((x) => x.getAttribute("aria-label")));
    assert(pressed.length === 1 && pressed[0].startsWith("Question: Limit choice"), JSON.stringify(pressed));
    const panel = await page.locator(`${fig("login")} .vis-flow-read`).innerText();
    assert(panel.includes("your call in question 2") && /\b2\b/.test(panel), panel);
    const focused = await page.evaluate(() => document.activeElement?.classList.contains("vis-flow"));
    assert(focused, "the figure keeps focus after its button went away");
  });

  await check(`${tag}: Escape clears the pick and goes no further; with nothing picked it reaches the page`, async () => {
    const before = await page.evaluate(() => window.escapes);
    await page.keyboard.press("Escape");
    assert((await page.$$eval(`${fig("login")} [aria-pressed="true"]`, (g) => g.length)) === 0, "still picked");
    assert((await page.$$(`${fig("login")} .vis-flow-read`)).length === 0, "panel still open");
    assert((await page.evaluate(() => window.escapes)) === before, "Escape reached the page while a shape was picked");
    await page.keyboard.press("Escape");
    assert((await page.evaluate(() => window.escapes)) === before + 1, "with nothing picked, Escape goes on");
  });

  await check(`${tag}: tapping the picked shape again clears it`, async () => {
    const s = shape(page, "login", "That login");
    await s.click();
    assert((await s.getAttribute("aria-pressed")) === "true", "picked");
    await s.click();
    assert((await s.getAttribute("aria-pressed")) === "false", "cleared");
    assert((await page.$$(`${fig("login")} .vis-flow-dim`)).length === 0, "nothing faded");
  });

  await check(`${tag}: keyboard: Enter picks the shape under the cursor, arrows move it`, async () => {
    await page.focus(fig("login"));
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    const active = await page.$eval(fig("login"), (r) => document.getElementById(r.getAttribute("aria-activedescendant") ?? "")?.getAttribute("aria-label"));
    assert(active?.startsWith("Question: Login picked"), String(active));
    await page.keyboard.press("Enter");
    assert((await page.$$eval(`${fig("login")} [aria-pressed="true"]`, (g) => g.map((x) => x.getAttribute("aria-label"))))[0]?.startsWith("Question: Login picked"), "Enter picked it");
    await page.keyboard.press(" ");
    assert((await page.$$eval(`${fig("login")} [aria-pressed="true"]`, (g) => g.length)) === 0, "Space cleared it");
  });

  await check(`${tag}: a panelled figure picks one shape at a time, its panel under the drawing that holds it`, async () => {
    await shape(page, "sections", "used to be cut short?").click();
    await shape(page, "sections", "every word shown on the drawing?").click();
    const pressed = await page.$$eval(`${fig("sections")} [aria-pressed="true"]`, (g) => g.length);
    assert(pressed === 1, `${pressed} picked`);
    const where = await page.$$eval(`${fig("sections")} .vis-flow-section`, (ss) => ss.map((s) => !!s.querySelector(".vis-flow-read")));
    assert(JSON.stringify(where) === "[false,true]", JSON.stringify(where));
    await page.keyboard.press("Escape");
  });

  await check(`${tag}: the arrow keys walk a wide drawing and scroll its box to each shape`, async () => {
    const box = page.locator(`${fig("wide")} .vis-scroll`);
    const scrolls = await box.evaluate((b) => b.scrollWidth > b.clientWidth + 1);
    await page.focus(fig("wide"));
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    const start = await box.evaluate((b) => b.scrollLeft);
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
    const end = await box.evaluate((b) => b.scrollLeft);
    const active = await page.$eval(fig("wide"), (r) => document.getElementById(r.getAttribute("aria-activedescendant") ?? "")?.getAttribute("aria-label"));
    assert(active?.includes("Region number"), String(active));
    if (scrolls) {
      assert(end > start, `scrollLeft ${start} → ${end}`);
      const visible = await page.$eval(fig("wide"), (r) => {
        const g = document.getElementById(r.getAttribute("aria-activedescendant") ?? "");
        const a = g.getBoundingClientRect();
        const b = r.querySelector(".vis-scroll").getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      });
      assert(visible, "the cursor's shape is inside the scrolled box");
    } else console.log("       (fits at this width: nothing to scroll)");
    if (SHOTS && scrolls) await page.locator('[data-case="wide"]').screenshot({ path: join(SHOTS, `wide-${tag}-arrowright.png`) });
  });

  await check(`${tag}: a state machine's dots take a 32px tap area; its kinds are Start, State, End`, async () => {
    const hit = await page.$eval(`${fig("state")} .vis-flow-hit`, (r) => r.getBoundingClientRect());
    assert(hit.width >= 25 && hit.height >= 25, `hit ${hit.width}×${hit.height} on screen (32 in the drawing)`);
    const paint = await page.$eval(`${fig("state")} .vis-flow-hit`, (r) => [getComputedStyle(r).fill, getComputedStyle(r).stroke]);
    assert(/rgba\(0, 0, 0, 0\)|transparent/.test(paint[0]) && paint[1] === "none", `the tap area is drawn: ${paint}`);
    await page.locator(`${fig("state")} [aria-label^="Start"]`).first().click({ position: { x: 2, y: 2 } });
    const panel = await page.locator(`${fig("state")} .vis-flow-read`).innerText();
    assert(/START/i.test(panel), panel);
    await page.locator(`${fig("state")} .vis-flow-read button`).first().click();
    assert(/STATE/i.test(await page.locator(`${fig("state")} .vis-flow-read`).innerText()), "State");
    await page.keyboard.press("Escape");
  });

  if (SHOTS) {
    await shape(page, "login", "to borrow in the pool?").click();
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(100);
    await page.locator('[data-case="login"]').screenshot({ path: join(SHOTS, `login-${tag}-picked-dark.png`) });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.focus(fig("login"));
    await page.keyboard.press("ArrowDown");
    await page.locator('[data-case="login"]').screenshot({ path: join(SHOTS, `login-${tag}-keyboard.png`) });
    await page.keyboard.press("Escape");
    await page.locator('[data-case="state"]').screenshot({ path: join(SHOTS, `state-${tag}.png`) });
    await page.locator('[data-case="sections"]').screenshot({ path: join(SHOTS, `sections-${tag}.png`) });
  }
  await check(`${tag}: no page errors`, async () => assert(errors.length === 0, errors.join("\n")));
  await page.close();
}

try {
  await run(1100, 900, "desktop");
  await run(390, 844, "phone");
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
