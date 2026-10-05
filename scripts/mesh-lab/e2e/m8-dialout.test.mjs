// M8 — dial-out pairings (§mesh/lan) between real Sova processes, with no tailnet on one side:
//   - `plain` (no Tailscale at all) is the DIAL-OUT HOST; the first lab host is its RELAY, listening
//     on its lab-network address (never a tailnet one, never every interface);
//   - pairing is two pasted fingerprints, one on each Mesh page; the relay listens only while it
//     accepts a pairing;
//   - both directions run, each through the answering host's peer gate and grants: the relay asks
//     on the `answer` channel, the dial-out host on the `ask` channel; presence by default;
//   - the relay's /peer proxy to the dial-out host returns hardened answers, and WebSockets ride a stream;
//   - a client with no certificate, or TLS 1.2, never gets an answer; a wrong pin is refused;
//   - the relay takes only a private address of its own (no public one; "internet" needs an accept process, M9);
//   - Stop Relaying ends both channels at once while the pairing stays, and relaying again lets it back;
//   - removing the pairing on either side ends the connections at once, and the relay stops listening.
//   scripts/mesh-lab/lab e2e m8-dialout      (takes the lab LOCK; leaves no pairing and no relay)
// No key, pin or fingerprint is printed: assertions compare them.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { curlFrom, dockerIp, exec, laptopFetch, requireLab, sh, SOVA_PORT, waitFor, wsFrom } from "./lib.mjs";
import { releaseLock, takeLock } from "./links-lib.mjs";

const RELAY_PORT = 4805;
let cfg;
let R; // the relay host
let relayIp = "";
const DIALER = "plain";

const send = (method, body) => ({ method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const lanOf = async (n) => (await laptopFetch(n, "/api/mesh/lan")).json();
const pairingOf = async (n, id) => (await lanOf(n)).pairings?.find((p) => p.id === id);
const bothUp = (p) => p?.channels.answer.state === "connected" && p?.channels.ask.state === "connected";
const sessionsRow = async (n, id) => (await (await laptopFetch(n, "/api/mesh/sessions")).json()).peers?.find((p) => p.id === id);
const meshRow = async (n, id) => (await (await laptopFetch(n, "/api/mesh")).json()).peers?.find((p) => p.id === id);
async function grant(host, peer, preset) {
  const res = await laptopFetch(host, "/api/mesh/access", send("PUT", { peer, grant: { preset } }));
  assert.equal(res.status, 200, `${host} grants ${peer} ${preset}: ${res.status}`);
}
/** A bare TLS attempt at the relay port from `node`; true when it got any HTTP answer. */
const tlsAnswered = (node, extra = "") => sh(node, `curl -sk -m 4 ${extra} -o /dev/null -w '%{http_code}' https://${relayIp}:${RELAY_PORT}/api/peer/hello`).out.replace(/^0+$/, "") !== "";
/** Whether anything accepts TCP at host:RELAY_PORT from `node` (a bare connect, no TLS). */
const portOpenAt = (node, host) =>
  exec(node, ["node", "-e", 'const s=require("net").connect(+process.argv[2],process.argv[1]);const o=(w)=>{console.log(w);process.exit(0)};s.setTimeout(3000,()=>o("closed"));s.on("connect",()=>o("open"));s.on("error",()=>o("closed"))', host, String(RELAY_PORT)]).out === "open";
const portOpen = (node) => portOpenAt(node, relayIp);

async function unpairAll() {
  for (const [host, id] of [[R, "laptop"], [DIALER, "relay"], [DIALER, "wrong"]]) {
    const res = await laptopFetch(host, `/api/mesh/lan/pairings/${id}`, { method: "DELETE" });
    await res.body?.cancel();
  }
  await (await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: null }))).body?.cancel();
}

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.plain, "M8 needs the plain host (lab up without --no-plain)");
  R = cfg.hosts[0];
  relayIp = dockerIp(R);
  assert.ok(relayIp, `${R}'s lab-network address`);
  await takeLock("m8-dialout");
  await unpairAll();
});

after(async () => {
  try {
    await unpairAll();
  } finally {
    releaseLock();
  }
});

