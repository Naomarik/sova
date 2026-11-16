// Run: pnpm test -- server/sessions-index-jobs.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// The session list's `job running` marker (§app.background-jobs/pane): a summary carries
// `jobsRunning` (its own running jobs, workers' not counted) only while its chat has shut down;
// none for no job, an ended one, or another session's.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-jobs-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-jobs-index--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { getSessionSummary, listSessions } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");
const { jobsDir } = await import("./background-jobs");
const { writeJob } = await import("../pi-config/extensions/subagents/job-store.ts");
type JobRecord = import("../pi-config/extensions/subagents/job-store.ts").JobRecord;

after(() => rmSync(agentDir, { recursive: true, force: true }));

const ID_A = "01234567-89ab-7cde-8f01-234567890aaa";
const ID_B = "01234567-89ab-7cde-8f01-234567890aab";
const ID_C = "01234567-89ab-7cde-8f01-234567890aac";

function session(id: string, title: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
  const user = JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: title } });
  writeFileSync(path, `${header}\n${user}\n`);
  return canonicalPath(path);
}

const job = (sessionId: string, path: string, id: string, over: Partial<JobRecord> = {}): JobRecord =>
  ({ v: 1, id, sessionId, path, kind: "kept", command: "sleep 600 &", cwd: "/tmp", unit: `sova-job-x-${id}.scope`, driver: "systemd", startedAt: 1, bootId: "b", ...over }) as JobRecord;

test("a shut-down chat's running jobs are counted on its row; an ended job, or none, adds nothing", async () => {
  const a = session(ID_A, "Two jobs, one ended");
  const b = session(ID_B, "Its job ended");
  const c = session(ID_C, "No jobs");
  writeJob(jobsDir(), job(ID_A, a, "j1"));
  writeJob(jobsDir(), job(ID_A, a, "j2"));
  writeJob(jobsDir(), job(ID_A, a, "j3", { ended: { at: 2, how: "exited", card: "none" } }));
  writeJob(jobsDir(), job(ID_B, b, "j1", { ended: { at: 2, how: "stopped", card: "note" } }));
  const rows = new Map((await listSessions()).map((s) => [s.id, s]));
  assert.equal(rows.get(ID_A)?.jobsRunning, 2);
  assert.equal("jobsRunning" in rows.get(ID_B)!, false);
  assert.equal("jobsRunning" in rows.get(ID_C)!, false);
  // The one-row read says the same.
  assert.equal((await getSessionSummary(a))?.jobsRunning, 2);
  assert.equal((await getSessionSummary(c))?.jobsRunning, undefined);
});

// The listing reads every chat's jobs in one pass (runningJobCounts), not one folder per row, and keeps a
// chat's count while its folder hasn't moved: a job started or ended still shows on the next listing.
test("a job started or ended after a listing shows on the next one", async () => {
  const ID_D = "01234567-89ab-7cde-8f01-234567890aad";
  const d = session(ID_D, "Jobs come and go");
  const { sessionsChanged } = await import("./list-generation");
  // A new listing each time (past the 1 s reuse of the last one), every row built.
  const count = async () => {
    sessionsChanged();
    return (await listSessions()).find((s) => s.id === ID_D)?.jobsRunning;
  };
  assert.equal(await count(), undefined);
  writeJob(jobsDir(), job(ID_D, d, "j1"));
  assert.equal(await count(), 1);
  writeJob(jobsDir(), job(ID_D, d, "j2"));
  assert.equal(await count(), 2);
  writeJob(jobsDir(), job(ID_D, d, "j1", { ended: { at: 3, how: "exited", card: "none" } }));
  assert.equal(await count(), 1);
  writeJob(jobsDir(), job(ID_D, d, "j2", { ended: { at: 3, how: "stopped", card: "note" } }));
  assert.equal(await count(), undefined);
});

test("runningJobCounts: one pass over every chat's folder, read again only when the folder moved or is fresh", async () => {
  const { runningJobCounts, JOB_FOLDER_SETTLE_MS } = await import("./background-jobs");
  const { jobFile } = await import("../pi-config/extensions/subagents/job-store.ts");
  const { utimesSync } = await import("node:fs");
  const dir = join(agentDir, "counts-jobs");
  assert.deepEqual(runningJobCounts(dir), { counts: new Map(), stamp: "" }, "no folder: no jobs");
  const X = "sess/x"; // an id the folder name encodes
  writeJob(dir, job(X, "/x.jsonl", "j1"));
  writeJob(dir, job(X, "/x.jsonl", "j2", { ended: { at: 2, how: "exited", card: "none" } }));
  writeJob(dir, job("y", "/y.jsonl", "j1", { ended: { at: 2, how: "exited", card: "none" } }));
  // A whole-second mtime, so it can be put back exactly below.
  const xDir = join(dir, encodeURIComponent(X));
  const mtime = Math.floor(Date.now() / 1000) - 60;
  utimesSync(xDir, mtime, mtime);
  const settled = Date.now() + JOB_FOLDER_SETTLE_MS + 1_000;
  const first = runningJobCounts(dir, settled);
  assert.deepEqual([...first.counts], [[X, 1]]);
  assert.match(first.stamp, /^sess%2Fx:\d/m);
  assert.match(first.stamp, /^y:\d/m);
  // Rewritten in place (no rename, the folder's mtime put back): a settled folder's count is the one read.
  writeFileSync(jobFile(dir, X, "j1"), `${JSON.stringify(job(X, "/x.jsonl", "j1", { ended: { at: 4, how: "exited", card: "none" } }))}\n`);
  utimesSync(xDir, mtime, mtime);
  assert.deepEqual([...runningJobCounts(dir, settled).counts], [[X, 1]], "kept while the folder hasn't moved");
  // A folder written within the settle window is read every time.
  assert.deepEqual([...runningJobCounts(dir, mtime * 1000 + 1).counts], [], "fresh: read again");
  // Its folder moving reads it again.
  writeJob(dir, job(X, "/x.jsonl", "j3"));
  assert.deepEqual([...runningJobCounts(dir, Date.now() + JOB_FOLDER_SETTLE_MS + 5_000).counts], [[X, 1]]);
  rmSync(xDir, { recursive: true, force: true });
  assert.deepEqual([...runningJobCounts(dir, settled).counts], [], "a dropped chat's folder counts nothing");
});
