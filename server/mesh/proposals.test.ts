// §mesh.lan/proposals: an extension proposes, Sova asks. The store's rules over fake mesh deps (what waits, what
// applies at once, whose links an extension may touch, expiry and retries), then the real routes' doors: who may
// propose, and that only the person's page answers. Applying a real pairing (sockets) is in the integration sibling.
import { dropScratchAgentDir, scratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { grantCaps, MESH_CAPS, MESH_PRESETS, type MeshGrant, type MeshPreset } from "../../shared/mesh-access";
import type { LanPairingAdd } from "../../shared/mesh-lan";
import { PROPOSAL_TTL_MS, WAITING_MAX, type MeshProposal } from "../../shared/mesh-proposals";
import { MeshProposals, NO_SUCH_LINK, NOT_ITS_LINK, type ProposalDeps, type Result } from "./proposals";
import type { PeerEntry } from "./peers";

after(() => dropScratchAgentDir());

const PIN = "0123456789ABCDEF0123456789ABCDEF";
const PIN2 = "FEDCBA9876543210FEDCBA9876543210";
const OK: Result = { status: 200, body: {} };

/** A mesh in memory: peers, grants and a relay, changed only through the deps the store calls. */
function rig(opts: { pairResult?: Result } = {}) {
  let now = 1_000_000;
  const peers: PeerEntry[] = [];
  const grants = new Map<string, MeshGrant>();
  let relay: { host: string; port: number } | null = null;
  const calls: string[] = [];
  const published: MeshProposal[][] = [];
  const linksFile = join(scratchAgentDir, `links-${Math.random().toString(36).slice(2)}.json`);
  const deps: ProposalDeps = {
    now: () => now,
    ownPin: () => undefined,
    ensureKey: () => ({ pin: PIN2 }),
    peers: () => peers,
    selfId: () => "this-mac",
    relay: () => relay,
    grantOf: (id) => grants.get(id) ?? { preset: "presence" },
    async pair(b: LanPairingAdd, o) {
      calls.push(`pair${o?.dry ? ":dry" : ""} ${b.id}`);
      if (peers.some((p) => p.id === b.id)) return { status: 400, body: { error: `${b.id} is already a host here` } };
      if (o?.dry) return OK;
      if (opts.pairResult) return opts.pairResult;
      peers.push({ id: b.id, label: b.label, nodeId: `lan:${b.pin.toLowerCase()}`, pairedAt: now, lan: b.role === "dial" ? { role: "dial", pin: b.pin, host: b.host!, port: b.port! } : { role: "accept", pin: b.pin } } as unknown as PeerEntry);
      grants.set(b.id, { preset: b.grant as MeshPreset });
      return OK;
    },
    unpair(id) {
      calls.push(`unpair ${id}`);
      const i = peers.findIndex((p) => p.id === id);
      if (i < 0) return { status: 404, body: { error: "No such pairing" } };
      peers.splice(i, 1);
      grants.delete(id);
      return OK;
    },
    setGrant(id, preset) {
      calls.push(`grant ${id} ${preset}`);
      grants.set(id, { preset });
      return OK;
    },
    setRelay(r, o) {
      calls.push(`relay${o?.dry ? ":dry" : ""} ${r ? `${r.host}:${r.port}` : "null"}`);
      if (!o?.dry) relay = r;
      return OK;
    },
    titleOf: (id) => `Title of ${id}`,
    publish: (w) => published.push(w),
    linksFile: () => linksFile,
  };
  const store = new MeshProposals(deps);
  const tick = (ms: number) => {
    now += ms;
  };
  return { store, deps, peers, grants, calls, published, linksFile, tick, setRelay: (r: typeof relay) => (relay = r), get relay() { return relay; } };
}

const proposalOf = (r: Result): MeshProposal => (r.body as { proposal: MeshProposal }).proposal;
const errOf = (r: Result): string => (r.body as { error: string }).error;
const pairBody = (over: Record<string, unknown> = {}) => ({ kind: "pair", role: "accept", peer: "co-omar", label: "Omar", fingerprint: PIN.toLowerCase().match(/.{4}/g)!.join("-"), grant: "sessions", ...over });

/** A link the extension `ext` made: proposed, then confirmed. */
async function linked(r: ReturnType<typeof rig>, ext = "company", grant: MeshPreset = "sessions", peer = "co-omar") {
  const p = proposalOf(await r.store.propose(ext, pairBody({ peer, grant })));
  assert.equal((await r.store.confirm(p.id)).status, 200);
}

describe("what waits for the person and what applies at once", () => {
  test("a new pairing always waits, and nothing is written until the person confirms", async () => {
    for (const grant of MESH_PRESETS) {
      const r = rig();
      const res = await r.store.propose("company", pairBody({ grant }));
      assert.equal(res.status, 200, errOf(res));
      const p = proposalOf(res);
      assert.equal(p.state, "waiting", grant);
      assert.equal(p.widens, true);
      assert.equal(p.fullAccess, grant === "sessions" || grant === "full", `fullAccess for ${grant}`);
      assert.equal(p.fingerprint, PIN.match(/.{4}/g)!.join("-"), "the fingerprint as people compare it");
      assert.deepEqual(r.calls, ["pair:dry co-omar"], "only checked, nothing applied");
      assert.equal(r.peers.length, 0);
      assert.deepEqual(r.published.at(-1)!.map((w) => w.id), [p.id], "every page is told it waits");
    }
  });

  test("a grant waits exactly when it gives any capability the link lacks; otherwise it applies at once", async () => {
    for (const from of MESH_PRESETS) {
      for (const to of MESH_PRESETS) {
        const r = rig();
        await linked(r, "company", from);
        r.calls.length = 0;
        const p = proposalOf(await r.store.propose("company", { kind: "grant", peer: "co-omar", grant: to }));
        const was = grantCaps({ preset: from });
        const widens = MESH_CAPS.some((c) => grantCaps({ preset: to })[c] && !was[c]);
        assert.equal(p.state, widens ? "waiting" : "applied", `${from} → ${to}`);
        assert.equal(p.from, from);
        assert.deepEqual(r.calls, widens ? [] : [`grant co-omar ${to}`], `${from} → ${to}: applied only when narrowing`);
        if (widens) {
          assert.equal(r.grants.get("co-omar")!.preset, from, "nothing given before the click");
          assert.equal((await r.store.confirm(p.id)).status, 200);
          assert.equal(r.grants.get("co-omar")!.preset, to);
        }
      }
    }
  });

  test("unpair applies at once, and the extension's note of the link goes with it", async () => {
    const r = rig();
    await linked(r);
    assert.deepEqual(r.store.links("company").map((l) => l.peer), ["co-omar"]);
    const p = proposalOf(await r.store.propose("company", { kind: "unpair", peer: "co-omar" }));
    assert.equal(p.state, "applied");
    assert.equal(r.peers.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(r.linksFile, "utf8")).links, {});
  });

  test("key makes this computer's key and gives its fingerprint, with no click", async () => {
    const r = rig();
    const res = await r.store.propose("company", { kind: "key" });
    assert.equal(proposalOf(res).state, "applied");
    assert.equal((res.body as { fingerprint: string }).fingerprint, PIN2.match(/.{4}/g)!.join("-"));
    assert.equal(r.published.length, 0, "nothing waits, so no page is told anything");
  });
});