describe("pairing", () => {
  let relayFp = "";
  let dialerFp = "";

  test("each side makes its key on request and shows only a fingerprint", async () => {
    relayFp = (await (await laptopFetch(R, "/api/mesh/lan/key", { method: "POST" })).json()).fingerprint;
    dialerFp = (await (await laptopFetch(DIALER, "/api/mesh/lan/key", { method: "POST" })).json()).fingerprint;
    for (const fp of [relayFp, dialerFp]) assert.match(fp, /^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
    assert.notEqual(relayFp, dialerFp);
    // Each key file is 0600 and never named on a page.
    for (const n of [R, DIALER]) assert.equal(sh(n, 'stat -c %a "$PI_CODING_AGENT_DIR/sova/lan-identity.json"').out, "600", `${n}'s key file`);
  });

  test("the relay takes only a local-network address of its own: no public address, no internet relay without an accept process", async () => {
    assert.match(relayIp, /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/, "the lab network is private (the relay must take its address)");
    for (const relay of [{ host: "203.0.113.7", port: RELAY_PORT }, { host: "0::", port: RELAY_PORT }]) {
      const res = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay }));
      assert.equal(res.status, 400, JSON.stringify(relay));
      await res.body?.cancel();
    }
    // This host has no accept process (no SOVA_RELAY_HANDOFF): an internet relay is refused (M9 runs one).
    const net = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: { host: relayIp, port: RELAY_PORT, exposure: "internet" } }));
    assert.equal(net.status, 409);
    assert.equal((await net.json()).error, "the accept process isn't running (SUDO.md §5)");
    assert.equal((await lanOf(R)).relay, undefined, "nothing saved");
    const dial = await laptopFetch(DIALER, "/api/mesh/lan/pairings", send("POST", { id: "public", role: "dial", pin: "0000-0000-0000-0000-0000-0000-0000-0001", host: "198.51.100.7", port: RELAY_PORT }));
    assert.equal(dial.status, 400, "a dial-out host never pairs a public relay address");
    await dial.body?.cancel();
  });

  test("the relay listens only once a dial-out host is paired, and only on its one address", async () => {
    const set = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: { host: relayIp, port: RELAY_PORT } }));
    assert.equal(set.status, 200);
    assert.equal((await set.json()).relay.listening, false);
    assert.equal(portOpen(DIALER), false, "no listener before a pairing");
    const paired = await laptopFetch(R, "/api/mesh/lan/pairings", send("POST", { id: "laptop", label: "Laptop", role: "accept", pin: dialerFp }));
    assert.equal(paired.status, 200, await paired.text());
    await waitFor(async () => (await lanOf(R)).relay?.listening, { what: "the relay to listen" });
    assert.equal(portOpen(DIALER), true, "reachable on the lab network");
    assert.equal(portOpenAt(R, "127.0.0.1"), false, "not on loopback: one address only");
  });

  test("a client with no certificate, or offering TLS 1.2, never gets an HTTP answer", async () => {
    const other = cfg.hosts[1];
    assert.equal(tlsAnswered(other), false, "no client certificate");
    assert.equal(tlsAnswered(other, "--tls-max 1.2"), false, "TLS 1.2");
  });

  test("the dial-out host pairs the relay and both channels come up", async () => {
    const paired = await laptopFetch(DIALER, "/api/mesh/lan/pairings", send("POST", { id: "relay", label: "Relay", role: "dial", pin: relayFp, host: relayIp, port: RELAY_PORT }));
    assert.equal(paired.status, 200, await paired.text());
    await waitFor(async () => bothUp(await pairingOf(DIALER, "relay")), { what: "plain's two channels", timeoutMs: 30000 });
    await waitFor(async () => bothUp(await pairingOf(R, "laptop")), { what: "the relay's view of both channels" });
    // A new pairing gets presence on both sides.
    for (const [n, id] of [[R, "laptop"], [DIALER, "relay"]]) {
      const view = await (await laptopFetch(n, "/api/mesh/access")).json();
      assert.equal(view.peers.find((p) => p.id === id)?.grant?.preset, "presence", `${n}'s grant to ${id}`);
    }
  });
});

