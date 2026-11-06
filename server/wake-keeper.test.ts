import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { publishWakes, readWakeRecords, wakesCancelledBefore } from "../pi-config/extensions/subagents/wake-store.ts";
import { cancelChatWakes } from "./wake-keeper-live";
import { CONFIRM_MS, LEAD_MS, TRY_GAPS_MS, WakeKeeper, type WakeKeeperDeps, type WakeWorker } from "./wake-keeper";

const PATH = "/sessions/chat.jsonl";

function rig(o: Partial<WakeKeeperDeps> = {}, files?: { dir: string; triesFile: string }) {
  const root = mkdtempSync(join(tmpdir(), "wake-keeper-"));
  const where = files ?? { dir: join(root, "wake"), triesFile: join(root, "wake", "keeper", "tries.json") };
  const r = {
    now: 1_000_000,
    calls: [] as string[],
    running: new Set<string>(),
    summaries: new Map<string, { archived: boolean; live: boolean } | null>(),
    workers: new Map<string, WakeWorker>(),
    openFails: false,
    onOpen: undefined as undefined | ((path: string) => void | Promise<void>),
    root,
    ...where,
  };
  const deps: WakeKeeperDeps = {
    ...where,
    now: () => r.now,
    summary: async (p) => (r.summaries.has(p) ? r.summaries.get(p)! : { archived: false, live: false }),
    running: (p) => r.running.has(p),
    worker: (id) => r.workers.get(id),
    open: async (p) => {
      r.calls.push(`open ${p}`);
      await r.onOpen?.(p);
      if (r.openFails) throw new Error("no start");
    },
    resumeWorker: async (id) => void r.calls.push(`resume ${id}`),
    log: () => {},
    ...o,
  };
  return { ...r, r, deps, keeper: new WakeKeeper(deps), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const put = (dir: string, items: { id: string; at: number }[], o: { id?: string; path?: string; source?: string; now?: number } = {}) =>
  publishWakes({ dir, sessionId: o.id ?? "chat", path: o.path ?? PATH }, o.source ?? "nudges", items, o.now ?? 0);
const opens = (calls: string[]) => calls.filter((c) => c.startsWith("open")).length;

test("a shut-down chat is started just before its nudge is due, not sooner; a tick after that starts nothing more", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now + LEAD_MS + 5000 }]);
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 0, "too early");
  t.r.now += 5000;
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 1);
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 1, "within the chat's time to fire");
  assert.equal(readWakeRecords(t.dir).length, 1, "and its record is not judged before that time is up");
  t.cleanup();
});

test("single start per chat: two sources due at once and overlapping sweeps start it once", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now }, { id: "n2", at: t.r.now }]);
  put(t.dir, [{ id: "ag_01:n1", at: t.r.now }], { source: "team" });
  let release!: () => void;
  t.r.onOpen = () => new Promise<void>((done) => (release = done));
  const first = t.keeper.tick();
  while (!release) await new Promise((r) => setImmediate(r));
  await t.keeper.tick(); // a second sweep while the start is in flight
  release();
  await first;
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 1);
  t.cleanup();
});

test("catch-up goes one chat at a time, the longest overdue first", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now - 100 }], { id: "b", path: "/b.jsonl" });
  put(t.dir, [{ id: "n1", at: t.r.now - 900 }], { id: "a", path: "/a.jsonl" });
  let inFlight = 0;
  let most = 0;
  t.r.onOpen = async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
  };
  await t.keeper.tick();
  assert.deepEqual(t.r.calls, ["open /a.jsonl", "open /b.jsonl"]);
  assert.equal(most, 1);
  t.cleanup();
});

test("left alone: a running chat and a chat open in a terminal, with no try spent", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now - 1000 }]);
  t.r.running.add(PATH);
  for (let i = 0; i < 5; i++) {
    await t.keeper.tick();
    t.r.now += 10 * 60_000;
  }
  t.r.running.clear();
  t.r.summaries.set(PATH, { archived: false, live: true });
  for (let i = 0; i < 5; i++) {
    await t.keeper.tick();
    t.r.now += 10 * 60_000;
  }
  assert.equal(opens(t.r.calls), 0);
  assert.equal(readWakeRecords(t.dir).length, 1);
  t.r.summaries.delete(PATH);
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 1, "free to start once it isn't");
  t.cleanup();
});