describe("an extension touches only the links it made", () => {
  test("another extension's link and a link made on the Mesh page are refused 403, a missing one is 404, and nothing changes", async () => {
    const r = rig();
    await linked(r, "company");
    r.peers.push({ id: "my-vps", label: "VPS", nodeId: `lan:${PIN2.toLowerCase()}`, lan: { role: "dial", pin: PIN2, host: "10.0.0.2", port: 4803 } } as unknown as PeerEntry);
    r.calls.length = 0;
    for (const [ext, peer, status] of [["other-ext", "co-omar", 403], ["company", "my-vps", 403], ["company", "nobody", 404]] as const) {
      for (const body of [{ kind: "unpair", peer }, { kind: "grant", peer, grant: "none" }]) {
        const res = await r.store.propose(ext, body);
        assert.equal(res.status, status, `${ext} ${body.kind} ${peer}`);
        assert.equal(errOf(res), status === 403 ? NOT_ITS_LINK : NO_SUCH_LINK);
      }
    }
    assert.deepEqual(r.calls, []);
  });

  test("a link removed some other way and paired again, with another fingerprint or the very same one, isn't the extension's", async () => {
    for (const pin of [PIN2, PIN]) {
      const r = rig();
      await linked(r, "company");
      const was = r.peers.splice(0, 1)[0]!; // removed on the Mesh page, with nothing read since
      r.tick(1);
      r.peers.push({ id: "co-omar", label: "x", nodeId: `lan:${pin.toLowerCase()}`, pairedAt: (was as { pairedAt: number }).pairedAt + 1, lan: { role: "accept", pin } } as unknown as PeerEntry);
      for (const body of [{ kind: "unpair", peer: "co-omar" }, { kind: "grant", peer: "co-omar", grant: "none" }]) assert.equal((await r.store.propose("company", body)).status, 403, `${pin === PIN ? "same" : "other"} fingerprint, ${body.kind}`);
      assert.equal(r.peers.length, 1, "the hand-made link stays");
      assert.deepEqual(r.store.links("company"), []);
      assert.deepEqual(JSON.parse(readFileSync(r.linksFile, "utf8")).links, {});
    }
  });

  test("a pairing that goes, or is paired again, is forgotten at once by whatever route wrote peers.json", async () => {
    const { forgetLinks, goneLinks } = await import("./proposals");
    const at = (id: string, nodeId: string, pairedAt: number) => ({ id, nodeId, pairedAt }) as unknown as PeerEntry;
    const before = [at("a", "lan:1", 1), at("b", "lan:2", 2), at("c", "lan:3", 3)];
    assert.deepEqual(goneLinks(before, [at("a", "lan:1", 1), at("b", "lan:2", 9)]), ["b", "c"], "b paired again, c gone; a untouched");
    assert.deepEqual(goneLinks(before, before), []);
    const r = rig();
    await linked(r, "company");
    await linked(r, "company", "presence", "co-dana");
    forgetLinks(r.linksFile, ["co-omar"]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(r.linksFile, "utf8")).links), ["co-dana"]);
    const missing = join(scratchAgentDir, "no-such-links.json");
    forgetLinks(missing, ["co-dana"]);
    assert.equal(existsSync(missing), false, "no file is made when there is none");
  });

  test("a store no extension asked holds nothing: no file, no frame", () => {
    const r = rig();
    assert.deepEqual(r.store.waiting(), []);
    assert.deepEqual(r.store.list(null), []);
    assert.equal(existsSync(r.linksFile), false);
    assert.equal(r.published.length, 0);
    r.store.stop();
  });
});

