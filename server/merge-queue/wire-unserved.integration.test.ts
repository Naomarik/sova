/**
 * al_1 a8 and a4/t8, through the server's own wiring (startMergeQueue): a queue record left for a repo the queue
 * doesn't serve is never loaded at start and stays byte-for-byte on disk, while a served repo's record is loaded;
 * and the merge thread is woken only for a served root (a root that stops being served wakes it no more).
 * The state root is a temp agent dir; both repos are real.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
let strayTree = "";

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
    if (r === stray) strayTree = b.path;
    await k.queues.stop();
  }
  const { recordedRoots } = await import("./routes");
  assert.deepEqual(new Set(recordedRoots(base)), new Set([served.root, stray.root]), "both records are on disk before the start");
  const { projectKey } = await import("./store");
  strayFile = join(base, projectKey(stray.root), "queue.json");
  strayBytes = readFileSync(strayFile, "utf8");
  // A stand-in merge thread: records each wake.
  const { setMergeThread } = await import("./thread");
  setMergeThread({ notify: (root: string, ev: { kind: string }) => void woke.push({ root, kind: ev.kind }), isThreadChat: () => false, record: () => undefined, history: () => [] } as unknown as MergeThread);
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

test("a repo gaining service: an archived row of its branch gains its queue entry, with no read of that row coming", async () => {
  const { refreshServed } = await import("./wire");
  const r = await import("../merge-readiness");
  const { listSessions } = await import("../sessions-index");
  const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const dir = join((await import("../paths")).SESSIONS_DIR, "--wire-unserved--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-09-29T15-34-48-453Z_${id}.jsonl`);
  const trees = [{ path: strayTree, branch: "feat/old", base: "b0", baseBranch: "main", status: "active", session: id, how: "created", at: 1 }];
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-09-29T15:34:48.453Z", cwd: strayTree }, { type: "custom", customType: "worktrees", data: { version: 1, trees }, timestamp: "2026-09-29T15:36:00.000Z", id: "e1", parentId: null }, { type: "message", id: "e2", parentId: "e1", timestamp: "2026-09-29T15:37:00.000Z", message: { role: "user", content: "hello" } }];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  (await import("../archived-sessions")).setArchived(id, true);
  // The row as the listing has it, read: the same row at the next listing, so no listing re-reads it.
  const listed = async () => (await listSessions()).find((s) => s.path === path);
  await until(async () => {
    const s = await listed();
    await r.readinessIdle();
    return !!s && !!r.branchesOverlay(s);
  }, "the row read");
  const row = (await listed())!;
  assert.equal(row.archived, true);
  const branch = () => r.branchesOverlay(row)?.[0];
  assert.equal(branch()?.branch, "feat/old");
  assert.equal(branch()?.mergeServed, undefined, "off the list: a plain repo");
  assert.equal(r.readinessParked(row), true);
  listedRows.push({ root: stray.root });
  await refreshServed();
  await until(() => branch()?.mergeServed === true && !!branch()?.queue, "the row carries its queue entry");
  // A row read before the queue has started (a server's restart): nothing joins it, and the start reads it again.
  const { servedKey } = await import("./served");
  const { startMergeQueue, stopMergeQueue } = await import("./wire");
  await stopMergeQueue();
  await r.rereadBranches(servedKey(stray.root));
  assert.equal(branch()?.mergeServed, undefined, "the queue isn't started");
  await startMergeQueue({ listed: () => listedRows });
  await until(() => branch()?.mergeServed === true && !!branch()?.queue, "the row carries its queue entry after the start");
});
