import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  CONTRACT_FILE,
  closureOf,
  DefinitionError,
  envPart,
  isVerb,
  ordered,
  parseDefinition,
  portsFor,
  READ_VERBS,
  render,
  RESERVED_VERBS,
  serviceOrder,
  type AnyVerb,
  type Check,
  type DataDecl,
  type DataView,
  type ErrorCode,
  type InstanceState,
  type InstanceSummary,
  type LogLine,
  type ProjectDef,
  type ServiceDecl,
  type ServiceView,
  type Step,
  type StepKind,
  type VerbResult,
} from "../../shared/project-contract";
import type { Autonomy } from "../../shared/project-overseer";
import { portOwner as realPortOwner, type PortOwner } from "../port-owner";
import { startStaticServe, staticServes, StaticServeError, stopStaticServe } from "../preview-serve";
import { projectOf } from "../project-root";
import { DriverError, type Driver, type UnitSpec } from "./drivers";
import {
  dataRootOf,
  instanceLockFile,
  mutateRegistry,
  newInstanceId,
  pickSlot,
  readRegistry,
  sharedIdOf,
  stateHash,
  tryLock,
  type InstanceRecord,
  type SharedRecord,
} from "./store";
import { defHashOf, hostVars, isApproved } from "./trust";

/**
 * The verbs (§app/project-services): one engine in the server implements every verb from the
 * project's declaration, and every caller (routes, CLI, the session tool, the Overseers' tool) gets
 * its one result shape. Converges towards a desired state, so each verb is idempotent; one lock per
 * instance, a second caller gets `busy`.
 */

// ---- callers and requests -------------------------------------------------------------------------

export type Caller =
  | { kind: "operator"; confirm?: boolean }
  | { kind: "overseer"; id: string }
  /** `attended`: the operator's own run, which the level does not bind (§app.project-overseer/autonomy-levels). */
  | { kind: "project-overseer"; id: string; root: string; level: Autonomy; attended?: boolean }
  | { kind: "session"; id: string; root: string | null; own: string[] }
  | { kind: "conform"; id: string };

export const callerTag = (c: Caller): string => (c.kind === "operator" ? "operator" : `${c.kind}:${c.id}`);

export interface VerbRequest {
  project?: string;
  instance?: string;
  checkout?: string;
  branch?: string;
  from?: string;
  slot?: number;
  services?: string[];
  restart?: boolean;
  lines?: number;
  keepData?: boolean;
  resources?: string[];
  ref?: string;
  /** The operator's confirm (stopping a shared service). */
  confirm?: boolean;
}

export class VerbFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { step?: string; service?: string } = {},
  ) {
    super(message);
    this.name = "VerbFailure";
  }
}

const REQUEST_KEYS: Record<keyof VerbRequest, "string" | "number" | "boolean" | "strings"> = {
  project: "string",
  instance: "string",
  checkout: "string",
  branch: "string",
  from: "string",
  slot: "number",
  services: "strings",
  restart: "boolean",
  lines: "number",
  keepData: "boolean",
  resources: "strings",
  ref: "string",
  confirm: "boolean",
};

/** A request body, checked strictly: unknown keys and wrong types are `invalid-request`. */
export function parseRequest(body: unknown): VerbRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new VerbFailure("invalid-request", "the request is a JSON object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const want = REQUEST_KEYS[k as keyof VerbRequest];
    if (!want) throw new VerbFailure("invalid-request", `unknown request key "${k}"`);
    const ok =
      want === "strings" ? Array.isArray(v) && v.every((x) => typeof x === "string" && x) : want === "number" ? typeof v === "number" && Number.isInteger(v) && v >= 0 : typeof v === want && (want !== "string" || v !== "");
    if (!ok) throw new VerbFailure("invalid-request", `"${k}" must be ${want === "strings" ? "a list of names" : want === "number" ? "a whole number" : `a ${want}`}`);
    out[k] = v;
  }
  return out as VerbRequest;
}

// ---- small helpers ----------------------------------------------------------------------------------

type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export const realGit: GitRun = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || "failed";
const canonical = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The variables a service or hook process inherits from the server: nothing secret. */
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR", "SHELL", "TMPDIR"];
function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  out.LANG ??= "C.UTF-8";
  return out;
}

function tcpOpen(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port });
    const end = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

async function httpOk(port: number, path: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await r.body?.cancel().catch(() => undefined);
    return r.status < 500;
  } catch {
    return false;
  }
}

// ---- the engine -----------------------------------------------------------------------------------

export interface EngineDeps {
  driver: Driver;
  git?: GitRun;
  portOwner?: (port: number) => PortOwner;
  /** Run a container engine command (`docker rm -f …`); tests fake it. */
  containerExec?: (engine: string, args: string[]) => Promise<number>;
  /** Poll interval for readiness waits. */
  pollMs?: number;
}

/** Everything one verb run knows. */
interface Run {
  verb: AnyVerb;
  caller: Caller;
  req: VerbRequest;
  project: string | null;
  rec: InstanceRecord | null;
  def: ProjectDef | null;
  defError: DefinitionError | null;
  defHash: string | null;
  approved: boolean;
  steps: Step[];
  extra: Partial<Pick<VerbResult, "instances" | "lines" | "checks" | "conform">>;
}

/** The scope a process runs in: an instance, or the project's shared services. */
interface Scope {
  id: string;
  project: string;
  checkout: string;
  branch: string | null;
  slot: number;
  ports: Record<string, Record<string, number>>;
  data: Record<string, string>;
}

/** Whether a definition runs any process (a cmd service, a setup step, a data or probe hook), rather than only static folders. */
const runsProcesses = (def: ProjectDef) => def.services.some((s) => s.static === undefined) || def.setup.length > 0 || def.data.some((d) => d.kind === "hook") || !!def.hooks.probe;

const scopeOf = (rec: InstanceRecord): Scope => ({ id: rec.id, project: rec.project, checkout: rec.checkout, branch: rec.branch, slot: rec.slot, ports: rec.ports, data: rec.data });

export class ProjectEngine {
  readonly driver: Driver;
  private readonly git: GitRun;
  private readonly portOwner: (port: number) => PortOwner;
  private readonly containerExec: (engine: string, args: string[]) => Promise<number>;
  private readonly pollMs: number;
  private sharedChain = new Map<string, Promise<unknown>>();
  /** The conformance runner (server/project-services/conform.ts), wired at startup. */
  conformer: ((body: unknown, caller: Caller) => Promise<VerbResult>) | null = null;

