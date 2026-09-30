// Run: pnpm exec tsx --test server/share-listener.test.ts. A throwaway PI_CODING_AGENT_DIR and
// workspace in the OS temp dir, the share server on an ephemeral loopback port; ~/.pi untouched.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { BATON_HANDOFF_ENTRY } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const links = await import("./baton-links");
const { clientAddress, createShareServer, RateLimiter, shareMayReach } = await import("./share/listener");
const { tokenLimited, MESSAGES_PER_MINUTE } = await import("./share/routes");

const TOKEN = "A".repeat(43);

test("the allowlist: exact shapes on the raw path, nothing else", () => {
  const yes: [string, string][] = [
    ["GET", `/h/${TOKEN}`],
    ["HEAD", `/h/${TOKEN}`],
    ["GET", "/h/assets/index-abc.js"],
    ["GET", `/api/h/${TOKEN}`],
    ["POST", `/api/h/${TOKEN}/message`],
  ];
  const no: [string, string][] = [
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/api/sessions"],
    ["GET", "/api/orgs"],
    ["POST", "/api/sessions/prompt"],
    ["GET", "/ws/chat"],
    ["GET", "/ws/watch"],
    ["GET", "/peer/x/api/sessions"],
    ["GET", "/ext/x/"],
    ["GET", "/explain/x"],
    ["GET", "/h/assets/.hidden"],
    ["GET", "/h/assets/a/b.js"],
    ["GET", `/h/${TOKEN}x`],
    ["GET", `/api/h/${TOKEN}/message`],
    ["POST", `/api/h/${TOKEN}`],
    ["GET", `/api/%68/${TOKEN}`],
    ["GET", `/h/${TOKEN.slice(0, 40)}%41%41%41`],
    ["DELETE", `/api/h/${TOKEN}`],
  ];
  for (const [m, p] of yes) assert.equal(shareMayReach(m, p), true, `${m} ${p}`);
  for (const [m, p] of no) assert.equal(shareMayReach(m, p), false, `${m} ${p}`);
});

test("limits: 10 messages a minute per token; the per-address limiter; the proxy's client address", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < MESSAGES_PER_MINUTE; i++) assert.equal(tokenLimited("tok-a", t0 + i), false);
  assert.equal(tokenLimited("tok-a", t0 + 100), true);
  assert.equal(tokenLimited("tok-b", t0 + 100), false, "per token");
  assert.equal(tokenLimited("tok-a", t0 + 60_001), false, "a sliding minute");
  const r = new RateLimiter(2);
  assert.deepEqual([r.limited("x", 1), r.limited("x", 2), r.limited("x", 3), r.limited("y", 3)], [false, false, true, false]);
  const req = (peer: string, xff?: string) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} });
  assert.equal(clientAddress(req("127.0.0.1", "203.0.113.9")), "203.0.113.9", "behind the local proxy");
  assert.equal(clientAddress(req("100.101.1.2", "198.51.100.1, 203.0.113.9")), "203.0.113.9", "behind a tailnet proxy: the hop it appended");
  assert.equal(clientAddress(req("203.0.113.50", "1.2.3.4")), "203.0.113.50", "a direct client can't choose its address");
});

