/**
 * The cards' copies memory (§app.projects/home-glance) against a REAL systemd user unit: a throwaway transient unit
 * started the way Sova starts a copy's service (`systemd-run --user --slice=sova-services.slice --collect`), running
 * `sleep`. systemd nests a dashed slice (`sova-services.slice` lives in `sova.slice/`), so the unit's cgroup is
 * `<manager>/sova.slice/sova-services.slice/<unit>`: the real `unitCgroupPids` must find its pid there, its cgroup
 * folder must be the one systemd itself names (ControlGroup), and `buildGlance` with the server's real readers must
 * count more than 0 bytes for it. A unit that isn't running counts 0, so the two cases are told apart.
 * Skipped with no systemd user manager (macOS, a sandbox without the user bus). The unit is stopped in cleanup.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ownMemoryOfPid, SLICE, sliceCgroupPath, unitCgroupPids, userManagerCgroup } from "../project-services/drivers";
import { until } from "../test-wait";
import { buildGlance, type GlanceDeps } from "./glance";

const manager = process.platform === "linux" ? userManagerCgroup() : null;
const systemd = !!manager && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status === 0;
const skip = systemd ? false : "no systemd user manager reachable (Linux with a user bus only)";

const tag = `glancetest${randomBytes(4).toString("hex")}`;
const unitOf = (scope: string, svc: string) => `sova-test-${tag}-${scope}-${svc}`;
const unit = `${unitOf("c1", "web")}.service`;

after(() => {
  if (systemd) spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10_000 });
});

const deps = (x: Partial<GlanceDeps>): GlanceDeps => ({
  projects: [{ id: "prj_a", root: "/w/a" }],
  sameRoot: (a, b) => a === b,
  queueOf: () => ({ state: "unserved" }),
  releaseOf: () => undefined,
  definitionOf: () => ({ adoptedUnit: null, adoptedService: null, def: null }),
  capOf: () => 4,
  instances: [{ id: "c1", project: "/w/a", slot: 1, createdBy: "operator", desired: { web: "running" }, ports: {} }],
  shared: [],
  listeningPorts: new Set(),
  unitOf,
  // The server's own wiring (gatherGlance): the unit's cgroup.procs, each pid's own memory.
  unitPids: (u) => unitCgroupPids(u, manager) ?? [],
  ownMemory: (pid) => ownMemoryOfPid(pid),
  monitorSessions: [],
  projectOfSession: () => null,
  hostTotalBytes: 16e9,
  now: new Date(),
  ...x,
});

test("a real unit in sova-services.slice: its pid found in systemd's nested cgroup, and its memory counted on the card", { skip }, async () => {
  assert.equal(buildGlance(deps({})).glances[0]!.memory.copiesBytes, 0, "before it starts: nothing to count");
  const r = spawnSync("systemd-run", ["--user", `--unit=${unit}`, `--slice=${SLICE}`, "--collect", "--quiet", "--property=StandardInput=null", "--", "sleep", "300"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, `systemd-run: ${r.stderr}`);
  await until(() => (unitCgroupPids(unit, manager) ?? []).length > 0, `${unit}'s pid in its cgroup`);

  // Where systemd says the unit's cgroup is, the derived path agrees.
  const cg = spawnSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", unit], { encoding: "utf8" }).stdout.trim();
  assert.ok(cg.endsWith(`/${sliceCgroupPath(SLICE)}/${unit}`), `ControlGroup ${cg} is under sova.slice/sova-services.slice`);
  assert.ok(existsSync(join(manager!, sliceCgroupPath(SLICE), unit, "cgroup.procs")));
  assert.ok(!existsSync(join(manager!, SLICE, unit)), "not in a flat sova-services.slice under the manager");

  const pids = unitCgroupPids(unit, manager)!;
  const main = Number(spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], { encoding: "utf8" }).stdout.trim());
  assert.ok(main > 0 && pids.includes(main), `the unit's MainPID ${main} is among ${pids.join(",")}`);

  const g = buildGlance(deps({}));
  assert.ok(g.glances[0]!.memory.copiesBytes > 0, `copiesBytes ${g.glances[0]!.memory.copiesBytes} > 0 for a running unit`);
  // Sova's own server's unit is never counted, even when a record points at it.
  assert.equal(buildGlance(deps({ ownUnits: [unit] })).glances[0]!.memory.copiesBytes, 0);

  spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10_000 });
  await until(() => (unitCgroupPids(unit, manager) ?? []).length === 0, `${unit} stopped`);
  assert.equal(buildGlance(deps({})).glances[0]!.memory.copiesBytes, 0, "stopped: 0 again");
});
