import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clean, countWorkers, deriveState, fit, isFinishedWorker, isRestoredWorker, parseLiveRecord, parsePresence, presenceWorkers, RECORD_BUDGET, workerState } from "./schema.ts";
import type { LiveRecord, SessionMeta, WorkerEntry } from "./schema.ts";

const NOW = 1789804800000;
const example = (name: string) => JSON.parse(readFileSync(new URL(`./public/examples/${name}.json`, import.meta.url), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const bytes = (record: LiveRecord) => Buffer.byteLength(JSON.stringify(record));
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

test("worker effort: kept whole, invalid values dropped, absent stays absent", () => {
  const v2 = example("v2");
  const r = parseLiveRecord(clone(v2), NOW)!;
  assert.equal(r.presence!.workers[0].effort, "high");
  assert.equal(r.presence!.workers[1].effort, "medium");
  assert.ok(!("effort" in r.presence!.workers[2]), "a record written before effort existed still decodes without it");
  const bad = clone(v2);
  Object.assign(bad.presence.workers[0], { effort: "e".repeat(33) });
  Object.assign(bad.presence.workers[1], { effort: 3 });
  Object.assign(bad.presence.workers[2], { effort: "" });
  const p = parseLiveRecord(bad, NOW)!.presence!;
  assert.equal(p.workers.length, 3, "an invalid effort never rejects the worker or the record");
  for (const w of p.workers) assert.ok(!("effort" in w), w.id);
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
  assert.deepEqual(r.presence!.workers.map(w => w.id), running.slice(0, r.presence!.workers.length), "then live ones popped from the end");
  assert.deepEqual(r.presence!.workerCounts, record.presence!.workerCounts, "tally kept truthful");

  r = fit(clone(record), 1);
  assert.equal(r.presence!.workers.length, 0, "never throws when the budget is unreachable");
  const small = example("legacy");
  assert.deepEqual(fit(clone(small), 10), small);
});

test("worker usage: bad counts read as 0, a bad object is dropped, the total keeps its lifetime count", () => {
  const base = { type: "presence", version: 1, status: "Idle", since: 1, completed: 0, preview: "" };
  const p = parsePresence({ ...base,
    workers: [
      { id: "a", name: "a", status: "running", usage: { input: 10, output: 2, cacheRead: 300, cacheWrite: 40, cost: 0.5 } },
      { id: "b", name: "b", status: "done", usage: { input: -5, output: "x", cacheRead: Number.NaN, cacheWrite: 9.7, cost: -1 } },
      { id: "c", name: "c", status: "running", usage: [1, 2] },
    ],
    workerUsage: { input: 10_000, output: 900, cacheRead: 1, cacheWrite: 2, cost: 3.5, workers: 99 } });
  assert.ok(p);
  assert.deepEqual(p.workers[0].usage, { input: 10, output: 2, cacheRead: 300, cacheWrite: 40, cost: 0.5 });
  assert.deepEqual(p.workers[1].usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 9 }, "floored, clamped, no negative cost");
  assert.equal(p.workers[2].usage, undefined, "a non-object usage never invalidates the worker");
  assert.deepEqual(p.workerUsage, { input: 10_000, output: 900, cacheRead: 1, cacheWrite: 2, cost: 3.5, workers: 99 });
  assert.ok(p.workerUsage!.workers > p.workers.length, "the \u03a3 is a lifetime total, not the sum of the rows");

  const bad = parsePresence({ ...base, workers: [], workerUsage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, workers: -2 } });
  assert.deepEqual(bad?.workerUsage, { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, workers: 0 }, "a bad lifetime count reads as 0");
  assert.equal(parsePresence({ ...base, workers: [], workerUsage: 7 })?.workerUsage, undefined, "a non-object total is dropped");
});

