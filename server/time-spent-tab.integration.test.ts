// The Time Spent tab in a real Chrome (§app.subagents-pane/time-spent): the app's own build, every request
// answered here, on a believable session whose figures add up. SPENT_TAB_SHOTS=<dir> also saves the
// screenshots of the tab at both widths and of the Session tab it left. Chrome or Chromium must be installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page, Route } from "playwright-core";
import type { SessionSummary } from "../shared/protocol";
import { TIME_SPENT_READ_ROUTE, TIME_SPENT_REPORT_ROUTE, type TimeSpentMessage, type TimeSpentRecord } from "../shared/time-spent";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
const SHOTS = process.env.SPENT_TAB_SHOTS ?? "";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_TIME_SPENT_DIST=<dir>: drive a build made elsewhere.
  dist = process.env.SOVA_TIME_SPENT_DIST || join(scratchRoot("sova-time-spent-tab-"), "dist");
  if (!process.env.SOVA_TIME_SPENT_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  if (process.env.SPENT_FADE_SHOTS) mkdirSync(process.env.SPENT_FADE_SHOTS, { recursive: true });
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const PATH = "/home/you/.pi/agent/sessions/shop/checkout-totals.jsonl";
const CWD = "/home/you/projects/shop";
const TITLE = "Checkout totals off by a cent";

const summary = (path: string, id: string, title: string) =>
  ({ path, id, cwd: CWD, title, createdAt: iso(300), lastActiveAt: iso(9), live: null, origin: "web", archived: false, busy: false }) as unknown as SessionSummary;

/** A row's messages from [excerpt, seconds]; the row's seconds are their sum. */
const said = (key: string, list: readonly (readonly [string, number, string?])[]) => {
  const messages: TimeSpentMessage[] = list.map(([excerpt, seconds, labelledBy], i) => ({ id: `${key}-${i}`, excerpt, seconds, ...(labelledBy ? { labelledBy } : {}) }));
  return { seconds: messages.reduce((n, m) => n + m.seconds, 0), messages };
};
const SPECIFYING = said("specifying", [
  ["The checkout total is a cent off the sum of the lines on orders with a percentage discount. Find out why and fix it.", 164],
  ["Before you start, keep the old rounding behind a flag so we can compare the 2 for a week.", 214],
  ["Yes, go with the second option.", 72],
  ["Plan it for the invoice PDF as well, it has to use the same totals.", 176],
  ["Leave the currency formatting out of this, that's another branch.", 118],
  ["Option 1.", 41],
  ["Approved. Do the same on the cart page.", 96],
  ["Add a test for a zero-tax region to the plan.", 96],
  ["Pick the first one.", 34],
  ["Don't touch the database for this, keep it in the pricing module.", 118],
]);
const DIRECTING = said("directing", [
  ["Looks right. Run the whole checkout suite and show me the receipt at phone width.", 118],
  ["Show me the receipt with 2 discounts on it.", 88],
  ["Good. Commit this.", 53],
  ["Do the refund path first, then the receipts.", 142],
  ["Now the refund path.", 127],
  ["Carry on.", 22],
  ["Yes.", 18],
  ["Show me the failing test.", 92],
  ["Go ahead and rerun it.", 61],
  ["Commit that, then start on the invoice PDF.", 136],
]);
const REWORKING = said("reworking", [
  ["No, the rounding should happen per line, not on the order total. Redo this.", 412],
  ["The receipt still shows the old tax label, that's not what I asked for.", 286, "zai/glm-5.3"],
  ["Move the discount above the tax line and use the same row style as the others.", 198],
  ["The phone totals wrap onto 2 lines now. Put them back on 1.", 142],
]);
const ASKING = said("asking", [
  ["Why does the cart round differently from the receipt?", 184],
  ["Which regions charge tax on shipping?", 112],
  ["What does the old flag do when it's off?", 96],
  ["How many orders would this have changed last month?", 148],
  ["Is the refund total computed from the same lines?", 72],
]);
const NOT_LABELLED = said("not-labelled", [
  ["And the same for gift cards.", 58],
  ["That fixes the cent, what's left on the invoice?", 68],
]);
/** The chat holds exactly the messages the rows count, each with a reply; the curated last stretch is what shows. */
const LAST_REPLIES: Record<string, string> = {
  "No, the rounding should happen per line, not on the order total. Redo this.": "Done. Each line now rounds its own discount and tax, and the total is the plain sum of the lines. `pricing.test.ts` has 6 new cases, including the 3-line order that showed the cent.\n\nAll 214 pricing tests pass.",
  "Move the discount above the tax line and use the same row style as the others.": "Moved. The discount now sits above tax on the cart, the checkout summary and the receipt, in the same row as the other figures.",
  "Looks right. Run the whole checkout suite and show me the receipt at phone width.": "The checkout suite passes: 88 tests. The receipt at 375px holds every figure on one line, and nothing scrolls sideways.",
};
const SENT = [...SPECIFYING.messages, ...DIRECTING.messages, ...REWORKING.messages, ...ASKING.messages, ...NOT_LABELLED.messages]
  .map((m) => m.excerpt)
  .sort((a, b) => Number(a in LAST_REPLIES) - Number(b in LAST_REPLIES));
const LAST_ORDER = Object.keys(LAST_REPLIES);
const ORDERED = [...SENT.filter((t) => !(t in LAST_REPLIES)), ...LAST_ORDER];
const ITEMS = ORDERED.flatMap((text, i) => {
  const minAgo = i >= ORDERED.length - 3 ? [88, 41, 12][i - (ORDERED.length - 3)]! : 118 - i;
  return [
    { id: `u${i + 1}`, kind: "user", text, at: iso(minAgo) },
    { id: `a${i + 1}`, kind: "assistant-text", text: LAST_REPLIES[text] ?? "Done, and the pricing tests pass.", at: iso(minAgo - 3), model: "zai/glm-5.3" },
  ];
});

/** Every figure below adds up: the activity rows to You, Your Messages to You, Reading's parts and the split to their rows. */
const RECORD: TimeSpentRecord = {
  you: 4472,
  rows: { "reading-transcript": 1460, "reading-alignments": 742, "reading-workers": 198, typing: 612, dictating: 318, scrolling: 224, changes: 428, screenshots: 356, tours: 96, other: 38 },
  agent: 10_964,
  agentRunning: null,
  alignments: [
    { docId: "d1", title: "Rounding: per line or on the total", onScreen: 412, toRead: 130, firstShownAt: NOW - 90 * 60_000, toDecided: 1846 },
    { docId: "d2", title: "Where the discount sits on the receipt", onScreen: 214, toRead: 95, firstShownAt: NOW - 44 * 60_000, toDecided: 622 },
    { docId: "d3", title: "The invoice PDF's totals", onScreen: 116, toRead: 160, firstShownAt: NOW - 11 * 60_000, toDecided: null },
  ],
  older: false,
  messages: {
    rows: [
      { key: "specifying", ...SPECIFYING },
      { key: "directing", ...DIRECTING },
      { key: "reworking", ...REWORKING },
      { key: "asking", ...ASKING },
      { key: "not-labelled", ...NOT_LABELLED },
    ],
    beforeAction: { count: 3, seconds: 518 },
    sinceLast: 0,
  },
  screenshots: { reworking: 196, specifying: 52, directing: 108, other: 0 },
};
{
  const m = RECORD.messages!;
  m.sinceLast = RECORD.you - m.rows.reduce((n, r) => n + r.seconds, 0) - m.beforeAction.seconds;
  assert.ok(m.sinceLast > 0 && m.sinceLast < 600, `the rows leave ${m.sinceLast}s since the last message`);
  assert.equal(Object.values(RECORD.rows).reduce((n, s) => n + s, 0), RECORD.you);
}

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const GIT = {
  state: "repo",
  where: { kind: "local" },
  cwd: CWD,
  root: CWD,
  head: { kind: "branch", name: "fix/checkout-rounding" },
  unborn: false,
  upstream: { name: "origin/fix/checkout-rounding", ahead: 2, behind: 0 },
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  clean: true,
  lastCommit: { oid: "9f3c1e7a2b", short: "9f3c1e7", subject: "Round each line's discount and tax on its own", author: "You", at: NOW - 12 * 60_000 },
  files: [],
  filesTotal: 0,
  statusPartial: false,
  lines: "ok",
  added: 0,
  removed: 0,
  checkedAt: NOW,
};
const INSIGHT = { outline: null, compactions: [], teams: [], workers: [], explanations: [] };

/** The chat open at `width` with its pane on `tab`, in a fresh browser. Records each route nothing here answers. */
async function open(width: number, height: number, tab: "time" | "session", read: (route: Route) => unknown = (r) => r.fulfill(json(RECORD)), opts: { pressTab?: boolean } = {}): Promise<{ page: Page; unanswered: string[] }> {
  const phone = width < 768;
  const unanswered: string[] = [];
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce", colorScheme: "dark" });
  const page = await ctx.newPage();
  // The shots hold still: a page that reads as hidden counts nothing, so every shot shows the same figures.
  if (SHOTS) await page.addInitScript(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.send(JSON.stringify({ type: "hello", items: ITEMS, isStreaming: false, model: "zai/glm-5.3", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === TIME_SPENT_READ_ROUTE) return read(route);
    if (p === TIME_SPENT_REPORT_ROUTE) return route.fulfill(json({ ok: true }));
    if (p === "/api/sessions") return route.fulfill(json([summary(PATH, "s1", TITLE), summary("/home/you/.pi/agent/sessions/shop/invoice-pdf.jsonl", "s2", "Invoice PDF layout")]));
    if (p === "/api/transcript") return route.fulfill(json({ items: ITEMS, context: null }));
    if (p === "/api/insights/session") return route.fulfill(json(INSIGHT));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: NOW, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p === "/api/sessions/git") return route.fulfill(json(GIT));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") {
      unanswered.push(p);
      return route.fulfill(json({}, 404));
    }
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(PATH)}`);
  await page.locator(`.entry[data-entry="u${ORDERED.length}"]`).waitFor({ timeout: 20_000 });
  await page.locator(".session-details-open").first().click();
  if (opts.pressTab !== false) await page.locator(`#session-tab-${tab}`).click();
  if (tab === "time") await page.locator("[data-time-you]").waitFor({ timeout: 20_000 });
  return { page, unanswered };
}

const rowsOf = (page: Page) =>
  page.locator(".time-spent").evaluate((root) => ({
    you: Number(root.querySelector("[data-time-you]")?.getAttribute("data-seconds")),
    keys: [...root.querySelectorAll(".time-spent-message-rows > li")].map((li) => (li.matches("[data-time-row]") ? li : li.querySelector("[data-time-row]"))!.getAttribute("data-time-row")!),
    seconds: [...root.querySelectorAll(".time-spent-message-rows > li")].reduce((n, li) => n + Number((li.matches("[data-time-row]") ? li : li.querySelector("[data-time-row]"))!.getAttribute("data-seconds")), 0),
  }));
/** Every message has one of the four labels: the Unsorted row holds nothing, so it doesn't show. */
const ALL_ROWS = ["specifying", "directing", "reworking", "asking", "not-labelled", "before-action", "since-last"];

/** Reading, Reworking and Reviewing Screenshots open, as the shots show them. */
async function openTheRows(page: Page) {
  for (const row of ["reading", "screenshots", "reworking"]) await page.locator(`[data-time-row="${row}"]`).click();
  await page.mouse.move(5, 5);
}
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));

