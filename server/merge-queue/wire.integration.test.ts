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
/** The Projects list as the served rule reads it (stood in; the second test adds to it). */
const listedRows: { root: string; id?: string }[] = [{ root: repo.root }];
const others: { done(): void }[] = [];

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
  for (const o of others) o.done();
});

test("merge.* through the project engine: a branch lands from the real run in a copy beside the project; the push waits for the names file", async () => {
  const { startMergeQueue } = await import("./wire");
  const { projectEngine } = await import("../project-services/routes");
  // The repo is on the Projects list (stood in) and declares checks: the queue serves it.
  await startMergeQueue({ listed: () => listedRows });
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

test("only a listed project with its setup done is served: a listed one with no setup gets a bare status and Set Up on its rows, an unlisted one nothing; neither gets a queue record; merge-served.json names the served one alone", async () => {
  const { projectEngine } = await import("../project-services/routes");
  const { queueManages, refreshServed, worktreeQueueOf } = await import("./wire");
  const { NOT_SERVED, servedKey } = await import("./served");
  const { projectKey } = await import("./store");
  const { readServed } = await import("../../pi-config/extensions/worktrees/served.ts");
  const op = { kind: "operator" } as const;
  const bare = makeRepo({ prefix: "mq-wire-bare-" });
  const loose = makeRepo({ prefix: "mq-wire-loose-" });
  others.push(bare, loose);
  loose.commitOn(loose.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "its own setup");
  listedRows.push({ root: bare.root, id: "prj_bare" });
  await refreshServed();

  const st = await projectEngine().run("merge.status", { project: bare.root }, op);
  assert.equal(st.ok, true, JSON.stringify(st.error));
  assert.equal(st.merge?.view?.served, false);
  const bt = bare.branch("feat/x", { "x.txt": "x\n" });
  const bareRow = await worktreeQueueOf(bt.path, "feat/x");
  assert.equal(bareRow.mergeProject?.id, "prj_bare");
  assert.equal(bareRow.mergeProject?.checks, "unset", "Set Up, never Land");
  assert.equal(bareRow.mergeServed, undefined);
  assert.equal(bareRow.queue, undefined);
  const lt = loose.branch("feat/y", { "y.txt": "y\n" });
  assert.deepEqual(await worktreeQueueOf(lt.path, "feat/y"), {}, "unlisted: a plain repo");
  const st2 = repo.branch("feat/c", { "c.txt": "c\n" });
  assert.equal((await worktreeQueueOf(st2.path, "feat/c")).mergeServed, true, "the served project's row");

  for (const [root, path] of [[bare.root, bt.path], [loose.root, lt.path]] as const) {
    const r = await projectEngine().run("merge.add", { checkout: path }, op);
    assert.equal(r.error?.message, NOT_SERVED, root);
    assert.equal(await queueManages(root, "master"), false, `a direct merge into ${root}'s master is allowed`);
    assert.equal(existsSync(join(agentDir, "sova", "merge-queue", projectKey(root))), false, `no queue record for ${root}`);
  }
  assert.equal(await queueManages(repo.root, "master"), true);
  assert.deepEqual(readServed(join(agentDir, "sova", "merge-served.json"))?.roots, [{ root: servedKey(repo.root), target: "master" }]);
});
