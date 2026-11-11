import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { RUN_LOG_CLEANED_LINE, RUN_LOGS_KEEP_NEWEST, sizeLabel, type RunLogsInfo } from "../../shared/merge-run-logs";
import type { MergeRun } from "../../shared/merge-queue";
import { CLEANED_MARK, cleanRunLogs, dropRunDrafts, packRun, readRunLogText, runLogsInfo, type RunLogsEntry, startRunLogSweep, sweepRunLogs, type RunLogsQueue } from "./run-logs";
import { registerRunLogsRoutes } from "./run-logs-routes";
import { stepLog } from "./run";
import { QueueStore } from "./store";

const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-07T12:00:00Z");

let seq = 0;
/** A run id ordered by `at` (the store orders runs by id). */
const runId = (at: number) => `mr_${at.toString(36)}${(seq++).toString(16).padStart(8, "0")}`;

let entrySeq = 0;
/** An entry as the sweep reads it: of feat/x unless said, created in order. */
const ent = (o: Partial<RunLogsEntry> & Pick<RunLogsEntry, "state">): RunLogsEntry => {
  const n = entrySeq++;
  return { id: `mq_${n}`, seq: n, branch: "feat/x", target: "master", createdAt: new Date(NOW - 10 * DAY + n * 1000).toISOString(), runs: [], ...o } as RunLogsEntry;
};

function kit(): { q: RunLogsQueue & { root: string; entriesList: RunLogsEntry[]; current: { id: string } | null; settledFacts: Map<string, "merged" | "gone">; refreshed: number }; store: QueueStore } {
  const base = mkdtempSync(join(tmpdir(), "mq-run-logs-"));
  temps.push(base);
  const store = new QueueStore(base, "/projects/demo");
  const q = {
    id: "demo",
    root: "/projects/demo",
    store,
    entriesList: [] as RunLogsEntry[],
    current: null as { id: string } | null,
    settledFacts: new Map<string, "merged" | "gone">(),
    refreshed: 0,
    entries() {
      return this.entriesList;
    },
    settled() {
      return this.settledFacts;
    },
    async refreshSettled() {
      this.refreshed++;
    },
    currentRun() {
      return this.current;
    },
  };
  return { q, store };
}

const LOG = Array.from({ length: 400 }, (_, i) => `line ${i} of the unit check: ok ${"x".repeat(40)}`).join("\n") + "\n";