test("shots: the tab at both widths and the Session tab it left", { skip: !SHOTS }, async () => {
  {
    const { page, unanswered } = await open(1440, 1240, "time");
    await openTheRows(page);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, "1440-time-spent-tab.png") });
    console.log("unanswered", [...new Set(unanswered)]);
    await page.context().close();
  }
  {
    const { page } = await open(375, 1200, "time");
    await openTheRows(page);
    // Exactly as tall as the tab: nothing cut off, no empty ground under it.
    const panel = page.locator(".session-panel-scroll");
    const box = (await panel.boundingBox())!;
    const content = await panel.evaluate((el) => el.scrollHeight);
    await page.setViewportSize({ width: 375, height: Math.ceil(box.y + content) });
    await settled(page);
    await page.screenshot({ path: join(SHOTS, "375-time-spent-tab-full.png") });
    await page.context().close();
  }
  {
    const { page } = await open(375, 812, "time");
    await openTheRows(page);
    const panel = page.locator(".session-panel-scroll");
    const { scrollHeight, clientHeight } = await panel.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    for (let i = 0, top = 0; ; i++, top += clientHeight - 40) {
      await panel.evaluate((el, t) => el.scrollTo(0, t), top);
      await settled(page);
      await page.screenshot({ path: join(SHOTS, `375-time-spent-tab-${i + 1}.png`) });
      if (top + clientHeight >= scrollHeight) break;
    }
    await page.context().close();
  }
  {
    const { page, unanswered } = await open(1440, 1000, "session");
    await page.locator(".git-skeleton").waitFor({ state: "detached", timeout: 10_000 });
    await settled(page);
    await page.screenshot({ path: join(SHOTS, "1440-session-tab.png") });
    console.log("unanswered", [...new Set(unanswered)]);
    await page.context().close();
  }
});

