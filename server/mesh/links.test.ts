// Run: pnpm exec tsx --test server/mesh/links.test.ts
// Linked sessions across hosts (§mesh/links) with no network: each fake host is a MeshLinks plus
// its own Hono app with mountLinks, and a fake MeshApi whose peerFetch calls the other host's app
// with the caller as the peer listener's verified peer. State lives in a throwaway dir, removed after.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import { parseLinkMessage } from "../../shared/link-message";
import type { LinkedAgentInfo, LinkError, LinkSendResult, LinksList, LinkThread, MeshLinkView, PeerLinkMessageResult } from "../../shared/mesh-links";
import type { SessionSummary } from "../../shared/protocol";
import { MeshLinks, MEMBER_CACHE_MS } from "./links";
import { mountLinks } from "./links-routes";
import type { PeerEntry } from "./peers";

const tmp = mkdtempSync(join(tmpdir(), "sova-links-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

interface Host {
  id: string;
  label: string;
  nodeId: string;
  /** false: its listener doesn't know its node identity (an address-identity host). */
  knowsSelf: boolean;
  root: string;
  app: Hono;
  links: MeshLinks;
  sessions: Map<string, SessionSummary>;
  held: Set<string>;
  delivered: Array<{ path: string; framed: string }>;
  answer: PeerLinkMessageResult;
  up: boolean;
  /** Serves no link route (a build without links). */
  old: boolean;
  /** Serves only summary?id=, no by-id (an older build). */
  noById: boolean;
  peerUp: Array<(peerId: string) => void>;
  clock: number;
}

let hosts: Record<string, Host> = {};
let n = 0;

const entryOf = (h: Host): PeerEntry => ({ id: h.id, label: h.label, nodeId: h.nodeId, dnsName: `${h.id}.test` });

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/work",
    title: `title ${id}`,
    createdAt: new Date(0).toISOString(),
    lastActiveAt: new Date(1000).toISOString(),
    model: "p/m",
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...extra,
  } as SessionSummary;
}

function makeHost(id: string, label: string, opts: Partial<Pick<Host, "knowsSelf" | "old" | "noById">> = {}): Host {
  const h = {
    id,
    label,
    nodeId: `node-${id}`,
    knowsSelf: opts.knowsSelf ?? true,
    root: join(tmp, `${n++}-${id}`),
    app: new Hono(),
    links: new MeshLinks(),
    sessions: new Map(),
    held: new Set(),
    delivered: [],
    answer: { state: "started" },
    up: true,
    old: opts.old ?? false,
    noById: opts.noById ?? false,
    peerUp: [],
    clock: 1_000_000,
  } as Host;
  hosts[id] = h;
  const byId = (c: import("hono").Context, sid: string) => {
    const s = h.sessions.get(sid);
    return s ? c.json(s) : c.json({ error: "No session with that id" }, 404);
  };
  h.app.get("/api/sessions/summary", (c) => byId(c, c.req.query("id") ?? ""));
  if (!h.noById) h.app.get("/api/sessions/by-id/:id", (c) => byId(c, c.req.param("id")));
  const mesh = {
    enabled: () => true,
    peers: () => Object.values(hosts).filter((o) => o !== h).map(entryOf),
    self: () => ({ id: h.id, label: h.label }),
    selfNode: () => ({ ...(h.knowsSelf ? { nodeId: h.nodeId } : {}), addresses: [] }),
    peerFetch: async (peerId: string, path: string, init?: RequestInit) => {
      const to = hosts[peerId];
      if (!to?.up) throw new TypeError("fetch failed");
      return to.app.request(path, init, { meshPeer: entryOf(h) });
    },
    requestPeer: (c: import("hono").Context) => (c.env as { meshPeer?: PeerEntry } | undefined)?.meshPeer ?? null,
    onPeerUp: (fn: (peerId: string) => void) => void h.peerUp.push(fn),
    onMeshStart: () => {},
    onMeshStop: () => {},
    sawPeer: () => {},
  };
  const deps = {
    root: () => h.root,
    summary: async (sid: string) => h.sessions.get(sid) ?? null,
    held: (sid: string) => (h.held.has(sid) ? (h.sessions.get(sid)?.path ?? null) : null),
    deliver: async (path: string, framed: string) => {
      h.delivered.push({ path, framed });
      return h.answer;
    },
    renderPeerRead: async (path: string) => ({ text: `read ${path}`, from: 0, total: 1, title: "t" }),
    now: () => h.clock,
  };
  if (h.old) h.links.configure({ ...deps, mesh });
  else mountLinks(h.app, mesh as never, deps, h.links);
  h.app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  return h;
}

