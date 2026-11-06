// Time Spent on the session pane's Session tab in a real Chrome (§app.subagents-pane/time-spent): the
// app's own build, every request answered here. The section sits right under Path and above Repository,
// with no Context section left; a 403 or 404 reads Not Recording and a brief failure doesn't; the rows
// add up to You and an empty row is hidden; closing it is remembered for all sessions; it holds a
// placeholder, never a zero, before the first read; the tick is no live region; and at 375px nothing
// scrolls sideways and each expander is a 44px target. Chrome or Chromium must be installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page, Route } from "playwright-core";
import type { SessionSummary } from "../shared/protocol";
import { TIME_SPENT_READ_ROUTE as READ_ROUTE, TIME_SPENT_REPORT_ROUTE, type TimeSpentRecord } from "../shared/time-spent";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_TIME_SPENT_DIST=<dir>: drive a build made elsewhere.
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

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
const PATH = "/w/sessions/s1.jsonl";
const OTHER = "/w/sessions/s2.jsonl";
const CWD = "/w/projects/shop";
const ITEMS = [
  { id: "u0", kind: "user", text: "Question", at: iso(60) },
  { id: "a0", kind: "assistant-text", text: "Answer.", at: iso(59), model: "mock/m1" },
];
const summary = (path: string, id: string) =>
  ({ path, id, cwd: CWD, title: id, createdAt: iso(90), lastActiveAt: iso(5), live: null, origin: "web", archived: false, busy: false }) as unknown as SessionSummary;

const RECORD: TimeSpentRecord = {
  you: 184,
  rows: { "reading-transcript": 100, "reading-alignments": 20, typing: 60, scrolling: 4 },
  agent: 4328,
  agentRunning: null,
  alignments: [{ docId: "d1", title: "A plan for the pane", onScreen: 252, toRead: 130, firstShownAt: T0, toDecided: 3700 }, { docId: "d2", title: "Still open", onScreen: 12, toRead: 40, firstShownAt: T0, toDecided: null }],
  older: true,
};
const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

