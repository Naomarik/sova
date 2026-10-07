// Run: pnpm test -- server/mesh/links.test.ts
// Linked sessions across hosts (§mesh/links) with no network: each fake host is a MeshLinks plus
// its own Hono app with mountLinks, and a fake MeshApi whose peerFetch calls the other host's app
// with the caller as the peer listener's verified peer. File offers pack and land through tar
// in-process (links-transfer-test-fixtures.ts). State lives in a throwaway dir, removed after.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import { parseLinkMessage } from "../../shared/link-message";
import type {
  LinkedAgentInfo,
  LinkError,
  LinkOffer,
  LinkOfferCreateResult,
  LinkOffersList,
  LinkSendResult,
  LinksList,
  LinkThread,
  MeshLinkView,
  PeerLinkMessageResult,
} from "../../shared/mesh-links";
import type { LinkSandbox } from "../link-sandbox";
import type { SessionSummary } from "../../shared/protocol";
import { NotShared } from "./access";
import { MeshLinks, MEMBER_CACHE_MS } from "./links";
import { mountLinks } from "./links-routes";
import { inProcessTar } from "./links-transfer-test-fixtures";
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
  /** Each local session's sandbox, as linkSandboxOf would answer. */
  sandbox: (sessionId: string) => LinkSandbox;
  /** The next tar body served to this host is cut after this many bytes (a dropped connection). */
  cutTarAt?: number;
  /** This host's tar downloads wait for it (a pull still running while others finish). */
  holdTar?: Promise<void>;
  /** Peers this host's grant withholds links from: its peerFetch refuses link sends to them, as the
      real outbound gate does (reads of the peer by id still go). */
  withholdLinks: Set<string>;
  /** Peers this host marked down (sawPeer false). */
  sawDown: string[];
  /** Called with every peerFetch, before it goes. */
  onFetch?: (peerId: string, path: string) => void;
  /** The call reaches the peer, but its answer is lost on the way back. */
  loseAnswer?: (peerId: string, path: string) => boolean;
  /** This host's LAN key pin (lower-case hex): it goes by lan:<pin> to its LAN pairings. */
  lanPin?: string;
  /** Peers this host is paired with over LAN: each names the other lan:<pin>. */
  lanWith: Set<string>;
  /** The mesh can't say how a peer knows this host (only a whoami answer can). */
  noSelfFor?: boolean;
  /** Hosts missing from this host's peers.json. */
  hidePeers: Set<string>;
  /** While set, this host's own session lookups (deps.summary) wait for it. */
  stall?: Promise<void>;
  /** The call goes and runs on the peer, but this host stops waiting at once (its hop timed out). */
  detachAnswer?: (peerId: string, path: string) => boolean;  /** The calls detachAnswer let run on. */
  detached: Array<Promise<void>>;
}

let hosts: Record<string, Host> = {};
let n = 0;

/** Host `h` as `viewer` has it in peers.json: by lan:<pin> over a LAN pairing, else its tailnet id. */
const entryOf = (h: Host, viewer?: Host): PeerEntry =>
  viewer?.lanWith.has(h.id) && h.lanPin
    ? { id: h.id, label: h.label, nodeId: `lan:${h.lanPin}`, dnsName: "", lan: { role: "accept", pin: h.lanPin.toUpperCase() } }
    : { id: h.id, label: h.label, nodeId: h.nodeId, dnsName: `${h.id}.test` };

/** Pair two hosts over LAN (each gets a pin); `knowsSelf: false` too makes one LAN-only. */
function pairLan(x: Host, y: Host): void {
  for (const h of [x, y]) h.lanPin ??= randomBytes(16).toString("hex");
  x.lanWith.add(y.id);
  y.lanWith.add(x.id);
}
const lanId = (h: Host) => `lan:${h.lanPin}`;

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

