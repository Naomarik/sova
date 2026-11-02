/**
 * The server's merge queue as wired at start (wire.ts): the project engine forwards merge.* to the merger, the REAL
 * run (merge copy beside the project, the definition's checks) checks the branch, the queue lands it, the names hold
 * keeps the push back until a names file exists. A real repository in a temp dir; the state root is a temp agent dir.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { makeRepo, sh, until } from "./testing/queue-kit";

const DEF = {
  version: 1,
  services: { web: { cmd: ["true"] } },
  merge: { checks: [{ id: "has-b", label: "Has b.txt", run: ["sh", "-c", "test -f b.txt"] }] },
};

let agentDir = "";
const repo = makeRepo({ prefix: "mq-wire-" });

before(() => {
  agentDir = join(repo.scratch, "agent");
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  repo.commitOn(repo.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "definition");
  sh(repo.root, "push", "-q", "origin", "master");
});

after(async () => {
  const { stopMergeQueue } = await import("./wire");
  await stopMergeQueue();
  repo.done();
});

test("merge.* through the project engine: a branch lands from the real run in a copy beside the project; the push waits for the names file", async () => {
  const { startMergeQueue } = await import("./wire");
  const { projectEngine } = await import("../project-services/routes");
  await startMergeQueue();
  const op = { kind: "operator" } as const;
  const b = repo.branch("feat/b", { "b.txt": "b\n" });
  const added = await projectEngine().run("merge.add", { checkout: b.path }, op);
  assert.equal(added.ok, true, JSON.stringify(added.error));
  const id = added.merge!.entry!.id;
  const status = async () => (await projectEngine().run("merge.status", { project: repo.root }, op)).merge!.view!;
  await until(async () => (await status()).recent.some((r) => r.entry.id === id && r.entry.landed?.pushed !== "pending"), "landed", 120_000);
  const v = await status();
  const e = v.recent.find((r) => r.entry.id === id)!.entry;
  assert.equal(sh(repo.root, "rev-parse", "master"), e.landed!.sha, "master is the tested tip");
  assert.equal(sh(repo.root, "rev-parse", `${e.landed!.sha}^2`), b.head);
  assert.equal(e.landed!.pushWhy, "push held: private names not set up yet");
  assert.equal(v.heads.pushWhy, "push held: private names not set up yet");
  // The run's copy was beside the project, never under the state root.
  const logs = await projectEngine().run("merge.logs", { run: e.run! }, op);
  const copy = logs.merge!.run!.copy!;
  assert.equal(dirname(copy), join(dirname(repo.root), ".worktrees"));
  assert.ok(!copy.startsWith(agentDir));
  assert.ok(logs.merge!.run!.steps.some((s) => s.kind === "check" && s.result === "passed"));
  // The names file written (as the thread's interview would), a retry pushes what was held.
  const namesFile = join(agentDir, "sova", "merge-queue", (await import("./store")).projectKey(repo.root), "names.json");
  writeFileSync(namesFile, JSON.stringify({ v: 1, privateNames: ["acme-internal"] }));
  const r = await projectEngine().run("merge.retry", { project: repo.root }, op);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sh(repo.origin, "rev-parse", "master"), e.landed!.sha);
  assert.ok(existsSync(namesFile));
});
