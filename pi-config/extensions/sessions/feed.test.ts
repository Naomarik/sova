import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLive, feedState, hashRecord, makeHello, pidAlive, readLiveDir, STALE_MS } from "./feed.ts";
import type { LiveRecord } from "./schema.ts";

const NOW = 1789804800000;
const v2 = (): LiveRecord => JSON.parse(readFileSync(new URL("./public/examples/v2.json", import.meta.url), "utf8"));
const v1 = (): LiveRecord => JSON.parse(readFileSync(new URL("./public/examples/v1.json", import.meta.url), "utf8"));
function record(id: string, base: LiveRecord, heartbeat = NOW, pid = process.pid): LiveRecord {
  const r = structuredClone(base);
  r.session.id = id; r.session.pid = pid; r.heartbeat = heartbeat; r.session.lastActivity = heartbeat;
  return r;
}
const put = (dir: string, r: LiveRecord, name = `${r.session.id}.json`) => writeFileSync(join(dir, name), JSON.stringify(r));
/** A pid that certainly exited (reaped child), or undefined if it was recycled. */
function deadPid(): number | undefined {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  return pid && !pidAlive(pid) ? pid : undefined;
}

test("readLiveDir: freshness, derived fields, and skipping of junk", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-feed-"));
  try {
    put(dir, record("p1-aaaaaaaa", v2()));
    put(dir, record("p2-bbbbbbbb", v1(), NOW - STALE_MS - 1));
    const needs = record("p3-cccccccc", v1());
    needs.presence!.status = "Needs input";
    put(dir, needs);
    put(dir, record("p4-dddddddd", v2()), ".p4-dddddddd.4.tmp");
    put(dir, record("p5-eeeeeeee", v2()), ".hidden.json");
    put(dir, record("p6-ffffffff", v2()), "p6-ffffffff.json.bak");
    put(dir, record("mismatch", v2()), "p7-00000000.json");
    writeFileSync(join(dir, "p8-11111111.json"), "{ truncated");
    writeFileSync(join(dir, "p9-22222222.json"), JSON.stringify({ v: 1, heartbeat: "now" }));

    const sessions = readLiveDir(dir, NOW);
    assert.deepEqual(sessions.map(s => s.id), ["p1-aaaaaaaa", "p2-bbbbbbbb", "p3-cccccccc"]);
    const [a, b, c] = sessions;
    assert.equal(a.fresh, true); assert.equal(a.legacy, false); assert.equal(a.state, "working");
    assert.equal(a.attention, "none"); assert.equal(a.workersWorking, 1); assert.equal(a.age, 0);
    assert.equal(b.fresh, false, "heartbeat older than 15s"); assert.equal(b.legacy, true);
    assert.equal(b.workersWorking, 1, "falls back to countWorkers for v1 records");
    assert.equal(c.state, "needs-input"); assert.equal(c.attention, "needs-input");
    assert.deepEqual(readLiveDir(join(dir, "missing"), NOW), [], "unreadable dir ⇒ []");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hashRecord ignores heartbeat, lastActivity and note only", () => {
  const a = record("p1-aaaaaaaa", v2());
  const b = record("p1-aaaaaaaa", v2(), NOW + 3000);
  b.note = { payload: { type: "visited", to: "x" }, at: NOW + 3000 };
  assert.equal(hashRecord(a), hashRecord(b));
  const reordered = JSON.parse(JSON.stringify({ heartbeat: a.heartbeat, session: a.session, presence: a.presence, schemaVersion: 2, v: 1 }));
  assert.equal(hashRecord(a), hashRecord(reordered), "key order is irrelevant");
  b.presence!.preview = "changed";
  assert.notEqual(hashRecord(a), hashRecord(b));
});

