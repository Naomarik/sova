// Run: pnpm exec tsx --test server/share-destination.test.ts. Where a gateway may dial a routed
// host (review B3): a tailnet literal bound to the row's StableID, never a resolver's answer.
import assert from "node:assert/strict";
import { test } from "node:test";

const { verifiedAddress, clearDestinationCache } = await import("./share/destination");
const { setIdentity, localApiIdentity } = await import("./mesh/localapi");
type TailnetNode = import("./mesh/localapi").TailnetNode;
type PeerEntry = import("./mesh/peers").PeerEntry;

const node = (nodeId: string, addresses: string[]): TailnetNode => ({ nodeId, name: `${nodeId}.tail.example`, hostName: nodeId, os: "linux", online: true, tags: [], login: "u", addresses });
function withStatus(peers: TailnetNode[] | Error): void {
  clearDestinationCache();
  setIdentity({
    status: async () => {
      if (peers instanceof Error) throw peers;
      return { backendState: "Running", self: node("self", ["100.64.0.1"]), peers };
    },
    whois: async () => null,
  });
}
const peer = (over: Partial<PeerEntry> = {}): PeerEntry => ({ id: "b", nodeId: "nB", label: "b", dnsName: "localhost", ...over });

test("LocalAPI: the StableID's own tailnet address, IPv4 first, whatever peers.json names it", async () => {
  withStatus([node("nB", ["fd7a:115c:a1e0::5", "100.64.0.5"]), node("nC", ["100.64.0.6"])]);
  assert.equal(await verifiedAddress(peer(), {}), "100.64.0.5", "dnsName localhost is never resolved");
  assert.equal(await verifiedAddress(peer({ dnsName: "100.64.0.6" }), {}), "100.64.0.5", "another node's address in the name is ignored");
});

test("LocalAPI: refused when the node is unknown, doubled, or has no tailnet address, or status fails", async () => {
  withStatus([node("nC", ["100.64.0.6"])]);
  assert.equal(await verifiedAddress(peer(), {}), null);
  withStatus([node("nB", ["100.64.0.5"]), node("nB", ["100.64.0.7"])]);
  assert.equal(await verifiedAddress(peer(), {}), null);
  withStatus([node("nB", ["127.0.0.1", "192.168.1.5", "8.8.8.8"])]);
  assert.equal(await verifiedAddress(peer(), {}), null);
  withStatus(new Error("tailscaled unreachable"));
  assert.equal(await verifiedAddress(peer(), {}), null);
  assert.equal(await verifiedAddress(peer({ nodeId: "" }), {}), null);
  setIdentity(localApiIdentity);
  clearDestinationCache();
});

test("address identity: only the tailnet literal pinned in peers.json; a name is refused", async () => {
  const env = { SOVA_MESH_IDENTITY: "addresses" };
  assert.equal(await verifiedAddress(peer({ dnsName: "100.64.0.9" }), env), "100.64.0.9");
  assert.equal(await verifiedAddress(peer({ dnsName: "phone.example.com" }), env), null);
  assert.equal(await verifiedAddress(peer({ dnsName: "127.0.0.1" }), env), null);
  assert.equal(await verifiedAddress(peer({ dnsName: "phone.example.com", url: "http://100.64.0.10:4801" }), env), "100.64.0.10");
});

test("address identity: a pinned address another peers.json entry also names is refused", async () => {
  const env = { SOVA_MESH_IDENTITY: "addresses" };
  const me = peer({ dnsName: "100.64.0.9" });
  const twin = peer({ id: "c", nodeId: "nC", dnsName: "phone.example.com", url: "http://100.64.0.9:4801" });
  assert.equal(await verifiedAddress(me, env, () => [me, twin]), null);
  assert.equal(await verifiedAddress(me, env, () => [me, peer({ id: "c", nodeId: "nC", dnsName: "100.64.0.10" })]), "100.64.0.9");
});
