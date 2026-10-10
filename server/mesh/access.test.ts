// Run: pnpm test -- server/mesh/access.test.ts
// mesh-access.json (§mesh.peers/grants) against a throwaway PI_CODING_AGENT_DIR: the file's strict
// read, fail closed, presets and switches, the per-login list, and the route classifier.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { grantCaps, MESH_CAPS, presetCaps } from "../../shared/mesh-access";

const tmp = mkdtempSync(join(tmpdir(), "sova-access-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sova"), { recursive: true });

const {
  access,
  accessFile,
  allows,
  classifyRequest,
  classifyUpgrade,
  loginsOf,
  mayShareLoginNode,
  onAccessChange,
  resetAccessCache,
  restricted,
  updateAccess,
  validateAccess,
  validateGrant,
} = await import("./access");

const put = (doc: unknown) => writeFileSync(accessFile(), typeof doc === "string" ? doc : JSON.stringify(doc));

after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(accessFile(), { force: true });
  resetAccessCache();
});

describe("the file", () => {
  test("missing: every peer has everything, exactly as before grants", () => {
    assert.equal(access().kind, "missing");
    for (const need of [...MESH_CAPS, "hello", "full", "sync.docs"] as const) assert.equal(allows("nX", need), true, need);
    assert.equal(restricted("nX"), false);
    assert.equal(loginsOf("nX"), "all");
  });

  test("a dial-out pairing fails closed (M1): no file or no entry is presence, never full; tailnet peers unchanged", () => {
    const pairing = "lan:0123456789abcdef0123456789abcdef";
    const check = (why: string) => {
      assert.equal(allows(pairing, "hello"), true, why);
      assert.equal(allows(pairing, "presence"), true, why);
      for (const need of ["sessions", "admin", "links", "llm", "sync.logins", "sync.docs", "full"] as const) assert.equal(allows(pairing, need), false, `${why}: ${need}`);
      assert.equal(restricted(pairing), true, why);
      assert.deepEqual(loginsOf(pairing), [], why);
      // The zero-regression half: a tailnet peer in the same state still has everything.
      assert.equal(allows("nTailnet", "full"), true, why);
      assert.equal(restricted("nTailnet"), false, why);
    };
    check("no file");
    put({ version: 1, peers: { nOther: { preset: "sessions" } } });
    check("a file that doesn't list it");
    put({ version: 1, peers: { [pairing]: { preset: "full" } } });
    assert.equal(allows(pairing, "full"), true, "an explicit grant still says what it says");
    put("{broken");
    assert.equal(allows(pairing, "hello"), true);
    assert.equal(allows(pairing, "presence"), false, "a broken file is hello only, for a pairing as for anyone");
  });

  test("a peer the file doesn't list has everything; a listed one has its grant", () => {
    put({ version: 1, peers: { nA: { preset: "presence" } } });
    assert.equal(allows("nB", "full"), true);
    assert.equal(restricted("nB"), false);
    assert.equal(allows("nA", "hello"), true);
    assert.equal(allows("nA", "presence"), true);
    assert.equal(allows("nA", "sessions"), false);
    assert.equal(allows("nA", "full"), false);
    assert.equal(restricted("nA"), true);
  });

  test("malformed or invalid fails CLOSED: hello only, for every peer, listed or not", () => {
    for (const bad of ["{broken", JSON.stringify({ version: 2, peers: {} }), JSON.stringify({ version: 1, peers: { nA: { preset: "admin" } } }), JSON.stringify({ version: 1, peers: { nA: { preset: "full", caps: { root: true } } } })]) {
      put(bad);
      const a = access();
      assert.equal(a.kind, "error", bad);
      for (const node of ["nA", "nUnlisted"]) {
        assert.equal(allows(node, "hello"), true);
        for (const need of [...MESH_CAPS, "full", "sync.docs"] as const) assert.equal(allows(node, need), false, `${bad} ${node} ${need}`);
        assert.equal(restricted(node), true);
        assert.deepEqual(loginsOf(node), []);
      }
    }
  });

  test("a broken file is never overwritten by a write", () => {
    put("{broken");
    const r = updateAccess((d) => d);
    assert.ok("error" in r && /fix or remove it first/.test(r.error));
  });

  test("writes are atomic at 0600 and picked up at once; a hand edit is noticed by the next question", () => {
    let changes = 0;
    onAccessChange(() => changes++);
    assert.deepEqual(updateAccess((d) => ({ ...d, peers: { nA: { preset: "none" } } })), { ok: true });
    assert.equal(statSync(accessFile()).mode & 0o777, 0o600);
    assert.equal(allows("nA", "hello"), false);
    assert.ok(changes >= 1);
    const before = changes;
    put({ version: 1, peers: { nA: { preset: "full" } } });
    assert.equal(allows("nA", "full"), true);
    assert.equal(changes, before + 1);
  });

  test("validation is strict and names the problem", () => {
    assert.ok("error" in validateAccess([]));
    assert.ok("error" in validateAccess({ version: 1, peers: [] }));
    assert.ok("error" in validateGrant({ preset: "full", caps: { links: "yes" } }));
    assert.ok("error" in validateGrant({ preset: "full", logins: ["pi:zai", "pi:zai"] }));
    assert.ok("error" in validateGrant({ preset: "full", logins: ["../etc"] }));
    assert.deepEqual(validateGrant({ preset: "sessions", caps: { admin: true }, logins: ["pi:zai", "pi:anthropic"] }), {
      grant: { preset: "sessions", caps: { admin: true }, logins: ["pi:anthropic", "pi:zai"] },
    });
  });
});