test("worker turns: a top-level count, dropped when not a non-negative integer, kept when fit() drops usage", () => {
  const base = { type: "presence", version: 1, status: "Idle", since: 1, completed: 0, preview: "" };
  const p = parsePresence({ ...base,
    workers: [
      { id: "a", name: "a", status: "running", turns: 7 },
      { id: "b", name: "b", status: "done", turns: 0 },
      { id: "c", name: "c", status: "done", turns: -1 },
      { id: "d", name: "d", status: "done", turns: 2.5 },
      { id: "e", name: "e", status: "done", turns: "3" },
      { id: "f", name: "f", status: "done" },
    ] });
  assert.ok(p);
  assert.deepEqual(p.workers.map(w => w.turns), [7, 0, undefined, undefined, undefined, undefined]);
  assert.ok(!("turns" in p.workers[5]), "absent stays absent: unknown is never 0");

  const record = example("v2") as LiveRecord;
  const usage = { input: 1_234_567, output: 234_567, cacheRead: 9_876_543, cacheWrite: 345_678, cost: 12.345678 };
  // Nothing fit() gives up before workers' usage, so the budget lands on the usage step.
  delete record.presence!.outline;
  delete record.presence!.activity;
  record.presence!.preview = "";
  record.presence!.workers = [{ id: "live", name: "live", status: "running", turns: 12, usage: { ...usage } }];
  const withUsage = bytes(record);
  delete record.presence!.workers[0].usage;
  const without = bytes(record);
  record.presence!.workers[0].usage = { ...usage };
  const r = fit(clone(record), Math.floor((withUsage + without) / 2));
  assert.equal(r.presence!.workers[0].usage, undefined, "usage went first");
  assert.equal(r.presence!.workers[0].turns, 12, "turns rides outside usage and survives");
});

test("fit() drops settled rows' usage before any row, and live usage before any live row", () => {
  const record = example("v2") as LiveRecord;
  const p = record.presence!;
  const usage = { input: 1_234_567, output: 234_567, cacheRead: 9_876_543, cacheWrite: 345_678, cost: 12.345678 };
  p.workers = Array.from({ length: 40 }, (_, i): WorkerEntry => ({ id: `w${i}`, name: `worker-${i}`,
    status: i % 4 === 0 ? "done" : "running", usage: { ...usage } }));
  p.workerUsage = { ...usage, workers: 137 };
  const size = (r: LiveRecord) => Buffer.byteLength(JSON.stringify(r));
  const settledBare = (() => { const r = clone(record); for (const w of r.presence!.workers) if (w.status === "done") delete w.usage; return size(r); })();
  assert.ok(settledBare < size(record), "usage is worth dropping");

  const r = fit(clone(record), settledBare);
  assert.equal(r.presence!.workers.length, 40, "every row survives");
  assert.ok(r.presence!.workers.every(w => (w.usage === undefined) === (w.status === "done")), "only settled rows lost their counts");
  assert.deepEqual(r.presence!.workerUsage, p.workerUsage, "the lifetime \u03a3 is kept");

  // Everything the earlier steps can give up, no settled row and no live usage: below that, live rows go.
  const floor = (() => {
    const r = clone(record); const q = r.presence!;
    delete q.outline!.detail; delete q.activity!.buckets; delete q.outline!.overall; delete q.outline!.topics;
    q.preview = Array.from(q.preview).slice(0, 600).join("");
    q.workers = q.workers.filter(w => w.status !== "done");
    for (const w of q.workers) delete w.usage;
    return size(r);
  })();
  const atFloor = fit(clone(record), floor);
  assert.equal(atFloor.presence!.workers.length, 30);
  assert.ok(atFloor.presence!.workers.every(w => w.status === "running" && w.usage === undefined));
  const tight = fit(clone(record), floor - 1);
  assert.ok(tight.presence!.workers.length < 30, "then live rows go, from the end");
  assert.deepEqual(tight.presence!.workerUsage, p.workerUsage);
  assert.ok(size(fit(clone(record), 16_384)) <= 16_384);
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

test("restored workers count in total only, are neither working nor finished, and drop before live rows", () => {
  const w = (id: string, status: string): WorkerEntry => ({ id, name: id, status });
  assert.equal(workerState("restored"), "restored");
  assert.equal(workerState(" Restored "), "restored");
  assert.deepEqual(countWorkers([w("a", "restored"), w("b", "running"), w("c", "done")]),
    { total: 3, working: 1, waiting: 0, done: 1, error: 0, killed: 0 });
  assert.equal(isFinishedWorker(w("a", "restored")), false);
  assert.equal(isRestoredWorker(w("a", "restored")), true);
  assert.equal(isRestoredWorker(w("a", "waiting")), false);
});

test("restored-worker fields and usage Σ extras pass through validated; invalid ones are dropped", () => {
  const good = parsePresence({ type: "presence", version: 1, status: "Idle", since: 1, completed: 0, preview: "",
    workers: [{ id: "ag_01", name: "w", status: "restored", restored: true, usageSource: "snapshot", usageAsOf: 5, interruptedAt: 6, resumable: true }],
    workerUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, workers: 1, asOf: 5, restored: 1 } })!;
  assert.deepEqual(good.workers[0], { id: "ag_01", name: "w", status: "restored", restored: true, usageSource: "snapshot", usageAsOf: 5, interruptedAt: 6, resumable: true });
  assert.deepEqual(good.workerUsage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, workers: 1, asOf: 5, restored: 1 });
  const bad = parsePresence({ type: "presence", version: 1, status: "Idle", since: 1, completed: 0, preview: "",
    workers: [{ id: "ag_01", name: "w", status: "restored", restored: "yes", usageSource: "guess", usageAsOf: "x", interruptedAt: NaN, resumable: 1 }],
    workerUsage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, workers: 1, asOf: "x", restored: -1 } })!;
  assert.deepEqual(bad.workers[0], { id: "ag_01", name: "w", status: "restored" });
  assert.deepEqual(bad.workerUsage, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, workers: 1 });
});

