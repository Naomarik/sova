// The live page route: one document that fills in, who it opens for, and where it stops.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "design-live-route-"));
const { DESIGN_STREAM_CSP } = await import("../../src/lib/design-frame");
const { mountDesignLiveRoutes } = await import("./live-route");
const { applySlice, clearLivePage } = await import("./live");
const { LIVE_LINK_MS, liveLinkOpens, mintLiveLink, setLiveLinkClockForTest } = await import("./live-link");
const store = await import("./store");
const { classifyRequest } = await import("../mesh/access");

const sid = "chat";
let n = 0;
let label: string;
const app = new Hono();
mountDesignLiveRoutes(app, (c) => (c.req.query("path") === "bad" ? null : { sessionId: sid }));

function makeDesign(): void {
  const now = new Date().toISOString();
  label = String.fromCharCode(65 + (n++ % 26));
  store.changeDesigns(sid, (s) => {
    s.designs = s.designs.filter((d) => d.label !== label);
    s.designs.push({ label, runId: "r", direction: "Minimalist", model: "zai/a", modelName: "a", parents: [], status: "writing", route: "tool", versions: [], workerState: "working", vision: true, createdAt: now, updatedAt: now });
  });
}

const slice = (gen: number, at: number, text: string, version = 1) => applySlice(sid, label, version, { gen, at, text });
const urlFor = async (): Promise<string> => ((await (await app.request(`/api/design/${label}/live-url?path=x`)).json()) as { url: string }).url;
/** Reads what has arrived so far, then whether the document has ended. */
async function reader(url: string) {
  const res = await app.request(url);
  const r = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  const pump = (async () => {
    for (;;) {
      const got = await r.read();
      if (got.done) return void (done = true);
      text += decoder.decode(got.value, { stream: true });
    }
  })();
  return { res, r, text: () => text, done: () => done, ended: () => pump };
}
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

beforeEach(makeDesign);
afterEach(() => {
  setLiveLinkClockForTest(null);
  clearLivePage(sid, label);
});
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

test("connecting replays the text so far, slices follow in the same document, and the page's end closes it", async () => {
  slice(1, 0, "<body>one");
  const f = await reader(await urlFor());
  assert.equal(f.res.status, 200);
  assert.equal(f.res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(f.res.headers.get("content-security-policy"), `sandbox; ${DESIGN_STREAM_CSP}`);
  assert.equal(f.res.headers.get("cache-control"), "no-store, no-transform");
  await settle();
  assert.match(f.text(), /<body>one$/);
  assert.equal(f.done(), false);
  slice(1, 9, " two");
  await settle();
  assert.match(f.text(), /<body>one two$/);
  clearLivePage(sid, label);
  await f.ended();
  assert.equal(f.done(), true);
});

test("a reconnect replays from the start; the first connection is unaffected", async () => {
  slice(1, 0, "abc");
  const url = await urlFor();
  const a = await reader(url);
  slice(1, 3, "def");
  await settle();
  const b = await reader(url);
  await settle();
  assert.equal(a.text(), b.text());
  assert.match(b.text(), /abcdef$/);
});

test("a new page ends the old document rather than writing over it; a re-told page doesn't", async () => {
  slice(1, 0, "abc");
  const f = await reader(await urlFor());
  await settle();
  slice(1, 0, "abcd");
  await settle();
  assert.match(f.text(), /abcd$/);
  assert.equal((f.text().match(/abc/g) ?? []).length, 1, "the same page told again goes on, once");
  assert.equal(f.done(), false);
  slice(2, 0, "xyz");
  await f.ended();
  assert.equal(f.text().includes("xyz"), false);
});

test("a character split across two slices arrives whole", async () => {
  const smile = "😀";
  slice(1, 0, `a${smile[0]}`);
  const f = await reader(await urlFor());
  await settle();
  slice(1, 2, `${smile[1]}b`);
  await settle();
  assert.match(f.text(), /a😀b$/);
});

test("a link to a page that has ended answers its finished text, or nothing, and closes", async () => {
  slice(1, 0, "partial");
  const url = await urlFor();
  clearLivePage(sid, label);
  const none = await reader(url);
  await none.ended();
  assert.equal(none.text().includes("partial"), false);
  store.writePage(sid, label, 1, "<p>finished</p>");
  store.changeDesign(sid, label, (d) => d.versions.push({ n: 1, at: "", chars: 15, by: "first" }));
  const page = await reader(url);
  await page.ended();
  assert.match(page.text(), /<p>finished<\/p>$/);
});

test("a link names one design and version: another design's page isn't what it follows", async () => {
  slice(1, 0, "mine");
  const url = await urlFor();
  const mine = label;
  makeDesign();
  slice(1, 0, "theirs");
  const f = await reader(url);
  await settle();
  assert.match(f.text(), /mine$/);
  clearLivePage(sid, mine);
});

test("refusals: no such token, an expired one, a design that is gone", async () => {
  slice(1, 0, "x");
  const url = await urlFor();
  const token = url.split("/").pop()!;
  for (const bad of ["/api/design/live-page/nope", `/api/design/live-page/${token}x`]) {
    assert.equal((await app.request(bad)).status, 403, bad);
    assert.equal(liveLinkOpens("GET", bad), false);
  }
  assert.equal(liveLinkOpens("GET", url), true);
  assert.equal(liveLinkOpens("POST", url), false, "reading is all a link opens");
  const t0 = Date.now();
  setLiveLinkClockForTest(() => t0 + LIVE_LINK_MS + 1);
  assert.equal((await app.request(url)).status, 403);
  assert.equal(liveLinkOpens("GET", url), false);
  setLiveLinkClockForTest(null);
  const again = mintLiveLink(sid, label, 1).token;
  store.changeDesigns(sid, (s) => void (s.designs = s.designs.filter((d) => d.label !== label)));
  assert.equal((await app.request(`/api/design/live-page/${again}`)).status, 404);
});

test("asking for a link: a bad chat is 400, nothing being written is 404", async () => {
  assert.equal((await app.request(`/api/design/${label}/live-url?path=bad`)).status, 400);
  assert.equal((await app.request(`/api/design/${label}/live-url?path=x`)).status, 404);
  slice(1, 0, "x");
  const r = (await (await app.request(`/api/design/${label}/live-url?path=x`)).json()) as { url: string; version: number; expires: number };
  assert.match(r.url, /^\/api\/design\/live-page\/[0-9a-f]{64}$/);
  assert.equal(r.version, 1);
  assert.ok(r.expires > Date.now());
});

test("a mesh peer needs full access for both the link and the page, like every design route", () => {
  for (const path of ["/api/design/live-page/abc", "/api/design/A/live-url"]) assert.equal(classifyRequest("GET", path).need, "full", path);
});
