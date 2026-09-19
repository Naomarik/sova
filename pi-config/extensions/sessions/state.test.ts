import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, parsePresence, parseOutline, SessionStore, FRESH_MS, STALE_MS } from "./state.ts";
import type { Presence } from "./state.ts";
import type { FocusTarget, SessionMeta } from "./schema.ts";

const T = 1_000_000;
const target = (pid: number): FocusTarget => ({ version: 1, instance: "hypr-instance", bootId: "boot-id",
  origin: { pid, start: "123", tty: "34816" }, ghostty: { pid: 50, start: "100", tty: "0" },
  terminal: { pid: 51, start: "101", tty: "34816" }, address: "0x55aa" });
const meta = (id: string, pid: number, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, pid, cwd: `/tmp/${id}`, model: "test", startedAt: 1, lastActivity: 2, endpointEpoch: "one", name: id, ...extra });
const peer = meta("peer", 200);
const presence = (extra: Partial<Presence> = {}): Presence => ({ type: "presence", version: 1, status: "Idle", since: 10,
  completed: 0, preview: "hello", workers: [], target: target(200), ...extra });
const activity = (state: "working" | "idle" | "needs-input" | "error", since: number, extra = {}) => ({ state, since, ...extra });
function store(...peers: SessionMeta[]) {
  const s = new SessionStore(100); s.connected = true; s.roster(peers); return s;
}

test("roster metadata is not a claim that a peer can be focused", () => {
  const s = store(peer);
  const [v] = s.views(T);
  assert.equal(v.canFocus, false);
  assert.match(v.focusReason ?? "", /no rich presence/);
  assert.match(v.statusLabel, /basic/);
  assert.equal(v.preview.length > 0, true);
});

test("valid FocusTarget fixture is focusable only while fresh", () => {
  const s = store(peer); s.receive("peer", presence(), T);
  assert.equal(s.views(T + 1)[0].canFocus, true);
  assert.deepEqual(s.target("peer", T + 1), target(200));
  assert.equal(s.target("peer", T + 1 + FRESH_MS), undefined);
  assert.equal(s.views(T + 1 + FRESH_MS)[0].statusLabel, "Unknown · stale");
  s.receive("peer", presence({ target: undefined, focusable: false, focusReason: "hidden tab" }), T);
  const v = s.views(T + 1)[0];
  assert.equal(v.canFocus, false); assert.equal(v.focusReason, "hidden tab");
});

test("stale, disconnected, removed and replaced endpoints cannot be focused", () => {
  const s = store(peer); s.receive("peer", presence(), T);
  assert.ok(s.target("peer", T + 1));
  s.disconnect(); assert.equal(s.target("peer", T + 1), undefined);
  assert.equal(s.views(T)[0].statusLabel, "Disconnected");
  assert.equal(s.views(T)[0].group, "unreachable");
  s.connected = true; assert.equal(s.target("peer", T + 1), undefined);
  s.receive("peer", presence(), T); s.upsert({ ...peer, endpointEpoch: "two" });
  assert.equal(s.target("peer", T + 1), undefined);
  s.receive("peer", presence(), T); s.roster([]);
  assert.equal(s.target("peer", T + 1), undefined); assert.equal(s.views().length, 0);
});

test("a record whose heartbeat is >15s old yields a stale row even if just received", () => {
  const s = store(peer);
  s.receive("peer", presence(), T, T - STALE_MS - 1);
  const [v] = s.views(T);
  assert.equal(v.stale, true); assert.equal(v.group, "unreachable"); assert.equal(v.canFocus, false);
  s.receive("peer", presence(), T, T - 1000);
  assert.equal(s.views(T)[0].stale, false);
});

