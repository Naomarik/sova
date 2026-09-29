// Public links M3 — the gateway front (§mesh.public/front), end to end in the lab:
//   host `a` is the gateway (PUT /api/public-links route "self"); the lab's public front (Caddy in a's
//   netns, plain http :4880 → a's 127.0.0.1:4802) stands in for the real TLS front; `plain` is the
//   internet. A token minted on a opens through the front, every non-share path is 404, and an
//   exposure-style probe finds nothing of Sova's reachable but the front.
//   scripts/mesh-lab/lab e2e public-m3
// Leaves a's public-links setting as it found it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { curlFrom, dockerIp, exec, laptopFetch, readAgentFile, requireLab, sh, tailnetIp, waitFor, writeAgentFile } from "./lib.mjs";

const GW = "a";
const FRONT = `http://${GW}:4880`; // the lab's public front, as `plain` sees it
const SETTING = "sova/public-links.json";
const PUBLIC_URL = "https://share.example.com";
/** A TCP connect from inside `node`: "open", or "closed" (refused or no answer within 4 s). */
const tcp = (node, host, port) =>
  exec(node, ["node", "-e", `const s=require("net").connect(${port},${JSON.stringify(host)});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("error",()=>{console.log("closed");process.exit(0)});setTimeout(()=>{console.log("closed");process.exit(0)},4000)`]).out;

async function api(path, { method = "GET", body } = {}) {
  const r = await laptopFetch(GW, path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, timeoutMs: 20000 });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

let cfg;
let saved = null;
let token = "";
before(async () => {
  cfg = requireLab();
  assert.ok(cfg.publicfront && cfg.hosts[0] === GW, "the lab needs its public front on host a (lab up without --no-publicfront)");
  saved = readAgentFile(GW, SETTING);
  const put = await api("/api/public-links", {
    method: "PUT",
    body: { route: "self", gateway: { publicUrl: PUBLIC_URL, front: "caddy", sharePort: 4802, acceptFrom: "all" } },
  });
  assert.equal(put.status, 200, `PUT /api/public-links -> ${put.status} ${put.text}`);
  // the lab sets no SOVA_SHARE_* pins, so the setting alone binds 127.0.0.1:4802 and names the address
  assert.deepEqual(put.json.pinnedByEnv, [], `a has env pins: ${put.json.pinnedByEnv}`);
  assert.equal(put.json.share.source, "setting");
  assert.equal(put.json.share.publicUrl, PUBLIC_URL);
  assert.equal(put.json.front?.front, "caddy", "the answer carries the chosen front's guide");
  assert.ok(put.json.front.steps.some((s) => s.root && /setcap/.test(s.text)), "the caddy guide has its root setcap step");
  // the share port comes up without a restart (M1's rebind), behind the front
  await waitFor(() => curlFrom("plain", `${FRONT}/api/h/${"A".repeat(43)}`).status === 404, { timeoutMs: 30000, what: "the front reaches a's share port" });

  // an Owner page link minted on a (org → person → owner → link)
  const org = await api("/api/orgs", { method: "POST", body: { name: `public-m3 ${Date.now()}` } });
  assert.equal(org.status, 201, org.text);
  const people = await api(`/api/orgs/${org.json.id}/people`, { method: "POST", body: { name: "Owner" } });
  assert.equal(people.status, 201, people.text);
  const pid = people.json.roster.find((p) => p.name === "Owner").id;
  assert.equal((await api(`/api/orgs/${org.json.id}/owner`, { method: "PUT", body: { personId: pid } })).status, 200);
  const link = await api(`/api/orgs/${org.json.id}/owner/link`);
  assert.equal(link.status, 200, link.text);
  assert.ok(link.json.link.startsWith(`${PUBLIC_URL}/i/`), `the link uses the setting's public URL: ${link.json.link}`);
  token = link.json.link.slice(`${PUBLIC_URL}/i/`.length);
});

after(async () => {
  // back to what a had: the patchable fields through the route (so the listener rebinds), then the file itself
  const was = saved === null ? { route: "off" } : JSON.parse(saved);
  await api("/api/public-links", { method: "PUT", body: { route: was.route, ...(was.gateway ? { gateway: was.gateway } : {}) } }).catch(() => {});
  if (saved === null) sh(GW, `rm -f "$PI_CODING_AGENT_DIR/${SETTING}"`);
  else writeAgentFile(GW, SETTING, saved);
});

describe("plain → public front → a's gateway", () => {
  test("a token minted on a opens publicly", () => {
    const page = curlFrom("plain", `${FRONT}/i/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    const view = curlFrom("plain", `${FRONT}/api/i/${token}`);
    assert.equal(view.status, 200, view.body);
    assert.equal(view.headers["cache-control"], "no-store");
  });

  test("an unknown token answers the gateway's own 404 signature (what Verify checks)", () => {
    const r = curlFrom("plain", `${FRONT}/api/h/${"B".repeat(43)}`);
    assert.equal(r.status, 404);
    assert.equal(r.json?.code, "not-found");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  });

  test("every non-share path is 404 through the front", () => {
    for (const path of ["/", "/api/health", "/api/public-links", "/api/sessions", "/api/mesh", "/api/orgs", "/ws/chat", "/peer/hello", "/ext/x", "/h/", "/bad/%2e%2e/h/x", `/i/${token}/x`])
      assert.equal(curlFrom("plain", `${FRONT}${path}`).status, 404, path);
    assert.equal(curlFrom("plain", `${FRONT}/api/public-links`, { method: "PUT", body: { route: "off" } }).status, 404);
  });

  test("exposure: only the front answers; a's Sova ports are closed to the public and to the tailnet stranger", () => {
    const pub = dockerIp(GW);
    for (const port of [4800, 4801, 4802]) {
      assert.equal(tcp("plain", pub, port), "closed", `plain → ${GW}:${port}`);
    }
    assert.equal(tcp("plain", pub, 4880), "open", "the front is the control");
    const ts = tailnetIp(GW);
    if (cfg.stranger && ts) {
      const r = curlFrom("stranger", `http://${ts}:4802/api/h/${"C".repeat(43)}`, { timeoutS: 4 });
      assert.equal(r.status, 0, "the gateway's share port is loopback only, never on the tailnet");
    }
  });
});
