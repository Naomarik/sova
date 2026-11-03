/**
 * Review Changes on a Merge Queue row, through the real route (GET /api/diff/summary, kind=queue) and the queue as wired
 * at start (wire.ts queueSubjectOf): a Ready branch's diff needs no chat; a branch that isn't checked out in a worktree
 * of that project's main checkout (another repository's, the checkout's own, or no worktree at all) is refused. A real
 * repository in a temp dir; the state root is a temp agent dir.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DiffSummary } from "../../shared/protocol";
import { makeRepo, sh } from "./testing/queue-kit";

const DEF = { version: 1, services: { web: { cmd: ["true"] } }, merge: { checks: [{ id: "ok", label: "OK", run: ["true"] }] } };
const repo = makeRepo({ prefix: "mq-diff-route-" });

before(() => {
  const agentDir = join(repo.scratch, "agent");
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  repo.commitOn(repo.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "definition");
});

after(async () => {
  const { stopMergeQueue } = await import("./wire");
  await stopMergeQueue();
  repo.done();
});

test("a Ready branch's Review Changes with no chat: a summary against the target; a folder outside the project is refused", async () => {
  const { startMergeQueue } = await import("./wire");
  const { projectEngine } = await import("../project-services/routes");
  const { buildApp } = await import("../app");
  // The project is on the Projects list (stood in) and declares checks: the queue serves it (al_1).
  await startMergeQueue({ listed: () => [{ root: repo.root }] });
  const { app } = buildApp({ extensionEntriesOf: async () => [] });
  const op = { kind: "operator" } as const;
  const b = repo.branch("feat/b", { "b.txt": "b\n" });
  writeFileSync(join(b.path, "loose.txt"), "not committed\n");
  // The tab's own read loads the queue; its view names the project.
  const view = (await projectEngine().run("merge.status", { project: repo.root }, op)).merge!.view!;
  const get = (q: Record<string, string>) => app.request(`/api/diff/summary?${new URLSearchParams({ kind: "queue", project: view.project, ...q })}`);

  const ok = await get({ branch: "feat/b" });
  assert.equal(ok.status, 200, await ok.clone().text());
  const s = (await ok.json()) as DiffSummary;
  assert.equal(s.base.label, "master (merge-base)");
  assert.equal(s.base.oid, sh(repo.root, "merge-base", "master", "feat/b"));
  assert.deepEqual(s.files.map((f) => [f.path, !!f.uncommitted]), [["b.txt", false], ["loose.txt", true]]);
  assert.equal(s.uncommitted, 1);

  // Another repository with a branch of the same kind: not a worktree of this project.
  const outside = join(repo.scratch, "outside");
  mkdirSync(outside);
  sh(outside, "init", "-q", "-b", "feat/out");
  writeFileSync(join(outside, "o.txt"), "o\n");
  sh(outside, "add", ".");
  sh(outside, "commit", "-q", "-m", "o");
  const refused = await get({ branch: "feat/out" });
  assert.equal(refused.status, 404);
  assert.match(((await refused.json()) as { error: string }).error, /not checked out in a worktree of that project/);
  // The main checkout's own branch, and a branch with no worktree, are refused the same way.
  assert.equal((await get({ branch: "master" })).status, 404);
  sh(repo.root, "branch", "feat/loose");
  assert.equal((await get({ branch: "feat/loose" })).status, 404);
  // An unknown project or entry: nothing read.
  assert.equal((await app.request(`/api/diff/summary?kind=queue&project=nope&branch=feat%2Fb`)).status, 404);
  assert.equal((await get({ entry: "mq_nope" })).status, 404);
  // A queued entry: its pinned commit, however the branch moves after.
  assert.equal((await projectEngine().run("merge.pause", { project: repo.root }, op)).ok, true);
  sh(b.path, "add", "loose.txt");
  sh(b.path, "commit", "-q", "-m", "loose");
  const e = (await projectEngine().run("merge.add", { checkout: b.path }, op)).merge!.entry!;
  repo.commitOn(b.path, { "later.txt": "later\n" }, "later");
  const pinned = (await (await get({ entry: e.id })).json()) as DiffSummary;
  assert.equal(pinned.head.oid, e.commit);
  assert.deepEqual(pinned.files.map((f) => f.path), ["b.txt", "loose.txt"]);
});
