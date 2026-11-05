/**
 * GET /api/merge-queue/landing-summary through the server's own wiring (startMergeQueue): one answer with every listed
 * project's queue cut and release cut, for the landing bar's starting picture. A real repository in a temp dir; the
 * state root is a temp agent dir; the Projects list the summary names projects by is stood in.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import type { LandingSummary } from "../../shared/merge-queue";
import type { ReleaseRecord } from "../../shared/release";
import { makeRepo, sh, until } from "./testing/queue-kit";

const DEF = { version: 1, merge: { checks: [{ id: "ok", label: "OK", run: ["true"] }] } };

const repo = makeRepo({ prefix: "mq-landing-sum-" });
const agentDir = join(repo.scratch, "agent");
const listedRows: { root: string; id?: string }[] = [{ root: repo.root, id: "prj_landsum1" }];
const app = new Hono();

before(async () => {
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  repo.commitOn(repo.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "definition");
  sh(repo.root, "push", "-q", "origin", "master");
  const { registerMergeCardRoutes } = await import("./routes");
  registerMergeCardRoutes(app);
});

after(async () => {
  const { stopMergeQueue, setLandingListForTest } = await import("./wire");
  setLandingListForTest(null);
  await stopMergeQueue();
  repo.done();
});

const summary = async (): Promise<LandingSummary> => {
  const res = await app.request("/api/merge-queue/landing-summary");
  assert.equal(res.status, 200);
  return (await res.json()) as LandingSummary;
};

test("before the queue starts: an empty answer, never an error", async () => {
  const s = await summary();
  assert.deepEqual(s.projects, []);
  assert.ok(Date.parse(s.at) > 0);
});

test("a paused queue with a branch in line, then its landing: each project's cut in one read, named from the Projects list", async () => {
  const { startMergeQueue, mergeQueues, setLandingListForTest } = await import("./wire");
  await startMergeQueue({ listed: () => listedRows });
  setLandingListForTest(() => [{ id: "prj_landsum1", root: repo.root, name: "Landing Sum" }]);
  const q = await mergeQueues()!.get(repo.root);
  await q.pause("held for the test");
  const a = repo.branch("feat/a", { "a2.txt": "a\n" });
  await q.add({ branch: "feat/a", commit: a.head, by: "land-button" });

  const s1 = await summary();
  assert.equal(s1.projects.length, 1, JSON.stringify(s1));
  const p1 = s1.projects[0]!;
  assert.equal(p1.id, "prj_landsum1");
  assert.equal(p1.name, "Landing Sum");
  assert.equal(p1.root, repo.root);
  assert.equal(p1.release, null, "no release record: null");
  const c1 = p1.queue!;
  assert.equal(c1.state, "paused");
  assert.equal(c1.paused?.why, "held for the test");
  assert.equal(c1.served, true);
  assert.deepEqual(c1.waiting.map((e) => [e.branch, e.position]), [["feat/a", 1]]);
  assert.ok(c1.waiting[0]!.eta, "an entry in line carries its estimate");
  assert.equal(c1.target, "master");
  assert.equal(c1.heads.target, repo.head("master"));
  // The cut carries none of the view's heavy parts.
  for (const k of ["ready", "settings", "needsFix", "chats", "tryRun", "thread", "waitingOnHost"]) assert.equal(k in c1, false, `no ${k} in the cut`);

  await q.resume();
  await until(async () => (await summary()).projects[0]?.queue?.recent.some((r) => r.entry.branch === "feat/a"), "landed in the summary", 120_000);
  const c2 = (await summary()).projects[0]!.queue!;
  assert.equal(c2.state, "idle");
  assert.deepEqual(c2.waiting, []);
  const landed = c2.recent.find((r) => r.entry.branch === "feat/a")!;
  assert.equal(landed.entry.landed?.sha, repo.head("master"), "the landed info rides along");
  assert.ok(landed.run?.id, "with its run's summary");
});

test("recent keeps the 5 newest landings; a project off the list is left out", async () => {
  const { mergeQueues, setLandingListForTest } = await import("./wire");
  const q = await mergeQueues()!.get(repo.root);
  for (let i = 0; i < 5; i++) {
    const b = repo.branch(`feat/r${i}`, { [`r${i}.txt`]: `${i}\n` });
    await q.add({ branch: `feat/r${i}`, commit: b.head, by: "land-button" });
  }
  await until(async () => (await summary()).projects[0]?.queue?.recent.some((r) => r.entry.branch === "feat/r4"), "all landed", 180_000);
  const recent = (await summary()).projects[0]!.queue!.recent.map((r) => r.entry.branch);
  assert.deepEqual(recent, ["feat/r4", "feat/r3", "feat/r2", "feat/r1", "feat/r0"], "the newest five, newest first");
  setLandingListForTest(() => []);
  assert.deepEqual((await summary()).projects, [], "not on the Projects list: not in the summary");
  setLandingListForTest(() => [{ id: "prj_landsum1", root: repo.root, name: "Landing Sum" }]);
});

test("an open release: its record with steps (no detail), Publish's gates and the quiet watch", async () => {
  const { projectKey } = await import("./store");
  const dir = join(agentDir, "sova", "project-services", "release", projectKey(repo.root));
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const rec = {
    id: "rl_landsum01",
    project: repo.root,
    state: "preparing",
    version: "1.4.0",
    tag: "v1.4.0",
    channels: [],
    base: repo.head("master"),
    commit: null,
    entry: null,
    thread: null,
    steps: [
      { id: "notes", label: "Write notes", phase: "prepare", state: "running", summary: "drafting", detail: "x".repeat(5000), at: now },
      { id: "checks", label: "Gating checks", phase: "sova", state: "waiting" },
      { id: "publish", label: "Publish", phase: "sova", state: "waiting" },
    ],
    notes: null,
    artifacts: [],
    startedAt: now,
    startedBy: "operator",
    lastReportAt: now,
    manifest: { version: 1, steps: [] },
    settings: { tag: "v{version}", scheme: "semver", channels: [], playbook: "release", commit: true, quietMin: 30 },
  } as unknown as ReleaseRecord;
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec));
  const p = (await summary()).projects[0]!;
  const r = p.release!;
  assert.ok(r, "the release cut is there");
  assert.equal(r.project, repo.root, "a release names its project by root, as ReleaseView does");
  assert.equal(r.open?.id, "rl_landsum01");
  assert.equal(r.last, null);
  assert.deepEqual(r.open!.steps.map((s) => [s.id, s.state, s.summary ?? null]), [["notes", "running", "drafting"], ["checks", "waiting", null], ["publish", "waiting", null]]);
  assert.equal(r.open!.steps.some((s) => "detail" in s), false, "no step detail in the cut");
  assert.ok(r.gates?.why.includes("the gating checks haven't passed yet"), JSON.stringify(r.gates));
  assert.equal(r.quiet, null, "reported just now: not quiet");
  assert.equal(r.target, "master");
  assert.equal(r.initialized, false, "the definition declares no release");
  assert.ok(p.queue, "the queue cut stands beside it");
});