describe("presets and switches", () => {
  test("each preset's caps", () => {
    assert.ok(MESH_CAPS.every((c) => presetCaps("full")[c]));
    assert.ok(MESH_CAPS.every((c) => !presetCaps("none")[c]));
    assert.deepEqual(
      MESH_CAPS.filter((c) => presetCaps("sessions")[c]),
      ["presence", "sessions", "links", "llm"],
    );
    assert.deepEqual(
      MESH_CAPS.filter((c) => presetCaps("presence")[c]),
      ["presence"],
    );
  });

  test("switches override the preset both ways", () => {
    const caps = grantCaps({ preset: "presence", caps: { "sync.themes": true, presence: false } });
    assert.equal(caps["sync.themes"], true);
    assert.equal(caps.presence, false);
  });

  test("none denies hello itself; full with one switch off is no longer full", () => {
    put({ version: 1, peers: { nNone: { preset: "none" }, nAlmost: { preset: "full", caps: { links: false } } } });
    assert.equal(allows("nNone", "hello"), false);
    assert.equal(allows("nAlmost", "sessions"), true);
    assert.equal(allows("nAlmost", "links"), false);
    assert.equal(allows("nAlmost", "full"), false);
  });

  test("settings and themes share one exchange: either one opens it", () => {
    put({ version: 1, peers: { nT: { preset: "none", caps: { "sync.themes": true } }, nN: { preset: "sessions" } } });
    assert.equal(allows("nT", "sync.docs"), true);
    assert.equal(allows("nN", "sync.docs"), false);
  });
});

describe("logins", () => {
  test("no list: every login (today's meaning); a list: only those; no logins grant: none", () => {
    put({
      version: 1,
      peers: {
        nAll: { preset: "full" },
        nSome: { preset: "full", logins: ["pi:zai"] },
        nOff: { preset: "full", caps: { "sync.logins": false }, logins: ["pi:zai"] },
      },
    });
    assert.equal(loginsOf("nAll"), "all");
    assert.equal(mayShareLoginNode("nAll", "pi:anything"), true);
    assert.deepEqual(loginsOf("nSome"), ["pi:zai"]);
    assert.equal(mayShareLoginNode("nSome", "pi:zai"), true);
    assert.equal(mayShareLoginNode("nSome", "pi:anthropic"), false);
    assert.deepEqual(loginsOf("nOff"), []);
    assert.equal(mayShareLoginNode("nOff", "pi:zai"), false);
  });
});