/** A run folder as a run left it before its drafts copy was deleted: its record, step logs, a counts file, the drafts copy. */
function makeRun(store: QueueStore, o: { endedAt?: number; verdict?: MergeRun["verdict"]; startedAt: number; oldArchive?: boolean }): string {
  const id = runId(o.startedAt);
  const d = store.runDir(id);
  mkdirSync(join(d, "logs"), { recursive: true });
  writeFileSync(join(d, "logs", "01-copy.log"), "copied\n");
  writeFileSync(join(d, "logs", "02-check_unit.log"), LOG);
  writeFileSync(join(d, "logs", "02-check_unit.log.out.json"), '{"pass":12}\n');
  writeFileSync(join(d, "changed.txt"), "server/a.ts\n");
  const claims = join(d, "drafts", "t3-risks", "base", "claims", "app");
  mkdirSync(claims, { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(claims, `claim-${i}.md`), `# Claim ${i}\n\n${"The queue keeps its promise. ".repeat(80)}\n`);
  // What sweeps before drafts were deleted left: the copy packed into an archive (and a half-written one).
  if (o.oldArchive) {
    writeFileSync(join(d, "drafts.tar.gz"), "an old archive");
    writeFileSync(join(d, "drafts.tar.gz.99.tmp"), "half");
  }
  const run: MergeRun = {
    id,
    entry: "mq_x",
    project: "demo",
    branch: "feat/x",
    base: "a".repeat(40),
    commit: "b".repeat(40),
    steps: [
      { id: "copy", kind: "copy", label: "Merge copy", result: "passed", log: "logs/01-copy.log" },
      { id: "check:unit", kind: "check", label: "unit", result: "passed", log: "logs/02-check_unit.log" },
    ] as unknown as MergeRun["steps"],
    checks: [],
    verdict: o.verdict ?? "passed",
    startedAt: new Date(o.startedAt).toISOString(),
    ...(o.endedAt !== undefined ? { endedAt: new Date(o.endedAt).toISOString() } : {}),
  };
  store.writeRun(run);
  return id;
}

describe("run logs: packing a finished run", () => {
  test("a run that ended over a day ago: its step logs gzipped, its drafts copy deleted (no archive made), its record as it was; its logs read the same", async () => {
    const { q, store } = kit();
    const id = makeRun(store, { startedAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY });
    const d = store.runDir(id);
    const before = store.readLog(id, "logs/02-check_unit.log", 50);
    const record = readFileSync(join(d, "run.json"), "utf8");
    const sizeBefore = runLogsInfo(q).bytes;

    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [id]);

    assert.deepEqual(readdirSync(join(d, "logs")).sort(), ["01-copy.log.gz", "02-check_unit.log.gz", "02-check_unit.log.out.json.gz"]);
    assert.deepEqual(readdirSync(d).sort(), ["changed.txt", "logs", "run.json"], "the drafts copy is gone, and no archive of it made");
    assert.equal(readFileSync(join(d, "run.json"), "utf8"), record, "the record is untouched");
    assert.equal(readFileSync(join(d, "changed.txt"), "utf8"), "server/a.ts\n");
    assert.equal(gunzipSync(readFileSync(join(d, "logs", "02-check_unit.log.gz"))).toString(), LOG);

    // Read as before: the store's tail, the run's own reader, its line count.
    assert.deepEqual(store.readLog(id, "logs/02-check_unit.log", 50), before);
    assert.equal(stepLog(d, { log: "logs/02-check_unit.log" }, 100_000).join("\n"), LOG);
    assert.equal(readRunLogText(d, "logs/01-copy.log"), "copied\n");
    assert.ok(runLogsInfo(q).bytes < sizeBefore, "it takes less room");
    assert.equal(runLogsInfo(q).packed, 1);

    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [], "a packed run is left alone");
  });

  test("never a run in use: the one checking now, one an entry is checking, one an entry sent back to fix or queued again names, one recorded running, one without an end; one ended an hour ago, or one an entry names, loses only its drafts copy", async () => {
    const { q, store } = kit();
    const current = makeRun(store, { startedAt: NOW - 5 * DAY, endedAt: NOW - 4 * DAY });
    const checking = makeRun(store, { startedAt: NOW - 5 * DAY + 1, endedAt: NOW - 4 * DAY });
    const running = makeRun(store, { startedAt: NOW - 5 * DAY + 2, verdict: "running" });
    const noEnd = makeRun(store, { startedAt: NOW - 5 * DAY + 3 });
    const young = makeRun(store, { startedAt: NOW - 2 * 60 * 60 * 1000, endedAt: NOW - 60 * 60 * 1000 });
    const sentBack = makeRun(store, { startedAt: NOW - 5 * DAY + 5, endedAt: NOW - 4 * DAY });
    const queuedAgain = makeRun(store, { startedAt: NOW - 5 * DAY + 6, endedAt: NOW - 4 * DAY });
    const landed = makeRun(store, { startedAt: NOW - 5 * DAY + 7, endedAt: NOW - 4 * DAY });
    const old = makeRun(store, { startedAt: NOW - 5 * DAY + 4, endedAt: NOW - 4 * DAY });
    q.current = { id: current };
    q.entriesList = [
      ent({ state: "checking", branch: "feat/c", run: checking, runs: [checking] }),
      ent({ state: "needs-fix", branch: "feat/s", run: sentBack, runs: [sentBack] }),
      ent({ state: "queued", branch: "feat/q", runs: [queuedAgain] }),
      ent({ state: "landed", branch: "feat/l", run: landed, runs: [landed] }),
    ];
    assert.deepEqual((await sweepRunLogs(q, { now: NOW })).sort(), [old, landed, young, sentBack, queuedAgain].sort(), "a landed entry's run is packed");
    assert.equal(q.refreshed, 1, "the sweep reads git's settled facts afresh first");
    for (const id of [current, checking, running, noEnd]) assert.ok(existsSync(join(store.runDir(id), "drafts")), `${id} keeps its drafts copy`);
    for (const id of [current, checking, running, noEnd, young, sentBack, queuedAgain]) assert.ok(existsSync(join(store.runDir(id), "logs", "02-check_unit.log")), `${id} keeps its plain log`);
    // Ended, not checking: its drafts copy is read by nothing, whoever names the run (a stop cut short leaves one).
    for (const id of [young, sentBack, queuedAgain]) assert.equal(existsSync(join(store.runDir(id), "drafts")), false, `${id}: its drafts copy goes at once`);
  });

  test("a sent-back entry done for good no longer holds its runs: superseded by a later entry of its branch, or settled by git (merged, gone); one still waiting for its fix does", async () => {
    const { q, store } = kit();
    const at = (i: number) => makeRun(store, { startedAt: NOW - 5 * DAY + i, endedAt: NOW - 4 * DAY });
    const [first, retry, superseding, merged, gone, waiting, otherTarget] = [0, 1, 2, 3, 4, 5, 6].map(at) as string[];
    q.entriesList = [
      // Sent back twice, then approved again: the later entry stands for it (whatever its state).
      ent({ state: "needs-fix", branch: "feat/a", run: retry, runs: [first!, retry!] }),
      ent({ state: "landed", branch: "feat/a", run: superseding, runs: [superseding!] }),
      ent({ id: "mq_merged", state: "needs-fix", branch: "feat/m", run: merged, runs: [merged!] }),
      ent({ id: "mq_gone", state: "needs-fix", branch: "feat/g", run: gone, runs: [gone!] }),
      ent({ state: "needs-fix", branch: "feat/w", run: waiting, runs: [waiting!] }),
      // A later entry of the same branch for another target supersedes nothing.
      ent({ state: "needs-fix", branch: "feat/t", target: "release", run: otherTarget, runs: [otherTarget!] }),
      ent({ state: "landed", branch: "feat/t", target: "master", runs: [] }),
    ];
    q.settledFacts = new Map([
      ["mq_merged", "merged"],
      ["mq_gone", "gone"],
    ]);
    assert.deepEqual((await sweepRunLogs(q, { now: NOW })).sort(), [first, retry, superseding, merged, gone, waiting, otherTarget].sort(), "the two still waiting lose only their drafts copy");
    for (const id of [waiting!, otherTarget!]) assert.ok(existsSync(join(store.runDir(id), "logs", "02-check_unit.log")), `${id} keeps its plain log: its chat may read it`);
    for (const id of [first!, merged!]) assert.deepEqual(readdirSync(join(store.runDir(id), "logs")).sort(), ["01-copy.log.gz", "02-check_unit.log.gz", "02-check_unit.log.out.json.gz"]);
    // Clean Logs reads the same rule.
    for (let i = 0; i < RUN_LOGS_KEEP_NEWEST; i++) makeRun(store, { startedAt: NOW - DAY + i, endedAt: NOW - DAY + i + 1 });
    assert.equal(runLogsInfo(q).cleanable.runs, 5, "the five done for good, not the two still waiting");
  });

  test("drafts already on disk: a finished run's drafts copy and the archive older sweeps made go, at any age; a packed run with only its old archive is swept again", async () => {
    const { q, store } = kit();
    const packedLongAgo = makeRun(store, { startedAt: NOW - 30 * DAY, endedAt: NOW - 29 * DAY, oldArchive: true });
    const d = store.runDir(packedLongAgo);
    await packRun(d);
    writeFileSync(join(d, "drafts.tar.gz"), "an old archive");
    const young = makeRun(store, { startedAt: NOW - 60_000, endedAt: NOW - 30_000, oldArchive: true });
    assert.equal(runLogsInfo(q).packed, 0, "a folder with an old archive isn't packed yet");
    assert.deepEqual((await sweepRunLogs(q, { now: NOW })).sort(), [packedLongAgo, young].sort());
    assert.deepEqual(readdirSync(d).sort(), ["changed.txt", "logs", "run.json"]);
    assert.deepEqual(readdirSync(store.runDir(young)).sort(), ["changed.txt", "logs", "run.json"]);
    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [], "nothing left the second time");
    assert.equal(runLogsInfo(q).packed, 1, "the young run's logs are still plain");
  });

  test("dropRunDrafts: the drafts copy, the old archive and a half-written one go; nothing else; a missing folder is no error", () => {
    const { store } = kit();
    const id = makeRun(store, { startedAt: NOW - 3 * DAY, oldArchive: true });
    const d = store.runDir(id);
    writeFileSync(join(d, "docs-landed.json"), "{}\n");
    assert.equal(dropRunDrafts(d), true);
    assert.deepEqual(readdirSync(d).sort(), ["changed.txt", "docs-landed.json", "logs", "run.json"]);
    assert.equal(dropRunDrafts(d), false, "nothing left to drop");
    assert.equal(dropRunDrafts(join(d, "nope")), false);
  });

  test("a pack a stop cut short (both the log and its .gz there, a leftover temp file): the log reads, and the next sweep finishes it", async () => {
    const { q, store } = kit();
    const id = makeRun(store, { startedAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY });
    const d = store.runDir(id);
    writeFileSync(join(d, "logs", "02-check_unit.log.gz"), "not yet a whole gzip");
    writeFileSync(join(d, "logs", "01-copy.log.gz.123.tmp"), "half");
    assert.equal(readRunLogText(d, "logs/02-check_unit.log"), LOG, "the original is read first");
    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [id]);
    assert.equal(readRunLogText(d, "logs/02-check_unit.log"), LOG);
    assert.deepEqual(readdirSync(join(d, "logs")).sort(), ["01-copy.log.gz", "02-check_unit.log.gz", "02-check_unit.log.out.json.gz"]);
  });

  test("the server's sweep: runs at start and on its timer, one at a time, and stops", async () => {
    const { q, store } = kit();
    const old = makeRun(store, { startedAt: Date.now() - 3 * DAY, endedAt: Date.now() - 2 * DAY });
    const lines: string[] = [];
    const s = startRunLogSweep({ queues: async () => [q], firstAfterMs: 10_000_000, everyMs: 10_000_000, log: (l) => lines.push(l) });
    try {
      await Promise.all([s.now(), s.now()]);
      assert.equal(existsSync(join(store.runDir(old), "drafts")), false);
      assert.ok(existsSync(join(store.runDir(old), "logs", "02-check_unit.log.gz")));
      assert.deepEqual(lines, ["demo: packed the logs of 1 finished run"]);
    } finally {
      s.stop();
    }
    await s.now();
    assert.equal(lines.length, 1, "a stopped sweep does nothing");
  });
});

