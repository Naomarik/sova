import assert from "node:assert/strict";
import { test } from "node:test";
import { isStarting } from "../../shared/services-view";
import { adoptedLine, adoptedOf, copyChip, copyMemory, copyName, createdByWord, endpointNotRunning, rowVerbs, shareOffered, endpointPort, httpHref, linkLine, notReadyLine, refusalLine, sentence, SHARE_SENSITIVE, shareBlocked } from "./services-view";

test("a copy is named main at slot 0, else by its branch, else by its folder", () => {
  assert.equal(copyName({ slot: 0, branch: "master", checkout: "/p" }), "main");
  assert.equal(copyName({ slot: 2, branch: "feat-x", checkout: "/p/.wt/x" }), "feat-x");
  assert.equal(copyName({ slot: 3, branch: null, checkout: "/p/.wt/detached/" }), "detached");
});

test("memory sums what reports, and says — when nothing does", () => {
  assert.equal(copyMemory([{}, {}]), "—");
  assert.equal(copyMemory([{ rssBytes: 1024 * 1024 }, {}, { rssBytes: 1024 * 1024 }]), copyMemory([{ rssBytes: 2 * 1024 * 1024 }]));
});

test("who made a copy reads as a person or a kind; an unknown tag passes through", () => {
  assert.equal(createdByWord("operator"), "you");
  assert.equal(createdByWord("session:abc"), "a coding session");
  assert.equal(createdByWord("project-overseer:prj_1"), "its overseer");
  assert.equal(createdByWord("overseer:o1"), "the Overseer");
  assert.equal(createdByWord("weird"), "weird");
});

test("the services not ready are named; none when all are", () => {
  const s = (name: string, state: "ready" | "stopped" | "failed") => ({ name, scope: "checkout" as const, kind: "process" as const, state, unit: null, pid: null, ports: {} });
  assert.equal(notReadyLine([s("web", "ready")]), null);
  assert.equal(notReadyLine([s("web", "ready"), s("api", "failed"), s("db", "stopped")]), "api failed · db stopped");
});

test("an HTTP port links on the page's host, an IPv6 host bracketed", () => {
  assert.equal(httpHref("localhost", { port: 4100, path: "/health" }), "http://localhost:4100/health");
  assert.equal(httpHref("::1", { port: 4100, path: "x" }), "http://[::1]:4100/x");
});

test("a refusal is a sentence without the CLI's hint; needs-confirm and busy say what to do", () => {
  assert.equal(sentence("apply of the main checkout stops it: confirm it (sova-project apply … --confirm)"), "Apply of the main checkout stops it: confirm it.");
  assert.equal(refusalLine({ ok: true }), null);
  assert.equal(refusalLine({ ok: false }), "It didn't finish. Read its logs.");
  const confirm = refusalLine({ ok: false, error: { code: "needs-confirm", message: "x stops the server (sova-project down … --confirm)" } })!;
  assert.match(confirm, /^X stops the server\. Press it again to confirm\.$/);
  assert.equal(refusalLine({ ok: false, error: { code: "busy", message: "another verb is running on this instance (pid 4); try again when it ends" } }), "Another verb is running on this instance (pid 4); try again when it ends.");
  assert.equal(refusalLine({ ok: false, error: { code: "busy", message: "2 sessions are busy" } }), "2 sessions are busy. Try again once they are idle.");
  assert.equal(refusalLine({ ok: false, error: { code: "start-failed", message: "web stopped (exit 1)" } }), "Web stopped (exit 1).");
});

test("Share: an endpoint's port in the copy, the sensitive reason before the engine's, and a link's chip", () => {
  const c = { services: [{ name: "web", scope: "checkout" as const, kind: "process" as const, state: "ready" as const, unit: null, pid: null, ports: { http: 4110 } }] };
  assert.equal(endpointPort(c, "web.http"), 4110);
  assert.equal(endpointPort(c, "web.admin"), null);
  assert.equal(endpointPort(c, "api.http"), null);
  assert.equal(shareBlocked({ share: { endpoints: ["web.http"], refused: null } }, true), SHARE_SENSITIVE);
  assert.equal(shareBlocked({ share: { endpoints: ["web.http"], refused: "Start it first." } }, false), "Start it first.");
  assert.equal(shareBlocked({ share: { endpoints: ["web.http"], refused: null } }, false), null);
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(linkLine({ endpoint: "web.http", expiresAt: "2026-10-03T17:30:00Z" }, now), "web.http · expires in 5 hours");
  assert.equal(linkLine({ endpoint: "web.http", expiresAt: "2026-10-08T12:00:00Z" }, now), "web.http · expires in 5 days");
});

