// M7 — per-peer grants (§mesh.peers/grants) on real tailscaled/Headscale and real whois, three hosts:
//   - no mesh-access.json anywhere: every peer has everything, as before grants;
//   - A grants B `none`: B's calls to A are 403 X-Sova-Mesh: denied (hello included), B shows A
//     `hidden` with no session rows, C still sees and reads A, A still sees B (grants are per
//     direction), a stranger is still `refused`, B can't change A's grants, and lowering the grant
//     cuts B's open socket on A;
//   - per-login sync: A shares only one of two API keys with C, so C gets that one alone. B, which A
//     grants nothing, still gets it through C on C's next exchange (sync replicates host to host, at
//     its 5-minute reconcile, a peer-up or a settings save; here a settings save), never the other.
//   scripts/mesh-lab/lab e2e m7-grants      (takes the lab LOCK; leaves a,b,c paired with no grants)
// Keys are lab-only values compared by sha256; no secret is ever printed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { curlFrom, exec, execBackground, lab, laptopFetch, magicName, PEER_PORT, readAgentFile, requireLab, sh, waitFor } from "./lib.mjs";
import { releaseLock, takeLock } from "./links-lib.mjs";

let cfg;
let A, B, C;
const ACCESS = "sova/mesh-access.json";
const json = (body) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const meshOf = async (n) => (await laptopFetch(n, "/api/mesh")).json();
const peerState = async (n, id) => (await meshOf(n)).peers?.find((p) => p.id === id)?.state;
const sessionsRow = async (n, id) => (await (await laptopFetch(n, "/api/mesh/sessions")).json()).peers?.find((p) => p.id === id);
/** A's grant to `peer`, set from A's own page (its laptop port is its main listener: the operator). */
async function grant(host, peer, g) {
  const res = await laptopFetch(host, "/api/mesh/access", json({ peer, grant: g }));
  assert.equal(res.status, 200, `${host} grants ${peer} ${JSON.stringify(g)}: ${res.status}`);
  return res.json();
}
const peerUrl = (host, path) => `http://${magicName(host)}:${PEER_PORT}${path}`;

/** In-host AuthStorage call, the way pi itself writes auth.json (m3's helper). */
function authOp(n, op, provider, key) {
  const script = `
import { join } from "node:path";
const pi = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AuthStorage } = await import(new URL("core/auth-storage.js", pi).href);
const s = AuthStorage.create(join(process.env.PI_CODING_AGENT_DIR, "auth.json"));
const [op, provider, key] = process.argv.slice(2);
if (op === "set") await s.modify(provider, async () => ({ type: "api_key", key }));
else await s.delete(provider);`;
  const r = exec(n, ["sh", "-c", 'cd /sova && node --input-type=module - "$@"', "-", op, provider, key ?? ""], { input: script });
  assert.equal(r.code, 0, `${n} ${op} ${provider}: ${r.err}`);
}
const entrySha = (n, provider) =>
  exec(n, ["node", "-e", `const d=JSON.parse(require("fs").readFileSync(process.env.PI_CODING_AGENT_DIR+"/auth.json","utf8"));const e=d[process.argv[1]];console.log(e?require("crypto").createHash("sha256").update(String(e.key)).digest("hex"):"absent")`, provider]).out;

/** Every host's grants removed: the lab as the other milestones expect it. */
async function clearGrants() {
  for (const h of cfg.hosts) sh(h, `rm -f "$PI_CODING_AGENT_DIR/${ACCESS}"`);
}

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.hosts.length >= 3, "M7 needs 3 hosts (lab up --hosts 3)");
  [A, B, C] = cfg.hosts;
  await takeLock("m7-grants");
  await clearGrants();
  lab("pair", cfg.hosts.join(","));
  for (const h of cfg.hosts)
    for (const p of cfg.hosts) if (p !== h) await waitFor(async () => (await peerState(h, p)) === "up", { timeoutMs: 60000, what: `${h} sees ${p} up` });
});

after(async () => {
  try {
    await clearGrants();
    for (const p of ["lab-m7-keep", "lab-m7-held"]) for (const h of cfg.hosts) authOp(h, "delete", p);
    lab("pair", cfg.hosts.join(","));
  } finally {
    releaseLock();
  }
});

