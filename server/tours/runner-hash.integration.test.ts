import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeTourScript, type TourScript } from "../../shared/tour";
import { TourJobBlocked } from "./queue";
import { runTourAttempt } from "./runner";
import type { TourRecordingContext } from "./sandbox";

// A hash-routed single-page app against the real recorder (sandbox off, its own proxy, its route
// handler active). Each view starts from a fresh document load: a route that differs from the
// previous one only after "#" is loaded in full and its response checked, and nothing the page did
// in an earlier view carries over. Before, the second view's goto was a same-document navigation
// with no response, and failed "The recorded page did not return a successful response."
const APP = `<!doctype html><html><head><title>Made-up app</title></head><body><main id="app"></main><script>
  let changes = 0;
  const render = () => {
    const name = (location.hash.replace(/^#\\/?/, "") || location.pathname.replace(/^\\//, "") || "home").toUpperCase();
    // A view reached by an in-page hash change rather than a fresh load says so: no mark matches it.
    document.getElementById("app").innerHTML = "<h1>View " + name + (changes ? " carried over" : " loaded fresh") + "</h1>" +
      "<details><summary>More about " + name + "</summary><p>Made-up details.</p></details>";
  };
  addEventListener("hashchange", () => { changes++; render(); });
  if (location.search.includes("leave")) addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = ""; });
  if (location.search.includes("beacon")) addEventListener("pagehide", () => { navigator.sendBeacon("/beacon", "x"); fetch("/beacon", { method: "POST", body: "x", keepalive: true }).catch(() => {}); });
  if (location.search.includes("postnow")) addEventListener("load", () => { fetch("/beacon", { method: "POST", body: "x" }).catch(() => {}); });
  if (location.search.includes("postopen")) document.addEventListener("toggle", () => { fetch("/beacon", { method: "POST", body: "x" }).catch(() => {}); }, true);
  if (location.search.includes("linger")) addEventListener("pagehide", () => { fetch(window.LINGER, { keepalive: true }).catch(() => {}); });
  render();
</script></body></html>`;

async function app() {
  const loads: string[] = [];
  let slowHits = 0, beacons = 0;
  const slow = createServer((_req, res) => { slowHits++; res.setHeader("access-control-allow-origin", "*"); res.end("ok"); });
  slow.listen(0, "127.0.0.1"); await once(slow, "listening");
  const slowOrigin = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
  const main = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/beacon") { beacons++; res.end(); return; }
    loads.push(url.pathname + url.search);
    res.setHeader("content-type", "text/html");
    res.end(APP.replace("<script>", `<script>window.LINGER = ${JSON.stringify(`${slowOrigin}/linger`)};`));
  });
  main.listen(0, "127.0.0.1"); await once(main, "listening");
  const origin = `http://127.0.0.1:${(main.address() as { port: number }).port}`;
  return { origin, slowOrigin, loads, slowHits: () => slowHits, beacons: () => beacons, close: () => { main.closeAllConnections(); main.close(); slow.closeAllConnections(); slow.close(); } };
}

type View = { route: string; heading: string; open?: boolean };
function script(origin: string, views: View[], sites?: string[]): TourScript {
  const s: TourScript = {
    v: 1, title: "Made-up hash app", summary: "Two views of a hash-routed app.", audience: "A reviewer", outcome: "See both views.",
    source: { kind: "site", origin }, ...(sites ? { sites } : {}), chapters: [{ id: "views", title: "Views" }],
    steps: [{ id: "both", chapter: "views", title: "Both views", summary: "Each view of the app.", views: views.map((v, i) => ({
      id: `view-${i + 1}`, title: `View ${i + 1}`, kind: "page" as const, note: "A made-up view.", route: v.route, sizes: ["desktop", "phone"] as ("desktop" | "phone")[],
      actions: v.open ? { desktop: [{ op: "open" as const, target: { kind: "text" as const, text: `More about ${v.heading}` } }], phone: [{ op: "open" as const, target: { kind: "text" as const, text: `More about ${v.heading}` } }] } : {},
      marks: [{ target: { kind: "role" as const, role: "heading" as const, name: `View ${v.heading} loaded fresh` }, label: "This view, loaded fresh.", side: "right" as const }], masks: [],
    })) }],
  };
  assert.ok(normalizeTourScript(s), "fixture invalid: the script must pass the recorder's own validator");
  return s;
}
function record(s: TourScript, consent: (origin: string) => Promise<void> = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "tour-hash-"));
  const context: TourRecordingContext = { sessionId: "hash", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  return runTourAttempt({ context, script: s, tourId: "hash", editionId: "hash-edition", dryRun: true, beforeContact: consent })
    .then(() => "recorded", (e: unknown) => e instanceof Error ? `failed: ${e.message}${"failure" in e ? ` ${JSON.stringify((e as { failure: unknown }).failure)}` : ""}` : `failed: ${String(e)}`)
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("two hash routes of one app each load fresh, on both sizes, with the route handler active", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    // The route handler refuses any non-http destination ("A request used an unsupported
    // destination."), so a recording that passes shows the blank page between views never reached it.
    assert.equal(await record(script(a.origin, [{ route: "/#/a", heading: "A" }, { route: "/#/b", heading: "B" }])), "recorded");
    assert.deepEqual(a.loads, ["/", "/", "/", "/"], "one full document load per view and size");
  } finally { a.close(); }
});

