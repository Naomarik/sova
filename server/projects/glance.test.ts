import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeQueueView } from "../../shared/merge-queue";
import { parseDefinition } from "../../shared/project-contract";
import type { ReleaseRecord } from "../../shared/release";
import { queueGlanceOf } from "../merge-queue/view";
import { queueGlanceNow } from "../merge-queue/wire";
import { buildGlance, releaseGlanceOf, type GlanceDeps, type GlanceInstance } from "./glance";

const inst = (x: Partial<GlanceInstance> & Pick<GlanceInstance, "id" | "slot">): GlanceInstance => ({ project: "/w/a", createdBy: "operator", desired: { web: "running" }, ports: {}, ...x });

const WEB = parseDefinition(JSON.stringify({ version: 1, services: { web: { cmd: ["x"], ports: { http: { base: 5000 } } } } }));

const deps = (x: Partial<GlanceDeps> = {}): GlanceDeps => ({
  projects: [
    { id: "prj_a", root: "/w/a" },
    { id: "prj_b", root: "/w/b" },
    { id: "prj_old", root: "/w/old", archived: { at: "2026-01-01T00:00:00.000Z" } },
  ],
  sameRoot: (a, b) => a.replace(/\/$/, "") === b.replace(/\/$/, ""),
  queueOf: () => ({ state: "unserved" }),
  releaseOf: () => undefined,
  definitionOf: (root) => (root === "/w/a" ? { adoptedUnit: null, adoptedService: null, def: WEB } : null),
  capOf: () => 4,
  instances: [],
  shared: [],
  listeningPorts: new Set(),
  unitOf: (scope, svc) => `sova-svc-abc-${scope}-${svc}`,
  unitPids: () => [],
  ownMemory: () => null,
  monitorSessions: [],
  projectOfSession: () => null,
  hostTotalBytes: 16e9,
  now: new Date("2026-11-05T12:00:00.000Z"),
  ...x,
});

test("chats' memory: the monitor's sessions (each total with its workers and tools) joined to their project; others and unknown files left out", () => {
  const of: Record<string, string> = { "/s/1.jsonl": "prj_a", "/s/2.jsonl": "prj_a", "/s/3.jsonl": "prj_b" };
  const g = buildGlance(
    deps({
      monitorSessions: [
        { sessionPath: "/s/1.jsonl", privBytes: 300 }, // its own processes 100 + a worker's 200: the monitor's total
        { sessionPath: "/s/2.jsonl", privBytes: 50 },
        { sessionPath: "/s/3.jsonl", privBytes: 7 },
        { sessionPath: "/s/loose.jsonl", privBytes: 1000 },
        { privBytes: 999 },
      ],
      projectOfSession: (p) => of[p] ?? null,
    }),
  );
  assert.deepEqual(
    g.glances.map((x) => [x.projectId, x.memory.chatsBytes]),
    [
      ["prj_a", 350],
      ["prj_b", 7],
    ],
    "an archived project has no card and no glance",
  );
});

test("slots: the figure is the copy limit's count, the places only the usable slots; the main checkout's and conformance's in neither; no project file → null", () => {
  const g = buildGlance(
    deps({
      instances: [
        inst({ id: "main", slot: 0 }),
        inst({ id: "c1", slot: 1 }),
        inst({ id: "c2", slot: 2, desired: { web: "stopped" } }),
        inst({ id: "c3", slot: 3, project: "/w/a/" }),
        inst({ id: "conf", slot: 17, createdBy: "conform:run1" }),
        inst({ id: "stale", slot: 19 }),
        inst({ id: "other", slot: 1, project: "/w/b" }),
      ],
      capOf: () => 3,
      listeningPorts: new Set([5004]),
    }),
  );
  assert.deepEqual(g.glances[0]!.slots, { running: 3, cap: 3, usable: 16, runningPlaces: 2, stopped: 1, elsewhere: 1, free: 12 }, "the stale slot 19 is at the limit's count and on no place");
  assert.equal(g.glances[1]!.slots, null, "prj_b has no project file");
});

