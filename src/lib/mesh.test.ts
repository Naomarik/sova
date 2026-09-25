import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerStatus, SessionSummary } from "../../shared/protocol";
import {
  hostOf,
  hostUrl,
  mergePeerLists,
  noteHost,
  notePeerSessions,
  pathsNamed,
  peerUnavailable,
  resetHosts,
  routeUrl,
  sessionHrefOn,
  effectiveHostFilter,
  passesHostFilter,
  SELF_FILTER,
  meshRetryDelay,
  helloChange,
  moveItem,
  setMeshState,
  sessionRouteFromHash,
  
} from "./mesh";

const A = "/home/u/.pi/agent/sessions/--x--/2026-09-25T00-00-00-000Z_0199aaaa.jsonl";
const B = "/home/u/.pi/agent/sessions/--x--/2026-09-25T00-00-00-000Z_0199bbbb.jsonl";
const q = (p: string) => encodeURIComponent(p);

test("with no peer known, every URL is left exactly as it was", () => {
  resetHosts();
  for (const url of [`/api/transcript?path=${q(A)}`, "/api/sessions", `/api/upload?draft=${q(A)}`, "/explain/x"]) {
    assert.equal(routeUrl(url, JSON.stringify({ path: A })), url);
  }
});

test("a request naming a peer's session goes to that peer, by query or by body", () => {
  resetHosts();
  noteHost(A, "laptop");
  assert.equal(routeUrl(`/api/transcript?path=${q(A)}`), `/peer/laptop/api/transcript?path=${q(A)}`);
  assert.equal(routeUrl(`/api/upload?draft=${q(A)}`), `/peer/laptop/api/upload?draft=${q(A)}`);
  assert.equal(routeUrl("/api/sessions/title", JSON.stringify({ path: A, title: "x" })), "/peer/laptop/api/sessions/title");
  assert.equal(routeUrl("/api/sessions/cleanup", JSON.stringify({ mode: "paths", paths: [A] })), "/peer/laptop/api/sessions/cleanup");
  // A path this host holds stays here, and so does a request naming none.
  assert.equal(routeUrl(`/api/transcript?path=${q(B)}`), `/api/transcript?path=${q(B)}`);
  assert.equal(routeUrl("/api/sessions"), "/api/sessions");
  // Paths on two hosts at once: neither can answer; the serving host refuses it as it would any.
  assert.equal(routeUrl("/api/sessions/cleanup", JSON.stringify({ paths: [A, B] })), "/api/sessions/cleanup");
});

test("a URL already aimed at a peer is never prefixed twice", () => {
  resetHosts();
  noteHost(A, "laptop");
  assert.equal(hostUrl("laptop", "/api/cwds"), "/peer/laptop/api/cwds");
  assert.equal(hostUrl("vps", "/peer/laptop/api/cwds"), "/peer/laptop/api/cwds");
  assert.equal(routeUrl(`/peer/laptop/api/transcript?path=${q(A)}`), `/peer/laptop/api/transcript?path=${q(A)}`);
  assert.equal(hostUrl(null, "/api/cwds"), "/api/cwds");
});

test("a non-JSON body names nothing", () => {
  assert.deepEqual(pathsNamed("/api/upload", "not json"), []);
  assert.deepEqual(pathsNamed("/api/x", "{broken"), []);
});

test("a peer's list adds what it names and never forgets a path it leaves out", () => {
  resetHosts();
  // A session just created on the peer (a husk it doesn't list yet), or one a link named.
  noteHost(A, "laptop");
  notePeerSessions("laptop", []);
  assert.equal(hostOf(A), "laptop", "still routed to its host: forgetting it would send its requests here");
  notePeerSessions("vps", [B]);
  assert.equal(hostOf(B), "vps");
  assert.equal(hostOf(A), "laptop");
});

test("a local session's link is exactly what it was; a peer's carries the host, and both parse back", () => {
  assert.equal(sessionHrefOn(null, A), `#/s/${q(A)}`);
  assert.deepEqual(sessionRouteFromHash(`#/s/${q(A)}`), { host: null, path: A });
  const href = sessionHrefOn("laptop", A);
  assert.equal(href, `#/s/${q(A)}?host=laptop`);
  assert.deepEqual(sessionRouteFromHash(href), { host: "laptop", path: A });
  assert.equal(sessionRouteFromHash("#/mesh"), null);
  assert.equal(sessionRouteFromHash("#/s/%E0%A4%A"), null, "a malformed escape names nothing");
});