describe("no mesh-access.json: exactly as before grants", () => {
  test("no host has the file, and a peer reaches hello, sessions and sync", async () => {
    for (const h of cfg.hosts) assert.equal(readAgentFile(h, ACCESS), null, `${h} has no ${ACCESS}`);
    assert.equal(curlFrom(B, peerUrl(A, "/api/peer/hello")).status, 200);
    assert.ok(Array.isArray(curlFrom(B, peerUrl(A, "/api/sessions")).json));
    assert.equal(curlFrom(B, peerUrl(A, "/api/peer/sync/manifest")).status, 200);
    const view = await (await laptopFetch(A, "/api/mesh/access")).json();
    assert.equal(view.exists, false);
    assert.ok(view.peers.every((p) => Object.values(p.effective).every(Boolean)));
  });
});

describe("A grants B none", () => {
  before(async () => {
    await grant(A, B, { preset: "none" });
  });

  test("the file is A's alone: 0600, keyed by B's node, peers.json untouched", () => {
    const mode = sh(A, `stat -c %a "$PI_CODING_AGENT_DIR/${ACCESS}"`).out;
    assert.equal(mode, "600");
    const doc = JSON.parse(readAgentFile(A, ACCESS));
    const bNode = JSON.parse(readAgentFile(A, "sova/peers.json")).peers.find((p) => p.id === B).nodeId;
    assert.deepEqual(doc.peers[bNode], { preset: "none" });
    for (const h of [B, C]) assert.equal(readAgentFile(h, ACCESS), null, `${h} got no copy of A's grants`);
  });

  test("B's every call to A is denied, hello included: X-Sova-Mesh: denied, never refused", () => {
    for (const path of ["/api/peer/hello", "/api/peer/details", "/api/sessions", "/api/peer/sync/manifest", "/api/peer/credentials/manifest", "/api/peer/claude-pool/doc"]) {
      const r = curlFrom(B, peerUrl(A, path));
      assert.equal(r.status, 403, `${path} -> ${r.status}`);
      assert.equal(r.headers["x-sova-mesh"], "denied", path);
    }
    const ws = curlFrom(B, peerUrl(A, "/ws/watch?feed=sessions"), { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    assert.equal(ws.status, 403);
    assert.equal(ws.headers["x-sova-mesh"], "denied");
  });

  test("a stranger is still refused, not denied", () => {
    const r = curlFrom("stranger", peerUrl(A, "/api/peer/hello"));
    assert.equal(r.status, 403);
    assert.equal(r.headers["x-sova-mesh"], "refused");
  });

  test("B shows A hidden: not down, not refused, and no session rows", async () => {
    await waitFor(async () => (await peerState(B, A)) === "hidden", { timeoutMs: 30000, what: `${B} sees ${A} hidden` });
    const row = await sessionsRow(B, A);
    assert.equal(row.state, "hidden");
    assert.equal(row.sessions, undefined);
    // A browser on B's page reaching A through B's proxy is held to A's grant to B.
    const proxied = await laptopFetch(B, `/peer/${A}/api/sessions`);
    assert.equal(proxied.status, 403);
    assert.equal(proxied.headers.get("x-sova-mesh"), "denied");
  });

  test("C, which A doesn't restrict, still sees and reads A; and A still sees B (grants are per direction)", async () => {
    assert.equal(await peerState(C, A), "up");
    assert.equal((await sessionsRow(C, A)).state, "up");
    assert.equal(await peerState(A, B), "up");
    assert.equal((await sessionsRow(A, B)).state, "up");
  });

  test("B can't change A's grants: /api/mesh/access is never on the peer listener or the proxy", async () => {
    const before = readAgentFile(A, ACCESS);
    assert.equal(curlFrom(B, peerUrl(A, "/api/mesh/access"), { method: "PUT", body: { peer: B, grant: { preset: "full" } } }).status, 404);
    assert.equal((await laptopFetch(B, `/peer/${A}/api/mesh/access`, json({ peer: B, grant: { preset: "full" } }))).status, 404);
    assert.equal(readAgentFile(A, ACCESS), before);
  });

  test("lowering a grant cuts B's open socket on A at once", async () => {
    await grant(A, B, { preset: "full" });
    const list = JSON.parse(curlFrom(B, peerUrl(A, "/api/sessions")).body || "[]");
    const path = list[0]?.path;
    assert.ok(path, "A has a session to watch");
    const holder = execBackground(B, ["node", "-e", `
const t0 = Date.now(); const ws = new WebSocket(process.argv[1]);
ws.onopen = () => console.log(JSON.stringify({ open: Date.now() - t0 }));
ws.onclose = (e) => { console.log(JSON.stringify({ closed: Date.now(), code: e.code })); process.exit(0); };
ws.onerror = () => {}; setTimeout(() => { console.log(JSON.stringify({ timeout: true })); process.exit(0); }, 30000);`,
      peerUrl(A, `/ws/watch?path=${encodeURIComponent(path)}`).replace(/^http/, "ws")]);
    try {
      await new Promise((r) => setTimeout(r, 2000));
      const t1 = Date.now();
      await grant(A, B, { preset: "presence" });
      const { out } = await holder.done;
      const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.some((l) => l.open !== undefined), `the watch opened (${out})`);
      const closed = lines.find((l) => l.closed);
      assert.ok(closed, `B's socket closed (${out})`);
      console.log(`# lowered grant: B's WS closed ${closed.closed - t1} ms after the write`);
      assert.ok(closed.closed - t1 < 3000, "within 3 s");
      // presence still answers hello and details
      assert.equal(curlFrom(B, peerUrl(A, "/api/peer/hello")).status, 200);
      assert.equal(curlFrom(B, peerUrl(A, "/api/peer/details")).status, 200);
      assert.equal(curlFrom(B, peerUrl(A, "/api/sessions")).headers["x-sova-mesh"], "denied");
    } finally {
      holder.kill();
      await grant(A, B, { preset: "none" });
    }
  });
});

describe("per-login sync", () => {
  test("A shares one of two keys with C; C gets it alone; B gets it only through C, never the other", async () => {
    // A: B none (from above), C full with only one login chosen.
    await grant(A, C, { preset: "full", logins: ["pi:lab-m7-keep"] });
    authOp(A, "set", "lab-m7-keep", `lab-m7-keep-${Date.now()}-not-a-secret`);
    authOp(A, "set", "lab-m7-held", `lab-m7-held-${Date.now()}-not-a-secret`);
    const keep = entrySha(A, "lab-m7-keep");
    await waitFor(() => entrySha(C, "lab-m7-keep") === keep, { timeoutMs: 90000, what: "the chosen key on C" });
    // Sync replicates host to host, on each host's next exchange: taking a key schedules no onward
    // push (server/sync/grants-sync.test.ts), so C passes it to B at its 5-minute reconcile, a
    // peer-up, or a settings save. A save on C's own page, rather than waiting out the timer:
    const saved = await laptopFetch(C, "/api/mesh/settings", json({ sync: { logins: true } }));
    assert.equal(saved.status, 200);
    await waitFor(() => entrySha(B, "lab-m7-keep") === keep, { timeoutMs: 60000, what: "the chosen key reaches B through C" });
    // The other key never leaves A: give the exchanges another round to prove it.
    await new Promise((r) => setTimeout(r, 15000));
    for (const h of [B, C]) assert.equal(entrySha(h, "lab-m7-held"), "absent", `${h} never gets the key A keeps`);
    // A's manifest to C names only the chosen key; to B, A answers nothing at all.
    const toC = curlFrom(C, peerUrl(A, "/api/peer/credentials/manifest")).json;
    assert.deepEqual(Object.keys(toC.entries).filter((k) => k.startsWith("pi:lab-m7")), ["pi:lab-m7-keep"]);
    assert.equal(curlFrom(B, peerUrl(A, "/api/peer/credentials/manifest")).headers["x-sova-mesh"], "denied");
  });

  test("turning the login off stops future changes reaching C, but the copy it holds stays", async () => {
    await grant(A, C, { preset: "full", logins: [] });
    const held = entrySha(C, "lab-m7-keep");
    authOp(A, "set", "lab-m7-keep", `lab-m7-keep-2-${Date.now()}-not-a-secret`);
    await new Promise((r) => setTimeout(r, 15000));
    assert.equal(entrySha(C, "lab-m7-keep"), held, "C keeps its copy and gets no new one");
  });
});
