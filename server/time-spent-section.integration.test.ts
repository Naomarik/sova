// Time Spent on the session pane's Session tab in a real Chrome (§app.subagents-pane/time-spent): the
// app's own build, every request answered here. The section sits right under Path and above Repository,
// with no Context section left; a 403 or 404 reads Not Recording and a brief failure doesn't; the rows
// add up to You and an empty row is hidden; a fresh browser shows it closed, with no placeholder and no
// read, and opening or closing it is remembered for all sessions; open, it holds a placeholder, never a
// zero, before the first read; the tick is no live region; every row is one line on one rhythm with a 44px
// hit area on each expander, and at 375px nothing scrolls sideways. Every test but the closed ones opens it first, through the heading, and
// asserts it did. Emphasis follows a figure's place: the same colours for any size, Counting or Paused.
// SPENT_UI_SHOTS=<dir> also saves that test's screenshots. Chrome or Chromium must be installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page, Route } from "playwright-core";
import type { SessionSummary } from "../shared/protocol";
import { TIME_SPENT_READ_ROUTE as READ_ROUTE, TIME_SPENT_REPORT_ROUTE, type TimeSpentRecord } from "../shared/time-spent";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
const SHOTS = process.env.SPENT_UI_SHOTS ?? "";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_TIME_SPENT_DIST=<dir>: drive a build made elsewhere.
  dist = process.env.SOVA_TIME_SPENT_DIST || join(scratchRoot("sova-time-spent-"), "dist");
  if (!process.env.SOVA_TIME_SPENT_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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

/** A press of the heading, and the section says it took. */
async function pressHeading(page: Page, expanded: "true" | "false") {
  const toggle = page.getByRole("button", { name: "Time Spent" });
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), expanded);
}
/** The Session tab of the session the page shows, once the pane is up. */
async function showSessionTab(page: Page) {
  await page.locator('.entry[data-entry="u0"]').waitFor({ timeout: 20_000 });
  await page.locator(".session-details-open").first().click();
  await page.locator("#session-tab-session").click();
  await page.locator(".time-spent").waitFor({ timeout: 20_000 });
}

/** The chat open at `width`, its pane on the Session tab, in a fresh browser; `read` answers the record's
    route. The section starts closed, so it is opened here unless the test is about the closed one. */
