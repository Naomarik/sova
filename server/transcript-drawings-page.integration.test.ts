// A chat's own drawings and view cards in the page, in a real Chrome (§chat.transcript-cards/drawing-kinds,
// /sealed-box, /toolkit): the app's own build, served from a scratch build with every request answered here
// (no server, no network). One reply holds six own-kind drawings of two kinds (a project's and an extension's)
// plus one whose view can't be had, and the chat holds a project's view card. Every drawing draws in its own
// box and paints (read back from a screenshot, not the DOM), including after the thread scrolls far away and
// back; the one that can't says "This drawing couldn't be drawn"; the view card stands in a card frame with
// its header, its box inside; and the box draws native controls in Sova's style, not the browser's.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, ElementHandle, Frame, Page } from "playwright-core";
import type { SessionSummary } from "../shared/protocol";
import type { CardInfo, SessionCardsAnswer } from "../shared/transcript-cards";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_DRAWINGS_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without a fix fails).
  dist = process.env.SOVA_DRAWINGS_DIST || join(scratchRoot("sova-drawings-page-"), "dist");
  if (!process.env.SOVA_DRAWINGS_DIST) {
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
const CWD = "/w/projects/shop";

/** The marker colour every test view paints its block in, so a screenshot shows whether it drew. */
const MARK = [255, 0, 170] as const;
const MARK_CSS = `rgb(${MARK.join(",")})`;

/**
 * A view's built code, as the box runs it (one script, the toolkit not needed): a block of the
 * marker colour with the fence's own words in it, at a height of its own, so the box's height says
 * it drew rather than holding its reservation. A view card's also writes the native controls.
 */
const viewCode = (height: number, controls = false) => `(() => {
  const init = globalThis.__sovaCardBox.init;
  const root = document.getElementById("root");
  const block = document.createElement("div");
  block.dataset.drawn = typeof init.card.data === "string" ? init.card.data : JSON.stringify(init.card.data);
  block.style.cssText = "height:${height}px;background:${MARK_CSS}";
  root.append(block);
  ${controls ? `root.insertAdjacentHTML("beforeend", '<p><input type="range" min="0" max="100" value="25"> <select><option>One</option></select> <input type="checkbox" checked> <input type="radio"> <input type="text" value="x"></p>');` : ""}
})();`;

const SPARK_H = 70;
const METER_H = 110;
const fence = (kind: string, title: string, body: string) => "```vis " + kind + "\ntitle: " + title + "\n" + body + "\n```";
const REPLY = [
  "Here is how things stand.",
  fence("project.meter", "Meter one", JSON.stringify({ left: 1 })),
  fence("pulse.spark", "Spark one", "1 2 3"),
  fence("project.meter", "Meter two", JSON.stringify({ left: 2 })),
  fence("pulse.spark", "Spark two", "4 5 6"),
  fence("project.meter", "Meter three", JSON.stringify({ left: 3 })),
  fence("pulse.spark", "Spark three", "7 8 9"),
  fence("project.gone", "Gone one", "x"),
].join("\n\n");
const DRAWN = ['{"left":1}', "1 2 3", '{"left":2}', "4 5 6", '{"left":3}', "7 8 9"];

/** Rows enough above the reply that scrolling to the top takes it far out of view. */
const ITEMS = [
  ...Array.from({ length: 30 }, (_, i) => [
    { id: `u${i}`, kind: "user", text: `Question ${i}`, at: iso(90 - i * 2) },
    { id: `a${i}`, kind: "assistant-text", text: `Answer ${i}.\n\n${"A line of filler text. ".repeat(20)}`, at: iso(89 - i * 2), model: "mock/m1" },
  ]).flat(),
  { id: "u-last", kind: "user", text: "How is it going?", at: iso(10) },
  { id: "a-last", kind: "assistant-text", text: REPLY, at: iso(9), model: "mock/m1" },
];

const SESSION = {
  id: "s1",
  path: PATH,
  cwd: CWD,
  title: "Drawings",
  createdAt: iso(120),
  lastActiveAt: iso(9),
  model: "mock/m1",
  context: { tokens: 1, window: 100_000 },
  live: null,
  origin: "web",
  archived: false,
  busy: false,
} as unknown as SessionSummary;

const VIEW_CARD: CardInfo = {
  id: "cd_1",
  type: "project.panel",
  title: "Panel",
  draws: "view",
  view: { toolkit: 1, height: 200 },
  answerMode: "none",
  placement: "anchored",
  data: { service: "checkout-api" },
  at: iso(9),
  by: { kind: "script" },
  after: null,
  state: "open",
} as unknown as CardInfo;

const CARDS: SessionCardsAnswer = {
  cards: [VIEW_CARD],
  types: [{ type: "project.panel", title: "Panel", draws: "view", answer: "none", placement: "anchored", height: 200, data: { type: "object" }, toolkit: 1 }] as unknown as SessionCardsAnswer["types"],
  drawings: [
    { kind: "project.meter", accepts: "data", data: { type: "object" }, height: 220, toolkit: 1 },
    { kind: "pulse.spark", accepts: "text", height: 90, toolkit: 1, ext: { id: "pulse", title: "Pulse", view: "drawings/spark.js" } },
    { kind: "project.gone", accepts: "text", height: 90, toolkit: 1 },
  ] as unknown as SessionCardsAnswer["drawings"],
  trust: { owner: `project:${CWD}`, name: "shop", trusted: false },
};

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

/** The chat open at `width`, every request answered from the data above. A view's redraw long-poll is held open. */
async function open(width: number): Promise<Page> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.send(JSON.stringify({ type: "hello", items: ITEMS, isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    const q = url.searchParams;
    if (p === "/api/sessions") return route.fulfill(json([SESSION]));
    if (p === "/api/transcript") return route.fulfill(json({ items: ITEMS, context: null }));
    if (p === "/api/session-cards") return route.fulfill(json(CARDS));
    if (p === "/api/session-cards/drawing" || p === "/api/session-cards/view") {
      // A redraw waits for a save that never comes: held, so the page keeps what it drew.
      if (q.get("wait") === "1") return;
      const kind = q.get("kind") ?? q.get("type");
      if (kind === "project.meter") return route.fulfill(json({ ok: true, hash: "m1", code: viewCode(METER_H) }));
      if (kind === "pulse.spark") return route.fulfill(json({ ok: true, hash: "s1", code: viewCode(SPARK_H) }));
      if (kind === "project.panel") return route.fulfill(json({ ok: true, hash: "p1", code: viewCode(60, true) }));
      return route.fulfill(json({ ok: false, hash: "uninstalled", error: "Pulse is no longer installed." }));
    }
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(PATH)}`);
  assert.equal(await page.evaluate(() => innerWidth), width);
  return page;
}

/** The view frame inside a box (the shell's one child), once it is there. */
async function viewFrame(box: ElementHandle): Promise<Frame | null> {
  const shell = await box.contentFrame();
  return shell?.childFrames()[0] ?? null;
}

/** What a box's view drew (its block's words), or null while it hasn't. */
async function drawnIn(box: ElementHandle): Promise<string | null> {
  const f = await viewFrame(box);
  if (!f) return null;
  return f.evaluate(() => document.querySelector<HTMLElement>("[data-drawn]")?.dataset.drawn ?? null).catch(() => null);
}

async function until(what: string, ok: () => Promise<boolean>, ms = 20_000, seen?: () => Promise<unknown>) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 >= ms) assert.fail(`timed out waiting for ${what}${seen ? `: ${JSON.stringify(await seen())}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** How many pixels of a screenshot are the marker colour, decoded by a blank page's canvas. */
async function markedPixels(decoder: Page, png: Buffer): Promise<number> {
  return decoder.evaluate(
    async ([b64, mark]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - mark[0]) < 8 && Math.abs(d[i + 1]! - mark[1]) < 8 && Math.abs(d[i + 2]! - mark[2]) < 8) n++;
      return n;
    },
    [png.toString("base64"), [...MARK]] as const,
  );
}

const ownBoxes = (page: Page) => page.$$(`[data-vis-own]:not([data-vis-own="project.gone"]) iframe.card-view-box`);

/** Every own drawing has drawn its own fence's body, at its own height, and its box paints it on screen. */
async function everyDrawingDraws(page: Page, decoder: Page, when: string) {
  await until(`every drawing to draw (${when})`, async () => {
    const boxes = await ownBoxes(page);
    if (boxes.length !== DRAWN.length) return false;
    const drawn = await Promise.all(boxes.map(drawnIn));
    return drawn.every((d, i) => d === DRAWN[i]);
  }, 20_000, async () => Promise.all((await ownBoxes(page)).map(drawnIn)));
  const boxes = await ownBoxes(page);
  for (const [i, box] of boxes.entries()) {
    const want = i % 2 === 0 ? METER_H : SPARK_H;
    await until(`drawing ${i + 1} to take its drawn height (${when})`, async () => Math.round((await box.boundingBox())?.height ?? 0) === want);
    // On screen, the marker must show: read back from screenshots until it does (the page itself
    // paints a region it just scrolled to only once it has laid out the rows it had skipped).
    await box.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const area = want * Math.round((await box.boundingBox())!.width);
    const t0 = Date.now();
    let marked = 0;
    while ((marked = await markedPixels(decoder, await page.screenshot({ clip: (await box.boundingBox())! }))) < area * 0.8 && Date.now() - t0 < 10_000);
    assert.ok(marked > area * 0.8, `drawing ${i + 1} (${DRAWN[i]}) painted ${marked} of ${area} pixels (${when})`);
  }
}

for (const width of [1280, 390]) {
  test(`at ${width}px: every own drawing in one reply draws, after a scroll far away and back too; the one that can't says it is a drawing`, async () => {
    const page = await open(width);
    const decoder = await page.context().newPage();
    try {
      await page.locator("[data-vis-own]").first().waitFor({ timeout: 20_000 });
      await everyDrawingDraws(page, decoder, "first load");

      // Far away (the reply leaves the screen by many screens) and back.
      const thread = await page.$$("[data-vis-own]").then((f) => f[0]!.evaluateHandle((e) => {
        let el: HTMLElement | null = e.parentElement;
        while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        return el;
      }));
      await thread.evaluate((el) => el && (el.scrollTop = 0));
      await page.waitForTimeout(500);
      const far = await page.$("[data-vis-own]").then((f) => f!.evaluate((e) => e.getBoundingClientRect().top - innerHeight));
      assert.ok(far > 2000, `the reply is only ${far}px below the screen`);
      await everyDrawingDraws(page, decoder, "after scrolling back");

      // The kind whose view can't be had: a drawing's error box, never a card's.
      const gone = page.locator('[data-vis-own="project.gone"] .card-error .banner-title');
      await gone.waitFor({ timeout: 10_000 });
      assert.equal(await gone.textContent(), "This drawing couldn't be drawn: Pulse is no longer installed.");
    } finally {
      await page.context().close();
    }
  });
}

test("a view card stands in a card frame with its header, the From line above, its box inside; the box draws native controls in Sova's style", async () => {
  const page = await open(1280);
  try {
    const card = page.locator('.transcript-card[data-card-id="cd_1"]');
    await card.waitFor({ timeout: 20_000 });
    assert.equal(await card.locator(":scope > .transcript-card-from").textContent(), "From a script");
    const frame = card.locator(":scope > section.card");
    assert.equal(await frame.count(), 1, "the view card has no card frame");
    assert.equal(await frame.locator(".card-head .card-title").textContent(), "Panel");
    assert.equal(await frame.getAttribute("aria-labelledby"), await frame.locator(".card-title").getAttribute("id"));
    assert.equal(await frame.locator(".card-body iframe.card-view-box").count(), 1, "the box isn't inside the frame's body");

    const box = await frame.locator("iframe.card-view-box").elementHandle();
    await until("the view card to draw", async () => (await drawnIn(box!)) !== null);
    const f = (await viewFrame(box!))!;
    const styles = await f.evaluate(() => {
      const of = (sel: string) => {
        const s = getComputedStyle(document.querySelector(sel)!);
        return { appearance: s.appearance || s.getPropertyValue("-webkit-appearance"), bg: s.backgroundColor, border: s.borderTopColor };
      };
      return { range: of('input[type="range"]'), select: of("select"), checkbox: of('input[type="checkbox"]'), radio: of('input[type="radio"]'), text: of('input[type="text"]'), accent: getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim() };
    });
    for (const k of ["range", "select", "checkbox", "radio"] as const) assert.equal(styles[k].appearance, "none", `${k} keeps the browser's look`);
    assert.ok(styles.accent, "the box has no theme tokens");
    // The ticked checkbox is the accent, as Sova's own toggle box.
    const accentRgb = await page.evaluate((c) => {
      const d = document.createElement("div");
      d.style.color = c;
      document.body.append(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }, styles.accent);
    assert.equal(styles.checkbox.bg, accentRgb);
  } finally {
    await page.context().close();
  }
});
