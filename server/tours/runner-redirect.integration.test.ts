import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { normalizeTourScript } from "../../shared/tour";
import { TourJobBlocked } from "./queue";
import { runTourAttempt } from "./runner";
import type { TourRecordingContext } from "./sandbox";
import { TourCaptureFailure } from "./targets";

// Redirects, speculative loads and popups against the real recorder (sandbox off, its own proxy):
// a hop or connection to an origin this tour neither declares nor requested is refused before
// contact, and a redirect to one fails naming it; a declared origin still goes through consent.
const PAGE = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body><main><h1>Saved drafts</h1>${body}</main></body></html>`;

async function sites() {
  let otherHits = 0;
  const other = createServer((req, res) => { otherHits++; res.setHeader("content-type", "text/html"); res.end(PAGE("<p>Made-up other site.</p>")); void req; });
  other.listen(0, "127.0.0.1"); await once(other, "listening");
  const otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  const main = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const go = (to: string) => { res.statusCode = 302; res.setHeader("location", to); res.end(); };
    if (path === "/go") return go(`${otherOrigin}/landing`);
    if (path === "/img") return go(`${otherOrigin}/x.png`);
    if (path === "/rules.json") { res.setHeader("content-type", "application/speculationrules+json"); res.end(JSON.stringify({ prefetch: [{ source: "list", urls: [`${otherOrigin}/next`] }] })); return; }
    if (path === "/speculative-header") res.setHeader("speculation-rules", '"/rules.json"');
    res.setHeader("content-type", "text/html");
    const pages: Record<string, string> = {
      "/redirect-subresource": PAGE('<img src="/img" alt="">'),
      "/direct-subresource": PAGE(`<img src="${otherOrigin}/x.png" alt="">`),
      "/speculative": PAGE("<p>Made-up page.</p>", `<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: "list", urls: [`${otherOrigin}/next`] }] })}</script>`),
      "/window-open": PAGE("<p>Made-up page.</p><script>addEventListener('load', () => window.open('/x'));</script>"),
      "/blank-link": PAGE('<a id="l" href="/x" target="_blank">Open</a><script>addEventListener("load", () => document.getElementById("l").click());</script>'),
    };
    res.end(pages[path] ?? PAGE("<p>Made-up page.</p>"));
  });
  main.listen(0, "127.0.0.1"); await once(main, "listening");
  const origin = `http://127.0.0.1:${(main.address() as { port: number }).port}`;
  return { origin, otherOrigin, otherHits: () => otherHits, close: () => { main.closeAllConnections(); main.close(); other.closeAllConnections(); other.close(); } };
}