async function open(width: number, read: Read, opts: { closed?: boolean; holdReports?: boolean } = {}): Promise<Page> {
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
    // An accepted report clears a refusal, so a test of the read's refusal leaves reports unanswered.
    if (p === TIME_SPENT_REPORT_ROUTE) return opts.holdReports ? undefined : route.fulfill(json({ ok: true }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(PATH)}`);
  await showSessionTab(page);
  if (!opts.closed) await pressHeading(page, "true");
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
    const page = await open(1440, (r) => r.fulfill(json({ error: "no" }, status)), { holdReports: true });
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
    await r.fulfill(json({ ...RECORD, alignments: [], older: false, rows: { "reading-transcript": 100, typing: 60, scrolling: 4 } })).catch(() => {});
  });
  try {
    const section = page.locator(".time-spent");
    assert.equal(await page.locator("[data-time-you]").count(), 0);
    assert.ok((await page.locator(".time-spent .skeleton").count()) > 0);
    const repo = page.locator("section", { has: page.getByRole("heading", { name: "Repository" }) });
    // Against the section's own top: whatever lands above it (the insight's banner) moves both.
    const below = async () => (await repo.boundingBox())!.y - (await section.boundingBox())!.y;
    const before = await below();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "placeholder.png") });
    const h = (await section.boundingBox())!.height;
    answer();
    await word(page).waitFor();
    const moved = Math.abs((await below()) - before);
    // Under a row's height and a bit: the tracker may add a live row of its own, Other (22px).
    assert.ok(moved < 32, `Repository moved ${moved}px (section was ${h}px)`);
  } finally {
    answer();
    await page.context().close();
  }
});

test("the rows add up to You, an empty row doesn't show, and Reading opens to its parts", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    // You and the rows from one read of the page: the tracker may count a second, or a row of its own, between two reads.
    const rows = () =>
      page.locator(".time-spent").evaluate((root) => ({
        you: Number(root.querySelector("[data-time-you]")?.getAttribute("data-seconds")),
        rows: [...root.querySelectorAll("[data-time-row]")].map((e) => [e.getAttribute("data-time-row") ?? "", Number(e.getAttribute("data-seconds"))] as const),
      }));
    const shut = await rows();
    const shutKeys = shut.rows.map(([k]) => k);
    assert.deepEqual(shutKeys.filter((k) => k !== "other"), ["reading", "typing", "scrolling"], "in order; dictating, with no time, doesn't show");
    assert.equal(shut.rows.reduce((n, [, s]) => n + s, 0), shut.you, "the rows add up to You");
    await page.getByRole("button", { name: /^Reading/ }).click();
    const opened = await rows();
    const openedKeys = opened.rows.map(([k]) => k);
    assert.deepEqual(openedKeys.filter((k) => k !== "other"), ["reading", "reading-transcript", "reading-alignments", "typing", "scrolling"], "no time in workers: not shown");
    const at = (k: string) => opened.rows.find(([key]) => key === k)![1];
    assert.equal(at("reading-transcript") + at("reading-alignments"), at("reading"), "the parts add up to Reading");
    const text = await page.locator(".time-spent").innerText();
    assert.doesNotMatch(text, /Your Time/, "the rows need no visible heading"); // the older-session note says "Your time"
    assert.equal(await page.getByRole("list", { name: "Your Time" }).locator("[data-time-row]").count(), opened.rows.length, "the rows keep their name for assistive technology");
    assert.match(text, /Alignments/, "that heading stays");
    assert.match(text, /4m 12s on screen · 2m 10s to read · 1h 01m 40s from first shown to decided/);
    assert.match(text, /12s on screen · 40s to read(?! ·)/);
    assert.match(text, /An estimate\. Reading makes no events/);
    assert.match(text, /Your time before Time Spent arrived wasn't recorded\./);
    assert.equal(await page.locator(".time-spent [aria-live], .time-spent [role=status]").count(), 0, "the tick isn't announced");
  } finally {
    await page.context().close();
  }
});

test("a fresh browser shows only the heading: closed, with no figures, no placeholder and no read", async () => {
  let reads = 0;
  const page = await open(1440, (r) => {
    reads++;
    return r.fulfill(json(RECORD));
  }, { closed: true });
  try {
    const toggle = page.getByRole("button", { name: "Time Spent" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", "closed with nothing remembered");
    assert.equal(await page.evaluate(() => localStorage.getItem("sova:time-spent-open")), null, "nothing remembered: the state is the default's");
    assert.equal(await page.locator(".time-spent .skeleton").count(), 0, "no placeholder while closed");
    assert.equal(await page.locator("[data-time-you], [data-time-word], [data-time-row]").count(), 0);
    assert.equal(await page.locator(".time-spent").innerText().then((t) => t.trim().toLowerCase()), "time spent", "only the heading");
    assert.equal(await toggle.locator(".icon").evaluate((el) => getComputedStyle(el).transform), "none", "the chevron says closed");
    assert.equal(reads, 0, "nothing read for a section nobody opened");
    // The same page opens it: the closed state above wasn't a section that couldn't draw.
    await pressHeading(page, "true");
    await word(page).waitFor();
    assert.ok((await page.locator("[data-time-you]").count()) === 1);
  } finally {
    await page.context().close();
  }
});

test("closing while the first read is out takes the placeholder with it", async () => {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const page = await open(1440, async (r) => {
    await answered;
    await r.fulfill(json(RECORD)).catch(() => {});
  });
  try {
    assert.ok((await page.locator(".time-spent .skeleton").count()) > 0, "open: the placeholder");
    await pressHeading(page, "false");
    assert.equal(await page.locator(".time-spent .skeleton").count(), 0, "closed: none");
  } finally {
    answer();
    await page.context().close();
  }
});

/** A reload onto another session, its pane open on the Session tab. */
async function otherSessionAfterReload(page: Page) {
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(OTHER)}`);
  await page.reload();
  await showSessionTab(page);
}