  constructor(deps: EngineDeps) {
    this.driver = deps.driver;
    this.git = deps.git ?? realGit;
    this.portOwner = deps.portOwner ?? ((p) => realPortOwner(p));
    this.containerExec =
      deps.containerExec ??
      ((engine, args) =>
        new Promise((done) => {
          execFile(engine, args, { timeout: 60_000 }, (err) => done(err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127) : 0));
        }));
    this.pollMs = deps.pollMs ?? 250;
  }

  unitOf(scopeId: string, service: string): string {
    return `sova-svc-${stateHash()}-${scopeId}-${service}`;
  }
  hookUnitOf(scopeId: string, step: string): string {
    return `sova-hook-${stateHash()}-${scopeId}-${step}`;
  }
  /** Every unit name of this state root starts with it. */
  unitPrefix(): string {
    return `sova-svc-${stateHash()}-`;
  }

  // ---- entry --------------------------------------------------------------------------------------

  /** Run one verb for `caller`. Never throws: every outcome is a result. */
  async run(verb: string, body: unknown, caller: Caller): Promise<VerbResult> {
    const run: Run = { verb: (isVerb(verb) ? verb : "status") as AnyVerb, caller, req: {}, project: null, rec: null, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
    let release: (() => void) | null = null;
    if (verb === "conform" && this.conformer) return this.conformer(body, caller);
    try {
      if (!isVerb(verb)) throw new VerbFailure("invalid-request", `unknown verb "${verb}"`);
      run.req = parseRequest(body);
      if ((RESERVED_VERBS as readonly string[]).includes(verb)) throw new VerbFailure("unsupported", `${verb} is reserved and not supported yet`);
      await this.resolveTarget(run);
      if (run.verb === "teardown" && !run.rec) return await this.result(run);
      this.authorize(run);
      if (!(READ_VERBS as readonly string[]).includes(verb) && verb !== "conform") {
        const lock = tryLock(instanceLockFile(run.project!, this.targetKey(run)));
        if ("heldBy" in lock) throw new VerbFailure("busy", `another verb is running on this instance (pid ${lock.heldBy}); try again when it ends`);
        release = lock.release;
        // Re-read under the lock: the holder before us may have changed it.
        if (run.rec) run.rec = readRegistry().instances.find((i) => i.id === run.rec!.id) ?? null;
      }
      await this.dispatch(run);
      return await this.result(run);
    } catch (err) {
      const f = err instanceof VerbFailure ? err : err instanceof DefinitionError ? new VerbFailure("invalid-definition", err.message) : new VerbFailure("start-failed", err instanceof Error ? err.message : String(err));
      return await this.result(run, f);
    } finally {
      release?.();
    }
  }

  /** The checkout a create/up without an instance aims at; the lock key before the instance exists. */
  private targetKey(run: Run): string {
    if (run.rec) return run.rec.checkout;
    return (run as Run & { target?: string }).target ?? run.project!;
  }

  // ---- resolving ------------------------------------------------------------------------------------

  private async resolveTarget(run: Run): Promise<void> {
    const { req } = run;
    const reg = readRegistry();
    if (req.instance) {
      const rec = reg.instances.find((i) => i.id === req.instance);
      if (!rec) {
        // An absent instance is teardown's done state; for everything else it is not found.
        if (run.verb === "teardown") {
          if (req.project) run.project = await this.projectRoot(req.project);
          return;
        }
        throw new VerbFailure("not-found", `no instance ${req.instance}`);
      }
      if (req.project && (await this.projectRoot(req.project)) !== rec.project) throw new VerbFailure("not-found", `instance ${req.instance} is not in ${req.project}`);
      run.project = rec.project;
      run.rec = rec;
    } else {
      if (!req.project && !req.checkout) throw new VerbFailure("invalid-request", "name the project (a path inside it) or an instance");
      run.project = await this.projectRoot(req.project ?? req.checkout!);
      if (run.verb === "create" || run.verb === "up") {
        const target = await this.targetCheckout(run);
        (run as Run & { target?: string }).target = target.checkout;
        run.rec = reg.instances.find((i) => i.project === run.project && i.checkout === target.checkout) ?? null;
      } else if (["down", "apply", "reset", "teardown", "logs"].includes(run.verb)) {
        if (!req.checkout) throw new VerbFailure("invalid-request", `${run.verb} needs an instance (or the checkout it runs)`);
        const checkout = canonical(req.checkout);
        run.rec = reg.instances.find((i) => i.project === run.project && i.checkout === checkout) ?? null;
        if (!run.rec && run.verb !== "teardown") throw new VerbFailure("not-found", `no instance runs ${checkout}`);
      }
    }
    // The definition: the instance's own checkout's, else the main checkout's.
    const from = run.rec?.checkout ?? (run as Run & { target?: string }).target ?? run.project!;
    if (run.verb !== "conform") this.loadDefinition(run, from);
  }

  private async projectRoot(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new VerbFailure("invalid-request", "the project is an absolute path");
    const p = await projectOf(path);
    if (p.state !== "ok") throw new VerbFailure("not-found", p.state === "none" ? `no project at ${path}` : p.message);
    return p.root;
  }

  /** Where create/up aim: an adopted checkout, a branch's worktree (cut when missing), or the main checkout. */
  private async targetCheckout(run: Run): Promise<{ checkout: string; branch: string | null; cut: boolean; exists: boolean }> {
    const { req } = run;
    const project = run.project!;
    if (req.checkout && req.branch) throw new VerbFailure("invalid-request", "give checkout or branch, not both");
    if (req.checkout) {
      if (!existsSync(req.checkout)) throw new VerbFailure("not-found", `${req.checkout} doesn't exist`);
      const top = await this.git(["rev-parse", "--show-toplevel"], req.checkout);
      const checkout = top.code === 0 ? canonical(top.stdout.trim()) : canonical(req.checkout);
      if ((await this.projectRoot(checkout)) !== project) throw new VerbFailure("invalid-request", `${checkout} is not a checkout of ${project}`);
      return { checkout, branch: await this.branchOf(checkout), cut: false, exists: true };
    }
    if (req.branch) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(req.branch) || req.branch.includes("..")) throw new VerbFailure("invalid-request", "branch is a plain branch name");
      const existing = await this.worktreeOfBranch(project, req.branch);
      if (existing) return { checkout: existing, branch: req.branch, cut: false, exists: true };
      const slug = req.branch.replace(/^sova\//, "").replace(/[^A-Za-z0-9._-]+/g, "-");
      return { checkout: join(dirname(project), ".worktrees", `${basename(project)}-${slug}`), branch: req.branch, cut: true, exists: false };
    }
    return { checkout: project, branch: await this.branchOf(project), cut: false, exists: true };
  }

  private async branchOf(checkout: string): Promise<string | null> {
    const r = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], checkout);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  private async worktreeOfBranch(project: string, branch: string): Promise<string | null> {
    const r = await this.git(["worktree", "list", "--porcelain"], project);
    let path: string | null = null;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line === `branch refs/heads/${branch}` && path) return canonical(path);
    }
    return null;
  }

  loadDefinition(run: Run, checkout: string): void {
    const file = join(checkout, CONTRACT_FILE);
    try {
      if (!existsSync(file)) {
        if ((checkout === (run as Run & { target?: string }).target && run.req.branch && !existsSync(checkout)) || run.verb === "conform") return;
        throw new DefinitionError("$", `no ${CONTRACT_FILE} in ${checkout}`);
      }
      this.setDefinition(run, readFileSync(file, "utf8"));
    } catch (err) {
      if (!(err instanceof DefinitionError)) throw err;
      run.defError = err;
    }
  }

  setDefinition(run: Run, text: string): void {
    run.def = parseDefinition(text);
    run.defHash = defHashOf(run.def);
    run.approved = isApproved(run.project!, run.defHash);
  }

  /** No supervisor, no process verbs (§app.project-services/supervisor): refused before anything changes. */
  private async supervised(def: ProjectDef | null): Promise<void> {
    if (!def || !runsProcesses(def)) return;
    const d = await this.driver.available();
    if (!d.ok) throw new VerbFailure("unsupported", `${d.detail}: this host can't run a project's processes (a host without systemd starts Sova with SOVA_PROJECT_DRIVER=detached)`);
  }

  /** The definition, valid and approved, or the refusal. */
  private need(run: Run, approved = true): ProjectDef {
    if (run.defError) throw new VerbFailure("invalid-definition", run.defError.message);
    if (!run.def) throw new VerbFailure("invalid-definition", `no ${CONTRACT_FILE}`);
    if (approved && !run.approved)
      throw new VerbFailure("not-approved", `this definition (${run.defHash}) is not approved on this host: the operator approves it (sova-project approve --project ${run.project} --def-hash ${run.defHash})`);
    return run.def;
  }

  // ---- who may call what (§app.project-services/callers) --------------------------------------------

  private authorize(run: Run): void {
    const { caller, verb } = run;
    const sharedNamed = verb === "down" && !!run.req.services?.length && !!run.def && run.req.services.some((n) => run.def!.services.find((s) => s.name === n)?.scope === "shared");
    const confirmShared = "stopping a shared service stops it for every instance of the project: the operator does it (sova-project down … --confirm)";
    if (caller.kind === "operator") {
      if (sharedNamed && !run.req.confirm) throw new VerbFailure("needs-confirm", confirmShared);
      return;
    }
    if (caller.kind === "conform") return;
    const project = run.project!;
    const read = (READ_VERBS as readonly string[]).includes(verb);
    if (caller.kind === "project-overseer" || caller.kind === "session") {
      if (caller.root !== project) throw new VerbFailure("forbidden", `this caller acts only on its own project${caller.root ? ` (${caller.root})` : ""}`);
    }
    if (read) return;
    const createdByCaller = !!run.rec && run.rec.createdBy === callerTag(caller);
    if (sharedNamed) throw new VerbFailure("needs-confirm", confirmShared);
    if (caller.kind === "overseer") {
      if ((verb === "reset" || verb === "teardown") && run.rec && !createdByCaller)
        throw new VerbFailure("needs-confirm", `${verb} of an instance you did not create (${run.rec.createdBy}'s) is the operator's: ask them to run it`);
      return;
    }
    if (caller.kind === "project-overseer") {
      const need: Autonomy = verb === "down" ? "L0" : "L3";
      if (!caller.attended && caller.level < need)
        throw new VerbFailure("forbidden", `${verb} needs level ${need} and you are at ${caller.level}: file the gap as an idea or raise a confirm card instead`);
      if ((verb === "reset" || verb === "teardown") && run.rec && !createdByCaller)
        throw new VerbFailure("needs-confirm", `${verb} of an instance you did not create (${run.rec.createdBy}'s) is the operator's: ask them to run it`);
      return;
    }
    // A coding session.
    if (verb === "conform") return;
    const checkout = run.rec?.checkout ?? (run as Run & { target?: string }).target ?? null;
    if (!checkout || checkout === project || !caller.own.includes(checkout))
      throw new VerbFailure("forbidden", "a session acts only on instances of its own worktrees (never the main checkout)");
    if ((verb === "reset" || verb === "teardown") && run.rec && !createdByCaller) throw new VerbFailure("needs-confirm", `${verb} of an instance this session did not create is the operator's`);
  }

  // ---- dispatch ----------------------------------------------------------------------------------------

  private async dispatch(run: Run): Promise<void> {
    switch (run.verb) {
      case "create":
        return void (await this.create(run));
      case "up":
        return this.up(run);
      case "down":
        return this.down(run);
      case "apply":
        return this.apply(run);
      case "status":
        return this.status(run);
      case "logs":
        return this.logs(run);
      case "doctor":
        return this.doctor(run);
      case "reset":
        return this.reset(run);
      case "teardown":
        return this.teardown(run);
      case "conform":
        throw new VerbFailure("unsupported", "conform runs through the conformance runner");
      default:
        throw new VerbFailure("unsupported", `${run.verb} is not supported yet`);
    }
  }

  private async step<T>(run: Run, id: string, kind: StepKind, fn: () => Promise<{ result: "done" | "skipped"; detail?: string; fingerprint?: string; value?: T }>): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const r = await fn();
      run.steps.push({ id, kind, result: r.result, ms: Date.now() - t0, ...(r.detail ? { detail: r.detail } : {}), ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) });
      return r.value;
    } catch (err) {
      const f = err instanceof VerbFailure ? err : new VerbFailure("start-failed", err instanceof Error ? err.message : String(err));
      run.steps.push({ id, kind, result: "failed", ms: Date.now() - t0, detail: f.message });
      if (!f.extra.step) (f.extra as { step?: string }).step = id;
      throw f;
    }
  }

  private save(rec: InstanceRecord): void {
    mutateRegistry((r) => {
      const i = r.instances.findIndex((x) => x.id === rec.id);
      if (i >= 0) r.instances[i] = rec;
    });
  }

  // ---- env and templates ----------------------------------------------------------------------------

  private vars(def: ProjectDef, scope: Scope): Record<string, string> {
    const v: Record<string, string> = {
      slot: String(scope.slot),
      instance: scope.id,
      project: scope.project,
      checkout: scope.checkout,
      main: scope.project,
      branch: scope.branch ?? "",
      data: dataRootOf(scope.id),
    };
    for (const d of def.data) v[`data.${d.name}`] = scope.data[d.name] ?? this.dataPath(d, scope);
    const all = this.allPorts(def, scope);
    for (const [svc, ps] of Object.entries(all)) for (const [k, n] of Object.entries(ps)) v[`ports.${svc}.${k}`] = String(n);
    for (const [k, val] of Object.entries(hostVars(scope.project))) v[`host.${k}`] = val;
    for (const h of def.host) v[`host.${h}`] ??= "";
    return v;
  }

  /** Every port the scope sees: its own (checkout services) and the project's shared ones. */
  private allPorts(def: ProjectDef, scope: Scope): Record<string, Record<string, number>> {
    const fixed = portsFor(def, scope.slot);
    const out: Record<string, Record<string, number>> = {};
    for (const s of def.services) out[s.name] = s.scope === "shared" ? (fixed[s.name] ?? {}) : (scope.ports[s.name] ?? fixed[s.name] ?? {});
    return out;
  }

  private env(def: ProjectDef, scope: Scope, extra: { service?: ServiceDecl; verb?: string; step?: string; out?: string } = {}): Record<string, string> {
    const vars = this.vars(def, scope);
    const e: Record<string, string> = {
      ...baseEnv(),
      SOVA_V: "1",
      SOVA_PROJECT: scope.project,
      SOVA_INSTANCE: scope.id,
      SOVA_SLOT: String(scope.slot),
      SOVA_CHECKOUT: scope.checkout,
      SOVA_MAIN: scope.project,
      SOVA_BRANCH: scope.branch ?? "",
      SOVA_DATA: dataRootOf(scope.id),
    };
    for (const [svc, ps] of Object.entries(this.allPorts(def, scope))) for (const [k, n] of Object.entries(ps)) e[`SOVA_PORT_${envPart(svc)}_${envPart(k)}`] = String(n);
    if (extra.service) {
      for (const [k, n] of Object.entries(this.allPorts(def, scope)[extra.service.name] ?? {})) e[`SOVA_PORT_${envPart(k)}`] = String(n);
      for (const [k, t] of Object.entries(extra.service.env)) e[k] = render(t, vars);
    }
    if (extra.verb) e.SOVA_VERB = extra.verb;
    if (extra.step) e.SOVA_STEP = extra.step;
    if (extra.out) e.SOVA_OUT = extra.out;
    return e;
  }

  private dataPath(d: DataDecl, scope: Scope): string {
    return d.kind === "dir" && d.path ? join(scope.checkout, d.path) : join(dataRootOf(scope.id), d.name);
  }

  // ---- hooks (setup, build, data hooks, reload cmd, probe) -----------------------------------------------

  /** Run `argv` once as its own unit; exit 0 or `hook-failed`. */
  async hook(def: ProjectDef, scope: Scope, stepId: string, argv: string[], timeoutSec: number, verb: string, cwd = scope.checkout): Promise<Record<string, string>> {
    const vars = this.vars(def, scope);
    const outFile = join(dataRootOf(scope.id), ".out", `${stepId}.json`);
    mkdirSync(dirname(outFile), { recursive: true });
    rmSync(outFile, { force: true });
    const spec: UnitSpec & { timeoutSec: number } = {
      unit: this.hookUnitOf(scope.id, stepId),
      argv: argv.map((a) => render(a, vars)),
      cwd,
      env: this.env(def, scope, { verb, step: stepId, out: outFile }),
      timeoutSec,
    };
    const r = await this.driver.runOnce(spec);
    if (r.timedOut) throw new VerbFailure("hook-failed", `${stepId} timed out after ${timeoutSec}s`, { step: stepId });
    if (r.code !== 0) throw new VerbFailure("hook-failed", `${stepId} exited with ${r.code}`, { step: stepId });
    try {
      const out = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, unknown>;
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(out)) if (typeof v === "string") flat[k] = v;
      return flat;
    } catch {
      return {};
    }
  }

  private fingerprint(scope: Scope, argv: string[], inputs: string[]): string {
    const parts = [JSON.stringify(argv)];
    for (const f of inputs) {
      try {
        parts.push(`${f}:${sha(readFileSync(join(scope.checkout, f), "utf8"))}`);
      } catch {
        parts.push(`${f}:missing`);
      }
    }
    return `sha256:${sha(parts.join("\n")).slice(0, 32)}`;
  }

  // ---- create --------------------------------------------------------------------------------------------

  private async create(run: Run): Promise<InstanceRecord> {
    const project = run.project!;
    if (run.rec) {
      const def = this.need(run);
      await this.supervised(def);
      await this.provision(run, def, run.rec, false);
      return run.rec;
    }
    const target = await this.targetCheckout(run);
    // The definition is read and approved before anything is made: from the branch's commit when
    // the worktree does not exist yet.
    if (!target.exists) {
      const ref = (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}^{commit}`], project)).code === 0 ? target.branch! : (run.req.from ?? "HEAD");
      const shown = await this.git(["show", `${ref}:${CONTRACT_FILE}`], project);
      if (shown.code !== 0) throw new VerbFailure("invalid-definition", `no ${CONTRACT_FILE} at ${ref}`);
      run.defError = null;
      try {
        this.setDefinition(run, shown.stdout);
      } catch (err) {
        if (err instanceof DefinitionError) throw new VerbFailure("invalid-definition", err.message);
        throw err;
      }
    }
    const def = this.need(run);
    await this.supervised(def);
    const main = target.checkout === project;
    if (!main && run.req.slot === 0) throw new VerbFailure("refused-slot0", "slot 0 is the main checkout's");
    if (main && run.req.slot !== undefined && run.req.slot !== 0) throw new VerbFailure("invalid-request", "the main checkout is slot 0");
    if (run.req.slot !== undefined && run.req.slot > def.slots.cap + 2) throw new VerbFailure("invalid-request", `slot is at most ${def.slots.cap + 2}`);
    const checkoutPorts = (slot: number) => def.services.filter((s) => s.scope === "checkout").flatMap((s) => Object.values(portsFor(def, slot)[s.name] ?? {}));
    const listening = (p: number) => this.portOwner(p) !== "none";
    const rec = await this.step(run, "slot", "slot", async () => {
      const made = mutateRegistry((r) => {
        const dup = r.instances.find((i) => i.project === project && i.checkout === target.checkout);
        if (dup) return { rec: dup, fresh: false };
        const range = Array.from({ length: def.slots.cap }, (_, i) => i + 1);
        const pick = main ? pickSlot(r, project, checkoutPorts, [], () => false, 0) : pickSlot(r, project, checkoutPorts, range, listening, run.req.slot);
        if ("refused" in pick) throw new VerbFailure("cap-reached", pick.refused);
        const all = portsFor(def, pick.slot);
        const ports: Record<string, Record<string, number>> = {};
        for (const s of def.services) if (s.scope === "checkout" && Object.keys(s.ports).length) ports[s.name] = all[s.name] ?? {};
        const rec: InstanceRecord = {
          id: newInstanceId(project),
          project,
          checkout: target.checkout,
          branch: target.branch,
          slot: pick.slot,
          generation: 0,
          createdBy: callerTag(run.caller),
          createdAt: new Date().toISOString(),
          cutWorktree: target.cut,
          desired: {},
          prints: {},
          data: {},
          ports,
        };
        r.instances.push(rec);
        return { rec, fresh: true };
      });
      return { result: made.fresh ? "done" : "skipped", detail: `slot ${made.rec.slot}`, value: made.rec };
    });
    run.rec = rec!;
    if (target.cut) {
      await this.step(run, "worktree", "worktree", async () => {
        if (existsSync(target.checkout)) throw new VerbFailure("invalid-request", `${target.checkout} already exists`);
        const branchExists = (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}`], project)).code === 0;
        const args = branchExists ? ["worktree", "add", "--", target.checkout, target.branch!] : ["worktree", "add", "-b", target.branch!, "--", target.checkout, run.req.from ?? "HEAD"];
        const r = await this.git(args, project);
        if (r.code !== 0) {
          mutateRegistry((reg) => {
            reg.instances = reg.instances.filter((i) => i.id !== run.rec!.id);
          });
          run.rec = null;
          throw new VerbFailure("invalid-request", `git worktree add failed: ${firstLine(r.stderr || r.stdout)}`);
        }
        return { result: "done", detail: `${target.branch} at ${target.checkout}` };
      });
      run.rec.checkout = canonical(target.checkout);
      this.save(run.rec);
    }
    await this.provision(run, def, run.rec, false);
    return run.rec;
  }

  /** Data resources (skipped when they exist) then setup steps (skipped when their fingerprint holds); `force` redoes both. */
  private async provision(run: Run, def: ProjectDef, rec: InstanceRecord, force: boolean, only?: string[]): Promise<void> {
    const scope = scopeOf(rec);
    mkdirSync(dataRootOf(rec.id), { recursive: true });
    for (const d of def.data) {
      if (only && !only.includes(d.name)) continue;
      await this.step(run, `data:${d.name}`, "data", async () => {
        if (!force && rec.data[d.name] && this.dataExists(d, rec)) return { result: "skipped", detail: rec.data[d.name] };
        const ref = await this.provisionOne(def, rec, d);
        rec.data[d.name] = ref;
        this.save(rec);
        return { result: "done", detail: ref };
      });
    }
    for (const s of def.setup) {
      await this.step(run, `setup:${s.id}`, "setup", async () => {
        const argv = s.run.map((a) => render(a, this.vars(def, scopeOf(rec))));
        const fp = this.fingerprint(scope, argv, s.inputs);
        if (!force && rec.prints[s.id] === fp) return { result: "skipped", fingerprint: fp };
        await this.hook(def, scopeOf(rec), `setup-${s.id}`, s.run, s.timeout, run.verb);
        rec.prints[s.id] = fp;
        this.save(rec);
        return { result: "done", fingerprint: fp };
      });
    }
  }

  private dataExists(d: DataDecl, rec: InstanceRecord): boolean {
    if (d.kind === "hook") return !!rec.data[d.name];
    const p = rec.data[d.name];
    return !!p && existsSync(p);
  }

  private async provisionOne(def: ProjectDef, rec: InstanceRecord, d: DataDecl): Promise<string> {
    const scope = scopeOf(rec);
    if (d.kind === "hook") {
      const out = await this.hook(def, scope, `data-${d.name}-provision`, d.provision, d.timeout, "provision");
      return out.ref ?? `hook:${d.name}`;
    }
    const path = this.dataPath(d, scope);
    if (d.path) {
      // Asked as a folder (trailing slash): a `.agent/` pattern matches only folders, and it does not exist yet.
      const ig = await this.git(["check-ignore", "-q", "--", `${d.path}/`], rec.checkout);
      if (ig.code !== 0) throw new VerbFailure("invalid-definition", `data.${d.name}.path (${d.path}) must be ignored by git in the checkout`);
    }
    if (d.from === "empty") {
      mkdirSync(path, { recursive: true });
      return path;
    }
    const src = render(d.from, this.vars(def, scope));
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new VerbFailure("not-found", `data.${d.name}.from: ${src} is not a folder`);
    mkdirSync(path, { recursive: true });
    const code = await this.containerExecLike("cp", ["-a", "--reflink=auto", `${src}/.`, path]);
    if (code !== 0) throw new VerbFailure("hook-failed", `copying ${src} to ${path} failed (exit ${code})`);
    return path;
  }

  private containerExecLike(file: string, args: string[]): Promise<number> {
    return new Promise((done) => execFile(file, args, { timeout: 600_000 }, (err) => done(err ? 1 : 0)));
  }

  private async deprovisionOne(def: ProjectDef | null, rec: InstanceRecord, name: string): Promise<void> {
    const d = def?.data.find((x) => x.name === name);
    const ref = rec.data[name];
    if (d?.kind === "hook") await this.hook(def!, scopeOf(rec), `data-${d.name}-deprovision`, d.deprovision, d.timeout, "deprovision");
    else if (ref && isAbsolute(ref) && (ref.startsWith(dataRootOf(rec.id) + "/") || ref.startsWith(rec.checkout + "/"))) rmSync(ref, { recursive: true, force: true });
    delete rec.data[name];
    this.save(rec);
  }

  // ---- services ----------------------------------------------------------------------------------------

  private kindOf(s: ServiceDecl): ServiceView["kind"] {
    return s.static !== undefined ? "static" : s.container ? "container" : "process";
  }

  private sharedScope(def: ProjectDef, project: string): Scope {
    return { id: sharedIdOf(project), project, checkout: project, branch: null, slot: 0, ports: {}, data: {} };
  }

  private async isActive(unit: string, s: ServiceDecl): Promise<{ active: boolean; pid: number | null }> {
    if (s.static !== undefined) return { active: staticServes().some((x) => x.id === unit), pid: staticServes().some((x) => x.id === unit) ? process.pid : null };
    const st = await this.driver.status(unit);
    return { active: st.state === "active" || st.state === "activating", pid: st.pid };
  }

  /** One readiness probe; `ms` it took. */
  private async probe(def: ProjectDef, scope: Scope, s: ServiceDecl, unit: string): Promise<{ probe: string; ok: boolean; ms: number }> {
    const t0 = Date.now();
    const ports = this.allPorts(def, scope)[s.name] ?? {};
    if (s.static !== undefined) return { probe: "serve", ok: staticServes().some((x) => x.id === unit), ms: 0 };
    if (s.ready && "http" in s.ready) {
      const port = ports[s.ready.http]!;
      return { probe: `http :${port}${s.ready.path}`, ok: await httpOk(port, s.ready.path), ms: Date.now() - t0 };
    }
    const portName = s.ready && "tcp" in s.ready ? s.ready.tcp : Object.keys(ports)[0];
    if (portName !== undefined) {
      const port = ports[portName]!;
      return { probe: `tcp :${port}`, ok: await tcpOpen(port), ms: Date.now() - t0 };
    }
    const st = await this.driver.status(unit);
    return { probe: "running", ok: st.state === "active", ms: Date.now() - t0 };
  }

  private async waitReady(run: Run, def: ProjectDef, scope: Scope, s: ServiceDecl, unit: string): Promise<void> {
    const timeoutSec = s.ready?.timeout ?? 60;
    await this.step(run, `ready:${s.name}`, "ready", async () => {
      const until = Date.now() + timeoutSec * 1000;
      const bare = !s.ready && !Object.keys(s.ports).length && s.static === undefined;
      const started = Date.now();
      for (;;) {
        if (s.static === undefined) {
          const st = await this.driver.status(unit);
          if (st.state !== "active" && st.state !== "activating") {
            const tail = (await this.driver.logs(unit, 5)).map((l) => l.text).join(" | ");
            throw new VerbFailure("start-failed", `${s.name} stopped (${st.detail ?? st.state}${st.exit !== undefined && st.exit !== null ? `, exit ${st.exit}` : ""})${tail ? `: ${tail}` : ""}`, { service: s.name });
          }
        }
        const p = await this.probe(def, scope, s, unit);
        if (p.ok && (!bare || Date.now() - started >= 1_000)) return { result: "done", detail: p.probe };
        if (Date.now() > until) throw new VerbFailure("not-ready", `${s.name} was not ready within ${timeoutSec}s (${p.probe})`, { service: s.name });
        await sleep(this.pollMs);
      }
    });
  }

  /** A listener on one of `s`'s ports refuses the start (never stopped). */
  private preflight(def: ProjectDef, scope: Scope, s: ServiceDecl): void {
    for (const [k, port] of Object.entries(this.allPorts(def, scope)[s.name] ?? {})) {
      const o = this.portOwner(port);
      if (o === "none") continue;
      const who = o === "unknown" ? "a process this user can't read" : `pid ${o.pid} (${o.cwd})`;
      throw new VerbFailure("port-held", `${s.name}.${k} needs port ${port}, which ${who} holds; Sova never stops it`, { service: s.name });
    }
  }

  private async removeContainer(def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<void> {
    if (!s.container) return;
    const name = render(s.container.name, this.vars(def, scope));
    await this.containerExec(s.container.engine, ["rm", "-f", name]);
  }

  private async startService(run: Run, def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<void> {
    const unit = this.unitOf(scope.id, s.name);
    const port = Object.values(this.allPorts(def, scope)[s.name] ?? {})[0];
    await this.step(run, `start:${s.name}`, "start", async () => {
      if (s.static !== undefined) {
        try {
          const root = join(scope.checkout, s.static);
          await startStaticServe({ id: unit, root, port: port! });
          return { result: "done", detail: `serving ${root} on 127.0.0.1:${port}` };
        } catch (err) {
          if (err instanceof StaticServeError && err.code === "port-taken") this.preflight(def, scope, s);
          throw new VerbFailure("start-failed", err instanceof Error ? err.message : String(err), { service: s.name });
        }
      }
      this.preflight(def, scope, s);
      await this.removeContainer(def, scope, s);
      const vars = this.vars(def, scope);
      try {
        await this.driver.start({ unit, argv: s.cmd!.map((a) => render(a, vars)), cwd: join(scope.checkout, s.cwd), env: this.env(def, scope, { service: s }) });
      } catch (err) {
        throw new VerbFailure("start-failed", err instanceof DriverError ? err.message : String(err), { service: s.name });
      }
      return { result: "done", detail: unit };
    });
    await this.waitReady(run, def, scope, s, unit);
  }

  private async stopService(run: Run, def: ProjectDef | null, scope: Scope, name: string, s?: ServiceDecl): Promise<void> {
    const unit = this.unitOf(scope.id, name);
    await this.step(run, `stop:${name}`, "stop", async () => {
      if (staticServes().some((x) => x.id === unit)) {
        await stopStaticServe(unit);
        return { result: "done", detail: "static serve stopped" };
      }
      const st = await this.driver.status(unit);
      const had = st.state !== "missing";
      if (had) await this.driver.stop(unit);
      if (s?.container && def) await this.removeContainer(def, scope, s);
      if (had && s && def) await this.portsReleased(def, scope, s);
      return had && st.state !== "inactive" ? { result: "done", detail: unit } : { result: "skipped" };
    });
  }

  /**
   * After stopping its own process, wait (at most 5 s) until the service's ports have no listener:
   * a socket can outlive its process by a moment, and a start right after would take it for a
   * foreign holder.
   */
  private async portsReleased(def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<void> {
    const ports = Object.values(this.allPorts(def, scope)[s.name] ?? {});
    const until = Date.now() + 5_000;
    while (ports.some((p) => this.portOwner(p) !== "none") && Date.now() < until) await sleep(50);
  }

  /** Bring the project's shared services `names` up, one caller at a time per project. */
  private async upShared(run: Run, def: ProjectDef, names: ServiceDecl[]): Promise<void> {
    if (!names.length) return;
    const project = run.project!;
    const prev = this.sharedChain.get(project) ?? Promise.resolve();
    const job = prev.catch(() => undefined).then(async () => {
      const scope = this.sharedScope(def, project);
      mutateRegistry((r) => {
        let sh = r.shared.find((x) => x.project === project);
        if (!sh) {
          sh = { project, id: scope.id, desired: {}, ports: {} } satisfies SharedRecord;
          r.shared.push(sh);
        }
        for (const s of names) {
          sh.desired[s.name] = "running";
          sh.ports[s.name] = portsFor(def, 0)[s.name] ?? {};
        }
      });
      for (const s of names) {
        const unit = this.unitOf(scope.id, s.name);
        const a = await this.isActive(unit, s);
        if (a.active && (await this.probe(def, scope, s, unit)).ok) {
          run.steps.push({ id: `start:${s.name}`, kind: "start", result: "skipped", ms: 0, detail: `shared, ready (pid ${a.pid})` });
          continue;
        }
        if (a.active) await this.waitReady(run, def, scope, s, unit);
        else await this.startService(run, def, scope, s);
      }
    });
    this.sharedChain.set(project, job);
    await job;
  }

  // ---- verbs -------------------------------------------------------------------------------------------

  private async up(run: Run): Promise<void> {
    const rec = run.rec ?? (await this.create(run));
    run.rec = rec;
    const def = this.need(run);
    await this.supervised(def);
    const names = run.req.services?.length ? run.req.services : def.services.filter((s) => s.scope === "checkout").map((s) => s.name);
    for (const n of names) if (!def.services.some((s) => s.name === n)) throw new VerbFailure("invalid-request", `no service "${n}"`);
    const wanted = closureOf(def, names);
    await this.upShared(run, def, wanted.filter((s) => s.scope === "shared"));
    const scope = scopeOf(rec);
    const own = wanted.filter((s) => s.scope === "checkout");
    const anyRunning = (await Promise.all(def.services.filter((s) => s.scope === "checkout").map((s) => this.isActive(this.unitOf(rec.id, s.name), s)))).some((a) => a.active);
    let bumped = false;
    for (const s of own) {
      rec.desired[s.name] = "running";
      this.save(rec);
      const unit = this.unitOf(rec.id, s.name);
      const a = await this.isActive(unit, s);
      if (a.active) {
        const p = await this.probe(def, scope, s, unit);
        if (p.ok) {
          run.steps.push({ id: `start:${s.name}`, kind: "start", result: "skipped", ms: 0, detail: `ready (pid ${a.pid})` });
          continue;
        }
        await this.waitReady(run, def, scope, s, unit);
        continue;
      }
      if (!anyRunning && !bumped) {
        bumped = true;
        rec.generation += 1;
        this.save(rec);
      }
      await this.startService(run, def, scope, s);
    }
  }

  private async down(run: Run): Promise<void> {
    const rec = run.rec!;
    const def = run.def;
    await this.supervised(def);
    const known = def ? serviceOrder(def) : Object.keys(rec.desired).map((name) => ({ name, scope: "checkout" }) as ServiceDecl);
    const names = run.req.services?.length ? run.req.services : known.filter((s) => s.scope === "checkout").map((s) => s.name);
    for (const n of names) if (!known.some((s) => s.name === n)) throw new VerbFailure("invalid-request", `no service "${n}"`);
    const order = [...known].reverse().filter((s) => names.includes(s.name));
    for (const s of order) {
      if (s.scope === "shared") {
        await this.stopService(run, def, this.sharedScope(def!, rec.project), s.name, s);
        mutateRegistry((r) => {
          const sh = r.shared.find((x) => x.project === rec.project);
          if (sh) sh.desired[s.name] = "stopped";
        });
        continue;
      }
      rec.desired[s.name] = "stopped";
      this.save(rec);
      await this.stopService(run, def, scopeOf(rec), s.name, s);
    }
  }

  private async apply(run: Run): Promise<void> {
    const rec = run.rec!;
    const def = this.need(run);
    await this.supervised(def);
    const scope = scopeOf(rec);
    const names = run.req.services?.length ? run.req.services : def.services.filter((s) => s.scope === "checkout").map((s) => s.name);
    for (const n of names) if (!def.services.some((s) => s.name === n)) throw new VerbFailure("invalid-request", `no service "${n}"`);
    for (const s of serviceOrder(def).filter((x) => names.includes(x.name) && x.scope === "checkout")) {
      const unit = this.unitOf(rec.id, s.name);
      if (!(await this.isActive(unit, s)).active) {
        run.steps.push({ id: `reload:${s.name}`, kind: "reload", result: "skipped", ms: 0, detail: "not running (up starts it)" });
        continue;
      }
      if (s.build) {
        const b = s.build;
        await this.step(run, `build:${s.name}`, "build", async () => {
          const argv = b.run.map((a) => render(a, this.vars(def, scope)));
          const fp = this.fingerprint(scope, argv, b.inputs);
          if (rec.prints[`build:${s.name}`] === fp) return { result: "skipped", fingerprint: fp };
          await this.hook(def, scope, `build-${s.name}`, b.run, b.timeout, "apply", join(scope.checkout, s.cwd));
          rec.prints[`build:${s.name}`] = fp;
          this.save(rec);
          return { result: "done", fingerprint: fp };
        });
      }
      const how = run.req.restart && s.static === undefined ? "restart" : s.reload;
      if (how === "none") {
        run.steps.push({ id: `reload:${s.name}`, kind: "reload", result: "skipped", ms: 0, detail: s.static !== undefined ? "static files are live" : "reload is none" });
        continue;
      }
      await this.step(run, `reload:${s.name}`, "reload", async () => {
        if (how === "restart") {
          await this.driver.stop(unit);
          await this.removeContainer(def, scope, s);
          await this.portsReleased(def, scope, s);
          this.preflight(def, scope, s);
          const vars = this.vars(def, scope);
          await this.driver.start({ unit, argv: s.cmd!.map((a) => render(a, vars)), cwd: join(scope.checkout, s.cwd), env: this.env(def, scope, { service: s }) });
          return { result: "done", detail: "restarted" };
        }
        if ("signal" in how) {
          await this.driver.signal(unit, how.signal);
          return { result: "done", detail: `SIG${how.signal}` };
        }
        await this.hook(def, scope, `reload-${s.name}`, how.cmd, 120, "apply", join(scope.checkout, s.cwd));
        return { result: "done", detail: "reload command" };
      });
      await this.waitReady(run, def, scope, s, unit);
    }
  }

  private async reset(run: Run): Promise<void> {
    const rec = run.rec!;
    const def = this.need(run);
    await this.supervised(def);
    const only = run.req.resources;
    for (const n of only ?? []) if (!def.data.some((d) => d.name === n)) throw new VerbFailure("invalid-request", `no data resource "${n}"`);
    if (!def.data.length) {
      run.steps.push({ id: "data", kind: "data", result: "skipped", ms: 0, detail: "no data declared" });
      return;
    }
    const checkoutSvcs = def.services.filter((s) => s.scope === "checkout");
    const running: string[] = [];
    for (const s of checkoutSvcs) if ((await this.isActive(this.unitOf(rec.id, s.name), s)).active) running.push(s.name);
    for (const s of [...serviceOrder(def)].reverse().filter((x) => running.includes(x.name))) await this.stopService(run, def, scopeOf(rec), s.name, s);
    for (const d of def.data) {
      if (only && !only.includes(d.name)) continue;
      await this.step(run, `deprovision:${d.name}`, "data", async () => {
        await this.deprovisionOne(def, rec, d.name);
        return { result: "done" };
      });
    }
    await this.provision(run, def, rec, true, only);
    if (running.length) {
      const scope = scopeOf(rec);
      for (const s of closureOf(def, running).filter((x) => x.scope === "checkout")) await this.startService(run, def, scope, s);
    }
  }

  private async teardown(run: Run): Promise<void> {
    const rec = run.rec;
    if (!rec) return;
    if (rec.slot === 0) throw new VerbFailure("refused-slot0", "slot 0 is the main checkout: teardown never removes it");
    const def = run.defError ? null : run.def;
    const hookData = def?.data.some((d) => d.kind === "hook" && rec.data[d.name]) ?? false;
    if (hookData && !run.approved && !run.req.keepData) this.need(run);
    await this.down(run);
    if (!run.req.keepData) {
      for (const name of Object.keys(rec.data))
        await this.step(run, `deprovision:${name}`, "data", async () => {
          await this.deprovisionOne(def, rec, name);
          return { result: "done" };
        });
      rmSync(dataRootOf(rec.id), { recursive: true, force: true });
    } else if (Object.keys(rec.data).length) run.steps.push({ id: "data", kind: "data", result: "skipped", ms: 0, detail: `kept: ${Object.values(rec.data).join(", ")}` });
    if (rec.cutWorktree && existsSync(rec.checkout)) {
      await this.step(run, "worktree", "worktree", async () => {
        const r = await this.git(["worktree", "remove", "--", rec.checkout], rec.project);
        if (r.code !== 0) return { result: "skipped", detail: `kept ${rec.checkout}: ${firstLine(r.stderr || r.stdout)}` };
        return { result: "done", detail: `removed ${rec.checkout} (branch ${rec.branch} kept)` };
      });
    }
    await this.step(run, "slot", "slot", async () => {
      mutateRegistry((r) => {
        r.instances = r.instances.filter((i) => i.id !== rec.id);
      });
      return { result: "done", detail: `slot ${rec.slot} freed` };
    });
    run.rec = null;
    (run as Run & { tornDown?: InstanceRecord }).tornDown = rec;
  }

  private async status(run: Run): Promise<void> {
    if (run.rec || run.req.instance) return;
    // A whole project: every instance.
    const reg = readRegistry();
    const out: InstanceSummary[] = [];
    for (const rec of reg.instances.filter((i) => i.project === run.project)) {
      const sub: Run = { ...run, rec, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
      this.loadDefinition(sub, rec.checkout);
      const services = await this.observe(sub);
      out.push({ instance: rec.id, slot: rec.slot, generation: rec.generation, checkout: rec.checkout, branch: rec.branch, state: this.stateOf(sub, services), services, createdBy: rec.createdBy });
    }
    out.sort((a, b) => a.slot - b.slot);
    run.extra.instances = out;
  }

  private async logs(run: Run): Promise<void> {
    const rec = run.rec!;
    const lines = Math.min(Math.max(run.req.lines ?? 100, 1), 500);
    const names = run.req.services?.length ? run.req.services : run.def ? run.def.services.filter((s) => s.scope === "checkout").map((s) => s.name) : Object.keys(rec.desired);
    const out: LogLine[] = [];
    for (const n of names) for (const l of await this.driver.logs(this.unitOf(rec.id, n), lines)) out.push({ t: l.t, service: n, text: l.text });
    // Oldest first: by time where the driver has it, else each service's own order.
    const stable = out.map((l, i) => ({ l, i }));
    stable.sort((a, b) => (a.l.t && b.l.t ? a.l.t.localeCompare(b.l.t) : 0) || a.i - b.i);
    run.extra.lines = stable.map((x) => x.l).slice(-lines);
  }

  private async doctor(run: Run): Promise<void> {
    const checks: Check[] = [];
    const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
    add("definition", !run.defError && !!run.def, run.defError ? run.defError.message : run.def ? `valid (${run.defHash})` : `no ${CONTRACT_FILE}`);
    add("approved", run.approved, run.approved ? "approved on this host" : `not approved: ${run.defHash ?? "no definition"}`);
    const needsProcess = !!run.def && runsProcesses(run.def);
    const drv = await this.driver.available();
    add("supervisor", drv.ok || !needsProcess, `${this.driver.id}: ${drv.detail}`);
    if (run.def) {
      const def = run.def;
      const programs = new Set<string>();
      for (const s of def.services) if (s.cmd) programs.add(s.cmd[0]!);
      for (const st of def.setup) programs.add(st.run[0]!);
      for (const s of def.services) if (s.container) programs.add(s.container.engine);
      for (const p of programs) {
        if (p.includes("${")) continue;
        const found = p.includes("/") ? existsSync(isAbsolute(p) ? p : join(run.rec?.checkout ?? run.project!, p)) : (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, p)));
        add(`program:${p}`, found, found ? "found" : `${p} is not on the server's PATH`);
      }
      const hv = hostVars(run.project!);
      for (const h of def.host) add(`host:${h}`, h in hv, h in hv ? "set" : `set it in ${CONTRACT_FILE}'s host overlay (<state root>/project-services/host.json)`);
      const scope: Scope = run.rec ? scopeOf(run.rec) : { id: "doctor", project: run.project!, checkout: run.project!, branch: null, slot: 0, ports: {}, data: {} };
      for (const d of def.data)
        if (d.kind === "dir" && d.from !== "empty") {
          const src = render(d.from, this.vars(def, scope));
          add(`data:${d.name}`, existsSync(src), existsSync(src) ? `${src} exists` : `${src} doesn't exist`);
        }
      if (run.rec) {
        for (const s of def.services) {
          const unit = this.unitOf(s.scope === "shared" ? sharedIdOf(run.project!) : run.rec.id, s.name);
          for (const [k, port] of Object.entries(this.allPorts(def, scope)[s.name] ?? {})) {
            const o = this.portOwner(port);
            const own = o === "none" || (typeof o === "object" && (s.static !== undefined ? o.pid === process.pid : this.driver.owns(unit, o.pid)));
            add(`port:${s.name}.${k}`, own, o === "none" ? `${port} free` : own ? `${port} held by its own process` : `${port} held by ${o === "unknown" ? "an unreadable process" : `pid ${o.pid} (${o.cwd})`}`);
          }
        }
      }
    }
    run.extra.checks = checks;
  }

  // ---- observing -------------------------------------------------------------------------------------

  /** Every service of the instance as it is now. */
  async observe(run: Run): Promise<ServiceView[]> {
    const rec = run.rec;
    if (!rec) return [];
    const def = run.def;
    if (!def) {
      const out: ServiceView[] = [];
      for (const name of Object.keys(rec.desired)) {
        const unit = this.unitOf(rec.id, name);
        const st = await this.driver.status(unit);
        out.push({ name, scope: "checkout", kind: "process", state: st.state === "active" ? "degraded" : st.state === "failed" ? "failed" : "stopped", unit, pid: st.pid, ports: rec.ports[name] ?? {}, detail: "definition unreadable" });
      }
      return out;
    }
    const out: ServiceView[] = [];
    const scope = scopeOf(rec);
    for (const s of def.services) {
      const sc = s.scope === "shared" ? this.sharedScope(def, rec.project) : scope;
      const unit = this.unitOf(sc.id, s.name);
      const ports = this.allPorts(def, sc)[s.name] ?? {};
      const kind = this.kindOf(s);
      if (s.static !== undefined) {
        const serving = staticServes().some((x) => x.id === unit);
        out.push({ name: s.name, scope: s.scope, kind, state: serving ? "ready" : this.heldElsewhere(ports) ? "external" : "stopped", unit, pid: serving ? process.pid : null, ports, ...(serving ? { ready: { probe: "serve", ok: true, ms: 0 } } : {}) });
        continue;
      }
      const st = await this.driver.status(unit);
      if (st.state === "active" || st.state === "activating") {
        const p = await this.probe(def, sc, s, unit);
        out.push({ name: s.name, scope: s.scope, kind, state: p.ok ? "ready" : st.state === "activating" ? "starting" : "degraded", unit, pid: st.pid, ports, ready: p });
      } else {
        const state = st.state === "failed" ? "failed" : this.heldElsewhere(ports) ? "external" : "stopped";
        out.push({ name: s.name, scope: s.scope, kind, state, unit, pid: null, ports, ...(st.detail && st.state === "failed" ? { detail: st.detail } : {}) });
      }
    }
    return out;
  }

  private heldElsewhere(ports: Record<string, number>): boolean {
    return Object.values(ports).some((p) => this.portOwner(p) !== "none");
  }

  private stateOf(run: Run, services: ServiceView[]): InstanceState {
    const rec = run.rec;
    if (!rec) return "absent";
    const own = services.filter((s) => s.scope === "checkout");
    const desired = own.filter((s) => rec.desired[s.name] === "running");
    const active = own.filter((s) => s.state === "ready" || s.state === "starting" || s.state === "degraded");
    if (!desired.length) return active.length ? "degraded" : "stopped";
    return desired.every((s) => s.state === "ready") ? "running" : "degraded";
  }

  private dataViews(run: Run): DataView[] {
    const rec = run.rec;
    if (!rec || !run.def) return [];
    return run.def.data.map((d) => ({ name: d.name, kind: d.kind, ref: rec.data[d.name] ?? "", exists: this.dataExists(d, rec) }));
  }

  private async result(run: Run, failure?: VerbFailure): Promise<VerbResult> {
    const services = await this.observe(run).catch(() => []);
    const rec = run.rec;
    const gone = (run as Run & { tornDown?: InstanceRecord }).tornDown;
    const changed = run.steps.some((s) => s.result === "done" && s.kind !== "check" && s.kind !== "ready");
    const checksOk = run.extra.checks ? run.extra.checks.every((c) => c.ok) : true;
    return ordered({
      v: 1,
      verb: run.verb,
      project: run.project,
      instance: rec?.id ?? gone?.id ?? run.req.instance ?? null,
      slot: rec?.slot ?? null,
      generation: rec?.generation ?? null,
      checkout: rec?.checkout ?? gone?.checkout ?? null,
      branch: rec?.branch ?? gone?.branch ?? null,
      ok: !failure && checksOk,
      changed,
      state: this.stateOf(run, services),
      steps: run.steps,
      services,
      data: this.dataViews(run),
      links: [],
      ...run.extra,
      ...(failure ? { error: { code: failure.code, message: failure.message, ...failure.extra } } : {}),
      defHash: run.defHash,
      approved: run.approved,
      at: new Date().toISOString(),
    });
  }

  // ---- conformance helpers ----------------------------------------------------------------------------

  /** The instance with its definition loaded (no verb, no lock). */
  private bare(rec: InstanceRecord): Run {
    const run: Run = { verb: "status", caller: { kind: "operator" }, req: {}, project: rec.project, rec, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
    this.loadDefinition(run, rec.checkout);
    return run;
  }

  /** Run every setup step of `id` once more, ignoring fingerprints: null when each exited 0, else why not. */
  async rerunSetup(id: string): Promise<string | null> {
    const rec = readRegistry().instances.find((i) => i.id === id);
    if (!rec) return `no instance ${id}`;
    const run = this.bare(rec);
    if (!run.def) return "definition unreadable";
    for (const s of run.def.setup) {
      try {
        await this.hook(run.def, scopeOf(rec), `setup-${s.id}`, s.run, s.timeout, "conform");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    return null;
  }

  /** The `probe` hook in `rec`'s scope with `args` (`write <token>`, `read <token>`): its exit code, or null without a probe. */
  async probeHook(rec: InstanceRecord, args: string[]): Promise<number | null> {
    const run = this.bare(rec);
    const probe = run.def?.hooks.probe;
    if (!run.def || !probe) return null;
    const scope = scopeOf(rec);
    const vars = this.vars(run.def, scope);
    const r = await this.driver.runOnce({
      unit: this.hookUnitOf(scope.id, "probe"),
      argv: [...probe.run.map((a) => render(a, vars)), ...args],
      cwd: scope.checkout,
      env: this.env(run.def, scope, { verb: "conform", step: "probe" }),
      timeoutSec: probe.timeout,
    });
    return r.timedOut ? -1 : r.code;
  }

  /** Container names `rec`'s definition gives its services (for leak checks). */
  containersOf(rec: InstanceRecord): { engine: string; name: string }[] {
    const run = this.bare(rec);
    if (!run.def) return [];
    const vars = this.vars(run.def, scopeOf(rec));
    return run.def.services.filter((s) => s.container && s.scope === "checkout").map((s) => ({ engine: s.container!.engine, name: render(s.container!.name, vars) }));
  }

  // ---- reconcile (§app.project-services/reconcile) ------------------------------------------------------

  /** Bring every instance back to its desired state after a server start. Returns what it did. */
  async reconcile(): Promise<string[]> {
    const did: string[] = [];
    const reg = readRegistry();
    const touched = new Set<string>();
    for (const rec of reg.instances) {
      const want = Object.entries(rec.desired);
      if (!want.length) continue;
      const lock = tryLock(instanceLockFile(rec.project, rec.checkout));
      if ("heldBy" in lock) continue;
      try {
        const run: Run = { verb: "up", caller: { kind: "operator" }, req: {}, project: rec.project, rec, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
        this.loadDefinition(run, rec.checkout);
        if (!run.def || !run.approved) {
          did.push(`${rec.id}: left alone (${run.defError ? "definition invalid" : "definition not approved"})`);
          continue;
        }
        const def = run.def;
        const scope = scopeOf(rec);
        // A start from nothing is a new generation, whoever starts it.
        const own = def.services.filter((x) => x.scope === "checkout");
        const anyActive = (await Promise.all(own.map((s) => this.isActive(this.unitOf(rec.id, s.name), s)))).some((a) => a.active);
        const due = own.some((s) => rec.desired[s.name] === "running");
        if (!anyActive && due) {
          rec.generation += 1;
          this.save(rec);
        }
        for (const s of serviceOrder(def).filter((x) => x.scope === "checkout")) {
          const unit = this.unitOf(rec.id, s.name);
          const a = await this.isActive(unit, s);
          if (rec.desired[s.name] === "running" && !a.active) {
            if (s.scope === "checkout") for (const r of s.requires) touched.add(`${rec.project}\0${r}`);
            try {
              await this.startService(run, def, scope, s);
              did.push(`${rec.id}: started ${s.name}`);
            } catch (err) {
              did.push(`${rec.id}: ${s.name} failed to start (${err instanceof Error ? err.message : String(err)})`);
            }
          } else if (rec.desired[s.name] !== "running" && a.active) {
            await this.stopService(run, def, scope, s.name, s);
            did.push(`${rec.id}: stopped ${s.name}`);
          }
        }
      } finally {
        lock.release();
      }
    }
    for (const sh of reg.shared) {
      const run: Run = { verb: "up", caller: { kind: "operator" }, req: {}, project: sh.project, rec: null, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
      this.loadDefinition(run, sh.project);
      if (!run.def || !run.approved) continue;
      const names = run.def.services.filter((s) => s.scope === "shared" && sh.desired[s.name] === "running");
      try {
        await this.upShared(run, run.def, names);
        if (run.steps.some((s) => s.result === "done")) did.push(`${sh.id}: started shared services`);
      } catch (err) {
        did.push(`${sh.id}: shared services failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return did;
  }
}
