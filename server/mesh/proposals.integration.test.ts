// §mesh.lan/proposals end to end in one process: this server, an extension's key (a stand-in key check) proposing
// through the real gate, the person's page confirming, and a stand-in dial-out host built from Sova's own transport
// connecting to the pairing that confirm made. The page hears each change on the session feed, and a page that
// connects is sent the waiting proposals only while any wait. The store's rules and the doors: proposals.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { LanStatus } from "../../shared/mesh-lan";
import type { MeshProposal } from "../../shared/mesh-proposals";

const tmp = mkdtempSync(join(tmpdir(), "sova-proposals-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({ status: async () => Promise.reject(new Error("no tailscale here")), whois: async () => null });
const { server } = await import("../index");
const { stopMesh } = await import("./index");
const { AUTH_COOKIE, sovaToken, setExtensionKeyCheck } = await import("../auth");
const { mintLanIdentity, parsePin } = await import("./lan-cert");
const { RelayDialer } = await import("./lan-dialer");

setExtensionKeyCheck({ isKey: (v: string) => v === "ext-key", idOf: (v: string) => (v === "ext-key" ? "company" : null), socket() {} } as never);

const PAGE = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
const KEY = { "x-sova-token": "ext-key" };
let base = "";
const api = async <T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<[number, T]> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return [res.status, (await res.json()) as T];
};
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** A page on the session feed, keeping each mesh_proposals frame it is sent. */
async function page() {
  const frames: MeshProposal[][] = [];
  let joined = false;
  const sock = new WebSocket(`${base.replace(/^http/, "ws")}/ws/watch?feed=sessions`, { headers: PAGE });
  sock.on("message", (data) => {
    const msg = JSON.parse(String(data)) as { type: string; full?: boolean; proposals?: MeshProposal[] };
    if (msg.type === "marks" && msg.full) joined = true;
    if (msg.type === "mesh_proposals") frames.push(msg.proposals!);
  });
  await until("the feed's join", () => joined);
  return { frames, close: () => sock.close() };
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  stopMesh();
  server.close();
  server.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

test("an extension proposes, the person confirms, a computer links, and the extension removes it with no click", async () => {
  const quiet = await page();
  // No proposal yet: the feed said nothing of them, and no file was made.
  assert.deepEqual(quiet.frames, []);
  assert.equal(existsSync(join(tmp, "agent", "sova", "mesh-proposals.json")), false);

  const [, key] = await api<{ fingerprint: string }>("POST", "/api/mesh/proposals", KEY, { kind: "key" });
  const ownPin = parsePin(key.fingerprint)!;
  assert.ok(ownPin, "the key's answer gives this computer's fingerprint");

  const other = mintLanIdentity();
  const port = await freePort();
  const [s, made] = await api<{ proposal: MeshProposal }>("POST", "/api/mesh/proposals", KEY, {
    kind: "pair",
    role: "accept",
    peer: "co-laptop",
    label: "Omar (laptop)",
    fingerprint: other.pin,
    grant: "sessions",
    relay: { host: "127.0.0.1", port },
    why: "Omar signed in as omar and an approver approved him.",
  });
  assert.equal(s, 200, JSON.stringify(made));
  const p = made.proposal;
  assert.equal(p.state, "waiting");
  await until("the open page hears it", () => quiet.frames.at(-1)?.[0]?.id === p.id);
  const late = await page();
  assert.deepEqual(late.frames.map((f) => f.map((x) => x.id)), [[p.id]], "a page that connects while it waits is sent it");
  let lan = (await api<LanStatus>("GET", "/api/mesh/lan", KEY))[1];
  assert.equal(lan.pairings.length, 0, "nothing paired before the click");
  assert.equal(lan.relay, undefined, "and no relay set");

  const [cs, confirmed] = await api<{ proposal: MeshProposal }>("POST", `/api/mesh/proposals/${p.id}/confirm`, PAGE, {});
  assert.equal(cs, 200, JSON.stringify(confirmed));
  assert.equal(confirmed.proposal.state, "applied");
  await until("every page's dialog closes", () => quiet.frames.at(-1)?.length === 0 && late.frames.at(-1)?.length === 0);
  lan = (await api<LanStatus>("GET", "/api/mesh/lan", KEY))[1];
  assert.deepEqual(lan.pairings.map((x) => [x.id, x.role]), [["co-laptop", "accept"]]);
  const [, access] = await api<{ peers: Array<{ id: string; grant?: { preset: string } }> }>("GET", "/api/mesh/access", PAGE);
  assert.equal(access.peers.find((x) => x.id === "co-laptop")?.grant?.preset, "sessions");
  const [, mine] = await api<{ links: Array<{ peer: string; grant: string }> }>("GET", "/api/mesh/proposals", KEY);
  assert.deepEqual(mine.links.map((l) => [l.peer, l.grant]), [["co-laptop", "sessions"]]);

  // The other computer dials the relay the confirm set, and is let in on both channels.
  await until("the relay listens", async () => (await api<LanStatus>("GET", "/api/mesh/lan", KEY))[1].relay?.listening === true);
  const target = { id: "relay", label: "Relay", host: "127.0.0.1", port, pin: ownPin };
  const answer = new RelayDialer({ identity: other, relay: target, channel: "answer", onStream: (d) => d.destroy() });
  const ask = new RelayDialer({ identity: other, relay: target, channel: "ask", onClient: () => {} });
  answer.start();
  ask.start();
  try {
    await until("both channels", async () => {
      const x = (await api<LanStatus>("GET", "/api/mesh/lan", KEY))[1].pairings.find((y) => y.id === "co-laptop");
      return x?.channels.answer.state === "connected" && x.channels.ask.state === "connected";
    });

    // Narrowing applies at once; removing too: the pairing, its grant and its connections go.
    const [, narrowed] = await api<{ proposal: MeshProposal }>("POST", "/api/mesh/proposals", KEY, { kind: "grant", peer: "co-laptop", grant: "presence" });
    assert.equal(narrowed.proposal.state, "applied");
    const [, gone] = await api<{ proposal: MeshProposal }>("POST", "/api/mesh/proposals", KEY, { kind: "unpair", peer: "co-laptop" });
    assert.equal(gone.proposal.state, "applied");
    lan = (await api<LanStatus>("GET", "/api/mesh/lan", KEY))[1];
    assert.deepEqual(lan.pairings, []);
    assert.equal(lan.relay?.listening, false, "no pairing accepted, so nothing listens");
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, "agent", "sova", "mesh-proposals.json"), "utf8")).links, {});
  } finally {
    answer.stop();
    ask.stop();
    quiet.close();
    late.close();
  }
});

