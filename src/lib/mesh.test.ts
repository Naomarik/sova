import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerStatus, SessionSummary } from "../../shared/protocol";
import {
  hostOf,
  hostUrl,
  mergePeerLists,
  joinHostLists,
  linkedSessionRow,
  seedPeerList,
  watchMove,
  frontDoorLeftOut,
  withExclusion,
  orderKeepingLeftOut,
  meshReadInit,
  MESH_READ_TIMEOUT_MS,
  MOVE_WATCH_MS,
  sessionViewKey,
  pathOfViewKey,
  mayBeHostMove,
  recheckHost,
  setHostCheck,
  FILE_NOT_FOUND,
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
  firstBaseline,
  helloStep,
  HOST_CONFIRM_MS,
  moveItem,
  frontDoorProblems,
  serveUrlProblem,
  setMeshState,
  sessionRouteFromHash,
  claimable,
  claimRefusal,
  conflictLine,
  conflictSummary,
  listWords,
  loginConflicts,
  loginName,
  
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

test("the front door flags placeholder upstreams and mixed schemes, and nothing when all is well", () => {
  assert.deepEqual(frontDoorProblems([{ id: "a", upstream: "https://a.tail1.ts.net:8443" }, { id: "b", upstream: "https://b.tail1.ts.net:8443" }]), {
    placeholders: [],
    mixedSchemes: false,
  });
  assert.deepEqual(frontDoorProblems([{ id: "a", upstream: "https://a.YOUR-TAILNET.ts.net:8443" }, { id: "b", upstream: "http://b:8080" }]), {
    placeholders: ["a"],
    mixedSchemes: true,
  });
  assert.equal(serveUrlProblem("https://a.tail1.ts.net:8443"), null);
  assert.equal(serveUrlProblem("http://10.0.0.2:4800"), null);
  assert.match(serveUrlProblem("a.tail1.ts.net")!, /https:\/\//);
  assert.match(serveUrlProblem("")!, /https:\/\//);
});

test("login conflicts: only keys some peer holds differently, named for the page", () => {
  const entries = [
    { key: "pi:zai", store: "pi" as const, provider: "zai", kind: "api_key" as const, state: "live" as const, conflictWith: ["b", "c"] },
    { key: "pi:deepseek", store: "pi" as const, provider: "deepseek", kind: "api_key" as const, state: "live" as const, conflictWith: [] },
    { key: "claude:claudeAiOauth", store: "claude" as const, provider: "claudeAiOauth", kind: "oauth" as const, state: "expired" as const },
  ];
  assert.deepEqual(loginConflicts(entries).map((e) => e.key), ["pi:zai"]);
  assert.equal(loginName(entries[0]!), "zai API key");
  assert.equal(loginName(entries[2]!), "Claude Code login");
  assert.equal(listWords([]), "");
  assert.equal(listWords(["b"]), "b");
  assert.equal(listWords(["b", "c"]), "b and c");
  assert.equal(listWords(["b", "c", "d"]), "b, c, and d");
});

test("a refused claim reads as what to do next", () => {
  const key = { key: "pi:zai", store: "pi" as const, provider: "zai", kind: "api_key" as const, state: "live" as const };
  assert.match(claimRefusal(key, 409, "No live login here to claim"), /logged out or failed.*Add it again here/);
  assert.match(claimRefusal({ ...key, kind: "oauth" }, 409, "No live login here to claim"), /Log in again here/);
  assert.match(claimRefusal(key, 409, "Logins sync is off"), /Login sync is off on this host/);
  assert.match(claimRefusal({ ...key, kind: "oauth" }, 409, "This host syncs API keys only"), /API keys only, so its sign-ins stay here/);
  assert.equal(claimRefusal(key, 400, "Unknown login"), "This host doesn't hold the zai API key any more.");
  assert.equal(claimRefusal(key, 0, "The Sova server isn't reachable."), "The Sova server isn't reachable.");
});

test("live and expired logins can be kept; dead and logged-out ones can't", () => {
  const e = (state: "live" | "expired" | "dead" | "logged-out") => ({ key: "pi:x", store: "pi" as const, provider: "x", state });
  assert.deepEqual((["live", "expired", "dead", "logged-out"] as const).map((s) => claimable(e(s))), [true, true, false, false]);
});

test("a failover before the first hello still reads as a failover (qa F4)", () => {
  const b = { id: "b", label: "Host B", protocol: "p1", build: "b1" };
  const base = firstBaseline({ id: "a", label: "Host A" }, b);
  assert.deepEqual(base, { id: "a", label: "Host A", protocol: "p1", build: "b1" });
  assert.deepEqual(helloChange(base, b), { protocol: false, build: false, host: { from: "Host A", to: "Host B" } });
  // Same host, or no /api/mesh answer to go by: the hello is the baseline and nothing changed.
  assert.equal(helloChange(firstBaseline({ id: "b", label: "Host B" }, b), b), null);
  assert.equal(firstBaseline(null, b), b);
});

test("one answer from another host is not a failover; a second from it, 1 s or more later, is (lab L1)", () => {
  const a = { id: "a", label: "Host A", protocol: "p1", build: "b1" };
  const b = { ...a, id: "b", label: "Host B" };
  const c = { ...a, id: "c", label: "Host C" };
  // A single retried request answered by b, then a again: nothing is announced, nothing pends.
  let s = helloStep(a, b, null, 0);
  assert.deepEqual(s, { change: null, pending: { id: "b", at: 0 } });
  assert.deepEqual(helloStep(a, a, s.pending, 1_500), { change: null, pending: null });
  // b again too soon: still waiting, and the first sighting's time is kept.
  s = helloStep(a, b, s.pending, HOST_CONFIRM_MS - 1);
  assert.deepEqual(s, { change: null, pending: { id: "b", at: 0 } });
  // b again after the wait: the failover.
  assert.deepEqual(helloStep(a, b, s.pending, HOST_CONFIRM_MS), {
    change: { protocol: false, build: false, host: { from: "Host A", to: "Host B" } },
    pending: null,
  });
  // b, then c: c starts its own wait.
  assert.deepEqual(helloStep(a, c, { id: "b", at: 0 }, 5_000), { change: null, pending: { id: "c", at: 5_000 } });
  // Same host, new build: reported at once.
  assert.deepEqual(helloStep(a, { ...a, build: "b2" }, null, 0), { change: { protocol: false, build: true, host: null }, pending: null });
  // F4: the first hello already from b, the page from a: the same wait, then the failover.
  const base = firstBaseline({ id: "a", label: "Host A" }, b);
  s = helloStep(base, b, null, 0);
  assert.equal(s.change, null);
  assert.deepEqual(helloStep(base, b, s.pending, 1_100).change?.host, { from: "Host A", to: "Host B" });
});

test("conflict wording reads right for one host and for several", () => {
  const key = { key: "pi:zai", store: "pi" as const, provider: "zai", kind: "api_key" as const, state: "live" as const };
  const label = (id: string) => ({ b: "Host B", c: "Host C", d: "Host D" })[id] ?? id;
  assert.equal(conflictLine({ ...key, conflictWith: ["b"] }, label), "Host B has a different key, from before they synced. It doesn't sync until you keep one.");
  assert.equal(conflictLine({ ...key, conflictWith: ["b", "c"] }, label), "Host B and Host C have different keys, from before they synced. It doesn't sync until you keep one.");
  assert.equal(conflictLine({ ...key, kind: "oauth", conflictWith: ["b", "c", "d"] }, label), "Host B, Host C, and Host D have different logins, from before they synced. It doesn't sync until you keep one.");
  assert.equal(conflictSummary(1), "1 login differs between hosts. Choose below which to keep.");
  assert.equal(conflictSummary(2), "2 logins differ between hosts. Choose below which to keep.");
});

test("a path both this host and a peer list shows once, as the peer's (live failover finding)", () => {
  const row = (path: string, title: string) => ({ path, title }) as unknown as SessionSummary;
  const stale = row("/vps/s1.jsonl", "local copy");
  const mine = row("/laptop/s2.jsonl", "mine");
  const peer = row("/vps/s1.jsonl", "peer copy");
  const joined = joinHostLists([stale, mine], new Map([["vps", [peer]]]));
  assert.deepEqual(joined.map((s) => s.title), ["mine", "peer copy"]);
  // No overlap: this host's rows, then the peers', exactly as before.
  assert.deepEqual(joinHostLists([mine], new Map([["vps", [peer]]])).map((s) => s.title), ["mine", "peer copy"]);
});

test("a sova://s/ link to a peer's session finds the peer's row, and waits for the lists before asking this host", () => {
  const row = (id: string, path: string) => ({ id, path }) as unknown as SessionSummary;
  const mine = row("m1", "/laptop/m1.jsonl");
  const theirs = row("v1", "/vps/v1.jsonl");
  const peers = new Map([["vps", [theirs]]]);
  assert.equal(linkedSessionRow("v1", [mine], peers, true), theirs, "a peer's row, not 'That session is gone.'");
  assert.equal(linkedSessionRow("m1", [mine], peers, true), mine);
  // A miss goes to this host's server only once the lists that could hold it are in.
  assert.equal(linkedSessionRow("x", [mine], peers, true), null);
  assert.equal(linkedSessionRow("v1", [mine], new Map(), false), "wait", "the peers' lists haven't landed");
  assert.equal(linkedSessionRow("v1", undefined, peers, true), "wait", "this host's list hasn't landed");
  // Mesh off: this host's list alone, exactly as before.
  assert.equal(linkedSessionRow("m1", [mine], new Map(), true), mine);
  assert.equal(linkedSessionRow("v1", [mine], new Map(), true), null);
});

test("after a host change the old host's sessions stay listed as that peer's, until the peer's own list wins", () => {
  const row = (path: string, groupId?: string) => ({ path, groupId }) as SessionSummary;
  const seeded = seedPeerList(new Map(), "a", [row("/a/1.jsonl", "g1"), row("/a/2.jsonl")]);
  assert.deepEqual([...seeded.keys()], ["a"]);
  assert.deepEqual(seeded.get("a")!.map((s) => [s.path, s.groupId]), [["/a/1.jsonl", undefined], ["/a/2.jsonl", undefined]], "groups never cross hosts");
  const sent = new Map([["a", [row("/a/3.jsonl")]]]);
  assert.deepEqual(seedPeerList(sent, "a", [row("/a/1.jsonl")]).get("a")!.map((s) => s.path), ["/a/3.jsonl"], "a list the peer sent wins");
  // A down peer keeps the seeded rows through the next merge.
  const merged = mergePeerLists(seeded, { peers: [{ id: "a", label: "", state: "down" }] }, [{ id: "a" } as PeerStatus]);
  assert.equal(merged.get("a")!.length, 2);
});

test("a reconnect's 'not found' is held as a possible host change only with the mesh on, for this host's own session", () => {
  const nf = { code: "internal", message: FILE_NOT_FOUND };
  assert.equal(mayBeHostMove(nf, true, true, true), true);
  assert.equal(mayBeHostMove(nf, true, true, false), false, "mesh off: shown at once, as before");
  assert.equal(mayBeHostMove(nf, false, true, true), false, "the first connection: the file was never there");
  assert.equal(mayBeHostMove(nf, true, false, true), false, "a peer's session doesn't move with the front door");
  assert.equal(mayBeHostMove({ code: "internal", message: "boom" }, true, true, true), false);
  assert.equal(mayBeHostMove({ code: "config", message: FILE_NOT_FOUND }, true, true, true), false);
  let asked = 0;
  recheckHost(); // nothing registered: a no-op
  setHostCheck(() => asked++);
  recheckHost();
  setHostCheck(null);
  recheckHost();
  assert.equal(asked, 1);
});

test("after a host change the old host's state is re-read quickly until the new host calls it down, for a bounded time", () => {
  const peer = (state: PeerStatus["state"]) => [{ id: "a", state } as PeerStatus];
  const moved = { from: "a", at: 1_000 };
  assert.equal(watchMove(null, 2_000, peer("up")), false, "no host change: the 15 s poll alone");
  assert.equal(watchMove(moved, 2_000, peer("up")), true, "the new host still calls it up");
  assert.equal(watchMove(moved, 2_000, []), true, "not in the new host's state yet");
  assert.equal(watchMove(moved, 2_000, peer("down")), false, "called down: done");
  assert.equal(watchMove(moved, 1_000 + MOVE_WATCH_MS + 1, peer("up")), false, "a flap that never went down stops after the window");
});

test("the session view is keyed on its host too, and the path comes back out whole", () => {
  const p = "/s/odd\nname.jsonl";
  assert.notEqual(sessionViewKey("a", p), sessionViewKey(null, p), "handed to a peer: a new view");
  assert.equal(sessionViewKey(null, p), sessionViewKey(null, p));
  assert.equal(pathOfViewKey(sessionViewKey("a", p)), p);
  assert.equal(pathOfViewKey(sessionViewKey(null, p)), p);
});

test("mesh reads carry a deadline only while the mesh is on; off, the request is as before", async () => {
  assert.equal(meshReadInit(false), undefined, "mesh off: no options at all");
  const init = meshReadInit(true)!;
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal!.aborted, false);
  assert.equal(MESH_READ_TIMEOUT_MS, 4_000);
  // The deadline really fires: a fresh one, observed past its time (short-circuited with a fake clock would test nothing).
  const fired = await new Promise<boolean>((resolve) => {
    init.signal!.addEventListener("abort", () => resolve(true));
    setTimeout(() => resolve(false), MESH_READ_TIMEOUT_MS + 500);
  });
  assert.equal(fired, true);
});

test("the front door's left-out hosts stay listed, and a switch puts one in or leaves it out", () => {
  const hosts = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "phone", label: "Phone" }];
  assert.deepEqual(frontDoorLeftOut(hosts, undefined, ["a", "b", "phone"]), [], "absent: every host is in");
  assert.deepEqual(frontDoorLeftOut(hosts, ["phone", "a"], ["b"]).map((h) => h.id), ["a", "phone"], "host order, this host first");
  assert.deepEqual(frontDoorLeftOut(hosts, ["gone"], ["a", "b", "phone"]), [], "an id that is no host lists nothing");
  assert.deepEqual(frontDoorLeftOut(hosts, ["a", "b", "phone"], ["a", "b", "phone"]), [], "a file leaving out all: the front door keeps them, so none shows out");
  assert.deepEqual(withExclusion(null, "phone", true), ["phone"]);
  assert.deepEqual(withExclusion(["phone"], "a", true), ["phone", "a"]);
  assert.deepEqual(withExclusion(["phone", "a"], "a", true), ["phone", "a"], "no duplicate");
  assert.equal(withExclusion(["phone"], "phone", false), null, "nobody left out: cleared");
  assert.deepEqual(withExclusion(["phone", "a"], "phone", false), ["a"]);
  assert.deepEqual(orderKeepingLeftOut(["b", "a"], ["phone"]), ["b", "a", "phone"], "a left-out host keeps a place at the end");
  assert.deepEqual(orderKeepingLeftOut(["b", "a"], ["a"]), ["b", "a"]);
});
