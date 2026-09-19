import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clean, countWorkers, deriveState, fit, parseLiveRecord, parsePresence } from "./schema.ts";
import type { LiveRecord, SessionMeta, WorkerEntry } from "./schema.ts";

const NOW = 1789804800000;
const example = (name: string) => JSON.parse(readFileSync(new URL(`./public/examples/${name}.json`, import.meta.url), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const meta: SessionMeta = { id: "p1-00000000", cwd: "/tmp", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

test("v1 example parses as legacy with free-text status", () => {
  const r = parseLiveRecord(example("v1"), NOW);
  assert.ok(r);
  assert.equal(r.schemaVersion, undefined);
  assert.equal(r.presence?.status, "Running: edit, read");
  assert.equal(r.presence?.activity, undefined);
  assert.equal(deriveState(r.presence, r.session), "working");
});

test("legacy metadata-only record parses without presence", () => {
  const r = parseLiveRecord(example("legacy"), NOW);
  assert.ok(r);
  assert.equal(r.presence, undefined);
  assert.equal(deriveState(r.presence, r.session), "idle");
});

test("v2 example round-trips deeply through JSON", () => {
  const v2 = example("v2");
  const r = parseLiveRecord(clone(v2), NOW);
  assert.equal(r?.schemaVersion, 2);
  assert.deepEqual(r, v2);
  assert.deepEqual(parseLiveRecord(clone(r), NOW), v2);
  assert.ok(r?.presence?.target, "valid focus target survives");
});

test("unknown keys are ignored at every level", () => {
  const v2 = example("v2");
  const noisy = clone(v2);
  noisy.extra = 1; noisy.session.future = "x"; noisy.presence.somethingNew = [1, 2];
  noisy.presence.activity.gauge = 3; noisy.presence.workers[0].priority = "high"; noisy.presence.outline.mood = "ok";
  assert.deepEqual(parseLiveRecord(noisy, NOW), v2);
});

test("invalid enum values coerce to safe defaults without dropping the record", () => {
  const v2 = example("v2");
  v2.presence.activity.state = "hyperdrive";
  v2.presence.outline.state = "confused";
  v2.session.mode = "vr";
  v2.presence.workers[2].outcome = "meh";
  const r = parseLiveRecord(v2, NOW);
  assert.ok(r?.presence?.activity);
  assert.equal(r.presence.activity.state, "idle");
  assert.equal(r.presence.outline?.state, undefined);
  assert.equal(r.presence.outline?.now, "Splitting session middleware");
  assert.equal(r.session.mode, undefined);
  assert.equal(r.presence.workers[2].outcome, undefined);
  assert.equal(deriveState(r.presence, r.session), "idle");
});

test("worker sessionFile/sessionId: kept whole, invalid values dropped per field", () => {
  const v2 = example("v2");
  const r = parseLiveRecord(clone(v2), NOW)!;
  assert.match(r.presence!.workers[0].sessionFile!, /^\/home\/dev\/\.pi\/agent\/sessions\/.+\.jsonl$/);
  assert.equal(r.presence!.workers[1].sessionFile, undefined, "claude-code workers carry only a sessionId");
  assert.equal(r.presence!.workers[1].sessionId, "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f");
  const bad = clone(v2);
  Object.assign(bad.presence.workers[0], { sessionFile: "/" + "x".repeat(1024), sessionId: "s".repeat(65) });
  Object.assign(bad.presence.workers[1], { sessionFile: 42, sessionId: "" });
  Object.assign(bad.presence.workers[2], { sessionFile: "/" + "x".repeat(1023), sessionId: "s".repeat(64) });
  const p = parseLiveRecord(bad, NOW)!.presence!;
  assert.equal(p.workers.length, 3, "an invalid optional field never rejects the worker or the record");
  for (const w of p.workers.slice(0, 2)) {
    assert.ok(!("sessionFile" in w) && !("sessionId" in w), w.id);
    assert.equal(w.name, v2.presence.workers[p.workers.indexOf(w)].name);
  }
  assert.equal(p.workers[2].sessionFile, "/" + "x".repeat(1023));
  assert.equal(p.workers[2].sessionId, "s".repeat(64));
});

test("activity.error only survives in the error state; invalid target is dropped, presence kept", () => {
  const v2 = example("v2");
  v2.presence.activity.error = "boom";
  v2.presence.target = { kind: "fake", address: "0x1" };
  let r = parseLiveRecord(v2, NOW);
  assert.equal(r?.presence?.activity?.error, undefined);
  assert.equal(r?.presence?.target, undefined);
  v2.presence.activity.state = "error";
  r = parseLiveRecord(v2, NOW);
  assert.equal(r?.presence?.activity?.error, "boom");
  assert.equal(deriveState(r?.presence, r!.session), "error");
});

test("malformed records are rejected, never thrown", () => {
  const v1 = example("v1");
  const mutate = (fn: (r: any) => void) => { const r = clone(v1); fn(r); return parseLiveRecord(r, NOW); };
  assert.equal(mutate(r => delete r.session.pid), undefined);
  assert.equal(mutate(r => { r.heartbeat = String(r.heartbeat); }), undefined);
  assert.equal(mutate(r => { r.v = 2; }), undefined);
  assert.equal(mutate(r => { r.schemaVersion = 3; }), undefined);
  assert.equal(mutate(r => { r.session.id = "../evil"; }), undefined);
  assert.equal(mutate(r => { r.session.id = "p1-\x1b[2J"; }), undefined);
  assert.equal(mutate(r => { r.heartbeat = NOW + 3_600_000; }), undefined, "far-future heartbeat");
  for (const bad of [null, undefined, 42, "x", [], { v: 1 }]) assert.equal(parseLiveRecord(bad, NOW), undefined);
  // A broken presence block drops only the presence, like v1 readers.
  const r = mutate(r => { r.presence.since = "soon"; });
  assert.ok(r); assert.equal(r.presence, undefined);
});

test("control characters are stripped and fields bounded", () => {
  const v2 = example("v2");
  v2.session.name = "\x1b]0;pwned\x07evil\x1b[31mname\x00" + "x".repeat(200);
  v2.presence.preview = "a\x9bb" + "文".repeat(5000);
  v2.presence.activity.toolDetail = "edit · " + "f".repeat(200);
  v2.presence.activity.tools = Array.from({ length: 20 }, (_, i) => `t${i}`);
  v2.presence.activity.buckets = Array.from({ length: 40 }, (_, i) => i);
  v2.presence.outline.topics = Array.from({ length: 30 }, () => "t");
  v2.presence.outline.detail = Array.from({ length: 10 }, () => ({ heading: "h", bullets: ["1", "2", "3", "4", "5"] }));
  v2.presence.workers = Array.from({ length: 60 }, (_, i) => ({ id: `w${i}`, name: "n", status: "running" }));
  const r = parseLiveRecord(v2, NOW)!;
  assert.ok(r.session.name!.startsWith("evilname"));
  assert.equal(r.session.name!.length, 80);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(r.presence!.preview));
  assert.equal(r.presence!.preview.length, 2000);
  assert.equal(r.presence!.activity!.toolDetail!.length, 60);
  assert.equal(r.presence!.activity!.tools!.length, 6);
  assert.deepEqual(r.presence!.activity!.buckets, Array.from({ length: 16 }, (_, i) => 24 + i), "newest 16 buckets kept");
  assert.equal(r.presence!.outline!.topics!.length, 12);
  assert.equal(r.presence!.outline!.detail!.length, 6);
  assert.ok(r.presence!.outline!.detail!.every(d => d.bullets.length === 3));
  assert.equal(r.presence!.workers.length, 40);
  assert.equal(clean("a\x1b[1mb\x1b]2;t\x1b\\c\x00"), "abc");
  assert.equal(clean("x\x1b]0;title\x07y\x9b", 1), "x");
});

test("parsePresence keeps v1 required fields mandatory", () => {
  const p = example("v1").presence;
  assert.ok(parsePresence(p));
  for (const key of ["type", "version", "status", "since", "completed", "preview", "workers"]) {
    const bad = clone(p); delete bad[key];
    assert.equal(parsePresence(bad), undefined, key);
  }
  const badWorker = clone(p); badWorker.workers.push({ id: "x", name: 3, status: "running" });
  assert.equal(parsePresence(badWorker), undefined);
});

test("fit() drops fields in contract order as the budget shrinks", () => {
  const record = example("v2") as LiveRecord;
  const p = record.presence!;
  p.preview = "文".repeat(2000);
  p.workers = Array.from({ length: 40 }, (_, i): WorkerEntry => ({ id: `w${i}`, name: "文".repeat(40),
    status: i % 4 === 0 ? "done" : "running", preview: "文".repeat(180) }));
  const size = (r: LiveRecord) => Buffer.byteLength(JSON.stringify(r));
  const trimmed = (fn: (r: LiveRecord) => void) => { const r = clone(record); fn(r); return size(r); };

  const noDetail = trimmed(r => delete r.presence!.outline!.detail);
  const noBuckets = trimmed(r => { delete r.presence!.outline!.detail; delete r.presence!.activity!.buckets; });
  const shortPreview = trimmed(r => { delete r.presence!.outline!.detail; delete r.presence!.activity!.buckets;
    r.presence!.preview = r.presence!.preview.slice(0, 600); });
  const noOverall = trimmed(r => { delete r.presence!.outline!.detail; delete r.presence!.activity!.buckets;
    r.presence!.preview = r.presence!.preview.slice(0, 600); delete r.presence!.outline!.overall; delete r.presence!.outline!.topics; });

  let r = fit(clone(record), noDetail);
  assert.equal(r.presence!.outline!.detail, undefined);
  assert.ok(r.presence!.activity!.buckets);
  assert.equal(r.presence!.preview.length, 2000);

  r = fit(clone(record), noBuckets);
  assert.equal(r.presence!.activity!.buckets, undefined);
  assert.equal(r.presence!.preview.length, 2000);

  r = fit(clone(record), shortPreview);
  assert.equal(r.presence!.preview.length, 600);
  assert.ok(r.presence!.outline!.overall);

  r = fit(clone(record), noOverall);
  assert.equal(r.presence!.outline!.overall, undefined);
  assert.equal(r.presence!.outline!.topics, undefined);
  assert.equal(r.presence!.outline!.now, "Splitting session middleware", "outline.now survives");
  assert.equal(r.presence!.workers.length, 40);

  r = fit(clone(record), noOverall - 1);
  assert.equal(r.presence!.workers.length, 39);
  assert.equal(r.presence!.workers.at(-1)!.id, "w39", "finished workers go first regardless of position");
  assert.ok(!r.presence!.workers.some(w => w.id === "w36"));

  r = fit(clone(record), 16_384);
  assert.ok(size(r) <= 16_384);
  assert.ok(r.presence!.workers.length < 40);
  assert.ok(r.presence!.workers.every(w => w.status === "running"), "all 10 finished workers dropped before any running one");
  const running = record.presence!.workers.filter(w => w.status === "running").map(w => w.id);
  assert.deepEqual(r.presence!.workers.map(w => w.id), running.slice(0, r.presence!.workers.length), "then popped from the end");
  assert.deepEqual(r.presence!.workerCounts, record.presence!.workerCounts, "tally kept truthful");

  r = fit(clone(record), 1);
  assert.equal(r.presence!.workers.length, 0, "never throws when the budget is unreachable");
  const small = example("legacy");
  assert.deepEqual(fit(clone(small), 10), small);
});

test("deriveState maps the exact v1 status strings", () => {
  const cases: [string, string][] = [["Idle", "idle"], ["Running", "working"], ["Running: bash, read", "working"],
    ["Needs input", "needs-input"], ["Error", "error"], ["Disconnected", "idle"]];
  for (const [status, state] of cases) {
    const p = { type: "presence", version: 1, status, since: 1, completed: 0, preview: "", workers: [] } as const;
    assert.equal(deriveState({ ...p, workers: [] }, meta), state, status);
    assert.equal(deriveState(undefined, { ...meta, status }), state, `session.status ${status}`);
  }
  assert.equal(deriveState(undefined, meta), "idle");
});

test("countWorkers tallies states, unknown status counts as working", () => {
  const w = (status: string): WorkerEntry => ({ id: status, name: status, status });
  assert.deepEqual(countWorkers(["starting", "running", "stopping", "waiting", "done", "error", "killed",
    "Busy", "teleporting", "completed", "failed"].map(w)),
  { total: 11, working: 5, waiting: 1, done: 2, error: 2, killed: 1 });
  assert.deepEqual(countWorkers([]), { total: 0, working: 0, waiting: 0, done: 0, error: 0, killed: 0 });
});
