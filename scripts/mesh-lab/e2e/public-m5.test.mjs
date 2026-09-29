// Public links M5 — a routed host's links through the gateway when that host sleeps
// (§mesh.public/routing, /offline). Host a is the gateway behind the lab's public front
// (`plain` → http://a:4880 → a's share port); b routes via a. Stop b's Sova and b's links answer the
// static 503s from a, never 404; start it again and they reopen, and a page socket held through a
// reconnects. An unknown hash stays 404 at a.
//   scripts/mesh-lab/lab e2e public-m5     (leaves a,b paired and public links off again at the end)
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { curlFrom, execBackground, lab, laptopFetch, nodeId, requireLab, waitFor, wsFrom } from "./lib.mjs";

const A = "a";
const B = "b";
const FRONT = `http://${A}:4880`;
const PUBLIC_URL = "https://share.example.com";
const OFFLINE = { error: "offline", retryAfter: 60 };

/** JSON over a host's own main listener (the laptop port), as its local user. */
async function api(host, path, { method = "GET", body } = {}) {
  const res = await laptopFetch(host, path, {
    method,
    timeoutMs: 20000,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.status < 200 || res.status > 299) throw new Error(`${host} ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const pathOf = (link) => new URL(link).pathname;
const tokenOf = (link) => pathOf(link).split("/").pop();
const fromPlain = (path, opts) => curlFrom("plain", `${FRONT}${path}`, opts);

let hLink;
let iLink;

before(async () => {
  const cfg = requireLab();
  assert.ok(cfg.publicfront, "lab up with the public front (no --no-publicfront)");
  lab("pair", `${A},${B}`);
  await api(A, "/api/public-links", {
    method: "PUT",
    body: { route: "self", gateway: { publicUrl: PUBLIC_URL, front: "caddy", sharePort: 4802, acceptFrom: "all" } },
  });
  const gatewayNode = nodeId(A);
  assert.ok(gatewayNode, "a's StableID");
  await api(B, "/api/public-links", { method: "PUT", body: { route: { via: { nodeId: gatewayNode } } } });

  // One organization on b with a person, a project, an owner link (/i/) and a baton link (/h/).
  const org = await api(B, "/api/orgs", { method: "POST", body: { name: `M5 public ${Date.now()}` } });
  // An org answer is its OrgDetail: `projects`/`people` are counts, the lists `projectList`/`roster`.
  const orgId = org.id;
  const withPerson = await api(B, `/api/orgs/${orgId}/people`, { method: "POST", body: { name: "Pat Visitor" } });
  const personId = withPerson.roster.find((p) => p.name === "Pat Visitor").id;
  const withProject = await api(B, `/api/orgs/${orgId}/projects`, { method: "POST", body: { name: "Public links", root: "/root/work" } });
  const projectId = withProject.projectList.find((p) => p.name === "Public links").id;
  await api(B, `/api/orgs/${orgId}/owner`, { method: "PUT", body: { personId } });
  iLink = (await api(B, `/api/orgs/${orgId}/owner/link`)).link;
  hLink = (await api(B, "/api/baton", { method: "POST", body: { orgId, projectId, to: personId, publicTitle: "A question", goal: "M5 lab check" } })).link;
  assert.ok(hLink?.startsWith(`${PUBLIC_URL}/h/`), `b's baton link carries the gateway's URL: ${hLink}`);
  assert.ok(iLink?.startsWith(`${PUBLIC_URL}/i/`), `b's owner link carries the gateway's URL: ${iLink}`);

  // The registry push lands: both links open from the public side.
  await waitFor(() => fromPlain(`/api/h/${tokenOf(hLink)}`).status === 200, { timeoutMs: 30000, what: "b's /h/ link through a" });
  await waitFor(() => fromPlain(`/api/i/${tokenOf(iLink)}`).status === 200, { timeoutMs: 30000, what: "b's /i/ link through a" });
});

after(async () => {
  lab("sova-start", B);
  await waitFor(async () => (await laptopFetch(B, "/api/health", { timeoutMs: 5000 }).catch(() => null))?.status === 200, { timeoutMs: 60000, what: "b back" }).catch(() => {});
  for (const h of [B, A]) await api(h, "/api/public-links", { method: "PUT", body: { route: "off" } }).catch(() => {});
});

describe("b awake", () => {
  test("b's links open from plain through a; an unknown hash is 404 at a", () => {
    assert.equal(fromPlain(pathOf(hLink)).status, 200);
    assert.equal(fromPlain(pathOf(iLink)).status, 200);
    const unknown = "Q".repeat(43);
    assert.equal(fromPlain(`/h/${unknown}`).status, 404);
    assert.equal(fromPlain(`/api/h/${unknown}`).status, 404);
    assert.equal(fromPlain(`/api/i/${unknown}`).status, 404);
  });
});

describe("b asleep, then back", () => {
  const ws = () => `ws://${A}:4880/ws/h?token=${tokenOf(hLink)}&v=m5lab`;

  test("a page socket opens through a and gets the view", () => {
    const r = wsFrom("plain", ws(), { holdMs: 2000 });
    assert.equal(r.opened, true, JSON.stringify(r));
    assert.ok(r.messages.some((m) => m.includes('"view"')), "the view arrives through the hop");
  });

  test("stopping b's Sova: a held socket closes 4503, and b's links answer a's offline 503s, never 404", async () => {
    // Hold a socket in the background (wsFrom blocks), then stop b under it.
    const job = execBackground("plain", [
      "node",
      "-e",
      "const ws=new WebSocket(process.argv[1]);let o=false;ws.onopen=()=>{o=true};ws.onclose=(e)=>{console.log(JSON.stringify({o,code:e.code}));process.exit(0)};setTimeout(()=>{console.log(JSON.stringify({o,code:null}));process.exit(0)},40000);",
      ws(),
    ]);
    await new Promise((res) => setTimeout(res, 3000));
    lab("sova-stop", B);
    const { out } = await job.done;
    const closed = JSON.parse(out.split("\n").pop());
    assert.equal(closed.o, true, "the socket was open before the stop");
    assert.equal(closed.code, 4503, "a live hop that dies closes 4503");

    const page = await waitFor(() => {
      const res = fromPlain(pathOf(hLink));
      return res.status === 503 ? res : null;
    }, { timeoutMs: 30000, what: "b's page shell answers 503" });
    assert.equal(page.headers["retry-after"], "60");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.ok(page.headers["content-security-policy"], "the share page's CSP");
    assert.ok(!page.body.includes(tokenOf(hLink)), "the offline shell repeats no token");
    assert.match(page.body, /This page can't be opened right now\./);
    assert.equal(fromPlain(pathOf(iLink)).status, 503);

    for (const path of [`/api/h/${tokenOf(hLink)}`, `/api/i/${tokenOf(iLink)}`]) {
      const res = fromPlain(path);
      assert.equal(res.status, 503, path);
      assert.deepEqual(res.json, OFFLINE);
    }
    const post = fromPlain(`/api/h/${tokenOf(hLink)}/message`, { method: "POST", body: { text: "while asleep" } });
    assert.equal(post.status, 503);
    assert.deepEqual(post.json, OFFLINE);

    const up = wsFrom("plain", ws(), { holdMs: 1500 });
    assert.equal(up.opened, false, "the upgrade is refused while b sleeps");
  });

  test("starting b again: its links reopen and a page socket reconnects; the POST sent while asleep was never replayed", async () => {
    lab("sova-start", B);
    await waitFor(() => fromPlain(`/api/h/${tokenOf(hLink)}`).status === 200, { timeoutMs: 60000, what: "b's /api/h/ reopens" });
    assert.equal(fromPlain(pathOf(hLink)).status, 200);
    assert.equal(fromPlain(`/api/i/${tokenOf(iLink)}`).status, 200);
    const r = wsFrom("plain", ws(), { holdMs: 2000 });
    assert.equal(r.opened, true, JSON.stringify(r));
    const view = JSON.parse(r.messages.find((m) => m.includes('"view"')) ?? "{}").view;
    assert.ok(view, "a view");
    assert.ok(!JSON.stringify(view.items ?? []).includes("while asleep"), "the refused POST never reached b");
  });
});