test("the tab sits between Usage and Context, and the Session tab holds no Time Spent", async () => {
  const { page } = await open(1440, 1000, "session");
  try {
    const tabs = await page.locator(".session-tabs [role=tab]").allInnerTexts();
    const at = tabs.findIndex((t) => t.trim() === "Time Spent");
    assert.deepEqual([tabs[at - 1]?.trim(), tabs[at + 1]?.trim()], ["Usage", "Context"]);
    await page.locator(".git-skeleton").waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await page.locator("#session-tabpanel .time-spent").count(), 0);
    const heads = await page.locator("#session-tabpanel .text-eyebrow").allInnerTexts();
    assert.equal(heads.length > 2, true, "the Session tab drew its sections: an absence here means something");
    assert.ok(!heads.some((h) => /time spent/i.test(h)), `no Time Spent heading in ${heads.join(", ")}`);
  } finally {
    await page.context().close();
  }
});

test("a pane with no tab kept doesn't open on Time Spent", async () => {
  const { page } = await open(1440, 1000, "session", undefined, { pressTab: false });
  try {
    await page.locator("[role=tab][aria-selected=true]").waitFor();
    assert.equal(await page.locator("[role=tab][aria-selected=true]").innerText(), "Session");
    assert.equal(await page.locator(".time-spent").count(), 0);
  } finally {
    await page.context().close();
  }
});