describe("the route classifier", () => {
  const need = (method: string, path: string) => classifyRequest(method, path).need;

  test("peer-only routes, one capability each", () => {
    assert.equal(need("GET", "/api/peer/hello"), "hello");
    assert.equal(need("GET", "/api/peer/details"), "presence");
    assert.equal(need("POST", "/api/peer/label"), "presence");
    assert.equal(need("POST", "/api/peer/browser-access"), "presence");
    assert.equal(need("POST", "/api/peer/rename"), "admin");
    assert.equal(need("POST", "/api/peer/set-browser-access"), "admin");
    assert.equal(need("GET", "/api/peer/sync/manifest"), "sync.docs");
    assert.equal(need("POST", "/api/peer/sync/push"), "sync.docs");
    assert.equal(need("GET", "/api/peer/sync/extensions"), "sync.extensions");
    assert.equal(need("GET", "/api/peer/credentials/entry"), "sync.logins");
    assert.equal(need("POST", "/api/peer/claude-pool/lend"), "sync.logins");
    assert.equal(need("POST", "/api/peer/links"), "links");
    assert.equal(need("GET", "/api/peer/links/whoami"), "links");
    assert.equal(need("GET", "/api/peer/links/read"), "sessions");
    assert.equal(need("GET", "/api/peer/links/x/offers/y/tar"), "links");
    assert.equal(need("POST", "/api/peer/outreach/send"), "outreach");
    assert.equal(need("POST", "/api/peer/outreach/reconnect"), "admin", "reconnecting the sender needs full control, not outreach");
    assert.equal(need("PUT", "/api/peer/share-gateway/links"), "share");
    assert.deepEqual(classifyRequest("GET", "/api/peer/something-new"), { need: "full", rule: "default" });
  });

  test("sessions drive with every method; other reads are sessions and their writes admin", () => {
    assert.equal(need("GET", "/api/sessions"), "sessions");
    assert.equal(need("POST", "/api/sessions"), "sessions");
    assert.equal(need("POST", "/api/sessions/prompt"), "sessions");
    assert.equal(need("GET", "/api/transcript"), "sessions");
    assert.equal(need("GET", "/api/settings"), "sessions");
    assert.equal(need("PUT", "/api/settings"), "admin");
    assert.equal(need("POST", "/api/orgs/o/projects"), "admin");
    assert.equal(need("PUT", "/api/claude/pool/keeper"), "admin");
    assert.equal(need("GET", "/api/auth/token"), "full");
    assert.deepEqual(classifyRequest("GET", "/api/brand-new-route"), { need: "full", rule: "default" });
  });

  test("judged as the router routes it: spelling never lowers what a path needs", () => {
    assert.equal(need("GET", "/api/%70eer/rename"), "admin");
    assert.equal(need("POST", "/API/Peer/Rename"), "admin");
    assert.equal(need("PUT", "/api//settings"), "admin");
    assert.equal(need("GET", "/api/peer%2frename"), "full");
    assert.equal(need("GET", "/api/%zz"), "full");
  });

  test("sockets: the llm feed is llm, every other one sessions", () => {
    assert.equal(classifyUpgrade("/ws/watch", new URLSearchParams("feed=llm")).need, "llm");
    assert.equal(classifyUpgrade("/ws/watch", new URLSearchParams("feed=sessions")).need, "sessions");
    assert.equal(classifyUpgrade("/ws/watch", new URLSearchParams("path=/x.jsonl")).need, "sessions");
    assert.equal(classifyUpgrade("/ws/chat", new URLSearchParams("path=/x.jsonl")).need, "sessions");
  });
});
