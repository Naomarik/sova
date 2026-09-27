import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkInboxRecord, LinkOffer, LinkedAgentInfo } from "../../shared/mesh-links";
import type { MeshInfo, PeerStatus } from "../../shared/protocol";
import { linkGroupId, linkGroups, threadHost, linkHostLabel, linkReach, linkStateChip, newestFrom, offerRows, progressText, sessionIdOfPath, threadItems, threadRows, threadSignature, transferChip } from "./links";

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

test("threadHost reads a member host's inbox: the session's host, unless the Overseer's host isn't a member", () => {
  const m = mesh("nA", [{ id: "laptop", nodeId: "nB", label: "Laptop" }, { id: "phone", nodeId: "nC", label: "Phone" }]);
  // A member's pane: its own host holds the inbox.
  assert.deepEqual(threadHost([row({ nodeId: "nB" })], false, m, "desk"), { ok: true, host: "desk" });
  // The Overseer's pane with a local member: its own host is a member too.
  assert.deepEqual(threadHost([row({ nodeId: "nZ", self: true }), row({ nodeId: "nB" })], true, m, null), { ok: true, host: null });
  // The Overseer linked two other hosts: the first member host the page reaches, skipping unknown ones.
  assert.deepEqual(threadHost([row({ nodeId: "nX" }), row({ nodeId: "nC" }), row({ nodeId: "nB" })], true, m, null), { ok: true, host: "phone" });
  // None reachable: no host to read from, never the empty copy on the creating host.
  assert.deepEqual(threadHost([row({ nodeId: "nX" })], true, m, null), { ok: false });
});

const MB = 1024 * 1024;
const OF = "of_0123456789abcdef";

const offer = (over: Partial<LinkOffer> = {}): LinkOffer => ({
  id: OF,
  linkId: LK,
  at: 15,
  expiresAt: 15 + 86_400_000,
  from: { nodeId: "nA", sessionId: "sA" },
  roots: [
    { name: "proj", kind: "dir", files: 5000, bytes: 40 * MB },
    { name: "notes.md", kind: "file", files: 1, bytes: 1 * MB },
  ],
  files: 5001,
  bytes: 41 * MB,
  snapshot: { sha256: "ab", size: 12 * MB, encoding: "zstd", packedAt: 16 },
  packing: { state: "ready", written: 12 * MB },
  recipients: [{ to: { nodeId: "nB", sessionId: "sB" }, state: "pulling", dest: "~/in", resolvedDest: "/r/in", received: 3 * MB, startedAt: 17 }],
  ...over,
});

test("transferChip says what the member is doing with its newest open offer, and nothing when final", () => {
  assert.equal(transferChip(undefined), null);
  assert.equal(transferChip({ offerId: OF, dir: "out", state: "pulling", received: 12 * MB, size: 41 * MB })!.text, "Sending 12 MB / 41 MB");
  assert.equal(transferChip({ offerId: OF, dir: "in", state: "pulling" })!.text, "Receiving…");
  assert.equal(transferChip({ offerId: OF, dir: "in", state: "accepted" })!.text, "Receiving…");
  assert.equal(transferChip({ offerId: OF, dir: "in", state: "extracting" })!.text, "Unpacking");
  assert.equal(transferChip({ offerId: OF, dir: "out", state: "offered" })!.text, "Waiting for an answer");
  assert.equal(transferChip({ offerId: OF, dir: "out", state: "done" }), null);
  assert.equal(progressText(undefined, 5), null);
  assert.equal(progressText(1536, undefined), "1.5 KB");
});

test("threadSignature moves with a transfer's state and bytes", () => {
  const t = { offerId: OF, dir: "in" as const, state: "pulling" as const, received: 1 };
  assert.notEqual(threadSignature(row({ transfer: t })), threadSignature(row()));
  assert.notEqual(threadSignature(row({ transfer: { ...t, received: 2 } })), threadSignature(row({ transfer: t })));
  assert.notEqual(threadSignature(row({ transfer: { ...t, state: "extracting" } })), threadSignature(row({ transfer: t })));
});

