/**
 * GET /api/projects/glance (§app.projects/home-glance) through the server's own wiring: the merge queue started for
 * real (startMergeQueue) over two registered repos, one it serves and one it doesn't (no project file, a clean branch
 * with a commit ahead). The answer's shape; Ready to merge read from the served queue's kept view; `null` for the
 * unserved one, and no queue made for it; one answer reused within 10 s; and a read that spawns nothing at all (git
 * included) and asks no queue for a view. Real git repos under a temp state root; no model is called.
 */
import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import type { ProjectGlanceList } from "../../shared/projects";
import { makeRepo, until } from "../merge-queue/testing/queue-kit";

const DEF = { version: 1, merge: { checks: [{ id: "ok", label: "OK", run: ["true"] }] } };
const served = makeRepo({ prefix: "glance-served-" });
const plain = makeRepo({ prefix: "glance-plain-" });
const agentDir = join(served.scratch, "agent");
const app = new Hono();
const ids: Record<string, string> = {};

const call = async (path: string, init?: RequestInit) => {
  const r = await app.request(path, init);
  return { status: r.status, json: (await r.json()) as unknown };
};

before(async () => {
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  served.commitOn(served.root, { ".sova/project.json": `${JSON.stringify(DEF, null, 2)}\n` }, "definition");
  // A branch ready to land in the served repo; a clean branch with a commit ahead in the plain one.
  served.branch("feat/ready", { "r.txt": "r\n" });
  plain.branch("feat/clean", { "c.txt": "c\n" });
  const { registerProjectRoutes } = await import("./routes");
  registerProjectRoutes(app);
  for (const [name, r] of [
    ["served", served],
    ["plain", plain],
  ] as const) {
    const out = await call("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: r.root, name }) });
    assert.equal(out.status, 201, JSON.stringify(out.json));
    ids[name] = (out.json as { project: { id: string } }).project.id;
  }
  const wire = await import("../merge-queue/wire");
  await wire.startMergeQueue();
  const qs = wire.mergeQueues()!;
  // The served rule's answer for each root, as the session list's rows ask it first.
  const { servedRule } = await import("../merge-queue/served");
  await until(async () => (await servedRule()).served(served.root), "the served repo served");
  assert.equal(await (await servedRule()).served(plain.root), false);
  // The view the queue keeps once it publishes (its publish hook notes it): the Merge Queue tab's.
  const q = await qs.get(served.root);
  wire.noteQueueView(await q.view({ fresh: true }));
});

after(async () => {
  const { stopMergeQueue } = await import("../merge-queue/wire");
  await stopMergeQueue();
  served.done();
  plain.done();
});

/** Every program started while `fn` runs (git included), and every queue view or queue asked for. */
async function watching<T>(fn: () => Promise<T>): Promise<{ out: T; spawned: string[]; asked: string[] }> {
  const spawned: string[] = [];
  const asked: string[] = [];
  const undo: (() => void)[] = [];
  const patch = (obj: Record<string, unknown>, key: string, note: (args: unknown[]) => void) => {
    const orig = obj[key] as (...a: unknown[]) => unknown;
    if (typeof orig !== "function") return;
    obj[key] = function (this: unknown, ...a: unknown[]) {
      note(a);
      return new.target ? Reflect.construct(orig, a, new.target) : orig.apply(this, a);
    };
    undo.push(() => (obj[key] = orig));
  };
  const proto = cp.ChildProcess.prototype as unknown as Record<string, unknown>;
  patch(proto, "spawn", (a) => spawned.push(String((a[0] as { file?: string })?.file)));
  for (const k of ["spawnSync", "execFileSync", "execSync"]) patch(cp as unknown as Record<string, unknown>, k, (a) => spawned.push(String(a[0])));
  const B = (globalThis as { Bun?: Record<string, unknown> }).Bun;
  if (B) for (const k of ["spawn", "spawnSync"]) patch(B, k, (a) => spawned.push(String(Array.isArray(a[0]) ? a[0][0] : (a[0] as { cmd?: string[] })?.cmd?.[0])));
  const { MergeQueues, ProjectQueue } = await import("../merge-queue/queue");
  patch(MergeQueues.prototype as unknown as Record<string, unknown>, "get", (a) => asked.push(`get ${a[0]}`));
  for (const k of ["view", "cachedView", "landingCut", "readyRows"]) patch(ProjectQueue.prototype as unknown as Record<string, unknown>, k, () => asked.push(k));
  try {
    return { out: await fn(), spawned, asked };
  } finally {
    for (const u of undo.reverse()) u();
  }
}

test("the glance: shape, Ready from the served queue's kept view, null for the unserved one, nothing spawned or asked, no queue made", async () => {
  const { resetGlanceForTest } = await import("./glance");
  resetGlanceForTest();
  const { out, spawned, asked } = await watching(() => call("/api/projects/glance"));
  assert.equal(out.status, 200);
  const g = out.json as ProjectGlanceList;
  assert.equal(typeof g.at, "string");
  assert.ok(g.hostTotalBytes === null || g.hostTotalBytes > 0);
  const byId = new Map(g.glances.map((x) => [x.projectId, x]));
  const s = byId.get(ids.served!)!;
  const p = byId.get(ids.plain!)!;
  assert.ok(s && p, JSON.stringify(g));
  assert.equal(s.queue?.ready, 1, "the served queue's Ready list: feat/ready");
  assert.equal(s.queue?.inLine, 0);
  assert.deepEqual([s.slots?.running, s.slots?.cap, s.slots?.usable, s.slots?.runningPlaces, s.slots?.stopped], [0, 4, 16, 0, 0], "a project file, no copies: 0 of the default 4, every slot a place");
  assert.equal(typeof s.slots?.free, "number", "this host has a list of listening ports, read through the real path");
  assert.equal(s.merge, "served");
  assert.deepEqual([p.merge, p.queue], ["unserved", null], "the queue doesn't serve the plain repo: —");
  assert.equal(p.slots, null, "no project file: no slots");
  for (const x of [s, p]) {
    assert.deepEqual(Object.keys(x.memory).sort(), ["chatsBytes", "copiesBytes"]);
    assert.equal(x.memory.copiesBytes, 0, "no copy runs");
    assert.equal(x.release, null);
  }
  assert.deepEqual(spawned, [], "the read starts no program, git included");
  assert.deepEqual(asked, [], "the read asks no queue for a view and makes none");
  const { mergeQueues } = await import("../merge-queue/wire");
  assert.ok(!(await mergeQueues()!.loaded()).some((q) => q.root === plain.root), "no queue was made for the unserved repo");
});

test("several reads within 10 s share one answer; a fresh one follows the kept view's change", async () => {
  const { resetGlanceForTest } = await import("./glance");
  resetGlanceForTest();
  const first = (await call("/api/projects/glance")).json as ProjectGlanceList;
  const second = await watching(() => call("/api/projects/glance"));
  assert.equal((second.out.json as ProjectGlanceList).at, first.at, "the same answer");
  assert.deepEqual(second.spawned, []);
  // The queue publishes a newer view (a second branch ready): the shared answer stands until it is read afresh.
  const wire = await import("../merge-queue/wire");
  const v = await (await wire.mergeQueues()!.get(served.root)).view({ fresh: true });
  wire.noteQueueView({ ...v, ready: [...(v.ready ?? []), { ...v.ready![0]!, branch: "feat/also" }], at: new Date(Date.now() + 1000).toISOString() });
  const cached = (await call("/api/projects/glance")).json as ProjectGlanceList;
  assert.equal(cached.glances.find((x) => x.projectId === ids.served)!.queue?.ready, 1);
  resetGlanceForTest();
  const fresh = (await call("/api/projects/glance")).json as ProjectGlanceList;
  assert.equal(fresh.glances.find((x) => x.projectId === ids.served)!.queue?.ready, 2);
});

test("control: the watch sees a git run (sync and async) and a queue's view read, so its empty lists above mean something", async () => {
  const wire = await import("../merge-queue/wire");
  const { realGit } = await import("../merge-queue/guard");
  const w = await watching(async () => {
    cp.execFileSync("git", ["--version"]);
    await realGit(["--version"], served.root);
    await (await wire.mergeQueues()!.get(served.root)).cachedView();
  });
  assert.ok(w.spawned.filter((x) => /git/.test(x)).length >= 2, JSON.stringify(w.spawned));
  assert.ok(w.asked.some((a) => a.startsWith("get ")) && w.asked.includes("cachedView"), JSON.stringify(w.asked));
});

test("after a restart (no view kept): a served project reads `reading`, unlike an unserved one; its view is built once, in the background, then kept; a later read runs no git", async () => {
  const wire = await import("../merge-queue/wire");
  const { resetGlanceForTest } = await import("./glance");
  wire.resetQueueViewsForTest(); // what a restart leaves: no kept view
  resetGlanceForTest();
  const first = (await call("/api/projects/glance")).json as ProjectGlanceList;
  const by = (g: ProjectGlanceList, id: string) => g.glances.find((x) => x.projectId === id)!;
  assert.deepEqual([by(first, ids.served!).merge, by(first, ids.served!).queue], ["reading", null]);
  assert.equal(by(first, ids.plain!).merge, "unserved");
  // No Merge Queue tab visit: the glance's own one read of the served view lands, and the count appears.
  const shown = await until(async () => {
    resetGlanceForTest();
    const g = by((await call("/api/projects/glance")).json as ProjectGlanceList, ids.served!);
    return g.merge === "served" ? g : null;
  }, "the served project's first view kept");
  assert.ok((shown.queue?.ready ?? 0) >= 1, JSON.stringify(shown));
  resetGlanceForTest();
  const again = await watching(() => call("/api/projects/glance"));
  assert.deepEqual(again.spawned, [], "a read once the view is kept runs no git");
  assert.deepEqual(again.asked, []);
  assert.ok(!(await wire.mergeQueues()!.loaded()).some((q) => q.root === plain.root), "still no queue for the unserved repo");
});