describe("run logs: Clean Logs", () => {
  test("takes the logs of finished runs past the newest 10, never a checking or open entry's run; each keeps its record; its steps read (log cleaned)", async () => {
    const { q, store } = kit();
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) ids.push(makeRun(store, { startedAt: NOW - 30 * DAY + i * 1000, endedAt: NOW - 20 * DAY + i * 1000 }));
    // Packed or not, it doesn't matter: pack a few first.
    await packRun(store.runDir(ids[1]!));
    const openRun = ids[2]!;
    const checkingRun = ids[3]!;
    q.entriesList = [ent({ state: "needs-fix", branch: "feat/open", run: openRun, runs: [openRun] }), ent({ state: "landed", run: ids[0]!, runs: [ids[0]!] })];
    q.current = { id: checkingRun };

    const info = runLogsInfo(q);
    assert.equal(info.runs, 15);
    assert.equal(info.cleanable.runs, 15 - RUN_LOGS_KEEP_NEWEST - 2, "5 old ones less the open entry's and the checking one");
    assert.ok(info.cleanable.bytes > 0 && info.cleanable.bytes < info.bytes);

    const r = cleanRunLogs(q);
    assert.equal(r.runs, 3);
    assert.equal(r.freed, info.cleanable.bytes);
    assert.equal(r.info.cleanable.runs, 0, "nothing left to clean");
    assert.ok(r.info.bytes <= info.bytes - r.freed + 4096 * 3, "the size drops by what went (the marks aside)");
    for (const id of [ids[0]!, ids[1]!, ids[4]!]) {
      const d = store.runDir(id);
      assert.deepEqual(readdirSync(d).sort(), ["changed.txt", CLEANED_MARK, "run.json"].sort(), `${id} keeps its record only`);
      assert.equal(store.readRun(id)?.verdict, "passed");
      assert.deepEqual(store.readLog(id, "logs/02-check_unit.log"), [RUN_LOG_CLEANED_LINE]);
    }
    for (const id of [openRun, checkingRun, ...ids.slice(5)]) assert.ok(existsSync(join(store.runDir(id), "logs")), `${id} keeps its logs`);
    assert.equal(cleanRunLogs(q).runs, 0, "a second clean finds nothing");
  });
});

