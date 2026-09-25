// M1 — peers.json + hello + the whois gate, on real tailscaled/Headscale:
// paired hosts see each other up; a tailnet node not in peers.json is refused (403); a non-tailnet
// caller never reaches the peer listener; a peer never reaches /api/mesh/* or /peer/* through it;
// the /peer/<id> proxy works and reports a down peer as 502; unpairing turns the mesh fully off.
//   scripts/mesh-lab/lab e2e m1          (leaves the lab paired a,b,c at the end)
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chaos, curlFrom, dockerIp, laptopFetch, lab, magicName, nodeId, PEER_PORT, requireLab, sh, tailnetIp, waitFor, wsFrom } from "./lib.mjs";

let cfg;
let A, B, C;
const meshOf = async (n) => (await laptopFetch(n, "/api/mesh")).json();
const peerState = async (n, id) => (await meshOf(n)).peers?.find((p) => p.id === id)?.state;
const listening = (n) => sh(n, `ss -ltn | grep -q ':${PEER_PORT} '`).code === 0;

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.hosts.length >= 3, "M1 needs 3 hosts (lab up --hosts 3)");
  [A, B, C] = cfg.hosts;
  lab("pair", cfg.hosts.join(","));
  for (const h of cfg.hosts)
    for (const p of cfg.hosts) if (p !== h) await waitFor(async () => (await peerState(h, p)) === "up", { timeoutMs: 60000, what: `${h} sees ${p} up` });
});

after(() => {
  // leave the lab in the paired shape the next milestone expects
  lab("pair", cfg.hosts.join(","));
});

describe("paired hosts", () => {
  test("every host's mesh is on, its peer listener bound to its tailnet addresses only", async () => {
    for (const h of cfg.hosts) {
      const m = await meshOf(h);
      assert.equal(m.enabled, true);
      assert.equal(m.self.id, h);
      assert.equal(m.self.nodeId, nodeId(h));
      assert.ok(m.self.listen.addresses.includes(tailnetIp(h)), `${h} listens on ${tailnetIp(h)}`);
      assert.ok(!m.self.listen.addresses.some((a) => a === "0.0.0.0" || a === "::" || a.startsWith("127.") || a === dockerIp(h)), `${h}: ${m.self.listen.addresses}`);
      assert.equal(m.self.listen.port, PEER_PORT);
    }
  });

  test("a peer's hello over the peer listener names the host", () => {
    const r = curlFrom(B, `http://${magicName(A)}:${PEER_PORT}/api/peer/hello`);
    assert.equal(r.status, 200);
    assert.equal(r.json.id, A);
    assert.equal(r.json.nodeId, nodeId(A));
  });

  test("a peer reaches ordinary /api/* routes, never /api/mesh/*, /peer/* or static files", () => {
    const base = `http://${magicName(A)}:${PEER_PORT}`;
    assert.equal(curlFrom(B, `${base}/api/health`).json?.ok, true);
    assert.ok(Array.isArray(curlFrom(B, `${base}/api/sessions`).json));
    for (const path of ["/api/mesh", "/api/mesh/hello", "/api/mesh/peers", `/peer/${C}/api/health`, "/", "/index.html"])
      assert.equal(curlFrom(B, base + path).status, 404, path);
  });
});

describe("refusals", () => {
  test("a tailnet node that is in nobody's peers.json gets 403 on every path and on WS", () => {
    if (!cfg.stranger) return;
    const base = `http://${magicName(A)}:${PEER_PORT}`;
    for (const path of ["/api/peer/hello", "/api/health", "/api/sessions"]) {
      const r = curlFrom("stranger", base + path);
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.json, { error: "not a peer" });
      assert.equal(r.headers["x-sova-mesh"], "refused");
    }
    const up = curlFrom("stranger", `${base}/ws/watch`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    assert.equal(up.status, 403, "WS upgrade refused before the handshake");
  });

  test("a non-tailnet caller never reaches a peer listener", () => {
    if (!cfg.plain) return;
    // the docker address: nothing listens there
    assert.equal(curlFrom("plain", `http://${dockerIp(A)}:${PEER_PORT}/api/peer/hello`, { timeoutS: 3 }).status, 0);
    // the tailnet address is not routable from outside the tailnet
    assert.equal(curlFrom("plain", `http://${tailnetIp(A)}:${PEER_PORT}/api/peer/hello`, { timeoutS: 3 }).status, 0);
  });

  test("a host dropped from one side's peers.json is refused by that side and reported so by the other", async () => {
    lab("pair", `${A},${B}`); // A and B list each other only; C still lists A and B
    try {
      const r = curlFrom(C, `http://${magicName(A)}:${PEER_PORT}/api/peer/hello`);
      assert.equal(r.status, 403);
      assert.equal(r.headers["x-sova-mesh"], "refused");
      await waitFor(async () => (await peerState(C, A)) === "refused", { timeoutMs: 30000, what: `${C} reports ${A} refused` });
      assert.equal((await meshOf(A)).peers.some((p) => p.id === C), false);
    } finally {
      lab("pair", cfg.hosts.join(","));
    }
    await waitFor(async () => (await peerState(C, A)) === "up", { timeoutMs: 60000, what: `${C} sees ${A} up again` });
  });
});