test("Your Messages: every row in order, counts and times, adding up to You, the time brighter than the count", async () => {
  const { page } = await open(1440, 1240, "time");
  try {
    const shut = await rowsOf(page);
    assert.deepEqual(shut.keys, ALL_ROWS);
    assert.equal(shut.seconds, shut.you, "the rows add up to You");
    const counts = await page.locator(".time-spent-message-rows [data-time-count]").evaluateAll((els) => els.map((e) => e.getAttribute("data-time-count")));
    assert.deepEqual(counts, ["10", "10", "4", "5", "2", "3", ""]);
    const colours = await page.locator('[data-time-row="directing"]').evaluate((row) => ({
      count: getComputedStyle(row.querySelector(".time-spent-count")!).color,
      time: getComputedStyle(row.querySelector(".text-num:last-child")!).color,
      label: getComputedStyle(row.querySelector(".time-spent-row-label")!).color,
    }));
    assert.notEqual(colours.count, colours.time, "the time is the main figure");
    assert.notEqual(colours.label, colours.time, "the label is quieter than the time");
    assert.equal(await page.locator('.time-spent-message-rows button[data-time-row="before-action"], .time-spent-message-rows button[data-time-row="since-last"]').count(), 0, "those 2 don't open");
    assert.doesNotMatch(await page.locator(".time-spent").innerText(), /unhappy|Your Time|frustrat/i);
  } finally {
    await page.context().close();
  }
});

test("a row opens to its messages, which add up to it; only a fallback model's line says who labelled it; a second click closes it", async () => {
  const { page } = await open(1440, 1240, "time");
  try {
    const row = page.locator('[data-time-row="reworking"]');
    assert.equal(await page.locator("[data-time-message]").count(), 0);
    await row.click();
    const lines = page.locator("[data-time-message]");
    assert.equal(await lines.count(), 4);
    const sum = await lines.evaluateAll((els) => els.reduce((n, e) => n + Number(e.getAttribute("data-seconds")), 0));
    assert.equal(sum, Number(await row.getAttribute("data-seconds")));
    assert.deepEqual(await page.locator("[data-time-labelled-by]").allInnerTexts(), ["Labelled by glm-5.3"]);
    assert.match(await lines.nth(1).innerText(), /Labelled by glm-5\.3/, "on the line the model labelled");
    assert.doesNotMatch(await lines.nth(0).innerText(), /Labelled by/, "a line Jev labelled says nothing");
    await row.click();
    assert.equal(await lines.count(), 0);
  } finally {
    await page.context().close();
  }
});

