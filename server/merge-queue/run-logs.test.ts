import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { RUN_LOG_CLEANED_LINE, RUN_LOGS_KEEP_NEWEST, sizeLabel, type RunLogsInfo } from "../../shared/merge-run-logs";
import type { MergeEntry, MergeRun } from "../../shared/merge-queue";
import { CLEANED_MARK, cleanRunLogs, packRun, readRunLogText, runLogsInfo, startRunLogSweep, sweepRunLogs, type RunLogsQueue } from "./run-logs";
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

function kit(): { q: RunLogsQueue & { root: string; entriesList: Pick<MergeEntry, "state" | "run" | "runs">[]; current: { id: string } | null }; store: QueueStore } {
  const base = mkdtempSync(join(tmpdir(), "mq-run-logs-"));
  temps.push(base);
  const store = new QueueStore(base, "/projects/demo");
  const q = {
    id: "demo",
    root: "/projects/demo",
    store,
    entriesList: [] as Pick<MergeEntry, "state" | "run" | "runs">[],
    current: null as { id: string } | null,
    entries() {
      return this.entriesList;
    },
    currentRun() {
      return this.current;
    },
  };
  return { q, store };
}

const LOG = Array.from({ length: 400 }, (_, i) => `line ${i} of the unit check: ok ${"x".repeat(40)}`).join("\n") + "\n";

/** A run folder as a real run leaves it: its record, step logs, a counts file, the drafts snapshot. */
function makeRun(store: QueueStore, o: { endedAt?: number; verdict?: MergeRun["verdict"]; startedAt: number; longDraftPath?: boolean }): string {
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
  if (o.longDraftPath) {
    const deep = join(d, "drafts", "t3-risks", "base", "claims", "a-rather-long-namespace-folder-name", "another-long-nested-folder-for-the-test");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "a-file-whose-name-is-long-enough-to-push-the-path-past-one-hundred-bytes.md"), "deep\n");
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

/** A minimal ustar reader: every entry's name and body (the test's own, so the format is checked independently). */
function untar(buf: Buffer): Map<string, Buffer | "dir"> {
  const out = new Map<string, Buffer | "dir">();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    assert.equal(parseInt(str(148, 8).trim(), 8), sum, "the header's checksum");
    assert.equal(str(257, 6), "ustar");
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : "") + str(0, 100);
    const size = parseInt(str(124, 12), 8);
    const type = str(156, 1);
    off += 512;
    out.set(name, type === "5" ? "dir" : buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("run logs: packing a finished run", () => {
  test("a run that ended over a day ago: its step logs gzipped, its drafts snapshot one archive, its record as it was; its logs read the same", async () => {
    const { q, store } = kit();
    const id = makeRun(store, { startedAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY, longDraftPath: true });
    const d = store.runDir(id);
    const before = store.readLog(id, "logs/02-check_unit.log", 50);
    const record = readFileSync(join(d, "run.json"), "utf8");
    const draftFile = readFileSync(join(d, "drafts", "t3-risks", "base", "claims", "app", "claim-3.md"));
    const sizeBefore = runLogsInfo(q).bytes;

    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [id]);

    assert.deepEqual(readdirSync(join(d, "logs")).sort(), ["01-copy.log.gz", "02-check_unit.log.gz", "02-check_unit.log.out.json.gz"]);
    assert.equal(existsSync(join(d, "drafts")), false, "the snapshot folder is packed");
    assert.equal(readFileSync(join(d, "run.json"), "utf8"), record, "the record is untouched");
    assert.equal(readFileSync(join(d, "changed.txt"), "utf8"), "server/a.ts\n");
    assert.equal(gunzipSync(readFileSync(join(d, "logs", "02-check_unit.log.gz"))).toString(), LOG);
    const tar = untar(gunzipSync(readFileSync(join(d, "drafts.tar.gz"))));
    assert.deepEqual(tar.get("drafts/t3-risks/base/claims/app/claim-3.md"), draftFile);
    assert.equal(tar.get("drafts/"), "dir");
    const deep = [...tar.keys()].find((k) => k.endsWith("past-one-hundred-bytes.md"));
    assert.ok(deep && deep.length > 100 && deep.startsWith("drafts/t3-risks/base/claims/a-rather-long"), `a long path keeps its whole name: ${deep}`);

    // Read as before: the store's tail, the run's own reader, its line count.
    assert.deepEqual(store.readLog(id, "logs/02-check_unit.log", 50), before);
    assert.equal(stepLog(d, { log: "logs/02-check_unit.log" }, 100_000).join("\n"), LOG);
    assert.equal(readRunLogText(d, "logs/01-copy.log"), "copied\n");
    assert.ok(runLogsInfo(q).bytes < sizeBefore, "it takes less room");
    assert.equal(runLogsInfo(q).packed, 1);

    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [], "a packed run is left alone");
  });

  test("never a run in use or too young: the one checking now, one an entry is checking, one recorded running, one without an end, one ended an hour ago", async () => {
    const { q, store } = kit();
    const current = makeRun(store, { startedAt: NOW - 5 * DAY, endedAt: NOW - 4 * DAY });
    const checking = makeRun(store, { startedAt: NOW - 5 * DAY + 1, endedAt: NOW - 4 * DAY });
    const running = makeRun(store, { startedAt: NOW - 5 * DAY + 2, verdict: "running" });
    const noEnd = makeRun(store, { startedAt: NOW - 5 * DAY + 3 });
    const young = makeRun(store, { startedAt: NOW - 2 * 60 * 60 * 1000, endedAt: NOW - 60 * 60 * 1000 });
    const old = makeRun(store, { startedAt: NOW - 5 * DAY + 4, endedAt: NOW - 4 * DAY });
    q.current = { id: current };
    q.entriesList = [{ state: "checking", run: checking, runs: [checking] }];
    assert.deepEqual(await sweepRunLogs(q, { now: NOW }), [old]);
    for (const id of [current, checking, running, noEnd, young]) {
      assert.ok(existsSync(join(store.runDir(id), "drafts")), `${id} keeps its snapshot`);
      assert.ok(existsSync(join(store.runDir(id), "logs", "02-check_unit.log")), `${id} keeps its plain log`);
    }
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
      assert.ok(existsSync(join(store.runDir(old), "drafts.tar.gz")));
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
    q.entriesList = [
      { state: "needs-fix", run: openRun, runs: [openRun] },
      { state: "landed", run: ids[0]!, runs: [ids[0]!] },
    ] as Pick<MergeEntry, "state" | "run" | "runs">[];
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