describe("run logs: the routes", () => {
  function app(o: { notPage?: string | null } = {}) {
    const { q, store } = kit();
    const a = new Hono();
    registerRunLogsRoutes(a, { queues: async () => [q], isThreadChat: (root, s) => root === "/projects/demo" && s === "thread-1", notPage: () => o.notPage ?? null });
    return { a, q, store };
  }
  test("the size reads by project or by the merge thread's chat; another chat is not found", async () => {
    const { a, store } = app();
    makeRun(store, { startedAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY });
    const byProject = (await (await a.request("/api/merge-queue/run-logs?project=demo")).json()) as RunLogsInfo;
    assert.equal(byProject.project, "demo");
    assert.equal(byProject.runs, 1);
    assert.ok(byProject.bytes > 0);
    const byThread = (await (await a.request("/api/merge-queue/run-logs?session=thread-1")).json()) as RunLogsInfo;
    assert.deepEqual(byThread, byProject);
    assert.equal((await a.request("/api/merge-queue/run-logs?session=other")).status, 404);
    assert.equal((await a.request("/api/merge-queue/run-logs?project=nope")).status, 404);
    assert.equal((await a.request("/api/merge-queue/run-logs")).status, 400);
  });
  test("Clean needs the confirm and the user's own page", async () => {
    const post = (a: Hono, body: unknown) => a.request("/api/merge-queue/run-logs/clean", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const { a } = app();
    assert.equal((await post(a, { project: "demo" })).status, 409);
    assert.equal((await post(a, {})).status, 400);
    assert.equal((await post(a, { project: "nope", confirm: 1 })).status, 400, "a wrong-typed confirm is refused for itself");
    const ok = await post(a, { project: "demo", confirm: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys((await ok.json()) as object).sort(), ["freed", "info", "runs"]);
    const { a: fromChat } = app({ notPage: "A chat can't clean the merge queue's run logs." });
    const r = await post(fromChat, { project: "demo", confirm: true });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: { message: string } }).error.message, /A chat can't/);
  });
});

test("sizeLabel", () => {
  assert.equal(sizeLabel(512), "512 B");
  assert.equal(sizeLabel(18 * 1024), "18 KB");
  assert.equal(sizeLabel(1.4 * 1024 ** 3), "1.4 GB");
  assert.equal(sizeLabel(312 * 1024 ** 2), "312 MB");
});
