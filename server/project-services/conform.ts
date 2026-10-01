import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  CONTRACT_FILE,
  isVerbResult,
  ordered,
  parseDefinition,
  scratchSlots,
  type Check,
  type ConformReport,
  type ErrorCode,
  type ProjectDef,
  type VerbResult,
} from "../../shared/project-contract";
import { projectOf } from "../project-root";
import { actFor, callerTag, parseRequest, passRefusal, realGit, VerbFailure, type Caller, type ProjectEngine } from "./engine";
import { conformDir, dataRootOf, instanceLockFile, readRegistry, servicesRoot, slugOf, tryLock, type InstanceRecord } from "./store";
import { defHashOf, isApproved } from "./trust";

/**
 * Conformance (§app.project-services/conform): a fixed, versioned suite no project can change,
 * run in two scratch instances on new branches from the ref, in the two slots above the cap.
 * Every check is Sova's own observation (processes, listeners, files, registry), never the
 * project's say-so. Whatever fails, both scratch instances are torn down and the leak check runs.
 */

export const SUITE_VERSION = 1;

type Git = typeof realGit;

class Suite {
  checks: Check[] = [];
  envelopes: { label: string; result: VerbResult }[] = [];
  firstFailure: { id: string; code: ErrorCode; detail: string } | null = null;
  constructor(
    private readonly engine: ProjectEngine,
    private readonly caller: Caller,
  ) {}
  async verb(label: string, verb: string, body: Record<string, unknown>): Promise<VerbResult> {
    const r = await this.engine.run(verb, body, this.caller);
    this.envelopes.push({ label, result: r });
    return r;
  }
  check(id: string, ok: boolean, detail: string, t0: number, code?: ErrorCode): boolean {
    this.checks.push({ id, ok, detail, ms: Date.now() - t0 });
    if (!ok && !this.firstFailure) this.firstFailure = { id, code: code ?? "not-conformant", detail };
    return ok;
  }
  get failed() {
    return !!this.firstFailure;
  }
}

const describe = (r: VerbResult) => (r.error ? `${r.error.code}: ${r.error.message}` : `state ${r.state}, changed ${r.changed}`);
const pidsOf = (r: VerbResult) => Object.fromEntries(r.services.filter((s) => s.scope === "checkout").map((s) => [s.name, s.pid]));
const portsOf = (r: VerbResult) => r.services.filter((s) => s.scope === "checkout").flatMap((s) => Object.values(s.ports));
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function listDataDirs(): string[] {
  try {
    return readdirSync(join(servicesRoot(), "data"));
  } catch {
    return [];
  }
}

function containerExists(engine: string, name: string): Promise<boolean> {
  return new Promise((done) => execFile(engine, ["container", "inspect", name], { timeout: 30_000 }, (err) => done(!err)));
}