test("fit() drops restored rows before live ones", () => {
  const w = (id: string, status: string): WorkerEntry => ({ id, name: id, status, preview: "x".repeat(150) });
  const record = { v: 1, heartbeat: 1, session: { id: "p1-a", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
    presence: { type: "presence", version: 1, status: "Idle", since: 1, completed: 0, preview: "",
      workers: [w("live", "running"), w("ghost", "restored"), w("idle", "waiting")] } } as unknown as LiveRecord;
  const size = Buffer.byteLength(JSON.stringify(record));
  const out = fit(record, size - 100);
  assert.deepEqual(out.presence!.workers.map(x => x.id), ["live", "idle"]);
});

/** A session that has started 57 workers, in spawn order (the manager's): 56 restored and
 *  stopped, then ag_57 running. Sized like the real record that lost ag_57. */
function crowded(): WorkerEntry[] {
  const usage = { input: 12_345, output: 6_789, cacheRead: 234_567, cacheWrite: 34_567, cost: 0.4123 };
  return Array.from({ length: 57 }, (_, i): WorkerEntry => {
    const n = String(i + 1).padStart(2, "0");
    const live = i === 56;
    return { id: `ag_${n}`, name: `bw-r2-reviewer-${n}`, status: live ? "running" : "killed", model: "claude-opus-5-5[1m]", effort: "high",
      preview: "plan delivered; see the report in the worktree for the full list of findings",
      backend: "claude-code", sessionId: `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`, startedAt: 1_000 + i, lastActivity: 2_000 + i,
      ...(live ? {} : { endedAt: 3_000 + i, outcome: "success" as const, restored: true as const, usageSource: "transcript" as const,
        usageAsOf: 1_790_495_397_765, resumable: true as const }),
      usage: { ...usage } };
  });
}

test("presenceWorkers: live workers first, then newest, capped at 40", () => {
  const rows = presenceWorkers(crowded());
  assert.equal(rows.length, 40);
  assert.equal(rows[0].id, "ag_57", "the running worker survives the cap");
  assert.deepEqual(rows.slice(1).map(w => w.id), Array.from({ length: 39 }, (_, i) => `ag_${String(56 - i).padStart(2, "0")}`),
    "then settled ones, newest first");
  const mixed: WorkerEntry[] = [
    { id: "a", name: "a", status: "waiting", startedAt: 1 }, { id: "b", name: "b", status: "done", startedAt: 5 },
    { id: "c", name: "c", status: "restored", startedAt: 9 }, { id: "d", name: "d", status: "starting" },
    { id: "e", name: "e", status: "running", startedAt: 3 }, { id: "f", name: "f", status: "waiting", startedAt: 3, restored: true },
  ];
  assert.deepEqual(presenceWorkers(mixed).map(w => w.id), ["e", "a", "d", "c", "b", "f"],
    "waiting counts as live, a restored flag as settled; no startedAt sorts oldest, ties go to the later spawn");
});

test("fit() keeps a crowded session's running worker, with its usage", () => {
  const record = example("v2") as LiveRecord;
  record.presence!.workers = presenceWorkers(crowded());
  record.presence!.workerCounts = countWorkers(crowded());
  const r = fit(clone(record), 16_384);
  const rows = r.presence!.workers;
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 16_384);
  assert.ok(rows.length > 1 && rows.length < 40, `${rows.length} rows`);
  assert.equal(rows[0].id, "ag_57");
  assert.deepEqual(rows[0].usage, crowded()[56].usage, "the live worker keeps its counts");
  assert.deepEqual(rows.map(w => w.id), record.presence!.workers.slice(0, rows.length).map(w => w.id), "settled rows dropped oldest first");
  assert.equal(r.presence!.workerCounts!.total, 57, "tally kept truthful");
});