describe("both directions, each under the answering host's grant", () => {
  test("presence: each sees the other up, and neither's sessions", async () => {
    await waitFor(async () => (await meshRow(R, "laptop"))?.state === "up" || (await meshRow(R, "laptop"))?.state === "skewed", { what: "the relay sees plain" });
    await waitFor(async () => ["up", "skewed"].includes((await meshRow(DIALER, "relay"))?.state), { what: "plain sees the relay" });
    assert.equal((await sessionsRow(R, "laptop"))?.state, "hidden");
    assert.equal((await sessionsRow(DIALER, "relay"))?.state, "hidden");
  });

  test("the dial-out host grants sessions: the relay lists them and reaches them through its proxy, hardened", async () => {
    await grant(DIALER, "relay", "sessions");
    await waitFor(async () => (await sessionsRow(R, "laptop"))?.state === "up", { what: "plain's sessions on the relay" });
    const res = curlFrom(R, `http://127.0.0.1:${SOVA_PORT}/peer/laptop/api/sessions`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
    assert.match(res.headers["content-security-policy"] ?? "", /sandbox/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    const ws = wsFrom(R, `ws://127.0.0.1:${SOVA_PORT}/peer/laptop/ws/watch?feed=sessions`, { holdMs: 2500 });
    assert.equal(ws.opened, true, `the socket over a stream: ${JSON.stringify(ws)}`);
    // The relay still sees nothing more than it was granted.
    assert.equal((await sessionsRow(DIALER, "relay"))?.state, "hidden", "grants are per direction");
  });

  test("the relay grants sessions: the dial-out host's own calls reach the relay", async () => {
    await grant(R, "laptop", "sessions");
    await waitFor(async () => (await sessionsRow(DIALER, "relay"))?.state === "up", { what: "the relay's sessions on plain" });
  });

  test("lowering a grant takes effect on the next call", async () => {
    await grant(R, "laptop", "none");
    await waitFor(async () => (await sessionsRow(DIALER, "relay"))?.state === "hidden", { what: "the relay hidden again" });
    await waitFor(async () => (await meshRow(DIALER, "relay"))?.state === "hidden", { what: "hello denied too" });
  });
});

describe("refusal and removal", () => {
  test("a relay pinned with the wrong fingerprint is refused, and named so", async () => {
    const wrongFp = (await lanOf(cfg.hosts[1] ?? R)).fingerprint ?? "0000-0000-0000-0000-0000-0000-0000-0001";
    const res = await laptopFetch(DIALER, "/api/mesh/lan/pairings", send("POST", { id: "wrong", role: "dial", pin: wrongFp, host: relayIp, port: RELAY_PORT }));
    assert.equal(res.status, 200, await res.text());
    const p = await waitFor(async () => {
      const w = await pairingOf(DIALER, "wrong");
      return w?.channels.ask.state === "waiting" ? w : null;
    }, { what: "the wrong pin's refusal" });
    assert.match(p.channels.ask.reason, /pin didn't match|rejected|closed/);
    await (await laptopFetch(DIALER, "/api/mesh/lan/pairings/wrong", { method: "DELETE" })).body?.cancel();
    // The real pairing is untouched.
    assert.ok(bothUp(await pairingOf(DIALER, "relay")));
  });

  test("Stop Relaying ends both channels at once though the pairing stays; relaying again lets plain back in", async () => {
    assert.ok(bothUp(await pairingOf(DIALER, "relay")), "both channels up before");
    const t0 = Date.now();
    const stop = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: null }));
    assert.equal(stop.status, 200);
    await stop.body?.cancel();
    const relaySide = await pairingOf(R, "laptop");
    assert.ok(relaySide, "still paired on the relay");
    await waitFor(async () => {
      const p = await pairingOf(R, "laptop");
      return p?.channels.answer.state === "not connected" && p?.channels.ask.state === "not connected";
    }, { what: "the relay to drop both channels", timeoutMs: 1000 });
    await waitFor(async () => {
      const p = await pairingOf(DIALER, "relay");
      return p && p.channels.answer.state !== "connected" && p.channels.ask.state !== "connected";
    }, { what: "plain to see both channels end", timeoutMs: 3000 });
    console.log(`  both channels ended ${Date.now() - t0} ms after Stop Relaying`);
    assert.equal(portOpen(DIALER), false, "the port is closed");
    const back = await laptopFetch(R, "/api/mesh/lan/relay", send("PUT", { relay: { host: relayIp, port: RELAY_PORT } }));
    assert.equal(back.status, 200);
    await back.body?.cancel();
    await waitFor(async () => bothUp(await pairingOf(DIALER, "relay")), { what: "plain back on both channels", timeoutMs: 70000 });
  });

  test("the relay removes the pairing: plain's connections end at once and the port closes", async () => {
    const t0 = Date.now();
    const res = await laptopFetch(R, "/api/mesh/lan/pairings/laptop", { method: "DELETE" });
    assert.equal(res.status, 200);
    await waitFor(async () => (await pairingOf(DIALER, "relay"))?.channels.ask.state !== "connected", { what: "plain to lose its channel", timeoutMs: 5000 });
    assert.ok(Date.now() - t0 < 5000);
    await waitFor(async () => (await lanOf(R)).relay?.listening === false, { what: "the relay to stop listening" });
    assert.equal(portOpen(DIALER), false);
    const view = await (await laptopFetch(R, "/api/mesh/access")).json();
    assert.equal(view.peers.some((p) => p.id === "laptop"), false, "its grant went with it");
  });

  test("the dial-out host removes its relay: nothing dials any more", async () => {
    await (await laptopFetch(DIALER, "/api/mesh/lan/pairings/relay", { method: "DELETE" })).body?.cancel();
    assert.deepEqual((await lanOf(DIALER)).pairings, []);
  });
});