test("Reviewing Screenshots opens to what followed, in words that say only that", async () => {
  const { page } = await open(1440, 1240, "time");
  try {
    const row = page.locator('[data-time-row="screenshots"]');
    await row.click();
    assert.deepEqual(await page.locator('[data-time-row^="screenshots-"] > span:first-child').allInnerTexts(), ["Followed By Reworking", "Followed By Specifying", "Followed By Directing"]);
    const sum = await page.locator('[data-time-row^="screenshots-"]').evaluateAll((els) => els.reduce((n, e) => n + Number(e.getAttribute("data-seconds")), 0));
    assert.equal(sum, Number(await row.getAttribute("data-seconds")));
  } finally {
    await page.context().close();
  }
});

for (const [why, record] of [
  ["with the switch off", (() => { const { messages: _m, screenshots: _s, ...off } = RECORD; return off; })()],
  ["with a stray split and no messages", (() => { const { messages: _m, ...off } = RECORD; return off; })()],
] as const) {
  test(`${why}: no Your Messages at all, not even its last 2 rows, and Reviewing Screenshots doesn't open`, async () => {
    const { page } = await open(1440, 1240, "time", (r) => r.fulfill(json(record)));
    try {
      const text = await page.locator(".time-spent").innerText();
      assert.match(text, /Reviewing Screenshots/, "the tab's own figures are there: an absence here means something");
      assert.doesNotMatch(text, /Your Messages|Before An Action|Since Your Last Message|Directing|Followed By/);
      assert.equal(await page.locator('button[data-time-row="screenshots"]').count(), 0);
    } finally {
      await page.context().close();
    }
  });
}

