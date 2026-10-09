// Run: pnpm test -- server/mesh/peer-address.test.ts
// Where this host dials a tailnet peer (§mesh/peers): a DNS name is never trusted as resolved; the
// dial goes to the tailnet IP Tailscale lists for exactly that peer's node, so whoever answers the
// name elsewhere never gets the call. IP literals and https URLs are dialed as written.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { fetchPeer } from "./dial";
import { setIdentity, type TailnetNode, type TailnetStatus } from "./localapi";
import { EventEmitter } from "node:events";
import { candidateBase, clearPeerAddresses, setPeerAddressDeps, verifiedPeerBase, verifiedPeerSocket } from "./peer-address";
import { fakeWire } from "./peer-wire-test-fixtures";
import type { PeerEntry } from "./peers";

const node = (nodeId: string, addresses: string[], name = `${nodeId}.lab.ts.net`): TailnetNode => ({ nodeId, name, hostName: nodeId, os: "linux", online: true, tags: [], login: "me", addresses });

let nodes: TailnetNode[] = [];
let failing = false;
let calls = 0;
setIdentity({
  status: async (): Promise<TailnetStatus> => {
    calls++;
    if (failing) throw new Error("tailscaled not running");
    return { backendState: "Running", self: node("nA", ["100.64.0.1"]), peers: nodes };
  },
  whois: async () => null,
});

let now = 1_000_000;
let addressMode = false;
const undo = setPeerAddressDeps({ now: () => now, addressMode: () => addressMode });
const wire = fakeWire();
after(() => {
  undo();
  wire.restore();
});

beforeEach(() => {
  clearPeerAddresses();
  nodes = [];
  failing = false;
  calls = 0;
  addressMode = false;
});

const peer = (extra: Partial<PeerEntry> = {}): PeerEntry => ({ id: "b", label: "B", nodeId: "nB", dnsName: "b.lab.ts.net", ...extra });

test("a DNS name is dialed at the tailnet IP LocalAPI lists for that node, IPv4 first, same port", async () => {
  nodes = [node("nB", ["fd7a:115c:a1e0::9", "100.64.0.9"])];
  assert.equal(await verifiedPeerBase(peer()), "http://100.64.0.9:4801");
  assert.equal(await verifiedPeerBase(peer({ url: "http://b.lab.ts.net:9000" })), "http://100.64.0.9:9000");
  nodes = [node("nB", ["fd7a:115c:a1e0::9"])];
  clearPeerAddresses();
  assert.equal(await verifiedPeerBase(peer()), "http://[fd7a:115c:a1e0::9]:4801");
});

test("a peer whose name resolves somewhere else is never dialed there", async () => {
  // b.lab.ts.net "resolves" to an impostor; Tailscale says node nB is 100.64.0.9.
  nodes = [node("nB", ["100.64.0.9"]), node("nX", ["100.64.0.66"], "b.lab.ts.net")];
  let impostor = 0;
  wire.serve("http://b.lab.ts.net:4801", () => {
    impostor++;
    return Response.json({ who: "impostor" });
  });
  wire.serve("http://100.64.0.9:4801", () => Response.json({ who: "b" }));
  const res = await fetchPeer(peer(), "/api/peer/hello");
  assert.deepEqual(await res.json(), { who: "b" });
  assert.equal(impostor, 0);
  assert.ok(wire.sent.every((r) => new URL(r.url).hostname !== "b.lab.ts.net"));
});

test("a node LocalAPI doesn't list (or lists twice) is down, and nothing is sent", async () => {
  nodes = [node("nX", ["100.64.0.66"])];
  const before = wire.fetches;
  await assert.rejects(verifiedPeerBase(peer()), (e: Error & { cause?: { code?: string } }) => e.cause?.code === "not on the tailnet");
  await assert.rejects(fetchPeer(peer(), "/api/peer/hello"));
  nodes = [node("nB", ["100.64.0.9"]), node("nB", ["100.64.0.10"])];
  clearPeerAddresses();
  await assert.rejects(verifiedPeerBase(peer()));
  assert.equal(wire.fetches, before);
});