test("a link removed on the Mesh page and paired again there by hand, same id and fingerprint, is no longer the extension's", async () => {
  const other = mintLanIdentity();
  const pairing = { id: "co-again", label: "Again", role: "accept", pin: other.pin };
  // The extension's link, confirmed by the person.
  const [, made] = await api<{ proposal: MeshProposal }>("POST", "/api/mesh/proposals", KEY, { kind: "pair", role: "accept", peer: pairing.id, fingerprint: other.pin, grant: "presence" });
  assert.equal((await api<{ proposal: MeshProposal }>("POST", `/api/mesh/proposals/${made.proposal.id}/confirm`, PAGE, {}))[0], 200);
  // Removed by hand on the Mesh page, then paired again by hand: same id, same fingerprint. Nothing reads in between.
  assert.equal((await api("DELETE", `/api/mesh/lan/pairings/${pairing.id}`, PAGE))[0], 200);
  const [s] = await api("POST", "/api/mesh/lan/pairings", PAGE, pairing);
  assert.equal(s, 200);
  // The extension can neither remove nor change it, and it stays.
  const [us, unpair] = await api<{ error?: string; proposal?: MeshProposal }>("POST", "/api/mesh/proposals", KEY, { kind: "unpair", peer: pairing.id });
  assert.equal(us, 403, JSON.stringify(unpair));
  const [gs] = await api("POST", "/api/mesh/proposals", KEY, { kind: "grant", peer: pairing.id, grant: "none" });
  assert.equal(gs, 403);
  const lan = (await api<LanStatus>("GET", "/api/mesh/lan", KEY))[1];
  assert.deepEqual(lan.pairings.map((x) => x.id), [pairing.id], "the hand-made link stays");
  const [, mine] = await api<{ links: Array<{ peer: string }> }>("GET", "/api/mesh/proposals", KEY);
  assert.deepEqual(mine.links, [], "and isn't listed as the extension's");
  await api("DELETE", `/api/mesh/lan/pairings/${pairing.id}`, PAGE);
});