test("slots: no list of listening ports → free unknown, the places Sova knows still counted; a file that doesn't parse likewise", () => {
  const instances = [inst({ id: "c1", slot: 1 }), inst({ id: "b1", slot: 1, project: "/w/b", desired: { web: "stopped" }, ports: { web: { http: 5002 } } })];
  assert.deepEqual(buildGlance(deps({ instances, listeningPorts: null })).glances[0]!.slots, { running: 1, cap: 4, usable: 16, runningPlaces: 1, stopped: 0, elsewhere: 1, free: null });
  const everyPlaceHeld = [...Array(16)].map((_, i) => inst({ id: `h${i + 1}`, slot: i + 1 }));
  assert.equal(buildGlance(deps({ instances: everyPlaceHeld, listeningPorts: null })).glances[0]!.slots!.free, null, "every place held is still not 0 free");
  const broken = buildGlance(deps({ instances, definitionOf: () => ({ adoptedUnit: null, adoptedService: null, def: null }) })).glances[0]!.slots!;
  assert.deepEqual([broken.usable, broken.runningPlaces, broken.elsewhere, broken.free], [16, 1, 0, null], "no ports known: not called free");
});

test("copies' memory: every running unit of the project (slot 0's adopted unit, shared services), each process once", () => {
  const units: Record<string, number[]> = {
    "shop-web.service": [10, 11],
    "sova-svc-abc-c1-web.service": [20, 11],
    "sova-svc-abc-c1-db.service": [],
    "sova-svc-abc-a-shared-123-bus.service": [30],
    "sova-svc-abc-c9-web.service": [99],
  };
  const asked: string[] = [];
  const g = buildGlance(
    deps({
      definitionOf: (root) => (root === "/w/a" ? { adoptedUnit: "shop-web.service", adoptedService: "web", def: null } : null),
      instances: [inst({ id: "main", slot: 0 }), inst({ id: "c1", slot: 1, desired: { web: "running", db: "running", cache: "stopped" } }), inst({ id: "c9", slot: 1, project: "/w/b" })],
      shared: [{ id: "a-shared-123", project: "/w/a", desired: { bus: "running" }, ports: {} }],
      unitPids: (u) => (asked.push(u), units[u] ?? []),
      ownMemory: (pid) => pid * 1000,
    }),
  );
  assert.equal(g.glances[0]!.memory.copiesBytes, (10 + 11 + 20 + 30) * 1000);
  assert.ok(!asked.includes("sova-svc-abc-c1-cache.service"), "a service wanted stopped isn't read");
  assert.ok(!asked.includes("sova-svc-abc-main-web.service"), "the adopted unit stands for slot 0's service");
});

test("copies' memory: Sova's own server is never counted, its live unit nor the unit this server runs in; other copies are", () => {
  const units: Record<string, number[]> = {
    "sova-runtime.service": [10],
    "sova-svc-abc-self-server.service": [40],
    "sova-svc-abc-c1-web.service": [20],
  };
  const asked: string[] = [];
  const g = buildGlance(
    deps({
      definitionOf: (root) => (root === "/w/a" ? { adoptedUnit: "sova-runtime.service", adoptedService: "web", def: null } : null),
      instances: [inst({ id: "main", slot: 0 }), inst({ id: "c1", slot: 1 }), inst({ id: "self", slot: 2, desired: { server: "running" } })],
      ownUnits: ["sova-runtime.service", "sova-svc-abc-self-server.service"],
      unitPids: (u) => (asked.push(u), units[u] ?? []),
      ownMemory: (pid) => pid * 1000,
    }),
  );
  assert.equal(g.glances[0]!.memory.copiesBytes, 20 * 1000, "only the other copy's unit");
  assert.ok(!asked.includes("sova-runtime.service") && !asked.includes("sova-svc-abc-self-server.service"), "Sova's own units aren't even read");
  // Without the exclusion the same records would count them: the test can tell the two apart.
  assert.equal(buildGlance(deps({ definitionOf: (root) => (root === "/w/a" ? { adoptedUnit: "sova-runtime.service", adoptedService: "web", def: null } : null), instances: [inst({ id: "main", slot: 0 }), inst({ id: "c1", slot: 1 })], unitPids: (u) => units[u] ?? [], ownMemory: (pid) => pid * 1000 })).glances[0]!.memory.copiesBytes, 30 * 1000);
});