describe("the share server", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
  const maria = await orgs.addPerson(org.id, { name: "Maria", role: "Payroll" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "SECRET-GOAL" });
  // The registry moves, and the transcript gets the entry hand_to writes (here by hand, no runtime).
  const { n } = await baton.handTo(c.sessionId, maria.id, "Format?", "for Maria");
  const lines = readFileSync(c.path, "utf8").trim().split("\n");
  const parentId = JSON.parse(lines.at(-1)!).id;
  appendFileSync(c.path, `${JSON.stringify({ type: "custom", id: "hand2", parentId, timestamp: new Date().toISOString(), customType: BATON_HANDOFF_ENTRY, data: { v: 1, n, from: tony.id, to: maria.id, question: "Format?", briefing: "for Maria" } })}\n`);
  const tonyOld = c.token!; // moved on: reads, never writes
  const mariaToken = baton.rotateLink(c.sessionId).token;
  const closed = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Closed one", goal: "g" });
  await baton.closeBaton(closed.sessionId);

  const server = createShareServer();
  let base = "";
  let wsBase = "";
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (token: string, body: string) => fetch(`${base}/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

  test("the operator app and API are unreachable", async () => {
    // What It's Told (§app.baton/told) too, even for a real session's id.
    for (const p of ["/", "/api/sessions", "/api/orgs", "/api/baton", "/api/baton/x/told", `/api/baton/${c.sessionId}/told`, "/ws/chat", "/peer/x", "/ext/x/", "/assets/index.js", `/api/%68/${mariaToken}`])
      assert.equal((await fetch(base + p)).status, 404, p);
    const up = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${wsBase}/ws/chat?path=/x.jsonl`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => {});
    });
    assert.equal(up, 404, "/ws/chat does not upgrade on the share port");
  });

  test("tokens: unknown 404, closed 410, the holder reads with canWrite, the old holder reads without", async () => {
    assert.equal((await fetch(`${base}/api/h/${"B".repeat(43)}`)).status, 404);
    assert.equal((await fetch(`${base}/api/h/${closed.token}`)).status, 410);
    const mine = await (await fetch(`${base}/api/h/${mariaToken}`)).json();
    assert.deepEqual(mine.viewer, { name: "Maria", canWrite: true });
    assert.ok(JSON.stringify(mine).includes("for Maria"), "her briefing");
    assert.ok(!JSON.stringify(mine).includes("SECRET-GOAL"), "never the goal");
    const old = await (await fetch(`${base}/api/h/${tonyOld}`)).json();
    assert.deepEqual(old.viewer, { name: "Tony", canWrite: false, reason: "moved-on" });
    assert.ok(!JSON.stringify(old).includes("for Maria"), "not someone else's briefing");
    const res = await fetch(`${base}/h/${mariaToken}`);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  test("messages: the sender is the token; no other field, no slash, no oversize; a non-holder is refused", async () => {
    assert.equal((await post(tonyOld, JSON.stringify({ text: "hi" }))).status, 409, "moved on");
    assert.equal((await post(closed.token!, JSON.stringify({ text: "hi" }))).status, 410);
    assert.equal((await post(mariaToken, JSON.stringify({ text: "/compact" }))).status, 400);
    assert.equal((await post(mariaToken, JSON.stringify({ text: "hi", by: "operator" }))).status, 400, "no sender field");
    assert.equal((await post(mariaToken, JSON.stringify({ text: "hi", images: [] }))).status, 400, "no images");
    assert.equal((await post(mariaToken, JSON.stringify({ text: "x".repeat(4001) }))).status, 413);
    assert.equal((await post(mariaToken, JSON.stringify({ text: "x".repeat(20_000) }))).status, 413, "body cap before JSON");
    assert.equal((await post(mariaToken, "not json")).status, 400);
    assert.equal(baton.batonById(c.sessionId)!.row.budget.messagesUsed, 0, "nothing refused was counted");
  });

  test("the WebSocket: an unknown token is refused, a known one gets its view at once", async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${wsBase}/ws/h?token=${"C".repeat(43)}`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    assert.equal(status, 404);
    const first = await new Promise<{ type: string; view?: { viewer?: { name: string } } }>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/h?token=${mariaToken}`);
      ws.on("message", (d) => {
        resolve(JSON.parse(String(d)));
        ws.close();
      });
      ws.on("error", reject);
    });
    assert.equal(first.type, "view");
    assert.equal(first.view?.viewer?.name, "Maria");
  });

  test("an offer: 'taken' for the others while one holds the lease (409, code taken, holder unnamed); 410 once withdrawn", async () => {
    const carlos = await orgs.addPerson(org.id, { name: "Carlos", role: "CEO" });
    const o = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id, carlos.id], publicTitle: "Offer", goal: "g", question: "Who hosts?" });
    const tok = (id: string) => o.links!.find((l) => l.personId === id)!.token;
    const pooled = await (await fetch(`${base}/api/h/${tok(maria.id)}`)).json();
    assert.deepEqual(pooled.viewer, { name: "Maria", canWrite: true });
    assert.equal(baton.batonById(o.sessionId)!.row.holder, null, "opening the page claims nothing");
    baton.noteMessage(o.sessionId, tony.id); // Tony's first message took it
    const taken = await (await fetch(`${base}/api/h/${tok(maria.id)}`)).json();
    assert.deepEqual(taken.viewer, { name: "Maria", canWrite: false, reason: "taken" });
    assert.equal(taken.holder, null, "no name");
    const refused = await post(tok(maria.id), JSON.stringify({ text: "me too" }));
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "taken");
    await baton.handTo(o.sessionId, "operator", "q", "");
    assert.equal((await fetch(`${base}/api/h/${tok(carlos.id)}`)).status, 410);
    assert.equal((await post(tok(carlos.id), JSON.stringify({ text: "hi" }))).status, 410);
    assert.equal((await fetch(`${base}/api/h/${tok(tony.id)}`)).status, 200, "the one who held it reads on");
  });

  test("per address: 60 requests a minute, then 429", async () => {
    let last = 0;
    for (let i = 0; i < 65; i++) last = (await fetch(`${base}/api/h/${"D".repeat(43)}`)).status;
    assert.equal(last, 429);
    assert.ok(links.findLink(mariaToken), "untouched");
  });
});

test("past the address limit the page shell answers a plain page asking to wait, never JSON; the API keeps JSON", async () => {
  const server = createShareServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let res: Response | null = null;
    for (let i = 0; i < 61; i++) {
      res = await fetch(`${base}/h/${TOKEN}`);
      if (i < 60) await res.arrayBuffer();
    }
    assert.equal(res!.status, 429);
    assert.match(res!.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(res!.headers.get("retry-after"), "60");
    assert.match(res!.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(res!.headers.get("cache-control"), "no-store");
    assert.match(await res!.text(), /Too many requests from this network\. Wait a minute, then reload\./);
    const api = await fetch(`${base}/api/h/${TOKEN}`);
    assert.equal(api.status, 429);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
    await api.json();
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