function writeStamp(project: string, defHash: string, pass: boolean, report: string): void {
  const file = join(conformDir(), "stamps.json");
  let all: Record<string, Record<string, unknown>> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; stamps?: Record<string, Record<string, unknown>> };
    if (raw.version === 1 && raw.stamps) all = raw.stamps;
  } catch {
    // none yet
  }
  all[project] = { ...(all[project] ?? {}), [defHash]: { suiteVersion: SUITE_VERSION, pass, at: new Date().toISOString(), report } };
  mkdirSync(conformDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, stamps: all }, null, 2)}\n`);
  renameSync(tmp, file);
}

export function conformer(engine: ProjectEngine, git: Git = realGit) {
  return async (body: unknown, caller: Caller): Promise<VerbResult> => {
    const base = (over: Partial<VerbResult>): VerbResult =>
      ordered({
        v: 1,
        verb: "conform",
        project: null,
        instance: null,
        slot: null,
        generation: null,
        checkout: null,
        branch: null,
        ok: false,
        changed: false,
        state: "absent",
        steps: [],
        services: [],
        data: [],
        links: [],
        defHash: null,
        approved: false,
        at: new Date().toISOString(),
        ...over,
      });
    let project: string | null = null;
    let defHash: string | null = null;
    let approved = false;
    try {
      const req = parseRequest(body);
      if (!req.project) throw new VerbFailure("invalid-request", "conform needs the project (a path inside it)");
      const p = await projectOf(req.project);
      if (p.state !== "ok") throw new VerbFailure("not-found", p.state === "none" ? `no project at ${req.project}` : p.message);
      project = p.root;
      if ((caller.kind === "project-overseer" || caller.kind === "session") && caller.root !== project) throw new VerbFailure("forbidden", "this caller conforms only its own project");
      await actFor(caller, "conform", null);
      const ref = req.ref ?? "HEAD";
      const sha = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], project);
      if (sha.code !== 0) throw new VerbFailure("not-found", `no commit ${ref} in ${project}`);
      const commit = sha.stdout.trim();
      const shown = await git(["show", `${commit}:${CONTRACT_FILE}`], project);
      if (shown.code !== 0) throw new VerbFailure("invalid-definition", `no ${CONTRACT_FILE} at ${ref}`);
      let def: ProjectDef;
      try {
        def = parseDefinition(shown.stdout);
      } catch (err) {
        throw new VerbFailure("invalid-definition", err instanceof Error ? err.message : String(err));
      }
      defHash = defHashOf(def);
      approved = isApproved(project, defHash);
      if (!approved)
        throw new VerbFailure("not-approved", `this definition (${defHash}) is not approved on this host; running it confined before approval comes with the onboarding playbook`);
      const lock = tryLock(instanceLockFile(project, "\0conform"));
      if ("heldBy" in lock) throw new VerbFailure("busy", `a conformance run is already running on this project (pid ${lock.heldBy})`);
      try {
        const report = await runSuite(engine, git, { project, ref, commit, def, defHash }, caller);
        const file = join(conformDir(), `${slugOf(project)}-${defHash.slice(7, 19)}-${Date.now()}.json`);
        mkdirSync(conformDir(), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ ...report.report, project, commit, envelopes: report.envelopes }, null, 2)}\n`);
        writeStamp(project, defHash, report.report.pass, file);
        const f = report.failure;
        return base({
          project,
          ok: report.report.pass,
          changed: true,
          conform: report.report,
          ...(f ? { error: { code: f.code, message: `check ${f.id} failed: ${f.detail}`, step: f.id } } : {}),
          defHash,
          approved,
        });
      } finally {
        lock.release();
      }
    } catch (err) {
      passRefusal(err);
      const f = err instanceof VerbFailure ? err : new VerbFailure("start-failed", err instanceof Error ? err.message : String(err));
      return base({ project, error: { code: f.code, message: f.message }, defHash, approved });
    }
  };
}

