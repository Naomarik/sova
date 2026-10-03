import assert from "node:assert/strict";
import { test } from "node:test";
import { isStarting } from "../../shared/services-view";
import { adoptedLine, copyChip, copyMemory, copyName, createdByWord, endpointNotRunning, entryHref, openEntry, rowVerbs, shareOffered, endpointPort, httpHref, linkLine, notReadyLine, refusalLine, sentence, SHARE_SENSITIVE, shareBlocked, verbGroups, portLabel } from "./services-view";

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
  assert.deepEqual(rowVerbs({ slot: 1, state: "stopped" }), ["up", "apply", "reset", "teardown"]);
  assert.deepEqual(rowVerbs({ slot: 1, state: "running" }), ["down", "apply", "reset", "teardown"]);
  assert.deepEqual(rowVerbs({ slot: 1, state: "degraded" }), ["up", "down", "apply", "reset", "teardown"]);
  assert.deepEqual(rowVerbs({ slot: 0, state: "running" }), ["down", "apply", "reset"]);
  assert.deepEqual(rowVerbs({ slot: 0, state: "running", adopted: "sova-runtime.service" }), ["apply"]);
  assert.equal(adoptedLine("sova-runtime.service"), "Runs as sova-runtime.service; Apply schedules a guarded restart.");
});

test("Share only on a running copy, never an adopted main; Starting reads in place of Degraded while a service starts", () => {
  assert.equal(shareOffered({ state: "running" }), true);
  assert.equal(shareOffered({ state: "degraded" }), false);
  assert.equal(shareOffered({ state: "stopped" }), false);
  assert.equal(shareOffered({ state: "running", adopted: "u.service" }), false);
  assert.equal(copyChip("degraded", true).word, "Starting");
  assert.equal(copyChip("degraded", false).word, "Degraded");
  const svcs = (...st: ("ready" | "starting" | "failed")[]) => st.map((state) => ({ state }));
  assert.equal(isStarting("degraded", svcs("ready", "starting")), true);
  assert.equal(isStarting("degraded", svcs("failed", "starting")), false);
  assert.equal(isStarting("running", svcs("ready")), false);
});

test("a row's verbs are grouped by weight, and every verb it offers lands in exactly one group", () => {
  const states = ["running", "degraded", "stopped", "absent"] as const;
  for (const slot of [0, 2])
    for (const state of states)
      for (const adopted of [undefined, "x.service"]) {
        const verbs = rowVerbs({ slot, state, adopted });
        const g = verbGroups(verbs);
        const all = [...(g.primary ? [g.primary] : []), ...g.quiet, ...g.destructive];
        assert.deepEqual([...all].sort(), [...verbs].sort(), `${slot} ${state} ${adopted}`);
        assert.ok(g.destructive.every((v) => v === "reset" || v === "teardown"));
        assert.ok(!g.quiet.some((v) => v === "reset" || v === "teardown"));
      }
  assert.equal(verbGroups(rowVerbs({ slot: 1, state: "stopped" })).primary, "up");
  assert.equal(verbGroups(rowVerbs({ slot: 1, state: "degraded" })).primary, "up");
  assert.equal(verbGroups(rowVerbs({ slot: 1, state: "running" })).primary, "down");
  assert.equal(verbGroups(rowVerbs({ slot: 0, state: "running", adopted: "x.service" })).primary, "apply");
});

test("a port reads as its number for the generic name, else name:number", () => {
  assert.equal(portLabel("port", 4344), "4344");
  assert.equal(portLabel("nrepl", 7860), "nrepl:7860");
});

test("Open: only a running copy with an entry offers it, to the entry's port and path on this page's host", () => {
  const open = { endpoint: "web.http", port: 4130, path: "/home?x=1" };
  assert.deepEqual(openEntry({ state: "running", open }), open);
  for (const state of ["degraded", "stopped", "absent"] as const) assert.equal(openEntry({ state, open }), null, state);
  assert.equal(openEntry({ state: "running" }), null, "no entry declared: nothing extra");
  assert.equal(entryHref("192.0.2.7", open), "http://192.0.2.7:4130/home?x=1");
  assert.equal(entryHref("::1", { port: 4130, path: "/" }), "http://[::1]:4130/");
});
