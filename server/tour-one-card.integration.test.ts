// One tour card per tour in a chat (§app.tours/one-card), in a real Chrome: the app's own build, served from a
// scratch build with every request answered here (no server, no network), its chat socket a stand-in that sends
// the hello and the live events. Settled: several calls for one tour draw one "Tour recording: <title>" region, at
// the newest call, every earlier call one line with what it reported then; a failed call keeps its failure row; a
// second tour keeps its own card. Streaming: a tour call that finishes live takes the card at once, and the settled
// one becomes its line; a second live call for the same tour moves the card again, never two.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page, WebSocketRoute } from "playwright-core";
import type { SessionSummary, TranscriptItem } from "../shared/protocol";
import type { SovaEvent } from "../shared/harness-wire";
import type { TourCardDetails } from "../shared/tour";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
const PATH = "/w/sessions/tour-chat.jsonl";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_TOUR_CARD_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without the fix fails).
  dist = process.env.SOVA_TOUR_CARD_DIST || join(scratchRoot("sova-tour-one-card-"), "dist");
  if (!process.env.SOVA_TOUR_CARD_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const NOW = "2026-10-20T12:00:00.000Z";
const session = {
  id: "tour-chat",
  path: PATH,
  cwd: "/w/work",
  title: "Tour of the demo",
  createdAt: NOW,
  lastActiveAt: NOW,
  model: "mock/m1",
  context: { tokens: 1, window: 100_000 },
  live: null,
  origin: "web",
  archived: false,
  busy: false,
} as unknown as SessionSummary;

const card = (tourId: string, title: string, status: TourCardDetails["status"]): TourCardDetails => ({ v: 1, tourId, title, steps: 4, status });
const line = (d: TourCardDetails) => `${d.title} · ${d.steps} steps · ${d.status}`;

/** A settled tour call and its result, as the server's rows carry them; no `card`: a failed result. */
function tourRows(id: string, d: TourCardDetails | undefined, name = "record_tour"): TranscriptItem[] {
  return [
    { id, kind: "tool-call", text: name, toolCallId: `c-${id}`, at: NOW, tool: { summary: "look /", lazy: true, bytes: 20 } },
    {
      id: `${id}-r`,
      kind: "tool-result",
      toolCallId: `c-${id}`,
      at: NOW,
      facts: { tool: { name, isError: !d } },
      tool: d ? { details: d, output: line(d), lazy: true, bytes: 40 } : { output: "This tour result is unavailable. Open the tool report to check what happened.", lazy: true, bytes: 40 },
    },
  ] as unknown as TranscriptItem[];
}
const user = (id: string, text: string) => ({ id, kind: "user", text, at: NOW }) as unknown as TranscriptItem;

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

/** The chat open at 1280px on `items`; `streaming` keeps the run going so the test can send live events. */
async function open(items: TranscriptItem[], streaming = false): Promise<{ page: Page; send(e: SovaEvent): void }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  let chat: WebSocketRoute | null = null;
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.endsWith("/ws/chat")) return;
    chat = ws;
    ws.onMessage(() => {});
    ws.send(JSON.stringify({ type: "hello", items, isStreaming: streaming, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/sessions") return route.fulfill(json([session]));
    if (p === "/api/sessions/summary") return route.fulfill(json(session));
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/orgs") return route.fulfill(json({ operator: { name: "Operator" }, orgs: [] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: Date.parse(NOW), counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p === "/api/transcript") return route.fulfill(json({ items, context: null }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(PATH)}`);
  assert.equal(await page.evaluate(() => innerWidth), 1280);
  await page.locator(".tour-card").first().waitFor({ timeout: 20_000 });
  return {
    page,
    send(event) {
      assert.ok(chat, "the chat socket is open");
      chat.send(JSON.stringify({ type: "event", v: 2, event }));
    },
  };
}

/** Every tour card on the page, by its region's name. */
const regions = (page: Page) => page.locator('section[aria-label^="Tour recording:"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
/** Every tool row's one line, in order: its folded text and its chip. */
const toolLines = (page: Page) =>
  page
    .locator(".toolcard-summary")
    .evaluateAll((els) => els.map((e) => `${e.querySelector(".toolcard-arg")?.textContent ?? ""} | ${e.querySelector(".chip")?.textContent ?? ""}`))
    .then((lines) => lines.filter((l) => !l.startsWith("ls ")));
/** Tool rows drawn inside a working timeline: a tour call never is (§chat.transcript/work-chain). */
const inTimeline = (page: Page) =>
  page.locator(".chain-row .toolcard-arg, .chain-live .toolcard-arg").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
/** Two ordinary working rows, which do draw a timeline. */
const work = (id: string): TranscriptItem[] =>
  ["a", "b"].flatMap((n) => [
    { id: `${id}${n}`, kind: "tool-call", text: "bash", toolCallId: `c-${id}${n}`, at: NOW, tool: { summary: `ls ${id}${n}`, lazy: true, bytes: 5 } },
    { id: `${id}${n}-r`, kind: "tool-result", toolCallId: `c-${id}${n}`, at: NOW, facts: { tool: { name: "bash", isError: false } }, tool: { output: "ok", lazy: true, bytes: 2 } },
  ]) as unknown as TranscriptItem[];
/** Whether the element whose text is `a` comes before the one whose text is `b` in the document. */
const isAbove = (page: Page, a: string, b: string) =>
  page.evaluate(([a, b]) => {
    const find = (sel: string) => document.querySelector(sel)!;
    return !!(find(a).compareDocumentPosition(find(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, [a, b] as const);

const waitFor = async (what: string, ok: () => Promise<boolean>) => {
  const t0 = Date.now();
  while (!(await ok())) {
    assert.ok(Date.now() - t0 < 10_000, `never: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("settled: one card per tour at its newest call; earlier calls one line each; a failure keeps its row", async () => {
  const look = card("demo", "Demo tour", "queued");
  const status = card("demo", "Demo tour", "dry-run");
  const items = [
    user("u1", "Make a tour of the demo"),
    ...work("w1"),
    ...tourRows("look", look),
    ...tourRows("status", status),
    ...work("w2"),
    ...tourRows("bad", undefined),
    ...tourRows("other", card("other", "Other tour", "queued")),
    ...tourRows("check", card("demo", "Demo tour", "checking")),
  ];
  const { page } = await open(items);
  await waitFor("both tours' cards", async () => (await regions(page)).length === 2);
  assert.deepEqual((await regions(page)).sort(), ["Tour recording: Demo tour", "Tour recording: Other tour"]);
  const lines = await toolLines(page);
  assert.deepEqual(lines, [`${line(look)} | Done`, `${line(status)} | Done`, "look / | Failed"], lines.join("\n"));
  assert.deepEqual(await inTimeline(page), ["ls w1a", "ls w1b", "ls w2a", "ls w2b"], "earlier calls and the failure break the timeline, as every tour call does");
  // The card sits at the newest call: below the failure and the other tour's card.
  assert.ok(await isAbove(page, 'section[aria-label="Tour recording: Other tour"]', 'section[aria-label="Tour recording: Demo tour"]'), "the demo card moved down to its newest call");
  // An earlier call opens like any other tool row.
  await page.locator(".toolcard-summary").first().click();
  assert.equal(await page.locator(".toolcard-details").first().evaluate((d) => (d as HTMLDetailsElement).open), true);
  await page.context().close();
});

test("streaming: a finished live call takes the card at once, the settled one becomes its line, never two", async () => {
  const look = card("demo", "Demo tour", "queued");
  const { page, send } = await open([user("u1", "Make a tour of the demo"), ...work("w1"), ...tourRows("look", look), ...work("w2")], true);
  await waitFor("the settled card", async () => (await regions(page)).length === 1);
  assert.deepEqual(await toolLines(page), []);

  const dry = card("demo", "Demo tour", "dry-run");
  send({ type: "message.start", role: "assistant", parts: [{ kind: "toolCall", id: "live-1", name: "record_tour", args: { action: "status" } }] });
  send({ type: "tool.start", callId: "live-1", name: "record_tour", args: { action: "status" } });
  send({ type: "tool.end", callId: "live-1", name: "record_tour", isError: false, output: "ok", images: [], details: dry });
  await waitFor("the settled card becomes a line", async () => (await toolLines(page)).length === 1);
  assert.deepEqual(await regions(page), ["Tour recording: Demo tour"]);
  assert.deepEqual(await toolLines(page), [`${line(look)} | Done`]);

  // A second live call for the same tour: the card moves to it, the first live one becomes a line too.
  send({ type: "message.end", role: "assistant", parts: [], stop: "ok" });
  const rec = card("demo", "Demo tour", "recording");
  send({ type: "message.start", role: "assistant", parts: [{ kind: "toolCall", id: "live-2", name: "record_tour", args: { action: "status" } }] });
  send({ type: "tool.start", callId: "live-2", name: "record_tour", args: { action: "status" } });
  send({ type: "tool.end", callId: "live-2", name: "record_tour", isError: false, output: "ok", images: [], details: rec });
  await waitFor("the first live call becomes a line", async () => (await toolLines(page)).length === 2);
  assert.deepEqual(await regions(page), ["Tour recording: Demo tour"]);
  assert.deepEqual(await toolLines(page), [`${line(look)} | Done`, `${line(dry)} | Done`]);

  // A failed live call takes nothing: the card stays where it is.
  send({ type: "message.end", role: "assistant", parts: [], stop: "ok" });
  send({ type: "message.start", role: "assistant", parts: [{ kind: "toolCall", id: "live-3", name: "record_tour", args: { action: "status" } }] });
  send({ type: "tool.start", callId: "live-3", name: "record_tour", args: { action: "status" } });
  send({ type: "tool.end", callId: "live-3", name: "record_tour", isError: true, output: "No such job.", images: [] });
  await waitFor("the failed live call's row", async () => (await toolLines(page)).length === 3);
  assert.deepEqual(await regions(page), ["Tour recording: Demo tour"]);
  assert.match((await toolLines(page))[2]!, /\| Failed$/);
  assert.deepEqual(await inTimeline(page), ["ls w1a", "ls w1b", "ls w2a", "ls w2b"], "live tour lines break the timeline too");
  await page.context().close();
});