test("an archived chat is never started, and its record goes; so does a chat whose file is gone", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now }]);
  put(t.dir, [{ id: "n1", at: t.r.now }], { id: "gone", path: "/gone.jsonl" });
  t.r.summaries.set(PATH, { archived: true, live: false });
  t.r.summaries.set("/gone.jsonl", null);
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 0);
  assert.deepEqual(readWakeRecords(t.dir), []);
  t.cleanup();
});

test("a chat that can't start: 3 tries with growing gaps, then the nudge waits for the next open", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now }]);
  t.r.openFails = true;
  const at: number[] = [];
  const start = t.r.now;
  t.r.onOpen = () => void at.push(t.r.now - start);
  for (let i = 0; i < 200; i++) {
    await t.keeper.tick();
    t.r.now += 10_000;
  }
  assert.equal(at.length, 3);
  assert.ok(at[1]! - at[0]! >= TRY_GAPS_MS[0]!);
  assert.ok(at[2]! - at[1]! >= TRY_GAPS_MS[1]!);
  assert.ok(TRY_GAPS_MS[1]! > TRY_GAPS_MS[0]!, "the gaps grow");
  assert.equal(readWakeRecords(t.dir).length, 1, "still pending");
  t.cleanup();
});

test("a chat that starts and doesn't fire is a failed try, bounded the same, and a restart of Sova doesn't reset it", async () => {
  const t = rig();
  // Its extension publishes at each start (a live record, the nudge still in it), and never fires.
  put(t.dir, [{ id: "n1", at: t.r.now }]);
  t.r.onOpen = () => put(t.dir, [{ id: "n1", at: 1_000_000 }], { now: t.r.now });
  for (let i = 0; i < 30; i++) {
    await t.keeper.tick();
    t.r.now += 10_000;
  }
  assert.equal(opens(t.r.calls), 2, "two tries so far");
  const next = rig({}, { dir: t.dir, triesFile: t.triesFile });
  next.r.now = t.r.now;
  next.r.onOpen = () => put(t.dir, [{ id: "n1", at: 1_000_000 }], { now: next.r.now });
  for (let i = 0; i < 200; i++) {
    await next.keeper.tick();
    next.r.now += 10_000;
  }
  assert.equal(opens(next.r.calls), 1, "one try left, however long it runs");
  assert.equal(readWakeRecords(t.dir).length, 1, "the nudge waits for the next open");
  // Delivered at that open: its tries go with it, and the next nudge has its own.
  next.r.onOpen = undefined;
  put(t.dir, [], {});
  put(t.dir, [{ id: "n2", at: next.r.now }]);
  await next.keeper.tick();
  await next.keeper.tick();
  assert.equal(opens(next.r.calls), 2);
  t.cleanup();
  next.cleanup();
});

test("a given-up item doesn't hold back a later one: the later item starts its own count of tries", async () => {
  const t = rig();
  // A comes due; each start republishes it (a live record) and never delivers it.
  put(t.dir, [{ id: "a", at: t.r.now }]);
  t.r.onOpen = () => put(t.dir, [{ id: "a", at: 1_000_000 }], { now: t.r.now });
  for (let i = 0; i < 200; i++) {
    await t.keeper.tick();
    t.r.now += 10_000;
  }
  assert.equal(opens(t.r.calls), 3, "A had its 3 tries and waits for the user's open");
  // B comes due later, published with a fresh syncedAt; A is still in the record.
  const items = () => [{ id: "a", at: 1_000_000 }, { id: "b", at: t.r.now }];
  put(t.dir, items(), { now: t.r.now });
  t.r.onOpen = () => put(t.dir, items(), { now: t.r.now });
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 4, "B brings the chat back");
  for (let i = 0; i < 200; i++) {
    await t.keeper.tick();
    t.r.now += 10_000;
  }
  assert.equal(opens(t.r.calls), 6, "B has its own 3 tries, and A none more");
  assert.equal(readWakeRecords(t.dir).length, 1, "both still wait for the next open");
  t.cleanup();
});

test("a due record for a chat with no such nudge costs one start and goes, past two idle cycles", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now }]);
  t.r.onOpen = () => put(t.dir, [], {}); // the chat rebuilds from its branch and publishes nothing
  for (let i = 0; i < 400; i++) {
    await t.keeper.tick();
    t.r.now += 10_000;
  }
  assert.equal(opens(t.r.calls), 1);
  assert.deepEqual(readWakeRecords(t.dir), []);
  t.cleanup();
});