/** A local act on a host's own listener. */
async function act<T>(h: Host, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await h.app.request(path, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json()) as T };
}

/** Let the fire-and-forget hops (an end's fan-out) run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

let A: Host;
let B: Host;

beforeEach(() => {
  for (const h of Object.values(hosts)) h.links.stop();
  hosts = {};
  A = makeHost("a", "Alpha");
  B = makeHost("b", "Beta");
  A.sessions.set("sa", summary("sa"));
  B.sessions.set("sb", summary("sb"));
  A.held.add("sa");
  B.held.add("sb");
});

async function link(members = [{ session: "sa" }, { host: "b", session: "sb" }]): Promise<MeshLinkView> {
  const r = await act<MeshLinkView>(A, "POST", "/api/mesh/links", { members });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

describe("the record (§mesh.links/record)", () => {
  test("a link is written on the creating host and on every member host, 0600", async () => {
    const v = await link();
    assert.match(v.link.id, /^lk_[0-9a-f]{16}$/);
    assert.equal(v.link.createdBy, A.nodeId);
    assert.deepEqual(
      v.link.members.map((m) => [m.nodeId, m.sessionId, m.path]),
      [
        [A.nodeId, "sa", "/sessions/sa.jsonl"],
        [B.nodeId, "sb", "/sessions/sb.jsonl"],
      ],
    );
    assert.deepEqual(B.links.get(v.link.id), v.link);
    assert.equal(statSync(join(B.root, "mesh-links.json")).mode & 0o777, 0o600);
    // It survives a restart.
    B.links.forgetForTest();
    assert.deepEqual(B.links.get(v.link.id), v.link);
    const bView = v.members.find((m) => m.nodeId === B.nodeId)!;
    assert.equal(bView.hostId, "b");
    assert.equal(bView.hostLabel, "Beta");
    assert.equal(bView.reach, "up");
    assert.equal(bView.state, "idle");
  });

  test("a host that doesn't know its own identity learns it from the copy", async () => {
    B.knowsSelf = false;
    const v = await link();
    assert.equal(B.links.selfNodeId(), B.nodeId);
    assert.equal(B.links.localMember(B.links.get(v.link.id)!)?.sessionId, "sb");
  });

  test("a creating host that doesn't know its own identity asks a peer (whoami)", async () => {
    A.knowsSelf = false;
    const v = await link();
    assert.equal(v.link.createdBy, A.nodeId);
    assert.equal(A.links.selfNodeId(), A.nodeId);
  });

  test("refusals name the member", async () => {
    let r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }] });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, "too-few");
    B.sessions.set("sb2", summary("sb2"));
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }, { host: "b", session: "sb2" }] });
    assert.equal(r.json.reason, "same-host");
    assert.equal(r.json.member, 2);
    B.sessions.set("sb", summary("sb", { overseer: true }));
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "special");
    assert.equal(r.json.member, 1);
    A.sessions.set("sa", summary("sa", { live: { pid: 7, status: "x" } }));
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.json.reason, "tui-live");
    assert.equal(r.json.member, 0);
    A.sessions.set("sa", summary("sa"));
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "nope" }, { host: "b", session: "sb" }] });
    assert.equal(r.json.reason, "no-session");
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "zz", session: "sb" }] });
    assert.equal(r.json.reason, "unreachable");
    assert.equal(A.links.all().length, 0);
  });

  test("a host that is down, or runs a build without links, can't be linked", async () => {
    B.up = false;
    let r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.json.reason, "unreachable");
    const C = makeHost("c", "Gamma", { old: true });
    C.sessions.set("sc", summary("sc"));
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "c", session: "sc" }] });
    assert.equal(r.json.reason, "old-build");
  });

  test("a peer that answers only summary?id= is still resolved", async () => {
    const D = makeHost("d", "Delta", { noById: true });
    D.sessions.set("sd", summary("sd"));
    const v = await link([{ session: "sa" }, { host: "d", session: "sd" }]);
    assert.equal(v.members[1]!.path, "/sessions/sd.jsonl");
  });

  test("ending spreads to every host; the earliest end wins", async () => {
    const v = await link();
    A.clock = 2_000_000;
    B.clock = 2_500_000;
    const ended = await act<MeshLinkView>(A, "POST", `/api/mesh/links/${v.link.id}/end`);
    assert.equal(ended.json.link.endedAt, 2_000_000);
    await settle();
    assert.equal(B.links.get(v.link.id)!.endedAt, 2_000_000);
    // A later end from a peer doesn't move it.
    const r = B.links.takeEnd(entryOf(A), v.link.id, { endedAt: 3_000_000 });
    assert.equal(r.status, 200);
    assert.equal(B.links.get(v.link.id)!.endedAt, 2_000_000);
    const s = await act<LinkError>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "hi" });
    assert.equal(s.status, 409);
  });

  test("archiving a member ends its links", async () => {
    const v = await link();
    await A.links.endFor("sa");
    await settle();
    assert.ok(A.links.get(v.link.id)!.endedAt);
    assert.ok(B.links.get(v.link.id)!.endedAt);
  });
});

describe("delivery (§mesh.links/delivery)", () => {
  test("a message reaches the member through its host, tagged, and both inboxes record it", async () => {
    const v = await link();
    const r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "hello\nthere" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.deliveries, [{ to: { nodeId: B.nodeId, sessionId: "sb" }, state: "started" }]);
    assert.equal(B.delivered.length, 1);
    assert.equal(B.delivered[0]!.path, "/sessions/sb.jsonl");
    const parsed = parseLinkMessage(B.delivered[0]!.framed)!;
    assert.equal(parsed.linkId, v.link.id);
    assert.equal(parsed.messageId, r.json.messageId);
    assert.deepEqual(parsed.from, { title: "title sa", host: "Alpha", sessionId: "sa" });
    assert.equal(parsed.text, "hello\nthere");
    const inbox = await act<{ records: Array<{ dir: string; id: string }> }>(B, "GET", "/api/mesh/links/inbox?session=sb");
    assert.deepEqual(inbox.json.records.map((x) => [x.dir, x.id]), [["in", r.json.messageId]]);
    const out = A.links.inbox("sa");
    assert.equal(out[0]!.dir, "out");
    assert.equal(out[0]!.deliveries![0]!.state, "started");
    const thread = await act<LinkThread>(B, "GET", `/api/links/${v.link.id}/thread`);
    assert.equal(thread.json.messages.length, 1);
    assert.equal(thread.json.messages[0]!.text, "hello\nthere");
  });

  test("a busy member's result is delivered; a refusal comes back to the sender", async () => {
    await link();
    B.answer = { state: "delivered" };
    let r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x" });
    assert.equal(r.json.deliveries[0]!.state, "delivered");
    B.answer = { state: "refused", reason: "model-off", message: "its model is off" };
    r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "y" });
    assert.deepEqual(r.json.deliveries[0], { to: { nodeId: B.nodeId, sessionId: "sb" }, state: "refused", reason: "model-off", message: "its model is off" });
    assert.equal(A.links.pending().length, 0);
  });

  test("the sender must be a session this host runs and a member", async () => {
    await link();
    A.held.delete("sa");
    let r = await act<LinkError>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x" });
    assert.equal(r.status, 403);
    A.sessions.set("other", summary("other"));
    A.held.add("other");
    r = await act<LinkError>(A, "POST", "/api/mesh/links/send", { session: "other", text: "x" });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "not-member");
  });

  test("the peer route serves only a {caller, session} pair that is a member", async () => {
    const v = await link();
    const C = makeHost("c", "Gamma");
    const body = { message: { id: "lm_0123456789abcdef", linkId: v.link.id, at: 1, from: { nodeId: A.nodeId, sessionId: "sa" }, to: [{ nodeId: B.nodeId, sessionId: "sb" }], text: "forged" } };
    // C claims to speak for A's session: the caller is C, so it is refused.
    const res = await B.app.request(`/api/peer/links/${v.link.id}/message`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { meshPeer: entryOf(C) });
    assert.equal(res.status, 403);
    assert.equal(B.delivered.length, 0);
    // With no verified caller (the main listener), the peer route is the plain 404.
    const main = await B.app.request(`/api/peer/links/${v.link.id}/message`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(main.status, 404);
  });

  test("a message retried after a lost answer is not delivered twice", async () => {
    const v = await link();
    const body = { message: { id: "lm_0123456789abcdef", linkId: v.link.id, at: 1, from: { nodeId: A.nodeId, sessionId: "sa" }, to: [{ nodeId: B.nodeId, sessionId: "sb" }], text: "once" } };
    for (let i = 0; i < 2; i++) {
      const res = await B.app.request(`/api/peer/links/${v.link.id}/message`, { method: "POST", body: JSON.stringify(body) }, { meshPeer: entryOf(A) });
      assert.deepEqual(await res.json(), { state: "started" });
    }
    assert.equal(B.delivered.length, 1);
  });

  test("a host that is down gets it from the outbox when it comes up", async () => {
    await link();
    B.up = false;
    const r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "later" });
    assert.equal(r.json.deliveries[0]!.state, "outbox");
    assert.equal(A.links.pending().length, 1);
    assert.equal(A.links.armed(), true);
    // Survives a restart.
    A.links.forgetForTest();
    assert.equal(A.links.pending().length, 1);
    B.up = true;
    for (const fn of A.peerUp) fn("b");
    await A.links.flush();
    assert.equal(B.delivered.length, 1);
    assert.equal(A.links.pending().length, 0);
    assert.equal(A.links.armed(), false);
    assert.equal(A.links.inbox("sa")[0]!.deliveries![0]!.state, "started");
  });

  test("a build without links answers 404: final, never queued", async () => {
    const v = await link();
    // B is replaced by a build without links (same node).
    hosts.b = makeHost("b", "Beta", { old: true });
    const r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x" });
    assert.equal(r.json.deliveries[0]!.state, "refused");
    assert.equal((r.json.deliveries[0] as { reason: string }).reason, "old-build");
    assert.equal(A.links.pending().length, 0);
    assert.ok(v);
  });

  test("a host that doesn't hold the link yet gets it with the first message", async () => {
    const v = await link();
    // As if B's copy were still in some outbox: B holds nothing.
    rmSync(join(B.root, "mesh-links.json"), { force: true });
    B.links.forgetForTest();
    assert.equal(B.links.get(v.link.id), null);
    const r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x" });
    assert.equal(r.json.deliveries[0]!.state, "started");
    assert.deepEqual(B.links.get(v.link.id), v.link);
  });

  test("`to` picks members by host label, peer id or session id; ambiguity refuses", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    let r = await act<LinkError>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x" });
    assert.equal(r.status, 400);
    const s = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x", to: ["gamma"] });
    assert.deepEqual(s.json.deliveries.map((d) => d.to.sessionId), ["sc"]);
    const all = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x", to: "all" });
    assert.equal(all.json.deliveries.length, 2);
    r = await act<LinkError>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x", to: "nobody" });
    assert.equal(r.status, 400);
  });
});

describe("routes and the pane", () => {
  test("whoami answers the caller's node as this host knows it", async () => {
    const res = await B.app.request("/api/peer/links/whoami", {}, { meshPeer: entryOf(A) });
    assert.deepEqual(await res.json(), { nodeId: A.nodeId });
  });

  test("local acts never answer the peer listener", async () => {
    const res = await A.app.request("/api/mesh/links", {}, { meshPeer: entryOf(B) });
    assert.equal(res.status, 404);
    const proxied = await A.app.request("/api/mesh/links", { headers: { "X-Forwarded-Host": "x" } });
    assert.equal(proxied.status, 404);
  });

  test("link_members lists the session's links; without a session, every link", async () => {
    const v = await link();
    const mine = await act<LinksList>(A, "GET", "/api/mesh/links?session=sa");
    assert.deepEqual(mine.json.links.map((l) => l.link.id), [v.link.id]);
    const notHeld = await act<LinkError>(A, "GET", "/api/mesh/links?session=zz");
    assert.equal(notHeld.status, 403);
    const every = await act<LinksList>(A, "GET", "/api/mesh/links");
    assert.equal(every.json.links.length, 1);
  });

  test("brief=1 (the prompt section) makes no peer hop", async () => {
    await link();
    B.up = false;
    A.clock += MEMBER_CACHE_MS + 1;
    const r = await act<LinksList>(A, "GET", "/api/mesh/links?session=sa&brief=1");
    assert.equal(r.status, 200);
    const b = r.json.links[0]!.members.find((m) => m.nodeId === B.nodeId)!;
    assert.equal(b.state, "unknown");
    assert.equal(b.title, "title sb"); // what was last learnt
    assert.equal(b.hostLabel, "Beta");
    // Not linked: an empty list, not a refusal.
    A.sessions.set("lone", summary("lone"));
    A.held.add("lone");
    const none = await act<LinksList>(A, "GET", "/api/mesh/links?session=lone&brief=1");
    assert.deepEqual(none.json, { links: [] });
  });

  test("linked agents: partner rows with unread counts; the Overseer sees every member", async () => {
    const v = await link();
    await act(B, "POST", "/api/mesh/links/send", { session: "sb", text: "ping" });
    let rows: LinkedAgentInfo[] = await A.links.linkedAgents("sa");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.key, `link:${v.link.id}:${B.nodeId}`);
    assert.equal(rows[0]!.hostLabel, "Beta");
    assert.equal(rows[0]!.title, "title sb");
    assert.equal(rows[0]!.unread, 1);
    const at = A.links.inbox("sa")[0]!.at;
    const seen = await act(A, "POST", `/api/links/${v.link.id}/seen`, { session: "sa", from: { nodeId: B.nodeId, sessionId: "sb" }, at });
    assert.equal(seen.status, 200);
    rows = await A.links.linkedAgents("sa");
    assert.equal(rows[0]!.unread, 0);
    const all = await A.links.linkedAgents("overseer", { overseer: true });
    assert.deepEqual(all.map((r) => [r.sessionId, r.self]), [["sa", true], ["sb", false]]);
    // A host that is down reads as offline (after the state cache).
    B.up = false;
    A.clock += MEMBER_CACHE_MS + 1;
    rows = await A.links.linkedAgents("sa");
    assert.equal(rows[0]!.state, "offline");
    // Ended links leave the pane.
    await A.links.end(v.link.id);
    assert.deepEqual(await A.links.linkedAgents("sa"), []);
  });

  test("the peer read renders on the host that holds the session", async () => {
    const res = await B.app.request("/api/peer/links/read?id=sb&items=5", {}, { meshPeer: entryOf(A) });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { text: string }).text, "read /sessions/sb.jsonl");
  });
});