test("Share waits while the endpoint's service isn't ready, saying so", () => {
  const svc = (state: "ready" | "stopped") => ({ services: [{ name: "web", scope: "checkout" as const, kind: "process" as const, state, unit: null, pid: null, ports: { http: 4110 } }] });
  assert.equal(endpointNotRunning(svc("ready"), "web.http"), null);
  assert.equal(endpointNotRunning(svc("stopped"), "web.http"), "This copy isn't running web: start it first. Sharing never starts anything.");
  assert.match(endpointNotRunning(svc("ready"), "api.http")!, /isn't running api/);
});

test("a row offers what its state allows: Start when stopped or degraded, Stop when running or degraded, never Teardown on main", () => {
  assert.deepEqual(rowVerbs({ slot: 1, state: "stopped", services: [] }), ["up", "apply", "reset", "teardown"]);
  assert.deepEqual(rowVerbs({ slot: 1, state: "running", services: [] }), ["down", "apply", "reset", "teardown"]);
  assert.deepEqual(rowVerbs({ slot: 1, state: "degraded", services: [] }), ["up", "down", "apply", "reset", "teardown"]);
  assert.deepEqual(rowVerbs({ slot: 0, state: "running", services: [] }), ["down", "apply", "reset"]);
  assert.deepEqual(rowVerbs({ slot: 0, state: "running", services: [], adopted: "sova-runtime.service" }), ["apply"]);
  assert.equal(adoptedLine("sova-runtime.service"), "Runs as sova-runtime.service; Apply schedules a guarded restart.");
});

test("Share only on a running copy, never an adopted main; Starting reads in place of Degraded while a service starts", () => {
  assert.equal(shareOffered({ slot: 1, state: "running", services: [] }), true);
  assert.equal(shareOffered({ slot: 1, state: "degraded", services: [] }), false);
  assert.equal(shareOffered({ slot: 1, state: "stopped", services: [] }), false);
  assert.equal(shareOffered({ slot: 0, state: "running", services: [], adopted: "u.service" }), false);
  assert.equal(copyChip("degraded", true).word, "Starting");
  assert.equal(copyChip("degraded", false).word, "Degraded");
  const svcs = (...st: ("ready" | "starting" | "failed")[]) => st.map((state) => ({ state }));
  assert.equal(isStarting("degraded", svcs("ready", "starting")), true);
  assert.equal(isStarting("degraded", svcs("failed", "starting")), false);
  assert.equal(isStarting("running", svcs("ready")), false);
});

// A main copy as :4930's status answered it for an adopted stand-in unit (only the paths shortened), with
// no `adopted` key: what a server older than that field, or a peer's, sends.
const ADOPTED_MAIN = {
  instance: "adopt-d2449ea9",
  slot: 0,
  generation: 0,
  checkout: "/w/tmp/fixture/adopt",
  branch: "main",
  state: "running" as const,
  services: [
    {
      name: "server",
      scope: "checkout" as const,
      kind: "process" as const,
      unit: "sova-gate-4940.service",
      pid: 537889,
      ports: { http: 4940 },
      state: "ready" as const,
      ready: { probe: "http :4940/", ok: true, ms: 2 },
      detail: "adopted unit, started 2026-10-03T13:07:11.000Z",
      rssBytes: 80932864,
    },
  ],
  createdBy: "operator",
  links: [],
  share: { endpoints: [], refused: "This project's definition says its copies are never shared (share.allow: false)." },
};

test("an adopted main is read from its status detail when the server sends no `adopted`: Apply alone, no Share, its unit named", () => {
  assert.equal(adoptedOf(ADOPTED_MAIN), "sova-gate-4940.service");
  assert.deepEqual(rowVerbs(ADOPTED_MAIN), ["apply"]);
  assert.equal(shareOffered(ADOPTED_MAIN), false);
  assert.equal(adoptedOf({ ...ADOPTED_MAIN, adopted: "x.service" }), "x.service");
  // The same detail on a branch copy is not an adopted main; an ordinary main is not either.
  assert.equal(adoptedOf({ ...ADOPTED_MAIN, slot: 1 }), null);
  assert.equal(adoptedOf({ ...ADOPTED_MAIN, services: [{ ...ADOPTED_MAIN.services[0]!, detail: undefined }] }), null);
});
