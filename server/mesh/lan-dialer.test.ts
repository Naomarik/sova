import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import { mintLanIdentity } from "./lan-cert";
import { LAN_PROFILE } from "./lan-admission";
import { Backoff, type DialerStatus, RelayDialer, type RelayTarget } from "./lan-dialer";
import { RelayListener } from "./lan-relay";
import { connectReverse, type ReverseClient } from "./lan-reverse";

const relayId = mintLanIdentity();
const mac = mintLanIdentity();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Backoff: 1 s doubling to 60 s, jittered by a quarter either way, reset to 1 s", () => {
  const mid = new Backoff(() => 0.5);
  assert.deepEqual(Array.from({ length: 9 }, () => mid.next()), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  mid.reset();
  assert.equal(mid.next(), 1000);
  assert.equal(new Backoff(() => 0).next(), 750);
  assert.equal(new Backoff(() => 0.999999).next(), 1250);
  const low = new Backoff(() => 0);
  for (let i = 0; i < 40; i++) low.next();
  assert.equal(low.next(), 45000, "never past 60 s, even jittered");
});

/** A relay that runs the reverse client for each paired host and serves nothing else. */
async function relay(paired = [mac]) {
  const clients: ReverseClient[] = [];
  const l = new RelayListener({
    host: "127.0.0.1", port: 0, identity: relayId, profile: { ...LAN_PROFILE, failuresToBan: 1000 },
    onPeer: (sock) => void connectReverse(sock).then((c) => clients.push(c), () => {}),
  });
  await l.setPaired(paired.map((id, i) => ({ id: `h${i}`, label: `h${i}`, certPem: id.certPem, pin: id.pin })));
  return { l, clients, port: l.address()!.port };
}

const target = (port: number, over: Partial<RelayTarget> = {}): RelayTarget => ({ id: "r", label: "Relay", host: "127.0.0.1", port, certPem: relayId.certPem, pin: relayId.pin, ...over });

function dialer(t: RelayTarget, statuses: DialerStatus[], id = mac) {
  const inner = http.createServer((_req, res) => res.end("from the LAN host"));
  return new RelayDialer({
    identity: id, relay: t, random: () => 0,
    onStream: (d) => inner.emit("connection", d),
    onStatus: (s) => statuses.push(s),
  });
}

async function until(pred: () => boolean, ms = 4000): Promise<void> {
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
  await Promise.race([r.clients[0]!.closed, sleep(1500).then(() => assert.fail("relay still holds the session"))]);
  assert.deepEqual(d.status, { state: "stopped" });
  await sleep(1200);
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
  await until(() => r.clients.length === 2 && d.status.state === "connected", 3000);
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
    [target(r.port, { certPem: imposter.certPem, pin: imposter.pin }), "relay's pin didn't match", mac],
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
    assert.ok(w.retryAt > Date.now() - 1000);
    all.push(...statuses);
  }
  const text = JSON.stringify(all);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
  for (const pin of [mac.pin, relayId.pin, imposter.pin]) assert.ok(!text.includes(pin), "a pin in a status");
  await r.l.close();
});
