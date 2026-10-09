import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  closureOf,
  CONTRACT_FILE,
  isVerbResult,
  ordered,
  parseDefinition,
  scratchSlots,
  type Check,
  CONFORM_LOG_LINES,
  type ConformLog,
  type ConformMemory,
  type ConformReport,
  type ErrorCode,
  type ProjectDef,
  type VerbResult,
} from "../../shared/project-contract";
import { projectOf } from "../project-root";
import { actFor, callerTag, parseRequest, passRefusal, realGit, VerbFailure, type Caller, type ProjectEngine } from "./engine";
import { rssOf } from "./drivers";
import { conformDir, dataRootOf, instanceLockFile, readRegistry, servicesRoot, slugOf, tryLock, type InstanceRecord } from "./store";
import { endpointAnswers, endpointOf, shareRefusal } from "./share";
import { defHashOf } from "./def-hash";

/**
 * Conformance (§app.project-services/conform): a fixed, versioned suite no project can change,
 * run in two scratch instances on new branches from the ref, in the two slots above the cap.
 * Every check is Sova's own observation (processes, listeners, files, registry), never the
 * project's say-so. Whatever fails, both scratch instances are torn down and the leak check runs.
 */

/** 2: a declared `test` passes its smoke selection twice alike in A, on-demand services wait for it; 3: each share endpoint
    answers through the preview proxy's request path; 4: the declared entry point (`open`) answers in A (§app.project-services/conform). */
export const SUITE_VERSION = 4;

/** A GET of the entry, as a person's browser would ask it: its status and content type (null: no answer). */
export async function entryAnswers(port: number, path: string, timeoutMs = 10_000): Promise<{ status: number | null; type: string | null }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { accept: "text/html,*/*" } });
    await r.body?.cancel().catch(() => undefined);
    return { status: r.status, type: r.headers.get("content-type") };
  } catch {
    return { status: null, type: null };
  }
}

type Git = typeof realGit;
/** How often ports-owned asks again about a port nothing holds yet. */
const PORT_POLL_MS = 250;

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

/**
 * The scratch instances' resident memory while the suite runs (§app.project-services/conform): each
 * checkout process service's unit, sampled every second and at the steady points; an instance's
 * reading is the sum of its services' at one moment.
 */
