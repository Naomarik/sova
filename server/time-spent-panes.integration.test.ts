// Time Spent's tracker in a real Chrome (§app.subagents-pane/time-spent-counting): the app's own build, served from a
// scratch build with every request answered here (no server, no network), the reports caught as they leave. Two panes:
// the keyboard in pane A's composer and the wheel over pane B count Scrolling for B and nothing for A; a click into A
// moves the count; the chat following new text is no Scrolling and no activity; what is on screen names the row, and an
// alignment card's own seconds overlap it, with no row's content-visibility changed.
// SOVA_TIME_SPENT_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without the rule fails).
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { SessionGroup, SessionSummary } from "../shared/protocol";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
const A = "/w/sessions/a.jsonl";
const B = "/w/sessions/b.jsonl";
const T0 = Date.now();
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
let dist = "";
let browser: Browser;

before(async () => {
  dist = process.env.SOVA_TIME_SPENT_DIST || join(scratchRoot("sova-time-spent-"), "dist");
  if (!process.env.SOVA_TIME_SPENT_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

function row(path: string, title: string): SessionSummary {
  return {
    id: title,
    path,
    cwd: "/w/project",
    title,
    createdAt: iso(60),
    lastActiveAt: iso(1),
    model: "mock/m1",
    context: { tokens: 1, window: 100_000 },
    live: null,
    origin: "web",
    archived: false,
    busy: false,
    groupId: "g1",
  } as unknown as SessionSummary;
}
const GROUP: SessionGroup = { id: "g1", name: "Two panes", createdAt: iso(90), members: [{ id: "alpha" }, { id: "beta" }] };

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Reported {
  path: string;
  slices: { row: string; docs: string[]; sec: number }[];
}

async function open(): Promise<{ page: Page; reports: Reported[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => sessionStorage.setItem("sova:launched", "1"));
  const page = await ctx.newPage();
  const reports: Reported[] = [];
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/time-spent/report") {
      reports.push(route.request().postDataJSON() as Reported);
      return route.fulfill(json({ ok: true }));
    }
    if (p === "/api/sessions") return route.fulfill(json([row(A, "alpha"), row(B, "beta")]));
    if (p === "/api/session-groups") return route.fulfill(json([GROUP]));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/orgs") return route.fulfill(json({ operator: { name: "Operator" }, orgs: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/g/g1`);
  await pane(page, A).locator("textarea").first().waitFor({ timeout: 20_000 });
  await pane(page, B).locator("textarea").first().waitFor({ timeout: 20_000 });
  return { page, reports };
}

const pane = (page: Page, path: string) => page.locator(`.workspace-pane[data-time-session="${path}"]`);

/** Hands over what is counted, as a going page does, and adds up every report so far for one session. */
async function sums(page: Page, reports: Reported[], path: string): Promise<{ total: number; rows: Record<string, number>; docs: Record<string, number> }> {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(300);
  const out = { total: 0, rows: {} as Record<string, number>, docs: {} as Record<string, number> };
  for (const r of reports) {
    if (r.path !== path) continue;
    for (const s of r.slices) {
      out.total += s.sec;
      out.rows[s.row] = (out.rows[s.row] ?? 0) + s.sec;
      for (const d of s.docs) out.docs[d] = (out.docs[d] ?? 0) + s.sec;
    }
  }
  return out;
}

/** The wheel over a pane for about this long, the pointer resting there. */
async function wheelOver(page: Page, path: string, ms: number) {
  const box = await pane(page, path).boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(150);
  }
}

test("the keyboard in A's composer, the wheel over B: B's Scrolling grows, A gets nothing", async () => {
  const { page, reports } = await open();
  const composer = pane(page, A).locator("textarea").first();
  await composer.focus();
  assert.ok(await composer.evaluate((el) => document.activeElement === el), "the keyboard is in A");
  await wheelOver(page, B, 3_500);
  assert.ok(await composer.evaluate((el) => document.activeElement === el), "and stayed in A through the wheel");
  const b = await sums(page, reports, B);
  const a = await sums(page, reports, A);
  assert.ok((b.rows.scrolling ?? 0) >= 2, `B's Scrolling grew: ${JSON.stringify(b)}`);
  assert.equal(a.total, 0, `A counted nothing: ${JSON.stringify(a)}`);

  // The pointer moving into A with a click, and typing there: now A counts, Typing, and B stops.
  const before = b.total;
  await composer.click();
  await page.keyboard.type("hello there", { delay: 180 });
  const typed = await sums(page, reports, A);
  assert.ok((typed.rows.typing ?? 0) >= 1, `A's Typing grew: ${JSON.stringify(typed)}`);
  const after = await sums(page, reports, B);
  assert.ok(after.total <= before + 1, `B stopped within the second it was counting: ${before} then ${after.total}`);
  await page.context().close();
});

test("the chat following new text is no Scrolling, and rows on screen name the second", async () => {
  const { page, reports } = await open();
  const box = await pane(page, A).boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  // Rows of the kind the thread builds, tall enough to scroll, and an alignment's card in a row of its own.
  const entry = await pane(page, A).evaluate((el) => {
    const thread = el.querySelector(".thread")!;
    const add = (html: string) => {
      const row = document.createElement("div");
      row.className = "entry";
      row.style.setProperty("--entry-est", "1200px");
      row.innerHTML = html;
      thread.append(row);
      return row;
    };
    for (let i = 0; i < 6; i++) add(`<p style="height:1200px">words of row ${i}</p>`);
    add(`<p style="height:1200px">last</p>`);
    return getComputedStyle(thread.querySelector(".entry")!).contentVisibility;
  });
  assert.equal(entry, "auto");
  await page.waitForTimeout(2_000);
  // The chat following: the scroller moves with no input behind it, every 200 ms for a few seconds.
  const t0 = Date.now();
  await pane(page, A).locator(".transcript").evaluate((el) => {
    let y = 0;
    (window as unknown as { follow: ReturnType<typeof setInterval> }).follow = setInterval(() => (el.scrollTop = y += 40), 200);
  });
  while (Date.now() - t0 < 3_000) await page.waitForTimeout(200);
  await page.evaluate(() => clearInterval((window as unknown as { follow: ReturnType<typeof setInterval> }).follow));
  const followed = await sums(page, reports, A);
  assert.equal(followed.rows.scrolling ?? 0, 0, `the chat following isn't Scrolling: ${JSON.stringify(followed)}`);
  assert.ok((followed.rows["reading-transcript"] ?? 0) >= 2, `rows on screen read as Reading Transcript: ${JSON.stringify(followed)}`);
  assert.equal(await pane(page, A).locator(".transcript").evaluate((el) => getComputedStyle(el.querySelector(".thread > .entry")!).contentVisibility), "auto", "no row's content-visibility changed");

  // An alignment card filling the screen: the row changes, and the card's own count runs.
  await pane(page, A).evaluate((el) => {
    const row = document.createElement("div");
    row.className = "entry";
    row.style.setProperty("--entry-est", "3000px");
    row.innerHTML = `<article data-align-doc="doc-1" style="height:3000px">a card</article>`;
    el.querySelector(".thread")!.append(row);
    const t = el.querySelector(".transcript")!;
    t.scrollTop = t.scrollHeight;
  });
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2);
  await page.waitForTimeout(3_000);
  const carded = await sums(page, reports, A);
  assert.ok((carded.rows["reading-alignments"] ?? 0) >= 1, `the card names the second: ${JSON.stringify(carded)}`);
  assert.ok((carded.docs["doc-1"] ?? 0) >= 1, `and its own count runs: ${JSON.stringify(carded)}`);
  await page.context().close();
});
