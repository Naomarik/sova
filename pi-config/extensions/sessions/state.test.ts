import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, parsePresence, parseOutline, SessionStore, FRESH_MS } from "./state.ts";
import type { Presence } from "./state.ts";

const peer = { id: "peer", pid: 200, cwd: "/tmp/project", model: "test", startedAt: 1, lastActivity: 2, endpointEpoch: "one" };
const presence = (completed = 0): Presence => ({ type: "presence", version: 1, status: "Idle", since: 10,
  completed, preview: "hello", workers: [], target: { kind: "test" } as any });
test("roster metadata is not a claim that a peer can be focused", () => {
  const s = new SessionStore(100); s.connected = true; s.roster([peer]);
  assert.equal(s.rows()[0].canFocus, false);
  assert.match(s.rows()[0].status, /basic/);
});
test("parent idle and running children remain independent", () => {
  const s = new SessionStore(100); s.connected = true; s.roster([peer]);
  s.receive("peer", { ...presence(), workers: [{ id: "a", name: "Reviewer", status: "running" }] }, 100);
  assert.equal(s.rows(101)[0].status, "Idle");
  assert.equal(s.rows(101)[0].workers[0].status, "running");
});
test("unseen only after a newly observed completion, cleared by visit", () => {
  const s = new SessionStore(100); s.connected = true; s.roster([peer]);
  s.receive("peer", presence(1), 100);
  assert.equal(s.rows(100)[0].unseen, false);
  s.receive("peer", presence(2), 101);
  assert.equal(s.rows(101)[0].unseen, true);
  s.markSeen("peer"); assert.equal(s.rows(101)[0].unseen, false);
});
test("stale, disconnected, removed and replaced endpoints cannot be focused", () => {
  const s = new SessionStore(100); s.connected = true; s.roster([peer]); s.receive("peer", presence(), 100);
  assert.ok(s.target("peer", 101));
  assert.equal(s.target("peer", 101 + FRESH_MS), undefined);
  assert.match(s.rows(101 + FRESH_MS)[0].status, /stale/);
  s.disconnect(); assert.equal(s.target("peer", 101), undefined);
  s.connected = true; assert.equal(s.target("peer", 101), undefined);
  s.receive("peer", presence(), 100); s.upsert({ ...peer, endpointEpoch: "two" });
  assert.equal(s.target("peer", 101), undefined);
  s.receive("peer", presence(), 100); s.roster([]);
  assert.equal(s.target("peer", 101), undefined); assert.equal(s.rows().length, 0);
});
test("malformed snapshots are ignored and terminal escapes are stripped", () => {
  assert.equal(parsePresence(null), undefined);
  assert.equal(parsePresence({ ...presence(), since: NaN }), undefined);
  assert.equal(parsePresence({ ...presence(), workers: [{}] }), undefined);
  assert.equal(parsePresence({ ...presence(), workers: Array(41).fill({}) }), undefined);
  assert.equal(clean("\x1b[31mhello\x1b[0m\x07"), "hello");
  assert.equal(clean("\x1b]0;bad title\x07hello"), "hello");
});
test("outline enrichment passes through when well-formed", () => {
  const value = parsePresence({ ...presence(), outline: { now: "Editing auth.ts", overall: "Fixing login", topics: ["Auth fix"], state: "fresh", generatedAt: 1 } });
  assert.equal(value?.outline?.now, "Editing auth.ts");
  assert.equal(value?.outline?.topics?.[0], "Auth fix");
});
test("a malformed outline drops only the outline, never the presence", () => {
  const value = parsePresence({ ...presence(), outline: { now: 123 } });
  assert.ok(value);
  assert.equal(value?.outline, undefined);
  assert.equal(parseOutline({ now: "ok", topics: ["a", 1] }), undefined);
  assert.equal(parseOutline({ now: "ok", topics: Array(13).fill("t") }), undefined);
  assert.equal(parseOutline(undefined), undefined);
  assert.equal(parseOutline({}), undefined);
});
test("rows expose outline when fresh, everything works without it", () => {
  const s = new SessionStore(100); s.connected = true; s.roster([peer]);
  s.receive("peer", { ...presence(), outline: { now: "Summarizing", topics: ["A"] } }, 100);
  assert.equal(s.rows(101)[0].outline?.now, "Summarizing");
  s.receive("peer", presence(), 102);
  assert.equal(s.rows(103)[0].outline, undefined);
});
test("lastHeading passes through cleaned and capped; malformed drops only the outline", () => {
  const value = parsePresence({ ...presence(), outline: { now: "Editing", lastHeading: "Auth \x1b[31mfix" } });
  assert.equal(value?.outline?.lastHeading, "Auth fix");
  assert.equal(parseOutline({ lastHeading: "x".repeat(300) })?.lastHeading?.length, 80);
  assert.deepEqual(parseOutline({ now: "ok", lastHeading: "   " }), { now: "ok" });
  const bad = parsePresence({ ...presence(), outline: { now: "ok", lastHeading: 7 } });
  assert.equal(bad?.status, "Idle");
  assert.equal(bad?.outline, undefined);
  // Older peers without the field: outline unchanged.
  assert.deepEqual(parseOutline({ now: "ok" }), { now: "ok" });
  const s = new SessionStore(100); s.connected = true; s.roster([peer]);
  s.receive("peer", { ...presence(), outline: { lastHeading: "Auth fix" } }, 100);
  assert.equal(s.rows(101)[0].outline?.lastHeading, "Auth fix");
});