test("opening is remembered for this browser, in another session and after a reload", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    await otherSessionAfterReload(page);
    assert.equal(await page.getByRole("button", { name: "Time Spent" }).getAttribute("aria-expanded"), "true");
    await word(page).waitFor();
  } finally {
    await page.context().close();
  }
});

test("closing leaves the heading, and is remembered for this browser, in another session and after a reload", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    await pressHeading(page, "false");
    assert.equal(await page.locator("[data-time-you]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Time Spent" }).count(), 1, "the heading stays");
    // The chevron says closed, once its short turn has run.
    const toggle = page.getByRole("button", { name: "Time Spent" });
    await toggle.locator(".icon").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    assert.equal(await toggle.locator(".icon").evaluate((el) => getComputedStyle(el).transform), "none", "the chevron says closed");
    await otherSessionAfterReload(page);
    assert.equal(await page.getByRole("button", { name: "Time Spent" }).getAttribute("aria-expanded"), "false", "another session, after a reload");
    assert.equal(await page.locator("[data-time-you]").count(), 0);
  } finally {
    await page.context().close();
  }
});

/** Each place's text colour: the sub-heading, label and figure of a row, a part, a document, a note, and You. */
const placeColours = (page: Page) =>
  page.locator(".time-spent").evaluate((root) => {
    const colour = (q: string) => {
      const el = root.querySelector(q);
      if (!el) throw new Error(`nothing at ${q}`);
      return getComputedStyle(el).color;
    };
    return {
      you: colour("[data-time-you]"),
      agent: colour("[data-time-agent]"),
      figureLabel: colour(".time-spent-figures dt"),
      word: colour("[data-time-word]"),
      sub: colour(".time-spent-sub"),
      rowLabel: colour('[data-time-row="typing"] > span'),
      rowTime: colour('[data-time-row="typing"] > .text-num'),
      bigRowTime: colour('[data-time-row="reading"] > .text-num'),
      smallRowTime: colour('[data-time-row="scrolling"] > .text-num'),
      partLabel: colour('[data-time-row="reading-transcript"] > span'),
      partTime: colour('[data-time-row="reading-transcript"] > .text-num'),
      docTitle: colour(".time-spent-doc-title"),
      docWords: colour(".time-spent-docs .text-muted"),
      note: colour(".time-spent-notes > .usage-note"),
    };
  });

/** Each expander answers across 44px of height: the hit area, whatever the row's visible height. */
async function targets44(page: Page) {
  for (const name of ["Time Spent", /^Reading/]) {
    const button = page.getByRole("button", { name });
    const missed = await button.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const mid = box.top + box.height / 2;
      return [-21.5, -14, 0, 14, 21.5].filter((dy) => !el.contains(document.elementFromPoint(x, mid + dy)));
    });
    assert.deepEqual(missed, [], `${String(name)}: these offsets from its middle don't reach it`);
  }
}

test("every row is one line tall on one rhythm, Reading's parts hang from it, and the word sits on the figures' line", async () => {
  const page = await open(1440, (r) => r.fulfill(json(RECORD)));
  try {
    await word(page).waitFor();
    const top = (q: string) => page.locator(q).evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
    });
    const row = (k: string) => top(`[data-time-row="${k}"]`);
    const [reading, typing, scrolling] = [await row("reading"), await row("typing"), await row("scrolling")];
    assert.ok(Math.abs(reading.height - typing.height) < 1, `Reading is ${reading.height}px tall, Typing ${typing.height}px`);
    assert.ok(Math.abs(typing.top - reading.top - (scrolling.top - typing.top)) < 1, "an even step between rows");
    await targets44(page);
    const copy = await page.getByRole("button", { name: "Copy Resume Command" }).boundingBox();
    const stolen = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest(".time-spent") !== null, [copy!.x + copy!.width / 2, copy!.y + copy!.height - 2]);
    assert.equal(stolen, false, "the heading's hit area leaves the button above it alone");

    await page.getByRole("button", { name: /^Reading/ }).click();
    const [open2, part, part2, after] = [await row("reading"), await row("reading-transcript"), await row("reading-alignments"), await row("typing")];
    assert.ok(part.left - open2.left >= 12, `a part hangs one step under Reading, not ${part.left - open2.left}px`);
    const guide = await page.locator('[data-time-row="reading-transcript"]').evaluate((el) => getComputedStyle(el.parentElement!).borderLeftWidth);
    assert.notEqual(guide, "0px", "on a guide rule");
    const toParent = part.top - open2.bottom;
    const toNext = after.top - part2.bottom;
    assert.ok(toParent < toNext, `a part sits nearer Reading (${toParent}px) than the row below (${toNext}px)`);

    const [you, agent, said] = [await top("[data-time-you]"), await top("[data-time-agent]"), await top("[data-time-word]")];
    assert.ok(said.top < you.bottom && said.bottom > you.top, "the word is on the figures' line");
    assert.ok(said.left - agent.right <= 32, `the word follows the figures, ${said.left - agent.right}px on`);
  } finally {
    await page.context().close();
  }
});