test("fit() drops every settled row before a live worker's usage", () => {
  const record = example("v2") as LiveRecord;
  const p = record.presence!;
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  p.workers = Array.from({ length: 20 }, (_, i): WorkerEntry => ({ id: `w${i}`, name: "文".repeat(40),
    status: i < 5 ? "running" : "done", usage: { ...usage } }));
  const size = (r: LiveRecord) => Buffer.byteLength(JSON.stringify(r));
  const base = clone(record);
  delete base.presence!.outline!.detail; delete base.presence!.activity!.buckets;
  base.presence!.preview = base.presence!.preview.slice(0, 600); delete base.presence!.outline!.overall; delete base.presence!.outline!.topics;
  const liveOnly = clone(base); liveOnly.presence!.workers = liveOnly.presence!.workers.slice(0, 5);
  const settledBare = clone(base); for (const w of settledBare.presence!.workers.slice(5)) delete w.usage;

  let r = fit(clone(record), size(settledBare));
  assert.equal(r.presence!.workers.length, 20, "settled rows lose their counts first");
  assert.ok(r.presence!.workers.slice(0, 5).every(w => w.usage) && r.presence!.workers.slice(5).every(w => !w.usage));

  r = fit(clone(record), size(liveOnly));
  assert.deepEqual(r.presence!.workers.map(w => w.id), ["w0", "w1", "w2", "w3", "w4"]);
  assert.ok(r.presence!.workers.every(w => w.usage), "no live row lost its counts while a settled row was left");

  r = fit(clone(record), size(liveOnly) - 1);
  assert.equal(r.presence!.workers.length, 5, "then live counts go, before any live row");
  assert.ok(r.presence!.workers.every(w => !w.usage));
});