test("offerRows: what was offered, and each recipient's state, progress, dest and reason", () => {
  const [o] = offerRows(
    [
      offer({
        note: "  the repo  ",
        warnings: [{ kind: "gitlink", root: "proj", path: "proj/.git", gitdir: "/src/.git/worktrees/proj" }],
        recipients: [
          { to: { nodeId: "nB", sessionId: "sB" }, state: "pulling", resolvedDest: "/r/in", received: 3 * MB, retries: 2, startedAt: 17 },
          { to: { nodeId: "nC", sessionId: "sC" }, state: "done", dest: "~/in", startedAt: 17, doneAt: 17 + 125_000 },
          { to: { nodeId: "nD", sessionId: "sD" }, state: "refused", reason: "not-writable", message: "Its sandbox can't write /etc." },
          { to: { nodeId: "nE", sessionId: "sE" }, state: "failed", reason: "bad-hash" },
        ],
      }),
    ],
    { nodeId: "nA", sessionId: "sA" },
    [row(), row({ nodeId: "nC", sessionId: "sC", title: "Phone agent" })],
  );
  assert.equal(o!.own, true);
  assert.equal(o!.from, "This session");
  assert.deepEqual([o!.dir, o!.verb], ["out", "Offered"]);
  assert.equal(o!.roots, "proj/, notes.md");
  assert.equal(o!.size, "5,001 files · 41 MB");
  assert.equal(o!.note, "the repo");
  assert.equal(o!.packing, null);
  assert.match(o!.warnings[0]!, /^proj\/\.git .*no history/);
  const [b, c, d, e] = o!.recipients;
  assert.deepEqual([b!.who, b!.label, b!.progress, b!.dest], ["Partner", "Pulling, resumed 2×", "3 MB / 12 MB", "/r/in"]);
  assert.deepEqual([c!.who, c!.label, c!.tone, c!.dest, c!.at, c!.took, c!.progress], ["Phone agent", "Landed", "success", "~/in", 17 + 125_000, "2m", null]);
  assert.deepEqual([d!.label, d!.tone, d!.message], ["Refused", "warn", "Its sandbox can't write /etc."]);
  assert.deepEqual([e!.label, e!.tone, e!.message, e!.who], ["Failed", "error", "Reason: bad-hash.", "Session sE"]);
});

test("offerRows: the sender's packing shows until it's ready", () => {
  const packing = offerRows([offer({ packing: { state: "packing", written: 3 * MB }, snapshot: undefined })], null, [row()]);
  assert.equal(packing[0]!.packing, "Packing · 3 MB written");
  assert.equal(packing[0]!.own, false, "the Overseer's pane has no viewer");
  assert.equal(packing[0]!.dir, null);
  const inbound = offerRows([offer()], { nodeId: "nB", sessionId: "sB" }, [row({ nodeId: "nA", sessionId: "sA", title: "Sender" })]);
  assert.deepEqual([inbound[0]!.dir, inbound[0]!.verb, inbound[0]!.recipients[0]!.who, inbound[0]!.recipients[0]!.label], ["in", "Offered to this session", "This session", "Pulling"]);
  const failed = offerRows([offer({ packing: { state: "failed", error: "No room to pack 41 MB on this host." } })], null, []);
  assert.equal(failed[0]!.packing, "Packing failed: No room to pack 41 MB on this host.");
  assert.equal(failed[0]!.from, "Session sA");
  // Every recipient done with it before the spool was: the withdrawn packing isn't news.
  const withdrawn = offerRows(
    [offer({ packing: { state: "failed", error: "withdrawn: every recipient is done with it" }, recipients: [{ to: { nodeId: "nB", sessionId: "sB" }, state: "declined" }] })],
    null,
    [],
  );
  assert.equal(withdrawn[0]!.packing, null);
});

test("threadItems interleaves offers with messages by time, dropping an offer's own offered notice", () => {
  const items = threadItems(
    {
      messages: [
        msg("m1", 10, ["nA", "sA"]),
        msg("n1", 15, ["nA", "sA"], "offer notice", { offer: { id: OF, event: "offered" } }),
        msg("n2", 30, ["nB", "sB"], "landed", { offer: { id: OF, event: "landed" } }),
        msg("n3", 40, ["nA", "sA"], "other offer", { offer: { id: "of_ffffffffffffffff", event: "offered" } }),
      ],
      offers: [offer({ at: 15 }), offer({ at: 15 })],
    },
    { nodeId: "nA", sessionId: "sA" },
    [row()],
  );
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ["message:m1", `offer:${OF}`, "message:n2", "message:n3"]);
  // An older host sends no offers: the thread is its messages.
  assert.equal(threadItems({ messages: [msg("m1", 1, ["nA", "sA"])] }, null, []).length, 1);
});
