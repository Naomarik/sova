import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { MergeChatRequest, MergeRun } from "../../shared/merge-queue";
import { trulyFinal } from "./history";
import { KEEP_FINAL, type QueueFile, QueueStore } from "./store";

type Stored = QueueFile["entries"][number];

const ROOT = "/repo/project";
const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();

function entry(n: number, over: Partial<Stored> = {}): Stored {
  return {
    id: `mq_${n.toString(36).padStart(4, "0")}`,
    project: "p",
    target: "master",
    branch: `feat/b${n}`,
    commit: n.toString(16).padStart(40, "0"),
    state: "landed",
    approval: { commit: "", by: "land-button", at: at(n) },
    picks: [],
    notes: [],
    runs: [],
    createdAt: at(n),
    updatedAt: at(n),
    seq: n,
    ...over,
  } as Stored;
}

function kit() {
  const base = mkdtempSync(join(tmpdir(), "mq-history-"));
  const open = () => new QueueStore(base, ROOT);
  const store = open();
  mkdirSync(store.dir, { recursive: true });
  const q = store.read({ project: "p", target: "master" });
  /** Every history row on disk, file by file. */
  const rows = () =>
    readdirSync(store.history.dir)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) =>
        readFileSync(join(store.history.dir, n), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ file: n, row: JSON.parse(l) as { id: string; finalAt: string; entry?: Stored } })),
      );
  const queueJson = () => JSON.parse(readFileSync(join(store.dir, "queue.json"), "utf8")) as QueueFile;
  return { base, store, open, q, rows, queueJson, done: () => rmSync(base, { recursive: true, force: true }) };
}