test("grouping covers all four groups; parent idle and running workers stay independent", () => {
  const s = store(meta("ask", 201), meta("err", 202), meta("busy", 203), meta("kids", 204), meta("calm", 205), meta("gone", 206));
  s.receive("ask", presence({ activity: activity("needs-input", 5) }), T);
  s.receive("err", presence({ activity: activity("error", 6, { error: "boom" }) }), T);
  s.receive("busy", presence({ activity: activity("working", 7) }), T);
  s.receive("kids", presence({ status: "Idle", workers: [{ id: "a", name: "Reviewer", status: "running" }] }), T);
  s.receive("calm", presence(), T);
  s.receive("gone", presence(), T - FRESH_MS - 1);
  const byId = Object.fromEntries(s.views(T).map(v => [v.id, v]));
  assert.equal(byId.ask.group, "needs-input");
  assert.equal(byId.err.group, "needs-input"); assert.equal(byId.err.attention, "error");
  assert.equal(byId.busy.group, "working");
  assert.equal(byId.kids.group, "working"); assert.equal(byId.kids.state, "idle"); assert.equal(byId.kids.statusLabel, "Idle");
  assert.equal(byId.kids.workerCounts.working, 1); assert.equal(byId.kids.workers[0].status, "running");
  assert.equal(byId.calm.group, "idle");
  assert.equal(byId.gone.group, "unreachable");
  assert.deepEqual(s.views(T).map(v => v.group),
    ["needs-input", "needs-input", "working", "working", "idle", "unreachable"]);
});

test("intra-group sort orders and self pinned last", () => {
  const s = store(meta("me", 100), meta("n-late", 201), meta("n-early", 202), meta("w-old", 203), meta("w-new", 204),
    meta("i-seen", 205), meta("i-unseen", 206), meta("i-recent", 207), meta("u-b", 208), meta("u-a", 209));
  s.receive("me", presence({ activity: activity("needs-input", 1) }), T);
  s.receive("n-late", presence({ activity: activity("needs-input", 50) }), T);
  s.receive("n-early", presence({ activity: activity("needs-input", 10) }), T);
  s.receive("w-old", presence({ activity: activity("working", 10, { lastToolAt: 100 }) }), T);
  s.receive("w-new", presence({ activity: activity("working", 10, { lastToolAt: 900 }) }), T);
  s.receive("i-seen", presence({ completed: 5 }), T);
  s.receive("i-recent", presence({ completed: 8 }), T);
  s.receive("i-unseen", presence({ completed: 1 }), T);
  s.receive("i-unseen", presence({ completed: 2 }), T);
  s.receive("u-b", presence(), T - FRESH_MS - 1);
  s.receive("u-a", presence(), T - FRESH_MS - 1);
  assert.deepEqual(s.views(T).map(v => v.id),
    ["n-early", "n-late", "me", "w-new", "w-old", "i-unseen", "i-recent", "i-seen", "u-a", "u-b"]);
  const me = s.views(T).find(v => v.self)!;
  assert.equal(me.group, "needs-input"); assert.equal(me.canFocus, true); assert.equal(me.focusReason, undefined);
});

test("unseen only after a newly observed completion, only for non-self, cleared by visit", () => {
  const s = store(peer, meta("me", 100));
  s.receive("peer", presence({ completed: 1 }), T);
  s.receive("me", presence({ completed: 1 }), T);
  assert.equal(s.views(T).find(v => v.id === "peer")!.unseen, false);
  s.receive("peer", presence({ completed: 2 }), T + 1);
  s.receive("me", presence({ completed: 2 }), T + 1);
  const views = s.views(T + 1);
  assert.equal(views.find(v => v.id === "peer")!.unseen, true);
  assert.equal(views.find(v => v.id === "me")!.unseen, false);
  s.markSeen("peer"); assert.equal(s.views(T + 1).find(v => v.id === "peer")!.unseen, false);
});

test("recents: dedupe, newest first, capped at 8, nextRecent skips absent and excluded ids", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const s = store(...ids.map((id, i) => meta(id, 300 + i)));
  for (const id of ids) s.pushRecent(id);
  s.pushRecent("s5");
  assert.deepEqual(s.recents, ["s5", "s9", "s8", "s7", "s6", "s4", "s3", "s2"]);
  assert.equal(s.nextRecent(), "s5");
  assert.equal(s.nextRecent("s5"), "s9");
  s.remove("s9");
  assert.ok(!s.recents.includes("s9"));
  s.peers.delete("s5"); // absent from peers without an explicit remove
  assert.equal(s.nextRecent(), "s8");
  assert.equal(new SessionStore(1).nextRecent(), undefined);
});