test("the same route twice records both views, each from its own load", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    assert.equal(await record(script(a.origin, [{ route: "/#/a", heading: "A" }, { route: "/#/a", heading: "A" }])), "recorded");
    assert.equal(a.loads.length, 4);
  } finally { a.close(); }
});

test("a page that asks before it's left, after an opening action, still lets the next view load", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    assert.equal(await record(script(a.origin, [{ route: "/?leave#/a", heading: "A", open: true }, { route: "/#/b", heading: "B" }])), "recorded");
  } finally { a.close(); }
});

test("a request a view leaves in flight doesn't fail the next view; a refused one still does", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    // Leaving the page fires a keepalive request to a declared, approved origin whose check is slow:
    // the browser cancels it with the page, and the attempt carries on.
    const slowConsent = async (origin: string) => { if (origin === a.slowOrigin) await new Promise(r => setTimeout(r, 1500)); };
    assert.equal(await record(script(a.origin, [{ route: "/?linger#/a", heading: "A" }, { route: "/#/b", heading: "B" }], [a.slowOrigin]), slowConsent), "recorded");
    // Control: the same request to an origin that isn't approved is still refused.
    const refuse = async (origin: string) => { if (origin === a.slowOrigin) throw new TourJobBlocked({ origins: [origin] }); };
    const outcome = await record(script(a.origin, [{ route: "/?linger#/a", heading: "A" }, { route: "/#/b", heading: "B" }], [a.slowOrigin]), refuse);
    assert.notEqual(outcome, "recorded", "a refused contact from the previous view still stops the attempt");
  } finally { a.close(); }
});

test("a write a page tries while it's being left is stopped without failing the attempt; one during a view still fails it", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    assert.equal(await record(script(a.origin, [{ route: "/?beacon#/a", heading: "A" }, { route: "/#/b", heading: "B" }])), "recorded");
    assert.equal(a.beacons(), 0, "no write reached the site");
    // Control: the same POST sent while the view is open is refused and stops the attempt, as before.
    // A POST the page sends by itself on load (al_6 q5) is stopped quietly: recorded, nothing sent.
    assert.equal(await record(script(a.origin, [{ route: "/?postnow#/a", heading: "A" }, { route: "/#/b", heading: "B" }])), "recorded");
    assert.equal(a.beacons(), 0);
    // Control: the same POST provoked by the recorder's own opening action still fails the attempt.
    const outcome = await record(script(a.origin, [{ route: "/?postopen#/a", heading: "A", open: true }, { route: "/#/b", heading: "B" }]));
    assert.match(outcome, /An opening or draft action tried to contact the application|Blocked POST request during read-only recording\./);
    assert.equal(a.beacons(), 0);
  } finally { a.close(); }
});

// Path-route twins of the leave-prompt and leave-time-write cases: path routes were full loads before
// too, so these fail on the old code for their own reasons (the prompt or the beacon refused), not
// the hash bug, and record now.
test("path routes: a page that asks before it's left, after an opening action, still lets the next view load", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    assert.equal(await record(script(a.origin, [{ route: "/a?leave", heading: "A", open: true }, { route: "/b", heading: "B" }])), "recorded");
  } finally { a.close(); }
});

test("path routes: a write a page tries while it's being left is stopped without failing the attempt", { timeout: 180_000 }, async () => {
  const a = await app();
  try {
    assert.equal(await record(script(a.origin, [{ route: "/a?beacon", heading: "A" }, { route: "/b", heading: "B" }])), "recorded");
    assert.equal(a.beacons(), 0, "no write reached the site");
  } finally { a.close(); }
});