class Memory {
  private peak = new Map<string, number>();
  private steady = new Map<string, number>();
  private watched: { label: "A" | "B"; id: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly engine: ProjectEngine,
    private readonly services: string[],
  ) {}
  watch(label: "A" | "B", id: string): void {
    this.watched.push({ label, id });
    this.timer ??= setInterval(() => this.sample(), 1_000);
    this.timer.unref();
  }
  /** One reading of every watched instance; with `steady`, that instance's is its steady one. */
  sample(steady?: "A" | "B"): void {
    for (const w of this.watched) {
      let sum: number | null = null;
      for (const svc of this.services) {
        const rss = rssOf(this.engine.driver.pids(this.engine.unitOf(w.id, svc)));
        if (rss === null) continue;
        sum = (sum ?? 0) + rss;
        this.max(`${w.label}\0${svc}`, rss);
        if (steady === w.label) this.steady.set(`${w.label}\0${svc}`, rss);
      }
      if (sum !== null) this.max(w.label, sum);
      if (steady === w.label && sum !== null) this.steady.set(w.label, sum);
    }
  }
  private max(k: string, v: number) {
    this.peak.set(k, Math.max(this.peak.get(k) ?? 0, v));
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  report(): ConformMemory {
    const get = (m: Map<string, number>, k: string) => m.get(k) ?? null;
    return {
      instances: this.watched.map((w) => ({
        label: w.label,
        peakBytes: get(this.peak, w.label),
        steadyBytes: get(this.steady, w.label),
        services: this.services.map((name) => ({ name, peakBytes: get(this.peak, `${w.label}\0${name}`), steadyBytes: get(this.steady, `${w.label}\0${name}`) })),
      })),
    };
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

/** A conformance stamp: per project root and definition hash, the newest run's outcome (§app.project-services/conform). */
export interface Stamp {
  suiteVersion: number;
  pass: boolean;
  at: string;
  /** The report file. */
  report: string;
  /** Its first failed check. */
  failed?: { check: string; detail: string };
  memory?: ConformMemory;
}

const stampsFile = () => join(conformDir(), "stamps.json");

/** `stamps.json`: `{version: 1, stamps}`, `{<project root>: {<defHash>: Stamp}}`: the newest run of each hash. */
type StampFile = { stamps: Record<string, Record<string, Stamp>> };

function readStamps(): StampFile {
  try {
    const raw = JSON.parse(readFileSync(stampsFile(), "utf8")) as { version?: unknown; stamps?: unknown };
    const map = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Record<string, Stamp>>) : {});
    if (raw.version === 1) return { stamps: map(raw.stamps) };
  } catch {
    // none yet
  }
  return { stamps: {} };
}

/** The newest stamp of `project`'s definition `defHash` on this host, or null. */
export function readStamp(project: string, defHash: string): Stamp | null {
  const s = readStamps().stamps[project]?.[defHash];
  return s && typeof s === "object" ? s : null;
}

function writeStamp(project: string, defHash: string, stamp: Stamp): void {
  const f = readStamps();
  f.stamps[project] = { ...(f.stamps[project] ?? {}), [defHash]: stamp };
  mkdirSync(conformDir(), { recursive: true });
  const file = stampsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...f }, null, 2)}\n`);
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
        at: new Date().toISOString(),
        ...over,
      });
    let project: string | null = null;
    let defHash: string | null = null;
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
      const lock = tryLock(instanceLockFile(project, "\0conform"));
      if ("heldBy" in lock) throw new VerbFailure("busy", `a conformance run is already running on this project (pid ${lock.heldBy})`);
      try {
        const report = await runSuite(engine, git, { project, ref, commit, def, defHash }, caller);
        const file = join(conformDir(), `${slugOf(project)}-${defHash.slice(7, 19)}-${Date.now()}.json`);
        mkdirSync(conformDir(), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ ...report.report, project, commit, envelopes: report.envelopes }, null, 2)}\n`);
        const f = report.failure;
        writeStamp(project, defHash, {
          suiteVersion: SUITE_VERSION,
          pass: report.report.pass,
          at: new Date().toISOString(),
          report: file,
          ...(f ? { failed: { check: f.id, detail: f.detail } } : {}),
          ...(report.report.memory ? { memory: report.report.memory } : {}),
        });
        return base({
          project,
          ok: report.report.pass,
          changed: true,
          conform: report.report,
          ...(f ? { error: { code: f.code, message: `check ${f.id} failed: ${f.detail}`, step: f.id } } : {}),
          defHash,
        });
      } finally {
        lock.release();
      }
    } catch (err) {
      passRefusal(err);
      const f = err instanceof VerbFailure ? err : new VerbFailure("start-failed", err instanceof Error ? err.message : String(err));
      return base({ project, error: { code: f.code, message: f.message }, defHash });
    }
  };
}