describe("a proposal's life", () => {
  test("it expires after its time: every page is told, and a late confirm changes nothing", async () => {
    const r = rig();
    const p = proposalOf(await r.store.propose("company", pairBody()));
    r.tick(PROPOSAL_TTL_MS - 1);
    assert.equal(r.store.get(null, p.id)!.state, "waiting");
    r.tick(1);
    assert.equal(r.store.get("company", p.id)!.state, "expired");
    assert.deepEqual(r.published.at(-1), [], "the dialog closes");
    const late = await r.store.confirm(p.id);
    assert.equal(late.status, 409);
    assert.equal(r.peers.length, 0);
    r.store.stop();
  });

  test("the same pairing sent again while it waits is the one that waits; at most 10 wait per extension", async () => {
    const r = rig();
    const a = proposalOf(await r.store.propose("company", pairBody()));
    assert.equal(proposalOf(await r.store.propose("company", pairBody())).id, a.id);
    for (let i = 1; i < WAITING_MAX; i++) assert.equal((await r.store.propose("company", pairBody({ peer: `co-${i}` }))).status, 200);
    const over = await r.store.propose("company", pairBody({ peer: "co-over" }));
    assert.equal(over.status, 409);
    assert.equal((await r.store.propose("other", pairBody({ peer: "co-over" }))).status, 200, "another extension's count is its own");
    r.store.stop();
  });

  test("withdraw, decline and a second answer: each decided once, and a key sees only its own", async () => {
    const r = rig();
    const a = proposalOf(await r.store.propose("company", pairBody({ peer: "co-a" })));
    const b = proposalOf(await r.store.propose("company", pairBody({ peer: "co-b" })));
    assert.equal(r.store.withdraw("other", a.id).status, 404, "another extension can't");
    assert.equal(proposalOf(r.store.withdraw("company", a.id)).state, "withdrawn");
    assert.equal(proposalOf(r.store.decline(b.id)).state, "declined");
    assert.equal((await r.store.confirm(b.id)).status, 409);
    assert.equal(r.store.withdraw("company", b.id).status, 409);
    assert.equal(r.store.get("other", a.id), null);
    assert.deepEqual(r.store.list("other"), []);
    assert.deepEqual(r.published.at(-1), []);
    assert.equal(r.peers.length, 0);
  });

  test("a confirm that can't be applied reads failed with why, notes no link and leaves no relay behind", async () => {
    const r = rig({ pairResult: { status: 400, body: { error: "A host with that fingerprint is already paired" } } });
    const p = proposalOf(await r.store.propose("company", pairBody({ relay: { host: "127.0.0.1", port: 4803 } })));
    assert.deepEqual(p.relay, { host: "127.0.0.1", port: 4803 });
    const res = await r.store.confirm(p.id);
    assert.equal(res.status, 409);
    assert.equal(proposalOf(res).state, "failed");
    assert.equal(proposalOf(res).error, "A host with that fingerprint is already paired");
    assert.equal(r.relay, null, "the relay set for it went again");
    assert.deepEqual(r.calls, ["pair:dry co-omar", "relay:dry 127.0.0.1:4803", "relay 127.0.0.1:4803", "pair co-omar", "relay null"]);
    assert.equal(existsSync(r.linksFile), false);
  });

  test("a relay: set with the pairing when none is; the same one is kept; another is refused", async () => {
    const r = rig();
    await r.store.confirm(proposalOf(await r.store.propose("company", pairBody({ relay: { host: "127.0.0.1", port: 4803 } }))).id);
    assert.deepEqual(r.relay, { host: "127.0.0.1", port: 4803 });
    assert.equal((await r.store.propose("company", pairBody({ peer: "co-2", fingerprint: PIN2, relay: { host: "127.0.0.1", port: 4803 } }))).status, 200);
    const other = await r.store.propose("company", pairBody({ peer: "co-3", fingerprint: PIN2, relay: { host: "127.0.0.1", port: 4900 } }));
    assert.equal(other.status, 409);
    assert.match(errOf(other), /already listens at 127\.0\.0\.1:4803/);
  });
});