function attempt(s: Awaited<ReturnType<typeof sites>>, route: string, opts: { declared?: boolean; consent?: (origin: string) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tour-redirect-"));
  const context: TourRecordingContext = { sessionId: "redirect", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  const script = tourScriptFixture();
  script.source = { kind: "site", origin: s.origin };
  if (opts.declared) script.sites = [s.otherOrigin];
  const view = script.steps[0]!.views[0]!;
  if (view.kind !== "page") throw new Error("fixture");
  // One size keeps it quick; the validator requires saying why the other is absent.
  view.route = route; view.sizes = ["desktop"]; view.unavailableReason = "Made-up fixture: the phone size isn't needed for this check.";
  assert.ok(normalizeTourScript(script), "fixture invalid: the script must pass the recorder's own validator");
  // Production-like consent: the page's own origin is approved; the other one only as told.
  const consent = opts.consent ?? (async (origin: string) => { if (origin !== s.origin) throw new TourJobBlocked({ origins: [origin] }); });
  return runTourAttempt({ context, script, tourId: "redirect", editionId: "redirect-edition", dryRun: true, beforeContact: consent })
    .then(() => "ok" as const, (e: unknown) => e)
    .finally(() => rmSync(root, { recursive: true, force: true }));
}
const named = (s: { otherOrigin: string }) => `This page redirects to ${s.otherOrigin}, which this tour didn't declare. Declare it in sites, or use reference text.`;
const failedWith = (outcome: unknown, message: string) => { assert.ok(outcome instanceof TourCaptureFailure, String(outcome)); assert.equal(outcome.failure.message, message); };

test("a page redirect to an undeclared origin fails naming it, with no contact; declared origins go through consent", { timeout: 180_000 }, async () => {
  const s = await sites();
  try {
    // Undeclared and unapproved.
    const refused = await attempt(s, "/go");
    failedWith(refused, named(s));
    assert.equal((refused as TourCaptureFailure).failure.blockedOrigin, s.otherOrigin);
    assert.equal(s.otherHits(), 0, "the hop never reached the other origin");
    // Undeclared but approved (consent passes everything): still refused before contact.
    failedWith(await attempt(s, "/go", { consent: async () => {} }), named(s));
    assert.equal(s.otherHits(), 0);
    // Control: declared and approved, the redirect lands.
    assert.equal(await attempt(s, "/go", { declared: true, consent: async () => {} }), "ok");
    assert.ok(s.otherHits() >= 1, "a declared, approved hop is admitted");
    // Declared but unapproved: paused up front, before the page.
    const hits = s.otherHits();
    const paused = await attempt(s, "/go", { declared: true });
    assert.ok(paused instanceof TourJobBlocked, String(paused));
    assert.deepEqual(paused.requirements.origins, [s.otherOrigin]);
    assert.equal(s.otherHits(), hits);
  } finally { s.close(); }
});

test("a subresource redirect to an undeclared origin fails naming it; a directly requested one pauses for consent", { timeout: 180_000 }, async () => {
  const s = await sites();
  try {
    failedWith(await attempt(s, "/redirect-subresource", { consent: async () => {} }), named(s));
    assert.equal(s.otherHits(), 0);
    // A subresource the page requests itself is a checked request: unapproved, the attempt pauses.
    const paused = await attempt(s, "/direct-subresource");
    assert.ok(paused instanceof TourJobBlocked, String(paused));
    assert.deepEqual(paused.requirements.origins, [s.otherOrigin]);
    assert.equal(s.otherHits(), 0);
    // Positive control for requested admission: approved, the page's own request is admitted and
    // its connection, through the proxy, reaches the other site.
    assert.equal(await attempt(s, "/direct-subresource", { consent: async () => {} }), "ok");
    assert.ok(s.otherHits() >= 1, "a requested, approved origin is admitted by the proxy");
  } finally { s.close(); }
});

test("a speculative load of an undeclared origin is refused before contact and fails nothing", { timeout: 120_000 }, async () => {
  const s = await sites();
  try {
    // Rules from a response header (not stopped by the browser flag) and inline; consent passes all.
    for (const route of ["/speculative-header", "/speculative"]) {
      assert.equal(await attempt(s, route, { consent: async () => {} }), "ok", route);
      await new Promise(ok => setTimeout(ok, 1000));
      assert.equal(s.otherHits(), 0, route);
    }
  } finally { s.close(); }
});

test("a declared origin whose approval is withdrawn stops the attempt when only the proxy sees it", { timeout: 120_000 }, async () => {
  const s = await sites();
  try {
    // Approved at the start (the up-front check), withdrawn afterwards: the redirect hop reaches only
    // the proxy, whose live check now refuses it, and the attempt stops for consent.
    let asked = 0;
    const outcome = await attempt(s, "/go", { declared: true, consent: async origin => { if (origin === s.otherOrigin && ++asked > 1) throw new TourJobBlocked({ origins: [origin] }); } });
    assert.ok(outcome instanceof TourJobBlocked, String(outcome));
    assert.deepEqual(outcome.requirements.origins, [s.otherOrigin]);
    assert.equal(s.otherHits(), 0);
  } finally { s.close(); }
});

test("popups fail with their own message", { timeout: 120_000 }, async () => {
  const s = await sites();
  try {
    const opened = await attempt(s, "/window-open");
    failedWith(opened, "Blocked popup during read-only recording.");
    assert.equal((opened as TourCaptureFailure).failure.viewId, "overview");
    const clicked = await attempt(s, "/blank-link");
    failedWith(clicked, "Blocked an unexpected popup during recording.");
    assert.equal((clicked as TourCaptureFailure).failure.stepId, "find-draft");
  } finally { s.close(); }
});