test("the verified IP is kept about 30 s, then asked again", async () => {
  nodes = [node("nB", ["100.64.0.9"])];
  await verifiedPeerBase(peer());
  await verifiedPeerBase(peer());
  assert.equal(calls, 1);
  nodes = [node("nB", ["100.64.0.10"])];
  now += 31_000;
  assert.equal(await verifiedPeerBase(peer()), "http://100.64.0.10:4801");
  assert.equal(calls, 2);
});

test("while LocalAPI errors, the last verified IP is kept; with none, the peer is down", async () => {
  nodes = [node("nB", ["100.64.0.9"])];
  await verifiedPeerBase(peer());
  failing = true;
  now += 60_000;
  assert.equal(await verifiedPeerBase(peer()), "http://100.64.0.9:4801");
  await assert.rejects(verifiedPeerBase(peer({ id: "c", nodeId: "nC" })));
});

test("a failed connection drops the cached IP, so the next dial asks LocalAPI again", async () => {
  nodes = [node("nB", ["100.64.0.9"])];
  wire.down("http://100.64.0.9:4801");
  await assert.rejects(fetchPeer(peer(), "/api/peer/hello"));
  assert.equal(calls, 1);
  nodes = [node("nB", ["100.64.0.12"])];
  wire.serve("http://100.64.0.12:4801", () => Response.json({ ok: true }));
  assert.equal((await fetchPeer(peer(), "/api/peer/hello")).status, 200);
  assert.equal(calls, 2);
});

test("an IP literal or an https URL is dialed as written, without asking LocalAPI", async () => {
  assert.equal(await verifiedPeerBase(peer({ url: "http://127.0.0.1:47001" })), "http://127.0.0.1:47001");
  assert.equal(await verifiedPeerBase(peer({ dnsName: "100.64.0.9" })), "http://100.64.0.9:4801");
  assert.equal(await verifiedPeerBase(peer({ dnsName: "fd7a:115c:a1e0::9" })), "http://[fd7a:115c:a1e0::9]:4801");
  assert.equal(await verifiedPeerBase(peer({ url: "https://b.example:9443" })), "https://b.example:9443");
  // A LAN or public IP keeps working (with a warning in the log).
  assert.equal(await verifiedPeerBase(peer({ url: "http://192.168.1.5:4801" })), "http://192.168.1.5:4801");
  assert.equal(calls, 0);
});

test("address-identity mode: the entry's pinned tailnet IP, else the name as before", async () => {
  addressMode = true;
  assert.equal(await verifiedPeerBase(peer({ url: "http://100.64.0.9:4801" })), "http://100.64.0.9:4801");
  assert.equal(await verifiedPeerBase(peer()), "http://b.lab.ts.net:4801");
  assert.equal(calls, 0);
});

test("discovery probes a node at its own address, never its name", () => {
  assert.equal(candidateBase(node("nB", ["fd7a:115c:a1e0::9", "100.64.0.9"], "evil.example")), "http://100.64.0.9:4801");
  assert.equal(candidateBase(node("nB", [])), null);
  assert.equal(candidateBase(node("nB", ["8.8.8.8"])), null);
});

test("the LLM feed's socket opens at the verified address; with none it errors and closes", async () => {
  nodes = [node("nB", ["100.64.0.9"])];
  const opened: string[] = [];
  const inner = Object.assign(new EventEmitter(), { close: () => inner.emit("close") });
  const seen: string[] = [];
  const sock = verifiedPeerSocket(peer(), (base) => {
    opened.push(base);
    return inner;
  });
  sock.on("message", (d: unknown) => seen.push(`message:${d}`));
  sock.on("close", () => seen.push("close"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened, ["http://100.64.0.9:4801"]);
  inner.emit("message", "hi");
  sock.close();
  assert.deepEqual(seen, ["message:hi", "close"]);

  nodes = [];
  clearPeerAddresses();
  const events: string[] = [];
  const none = verifiedPeerSocket(peer(), () => {
    throw new Error("never opened");
  });
  none.on("error", () => events.push("error"));
  none.on("close", () => events.push("close"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(events, ["error", "close"]);
});