test("attentionLines: other reachable sessions only, at most two lines", () => {
  const s = store(meta("me", 100), meta("refactor-auth", 201), meta("api-tests", 202), meta("foo", 203));
  assert.deepEqual(s.attentionLines(T), []);
  s.receive("me", presence({ activity: activity("needs-input", 1) }), T);
  assert.deepEqual(s.attentionLines(T), [], "self never raises attention");
  s.receive("api-tests", presence({ completed: 1 }), T);
  s.receive("api-tests", presence({ completed: 2 }), T);
  assert.deepEqual(s.attentionLines(T), ["✦ api-tests finished"]);
  s.receive("refactor-auth", presence({ activity: activity("needs-input", 1) }), T);
  assert.deepEqual(s.attentionLines(T), ["⚑ refactor-auth needs input", "✦ api-tests finished"]);
  s.receive("foo", presence({ activity: activity("error", 1) }), T);
  assert.deepEqual(s.attentionLines(T), ["⚑ refactor-auth needs input", "✗ foo errored (+1 more)"]);
  assert.deepEqual(s.attentionLines(T + FRESH_MS + 1), [], "stale sessions never raise attention");
});

test("legacy (no schemaVersion) records map through deriveState", () => {
  const s = store();
  s.upsert(meta("old", 201, { status: "Running: bash" }), { legacy: true });
  let [v] = s.views(T);
  assert.equal(v.legacy, true); assert.equal(v.state, "working"); assert.equal(v.group, "working");
  assert.equal(v.statusLabel, "working · basic");
  s.receive("old", presence({ status: "Needs input", target: undefined }), T);
  [v] = s.views(T);
  assert.equal(v.state, "needs-input"); assert.equal(v.statusLabel, "Needs input"); assert.equal(v.attention, "needs-input");
  assert.equal(v.activity, undefined); assert.equal(v.since, 10);
  s.receive("old", presence({ status: "Idle" }), T);
  assert.equal(s.views(T)[0].group, "idle");
  s.upsert(meta("old", 201), { legacy: false });
  assert.equal(s.views(T)[0].legacy, false);
});

test("v2 views copy activity, tools, preview timing and session meta", () => {
  const s = store(meta("v2", 201, { host: "box", sessionId: "uuid", sessionFile: "/x.jsonl" }));
  s.receive("v2", presence({ status: "Running: edit", previewAt: 42, activity: activity("working", 30,
    { tools: ["edit"], toolDetail: "edit · auth.ts", lastAssistantAt: 70 }) }), T);
  const [v] = s.views(T);
  assert.deepEqual(v.tools, ["edit"]); assert.equal(v.toolDetail, "edit · auth.ts");
  assert.equal(v.since, 30); assert.equal(v.lastActivity, 70); assert.equal(v.previewAt, 42);
  assert.equal(v.host, "box"); assert.equal(v.sessionId, "uuid"); assert.equal(v.sessionFile, "/x.jsonl");
  assert.equal(v.statusLabel, "Running: edit");
});

test("malformed snapshots are ignored and terminal escapes are stripped", () => {
  assert.equal(parsePresence(null), undefined);
  assert.equal(parsePresence({ ...presence(), since: NaN }), undefined);
  assert.equal(parsePresence({ ...presence(), workers: [{}] }), undefined);
  assert.equal(clean("\x1b[31mhello\x1b[0m\x07"), "hello");
  assert.equal(clean("\x1b]0;bad title\x07hello"), "hello");
});

test("outline enrichment passes through; malformed drops only the outline", () => {
  const value = parsePresence({ ...presence(), outline: { now: "Editing auth.ts", topics: ["Auth fix"], lastHeading: "Auth \x1b[31mfix" } });
  assert.equal(value?.outline?.now, "Editing auth.ts");
  assert.equal(value?.outline?.lastHeading, "Auth fix");
  const bad = parsePresence({ ...presence(), outline: { now: 123 } });
  assert.ok(bad); assert.equal(bad?.outline, undefined);
  assert.equal(parseOutline(undefined), undefined);
  const s = store(peer);
  s.receive("peer", { ...presence(), outline: { now: "Summarizing" } }, T);
  assert.equal(s.views(T)[0].outline?.now, "Summarizing");
  s.receive("peer", presence(), T);
  assert.equal(s.views(T)[0].outline, undefined);
});