test("an opened row stays open, with focus, through the tick and a new read, and shows what the read brought", async () => {
  // The second read onward: one more message in Reworking, so a kept row can't be keeping stale lines.
  const later = structuredClone(RECORD);
  const rework = later.messages!.rows.find((r) => r.key === "reworking")!;
  rework.messages.push({ id: "reworking-new", excerpt: "One more thing on the receipt.", seconds: 10 });
  rework.seconds += 10;
  later.messages!.sinceLast -= 10;
  let reads = 0;
  const { page } = await open(1440, 1240, "time", (r) => r.fulfill(json(++reads > 1 ? later : RECORD)));
  try {
    const steps = [
      { key: "reworking", lines: "[data-time-message]" },
      { key: "screenshots", lines: '[data-time-row^="screenshots-"]' },
      { key: "reading", lines: '[data-time-row^="reading-"]' },
    ];
    for (const { key } of steps) await page.locator(`button[data-time-row="${key}"]`).click();
    await page.locator('button[data-time-row="reworking"]').focus();
    await page.evaluate(() => {
      (window as any).kept = [...document.querySelectorAll("button[data-time-row], [data-time-message]")];
      (window as any).focused = document.activeElement;
    });
    assert.equal(await page.locator("[data-time-message]").count(), 4);
    // You really ticks, so the view has recomputed: 2 seconds on from here.
    const you = await page.locator("[data-time-you]").getAttribute("data-seconds");
    const moving = setInterval(() => void page.mouse.move(400 + Math.random() * 40, 300).catch(() => {}), 300);
    try {
      await page.waitForFunction((y) => Number(document.querySelector("[data-time-you]")?.getAttribute("data-seconds")) >= Number(y) + 2, you, { timeout: 15_000 });
    } finally {
      clearInterval(moving);
    }
    for (const { key, lines } of steps) {
      assert.equal(await page.locator(`button[data-time-row="${key}"]`).getAttribute("aria-expanded"), "true", `${key} is still open after the tick`);
      assert.ok((await page.locator(lines).count()) > 0, `${key} still shows its lines after the tick`);
    }
    const same = () => page.evaluate(() => ({ gone: (window as any).kept.filter((e: Element) => !e.isConnected).length, focus: document.activeElement === (window as any).focused && (window as any).focused.isConnected }));
    assert.deepEqual(await same(), { gone: 0, focus: true }, "the same elements, and the same button holds focus, after the tick");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator('[data-time-message="reworking-new"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator("[data-time-message]").count(), 5, "the open row shows what the read brought");
    assert.deepEqual(await same(), { gone: 0, focus: true }, "and a read keeps them too");
  } finally {
    await page.context().close();
  }
});

test("a press anywhere on a row opens that row, not its neighbour", async () => {
  for (const width of [1440, 375]) {
    const { page } = await open(width, 1240, "time");
    try {
      for (const key of ["specifying", "directing", "reworking", "asking", "not-labelled"]) {
        const missed = await page.locator(`[data-time-row="${key}"]`).evaluate((el) => {
          const b = el.getBoundingClientRect();
          return [b.top + 1, b.top + b.height / 2, b.bottom - 1].filter((y) => document.elementFromPoint(b.left + 40, y)?.closest("[data-time-row]") !== el);
        });
        assert.deepEqual(missed, [], `${key} at ${width}px`);
      }
    } finally {
      await page.context().close();
    }
  }
});

test("at 375px Reading and Reviewing Screenshots keep a 44px target, whose neighbours don't open", async () => {
  const { page } = await open(375, 812, "time");
  try {
    for (const key of ["reading", "screenshots"]) {
      const missed = await page.locator(`button[data-time-row="${key}"]`).evaluate((el) => {
        const b = el.getBoundingClientRect();
        const mid = b.top + b.height / 2;
        return [-21.5, -14, 0, 14, 21.5].filter((dy) => !el.contains(document.elementFromPoint(b.left + 40, mid + dy)));
      });
      assert.deepEqual(missed, [], `${key}: these offsets from its middle don't reach it`);
    }
  } finally {
    await page.context().close();
  }
});

test("counts stay in one column when a row reaches an hour, and at 375px long messages scroll nothing sideways", async () => {
  const hour = structuredClone(RECORD);
  const row = hour.messages!.rows[0]!;
  row.seconds += 3600;
  row.messages[0]!.seconds += 3600;
  row.messages[0]!.excerpt = "A".repeat(120);
  hour.you += 3600;
  hour.rows.typing = hour.rows.typing! + 3600;
  const { page } = await open(375, 812, "time", (r) => r.fulfill(json(hour)));
  try {
    await page.locator('[data-time-row="directing"]').click();
    const lefts = await page.locator(".time-spent-message-rows [data-time-count]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    assert.ok(lefts.every((x) => Math.abs(x - lefts[0]!) < 1), `count columns at ${lefts.join(", ")}`);
    const overflow = await page.locator(".session-panel-scroll").evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 0, `the panel scrolls sideways by ${overflow}px`);
  } finally {
    await page.context().close();
  }
});

/** Which edges of the session strip fade: the design system's .tabs mask, its edge widths read from the strip. */
const stripFade = (page: Page) =>
  page.locator(".session-tabs").evaluate((el) => {
    const cs = getComputedStyle(el);
    const w = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
    return { left: w("--tabs-fade-start") > 0, right: w("--tabs-fade-end") > 0, overflows: el.scrollWidth > el.clientWidth };
  });
const FADE_SHOTS = process.env.SPENT_FADE_SHOTS ?? "";

test("the session strip fades at the edge with tabs beyond it, and nowhere when they all fit", async () => {
  {
    const { page } = await open(375, 812, "session", undefined, { pressTab: false });
    try {
      await page.locator("[role=tab][aria-selected=true]").waitFor();
      assert.deepEqual(await stripFade(page), { left: false, right: true, overflows: true }, "at 375 at the start: a fade at the right only");
      if (FADE_SHOTS) await page.screenshot({ path: join(FADE_SHOTS, "375-dark-start.png") });
      await page.locator(".session-tabs").evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
      await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".session-tabs")!).getPropertyValue("--tabs-fade-start")) > 0);
      assert.deepEqual(await stripFade(page), { left: true, right: false, overflows: true }, "at 375 scrolled to the end: a fade at the left only");
      if (FADE_SHOTS) await page.screenshot({ path: join(FADE_SHOTS, "375-dark-end.png") });
      if (FADE_SHOTS) {
        await page.locator(".session-tabs").evaluate((el) => el.scrollTo({ left: 0 }));
        await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
        await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".session-tabs")!).getPropertyValue("--tabs-fade-start")) === 0);
        await page.screenshot({ path: join(FADE_SHOTS, "375-light-start.png") });
      }
    } finally {
      await page.context().close();
    }
  }
  {
    const { page } = await open(2200, 1000, "time");
    try {
      assert.deepEqual(await stripFade(page), { left: false, right: false, overflows: false }, "every tab fits: no fade");
    } finally {
      await page.context().close();
    }
  }
  if (FADE_SHOTS) {
    const { page } = await open(1440, 1000, "time");
    await settled(page);
    await page.screenshot({ path: join(FADE_SHOTS, "1440-dark-time-spent.png") });
    await page.context().close();
  }
});