test("ready to merge: the queue's kept cut while served; reading and unserved are told apart, neither with a cut", () => {
  const cut = { ready: 1, inLine: 0, waiting: 0, target: "main", at: "x" };
  const g = buildGlance(deps({ queueOf: (root) => (root === "/w/a" ? { state: "served", cut } : { state: "reading" }) }));
  assert.deepEqual([g.glances[0]!.merge, g.glances[0]!.queue], ["served", cut]);
  assert.deepEqual([g.glances[1]!.merge, g.glances[1]!.queue], ["reading", null]);
  assert.equal(buildGlance(deps()).glances[1]!.merge, "unserved");
  // The real reader: no view kept for a root (unserved, a clean branch never read) → null, and nothing is built.
  assert.equal(queueGlanceNow("/nowhere/never-served"), null);
});

const view = (x: Partial<MergeQueueView>): MergeQueueView =>
  ({ project: "prj_a", root: "/w/a", target: "master", served: true, checking: [], waiting: [], needsYou: [], needsFix: [], recent: [], at: "2026-11-05T12:00:00.000Z", ...x }) as unknown as MergeQueueView;

test("queueGlanceOf: the Ready list's count, what is in line, the run checking now, a release's hold; unserved → null", () => {
  assert.equal(queueGlanceOf(view({ served: false, ready: [{} as never] })), null);
  const e = (id: string, branch: string, extra = {}) => ({ id, branch, state: "queued", ...extra }) as never;
  const g = queueGlanceOf(
    view({
      ready: [{} as never, {} as never],
      waiting: [e("mq_2", "feat/b"), e("mq_3", "feat/c", { release: "rl_1" })],
      checking: [e("mq_1", "feat/a", { state: "checking", eta: { startsInMs: 0, takesMs: 240000 } })],
      current: { id: "mr_1", entry: "mq_1", branch: "feat/a", startedAt: "2026-11-05T11:58:00.000Z", steps: [{ id: "check:unit", kind: "check", label: "unit", result: "running", ms: 0, log: "x", detail: "big" }], checks: [{ id: "unit", label: "unit", source: "required" }] } as never,
      release: { id: "rl_1", version: "0.42", tag: "v0.42", state: "checking", base: "abc", since: "x" },
    }),
  )!;
  assert.deepEqual([g.ready, g.inLine, g.waiting], [2, 3, 2]);
  assert.deepEqual(g.frozen, { tag: "v0.42", version: "0.42", waiting: 1 });
  assert.equal(g.landing!.branch, "feat/a");
  assert.equal(g.landing!.takesMs, 240000);
  assert.deepEqual(g.landing!.steps, [{ id: "check:unit", kind: "check", label: "unit", result: "running" }], "a step's detail and log stay behind");
  assert.equal(g.landing!.release, undefined);
});

const rec = (state: ReleaseRecord["state"], steps: [string, ReleaseRecord["steps"][number]["phase"], ReleaseRecord["steps"][number]["state"]][]): ReleaseRecord =>
  ({ id: `rl_${state}`, state, version: "1.0", tag: "v1.0", steps: steps.map(([id, phase, s]) => ({ id, label: id, phase, state: s, summary: "long", detail: "longer" })) }) as unknown as ReleaseRecord;

test("release: the open record, else a published one with after-publish work; settled history and abandoned ones none", () => {
  assert.equal(releaseGlanceOf(undefined), null);
  const open = releaseGlanceOf({ open: rec("checking", [["checks", "check", "running"]]), last: null })!;
  assert.deepEqual(open.steps, [{ id: "checks", label: "checks", phase: "check", state: "running" }]);
  assert.equal(releaseGlanceOf({ open: null, last: rec("published", [["announce", "after", "waiting"]]) })!.state, "published");
  assert.equal(releaseGlanceOf({ open: null, last: rec("published", [["announce", "after", "done"]]) }), null);
  assert.equal(releaseGlanceOf({ open: null, last: rec("abandoned", [["x", "prepare", "waiting"]]) }), null);
});