describe("what a proposal is checked for when it is made", () => {
  test("each bad body is refused 400 or 409 and nothing is applied", async () => {
    const bad: Array<[unknown, number]> = [
      [null, 400],
      [{ kind: "nope" }, 400],
      [{ kind: "key", extra: 1 }, 400],
      [pairBody({ peer: "Bad Id" }), 400],
      [pairBody({ fingerprint: "1234" }), 400],
      [pairBody({ grant: undefined }), 400],
      [pairBody({ grant: "admin" }), 400],
      [pairBody({ role: "both" }), 400],
      [pairBody({ host: "10.0.0.1", port: 4803 }), 400],
      [pairBody({ role: "dial" }), 400],
      [pairBody({ role: "dial", host: "10.0.0.1", port: 70000 }), 400],
      [pairBody({ role: "dial", host: "10.0.0.1", port: 4803, relay: { host: "127.0.0.1", port: 1 } }), 400],
      [pairBody({ relay: { host: "127.0.0.1", port: 1, exposure: "internet" } }), 400],
      [pairBody({ why: "x".repeat(201) }), 400],
      [pairBody({ why: 3 }), 400],
      [pairBody({ peer: "this-mac" }), 409],
    ];
    for (const [body, status] of bad) {
      const r = rig();
      const res = await r.store.propose("company", body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.ok(errOf(res), "says why");
      assert.equal(r.peers.length, 0);
      assert.equal(r.published.length, 0);
    }
  });

  test("the extension's one line of why is kept as one line, its control and bidi characters gone", async () => {
    const r = rig();
    const p = proposalOf(await r.store.propose("company", pairBody({ why: "Omar asked\nto join \u202Etxet\u202C now" })));
    assert.equal(p.why, "Omar asked to join txet now");
    assert.equal(p.extension.title, "Title of company");
  });
});

// ---- the real routes' doors ---------------------------------------------------------------------------

const { buildApp } = await import("../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { pageHeaders } = await import("../testing/page");
const { setExtensionKeyCheck } = await import("../auth");
const { extensionKeys } = await import("../extension-keys");
const { meshProposalJoinFrames } = await import("./index");
const { PROPOSE_REFUSAL, DIALOG_FROM_EXTENSION_PAGE } = await import("./proposals");

const keyCheck = { isKey: (v: string) => v === "ext-key", idOf: (v: string) => (v === "ext-key" ? "company" : null), socket() {} } as never;
const call = (method: string, url: string, body: unknown, headers: Record<string, string>, env?: Record<string, unknown>) =>
  app.request(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
const token = () => pageHeaders().cookie!.split("=")[1]!;
const KEY = { "x-sova-token": "ext-key" };

describe("the routes", () => {
  test("before any extension asks, a joining page is sent nothing and no file is made", () => {
    assert.deepEqual(meshProposalJoinFrames(), []);
    assert.equal(existsSync(join(scratchAgentDir, "sova", "mesh-proposals.json")), false);
  });

  test("only an extension's key proposes; the page, a script and a chat are refused and nothing waits", async () => {
    setExtensionKeyCheck(keyCheck);
    try {
      for (const [who, headers] of [["the page", pageHeaders()], ["a script", { "x-sova-token": token() }], ["a chat", { "x-sova-caller": "k", "x-sova-token": token() }]] as const) {
        const r = await call("POST", "/api/mesh/proposals", pairBody(), headers);
        assert.equal(r.status, 403, who);
        assert.equal(((await r.json()) as { error: string }).error, PROPOSE_REFUSAL, who);
      }
      const r = await call("POST", "/api/mesh/proposals", pairBody(), KEY);
      assert.equal(r.status, 200, await r.clone().text());
      const p = ((await r.json()) as { proposal: MeshProposal }).proposal;
      assert.equal(p.state, "waiting");
      assert.equal(p.extension.id, "company");
      assert.deepEqual(meshProposalJoinFrames().map((f) => f.proposals.map((x) => x.id)), [[p.id]], "a page that connects now is sent it");

      // Only the person's page answers: the key, a script, a chat, a peer and an extension's page are refused.
      const refused: Array<[string, Record<string, string>, Record<string, unknown>?]> = [
        ["the key", KEY],
        ["a script", { "x-sova-token": token() }],
        ["a chat", { "x-sova-caller": "k", "x-sova-token": token() }],
        ["no mark", {}],
        ["a peer", pageHeaders(), { meshPeer: { id: "other", nodeId: "n" } }],
        ["an extension's page", { ...pageHeaders(), referer: "http://127.0.0.1/ext/company/" }],
        ["a frame", { ...pageHeaders(), "sec-fetch-dest": "iframe" }],
      ];
      for (const act of ["confirm", "decline"]) {
        for (const [who, headers, env] of refused) {
          const res = await call("POST", `/api/mesh/proposals/${p.id}/${act}`, {}, headers, env);
          assert.ok(res.status === 403 || res.status === 404, `${act} by ${who}: ${res.status}`);
          if (who === "an extension's page" || who === "a frame") assert.equal(((await res.json()) as { error: string }).error, DIALOG_FROM_EXTENSION_PAGE);
        }
      }
      const still = await call("GET", `/api/mesh/proposals/${p.id}`, undefined, KEY);
      assert.equal(((await still.json()) as { proposal: MeshProposal }).proposal.state, "waiting", "still waiting");

      // The page withdraws nothing; the key does. The person's Decline answers the next.
      assert.equal((await call("DELETE", `/api/mesh/proposals/${p.id}`, undefined, pageHeaders())).status, 403);
      const w = await call("DELETE", `/api/mesh/proposals/${p.id}`, undefined, KEY);
      assert.equal(((await w.json()) as { proposal: MeshProposal }).proposal.state, "withdrawn");
      const q = ((await (await call("POST", "/api/mesh/proposals", pairBody(), KEY)).json()) as { proposal: MeshProposal }).proposal;
      const d = await call("POST", `/api/mesh/proposals/${q.id}/decline`, {}, pageHeaders());
      assert.equal(d.status, 200, await d.clone().text());
      assert.equal(((await d.json()) as { proposal: MeshProposal }).proposal.state, "declined");
      assert.deepEqual(meshProposalJoinFrames(), []);
      // The key's list holds only its own; the page's holds all.
      const mine = (await (await call("GET", "/api/mesh/proposals", undefined, KEY)).json()) as { proposals: MeshProposal[]; links: unknown[] };
      assert.deepEqual(mine.links, []);
      assert.ok(mine.proposals.every((x) => x.extension.id === "company"));
    } finally {
      setExtensionKeyCheck(extensionKeys);
    }
  });

  test("a key's other writes under /api/mesh stay refused", async () => {
    setExtensionKeyCheck(keyCheck);
    try {
      for (const [method, url] of [["POST", "/api/mesh/lan/pairings"], ["PUT", "/api/mesh/access"], ["POST", "/api/mesh/lan/key"], ["PUT", "/api/mesh/lan/relay"]]) {
        const r = await call(method!, url!, {}, KEY);
        assert.equal(r.status, 403, `${method} ${url}`);
        assert.equal(((await r.json()) as { extensionRefused?: boolean }).extensionRefused, true);
      }
    } finally {
      setExtensionKeyCheck(extensionKeys);
    }
  });
});
