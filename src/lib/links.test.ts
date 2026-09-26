import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkInboxRecord, LinkedAgentInfo } from "../../shared/mesh-links";
import type { MeshInfo, PeerStatus } from "../../shared/protocol";
import { linkGroupId, linkGroups, linkHostLabel, linkReach, linkStateChip, newestFrom, sessionIdOfPath, threadRows, threadSignature } from "./links";

const LK = "lk_0123456789abcdef";
const LK2 = "lk_fedcba9876543210";

const row = (over: Partial<LinkedAgentInfo> = {}): LinkedAgentInfo => ({
  key: `link:${over.linkId ?? LK}:${over.nodeId ?? "nB"}`,
  linkId: LK,
  nodeId: "nB",
  sessionId: "sB",
  path: "/s/b.jsonl",
  self: false,
  hostId: "box-as-the-session-host-calls-it",
  hostLabel: "Box (session host's name)",
  title: "Partner",
  model: "zai/glm-5.3",
  state: "idle",
  unread: 0,
  ...over,
});

const mesh = (selfNode: string | undefined, peers: Array<Pick<PeerStatus, "id" | "nodeId" | "label">>): Pick<MeshInfo, "self" | "peers"> => ({
  self: { id: "me", label: "Desk", hostname: "desk", ...(selfNode ? { nodeId: selfNode } : {}) },
  peers: peers as PeerStatus[],
});

test("linkReach maps the member's nodeId through the page's own mesh, never the stored hostId", () => {
  const m = mesh("nA", [{ id: "laptop", nodeId: "nB", label: "Laptop" }]);
  assert.deepEqual(linkReach(row(), m, null), { ok: true, host: "laptop" });
  // The page is served by the member's own host (the session lives on a peer): no prefix.
  assert.deepEqual(linkReach(row({ nodeId: "nA" }), m, "phone"), { ok: true, host: null });
  // A host the page's host doesn't know is unreachable from here, whatever the session's host calls it.
  assert.deepEqual(linkReach(row({ nodeId: "nC" }), m, null), { ok: false });
  assert.deepEqual(linkReach(row(), null, null), { ok: false });
  // A local member (the Overseer's pane) is wherever the session itself is.
  assert.deepEqual(linkReach(row({ self: true, nodeId: "nZ" }), m, "phone"), { ok: true, host: "phone" });
});

test("linkReach never matches an unknown self nodeId to an empty one", () => {
  assert.deepEqual(linkReach(row({ nodeId: "" }), mesh(undefined, []), null), { ok: false });
});

test("linkHostLabel prefers the page's own name for the host", () => {
  const m = mesh("nA", [{ id: "laptop", nodeId: "nB", label: "Laptop" }]);
  assert.equal(linkHostLabel(row(), m), "Laptop");
  assert.equal(linkHostLabel(row({ nodeId: "nA" }), m), "Desk");
  assert.equal(linkHostLabel(row({ nodeId: "nC" }), m), "Box (session host's name)");
});

test("linkGroups: one section per link in first-seen order, working members first", () => {
  const rows = [
    row({ key: "k1", title: "b", state: "idle" }),
    row({ key: "k2", linkId: LK2, title: "z" }),
    row({ key: "k3", title: "a", state: "offline" }),
    row({ key: "k4", title: "c", state: "working" }),
  ];
  assert.deepEqual(linkGroups(rows), [
    { linkId: LK, keys: ["k4", "k1", "k3"] },
    { linkId: LK2, keys: ["k2"] },
  ]);
  assert.equal(linkGroupId(LK, 1), null);
  assert.equal(linkGroupId(LK, 2), "lk_012345");
});

test("linkStateChip: working pulses only from a live source; idle and offline carry as-of", () => {
  assert.deepEqual(linkStateChip({ state: "working", lastActivity: 5 }, true), { text: "Working", tone: "accent", live: true });
  assert.equal(linkStateChip({ state: "working" }, false).live, false);
  assert.deepEqual(linkStateChip({ state: "idle", lastActivity: 5 }, true), { text: "Idle", live: false, asOf: 5 });
  const off = linkStateChip({ state: "offline", lastActivity: 7 }, true);
  assert.equal(off.text, "Offline");
  assert.equal(off.tone, undefined, "muted");
  assert.equal(off.asOf, 7);
});

test("sessionIdOfPath reads a pi session file's id", () => {
  assert.equal(sessionIdOfPath("/x/--home--/2026-09-27T01-02-03-000Z_0199aabb-ccdd.jsonl"), "0199aabb-ccdd");
  assert.equal(sessionIdOfPath("/x/notes.txt"), null);
});

const msg = (id: string, at: number, from: [string, string], text = id, over: Partial<LinkInboxRecord> = {}): LinkInboxRecord => ({
  id,
  linkId: LK,
  at,
  from: { nodeId: from[0], sessionId: from[1] },
  to: [],
  text,
  dir: "in",
  ...over,
});

test("threadRows: oldest first, deduped, the viewer's own marked, partners named by row", () => {
  const rows = threadRows(
    { messages: [msg("m2", 20, ["nB", "sB"]), msg("m1", 10, ["nA", "sA"]), msg("m2", 20, ["nB", "sB"])] },
    { nodeId: "nA", sessionId: "sA" },
    [row()],
  );
  assert.deepEqual(rows.map((r) => [r.id, r.own, r.from]), [
    ["m1", true, "This session"],
    ["m2", false, "Partner · Box (session host's name)"],
  ]);
});

test("threadRows notes only the recipients that didn't simply get it", () => {
  const [r] = threadRows(
    {
      messages: [
        msg("m1", 1, ["nA", "sA"], "hi", {
          dir: "out",
          deliveries: [
            { to: { nodeId: "nB", sessionId: "sB" }, state: "started" },
            { to: { nodeId: "nC", sessionId: "sC" }, state: "outbox" },
            { to: { nodeId: "nD", sessionId: "sD" }, state: "refused", reason: "tui-live", message: "It's open in a terminal." },
          ],
        }),
      ],
    },
    null,
    [row(), row({ nodeId: "nC", sessionId: "sC", title: "Phone agent" })],
  );
  assert.deepEqual(r!.notes, ["Phone agent: held until its host is up", "Refused by sD: It's open in a terminal."]);
  assert.equal(r!.own, false, "the Overseer's pane has no viewer");
});

test("newestFrom and threadSignature", () => {
  const t = { messages: [msg("a", 5, ["nB", "sB"]), msg("b", 9, ["nB", "sB"]), msg("c", 12, ["nA", "sA"])] };
  assert.equal(newestFrom(t, { nodeId: "nB", sessionId: "sB" }), 9);
  assert.equal(newestFrom(t, { nodeId: "nX", sessionId: "sX" }), null);
  assert.notEqual(threadSignature(row({ unread: 1 })), threadSignature(row({ unread: 0 })));
  assert.equal(threadSignature(row({ title: "renamed" })), threadSignature(row()), "a title change fetches nothing");
});