async function runSuite(
  engine: ProjectEngine,
  git: Git,
  t: { project: string; ref: string; commit: string; def: ProjectDef; defHash: string },
  caller: Caller,
): Promise<{ report: ConformReport; envelopes: { label: string; result: VerbResult }[]; failure: { id: string; code: ErrorCode; detail: string } | null }> {
  const runId = randomBytes(3).toString("hex");
  const confCaller: Caller = { kind: "conform", id: `${runId}:${callerTag(caller)}` };
  const s = new Suite(engine, confCaller);
  const { project, commit, def } = t;
  const [slotA, slotB] = scratchSlots(def);
  const branchA = `sova/conform-${runId}-a`;
  const branchB = `sova/conform-${runId}-b`;
  const hasProcess = def.services.some((x) => x.static === undefined && x.scope === "checkout");
  const token = `sova-conform-${runId}`;
  let a: VerbResult | null = null;
  let b: VerbResult | null = null;
  let recA: InstanceRecord | null = null;
  let recB: InstanceRecord | null = null;
  const containersSeen: { engine: string; name: string }[] = [];
  const recOf = (id: string | null) => (id ? (readRegistry().instances.find((i) => i.id === id) ?? null) : null);

  const before = { units: new Set(await engine.driver.units(engine.unitPrefix())), instances: new Set(readRegistry().instances.map((i) => i.id)), data: new Set(listDataDirs()) };

  const suite = async () => {
    let t0 = Date.now();
    // 1. create A, and again.
    a = await s.verb("create A", "create", { project, branch: branchA, from: commit, slot: slotA });
    recA = recOf(a.instance);
    if (!s.check("create-a", a.ok && isVerbResult(a) && !!recA && existsSync(recA.checkout) && a.data.every((d) => d.exists), describe(a), t0, a.error?.code)) return;
    t0 = Date.now();
    const a2 = await s.verb("create A again", "create", { instance: a.instance });
    if (!s.check("create-a-again", a2.ok && !a2.changed && a2.steps.every((x) => x.result === "skipped"), describe(a2), t0, a2.error?.code)) return;
    // 2. every setup step is idempotent: run once more, exit 0.
    t0 = Date.now();
    const again = await engine.rerunSetup(a.instance!);
    if (!s.check("setup-twice", again === null, again ?? `${def.setup.length} step(s) exited 0 twice`, t0, again ? "hook-failed" : undefined)) return;
    // 3. doctor.
    t0 = Date.now();
    const doc = await s.verb("doctor A", "doctor", { instance: a.instance });
    if (!s.check("doctor", doc.ok, (doc.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join("; ") || "all checks ok", t0)) return;
    // 4. up A, and again (same pids).
    t0 = Date.now();
    const upA = await s.verb("up A", "up", { instance: a.instance });
    if (!s.check("up-a", upA.ok && upA.state === "running", describe(upA), t0, upA.error?.code)) return;
    t0 = Date.now();
    const own: string[] = [];
    for (const svc of upA.services.filter((x) => x.scope === "checkout"))
      for (const [k, port] of Object.entries(svc.ports)) {
        const o = engine.portOwner(port);
        const mine = typeof o === "object" && (svc.kind === "static" ? o.pid === process.pid : !!svc.unit && engine.driver.owns(svc.unit, o.pid));
        if (!mine) own.push(`${svc.name}.${k} (${port}): ${typeof o === "object" ? `pid ${o.pid} (${o.cwd})` : o}`);
      }
    if (!s.check("ports-owned", !own.length, own.length ? `not held by A's own processes: ${own.join("; ")}` : "every declared port is held by A's own processes", t0)) return;
    t0 = Date.now();
    const upA2 = await s.verb("up A again", "up", { instance: a.instance });
    if (!s.check("up-a-again", upA2.ok && !upA2.changed && sameJson(pidsOf(upA2), pidsOf(upA)), `${describe(upA2)}; pids ${JSON.stringify(pidsOf(upA))} → ${JSON.stringify(pidsOf(upA2))}`, t0, upA2.error?.code)) return;
    t0 = Date.now();
    const stA = await s.verb("status A", "status", { instance: a.instance });
    const view = (r: VerbResult) => r.services.map((x) => [x.name, x.state, x.pid, x.ports]);
    if (!s.check("status-a", stA.ok && sameJson(view(stA), view(upA)), sameJson(view(stA), view(upA)) ? "status agrees with up" : `status ${JSON.stringify(view(stA))} vs up ${JSON.stringify(view(upA))}`, t0)) return;
    // 5. B (created by its up) in parallel with A's up again.
    t0 = Date.now();
    const [bUp, aRace] = await Promise.all([s.verb("up B", "up", { project, branch: branchB, from: commit, slot: slotB }), s.verb("up A (concurrent)", "up", { instance: a.instance })]);
    b = bUp;
    recB = recOf(b.instance);
    if (!s.check("up-b-parallel", b.ok && b.state === "running" && aRace.ok && !aRace.changed, `B: ${describe(b)}; A: ${describe(aRace)}`, t0, b.error?.code ?? aRace.error?.code)) return;
    // The lock, whatever the timing: while B's lock is held, a verb on B answers busy (exit 4) and does nothing.
    t0 = Date.now();
    const held = tryLock(instanceLockFile(project, recB!.checkout));
    let busy: VerbResult | null = null;
    if ("release" in held)
      try {
        busy = await s.verb("down B while its lock is held", "down", { instance: b.instance });
      } finally {
        held.release();
      }
    const stillUp = await s.verb("status B after the busy call", "status", { instance: b.instance });
    if (!s.check("lock-busy", busy?.error?.code === "busy" && !busy.steps.length && stillUp.state === "running", busy ? `${describe(busy)}; B then ${stillUp.state}` : "could not hold B's lock", t0)) return;
    t0 = Date.now();
    const overlap = portsOf(upA).filter((p) => portsOf(b!).includes(p));
    const refsA = upA.data.map((d) => d.ref);
    const sharedRefs = b.data.map((d) => d.ref).filter((r) => r && refsA.includes(r));
    if (!s.check("disjoint", !overlap.length && !sharedRefs.length, overlap.length || sharedRefs.length ? `shared ports ${overlap.join(",")}; shared data ${sharedRefs.join(",")}` : `ports ${portsOf(upA).join(",") || "none"} vs ${portsOf(b).join(",") || "none"}; data refs distinct`, t0)) return;
    // 6. isolation: a token written in A reads in A, not in B, not in main.
    if (def.hooks.probe) {
      t0 = Date.now();
      const w = await engine.probeHook(recA!, ["write", token]);
      const rA = await engine.probeHook(recA!, ["read", token]);
      const rB = await engine.probeHook(recB!, ["read", token]);
      const main = readRegistry().instances.find((i) => i.project === project && i.slot === 0);
      const mainUp = main ? (await engine.run("status", { instance: main.id }, confCaller)).state === "running" : false;
      const rMain = main && mainUp ? await engine.probeHook(main, ["read", token]) : null;
      const ok = w === 0 && rA === 0 && rB !== 0 && (rMain === null || rMain !== 0);
      if (!s.check("isolation", ok, `write in A ${w}, read in A ${rA}, read in B ${rB}, read in main ${rMain === null ? "skipped (main not running)" : rMain}`, t0)) return;
    } else s.check("isolation", true, "no probe hook declared: only ports and data refs were compared", Date.now());
    // 7. apply A: ready again, B untouched.
    t0 = Date.now();
    const bBefore = pidsOf(await s.verb("status B", "status", { instance: b.instance }));
    const ap = await s.verb("apply A", "apply", { instance: a.instance });
    const bAfter = pidsOf(await s.verb("status B after apply A", "status", { instance: b.instance }));
    if (!s.check("apply-a", ap.ok && ap.state === "running" && sameJson(bBefore, bAfter), `${describe(ap)}; B pids ${JSON.stringify(bBefore)} → ${JSON.stringify(bAfter)}`, t0, ap.error?.code)) return;
    // 8. logs.
    t0 = Date.now();
    const lg = await s.verb("logs A", "logs", { instance: a.instance, lines: 50 });
    if (!s.check("logs-a", lg.ok && (!hasProcess || (lg.lines?.length ?? 0) > 0) && (lg.lines?.length ?? 0) <= 50, hasProcess ? `${lg.lines?.length ?? 0} line(s)` : "no process services: nothing to log", t0)) return;
    // 9. reset A.
    if (def.data.length) {
      t0 = Date.now();
      const rs = await s.verb("reset A", "reset", { instance: a.instance });
      let gone = "no probe";
      let ok = rs.ok && rs.state === "running" && rs.changed;
      if (def.hooks.probe) {
        const r = await engine.probeHook(recOf(a.instance)!, ["read", token]);
        gone = `token read after reset: ${r}`;
        ok &&= r !== 0;
      }
      if (!s.check("reset-a", ok, `${describe(rs)}; ${gone}`, t0, rs.error?.code)) return;
    } else s.check("reset-a", true, "no data declared", Date.now());
    // 10. down A, and again; B still up.
    t0 = Date.now();
    const bPids = pidsOf(await s.verb("status B before down A", "status", { instance: b.instance }));
    const dn = await s.verb("down A", "down", { instance: a.instance });
    const leftA = (dn.services.filter((x) => x.scope === "checkout" && x.unit).flatMap((x) => engine.driver.pids(x.unit!)) as number[]).length;
    const heldA = portsOf(dn).filter((p) => engine.portOwner(p) !== "none");
    const stB = await s.verb("status B after down A", "status", { instance: b.instance });
    if (!s.check("down-a", dn.ok && dn.state === "stopped" && !leftA && !heldA.length && stB.state === "running" && sameJson(pidsOf(stB), bPids), `${describe(dn)}; ${leftA} process(es) left, ports still held ${heldA.join(",") || "none"}; B ${describe(stB)}`, t0, dn.error?.code)) return;
    t0 = Date.now();
    const dn2 = await s.verb("down A again", "down", { instance: a.instance });
    if (!s.check("down-a-again", dn2.ok && !dn2.changed, describe(dn2), t0, dn2.error?.code)) return;
  };

  try {
    await suite();
  } finally {
    // 11. teardown A and B, and again; then nothing may be left.
    let t0 = Date.now();
    const ids = [a, b].map((r) => (r as VerbResult | null)?.instance ?? null).filter((x): x is string => !!x);
    const known = { A: recA as InstanceRecord | null, B: recB as InstanceRecord | null };
    containersSeen.push(...[known.A, known.B].filter((r): r is InstanceRecord => !!r).flatMap((r) => engine.containersOf(recOf(r.id) ?? r)));
    const tds = await Promise.all(ids.map((id) => s.verb(`teardown ${id}`, "teardown", { project, instance: id })));
    const tdOk = tds.every((r) => r.ok && r.state === "absent");
    if (!s.failed || tds.length) s.check("teardown", tdOk, tds.map(describe).join("; ") || "nothing to tear down", t0, tds.find((r) => r.error)?.error?.code);
    t0 = Date.now();
    const tds2 = await Promise.all(ids.map((id) => s.verb(`teardown ${id} again`, "teardown", { project, instance: id })));
    if (tds2.length) s.check("teardown-again", tds2.every((r) => r.ok && !r.changed && r.state === "absent"), tds2.map(describe).join("; "), t0);
    // The scratch branches: deleted only while they still point at the ref (nothing was committed there).
    for (const br of [branchA, branchB]) {
      const r = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${br}`], project);
      if (r.code === 0 && r.stdout.trim() === commit) await git(["branch", "-D", br], project);
    }
  }
  // 12. leaks.
  const t0 = Date.now();
  const leaks: string[] = [];
  for (const r of [recA as InstanceRecord | null, recB as InstanceRecord | null]) {
    if (!r) continue;
    const prefix = `${engine.unitPrefix()}${r.id}-`;
    for (const u of await engine.driver.units(prefix)) leaks.push(`unit ${u}`);
    for (const svc of def.services.filter((x) => x.scope === "checkout")) for (const p of engine.driver.pids(engine.unitOf(r.id, svc.name))) leaks.push(`process ${p} in ${svc.name}`);
    for (const ports of Object.values(r.ports)) for (const p of Object.values(ports)) if (engine.portOwner(p) !== "none") leaks.push(`listener on port ${p}`);
    if (existsSync(dataRootOf(r.id))) leaks.push(`data dir ${dataRootOf(r.id)}`);
    for (const ref of Object.values(r.data)) if (ref.startsWith("/") && existsSync(ref)) leaks.push(`data ${ref}`);
    if (readRegistry().instances.some((i) => i.id === r.id)) leaks.push(`registry entry ${r.id}`);
    if (existsSync(r.checkout)) leaks.push(`worktree ${r.checkout}`);
  }
  for (const c of containersSeen) if (await containerExists(c.engine, c.name)) leaks.push(`container ${c.name}`);
  const wt = await git(["worktree", "list", "--porcelain"], project);
  for (const br of [branchA, branchB]) if (wt.stdout.includes(`branch refs/heads/${br}\n`)) leaks.push(`git worktree on ${br}`);
  const after = { units: await engine.driver.units(engine.unitPrefix()), instances: readRegistry().instances.map((i) => i.id), data: listDataDirs() };
  for (const u of after.units) if (!before.units.has(u) && !leaks.includes(`unit ${u}`)) leaks.push(`unit ${u}`);
  for (const i of after.instances) if (!before.instances.has(i) && !leaks.includes(`registry entry ${i}`)) leaks.push(`registry entry ${i}`);
  for (const d of after.data) if (!before.data.has(d) && !leaks.some((l) => l.includes(d))) leaks.push(`data dir ${d}`);
  s.check("no-leaks", !leaks.length, leaks.length ? leaks.join("; ") : "no unit, process, listener, data dir, container, registry entry or worktree left", t0);
  return {
    report: { suiteVersion: SUITE_VERSION, defHash: t.defHash, ref: `${t.ref} (${commit.slice(0, 12)})`, pass: !s.failed, checks: s.checks, leaks },
    envelopes: s.envelopes,
    failure: s.firstFailure,
  };
}
