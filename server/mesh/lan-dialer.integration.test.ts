// Run: node scripts/run-tests.mjs server/mesh/lan-dialer.integration.test.ts
// The dial-out host's RelayDialer against a real relay listener on loopback (§mesh.lan/dialer). Its
// backoff schedule alone: lan-dialer.test.ts.
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import { mintLanIdentity } from "./lan-cert";
import { LAN_PROFILE } from "./lan-admission";
import { type DialerStatus, RelayDialer, type RelayTarget } from "./lan-dialer";
import { RelayListener } from "./lan-relay";
import { connectReverse, type ReverseClient, serveReverse } from "./lan-reverse";

const relayId = mintLanIdentity();
const mac = mintLanIdentity();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A relay: on `answer` it runs the reverse client; on `ask` it answers from its own server. */
async function relay(paired = [mac]) {
  const clients: ReverseClient[] = [];
  const own = http.createServer((_req, res) => res.end("from the relay"));
  const l = new RelayListener({
    host: "127.0.0.1", port: 0, identity: relayId, profile: { ...LAN_PROFILE, failuresToBan: 1000 },
    onPeer: (sock, _p, ch) => {
      if (ch === "answer") void connectReverse(sock).then((c) => clients.push(c), () => {});
      else serveReverse(sock, (d) => own.emit("connection", d));
    },
  });
  await l.setPaired(paired.map((id, i) => ({ id: `h${i}`, label: `h${i}`, pin: id.pin })));
  return { l, clients, port: l.address()!.port };
}

const target = (port: number, over: Partial<RelayTarget> = {}): RelayTarget => ({ id: "r", label: "Relay", host: "127.0.0.1", port, pin: relayId.pin, ...over });

/** The dialer's clock, fixed: a status's retryAt is then exactly NOW plus the backoff. */
const NOW = 1_000_000;

function dialer(t: RelayTarget, statuses: DialerStatus[], id = mac) {
  const inner = http.createServer((_req, res) => res.end("from the LAN host"));
  return new RelayDialer({
    identity: id, relay: t, channel: "answer", random: () => 0, now: () => NOW,
    onStream: (d) => inner.emit("connection", d),
    onStatus: (s) => statuses.push(s),
  });
}

/** Poll with a generous hang guard: never a bound on how fast the dial goes. */
async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await sleep(20);
  }
}

function fetchVia(c: ReverseClient): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "lan-peer", path: "/", agent: c.agent }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.end();
  });
}

test("connects, answers the relay's requests, and reports connected", async () => {
  const r = await relay();
  const statuses: DialerStatus[] = [];
  const d = dialer(target(r.port), statuses);
  d.start();
  await until(() => d.status.state === "connected" && r.clients.length === 1);
  assert.equal(await fetchVia(r.clients[0]!), "from the LAN host");
  assert.deepEqual(statuses.map((s) => s.state), ["connecting", "connected"]);
  d.stop();
  await r.l.close();
});

test("stop ends the session at once and schedules nothing more", async () => {
  const r = await relay();
  const d = dialer(target(r.port), []);
  d.start();
  await until(() => r.clients.length === 1);
  d.stop();
  await r.clients[0]!.closed; // the relay's side ends: "at once" is that stop itself closed it
  assert.deepEqual(d.status, { state: "stopped" });
  // Nothing scheduled: no redial timer, and the ended session found itself stale (no retry).
  await sleep(0);
  assert.equal((d as unknown as { timer: unknown }).timer, null, "no redial timer after stop");
  assert.equal(r.clients.length, 1, "no new dial after stop");
  await r.l.close();
});

test("a lost connection is dialed again after the backoff", async () => {
  const r = await relay();
  const statuses: DialerStatus[] = [];
  const d = dialer(target(r.port), statuses);
  d.start();
  await until(() => r.clients.length === 1);
  r.clients[0]!.close();
  await until(() => d.status.state === "waiting");
  const w = d.status as Extract<DialerStatus, { state: "waiting" }>;
  assert.equal(w.reason, "closed");
  await until(() => r.clients.length === 2 && d.status.state === "connected");
  d.stop();
  await r.l.close();
});

test("failure reasons are fixed phrases, and no status names an address or pin", async () => {
  const closed = net.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));

  const r = await relay();
  const imposter = mintLanIdentity();
  const cases: [RelayTarget, string, typeof mac][] = [
    [target(deadPort), "refused", mac],
    [target(r.port, { pin: imposter.pin }), "relay's pin didn't match", mac],
    [target(r.port), "rejected by the relay", mintLanIdentity()], // a host the relay never paired
  ];
  const all: DialerStatus[] = [];
  for (const [t, want, id] of cases) {
    const statuses: DialerStatus[] = [];
    const d = dialer(t, statuses, id);
    d.start();
    await until(() => d.status.state === "waiting");
    d.stop();
    const w = statuses.find((s) => s.state === "waiting") as Extract<DialerStatus, { state: "waiting" }>;
    if (want === "rejected by the relay") assert.ok(["rejected by the relay", "closed"].includes(w.reason), w.reason);
    else assert.equal(w.reason, want);
    assert.equal(w.retryAt, NOW + 750, "the first backoff (random 0: 1 s less a quarter), from the dialer's clock");
    all.push(...statuses);
  }
  const text = JSON.stringify(all);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
  for (const pin of [mac.pin, relayId.pin, imposter.pin]) assert.ok(!text.includes(pin), "a pin in a status");
  await r.l.close();
});

test("the ask channel holds a client for the dial-out host's own requests, and drops it on stop", async () => {
  const r = await relay();
  const held: (ReverseClient | null)[] = [];
  const d = new RelayDialer({ identity: mac, relay: target(r.port), channel: "ask", random: () => 0, onClient: (c) => held.push(c) });
  d.start();
  await until(() => d.status.state === "connected" && held.length === 1);
  assert.equal(await fetchVia(held[0]!), "from the relay");
  d.stop();
  assert.equal(held.at(-1), null);
  await r.l.close();
});
