import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
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
  sessionRouteFromHash,
  type PeerInfo,
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
  assert.equal(href, `#/p/laptop/s/${q(A)}`);
  assert.deepEqual(sessionRouteFromHash(href), { host: "laptop", path: A });
  assert.equal(sessionRouteFromHash("#/mesh"), null);
  assert.equal(sessionRouteFromHash("#/s/%E0%A4%A"), null, "a malformed escape names nothing");
});

const peer = (id: string, status: PeerInfo["status"], error?: string): PeerInfo => ({ id, label: "", node: `${id}.ts.net`, status, lastSeen: null, error });
const row = (path: string, groupId?: string) => ({ path, groupId }) as SessionSummary;

test("a down peer keeps its last rows; a removed one loses them; groups never cross hosts", () => {
  const prev = new Map([["laptop", [row(A)]], ["gone", [row(B)]]]);
  const next = mergePeerLists(
    prev,
    { peers: [{ id: "laptop", status: "down" }, { id: "vps", status: "up", sessions: [row(B, "g1")] }] },
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
