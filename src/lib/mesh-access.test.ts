// Run: pnpm test -- src/lib/mesh-access.test.ts
// The Mesh page's grants editor, pure: how a switch changes a grant, the per-login list, the words,
// and a hidden host's rows in the merged session list (§mesh.peers/grants).
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantCaps, MESH_CAPS } from "../../shared/mesh-access";
import { CAP_COPY, FULL, grantOf, grantSummary, loginOn, theirLine, transitLine, withCap, withLogin, withPreset } from "./mesh-access";
import { mergePeerLists, type PeerStatus } from "./mesh";

test("no stored grant reads as full", () => {
  assert.deepEqual(grantOf(undefined), FULL);
  assert.ok(MESH_CAPS.every((c) => grantCaps(grantOf(undefined))[c]));
});

test("a switch that lands on the preset's own value is dropped; one that differs is kept", () => {
  const g1 = withCap({ preset: "presence" }, "sync.themes", true);
  assert.deepEqual(g1, { preset: "presence", caps: { "sync.themes": true } });
  assert.deepEqual(withCap(g1, "sync.themes", false), { preset: "presence" });
  assert.deepEqual(withCap({ preset: "full" }, "admin", true), { preset: "full" });
  assert.deepEqual(withCap({ preset: "full" }, "admin", false), { preset: "full", caps: { admin: false } });
});

test("a new preset drops the switches and keeps the login choice", () => {
  assert.deepEqual(withPreset({ preset: "full", caps: { admin: false }, logins: ["pi:zai"] }, "sessions"), { preset: "sessions", logins: ["pi:zai"] });
  assert.deepEqual(withPreset({ preset: "full", caps: { admin: false } }, "none"), { preset: "none" });
});

test("logins: every login until the first choice; the first switch writes the list out", () => {
  const all = ["pi:zai", "pi:anthropic", "pi:openai"];
  const g = withLogin({ preset: "full" }, "pi:anthropic", false, all);
  assert.deepEqual(g.logins, ["pi:openai", "pi:zai"]);
  assert.equal(loginOn(g, "pi:anthropic"), false);
  assert.equal(loginOn(g, "pi:zai"), true);
  assert.equal(loginOn(g, "pi:added-later"), false, "a login added after the first choice isn't shared until chosen");
  assert.equal(loginOn({ preset: "full" }, "pi:added-later"), true, "before any choice, every login goes");
  assert.deepEqual(withLogin(g, "pi:anthropic", true, all).logins, ["pi:anthropic", "pi:openai", "pi:zai"]);
  assert.equal(loginOn({ preset: "presence", logins: ["pi:zai"] }, "pi:zai"), false, "no login goes without the logins grant");
});

test("the collapsed line names the preset and how many switches change it", () => {
  assert.equal(grantSummary({ preset: "presence" }), "Presence only");
  assert.equal(grantSummary({ preset: "full", caps: { admin: false, links: false } }), "Everything, 2 changed");
});

test("every capability has words; sessions says it runs commands", () => {
  for (const c of MESH_CAPS) assert.ok(CAP_COPY[c].label && CAP_COPY[c].means, c);
  assert.match(CAP_COPY.sessions.means, /run commands on this machine/);
});

test("the transit line names who can still pass a category on", () => {
  assert.equal(transitLine(["VPS"], "Laptop"), "VPS can still pass it on to Laptop, unless it keeps it from Laptop too.");
  assert.equal(transitLine(["VPS", "Phone"], "Laptop"), "VPS and Phone can still pass it on to Laptop, unless they keep it from Laptop too.");
});

test("what this host can see on a peer comes from its denials alone", () => {
  assert.equal(theirLine("VPS", undefined), "VPS hasn't kept anything from this host so far.");
  assert.equal(theirLine("VPS", { denied: ["sessions"] }), "VPS keeps sessions from this host.");
  assert.equal(theirLine("VPS", { denied: ["sessions", "links", "admin"] }), "VPS keeps sessions, links, and admin from this host.");
});

test("a host that hides its sessions keeps no rows in the merged list, not even its last ones", () => {
  const peer = (id: string, state: PeerStatus["state"]): PeerStatus => ({ id, label: id, nodeId: `n${id}`, name: id, url: "", state, lastSeen: null });
  const row = { id: "s1", path: "/far/s1.jsonl" } as never;
  const before = mergePeerLists(new Map(), { peers: [{ id: "b", label: "b", state: "up", sessions: [row] }] }, [peer("b", "up")]);
  assert.equal(before.get("b")?.length, 1);
  const after = mergePeerLists(before, { peers: [{ id: "b", label: "b", state: "hidden" }] }, [peer("b", "up")]);
  assert.equal(after.has("b"), false);
  // A host that is merely down keeps its last rows, as before.
  const down = mergePeerLists(before, { peers: [{ id: "b", label: "b", state: "down" }] }, [peer("b", "down")]);
  assert.equal(down.get("b")?.length, 1);
});
