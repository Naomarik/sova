// The Branches tab's view of a project's status (§app.project-services/services-ui): copies by slot with
// their checkout services, the shared services once each, HTTP readiness ports, and what runs now.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { InstanceSummary, ProjectDef, ServiceView } from "../../shared/project-contract";
import { parseDefinition } from "../../shared/project-contract";

const agentDir = mkdtempSync(join(tmpdir(), "sova-view-routes-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { copyEstimate, limitView, runningOf, servicesView, withHttp } = await import("./view-routes");
const { setMachineCopyLimit } = await import("./copy-limit");

const def: ProjectDef = parseDefinition(
  JSON.stringify({
    version: 1,
    data: { db: { kind: "dir", sensitive: true } },
    services: {
      web: { cmd: ["node", "web.js"], ports: { http: { base: 4100 } }, ready: { http: "http", path: "/health" } },
      site: { static: "public", ports: { http: { base: 4200 } } },
      cache: { cmd: ["redis-server"], ports: { tcp: { fixed: 6400 } }, scope: "shared" },
    },
  }),
);

const svc = (name: string, scope: "checkout" | "shared", state: ServiceView["state"], ports: Record<string, number>, rssBytes?: number): ServiceView => ({
  name,
  scope,
  kind: "process",
  state,
  unit: `u-${name}`,
  pid: null,
  ports,
  ...(rssBytes !== undefined ? { rssBytes } : {}),
});
const inst = (id: string, slot: number, state: InstanceSummary["state"], services: ServiceView[]): InstanceSummary =>
  ({ instance: id, slot, generation: 1, checkout: slot ? `/p/.wt/${id}` : "/p", branch: slot ? `b-${id}` : "main", state, services, createdBy: "operator" }) as InstanceSummary;

test("each HTTP-ready service carries its port and path; a static one its first port at /; a tcp one nothing", () => {
  const rows = withHttp([svc("web", "checkout", "ready", { http: 4110 }), svc("site", "checkout", "ready", { http: 4210 }), svc("cache", "shared", "ready", { tcp: 6400 })], def);
  assert.deepEqual(rows[0]!.http, { port: 4110, path: "/health" });
  assert.deepEqual(rows[1]!.http, { port: 4210, path: "/" });
  assert.equal(rows[2]!.http, undefined);
  assert.equal(withHttp([svc("web", "checkout", "ready", { http: 4110 })], null)[0]!.http, undefined);
});

test("copies come slot 0 first with checkout services only; shared services are listed once; sensitive from main", () => {
  const cache = svc("cache", "shared", "ready", { tcp: 6400 }, 5);
  const v = servicesView("prj_1", "/p", [inst("b", 2, "running", [svc("web", "checkout", "ready", { http: 4120 }), cache]), inst("a", 0, "stopped", [svc("web", "checkout", "stopped", { http: 4100 }), cache])], () => def);
  assert.deepEqual(
    v.copies.map((c) => [c.slot, c.services.map((s) => s.name)]),
    [
      [0, ["web"]],
      [2, ["web"]],
    ],
  );
  assert.deepEqual(
    v.shared.map((s) => s.name),
    ["cache"],
  );
  assert.equal(v.sensitive, true);
  assert.equal(servicesView("prj_1", "/p", [], () => null).sensitive, false);
});

test("what runs now: running and degraded copies with their memory summed, up shared services; nothing running → null", () => {
  const base = { projectId: "prj_1", name: "P", root: "/p" };
  assert.equal(runningOf(base, [inst("a", 0, "stopped", [svc("web", "checkout", "stopped", {})])]), null);
  const r = runningOf(base, [
    inst("a", 0, "stopped", [svc("web", "checkout", "stopped", {}), svc("cache", "shared", "ready", {}, 7)]),
    inst("b", 1, "degraded", [svc("web", "checkout", "ready", {}, 10), svc("api", "checkout", "failed", {}), svc("cache", "shared", "ready", {}, 7)]),
  ])!;
  assert.deepEqual(
    r.copies.map((c) => [c.instance, c.rssBytes]),
    [["b", 10]],
  );
  assert.deepEqual(r.shared, [{ name: "cache", state: "ready", rssBytes: 7, via: "a" }]);
});

const adoptDef = parseDefinition(
  JSON.stringify({
    version: 1,
    services: { server: { cmd: ["node", "s.js"], ports: { http: { base: 4810, stride: 10 } }, ready: { http: "http" }, adopt: { unit: "sova-runtime.service", ports: { http: 4800 } } } },
  }),
);

test("an adopted slot 0 names its unit, on the tab and in Running branches; a branch copy of the same definition does not", () => {
  const v = servicesView("prj_1", "/p", [inst("m", 0, "running", [svc("server", "checkout", "ready", { http: 4800 })]), inst("b", 1, "running", [svc("server", "checkout", "ready", { http: 4820 })])], () => adoptDef);
  assert.deepEqual(
    v.copies.map((c) => c.adopted ?? null),
    ["sova-runtime.service", null],
  );
  const r = runningOf({ projectId: "prj_1", name: "P", root: "/p" }, [inst("m", 0, "running", [svc("server", "checkout", "ready", {})])], () => adoptDef)!;
  assert.equal(r.copies[0]!.adopted, "sova-runtime.service");
  assert.equal(servicesView("prj_1", "/p", [inst("m", 0, "running", [])], () => def).copies[0]!.adopted, undefined);
});

test("a degraded copy whose only trouble is a service still starting is marked starting; a failed service keeps it degraded", () => {
  const base = { projectId: "prj_1", name: "P", root: "/p" };
  const starting = runningOf(base, [inst("a", 1, "degraded", [svc("web", "checkout", "ready", {}), svc("api", "checkout", "starting", {})])])!;
  assert.equal(starting.copies[0]!.starting, true);
  const failed = runningOf(base, [inst("a", 1, "degraded", [svc("web", "checkout", "failed", {}), svc("api", "checkout", "starting", {})])])!;
  assert.equal(failed.copies[0]!.starting, undefined);
});

test("the adopt stand-in as :4930 answered it: its definition's adopt names the unit on the main copy", () => {
  // tmp/fixture/adopt/.sova/project.json and the status instance the review server returned (paths shortened).
  const fixture = parseDefinition(
    JSON.stringify({
      version: 1,
      services: { server: { cmd: ["node", "server.js"], env: { PORT: "${ports.server.http}" }, ports: { http: { base: 4941, stride: 1 } }, ready: { http: "http" }, adopt: { unit: "sova-gate-4940.service", ports: { http: 4940 } } } },
      share: { allow: false },
    }),
  );
  const real = {
    instance: "adopt-d2449ea9",
    slot: 0,
    generation: 0,
    checkout: "/w/tmp/fixture/adopt",
    branch: "main",
    state: "running",
    services: [{ name: "server", scope: "checkout", kind: "process", unit: "sova-gate-4940.service", pid: 537889, ports: { http: 4940 }, state: "ready", ready: { probe: "http :4940/", ok: true, ms: 2 }, detail: "adopted unit, started 2026-10-03T13:07:11.000Z", rssBytes: 80932864 }],
    createdBy: "operator",
    links: [],
    share: { endpoints: [], refused: "This project's definition says its copies are never shared (share.allow: false)." },
  } as InstanceSummary;
  const v = servicesView("prj_hbwzdqmw", "/w/tmp/fixture/adopt", [real], () => fixture);
  assert.equal(v.copies[0]!.adopted, "sova-gate-4940.service");
  assert.equal(runningOf({ projectId: "prj_hbwzdqmw", name: "Adopt stand-in", root: "/w/tmp/fixture/adopt" }, [real], () => fixture)!.copies[0]!.adopted, "sova-gate-4940.service");
});

test("each copy carries its entry under its own definition: the open endpoint's port there and the path; none without open or the port", () => {
  const opened = parseDefinition(JSON.stringify({ version: 1, services: { web: { cmd: ["node", "web.js"], ports: { http: { base: 4100 } }, ready: { http: "http", path: "/health" } } }, open: { endpoint: "web.http", path: "/home" } }));
  const main = inst("m", 0, "running", [svc("web", "checkout", "ready", { http: 4100 })]);
  const branch = inst("b", 3, "running", [svc("web", "checkout", "ready", { http: 4130 })]);
  const old = inst("o", 1, "running", [svc("web", "checkout", "ready", { http: 4110 })]);
  // Each copy reads its own checkout's definition: a branch without `open` gets no entry, whatever main declares.
  const defs = (checkout: string) => (checkout.endsWith("/o") ? def : opened);
  const v = servicesView("prj_1", "/p", [branch, old, main], defs);
  assert.deepEqual(
    v.copies.map((c) => [c.slot, c.open ?? null]),
    [
      [0, { endpoint: "web.http", port: 4100, path: "/home" }],
      [1, null],
      [3, { endpoint: "web.http", port: 4130, path: "/home" }],
    ],
  );
  // Running branches lists no services, so its entry says whether the entry's own service is ready.
  const starting = inst("s", 4, "degraded", [svc("web", "checkout", "starting", { http: 4140 })]);
  const run = runningOf({ projectId: "prj_1", name: "p", root: "/p" }, [branch, old, main, starting], defs)!;
  assert.deepEqual(
    run.copies.map((c) => [c.slot, c.open ?? null]),
    [
      [0, { endpoint: "web.http", port: 4100, path: "/home", ready: true }],
      [1, null],
      [3, { endpoint: "web.http", port: 4130, path: "/home", ready: true }],
      [4, { endpoint: "web.http", port: 4140, path: "/home", ready: false }],
    ],
  );
  // A copy whose status lacks the endpoint's port (its record predates the port) has no entry.
  assert.equal(servicesView("prj_1", "/p", [inst("x", 2, "running", [svc("web", "checkout", "ready", {})])], () => opened).copies[0]!.open, undefined);
});

test("the copy estimate: the current definition's passing stamp, else the newest older reading, else none; the larger of A and B", () => {
  const mem = (a: [number | null, number | null], b: [number | null, number | null]) => ({
    instances: [
      { label: "A" as const, steadyBytes: a[0], peakBytes: a[1], services: [] },
      { label: "B" as const, steadyBytes: b[0], peakBytes: b[1], services: [] },
    ],
  });
  const st = (at: string, pass: boolean, memory?: ReturnType<typeof mem>) => ({ suiteVersion: 4, pass, at, report: "r", ...(memory ? { memory } : {}) });
  const stamps = {
    cur: st("2026-10-20T10:00:00Z", true, mem([2e9, 3e9], [2.5e9, 2.8e9])),
    old1: st("2026-10-01T10:00:00Z", true, mem([1e9, 1.2e9], [1e9, 1.1e9])),
    old2: st("2026-10-10T10:00:00Z", false, mem([1.5e9, null], [null, null])),
    none: st("2026-10-15T10:00:00Z", true),
  };
  assert.deepEqual(copyEstimate(stamps, "cur"), { steadyBytes: 2.5e9, peakBytes: 3e9, source: "current", at: "2026-10-20T10:00:00Z" });
  assert.deepEqual(copyEstimate({ ...stamps, cur: { ...stamps.cur, pass: false } }, "cur"), { steadyBytes: 1.5e9, peakBytes: 1.5e9, source: "older", at: "2026-10-10T10:00:00Z" }, "a failed run of the current hash is no proof: an older definition's newest reading stands in");
  assert.deepEqual(copyEstimate(stamps, "new"), { steadyBytes: 2.5e9, peakBytes: 3e9, source: "older", at: "2026-10-20T10:00:00Z" });
  const { cur: _c, ...olds } = stamps;
  assert.deepEqual(copyEstimate(olds, "new"), { steadyBytes: 1.5e9, peakBytes: 1.5e9, source: "older", at: "2026-10-10T10:00:00Z" }, "the newest with a reading, its peak at least its steady");
  assert.equal(copyEstimate({ none: stamps.none }, "none"), null);
  assert.equal(copyEstimate({}, null), null);
});

test("the tab's limit view: only running copies count, the main checkout's and conformance's never; the machine's value overrides the file's", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-view-limit-")));
  try {
    mkdirSync(join(root, ".sova"));
    writeFileSync(join(root, ".sova", "project.json"), JSON.stringify({ version: 1, slots: { cap: 2 }, services: { web: { cmd: ["x"], ports: { http: { base: 4300 } } } } }));
    const rec = (id: string, slot: number, running: boolean, createdBy = "operator") =>
      ({ id, project: root, checkout: `${root}/${id}`, branch: id, slot, generation: 1, createdBy, createdAt: "", cutWorktree: false, desired: { web: running ? "running" : "stopped" }, prints: {}, data: {}, ports: {} }) as const;
    const registry = {
      version: 1 as const,
      shared: [],
      instances: [rec("main", 0, true), rec("a", 1, true), rec("b", 2, true), rec("c", 3, true), rec("d", 4, false), rec("conf", 17, true, "conform:x")].map((r) => ({ ...r, desired: { ...r.desired } })),
    };
    const host = { totalBytes: 121e9, availableBytes: 30e9 };
    const v = limitView(root, registry, { host, stamps: {} });
    assert.deepEqual(
      { ...v },
      { value: 2, source: "file", file: 2, copies: 4, running: 3, over: "3 running, 1 over the limit: no new copy starts until two stop.", estimate: null, host },
    );
    setMachineCopyLimit(root, 12);
    const m = limitView(root, registry, { host: null, stamps: {} });
    assert.deepEqual([m.value, m.source, m.file, m.over, m.host], [12, "machine", 2, null, null]);
    setMachineCopyLimit(root, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