test("diffLive: joins, heartbeat-only rewrites, payload changes, and leaves", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-feed-"));
  try {
    const hello = makeHello(dir, NOW);
    assert.deepEqual(hello, { type: "hello", at: NOW, feedVersion: 1, schemaVersion: 2, dir });

    put(dir, record("p1-aaaaaaaa", v2()));
    put(dir, record("p2-bbbbbbbb", v1()));
    let next = readLiveDir(dir, NOW);
    let events = diffLive(new Map(), next, NOW);
    assert.deepEqual(events.map(e => e.type === "upsert" && [e.session.id, e.changed]),
      [["p1-aaaaaaaa", ["session", "presence"]], ["p2-bbbbbbbb", ["session", "presence"]]]);
    let state = feedState(next);

    // Heartbeat-only rewrite (plus a transient note) ⇒ nothing.
    const beat = record("p1-aaaaaaaa", v2(), NOW + 3000);
    beat.note = { payload: { type: "hello" }, at: NOW + 3000 };
    put(dir, beat);
    put(dir, record("p2-bbbbbbbb", v1(), NOW + 3000));
    next = readLiveDir(dir, NOW + 3000);
    assert.deepEqual(diffLive(state, next, NOW + 3000), []);
    state = feedState(next);

    // Payload change ⇒ upsert with dotted paths.
    const changed = record("p1-aaaaaaaa", v2(), NOW + 6000);
    changed.presence!.activity!.state = "idle";
    changed.presence!.workers.pop();
    changed.session.name = "renamed";
    put(dir, changed);
    put(dir, record("p2-bbbbbbbb", v1(), NOW + 6000));
    next = readLiveDir(dir, NOW + 6000);
    events = diffLive(state, next, NOW + 6000);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "upsert");
    if (events[0].type === "upsert") {
      assert.deepEqual(events[0].changed, ["presence.activity", "presence.workers", "session.name"]);
      assert.equal(events[0].session.state, "idle");
      assert.equal(events[0].at, NOW + 6000);
    }
    state = feedState(next);

    // Disappearance ⇒ remove "left".
    rmSync(join(dir, "p2-bbbbbbbb.json"));
    next = readLiveDir(dir, NOW + 7000);
    assert.deepEqual(diffLive(state, next, NOW + 7000), [{ type: "remove", at: NOW + 7000, id: "p2-bbbbbbbb", reason: "left" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diffLive: stale crossing, revival, and never-fresh records", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-feed-"));
  try {
    put(dir, record("p1-aaaaaaaa", v2()));
    put(dir, record("p2-bbbbbbbb", v2(), NOW - 60_000)); // stale from the start: never announced
    let next = readLiveDir(dir, NOW);
    assert.deepEqual(diffLive(new Map(), next, NOW).map(e => e.type === "upsert" && e.session.id), ["p1-aaaaaaaa"]);
    let state = feedState(next);

    const later = NOW + STALE_MS + 1; // p1's writer paused; file unchanged
    next = readLiveDir(dir, later);
    assert.deepEqual(diffLive(state, next, later), [{ type: "remove", at: later, id: "p1-aaaaaaaa", reason: "stale" }]);
    state = feedState(next);
    assert.deepEqual(diffLive(state, readLiveDir(dir, later + 1000), later + 1000), [], "no repeated removes");

    rmSync(join(dir, "p2-bbbbbbbb.json"));
    put(dir, record("p1-aaaaaaaa", v2(), later + 2000)); // writer resumes, same payload
    next = readLiveDir(dir, later + 2000);
    const events = diffLive(state, next, later + 2000);
    assert.equal(events.length, 1, "vanished never-fresh record emits no remove");
    assert.equal(events[0].type === "upsert" && events[0].changed.join(), "fresh");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diffLive: dead pid ⇒ remove \"dead\"", t => {
  const pid = deadPid();
  if (pid === undefined) { t.skip("could not obtain a dead pid"); return; }
  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-feed-"));
  try {
    const r = record("p9-99999999", v2());
    const state = feedState(readLiveDir(dir, NOW).concat([{ id: r.session.id, record: r, fresh: true, age: 0,
      legacy: false, state: "working", attention: "none", workersWorking: 1 }]));
    put(dir, record("p9-99999999", v2(), NOW + 1000, pid));
    const next = readLiveDir(dir, NOW + 1000);
    assert.equal(next[0].fresh, false);
    assert.deepEqual(diffLive(state, next, NOW + 1000), [{ type: "remove", at: NOW + 1000, id: "p9-99999999", reason: "dead" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
