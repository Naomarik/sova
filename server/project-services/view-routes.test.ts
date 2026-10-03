// The Services tab's view of a project's status (§app.project-services/services-ui): copies by slot with
// their checkout services, the shared services once each, HTTP readiness ports, and what runs now.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstanceSummary, ProjectDef, ServiceView } from "../../shared/project-contract";
import { parseDefinition } from "../../shared/project-contract";

const { runningOf, servicesView, withHttp } = await import("./view-routes");

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

test("an adopted slot 0 names its unit, on the tab and in Running copies; a branch copy of the same definition does not", () => {
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
