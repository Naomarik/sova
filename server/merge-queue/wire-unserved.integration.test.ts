/**
 * al_1 a8 and a4/t8, through the server's own wiring (startMergeQueue): a queue record left for a repo the queue
 * doesn't serve is never loaded at start and stays byte-for-byte on disk, while a served repo's record is loaded;
 * and the merge thread is woken only for a served root (a root that stops being served wakes it no more).
 * The state root is a temp agent dir; both repos are real.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { MergeThread } from "./thread";
import { makeKit, makeRepo, until } from "./testing/queue-kit";

const DEF = { version: 1, merge: { checks: [{ id: "ok", label: "OK", run: ["true"] }] } };

const served = makeRepo({ prefix: "mq-unserved-a-" });
const stray = makeRepo({ prefix: "mq-unserved-s-", target: "main" });
const agentDir = join(served.scratch, "agent");
const base = join(agentDir, "sova", "merge-queue");
const listedRows: { root: string }[] = [{ root: served.root }];
const woke: { root: string; kind: string }[] = [];
let strayFile = "";
let strayBytes = "";

before(async () => {
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  served.commitOn(served.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "definition");
  // The stray repo declares checks too: only the Projects list keeps it out (al_1 q1 a).
  stray.commitOn(stray.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "definition");
  // Records left from before the fix: one for each repo, each holding a held (paused) entry.
  for (const r of [served, stray]) {
    const k = makeKit({ repo: r, deps: { base } });
    const q = await k.q();
    await q.pause("held for the test");
    const b = r.branch("feat/old", { "old.txt": "o\n" });
    await q.add({ branch: "feat/old", commit: b.head, by: "land-button" });
    await k.queues.stop();
  }
  const { recordedRoots } = await import("./routes");
  assert.deepEqual(new Set(recordedRoots(base)), new Set([served.root, stray.root]), "both records are on disk before the start");
  const { projectKey } = await import("./store");
  strayFile = join(base, projectKey(stray.root), "queue.json");
  strayBytes = readFileSync(strayFile, "utf8");
  // A stand-in merge thread: records each wake.
  const { setMergeThread } = await import("./thread");
  setMergeThread({ notify: (root: string, ev: { kind: string }) => void woke.push({ root, kind: ev.kind }), isThreadChat: () => false, record: () => undefined } as unknown as MergeThread);
});

after(async () => {
  const { stopMergeQueue } = await import("./wire");
  await stopMergeQueue();
  (await import("./thread")).setMergeThread(null);
  served.done();
  stray.done();
});

test("a8: at start only served repos' records are loaded; an unserved repo's record isn't loaded and stays untouched on disk", async () => {
  const { startMergeQueue, mergeQueues } = await import("./wire");
  await startMergeQueue({ listed: () => listedRows });
  const qs = mergeQueues()!;
  const roots = async () => (await qs.loaded()).map((q) => q.root);
  await until(async () => (await roots()).includes(served.root), "the served record loaded");
  // The start-up asks the rule about each recorded root, then loads it on yes: wait for the stray's answer (the same
  // cached read), then a turn for its `.then`.
  const { servedRule } = await import("./served");
  assert.equal(await (await servedRule()).served(stray.root), false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await roots(), [served.root], "the stray record isn't loaded");
  assert.equal(readFileSync(strayFile, "utf8"), strayBytes, "its record file is byte-for-byte as it was");
  const { readServed } = await import("../../pi-config/extensions/worktrees/served.ts");
  const { SERVED_FILE_NAME } = await import("./served");
  const file = readServed(join(agentDir, "sova", SERVED_FILE_NAME));
  assert.deepEqual(file?.roots.map((r) => r.root), [(await import("./served")).servedKey(served.root)], "merge-served.json names the served repo alone");
});

test("a4/t8: the merge thread is woken for a served root, and no more once that root stops being served", async () => {
  const { mergeQueues, refreshServed } = await import("./wire");
  const q = await mergeQueues()!.get(served.root);
  // Control: a served root's new entry wakes the thread.
  const a = served.branch("feat/a", { "a.txt": "a\n" });
  await q.add({ branch: "feat/a", commit: a.head, by: "land-button" });
  await until(() => woke.some((w) => w.root === served.root && w.kind === "queued"), "the thread woken for the served root");
  // Off the list: its already-loaded queue still raises events, but the thread hears none of them.
  listedRows.length = 0;
  await refreshServed();
  const before = woke.length;
  const b = served.branch("feat/b", { "b.txt": "b\n" });
  const added = await q.add({ branch: "feat/b", commit: b.head, by: "land-button" });
  assert.equal(added.changed, true, "the event was raised");
  assert.equal(woke.length, before, "no wake for a root the queue no longer serves");
  assert.equal(woke.some((w) => w.root === stray.root), false, "never a wake for the stray root");
});
