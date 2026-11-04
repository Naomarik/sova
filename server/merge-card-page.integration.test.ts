// A chat's merge queue card in the page, in a real Chrome: the app's own build, served from a scratch
// build with every request answered here (no server, no network).
//
// - A rebuild removed the card's code file while the tab was open (§chat.transcript-cards/toolkit):
//   the card says Sova was updated, its Reload Page loads the page again, and the card then draws
//   from the newer build's files; the tab also asks the host again, so the stale-tab banner rises.
// - The card updating in place (a step of its check per `merge_cards` frame) keeps its row: the same
//   node, never redrawn at its estimate for a frame, and the rows above it never move.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page, WebSocketRoute } from "playwright-core";
import type { SessionSummary } from "../shared/protocol";
import type { MergeCard } from "../shared/merge-queue";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
/** The build the tab opened on, and a rebuild of it whose card file has another name. */
let older = "";
let newer = "";
let cardFile = "";
let browser: Browser;

before(async () => {
  const scratch = scratchRoot("sova-merge-card-page-");
  // SOVA_MERGE_CARD_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without a fix fails).
  older = process.env.SOVA_MERGE_CARD_DIST || join(scratch, "dist");
  if (!process.env.SOVA_MERGE_CARD_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", older, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  // The rebuild: the same files, the card's code file renamed (as a changed hash renames it) and
  // every file that names it changed with it. The older name is gone from it.
  newer = join(scratch, "dist-newer");
  cpSync(older, newer, { recursive: true });
  const assets = join(newer, "assets");
  const files = readdirSync(assets).filter((f) => /^TranscriptCard-[\w-]+\.js$/.test(f));
  assert.equal(files.length, 1, `the build's card file: ${files.join(", ")}`);
  cardFile = files[0]!;
  const renamed = "TranscriptCard-NEWERBLD.js";
  renameSync(join(assets, cardFile), join(assets, renamed));
  for (const f of [join(newer, "index.html"), ...readdirSync(assets).map((n) => join(assets, n))]) {
    if (!/\.(js|html|css)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    if (text.includes(cardFile)) writeFileSync(f, text.replaceAll(cardFile, renamed));
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

const itemsOf = (n: number, filler: number) =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, kind: "user", text: `Question ${i}`, at: iso(90 - i * 2) },
    { id: `a${i}`, kind: "assistant-text", text: `Answer ${i}.\n\n${"A line of filler text. ".repeat(filler)}`, at: iso(89 - i * 2), model: "mock/m1" },
  ]).flat();

const SESSION = { id: "s1", path: PATH, cwd: CWD, title: "Merge card", createdAt: iso(120), lastActiveAt: iso(9), model: "mock/m1", context: { tokens: 1, window: 100_000 }, live: null, origin: "web", archived: false, busy: false } as unknown as SessionSummary;

/** The branch's card checking, `step` of 11 steps done; placed after `after`. */
const cardAt = (step: number, after: string): MergeCard =>
  ({
    id: "mc1",
    entry: "mq_1",
    session: "s1",
    project: "p1",
    root: CWD,
    branch: "feat/x",
    target: "master",
    commit: "0123456789abcdef0123456789abcdef01234567",
    worktree: "/w/projects/.worktrees/shop-x",
    approvedBy: "land-button",
    state: "checking",
    run: "mr_1",
    progress: { done: step, total: 11 },
    notes: [{ kind: "thread", text: "Merge thread: changes server code; restart Sova to pick it up.", at: iso(20) }],
    revisions: [{ id: "mc1:1", kind: "approved", at: iso(25), after, state: "queued", position: 1 }],
    updatedAt: iso(1),
  }) as unknown as MergeCard;

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Served {
  /** The build served now (a rebuild swaps it). */
  dist: string;
  /** What GET /api/merge-queue/cards answers. */
  cards: MergeCard[];
  /** The served build's hello `build`, and how many hellos were asked. */
  build: string;
  hellos: number;
  /** Every card code file asked for: its name and the answer's status. */
  cardLoads: string[];
}

/** The chat open, every request answered from `served`; resolves with the page and its session feed (once open). */
async function open(served: Served, items: unknown[]): Promise<{ page: Page; feed: () => WebSocketRoute }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  let feed: WebSocketRoute | null = null;
  await page.routeWebSocket(/.*/, (ws) => {
    const p = new URL(ws.url()).pathname;
    if (p.startsWith("/ws/chat")) ws.send(JSON.stringify({ type: "hello", items, isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
    if (p.startsWith("/ws/watch")) feed = ws;
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/sessions") return route.fulfill(json([SESSION]));
    if (p === "/api/transcript") return route.fulfill(json({ items, context: null }));
    if (p === "/api/merge-queue/cards") return route.fulfill(json({ cards: served.cards }));
    if (p === "/api/session-cards") return route.fulfill(json({ cards: [], types: [], drawings: [], trust: null }));
    if (p === "/api/mesh") return route.fulfill(json({ self: { id: "h1", label: "Host", hostname: "host" }, peers: [] }));
    if (p === "/api/mesh/hello") {
      served.hellos++;
      return route.fulfill(json({ mesh: 1, id: "h1", label: "Host", hostname: "host", version: "1", protocol: "p1", pi: "1", build: served.build, now: Date.now() }));
    }
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(served.dist, p === "/" ? "index.html" : p));
    const there = file.startsWith(served.dist) && existsSync(file) && statSync(file).isFile();
    if (/\/TranscriptCard-[^/]+\.js$/.test(p)) served.cardLoads.push(`${p.split("/").pop()} ${there ? 200 : 404}`);
    if (there) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    // As Sova's server answers: a code file the build doesn't have is missing, any other path the app's page.
    if (p.startsWith("/assets/")) return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(served.dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(PATH)}`);
  return {
    page,
    feed: () => {
      assert.ok(feed, "the session feed is open");
      return feed;
    },
  };
}

async function until(what: string, ok: () => Promise<boolean>, ms = 20_000, seen?: () => Promise<unknown>) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 >= ms) assert.fail(`timed out waiting for ${what}${seen ? `: ${JSON.stringify(await seen())}` : ""}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a card whose code file a rebuild removed says Sova was updated, and Reload Page draws it from the newer build", async () => {
  const items = itemsOf(4, 2);
  const served: Served = { dist: older, cards: [], build: "older", hellos: 0, cardLoads: [] };
  const { page, feed } = await open(served, items);
  try {
    await page.locator('[data-entry="a3"]').waitFor({ timeout: 20_000 });
    await until("the stale-tab check's first hello", async () => served.hellos > 0);
    await until("the session feed", async () => {
      try {
        feed();
        return true;
      } catch {
        return false;
      }
    });
    // Sova is rebuilt and restarted while the tab is open: the tab's card file is gone.
    served.dist = newer;
    served.build = "newer";
    served.cards = [cardAt(1, "a3")];
    feed().send(JSON.stringify({ type: "merge_cards", session: "s1", cards: served.cards }));
    const box = page.locator(".card-error");
    await box.waitFor({ timeout: 10_000 });
    assert.deepEqual(served.cardLoads, [`${cardFile} 404`]);
    const title = () => box.locator(".banner-title").innerText();
    await until("the box to say what is wrong", async () => (await title()) !== "");
    assert.equal(await title(), "This card needs the newer Sova. Reload the page to draw it.");
    // The tab asked the host again: its build differs, so the stale-tab banner rises.
    await until("the stale-tab banner", async () => (await page.locator(".stale-tab").count()) > 0, 10_000, async () => ({ hellos: served.hellos }));

    const navigated = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 10_000 });
    await box.getByRole("button", { name: "Reload Page", exact: true }).click();
    await navigated;
    await page.locator(".mq-chat-card").waitFor({ timeout: 20_000 });
    assert.equal(await page.locator(".card-error").count(), 0);
    assert.deepEqual(served.cardLoads, [`${cardFile} 404`, "TranscriptCard-NEWERBLD.js 200"]);
  } finally {
    await page.context().close();
  }
});

test("a merge card updating step by step keeps its row: the same node, never drawn at its estimate, nothing above it moving", async () => {
  const items = itemsOf(12, 25);
  const served: Served = { dist: older, cards: [cardAt(1, "a11")], build: "older", hellos: 0, cardLoads: [] };
  const { page, feed } = await open(served, items);
  try {
    await page.locator(".mq-chat-card").waitFor({ timeout: 20_000 });
    // Settled at the end of the thread: the card's row is drawn and the view sits at the bottom.
    await until("the card's row to settle", async () => page.evaluate(() => !document.querySelector('.entry[data-entry^="card:"] .kind-pending')));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => {
      const w = window as unknown as { __trace: { frames: { rowH: number; refTop: number; scrollTop: number; pending: boolean }[]; remounts: number; rows: number } };
      let el = document.querySelector(".mq-chat-card") as HTMLElement | null;
      while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      const scroller = el!;
      const thread = document.querySelector(".mq-chat-card")!.closest(".entry")!.parentElement!;
      w.__trace = { frames: [], remounts: 0, rows: 0 };
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of [...m.addedNodes, ...m.removedNodes]) if (n instanceof HTMLElement && n.matches(".entry")) w.__trace.rows++;
      }).observe(thread, { childList: true });
      let card = document.querySelector(".mq-chat-card");
      const tick = () => {
        const now = document.querySelector(".mq-chat-card");
        if (now !== card) {
          w.__trace.remounts++;
          card = now;
        }
        const row = document.querySelector('.entry[data-entry^="card:"]');
        w.__trace.frames.push({
          rowH: row ? Math.round(row.getBoundingClientRect().height) : -1,
          refTop: Math.round(document.querySelector('.entry[data-entry="a11"]')!.getBoundingClientRect().top),
          scrollTop: Math.round(scroller.scrollTop),
          pending: !!row?.querySelector(".kind-pending"),
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let step = 2; step <= 11; step++) {
      feed().send(JSON.stringify({ type: "merge_cards", session: "s1", cards: [cardAt(step, "a11")] }));
      await until(`step ${step} drawn`, async () => (await page.locator(".mq-chat-card").innerText()).includes(`${step} of 11 steps`));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    const t = await page.evaluate(() => (window as unknown as { __trace: { frames: { rowH: number; refTop: number; scrollTop: number; pending: boolean }[]; remounts: number; rows: number } }).__trace);
    const first = t.frames[0]!;
    const moved = t.frames.filter((f) => f.rowH !== first.rowH || f.refTop !== first.refTop || f.scrollTop !== first.scrollTop || f.pending);
    const heights = [...new Set(t.frames.map((f) => f.rowH))];
    assert.deepEqual(
      { cardDrawnAnew: t.remounts, rowsAddedOrRemoved: t.rows, framesMoved: moved.length, cardHeights: heights.length },
      { cardDrawnAnew: 0, rowsAddedOrRemoved: 0, framesMoved: 0, cardHeights: 1 },
      `over ${t.frames.length} frames from ${JSON.stringify(first)}: heights ${heights.join(", ")}; first frames that moved ${JSON.stringify(moved.slice(0, 4))}`,
    );
  } finally {
    await page.context().close();
  }
});