describe("proxy", () => {
  test("/peer/<id>/api/* answers with the peer's data; an unknown id is 404", async () => {
    const res = await laptopFetch(A, `/peer/${B}/api/sessions`);
    assert.equal(res.status, 200);
    const list = await res.json();
    if (cfg.seed) assert.ok(list.some((s) => s.title === `fixture session on lab host ${B}`), "B's fixture through A");
    const unknown = await laptopFetch(A, "/peer/nosuchpeer/api/health");
    assert.equal(unknown.status, 404);
  });

  test("/peer/<id>/ws/* reaches the peer's WS endpoint", () => {
    const r = wsFrom(A, `ws://127.0.0.1:4800/peer/${B}/ws/watch`, { holdMs: 1500 });
    assert.ok(r.opened || (r.closeCode >= 4000 && r.closeCode !== 4422), JSON.stringify(r));
  });

  test("a peer whose Sova is down is reported down (502), never 4422, and comes back", async () => {
    chaos.sovaStop(B);
    try {
      await waitFor(async () => (await peerState(A, B)) === "down", { timeoutMs: 30000, what: `${A} sees ${B} down` });
      assert.equal((await laptopFetch(A, `/peer/${B}/api/health`)).status, 502);
      const ws = wsFrom(A, `ws://127.0.0.1:4800/peer/${B}/ws/watch`, { holdMs: 1500 });
      assert.notEqual(ws.closeCode, 4422, JSON.stringify(ws));
      assert.equal(ws.opened, false);
      assert.equal((await laptopFetch(A, "/api/health")).status, 200, "A itself unaffected");
    } finally {
      chaos.sovaStart(B);
    }
    await waitFor(async () => (await peerState(A, B)) === "up", { timeoutMs: 60000, what: `${A} sees ${B} up again` });
  });

  test("a killed peer container is reported down", async () => {
    chaos.kill(C);
    try {
      await waitFor(async () => (await peerState(A, C)) === "down", { timeoutMs: 30000, what: `${A} sees ${C} down` });
      // A dead container's address blackholes (no RST): the proxy's answer waits for its dial
      // timeout. Measured 10.5 s on 2026-09-25; the bound here only catches a hang.
      const t0 = Date.now();
      assert.equal((await laptopFetch(A, `/peer/${C}/api/health`, { timeoutMs: 30000 })).status, 502);
      console.log(`# /peer/${C} on a killed peer answered 502 after ${Date.now() - t0} ms`);
    } finally {
      chaos.start(C);
    }
    await waitFor(async () => (await peerState(A, C)) === "up", { timeoutMs: 120000, what: `${A} sees ${C} up again` });
  });
});

describe("mesh off", () => {
  test("the plain host (no tailscale, no peers.json) reports the mesh off", async () => {
    if (!cfg.plain) return;
    const m = await meshOf("plain");
    assert.equal(m.enabled, false);
    assert.deepEqual(m.peers, []);
  });

  test("unpairing turns the mesh off: no peer listener, /peer/* falls through", async () => {
    lab("unpair", A);
    try {
      assert.equal((await meshOf(A)).enabled, false);
      assert.equal(listening(A), false, "nothing on the peer port");
      assert.equal(curlFrom(B, `http://${magicName(A)}:${PEER_PORT}/api/peer/hello`, { timeoutS: 3 }).status, 0);
      const r = await laptopFetch(A, `/peer/${B}/api/health`);
      assert.notEqual(r.status, 502, "no proxy when off");
    } finally {
      lab("pair", cfg.hosts.join(","));
    }
  });
});