describe("the merge queue's history (store)", () => {
  test("61 finished entries then 3 saves: exactly one history row for the oldest; it left queue.json and the in-memory list alike", () => {
    const k = kit();
    try {
      for (let n = 1; n <= KEEP_FINAL + 1; n++) k.q.entries.push(entry(n));
      const oldest = k.q.entries[0]!.id;
      for (let i = 0; i < 3; i++) k.store.write(k.q, { now: at(1000) });
      const all = k.rows();
      assert.equal(all.filter((r) => r.row.id === oldest).length, 1, "one row for the oldest");
      assert.equal(new Set(all.map((r) => r.row.id)).size, all.length, "one row per id");
      assert.equal(all.length, KEEP_FINAL + 1, "every finished entry is filed");
      assert.equal(k.q.entries.length, KEEP_FINAL, "the in-memory list holds the window");
      assert.equal(k.q.entries.some((e) => e.id === oldest), false);
      assert.deepEqual(
        k.queueJson().entries.map((e) => e.id),
        k.q.entries.map((e) => e.id),
        "queue.json and memory agree",
      );
      assert.equal(k.store.historyRow(oldest)?.entry?.id, oldest, "the history still answers for it");
      // Filed by when it became final (its landing month), not by the save.
      assert.equal(all.find((r) => r.row.id === oldest)!.file, "2026-10.jsonl");
    } finally {
      k.done();
    }
  });

  test("a final entry that changes again is rewritten in place; an unchanged save rewrites no month", () => {
    const k = kit();
    try {
      for (let n = 1; n <= 3; n++) k.q.entries.push(entry(n));
      k.store.write(k.q, { now: at(1000) });
      const file = join(k.store.history.dir, "2026-10.jsonl");
      const ino = statSync(file).ino;
      k.store.write(k.q, { now: at(1001) });
      assert.equal(statSync(file).ino, ino, "nothing changed: the month is untouched");
      k.q.entries[1]!.notes.push({ kind: "thread", text: "landed fine", at: at(1002) } as Stored["notes"][number]);
      k.store.write(k.q, { now: at(1002) });
      const all = k.rows();
      assert.equal(all.length, 3);
      assert.equal(all[1]!.row.entry!.notes.at(-1)?.text, "landed fine", "rewritten in place, same position");
      assert.equal(all[1]!.row.finalAt, at(2), "first-final time kept");
      // After a restart, an unchanged save still rewrites nothing.
      const again = k.open();
      const q2 = again.read({ project: "p", target: "master" });
      const ino2 = statSync(file).ino;
      again.write(q2, { now: at(1003) });
      assert.equal(statSync(file).ino, ino2);
    } finally {
      k.done();
    }
  });

  test("a sent-back entry still waiting on its chat is never trimmed: its later answered request survives save, restart and reread", () => {
    const k = kit();
    try {
      const request = { id: "rq_aaaaaaaaaaaa", kind: "fix", text: "fix the test", at: at(0) } as unknown as MergeChatRequest;
      const sent = entry(0, { state: "needs-fix", branch: "feat/waiting", requests: [request] });
      k.q.entries.push(sent);
      for (let n = 1; n <= KEEP_FINAL + 5; n++) k.q.entries.push(entry(n));
      k.store.write(k.q, { now: at(1000) });
      assert.ok(k.q.entries.some((e) => e.id === sent.id), "kept past the window");
      assert.equal(k.store.history.has(sent.id), false, "not final: not filed");
      // The chat answers later.
      const e = k.q.entries.find((x) => x.id === sent.id)!;
      e.requests![0]!.answer = { kind: "fixed", changed: "commit", commit: "f".repeat(40), summary: "fixed", at: at(1001) };
      e.updatedAt = at(1001);
      k.store.write(k.q, { now: at(1001) });
      const reread = k.open().read({ project: "p", target: "master" });
      const back = reread.entries.find((x) => x.id === sent.id);
      assert.equal(back?.requests?.[0]?.answer?.kind, "fixed", "the answer survived the restart");
      k.open().write(reread, { now: at(1002) });
      assert.equal(k.open().read({ project: "p", target: "master" }).entries.find((x) => x.id === sent.id)?.requests?.[0]?.answer?.kind, "fixed", "and a save after it");
    } finally {
      k.done();
    }
  });

  test("truly final: landed, cancelled, pushed; sent back or closed only once superseded or merged (and then for good)", () => {
    const old = entry(1, { state: "needs-fix", branch: "feat/x" });
    const newer = entry(2, { state: "queued", branch: "feat/x" });
    const other = entry(3, { state: "needs-fix", branch: "feat/y" });
    const list = [old, newer, other];
    for (const s of ["landed", "cancelled", "pushed"] as const) assert.equal(trulyFinal(list, entry(9, { state: s })), true, s);
    for (const s of ["queued", "checking", "with-chat", "conflict", "requested", "request-review", "needs-user"] as const) assert.equal(trulyFinal(list, entry(9, { state: s })), false, s);
    assert.equal(trulyFinal(list, old), true, "superseded");
    assert.equal(trulyFinal(list, other), false, "still waiting on its chat");
    assert.equal(trulyFinal(list, other, new Set([other.id])), true, "git says it is in the target");
    assert.equal(trulyFinal([other], entry(4, { state: "closed", branch: "feat/z" })), false, "a closed request may open again");
    assert.equal(trulyFinal([other], other, undefined, "needs-fix"), true, "filed as final: stays final when the newer entry is gone");
    assert.equal(trulyFinal([other], other, undefined, "landed"), false, "filed in another state: not sticky");
  });

  test("a superseded sent-back entry is filed and trimmed like any final one, and stays out once its newer entry is gone", () => {
    const k = kit();
    try {
      k.q.entries.push(entry(0, { state: "needs-fix", branch: "feat/x" }), entry(1, { state: "landed", branch: "feat/x" }));
      for (let n = 2; n <= KEEP_FINAL + 1; n++) k.q.entries.push(entry(n));
      k.store.write(k.q, { now: at(1000) });
      assert.equal(k.q.entries.some((e) => e.id === entry(0).id), false, "superseded and oldest: trimmed");
      assert.equal(k.store.historyRow(entry(0).id)?.state, "needs-fix");
    } finally {
      k.done();
    }
  });

  test("one id, one row: closed, opened again by Land Again, landed; a landing pushed later rewrites its row", () => {
    const k = kit();
    try {
      const e = entry(1, { state: "closed", branch: "feat/x" });
      k.q.entries.push(e);
      k.store.write(k.q, { now: at(100) });
      assert.equal(k.store.history.has(e.id), false, "closed alone may open again: not final");
      k.q.entries.push(entry(2, { state: "cancelled", branch: "feat/x" }));
      k.store.write(k.q, { now: at(101) });
      assert.equal(k.store.historyRow(e.id)?.state, "closed", "superseded while closed: filed");
      e.state = "queued";
      k.store.write(k.q, { now: at(102) });
      assert.ok(k.q.entries.includes(e), "in line again: never trimmed");
      e.state = "landed";
      e.landed = { sha: "a".repeat(40), from: "b".repeat(40), at: at(103) } as Stored["landed"];
      k.store.write(k.q, { now: at(103) });
      e.landed = { ...e.landed!, pushed: "pushed" };
      k.store.write(k.q, { now: at(104) });
      const mine = k.rows().filter((r) => r.row.id === e.id);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]!.row.entry!.state, "landed");
      assert.equal(mine[0]!.row.entry!.landed?.pushed, "pushed");
    } finally {
      k.done();
    }
  });

  test("a stop between the history write and queue.json's: the reread files no second row; a history that can't be written trims nothing", () => {
    const k = kit();
    try {
      for (let n = 1; n <= KEEP_FINAL + 1; n++) k.q.entries.push(entry(n));
      k.store.write(k.q, { now: at(1000) });
      // The history alone, as if the stop came before queue.json: it still lists everything.
      const full = structuredClone(k.q);
      full.entries = [entry(0, { state: "landed" }), ...Array.from({ length: KEEP_FINAL + 1 }, (_, i) => entry(i + 1))];
      k.store.history.sync(full.entries, KEEP_FINAL, { now: at(1001) });
      const again = k.open();
      again.write(full, { now: at(1002) });
      const ids = k.rows().map((r) => r.row.id);
      assert.equal(ids.length, new Set(ids).size, "one row per id");
      assert.equal(ids.length, KEEP_FINAL + 2);
      // history/ unwritable (a file where the folder goes): queue.json is still written, nothing leaves it.
      const k2 = kit();
      try {
        writeFileSync(join(k2.store.dir, "history"), "not a folder");
        for (let n = 1; n <= KEEP_FINAL + 3; n++) k2.q.entries.push(entry(n));
        k2.store.write(k2.q, { now: at(1000) });
        assert.equal(k2.q.entries.length, KEEP_FINAL + 3);
        assert.equal(k2.queueJson().entries.length, KEEP_FINAL + 3);
      } finally {
        k2.done();
      }
    } finally {
      k.done();
    }
  });

  test("backfill, once: partial rows for runs whose entry is gone; nothing for kept entries, trials or a second pass", () => {
    const k = kit();
    try {
      const run = (id: string, e: string, over: Partial<MergeRun> = {}): MergeRun => ({
        id,
        entry: e,
        project: "p",
        branch: "feat/gone",
        base: "b".repeat(40),
        commit: "c".repeat(40),
        steps: [{ id: "unit", kind: "check", label: "unit", result: "failed", ms: 1, log: "unit.log", failures: [{ file: "a.test.ts", name: "it", message: "boom", blame: "branch" }] } as MergeRun["steps"][number]],
        checks: [],
        verdict: "failed",
        blame: "branch",
        startedAt: at(5),
        endedAt: at(6),
        ...over,
      });
      k.store.writeRun(run("mr_0001", "mq_gone"));
      k.store.writeRun(run("mr_0002", "mq_gone", { verdict: "passed", startedAt: at(7), endedAt: at(8), steps: [] }));
      k.store.writeRun(run("mr_0003", "mq_kept"));
      k.store.writeRun(run("mr_0004", "trial"));
      k.q.entries.push(entry(1, { id: "mq_kept", state: "queued" }));
      assert.equal(k.store.backfillHistory(k.q), 1);
      const row = k.store.historyRow("mq_gone")!;
      assert.equal(row.partial, true);
      assert.deepEqual(row.runs, ["mr_0001", "mr_0002"]);
      assert.equal(row.verdict, "passed", "the newest run's verdict");
      assert.equal(row.startedAt, at(5));
      assert.equal(row.endedAt, at(8));
      assert.equal(row.target, "master");
      assert.equal(row.entry, undefined, "no tries, requests or review");
      assert.equal(k.store.historyRow("mq_kept"), null);
      // Idempotent: a marker; even a new orphan run isn't taken twice.
      k.store.writeRun(run("mr_0005", "mq_later"));
      assert.equal(k.open().backfillHistory(k.q), 0);
      assert.equal(k.rows().length, 1);
    } finally {
      k.done();
    }
  });
});