/** Remove every worktree checked out on one of `branches` (by force: they are a conformance run's own scratch), then the branches. */
export async function removeScratch(git: Git, project: string, branches: readonly string[]): Promise<void> {
  const list = await git(["worktree", "list", "--porcelain"], project);
  let path: string | null = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (path && branches.some((br) => line === `branch refs/heads/${br}`) && path !== project) {
      const r = await git(["worktree", "remove", "--force", "--force", "--", path], project);
      if (r.code !== 0 || existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
        await git(["worktree", "prune"], project);
      }
    }
  }
  for (const br of branches) if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${br}`], project)).code === 0) await git(["branch", "-D", "--", br], project);
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
  const memory = new Memory(engine, def.services.filter((x) => x.scope === "checkout" && x.cmd && !x.container).map((x) => x.name));
  const [slotA, slotB] = scratchSlots(def);
  const branchA = `sova/conform-${runId}-a`;
  const branchB = `sova/conform-${runId}-b`;
  const token = `sova-conform-${runId}`;
  let a: VerbResult | null = null;
  let b: VerbResult | null = null;
  let recA: InstanceRecord | null = null;
  let recB: InstanceRecord | null = null;
  const containersSeen: { engine: string; name: string }[] = [];
  const recOf = (id: string | null) => (id ? (readRegistry().instances.find((i) => i.id === id) ?? null) : null);

  const regBefore = readRegistry();
  const before = {
    units: new Set(await engine.driver.units(engine.unitPrefix())),
    instances: new Set(regBefore.instances.map((i) => i.id)),
    shared: regBefore.shared.map((x) => x.id),
    data: new Set(listDataDirs()),
  };

  const suite = async () => {
    let t0 = Date.now();
    // 1. create A, and again.
    a = await s.verb("create A", "create", { project, branch: branchA, from: commit, slot: slotA });
    recA = recOf(a.instance);
    if (recA) memory.watch("A", recA.id);
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
    // The services up started: an on-demand one waits for its first test.
    for (const svc of upA.services.filter((x) => x.scope === "checkout" && x.state !== "stopped")) {
      // A port nothing holds yet gets the service's ready timeout (one opened after the probed one); a foreign holder fails at once.
      const until = Date.now() + (def.services.find((x) => x.name === svc.name)?.ready?.timeout ?? 60) * 1000;
      for (const [k, port] of Object.entries(svc.ports))
        for (;;) {
          // Its own process, or its own container publishing the port (§app.project-services/up).
          const c = await engine.portClaim(recA!, def, svc.name, port);
          if (c.held && c.own) break;
          if (c.held || Date.now() > until) {
            own.push(`${svc.name}.${k} (${port}): ${c.held ? c.who : "nothing listens"}`);
            break;
          }
          await new Promise((r) => setTimeout(r, PORT_POLL_MS));
        }
    }
    if (!s.check("ports-owned", !own.length, own.length ? `not held by A's own processes: ${own.join("; ")}` : "every declared port of what up started is held by A's own processes", t0)) return;
    const onDemand = def.services.filter((x) => x.scope === "checkout" && x.start === "on-demand").map((x) => x.name);
    if (onDemand.length) {
      t0 = Date.now();
      const woke = upA.services.filter((x) => onDemand.includes(x.name) && x.state !== "stopped");
      if (!s.check("on-demand-idle", !woke.length, woke.length ? `up started on-demand ${woke.map((x) => `${x.name} (${x.state})`).join(", ")}` : `up left ${onDemand.join(", ")} stopped`, t0)) return;
    }
    t0 = Date.now();
    const upA2 = await s.verb("up A again", "up", { instance: a.instance });
    if (!s.check("up-a-again", upA2.ok && !upA2.changed && sameJson(pidsOf(upA2), pidsOf(upA)), `${describe(upA2)}; pids ${JSON.stringify(pidsOf(upA))} → ${JSON.stringify(pidsOf(upA2))}`, t0, upA2.error?.code)) return;
    t0 = Date.now();
    const stA = await s.verb("status A", "status", { instance: a.instance });
    const view = (r: VerbResult) => r.services.map((x) => [x.name, x.state, x.pid, x.ports]);
    if (!s.check("status-a", stA.ok && sameJson(view(stA), view(upA)), sameJson(view(stA), view(upA)) ? "status agrees with up" : `status ${JSON.stringify(view(stA))} vs up ${JSON.stringify(view(upA))}`, t0)) return;
    memory.sample("A");
    // 5. B (created by its up) in parallel with A's up again.
    t0 = Date.now();
    const [bUp, aRace] = await Promise.all([s.verb("up B", "up", { project, branch: branchB, from: commit, slot: slotB }), s.verb("up A (concurrent)", "up", { instance: a.instance })]);
    b = bUp;
    recB = recOf(b.instance);
    if (recB) memory.watch("B", recB.id);
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
    memory.sample("B");
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
      const mainSaid = rMain === null ? "skipped (main not running)" : rMain;
      if (!s.check("isolation", ok, `write in A ${w}, read in A ${rA}, read in B ${rB}, read in main ${mainSaid}`, t0)) return;
    } else s.check("isolation", true, "no probe hook declared: only ports and data refs were compared", Date.now());
    // 7. apply A: ready again, B untouched.
    t0 = Date.now();
    const bBefore = pidsOf(await s.verb("status B", "status", { instance: b.instance }));
    const ap = await s.verb("apply A", "apply", { instance: a.instance });
    const bAfter = pidsOf(await s.verb("status B after apply A", "status", { instance: b.instance }));
    if (!s.check("apply-a", ap.ok && ap.state === "running" && sameJson(bBefore, bAfter), `${describe(ap)}; B pids ${JSON.stringify(bBefore)} → ${JSON.stringify(bAfter)}`, t0, ap.error?.code)) return;
    // 8. logs.
    t0 = Date.now();
    // Lines are owed only by what runs: a static service logs nothing, an on-demand one not started yet has nothing to log.
    const logging = ap.services.filter((x) => x.scope === "checkout" && x.kind !== "static" && x.state !== "stopped").map((x) => x.name);
    const lg = await s.verb("logs A", "logs", { instance: a.instance, lines: 50 });
    const n = lg.lines?.length ?? 0;
    if (!s.check("logs-a", lg.ok && (!logging.length || n > 0) && n <= 50, logging.length ? `${n} line(s) from ${logging.join(", ")}` : `${n} line(s); nothing started that logs`, t0)) return;
    // 8b. share endpoints (suite 3): each answers as a visitor's request would reach it, no link minted.
    t0 = Date.now();
    const never = def.share ? shareRefusal(def) : null;
    if (!def.share?.endpoints.length || never) s.check("share-endpoints", true, never ?? "no share endpoints declared", t0);
    else {
      const said: string[] = [];
      let ok = true;
      for (const ep of def.share.endpoints) {
        const at = endpointOf(def, recOf(a.instance)!, ep);
        const svc = at ? ap.services.find((x) => x.name === at.service.name) : undefined;
        if (!at || svc?.state !== "ready") {
          ok = false;
          said.push(`${ep}: its service is not ready after up (${svc?.state ?? "absent"})`);
          continue;
        }
        const r = await endpointAnswers(at.port);
        ok &&= r.ok;
        said.push(`${ep} (port ${at.port}): ${r.detail}${r.ok ? "" : ", not below 500"}`);
      }
      if (!s.check("share-endpoints", ok, said.join("; "), t0)) return;
    }
    // 8c. the entry point (suite 4): it answers in A below 500; the detail names its content type, a page's or an API's.
    t0 = Date.now();
    if (!def.open) s.check("open", true, "no entry point declared", t0);
    else {
      const { endpoint, path } = def.open;
      const at = endpointOf(def, recOf(a.instance)!, endpoint);
      const svc = at ? ap.services.find((x) => x.name === at.service.name) : undefined;
      if (!at || svc?.state !== "ready") {
        if (!s.check("open", false, `${endpoint}: its service is not ready after up (${svc?.state ?? "absent"})`, t0)) return;
      } else {
        const r = await entryAnswers(at.port, path);
        const ok = r.status !== null && r.status < 500;
        const said = r.status === null ? "no answer" : `answered ${r.status} (${r.type ?? "no content type"})`;
        if (!s.check("open", ok, `${endpoint} (port ${at.port}): GET ${path} ${said}${ok ? "" : ", not below 500"}`, t0)) return;
      }
    }
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
    // 9b. test (suite 2): the smoke selection passes in A, twice, with the same counts; B untouched.
    if (def.test) {
      t0 = Date.now();
      const bPidsT = pidsOf(await s.verb("status B before test A", "status", { instance: b.instance }));
      const t1 = await s.verb("test A (smoke)", "test", { instance: a.instance, select: def.test.smoke });
      const needs = closureOf(def, def.test.requires).filter((x) => x.scope === "checkout").map((x) => x.name);
      const notReady = t1.services.filter((x) => needs.includes(x.name) && x.state !== "ready").map((x) => `${x.name} ${x.state}`);
      const bAfterT = pidsOf(await s.verb("status B after test A", "status", { instance: b.instance }));
      const counts = (r: VerbResult) => (r.tests ? [r.tests.passed, r.tests.failed, r.tests.errors, r.tests.skipped] : null);
      const said = (r: VerbResult) => (r.tests ? `pass ${r.tests.pass}, counts ${JSON.stringify(counts(r))}, exit ${r.tests.exit}, ${r.tests.ms} ms` : describe(r));
      if (!s.check("test-a", t1.ok && !!t1.tests?.pass && !notReady.length && sameJson(bPidsT, bAfterT), `${t1.error ? `${describe(t1)}; ` : ""}${said(t1)}; requires ${notReady.length ? `not ready: ${notReady.join(", ")}` : `ready (${needs.join(", ") || "none"})`}; B pids ${JSON.stringify(bPidsT)} → ${JSON.stringify(bAfterT)}`, t0, t1.error?.code)) return;
      t0 = Date.now();
      const t2 = await s.verb("test A (smoke) again", "test", { instance: a.instance, select: def.test.smoke });
      if (!s.check("test-a-again", t2.ok && !!t2.tests?.pass && sameJson(counts(t2), counts(t1)), `${said(t1)} → ${said(t2)}`, t0, t2.error?.code)) return;
    } else {
      t0 = Date.now();
      const tu = await s.verb("test A (none declared)", "test", { instance: a.instance });
      if (!s.check("test-unsupported", tu.error?.code === "unsupported" && !tu.steps.length, describe(tu), t0)) return;
    }
    // 10. down A, and again; B still up (on-demand services stop with the rest).
    t0 = Date.now();
    const bPids = pidsOf(await s.verb("status B before down A", "status", { instance: b.instance }));
    const dn = await s.verb("down A", "down", { instance: a.instance });
    const leftA = (dn.services.filter((x) => x.scope === "checkout" && x.unit).flatMap((x) => engine.driver.pids(x.unit!)) as number[]).length;
    const heldA = portsOf(dn).filter((p) => engine.portHeld(p));
    const stB = await s.verb("status B after down A", "status", { instance: b.instance });
    if (!s.check("down-a", dn.ok && dn.state === "stopped" && !leftA && !heldA.length && stB.state === "running" && sameJson(pidsOf(stB), bPids), `${describe(dn)}; ${leftA} process(es) left, ports still held ${heldA.join(",") || "none"}; B ${describe(stB)}`, t0, dn.error?.code)) return;
    t0 = Date.now();
    const dn2 = await s.verb("down A again", "down", { instance: a.instance });
    if (!s.check("down-a-again", dn2.ok && !dn2.changed, describe(dn2), t0, dn2.error?.code)) return;
  };

  // A failed run's evidence, read before teardown removes it: what the fix needs (§app.project-services/conform).
  const logs: ConformLog[] = [];
  const tails = async () => {
    const said = new Set<string>();
    const tail = async (label: "A" | "B", service: string, state: string, unit: string) => {
      if (said.has(`${label}\0${service}`)) return;
      said.add(`${label}\0${service}`);
      const lines = (await engine.driver.logs(unit, CONFORM_LOG_LINES)).map((l) => l.text.slice(0, 2000));
      logs.push({ label, service, state, lines });
    };
    const failed = [...s.envelopes].reverse().find((e) => e.result.error);
    for (const [label, rec] of [["A", recA], ["B", recB]] as const) {
      if (!rec) continue;
      const st = await engine.run("status", { instance: rec.id }, confCaller).catch(() => null);
      for (const v of st?.services ?? [])
        if (v.unit && v.kind !== "static" && (["starting", "degraded", "failed"].includes(v.state) || (failed?.result.instance === rec.id && failed.result.error?.service === v.name)))
          await tail(label, v.name, v.state, v.unit);
      // A failed setup, data or build step: its own unit's output.
      const step = failed?.result.instance === rec.id ? failed.result.error?.step : undefined;
      // A hook names its unit's step (`setup-<id>`, `build-<service>`, `data-<name>-provision`); a step row names it `setup:<id>`.
      const hook = step?.replace(/^(setup|build):/, "$1-");
      if (hook && (hook === "test" || /^(setup|build|data|reload)-/.test(hook))) await tail(label, `step:${hook}`, "failed", engine.hookUnitOf(rec.id, hook));
      // The isolation probe's own runs.
      if (s.firstFailure?.id === "isolation") await tail(label, "step:probe", "failed", engine.hookUnitOf(rec.id, "probe"));
    }
    if (s.firstFailure?.id === "setup-twice" && recA) for (const st of def.setup) await tail("A", `step:setup-${st.id}`, "failed", engine.hookUnitOf(recA.id, `setup-${st.id}`));
  };

  try {
    await suite();
  } finally {
    memory.stop();
    if (s.failed) await tails().catch(() => undefined);
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
    // The run's own scratch worktrees and branches go on every outcome (§app.project-services/conform): teardown keeps
    // a worktree a failed step left files in, so whatever is still checked out on a scratch branch is removed by force.
    await removeScratch(git, project, [branchA, branchB]);
  }
  // 12. leaks.
  const t0 = Date.now();
  const leaks: string[] = [];
  for (const r of [recA as InstanceRecord | null, recB as InstanceRecord | null]) {
    if (!r) continue;
    const prefix = `${engine.unitPrefix()}${r.id}-`;
    for (const u of await engine.driver.units(prefix)) leaks.push(`unit ${u}`);
    for (const svc of def.services.filter((x) => x.scope === "checkout")) for (const p of engine.driver.pids(engine.unitOf(r.id, svc.name))) leaks.push(`process ${p} in ${svc.name}`);
    for (const ports of Object.values(r.ports)) for (const p of Object.values(ports)) if (engine.portHeld(p)) leaks.push(`listener on port ${p}`);
    if (existsSync(dataRootOf(r.id))) leaks.push(`data dir ${dataRootOf(r.id)}`);
    for (const ref of Object.values(r.data)) if (ref.startsWith("/") && existsSync(ref)) leaks.push(`data ${ref}`);
    if (readRegistry().instances.some((i) => i.id === r.id)) leaks.push(`registry entry ${r.id}`);
    if (existsSync(r.checkout)) leaks.push(`worktree ${r.checkout}`);
  }
  for (const c of containersSeen) if (await containerExists(c.engine, c.name)) leaks.push(`container ${c.name}`);
  const wt = await git(["worktree", "list", "--porcelain"], project);
  for (const br of [branchA, branchB]) if (wt.stdout.includes(`branch refs/heads/${br}\n`)) leaks.push(`git worktree on ${br}`);
  // What appeared during the run is a leak only when it is the run's own scratch instance's, or nobody's:
  // another instance's (registered before the run, or made meanwhile by another caller: a session's
  // up, the server's reconcile) never is.
  const reg = readRegistry();
  const scratch = new Set<string>([recA as InstanceRecord | null, recB as InstanceRecord | null].flatMap((r) => (r ? [r.id] : [])));
  for (const i of reg.instances) if (i.createdBy === callerTag(confCaller)) scratch.add(i.id);
  const others = new Set([...before.instances, ...before.shared, ...reg.instances.map((i) => i.id), ...reg.shared.map((x) => x.id)].filter((id) => !scratch.has(id)));
  // The owner is the longest id that names it (one id can be another's prefix).
  const leaked = (owned: (id: string) => boolean) => {
    const owner = [...scratch, ...others].filter(owned).sort((x, y) => y.length - x.length)[0];
    return owner === undefined || scratch.has(owner);
  };
  const after = { units: await engine.driver.units(engine.unitPrefix()), instances: reg.instances.map((i) => i.id), data: listDataDirs() };
  for (const u of after.units)
    if (!before.units.has(u) && !leaks.includes(`unit ${u}`) && leaked((id) => u.startsWith(`${engine.unitPrefix()}${id}-`))) leaks.push(`unit ${u}`);
  for (const i of after.instances) if (!before.instances.has(i) && scratch.has(i) && !leaks.includes(`registry entry ${i}`)) leaks.push(`registry entry ${i}`);
  for (const d of after.data) if (!before.data.has(d) && !leaks.includes(`data dir ${dataRootOf(d)}`) && leaked((id) => d === id)) leaks.push(`data dir ${d}`);
  s.check("no-leaks", !leaks.length, leaks.length ? leaks.join("; ") : "no unit, process, listener, data dir, container, registry entry or worktree left", t0);
  return {
    report: {
      suiteVersion: SUITE_VERSION,
      defHash: t.defHash,
      ref: `${t.ref} (${commit.slice(0, 12)})`,
      pass: !s.failed,
      checks: s.checks,
      leaks,
      ...(logs.length ? { logs } : {}),
      ...(recA ? { memory: memory.report() } : {}),
    },
    envelopes: s.envelopes,
    failure: s.firstFailure,
  };
}