test("a chat that starts and never publishes (the extension off) doesn't know the record: it goes", async () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: t.r.now }]);
  await t.keeper.tick();
  t.r.now += CONFIRM_MS + 1000;
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 1);
  assert.deepEqual(readWakeRecords(t.dir), []);
  assert.equal(existsSync(t.dir), true);
  t.cleanup();
});

test("a worker comes back through its parent: the parent starts, then the worker; only then does the keeper count on a fire", async () => {
  const t = rig();
  const worker: WakeWorker = { parentPath: "/parent.jsonl", parentSessionId: "p", workerId: "ag_01", running: false };
  t.r.workers.set("w", worker);
  put(t.dir, [{ id: "n1", at: t.r.now }], { id: "w", path: "/worker.jsonl" });
  await t.keeper.tick();
  assert.deepEqual(t.r.calls, ["open /parent.jsonl", "resume w"]);
  t.cleanup();
});

test("a worker's nudge stays through a failed resume, bounded; a running worker needs nothing", async () => {
  let resumes = 0;
  const t = rig({
    resumeWorker: async () => {
      resumes++;
      throw new Error("no such worker");
    },
  });
  t.r.workers.set("w", { parentPath: "/parent.jsonl", parentSessionId: "p", workerId: "ag_01", running: false });
  put(t.dir, [{ id: "n1", at: t.r.now }], { id: "w", path: "/worker.jsonl" });
  for (let i = 0; i < 100; i++) {
    await t.keeper.tick();
    t.r.now += 10_000;
  }
  assert.equal(resumes, 3);
  assert.equal(readWakeRecords(t.dir).length, 1, "never dropped because its worker wasn't running");

  const up = rig();
  up.r.workers.set("w", { parentPath: "/parent.jsonl", parentSessionId: "p", workerId: "ag_01", running: true });
  put(up.dir, [{ id: "n1", at: up.r.now }], { id: "w", path: "/worker.jsonl" });
  await up.keeper.tick();
  assert.deepEqual(up.r.calls, []);
  t.cleanup();
  up.cleanup();
});

test("a worker's record goes when it was stopped on purpose or its parent is archived; a parent in a terminal is left alone", async () => {
  const t = rig();
  t.r.workers.set("killed", { parentPath: "/parent.jsonl", parentSessionId: "p", workerId: "ag_01", running: false, ended: "killed" });
  t.r.workers.set("orphan", { parentPath: "/archived.jsonl", parentSessionId: "q", workerId: "ag_02", running: false });
  t.r.workers.set("tui", { parentPath: "/tui.jsonl", parentSessionId: "r", workerId: "ag_03", running: false });
  t.r.summaries.set("/archived.jsonl", { archived: true, live: false });
  t.r.summaries.set("/tui.jsonl", { archived: false, live: true });
  for (const id of ["killed", "orphan", "tui"]) put(t.dir, [{ id: "n1", at: t.r.now }], { id, path: `/${id}.jsonl` });
  await t.keeper.tick();
  assert.deepEqual(t.r.calls, []);
  assert.deepEqual(readWakeRecords(t.dir).map((r) => r.sessionId), ["tui"]);
  t.cleanup();
});

test("any source's item works the same: the keeper knows nothing of nudges", async () => {
  const t = rig();
  put(t.dir, [{ id: "job-7", at: t.r.now }], { source: "job-card" });
  t.r.onOpen = () => put(t.dir, [], { source: "job-card" });
  await t.keeper.tick();
  assert.equal(opens(t.r.calls), 1);
  assert.deepEqual(readWakeRecords(t.dir), []);
  t.cleanup();
});

test("archiving cancels for good, its workers' nudges with it, ended workers included", () => {
  const t = rig();
  put(t.dir, [{ id: "n1", at: 5 }], { id: "chat" });
  put(t.dir, [{ id: "n1", at: 5 }], { id: "w1", path: "/w1.jsonl" });
  put(t.dir, [{ id: "n1", at: 5 }], { id: "other", path: "/other.jsonl" });
  cancelChatWakes("chat", 777, t.dir, () => ["w1"]);
  assert.deepEqual(readWakeRecords(t.dir).map((r) => r.sessionId), ["other"]);
  assert.equal(wakesCancelledBefore(t.dir, "chat"), 777);
  assert.equal(wakesCancelledBefore(t.dir, "w1"), 777);
  assert.equal(wakesCancelledBefore(t.dir, "other"), 0);
  t.cleanup();
});