const peer = (id: string, state: PeerStatus["state"], error?: string): PeerStatus => ({
  id,
  label: "",
  nodeId: `n${id}`,
  name: `${id}.ts.net`,
  url: `http://${id}.ts.net:4801`,
  state,
  lastSeen: null,
  error,
});
const row = (path: string, groupId?: string) => ({ path, groupId }) as SessionSummary;

test("a down peer keeps its last rows; a removed one loses them; groups never cross hosts", () => {
  const prev = new Map([["laptop", [row(A)]], ["gone", [row(B)]]]);
  const next = mergePeerLists(
    prev,
    { peers: [{ id: "laptop", label: "", state: "down" }, { id: "vps", label: "", state: "up", sessions: [row(B, "g1")] }] },
    [peer("laptop", "down"), peer("vps", "up")],
  );
  assert.deepEqual([...next.keys()].sort(), ["laptop", "vps"]);
  assert.equal(next.get("laptop")![0]!.path, A);
  assert.equal(next.get("vps")![0]!.groupId, undefined, "a peer's group id means nothing here");
});

test("only an up peer can be used, and every other status says why in words", () => {
  assert.equal(peerUnavailable(peer("a", "up")), null);
  for (const s of ["down", "skewed", "refused"] as const) assert.match(peerUnavailable(peer("a", s))!, /\w+/);
  assert.match(peerUnavailable(peer("a", "down", "timed out"))!, /timed out/);
});

test("the host filter falls back to All when its host is gone or the filter isn't shown", () => {
  const peers = [{ id: "laptop" }];
  assert.equal(effectiveHostFilter(null, peers, true), null);
  assert.equal(effectiveHostFilter("laptop", peers, true), "laptop");
  assert.equal(effectiveHostFilter(SELF_FILTER, peers, true), SELF_FILTER);
  assert.equal(effectiveHostFilter("vps", peers, true), null, "a host no longer in peers.json");
  assert.equal(effectiveHostFilter("laptop", peers, false), null, "mesh off: never a filter");
});

test("the host filter narrows to one host's sessions, this host's included", () => {
  resetHosts();
  noteHost(A, "laptop");
  assert.equal(passesHostFilter(null, A), true);
  assert.equal(passesHostFilter(null, B), true);
  assert.equal(passesHostFilter("laptop", A), true);
  assert.equal(passesHostFilter("laptop", B), false);
  assert.equal(passesHostFilter(SELF_FILTER, B), true);
  assert.equal(passesHostFilter(SELF_FILTER, A), false);
});

test("GET /api/mesh is asked again only after a failure that may pass", () => {
  assert.equal(meshRetryDelay(404, 1), null, "a server without the route: one request, as before");
  assert.equal(meshRetryDelay(403, 1), null);
  assert.equal(meshRetryDelay(500, 1), 5_000);
  assert.equal(meshRetryDelay(0, 2), 15_000, "no answer at all: a host mid-restart");
  assert.equal(meshRetryDelay(502, 9), 60_000, "the last wait repeats");
});

test("a hello that differs says how; an unknown build is never a difference", () => {
  const a = { id: "a", label: "Host A", protocol: "p1", build: "b1" };
  assert.equal(helloChange(a, { ...a }), null);
  assert.deepEqual(helloChange(a, { ...a, build: "b2" }), { protocol: false, build: true, host: null });
  assert.equal(helloChange(a, { ...a, build: undefined }), null, "no build served (Vite): unknown");
  assert.equal(helloChange({ ...a, build: undefined }, { ...a, build: "b2" }), null);
  assert.deepEqual(helloChange(a, { id: "b", label: "Host B", protocol: "p1", build: "b1" }), {
    protocol: false,
    build: false,
    host: { from: "Host A", to: "Host B" },
  });
  assert.equal(helloChange(a, { ...a, protocol: "p2" })!.protocol, true);
});

test("after a failover, the new host's own paths are local again", () => {
  resetHosts();
  noteHost(A, "b");
  setMeshState({ enabled: true, self: { id: "a", label: "", hostname: "a" }, peers: [], sync: [], frontDoor: null });
  assert.equal(hostOf(A), "b");
  assert.equal(routeUrl(`/api/transcript?path=${q(A)}`), `/peer/b/api/transcript?path=${q(A)}`);
  setMeshState({ enabled: true, self: { id: "b", label: "", hostname: "b" }, peers: [], sync: [], frontDoor: null });
  assert.equal(hostOf(A), null, "b's session, and this page is now served by b");
  assert.equal(routeUrl(`/api/transcript?path=${q(A)}`), `/api/transcript?path=${q(A)}`);
  setMeshState(null);
});

test("moving a host in the front-door order moves only it; an out-of-range move changes nothing", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "c", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 3), ["a", "b", "c"]);
});