for (const [width, height] of [[1440, 1300], [375, 1100]] as const) {
  test(`at ${width}px emphasis follows the place: three weights, whatever the size, Counting and Paused alike`, async () => {
    const hours = { ...RECORD, rows: { ...RECORD.rows, "reading-transcript": 90_000, typing: 3_600, scrolling: 1 }, agent: 45_211 };
    const page = await open(width, (r) => r.fulfill(json(hours)));
    try {
      await page.setViewportSize({ width, height });
      await word(page).waitFor();
      await page.locator('[data-time-row="reading"]').click();
      
      const shots = async (state: string) => {
        if (!SHOTS) return;
        for (const theme of ["dark", "light"]) {
          await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null)))); // the theme's transitions have begun...
          await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished.catch(() => {})))); // ...and run
          await page.screenshot({ path: join(SHOTS, `${width}-${state}-${theme}.png`) });
        }
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      };
      await page.mouse.move(5, 5); // off the rows: hover is its own state
      await page.locator('[data-time-word]:text-is("Counting")').waitFor({ timeout: 10_000 });
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      const counting = await placeColours(page);
      assert.equal(counting.you, counting.agent);
      assert.equal(counting.rowTime, counting.you, "a row's time is as bright as the main times");
      assert.equal(counting.bigRowTime, counting.you, "a large figure gets no colour of its own");
      assert.equal(counting.smallRowTime, counting.you, "a small one neither");
      assert.equal(counting.docTitle, counting.you, "a document's title reads as a heading of its line");
      const named = counting.rowLabel;
      assert.notEqual(named, counting.you, "a row's label is quieter than its time");
      assert.equal(counting.sub, named);
      assert.equal(counting.word, named);
      const detail = counting.docWords;
      assert.notEqual(detail, named, "detail is quieter than what names it");
      assert.notEqual(detail, counting.you);
      assert.equal(counting.note, detail);
      assert.equal(counting.partLabel, detail);
      assert.equal(counting.figureLabel, detail);
      assert.equal(counting.partTime, named, "a part's time sits a step under a row's");
      await shots("counting");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.locator('[data-time-word]:text-is("Paused")').waitFor({ timeout: 10_000 });
      assert.deepEqual(await placeColours(page), counting, "the word changes, no colour does");
      await shots("paused");
    } finally {
      await page.context().close();
    }
  });
}

test("at 375px nothing scrolls sideways, and the expanders are 44px targets", async () => {
  const long = { ...RECORD, rows: { ...RECORD.rows, "reading-transcript": 360_000 }, agent: 720_000, alignments: [{ ...RECORD.alignments[0]!, title: "A very long alignment title that has to wrap at the edge of a phone screen without widening anything" }] };
  const page = await open(375, (r) => r.fulfill(json(long)));
  try {
    await word(page).waitFor();
    assert.equal(await page.evaluate(() => innerWidth), 375);
    const panel = page.locator(".session-panel-scroll");
    const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 0, `the panel scrolls sideways by ${overflow}px`);
    await targets44(page);
  } finally {
    await page.context().close();
  }
});
