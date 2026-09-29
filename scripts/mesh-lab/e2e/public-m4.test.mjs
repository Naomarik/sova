// Public links M4 — a routed host's ingress and registry push (§mesh.public/ingress,
// §mesh.public/registry), on real tailscaled/Headscale:
// `b` routes via `a` (the gateway behind the lab's public front); a link minted on `b` gets a's
// public URL and opens from `plain` through the front → a → b's ingress; `stranger` and `c`
// connecting straight to b's ingress get 403 with the refused marker (HTTP and WS); the ingress
// binds b's tailnet address only; a revoked link stops opening; turning `via` off closes an open
// hop and unbinds the ingress.
//   scripts/mesh-lab/lab e2e public-m4        (needs lab up --hosts 3 with plain, stranger, publicfront)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { container, curlFrom, dockerIp, lab, laptopFetch, nodeId, requireLab, sh, tailnetIp, waitFor, wsFrom } from "./lib.mjs";

const SHARE_PORT = 4802; // shared/public-links.ts SHARE_PORT_DEFAULT: a's loopback share port, b's ingress port
const FRONT = (gw) => `http://${gw}:4880`; // the lab's public front (plain http), reached by `plain` on the lab network
const PUBLIC_URL = "https://share.example.com"; // the gateway's configured publicUrl (the lab has no public TLS)
const REFUSED = "x-sova-mesh"; // server/mesh/hello.ts REFUSED_HEADER, lowercase as curlFrom reports it

let cfg, A, B, C;