type Read = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The chat open at `width`, its pane on the Session tab; `read` answers the record's route. */
async function open(width: number, read: Read, path = PATH): Promise<Page> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 960 }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.send(JSON.stringify({ type: "hello", items: ITEMS, isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === READ_ROUTE) return read(route);
    if (p === "/api/sessions") return route.fulfill(json([summary(PATH, "s1"), summary(OTHER, "s2")]));
    if (p === "/api/transcript") return route.fulfill(json({ items: ITEMS, context: null }));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p === "/api/sessions/git") return route.fulfill(json({ state: "none", cwd: CWD, checkedAt: T0 }));
    if (p === TIME_SPENT_REPORT_ROUTE) return route.fulfill(json({ ok: true }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(path)}`);
  await page.locator('.entry[data-entry="u0"]').waitFor({ timeout: 20_000 });
  await page.locator(".session-details-open").first().click();
  await page.locator("#session-tab-session").click();
  await page.locator(".time-spent").waitFor({ timeout: 20_000 });
  return page;
}
const word = (page: Page) => page.locator("[data-time-word]");
const seconds = async (page: Page, selector: string) => Number(await page.locator(selector).getAttribute("data-seconds"));

test("the Session tab's order is Path, Time Spent, Repository, and the Context section is gone", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    const heads = await page.locator("#session-tabpanel .session-panel-scroll > section").evaluateAll((sections) =>
      sections.map((s) => s.querySelector(".text-eyebrow")?.textContent?.trim()),
    );
    assert.deepEqual(heads.slice(0, 3), ["Path", "Time Spent", "Repository"]);
    assert.ok(!heads.includes("Context"), "no Context section");
    assert.equal(await page.getByText("See what fills it").count(), 0);
  } finally {
    await page.context().close();
  }
});

for (const status of [403, 404]) {
  test(`a ${status} on the read says Not Recording, and shows no zero`, async () => {
    const page = await open(1440, (r) => r.fulfill(json({ error: "no" }, status)));
    try {
      await page.locator('[data-time-word]:text-is("Not Recording")').waitFor({ timeout: 10_000 });
      assert.equal(await page.locator("[data-time-you]").count(), 0, "no figure to read as current");
      assert.equal(await page.locator(".time-spent .skeleton").count(), 0, "the placeholder is gone");
    } finally {
      await page.context().close();
    }
  });
}

test("a brief failure changes no word: no Not Recording, and the next read lands as usual", async () => {
  let reads = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const page = await open(1440, async (r) => {
    if (++reads > 1) return r.fulfill(json(RECORD));
    await released;
    await r.fulfill(json({ error: "down" }, 503)).catch(() => {});
  });
  try {
    // The 503's handling is done once its request finished and the page has run a frame and a task since:
    // reading again any sooner would drop that answer unread and prove nothing.
    const finished = page.waitForEvent("requestfinished", (q) => new URL(q.url()).pathname === READ_ROUTE);
    release();
    await finished;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
    assert.equal(await word(page).count(), 0, "under the failure, neither Not Recording nor any other word");
    assert.ok((await page.locator(".time-spent .skeleton").count()) > 0, "the placeholder, never a zero");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await word(page).waitFor();
    assert.notEqual(await word(page).innerText(), "Not Recording", "a 503 left no refusal behind");
  } finally {
    release();
    await page.context().close();
  }
});

test("You ticks while the word says Counting and Agent takes in a running turn; another tab draws none of it", async () => {
  const page = await open(1440, (r) => r.fulfill(json({ ...RECORD, agentRunning: 5 })));
  try {
    await word(page).waitFor();
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 320);
    await page.locator('[data-time-word]:text-is("Counting")').waitFor({ timeout: 10_000 });
    const you = await seconds(page, "[data-time-you]");
    const agent = await seconds(page, "[data-time-agent]");
    const keepActive = setInterval(() => void page.mouse.move(400 + Math.random() * 40, 300).catch(() => {}), 500);
    try {
      await page.waitForFunction(([y, a]) => {
        const at = (q: string) => Number(document.querySelector(q)?.getAttribute("data-seconds"));
        return at("[data-time-you]") >= y! + 2 && at("[data-time-agent]") >= a! + 2;
      }, [you, agent], { timeout: 15_000 });
    } finally {
      clearInterval(keepActive);
    }
    await page.locator("#session-tab-usage").click();
    assert.equal(await page.locator(".time-spent").count(), 0, "only the Session tab holds it");
  } finally {
    await page.context().close();
  }
});

test("while the first read is out it holds a placeholder about its usual height, never a zero", async () => {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const page = await open(1440, async (r) => {
    await answered;
    await r.fulfill(json({ ...RECORD, alignments: [], older: false, rows: { typing: 60 } })).catch(() => {});
  });
  try {
    const section = page.locator(".time-spent");
    assert.equal(await page.locator("[data-time-you]").count(), 0);
    assert.ok((await page.locator(".time-spent .skeleton").count()) > 0);
    const repo = page.locator("section", { has: page.getByRole("heading", { name: "Repository" }) });
    const before = (await repo.boundingBox())!.y;
    const h = (await section.boundingBox())!.height;
    answer();
    await word(page).waitFor();
    const moved = Math.abs((await repo.boundingBox())!.y - before);
    assert.ok(moved < 48, `Repository moved ${moved}px (section was ${h}px)`);
  } finally {
    answer();
    await page.context().close();
  }
});

test("the rows add up to You, an empty row doesn't show, and Reading opens to its parts", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    const you = await seconds(page, "[data-time-you]");
    const rows = () => page.locator("[data-time-row]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-time-row"), Number(e.getAttribute("data-seconds"))] as const));
    const shut = await rows();
    assert.deepEqual(shut.map(([k]) => k), ["reading", "typing", "scrolling"], "dictating has no time");
    assert.equal(shut.reduce((n, [, s]) => n + s, 0), you, "the rows add up to You");
    await page.getByRole("button", { name: /^Reading/ }).click();
    const opened = await rows();
    assert.deepEqual(opened.map(([k]) => k), ["reading", "reading-transcript", "reading-alignments", "typing", "scrolling"], "no time in workers: not shown");
    const parts = opened.filter(([k]) => k?.startsWith("reading-")).reduce((n, [, s]) => n + s, 0);
    assert.equal(parts, shut[0]![1], "the parts add up to Reading");
    const text = await page.locator(".time-spent").innerText();
    assert.match(text, /4m 12s on screen · 2m 10s to read · 1h 01m 40s from first shown to decided/);
    assert.match(text, /12s on screen · 40s to read(?! ·)/);
    assert.match(text, /An estimate\. Reading makes no events/);
    assert.match(text, /Your time before Time Spent arrived wasn't recorded\./);
    assert.equal(await page.locator(".time-spent [aria-live], .time-spent [role=status]").count(), 0, "the tick isn't announced");
  } finally {
    await page.context().close();
  }
});

test("closing leaves the heading, is remembered for this browser, and holds for another session", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    const toggle = page.getByRole("button", { name: "Time Spent" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "starts open");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    // The chevron says closed, once its short turn has run.
    await toggle.locator(".icon").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    assert.equal(await toggle.locator(".icon").evaluate((el) => getComputedStyle(el).transform), "none", "the chevron says closed");
    assert.equal(await page.locator("[data-time-you]").count(), 0);
    await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(OTHER)}`);
    await page.reload();
    await page.locator('.entry[data-entry="u0"]').waitFor({ timeout: 20_000 });
    await page.locator(".session-details-open").first().click();
    await page.locator("#session-tab-session").click();
    assert.equal(await page.getByRole("button", { name: "Time Spent" }).getAttribute("aria-expanded"), "false", "another session, after a reload");
    assert.equal(await page.locator("[data-time-you]").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("at 375px nothing scrolls sideways and the expanders are 44px targets", async () => {
  const long = { ...RECORD, rows: { ...RECORD.rows, "reading-transcript": 360_000 }, agent: 720_000, alignments: [{ ...RECORD.alignments[0]!, title: "A very long alignment title that has to wrap at the edge of a phone screen without widening anything" }] };
  const page = await open(375, (r) => r.fulfill(json(long)));
  try {
    await word(page).waitFor();
    assert.equal(await page.evaluate(() => innerWidth), 375);
    const panel = page.locator(".session-panel-scroll");
    const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 0, `the panel scrolls sideways by ${overflow}px`);
    for (const name of ["Time Spent", /^Reading/]) {
      const box = (await page.getByRole("button", { name }).boundingBox())!;
      assert.ok(box.height >= 43.5, `${String(name)} is ${box.height}px tall`);
    }
  } finally {
    await page.context().close();
  }
});