function makeHost(id: string, label: string, opts: Partial<Host> = {}): Host {
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
    sandbox: () => ({ on: false }),
    withholdLinks: new Set(),
    sawDown: [],
    lanWith: new Set(),
    hidePeers: new Set(),
    detached: [],
  } as Host;
  Object.assign(h, opts);
  hosts[id] = h;
  const byId = (c: import("hono").Context, sid: string) => {
    const s = h.sessions.get(sid);
    return s ? c.json(s) : c.json({ error: "No session with that id" }, 404);
  };
  h.app.get("/api/sessions/summary", (c) => byId(c, c.req.query("id") ?? ""));
  if (!h.noById) h.app.get("/api/sessions/by-id/:id", (c) => byId(c, c.req.param("id")));
  const mesh = {
    enabled: () => true,
    peers: () =>
      Object.values(hosts)
        .filter((o) => o !== h && !h.hidePeers.has(o.id))
        .map((o) => entryOf(o, h)),
    self: () => ({ id: h.id, label: h.label }),
    selfNode: () => ({ ...(h.knowsSelf ? { nodeId: h.nodeId } : {}), addresses: [] }),
    selfNodeIds: () => [...(h.knowsSelf ? [h.nodeId] : []), ...(h.lanPin ? [lanId(h)] : [])],
    selfNodeIdFor: (peer: PeerEntry) => (h.noSelfFor ? undefined : peer.lan ? (h.lanPin ? lanId(h) : undefined) : h.knowsSelf ? h.nodeId : undefined),
    mayShareWith: (peerId: string, cap: string) => cap !== "links" || !h.withholdLinks.has(peerId),
    peerFetch: async (peerId: string, path: string, init?: RequestInit) => {
      h.onFetch?.(peerId, path);
      if (h.withholdLinks.has(peerId) && /^\/api\/peer\/links(?:[/?]|$)/.test(path) && !/^\/api\/peer\/links\/(?:whoami|read)(?:\?|$)/.test(path)) throw new NotShared(peerId);
      const to = hosts[peerId];
      if (!to?.up) throw new TypeError("fetch failed");
      if (h.holdTar && path.endsWith("/tar")) await h.holdTar;
      if (h.detachAnswer?.(peerId, path)) {
        h.detached.push(Promise.resolve(to.app.request(path, init, { meshPeer: entryOf(h, to) })).then(() => undefined));
        throw new TypeError("The operation timed out.");
      }
      const res = await to.app.request(path, init, { meshPeer: entryOf(h, to) });
      if (h.loseAnswer?.(peerId, path)) {
        await res.body?.cancel();
        throw new TypeError("fetch failed");
      }
      if (h.cutTarAt === undefined || !path.endsWith("/tar") || (res.status !== 200 && res.status !== 206) || !res.body) return res;
      return cutAfter(res, h, h.cutTarAt);
    },
    requestPeer: (c: import("hono").Context) => (c.env as { meshPeer?: PeerEntry } | undefined)?.meshPeer ?? null,
    onPeerUp: (fn: (peerId: string) => void) => void h.peerUp.push(fn),
    onMeshStart: () => {},
    onMeshStop: () => {},
    sawPeer: (peerId: string, up: boolean) => void (up || h.sawDown.push(peerId)),
  };
  const deps = {
    root: () => h.root,
    summary: async (sid: string) => {
      if (h.stall) await h.stall;
      return h.sessions.get(sid) ?? null;
    },
    held: (sid: string) => (h.held.has(sid) ? (h.sessions.get(sid)?.path ?? null) : null),
    deliver: async (path: string, framed: string) => {
      h.delivered.push({ path, framed });
      return h.answer;
    },
    renderPeerRead: async (path: string) => ({ text: `read ${path}`, from: 0, total: 1, title: "t" }),
    now: () => h.clock,
    sandboxOf: async (sid: string) => h.sandbox(sid),
    homedir: () => join(h.root, "home"),
    protectedRoots: () => [join(h.root, "state"), join(h.root, "sessions")],
    transferTimings: { idleMs: 2_000, downWaitMs: 100, maxBackoffMs: 50 },
    // Packs and pulls through the in-process tar; the host's own: links-transfer.integration.test.ts.
    tar: inProcessTar,
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

/** Wait until `ok()` holds (a pull, a pack), failing after `ms`. */
async function until(ok: () => boolean, ms = 10_000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A tar answer whose body breaks after `n` bytes, once. */
function cutAfter(res: Response, h: Host, n: number): Response {
  h.cutTarAt = undefined;
  const reader = res.body!.getReader();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const r = await reader.read();
      if (r.done) return ctl.close();
      const room = n - sent;
      if (r.value.length >= room) {
        if (room > 0) ctl.enqueue(r.value.subarray(0, room));
        void reader.cancel();
        return ctl.error(new Error("connection reset"));
      }
      sent += r.value.length;
      ctl.enqueue(r.value);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}


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

  test("an organization's session is refused, on this host or a peer", async () => {
    const org = { orgId: "o1", orgName: "Org", kind: "coding" as const };
    B.sessions.set("sb", summary("sb", { org }));
    let r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "special");
    assert.equal(r.json.member, 1);
    assert.match(r.json.error, /organization/);
    B.sessions.set("sb", summary("sb"));
    A.sessions.set("sa", summary("sa", { org: { ...org, kind: "other" } }));
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "special");
    assert.equal(r.json.member, 0);
    assert.equal(A.links.all().length, 0);
    assert.equal(B.links.all().length, 0);
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

  test("a member on a peer this host doesn't share links with is refused as such, never as down", async () => {
    A.withholdLinks.add("b");
    const r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.member, 1);
    assert.match(r.json.error, /this host doesn't share links with Beta/);
    assert.match(r.json.error, /Mesh page/);
    assert.doesNotMatch(r.json.error, /didn't answer|down/);
    assert.equal(A.links.all().length, 0);
    assert.equal(B.links.all().length, 0);
    assert.deepEqual(A.links.pending(), []);
    assert.deepEqual(A.sawDown, []);
  });

  test("a grant lowered while the link is being made: refused, no live link left anywhere, nothing held", async () => {
    // After the check, before the copy goes: the member lookup is the last call before it.
    A.onFetch = (peerId, path) => {
      if (path.startsWith("/api/sessions/")) A.withholdLinks.add(peerId);
    };
    let r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.member, 1);
    assert.match(r.json.error, /this host doesn't share links with Beta/);
    assert.equal(A.links.all().length, 0, "no local record of a link that never got out");
    assert.equal(B.links.all().length, 0);
    assert.deepEqual(A.links.pending(), []);
    assert.deepEqual(A.sawDown, []);
    // Three members: Gamma's copy got out, so the link is ended there and here, never left live.
    A.withholdLinks.clear();
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    A.onFetch = (peerId, path) => {
      if (peerId === "b" && path.startsWith("/api/sessions/")) A.withholdLinks.add("b");
    };
    r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "c", session: "sc" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.member, 2);
    await settle();
    assert.ok(A.links.all().every((l) => l.endedAt !== undefined), "no live local link");
    assert.ok(C.links.all().length === 1 && C.links.all()[0]!.endedAt !== undefined, "Gamma's copy is ended");
    assert.equal(B.links.all().length, 0);
    assert.deepEqual(A.links.pending(), []);
    assert.deepEqual(A.sawDown, []);
  });

  test("a refused link's copy held for a host that was down never reaches it live, even once that host is back", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    let copyFailed = false;
    A.onFetch = (peerId, path) => {
      // B's grant drops after its lookup; C's copy finds it down once, then C is back (for the end).
      if (peerId === "b" && path.startsWith("/api/sessions/")) A.withholdLinks.add("b");
      if (peerId === "c") {
        if (path === "/api/peer/links" && !copyFailed) {
          copyFailed = true;
          C.up = false;
        } else C.up = true;
      }
    };
    const r = await act<LinkError>(A, "POST", "/api/mesh/links", { members: [{ session: "sa" }, { host: "c", session: "sc" }, { host: "b", session: "sb" }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.member, 2);
    assert.ok(copyFailed, "C's copy was held, not sent");
    await settle();
    C.up = true;
    await A.links.flush();
    await settle();
    C.links.forgetForTest();
    assert.deepEqual(
      C.links.all().filter((l) => l.endedAt === undefined),
      [],
      "no live link on C",
    );
    assert.deepEqual(
      A.links.pending().filter((e) => e.kind === "link"),
      [],
      "no creation copy still held",
    );
    assert.ok(A.links.all().every((l) => l.endedAt !== undefined), "no live local link");
    assert.equal(B.links.all().length, 0);
  });

  test("a message to a peer this host stopped sharing links with is refused, never held as if the peer were down", async () => {
    await link();
    A.withholdLinks.add("b");
    const r = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "hi" });
    assert.equal(r.status, 200);
    assert.equal(r.json.deliveries[0]!.state, "refused");
    assert.deepEqual(A.links.pending(), []);
    assert.deepEqual(A.sawDown, []);
    assert.equal(B.delivered.length, 0);
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
    // The "<host>/<session>" form link_members and the tag line show, host part in any case.
    const pair = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x", to: "BETA/sb" });
    assert.deepEqual(pair.json.deliveries.map((d) => d.to.sessionId), ["sb"]);
    const byPeerId = await act<LinkSendResult>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x", to: ["c/sc"] });
    assert.deepEqual(byPeerId.json.deliveries.map((d) => d.to.sessionId), ["sc"]);
    // A host that doesn't hold that session is no match.
    r = await act<LinkError>(A, "POST", "/api/mesh/links/send", { session: "sa", text: "x", to: "Beta/sc" });
    assert.equal(r.status, 400);
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
    const relayed = await A.app.request("/api/mesh/links", { headers: { "X-Sova-Relayed": "1" } });
    assert.equal(relayed.status, 404);
    const behindServe = await A.app.request("/api/mesh/links", { headers: { "X-Forwarded-Host": "host.example.ts.net:8443" } });
    assert.equal(behindServe.status, 200);
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
    // As last known: its title and model stay, never the bare session id.
    assert.equal(rows[0]!.title, "title sb");
    assert.equal(rows[0]!.model, "p/m");
    assert.equal(rows[0]!.lastActivity, 1000);
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

// ---- file offers (§mesh.links/offers, §mesh.links/transfer) ----------------------------------------

/** A small tree under the host's own work dir: proj/ (a few files, a symlink) and notes.md. */
function makeTree(h: Host): string {
  const work = join(h.root, "work");
  mkdirSync(join(work, "proj", "src"), { recursive: true });
  writeFileSync(join(work, "proj", "src", "a.txt"), "alpha\n".repeat(5000));
  writeFileSync(join(work, "proj", "b.bin"), Buffer.alloc(200_000, 7));
  writeFileSync(join(work, "notes.md"), "# notes\n");
  return work;
}

/** Every host's sessions work in their own dir, so offers resolve against real paths. */
function workIn(h: Host, sid: string): string {
  const cwd = join(h.root, "work");
  mkdirSync(cwd, { recursive: true });
  h.sessions.set(sid, summary(sid, { cwd }));
  return cwd;
}

const offerOf = (h: Host, id: string) => h.links.transfers.get(id);
const rowFor = (o: LinkOffer | null, h: Host) => o?.recipients.find((r) => r.to.nodeId === h.nodeId);
const spools = (h: Host) => {
  try {
    return readdirSync(join(h.root, "mesh-links", "spool"));
  } catch {
    return [];
  }
};
const wakes = (h: Host) => h.delivered.filter((d) => /^File offer of_[0-9a-f]{16} .*(finished|failed for a recipient)/m.test(parseLinkMessage(d.framed)?.text ?? ""));

async function offer(body: Record<string, unknown>, from: Host = A): Promise<{ status: number; json: LinkOfferCreateResult & LinkError }> {
  return act<LinkOfferCreateResult & LinkError>(from, "POST", "/api/mesh/links/offers", { session: "sa", ...body });
}

describe("file offers (§mesh.links/offers, §mesh.links/transfer)", () => {
  beforeEach(() => {
    for (const h of [A, B]) workIn(h, h === A ? "sa" : "sb");
    makeTree(A);
  });

  test("dest given: the recipient's host pulls it with no turn, it lands, one notice each side", async () => {
    await link();
    const r = await offer({ paths: ["proj", "notes.md"], dest: "in" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.offer.id;
    assert.match(id, /^of_[0-9a-f]{16}$/);
    assert.deepEqual(
      r.json.offer.roots.map((x) => [x.name, x.kind]),
      [
        ["proj", "dir"],
        ["notes.md", "file"],
      ],
    );
    assert.equal(r.json.deliveries[0]!.state, "accepted");
    const dest = join(B.root, "work", "in");
    assert.equal((r.json.deliveries[0] as { resolvedDest?: string }).resolvedDest, dest);
    // No turn on B until the files have landed.
    assert.equal(B.delivered.length, 0);
    await until(() => rowFor(offerOf(A, id), B)?.state === "done", 15_000, "the sender's row done");
    assert.equal(readFileSync(join(dest, "proj", "src", "a.txt"), "utf8"), "alpha\n".repeat(5000));
    assert.equal(statSync(join(dest, "proj", "b.bin")).size, 200_000);
    assert.equal(readFileSync(join(dest, "notes.md"), "utf8"), "# notes\n");
    await until(() => B.delivered.length === 1 && wakes(A).length === 1, 5_000, "the two notices");
    const landed = parseLinkMessage(B.delivered[0]!.framed)!;
    assert.equal(landed.linkId, r.json.offer.linkId);
    assert.match(landed.text, new RegExp(`File transfer ${id} from "title sa" landed in ${dest}: proj/, notes.md`));
    const wake = parseLinkMessage(wakes(A)[0]!.framed)!;
    assert.equal(wake.from.sessionId, "sb");
    assert.match(wake.text, /is finished:\n- Beta\/sb: done into /);
    // The spool is gone; B's row says done with the bytes; the offer is in both threads.
    await until(() => spools(A).length === 0, 2_000, "the spool removed");
    const bRow = offerOf(B, id)!.recipients[0]!;
    assert.equal(bRow.state, "done");
    assert.equal(bRow.received, offerOf(A, id)!.snapshot!.size);
    assert.equal(offerOf(B, id)!.snapshot?.sha256, offerOf(A, id)!.snapshot!.sha256);
    const thread = await act<LinkThread>(B, "GET", `/api/links/${r.json.offer.linkId}/thread`);
    assert.deepEqual(
      thread.json.offers?.map((o) => o.id),
      [id],
    );
    // dest given: one inbox record on B, moved on to landed.
    const recs = thread.json.messages.filter((m) => m.offer?.id === id && m.dir === "in" && m.to[0]?.sessionId === "sb");
    assert.deepEqual(
      recs.map((m) => m.offer?.event),
      ["landed"],
    );
    assert.equal(statSync(join(A.root, "mesh-links", r.json.offer.linkId, "offers.json")).mode & 0o777, 0o600);
  });

  test("no dest: the recipient's agent gets the offer, accepts it through its host, and it lands", async () => {
    await link();
    const r = await offer({ paths: ["proj"], note: "the repo" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.offer.id;
    assert.deepEqual(r.json.deliveries[0], { to: { nodeId: B.nodeId, sessionId: "sb" }, state: "offered", delivery: "started" });
    const msg = parseLinkMessage(B.delivered[0]!.framed)!;
    assert.match(msg.text, new RegExp(`^File offer ${id}: 1 path \\(proj/\\), 2 files, .*Note: the repo.*link_accept \\{offer:"${id}"`, "s"));
    // A peer can't answer for it; the session must be one B runs.
    let a = await act<LinkError>(B, "POST", `/api/mesh/links/offers/${id}/accept`, { session: "nope", dest: "in" });
    assert.equal(a.status, 403);
    a = await act<LinkError>(B, "POST", `/api/mesh/links/offers/${id}/accept`, { session: "sb", dest: "~nobody/x" });
    assert.equal(a.json.reason, "bad-dest");
    assert.equal(offerOf(B, id)!.recipients[0]!.state, "offered");
    const ok = await act<LinkOffer>(B, "POST", `/api/mesh/links/offers/${id}/accept`, { session: "sb", dest: "got" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.recipients[0]!.state, "accepted");
    await until(() => rowFor(offerOf(A, id), B)?.state === "done", 15_000, "done");
    assert.ok(existsSync(join(B.root, "work", "got", "proj", "b.bin")));
    await until(() => B.delivered.length === 2 && wakes(A).length === 1, 5_000, "notices");
    assert.match(parseLinkMessage(B.delivered[1]!.framed)!.text, /landed in .*got: proj\//);
    // Answered already: a second accept is refused.
    a = await act<LinkError>(B, "POST", `/api/mesh/links/offers/${id}/accept`, { session: "sb", dest: "again" });
    assert.equal(a.status, 409);
    const list = await act<LinkOffersList>(A, "GET", "/api/mesh/links/offers?session=sa");
    assert.deepEqual(
      list.json.offers.map((o) => o.id),
      [id],
    );
  });

  test("a decline is final; the sender is woken once and the spool goes", async () => {
    await link();
    const r = await offer({ paths: ["notes.md"] });
    const id = r.json.offer.id;
    const d = await act<LinkOffer>(B, "POST", `/api/mesh/links/offers/${id}/decline`, { session: "sb", reason: "not now" });
    assert.equal(d.json.recipients[0]!.state, "declined");
    const row = rowFor(offerOf(A, id), B)!;
    assert.equal(row.state, "declined");
    assert.equal(row.message, "not now");
    await until(() => wakes(A).length === 1, 3_000, "the wake");
    assert.match(parseLinkMessage(wakes(A)[0]!.framed)!.text, /- Beta\/sb: declined: not now/);
    await until(() => spools(A).length === 0, 3_000, "spool removed");
    // A report after the end changes nothing, and never wakes twice.
    const again = await B.links.transfers.get(id);
    assert.ok(again);
    await settle();
    assert.equal(wakes(A).length, 1);
  });

  test("a TUI-live recipient of an offer without dest is refused, final; with dest the files still land", async () => {
    await link();
    B.answer = { state: "refused", reason: "tui-live", message: "open in a terminal" };
    const r = await offer({ paths: ["notes.md"] });
    assert.equal(r.json.deliveries[0]!.state, "refused");
    assert.equal((r.json.deliveries[0] as { reason?: string }).reason, "tui-live");
    assert.equal(rowFor(offerOf(A, r.json.offer.id), B)!.state, "refused");
    assert.equal(offerOf(A, r.json.offer.id)!.wokeSender, true, "a refusal at the POST is in the tool's result: no wake");
    const r2 = await offer({ paths: ["notes.md"], dest: "in" });
    await until(() => rowFor(offerOf(A, r2.json.offer.id), B)?.state === "done", 15_000, "done");
    assert.ok(existsSync(join(B.root, "work", "in", "notes.md")));
    await until(() => (offerOf(B, r2.json.offer.id) ? true : false) && wakes(A).length === 1, 3_000, "wake");
    assert.equal(wakes(A).length, 1);
  });

  test("an old-build recipient is refused, final and never queued; the others proceed", async () => {
    const C = makeHost("c", "Gamma", { old: true });
    C.sessions.set("sc", summary("sc"));
    // A build without links can't be linked; so link a,b first, then give the link to c by hand.
    const v = await link();
    const l = { ...v.link, members: [...v.link.members, { nodeId: C.nodeId, sessionId: "sc", path: "/sessions/sc.jsonl" }] };
    A.links.forgetForTest();
    writeFileSync(join(A.root, "mesh-links.json"), JSON.stringify({ version: 1, links: [l] }));
    const r = await offer({ paths: ["notes.md"], to: "all", dest: "in" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = r.json.deliveries.find((d) => d.to.nodeId === C.nodeId)!;
    assert.equal(c.state, "refused");
    assert.equal((c as { reason?: string }).reason, "old-build");
    assert.equal(A.links.pending().length, 0);
    await until(() => rowFor(offerOf(A, r.json.offer.id), B)?.state === "done", 15_000, "b done");
    await until(() => wakes(A).length === 1, 3_000, "wake");
  });

  test("a recipient whose host is down gets the offer from the outbox and pulls when it is back", async () => {
    await link();
    B.up = false;
    const r = await offer({ paths: ["proj"], dest: "in" });
    assert.deepEqual(r.json.deliveries[0]!.state, "outbox");
    assert.equal(A.links.pending()[0]!.kind, "offer");
    B.up = true;
    for (const fn of A.peerUp) fn("b");
    await until(() => rowFor(offerOf(A, r.json.offer.id), B)?.state === "done", 15_000, "done after the outbox");
    assert.ok(existsSync(join(B.root, "work", "in", "proj", "src", "a.txt")));
    assert.equal(A.links.pending().length, 0);
  });

  test("a pull cut mid-way resumes from its .part with Range; the hash matches", async () => {
    await link();
    B.cutTarAt = 1000;
    writeFileSync(join(A.root, "work", "proj", "rand.bin"), randomBytes(300_000));
    const r = await offer({ paths: ["proj"], dest: "in" });
    const id = r.json.offer.id;
    await until(() => rowFor(offerOf(A, id), B)?.state === "done", 15_000, "done after a resume");
    assert.ok((offerOf(B, id)!.recipients[0]!.retries ?? 0) >= 1);
    assert.equal(statSync(join(B.root, "work", "in", "proj", "rand.bin")).size, 300_000);
  });

  test("the first failure wakes the sender at once; the rest finishing doesn't wake it again", async () => {
    const C = makeHost("c", "Gamma");
    workIn(C, "sc");
    await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    // B's sandbox reads as off at the accept and as unresolvable at the pre-scan: refused after it accepted.
    let calls = 0;
    B.sandbox = () => (calls++ === 0 ? { on: false } : { on: true, error: "policy gone" });
    // C's download waits until B's failure has woken the sender: C is still moving then.
    let releaseC!: () => void;
    C.holdTar = new Promise((r) => (releaseC = r));
    const r = await offer({ paths: ["proj"], to: "all", dest: "in" });
    const id = r.json.offer.id;
    await until(() => rowFor(offerOf(A, id), B)?.state === "refused", 15_000, "b refused");
    assert.equal(rowFor(offerOf(A, id), B)!.reason, "not-writable");
    await until(() => wakes(A).length === 1, 3_000, "the first-failure wake");
    assert.match(parseLinkMessage(wakes(A)[0]!.framed)!.text, /failed for a recipient/);
    releaseC();
    await until(() => rowFor(offerOf(A, id), C)?.state === "done", 15_000, "c done");
    await settle();
    assert.equal(wakes(A).length, 1);
    assert.equal(existsSync(join(B.root, "work", "in", "proj")), false, "nothing extracted on b");
  });

  test("final reports back to back wake the sender exactly once", async () => {
    const C = makeHost("c", "Gamma");
    workIn(C, "sc");
    const v = await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    const r = await offer({ paths: ["notes.md"], to: "all" });
    const id = r.json.offer.id;
    const rep = (from: Host, sid: string) =>
      A.app.request(`/api/peer/links/${v.link.id}/offers/${id}/result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: sid, state: "declined" }) }, { meshPeer: entryOf(from) });
    const answers = await Promise.all([rep(B, "sb"), rep(C, "sc"), rep(C, "sc"), rep(B, "sb")]);
    assert.deepEqual(
      answers.map((a) => a.status),
      [200, 200, 200, 200],
    );
    await until(() => wakes(A).length === 1, 3_000, "the wake");
    await settle();
    await settle();
    assert.equal(wakes(A).length, 1);
    assert.equal(offerOf(A, id)!.wokeSender, true);
  });

  test("ending the link cancels its open offers on every host; the spool goes and pulls get 410", async () => {
    const v = await link();
    const r = await offer({ paths: ["proj"] });
    const id = r.json.offer.id;
    await until(() => offerOf(A, id)?.packing?.state === "ready", 10_000, "packed");
    await act(A, "POST", `/api/mesh/links/${v.link.id}/end`);
    await settle();
    assert.equal(rowFor(offerOf(A, id), B)!.state, "cancelled");
    assert.equal(offerOf(B, id)!.recipients[0]!.state, "cancelled");
    assert.equal(spools(A).length, 0);
    const res = await A.app.request(`/api/peer/links/${v.link.id}/offers/${id}/tar`, {}, { meshPeer: entryOf(B) });
    assert.equal(res.status, 410);
    assert.ok(((await res.json()) as LinkError).reason);
    assert.equal(wakes(A).length, 0, "a cancelled offer wakes nobody");
  });

  test("peer routes: tar only to a recipient host, 503 while packing, reports only from the row's host", async () => {
    const C = makeHost("c", "Gamma");
    workIn(C, "sc");
    const v = await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    const r = await offer({ paths: ["notes.md"], to: "sb" });
    const id = r.json.offer.id;
    const tar = (from: Host) => A.app.request(`/api/peer/links/${v.link.id}/offers/${id}/tar`, {}, { meshPeer: entryOf(from) });
    assert.equal((await tar(C)).status, 403);
    assert.equal((await tar(B)).status, 403, "not accepted yet");
    // A fake offer still packing: 503 with Retry-After.
    const packing = { ...offerOf(A, id)!, id: "of_00000000000000ff", recipients: [{ to: { nodeId: B.nodeId, sessionId: "sb" }, state: "accepted" as const }] };
    delete (packing as Partial<LinkOffer>).snapshot;
    A.links.transfers.put({ ...packing, packing: { state: "packing", written: 0 } });
    const p = await A.app.request(`/api/peer/links/${v.link.id}/offers/of_00000000000000ff/tar`, {}, { meshPeer: entryOf(B) });
    assert.equal(p.status, 503);
    assert.equal(p.headers.get("Retry-After"), "5");
    const rep = (from: Host, body: unknown) =>
      A.app.request(`/api/peer/links/${v.link.id}/offers/${id}/result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { meshPeer: entryOf(from) });
    assert.equal((await rep(C, { session: "sc", state: "declined" })).status, 403);
    assert.equal((await rep(B, { session: "sb", state: "bogus" })).status, 400);
    assert.equal((await rep(B, { session: "sb", state: "declined" })).status, 200);
    assert.equal((await rep(B, { session: "sb", state: "done" })).status, 200, "idempotent: a final row stays");
    assert.equal(rowFor(offerOf(A, id), B)!.state, "declined");
    // Local acts never answer the peer listener.
    const peerAct = await A.app.request("/api/mesh/links/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: "sa", paths: ["x"] }) }, { meshPeer: entryOf(B) });
    assert.equal(peerAct.status, 404);
  });

  test("the sender's acts refuse cleanly: same names, missing paths, a dest for a non-recipient", async () => {
    const C = makeHost("c", "Gamma");
    workIn(C, "sc");
    await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    mkdirSync(join(A.root, "work", "other"), { recursive: true });
    writeFileSync(join(A.root, "work", "other", "notes.md"), "x");
    let r = await offer({ paths: ["notes.md", "other/notes.md"], to: "sb" });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, "same-name");
    r = await offer({ paths: ["nope"], to: "sb" });
    assert.equal(r.json.reason, "no-path");
    r = await offer({ paths: ["notes.md"], to: "sb", dest: { sc: "in" } });
    assert.equal(r.json.reason, "bad-dest");
    r = await offer({ paths: ["notes.md"], to: "all", dest: { sb: "in" } });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.deliveries.map((d) => [d.to.sessionId, d.state]),
      [
        ["sb", "accepted"],
        ["sc", "offered"],
      ],
    );
    // A dest in Sova's own state on the recipient: refused there, final, in the answer.
    r = await offer({ paths: ["notes.md"], to: "sb", dest: join(B.root, "state", "x") });
    assert.equal((r.json.deliveries[0] as { reason?: string }).reason, "protected");
    assert.equal(A.links.all().length, 1);
    // Every refusal carries a reason (the link client reads a bare 404 as an old build).
    const bad = await act<LinkError>(A, "POST", "/api/mesh/links/offers/of_0000000000000000/accept", { session: "sa", dest: "x" });
    assert.equal(bad.status, 404);
    assert.ok(bad.json.reason);
  });

  test("expiry: an unanswered offer expires on both hosts; the sender is woken once", async () => {
    await link();
    const r = await offer({ paths: ["notes.md"] });
    const id = r.json.offer.id;
    A.clock += 25 * 3_600_000;
    B.clock += 25 * 3_600_000;
    A.links.transfers.sweep();
    B.links.transfers.sweep();
    assert.equal(rowFor(offerOf(A, id), B)!.state, "expired");
    assert.equal(offerOf(B, id)!.recipients[0]!.state, "expired");
    await until(() => wakes(A).length === 1, 3_000, "wake");
    const late = await act<LinkError>(B, "POST", `/api/mesh/links/offers/${id}/accept`, { session: "sb", dest: "in" });
    assert.equal(late.status, 409);
    await until(() => spools(A).length === 0, 3_000, "spool removed");
  });

  test("the pane: a transfer chip on the member's row while it moves, none once final", async () => {
    await link();
    const r = await offer({ paths: ["notes.md"] });
    const rows = await A.links.linkedAgents("sa");
    assert.deepEqual(rows[0]!.transfer && { dir: rows[0]!.transfer.dir, state: rows[0]!.transfer.state, offerId: rows[0]!.transfer.offerId }, { dir: "in", state: "offered", offerId: r.json.offer.id });
    const bRows = await B.links.linkedAgents("sb");
    assert.equal(bRows[0]!.transfer?.dir, "out");
    await act(B, "POST", `/api/mesh/links/offers/${r.json.offer.id}/decline`, { session: "sb" });
    assert.equal((await A.links.linkedAgents("sa"))[0]!.transfer, undefined);
  });
});

// ---- a host's names (§mesh.links/host-names) -------------------------------------------------------

/** A host restarted on the same state: a fresh MeshLinks reading its records from disk. */
function restart(h: Host, change: Partial<Host> = {}): Host {
  h.links.stop();
  return makeHost(h.id, h.label, { root: h.root, sessions: h.sessions, held: h.held, knowsSelf: h.knowsSelf, lanPin: h.lanPin, lanWith: h.lanWith, clock: h.clock, ...change });
}
const linkOn = (h: Host, members: Array<{ host?: string; session: string }>) => act<MeshLinkView & LinkError>(h, "POST", "/api/mesh/links", { members });
const send = (h: Host, session: string, text: string) => act<LinkSendResult & LinkError>(h, "POST", "/api/mesh/links/send", { session, text });
const lastText = (h: Host) => parseLinkMessage(h.delivered.at(-1)?.framed ?? "")?.text;

describe("a host's names (§mesh.links/host-names)", () => {
  // Alpha is on a tailnet and LAN-paired with Beta; Beta has no tailnet identity (LAN only).
  beforeEach(() => {
    B.knowsSelf = false;
    pairLan(A, B);
    for (const h of [A, B]) workIn(h, h === A ? "sa" : "sb");
    makeTree(A);
    makeTree(B);
  });

  test("a tailnet + LAN host links with a LAN-only host: each keeps it in its own terms; messages, offers and the end go both ways", async () => {
    const v = await link();
    const id = v.link.id;
    assert.deepEqual(
      v.link.members.map((m) => m.nodeId),
      [A.nodeId, lanId(B)],
    );
    const onB = B.links.get(id);
    assert.ok(onB, "Beta holds the link");
    assert.equal(onB.createdBy, lanId(A));
    assert.deepEqual(
      onB.members.map((m) => m.nodeId),
      [lanId(A), lanId(B)],
    );
    assert.equal(B.links.localMember(onB)?.sessionId, "sb");
    assert.equal(A.links.localMember(A.links.get(id)!)?.sessionId, "sa");
    let s = await send(A, "sa", "hello Beta");
    assert.equal(s.json.deliveries?.[0]?.state, "started", JSON.stringify(s.json));
    assert.equal(lastText(B), "hello Beta");
    s = await send(B, "sb", "hello Alpha");
    assert.equal(s.json.deliveries?.[0]?.state, "started", JSON.stringify(s.json));
    assert.equal(lastText(A), "hello Alpha");
    // Alpha → Beta with dest: Beta pulls it at once.
    let r = await offer({ paths: ["notes.md"], dest: "in" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const o1 = r.json.offer.id;
    await until(() => offerOf(A, o1)?.recipients[0]?.state === "done", 15_000, "Alpha's offer done");
    assert.ok(existsSync(join(B.root, "work", "in", "notes.md")));
    // Beta → Alpha without dest: Alpha's agent accepts it.
    r = await offer({ session: "sb", paths: ["notes.md"] }, B);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const o2 = r.json.offer.id;
    assert.equal(r.json.deliveries[0]!.state, "offered", JSON.stringify(r.json.deliveries));
    const ok = await act<LinkOffer>(A, "POST", `/api/mesh/links/offers/${o2}/accept`, { session: "sa", dest: "got" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    await until(() => offerOf(B, o2)?.recipients[0]?.state === "done", 15_000, "Beta's offer done");
    assert.ok(existsSync(join(A.root, "work", "got", "notes.md")));
    for (const [h, sid] of [
      [A, "sa"],
      [B, "sb"],
    ] as const) {
      const list = await act<LinkOffersList>(h, "GET", `/api/mesh/links/offers?session=${sid}`);
      assert.deepEqual(list.json.offers.map((o) => o.id).sort(), [o1, o2].sort(), h.label);
    }
    await act<MeshLinkView>(B, "POST", `/api/mesh/links/${id}/end`);
    await settle();
    assert.notEqual(A.links.get(id)!.endedAt, undefined, "Beta's end reached Alpha");
  });

  test("a LAN-only host links with a tailnet + LAN host: the copy naming it lan:<pin> is taken as itself", async () => {
    const r = await linkOn(B, [{ session: "sb" }, { host: "a", session: "sa" }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const onA = A.links.get(r.json.link.id);
    assert.ok(onA, "Alpha holds the link");
    assert.equal(onA.createdBy, lanId(B));
    assert.deepEqual(
      onA.members.map((m) => m.nodeId),
      [lanId(B), A.nodeId],
    );
    let s = await send(B, "sb", "from Beta");
    assert.equal(s.json.deliveries?.[0]?.state, "started", JSON.stringify(s.json));
    s = await send(A, "sa", "from Alpha");
    assert.equal(s.json.deliveries?.[0]?.state, "started", JSON.stringify(s.json));
    assert.equal(lastText(B), "from Alpha");
  });

  test("a link with a member on a LAN pairing joins only two hosts: a third one is refused up front", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    let r = await linkOn(A, [{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.reason, "lan-pairing");
    assert.equal(r.json.member, 1);
    assert.match(r.json.error, /Beta is a LAN pairing/);
    // The Overseer linking the pairing with another peer makes three hosts too.
    r = await linkOn(A, [{ host: "c", session: "sc" }, { host: "b", session: "sb" }]);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.reason, "lan-pairing");
    assert.equal(r.json.member, 1);
    for (const h of [A, B, C]) assert.equal(h.links.all().length, 0, h.label);
    assert.deepEqual(A.links.pending(), []);
    r = await linkOn(A, [{ session: "sa" }, { host: "c", session: "sc" }]);
    assert.equal(r.status, 200, "a tailnet pair is still linked");
  });

  test("a copy naming a host this host doesn't know is refused, never stored", async () => {
    const link = {
      id: "lk_00000000000000aa",
      createdAt: 1,
      createdBy: lanId(A),
      members: [
        { nodeId: lanId(A), sessionId: "sa", path: "/x" },
        { nodeId: lanId(B), sessionId: "sb", path: "/y" },
        { nodeId: "node-zz", sessionId: "sz", path: "/z" },
      ],
    };
    const res = await B.app.request(
      "/api/peer/links",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link, you: lanId(B) }) },
      { meshPeer: entryOf(A, B) },
    );
    assert.equal(res.status, 403);
    const j = (await res.json()) as LinkError;
    assert.equal(j.reason, "not-member");
    assert.match(j.error, /doesn't know/);
    assert.equal(B.links.all().length, 0);
  });

  test("how a peer knows this host is kept from its whoami answer and names a held message after a restart", async () => {
    await link();
    const file = JSON.parse(readFileSync(join(A.root, "mesh-links.json"), "utf8")) as { selfAs?: Record<string, string> };
    assert.equal(file.selfAs?.[lanId(B)], lanId(A));
    B.up = false;
    const s = await send(A, "sa", "while you slept");
    assert.equal(s.json.deliveries?.[0]?.state, "outbox");
    // After the restart the mesh can't say how Beta knows Alpha: only the kept answer can.
    A = restart(A, { noSelfFor: true });
    B.up = true;
    await A.links.flush();
    assert.equal(lastText(B), "while you slept");
    assert.deepEqual(A.links.pending(), []);
  });

  test("a LAN-only host's link and offer still work after it joins a tailnet: its records take its new name", async () => {
    A.knowsSelf = false;
    const v = await link();
    const id = v.link.id;
    assert.equal(v.link.createdBy, lanId(A));
    let r = await offer({ paths: ["proj"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const o1 = r.json.offer.id;
    await until(() => offerOf(A, o1)?.snapshot !== undefined, 15_000, "the first offer packed");
    A = restart(A, { knowsSelf: true });
    const onA = A.links.get(id)!;
    assert.equal(onA.createdBy, A.nodeId);
    assert.deepEqual(
      onA.members.map((m) => m.nodeId),
      [A.nodeId, lanId(B)],
    );
    assert.equal(offerOf(A, o1)?.from.nodeId, A.nodeId);
    const disk = JSON.parse(readFileSync(join(A.root, "mesh-links.json"), "utf8")) as { links: Array<{ id: string; createdBy: string }> };
    assert.equal(disk.links.find((l) => l.id === id)?.createdBy, A.nodeId, "rewritten on disk");
    const list = await act<LinksList>(A, "GET", "/api/mesh/links?session=sa");
    assert.equal(list.json.links[0]?.members.find((m) => m.sessionId === "sa")?.self, true);
    // A new offer, pulled from the renamed host and reported back to it.
    r = await offer({ paths: ["notes.md"], dest: "in2" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const o2 = r.json.offer.id;
    await until(() => offerOf(A, o2)?.recipients[0]?.state === "done", 15_000, "the new offer done");
    // The offer made before the restart, accepted now.
    const ok = await act<LinkOffer>(B, "POST", `/api/mesh/links/offers/${o1}/accept`, { session: "sb", dest: "old" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    await until(() => offerOf(A, o1)?.recipients[0]?.state === "done", 15_000, "the old offer done");
    assert.ok(existsSync(join(B.root, "work", "old", "proj", "b.bin")));
    const offers = await act<LinkOffersList>(A, "GET", "/api/mesh/links/offers?session=sa");
    assert.deepEqual(offers.json.offers.map((o) => o.id).sort(), [o1, o2].sort());
  });
});

describe("a refused copy (§app.overseer/links-tools, §mesh.links/delivery)", () => {
  test("a member host that refuses its copy: the link is not made, naming the member and the host's reason", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    A.onFetch = (peerId, path) => {
      if (peerId === "c" && path === "/api/peer/links") C.sessions.delete("sc");
    };
    const r = await linkOn(A, [{ session: "sa" }, { host: "c", session: "sc" }]);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.member, 1);
    assert.equal(r.json.reason, "no-session");
    assert.match(r.json.error, /Gamma refused the link/);
    assert.equal(A.links.all().length, 0, "forgotten: no copy got out");
    assert.deepEqual(A.links.pending(), []);
  });

  test("a copy whose answer was lost may have been taken: that host is told the end, so no live link stays", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    let lost = false;
    A.loseAnswer = (peerId, path) => {
      if (peerId !== "b" || path !== "/api/peer/links" || lost) return false;
      lost = true;
      return true;
    };
    A.onFetch = (peerId, path) => {
      if (peerId === "c" && path === "/api/peer/links") C.sessions.delete("sc");
    };
    const r = await linkOn(A, [{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.member, 2);
    assert.equal(r.json.reason, "no-session");
    assert.ok(lost, "Beta's answer was lost");
    await settle();
    await A.links.flush();
    await settle();
    B.links.forgetForTest();
    assert.equal(B.links.all().length, 1, "Beta took the copy");
    assert.deepEqual(
      B.links.all().filter((l) => l.endedAt === undefined),
      [],
      "no live link on Beta",
    );
    assert.ok(A.links.all().every((l) => l.endedAt !== undefined), "no live local link");
    assert.deepEqual(A.links.pending(), []);
  });

  test("a held copy refused once its host is back ends the link everywhere, saying why", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    let held = false;
    A.onFetch = (peerId, path) => {
      if (peerId === "c" && path === "/api/peer/links" && !held) {
        held = true;
        C.up = false;
      }
    };
    const v = await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    assert.ok(held);
    C.up = true;
    C.sessions.delete("sc");
    await A.links.flush();
    await settle();
    const onA = A.links.get(v.link.id)!;
    assert.notEqual(onA.endedAt, undefined);
    assert.match(onA.endedWhy ?? "", /Gamma refused the link/);
    const onB = B.links.get(v.link.id)!;
    assert.notEqual(onB.endedAt, undefined, "ended on Beta too");
    assert.equal(onB.endedWhy, onA.endedWhy);
    const s = await send(B, "sb", "still there?");
    assert.equal(s.status, 409);
    assert.match(s.json.error, /has ended: Gamma refused the link/);
  });
});

describe("follow-up: tailnet strangers and a stalled copy", () => {
  test("a tailnet-only link naming a host this member doesn't peer is kept there, that host shown as unreachable", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    B.hidePeers.add("c");
    const v = await link([{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    const onB = B.links.get(v.link.id);
    assert.ok(onB, "Beta holds the link");
    const [view] = await B.links.list({ sessionId: "sb" });
    assert.equal(view?.members.find((m) => m.sessionId === "sc")?.reach, "unknown-host");
  });

  test("a copy stalled past the hop timeout, then refused elsewhere: the rollback still leaves no live link once it lands", async () => {
    const C = makeHost("c", "Gamma");
    C.sessions.set("sc", summary("sc"));
    let release!: () => void;
    let detached = false;
    A.detachAnswer = (peerId, path) => {
      if (peerId !== "b" || path !== "/api/peer/links" || detached) return false;
      detached = true;
      // Beta's lookup of its member session hangs until released.
      B.stall = new Promise<void>((r) => (release = r));
      return true;
    };
    A.onFetch = (peerId, path) => {
      if (peerId === "c" && path === "/api/peer/links") C.sessions.delete("sc");
    };
    const r = await linkOn(A, [{ session: "sa" }, { host: "b", session: "sb" }, { host: "c", session: "sc" }]);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.member, 2);
    assert.ok(detached, "Beta's copy timed out on Alpha's side");
    await settle();
    // Now Beta's stalled handler finishes and stores what it was given.
    B.stall = undefined;
    release();
    await Promise.all(B.detached.concat(A.detached));
    await settle();
    for (let i = 0; i < 3; i++) {
      await A.links.flush();
      await settle();
    }
    B.links.forgetForTest();
    assert.deepEqual(
      B.links.all().filter((l) => l.endedAt === undefined),
      [],
      "no live link on Beta",
    );
    assert.ok(A.links.all().every((l) => l.endedAt !== undefined), "no live local link");
    assert.deepEqual(A.links.pending(), []);
  });
});