async function api(host, path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const res = await laptopFetch(host, path, {
    method,
    timeoutMs,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
function ok(r, what) {
  if (r.status < 200 || r.status > 299) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
}
const setPublicLinks = async (host, patch) => ok(await api(host, "/api/public-links", { method: "PUT", body: patch }), `${host}: PUT /api/public-links`);
const tokenOf = (url) => /\/[hi]\/([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? null;
const ingressListening = (host) => sh(host, `ss -ltnH | awk '{print $4}' | grep -E ':${SHARE_PORT}$'`).out.split("\n").filter(Boolean);

/** An org, a project, a person and a baton on `host`, through its main listener; → { sessionId, link }. */
async function mintOnHost(host) {
  const stamp = Date.now().toString(36);
  sh(host, `mkdir -p /root/work/pm4-${stamp}`);
  const org = ok(await api(host, "/api/orgs", { method: "POST", body: { name: `PM4 ${stamp}`, dir: `/root/orgs/pm4-${stamp}` } }), "create org");
  const withProject = ok(await api(host, `/api/orgs/${org.id}/projects`, { method: "POST", body: { name: "Portal", root: `/root/work/pm4-${stamp}` } }), "add project");
  const withPerson = ok(await api(host, `/api/orgs/${org.id}/people`, { method: "POST", body: { name: "Tahir", role: "Finance" } }), "add person");
  // An org answer is its OrgDetail: `projects`/`people` are counts, the lists `projectList`/`roster`.
  const project = withProject.projectList.find((p) => p.name === "Portal");
  const person = withPerson.roster.find((p) => p.name === "Tahir");
  const b = ok(
    await api(host, "/api/baton", { method: "POST", body: { orgId: org.id, projectId: project.id, to: person.id, publicTitle: "Dashboard", goal: "What the dashboard shows" }, timeoutMs: 60000 }),
    "start baton",
  );
  assert.ok(b.link, `the baton came with a link: ${JSON.stringify(b)}`);
  return { sessionId: b.sessionId, link: b.link, warning: b.linkWarning };
}

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.hosts.length >= 3, "public-m4 needs 3 hosts (lab up --hosts 3)");
  assert.ok(cfg.plain && cfg.stranger && cfg.publicfront, "public-m4 needs plain, stranger and the public front");
  [A, B, C] = cfg.hosts;
  lab("pair", cfg.hosts.join(","));
  await setPublicLinks(A, { route: "self", gateway: { publicUrl: PUBLIC_URL, front: "caddy", sharePort: SHARE_PORT, acceptFrom: "all" } });
  await setPublicLinks(B, { route: { via: { nodeId: nodeId(A) } } });
  await waitFor(() => ingressListening(B).length > 0, { timeoutMs: 30000, what: `${B}'s ingress bound` });
});

after(async () => {
  // leave the lab as the next harness expects it: no public links anywhere
  for (const h of [B, A]) await setPublicLinks(h, { route: "off" }).catch(() => {});
});

describe("b's ingress", () => {
  test("binds b's tailnet address only: never loopback, the docker network or a wildcard", () => {
    const bound = ingressListening(B);
    const ip = tailnetIp(B);
    assert.ok(bound.some((a) => a.startsWith(`${ip}:`)), `bound on ${ip}: ${bound}`);
    for (const a of bound) {
      assert.ok(!/^(0\.0\.0\.0|\*|\[::\]|127\.|\[::1\])/.test(a), `no wildcard or loopback: ${a}`);
      assert.ok(!a.startsWith(`${dockerIp(B)}:`), `not the docker address: ${a}`);
    }
  });

  test("stranger straight to b's ingress: 403 with the refused marker, HTTP and WS", () => {
    const base = `http://${tailnetIp(B)}:${SHARE_PORT}`;
    for (const path of [`/h/${"A".repeat(43)}`, `/api/h/${"A".repeat(43)}`, "/api/sessions", "/"]) {
      const r = curlFrom("stranger", base + path);
      assert.equal(r.status, 403, `${path}: ${r.status} ${r.error ?? ""}`);
      assert.equal(r.headers[REFUSED], "refused", path);
    }
    const r = curlFrom("stranger", `${base}/ws/h?token=${"A".repeat(43)}`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    assert.equal(r.status, 403, "WS upgrade");
    assert.equal(r.headers[REFUSED], "refused");
  });

  test("c, a paired peer that is not b's gateway, is refused the same way", () => {
    const r = curlFrom(C, `http://${tailnetIp(B)}:${SHARE_PORT}/h/${"A".repeat(43)}`);
    assert.equal(r.status, 403);
    assert.equal(r.headers[REFUSED], "refused");
  });

  test("a forged X-Forwarded-For or x-sova-* from a non-gateway changes nothing", () => {
    const r = curlFrom("stranger", `http://${tailnetIp(B)}:${SHARE_PORT}/h/${"A".repeat(43)}`, {
      headers: { "X-Forwarded-For": tailnetIp(A), "X-Sova-Peer": nodeId(A), "Tailscale-User-Login": "someone@example.com", Forwarded: `for=${tailnetIp(A)}` },
    });
    assert.equal(r.status, 403);
  });

  test("the gateway reaches it, and only the share paths exist there", () => {
    const base = `http://${tailnetIp(B)}:${SHARE_PORT}`;
    // The page shell answers 200 for any well-shaped token (it asks the API), so the 404 control is the API's.
    assert.equal(curlFrom(A, `${base}/api/h/${"A".repeat(43)}`).status, 404, "an unknown token is the share app's 404, not a refusal");
    for (const path of ["/api/sessions", "/api/health", "/", "/index.html", "/ws/chat", "/api/peer/hello", `/bad/../h/${"A".repeat(43)}`]) {
      const r = curlFrom(A, base + path);
      assert.equal(r.status, 404, `${path}: ${r.status}`);
      assert.notEqual(r.headers[REFUSED], "refused", path);
    }
    assert.equal(curlFrom("plain", `${base}/h/${"A".repeat(43)}`, { timeoutS: 3 }).status, 0, "plain (no tailnet) can't reach it at all");
  });
});

describe("a link minted on b", () => {
  let minted;
  before(async () => {
    minted = await mintOnHost(B);
  });

  test("carries the gateway's public URL", () => {
    assert.ok(minted.link.startsWith(`${PUBLIC_URL}/h/`), minted.link);
    assert.ok(tokenOf(minted.link));
  });

  test("opens from plain through the public front and a (page, API)", async () => {
    const t = tokenOf(minted.link);
    const api = await waitFor(
      () => {
        const r = curlFrom("plain", `${FRONT(A)}/api/h/${t}`);
        return r.status === 200 ? r : null;
      },
      { timeoutMs: 30000, what: "a's registry knows b's link" },
    );
    assert.ok(api.json, "the view is JSON");
    const page = curlFrom("plain", `${FRONT(A)}/h/${t}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
  });

  test("its /ws/h opens through a and gets the view", () => {
    const t = tokenOf(minted.link);
    const r = wsFrom("plain", `${FRONT(A).replace("http", "ws")}/ws/h?token=${t}`, { holdMs: 3000 });
    assert.equal(r.opened, true, JSON.stringify(r));
    assert.ok(r.messages.some((m) => m.includes('"view"')), JSON.stringify(r.messages));
  });

  // A close check only: the lab can't see whether the frame was forwarded first. M5's hermetic
  // tests own the "enforced before forwarding" proof (SHARE_WS_MAX_PAYLOAD).
  test("an oversized client message on the hop closes the socket", () => {
    const t = tokenOf(minted.link);
    const r = wsFrom("plain", `${FRONT(A).replace("http", "ws")}/ws/h?token=${t}`, { holdMs: 4000, send: ["x".repeat(4096)] });
    assert.equal(r.opened, true);
    assert.ok(r.closeCode !== null && r.closeCode !== 1000, `closed abnormally: ${r.closeCode}`);
  });

  test("an unknown token through a stays 404 (the API; the shell answers 200 for any shape)", () => {
    assert.equal(curlFrom("plain", `${FRONT(A)}/api/h/${"Q".repeat(43)}`).status, 404);
  });

  test("once revoked on b, it stops opening through a", async () => {
    ok(await api(B, `/api/baton/${minted.sessionId}/revoke`, { method: "POST", body: {} }), "revoke");
    const t = tokenOf(minted.link);
    await waitFor(() => [404, 410].includes(curlFrom("plain", `${FRONT(A)}/api/h/${t}`).status), { timeoutMs: 30000, what: "the revoked link no longer opens" });
  });
});

describe("turning via off", () => {
  test("closes an open hop and unbinds the ingress", async () => {
    const { link } = await mintOnHost(B);
    const t = tokenOf(link);
    await waitFor(() => curlFrom("plain", `${FRONT(A)}/api/h/${t}`).status === 200, { timeoutMs: 30000, what: "the new link opens" });
    // Hold a socket open through a, then change b's route while it is open.
    const script = `const ws = new WebSocket(process.argv[1]); const r = { opened: false, closeCode: null };
ws.onopen = () => { r.opened = true; console.log("OPEN"); };
ws.onclose = (e) => { r.closeCode = e.code; console.log(JSON.stringify(r)); process.exit(0); };
setTimeout(() => { console.log(JSON.stringify(r)); process.exit(0); }, 20000);`;
    const p = spawn("docker", ["exec", container("plain"), "node", "-e", script, `${FRONT(A).replace("http", "ws")}/ws/h?token=${t}`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const done = new Promise((r) => p.on("close", r));
    await waitFor(() => out.includes("OPEN"), { timeoutMs: 10000, what: "the hop opened" });
    await setPublicLinks(B, { route: "off" });
    await done;
    const r = JSON.parse(out.trim().split("\n").pop());
    assert.equal(r.opened, true);
    assert.notEqual(r.closeCode, null, "the socket was closed, not left to time out");
    await waitFor(() => ingressListening(B).length === 0, { timeoutMs: 15000, what: "b's ingress unbound" });
    await setPublicLinks(B, { route: { via: { nodeId: nodeId(A) } } });
  });
});