test("presence.llm: the process's counts kept whole; a malformed one is dropped, the presence kept", () => {
  const base = clone(example("v2"));
  const llm = { v: 1, producer: "8c1f0d6e-5b7c-4f7e-9c34-0b7a1e2d3c4f", pid: 4242, active: 3, approximate: 1, claudeTurns: 1, degraded: false, folded: ["a", "b"] };
  base.presence.llm = { ...llm, folded: ["b", "a", "b"] };
  assert.deepEqual(parsePresence(base.presence)?.llm, llm, "folded sorted, deduplicated");
  const { folded: _f, ...older } = llm;
  base.presence.llm = older;
  assert.deepEqual(parsePresence(base.presence)?.llm?.folded, [], "absent folded reads as []");
  for (const bad of [
    { ...llm, v: 2 }, { ...llm, producer: "" }, { ...llm, pid: 0 }, { ...llm, active: -1 }, { ...llm, claudeTurns: 1.5 },
    { ...llm, degraded: "no" }, { ...llm, producer: "x".repeat(65) }, { ...llm, folded: "a" }, { ...llm, folded: [""] },
    { ...llm, folded: Array.from({ length: 257 }, (_, i) => `p${i}`) }, "3",
  ]) {
    base.presence.llm = bad;
    const p = parsePresence(base.presence);
    assert.ok(p, "the presence survives");
    assert.equal(p.llm, undefined);
  }
  base.presence.llm = { ...llm, approximate: 9 };
  assert.equal(parsePresence(base.presence)?.llm?.approximate, 3, "never more approximate than active");
});

test("presence.llm.tokens: additive; kept whole when valid, dropped alone (the counts stay) when not", () => {
  const base = clone(example("v2"));
  const llm = { v: 1, producer: "p1", pid: 4242, active: 0, approximate: 0, claudeTurns: 0, degraded: false, folded: [] };
  const tokens = { bucketMs: 30000, end: 59_000_000, out: Array.from({ length: 60 }, (_, i) => i * 1000) };
  base.presence.llm = { ...llm, tokens };
  assert.deepEqual(parsePresence(base.presence)?.llm, { ...llm, tokens });
  base.presence.llm = { ...llm, tokens: { ...tokens, partial: true } };
  assert.equal(parsePresence(base.presence)?.llm?.tokens?.partial, true);
  assert.equal("tokens" in parsePresence({ ...base.presence, llm })!.llm!, false, "absent: an older counter");
  for (const bad of [
    { ...tokens, bucketMs: 60000 }, { ...tokens, end: -1 }, { ...tokens, end: 1.5 }, { ...tokens, out: tokens.out.slice(1) },
    { ...tokens, out: [...tokens.out.slice(1), -1] }, { ...tokens, out: [...tokens.out.slice(1), 10_000_001] }, "x",
  ]) {
    base.presence.llm = { ...llm, tokens: bad };
    const got = parsePresence(base.presence)?.llm;
    assert.deepEqual(got, llm, "the counts survive a bad ring");
  }
});

test("presence.llm at its largest survives fit() whole, inside the budget, beside the largest presence", () => {
  const record = example("v2") as LiveRecord;
  const p = record.presence!;
  p.preview = "文".repeat(4000);
  p.workers = Array.from({ length: 40 }, (_, i): WorkerEntry => ({ id: `w${i}`, name: "文".repeat(40),
    status: i % 2 ? "done" : "running", preview: "文".repeat(180) }));
  // 64 folded ids of 64 characters each: the most the tracker ever writes (MAX_FOLDED)
  const folded = Array.from({ length: 64 }, (_, i) => `${"f".repeat(60)}${String(i).padStart(4, "0")}`).sort();
  const tokens = { bucketMs: 30000 as const, end: 99_999_999, out: new Array<number>(60).fill(10_000_000), partial: true as const };
  const llm = { v: 1 as const, producer: "p".repeat(64), pid: 2_147_483_647, active: 9999, approximate: 9999, claudeTurns: 9999, degraded: true, folded, tokens };
  p.llm = structuredClone(llm);
  const size = (r: LiveRecord) => Buffer.byteLength(JSON.stringify(r));
  assert.ok(size(record) > RECORD_BUDGET, "the fixture starts over the budget");
  const fitted = fit(structuredClone(record));
  assert.ok(size(fitted) <= RECORD_BUDGET, `fitted ${size(fitted)} ≤ ${RECORD_BUDGET}`);
  assert.deepEqual(fitted.presence!.llm, llm, "fit never trims the count");
  assert.deepEqual(parsePresence(fitted.presence)?.llm, llm, "and it reads back whole");
  assert.ok(fitted.presence!.workers.some((w) => w.status === "running"), "room is left for live workers too");
});
