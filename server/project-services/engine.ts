import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  adoptedService,
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
  scratchSlots as scratchSlotsOf,
  selectorsProblem,
  serviceOrder,
  FAILURE_MESSAGE_MAX,
  FAILURES_MAX,
  type AnyVerb,
  type Check,
  type DataDecl,
  type DataView,
  type ErrorCode,
  type InstanceState,
  type InstanceSummary,
  type LinkView,
  type LogLine,
  type ProjectDef,
  type ServiceDecl,
  type ServiceView,
  type Step,
  type StepKind,
  type TestFailure,
  type TestsReport,
  type VerbResult,
} from "../../shared/project-contract";
import type { PortOwner } from "../port-owner";
import { startStaticServe, staticServes, StaticServeError, stopStaticServe } from "../preview-serve";
import { projectOf } from "../project-root";
import { confinementOf, type Confinement } from "./confine";
import { copyContentsArgv } from "./copy-tree";
import { adoptedStatus, cgroupPids, DriverError, rssOf, SystemdDriver, type AdoptedStatus, type Driver, type OnceSpec, type UnitSpec } from "./drivers";
import { hostPortOwner } from "./proctable";
import type { NoteFacts } from "./note";
import { hostedBusy, restartGateLog, RESTART_DELAY_SEC, scheduleRestart, serverCheckout, serverStart } from "./self-host";
import { checkShare, instanceOfLink, linksOf, OVERSEER_SHARE_REFUSAL, revokeLinks, ShareFailure, shareInstance, shareRefusal } from "./share";
import { publishedPorts, publisherOf, type ContainerQuery } from "./container-ports";
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
  /** `act`: its project statechart's act for a verb that is not a read (§app.project-overseer/tools), which holds the
      level; the engine checks none. */
  | { kind: "project-overseer"; id: string; root: string; act: VerbAct }
  | { kind: "session"; id: string; root: string | null; own: string[] }
  /** `confine`: a confined run (§app.project-services/confined): the instances it makes run inside it, unapproved. */
  | { kind: "conform"; id: string; confine?: Confinement }
  /** Sova itself, on no one's request: `on-merge` reloads the main checkout's copy when main moves (§app.project-services/on-merge). Apply only. */
  | { kind: "system"; id: string };

/**
 * Resolves once the project statechart took the verb's act; throws its refusal otherwise. `share`'s act
 * (`services/share`, people-facing) may be held, or taken with its effect already minting the link
 * (§app.project-services/share): it says which.
 */
export type VerbAct = (verb: AnyVerb, instance: string | null, detail?: { endpoint: string; days?: number }) => Promise<void | VerbActOutcome>;
export type VerbActOutcome = { held: string } | { done: { id: string } };

/** A statechart's refusal of the project overseer's act: passed through to the tool as it was thrown, never a result. */
class ActRefused extends Error {
  constructor(readonly refusal: unknown) {
    super("act refused");
  }
}

/** The project overseer's act for `verb`, after the engine's own checks and before anything changes. */
export async function actFor(caller: Caller, verb: AnyVerb, instance: string | null, detail?: { endpoint: string; days?: number }): Promise<void | VerbActOutcome> {
  // revoke only takes something away: no act, never held (§app.project-services/share).
  if (caller.kind !== "project-overseer" || (READ_VERBS as readonly string[]).includes(verb) || verb === "revoke") return;
  try {
    return await caller.act(verb, instance, detail);
  } catch (err) {
    throw new ActRefused(err);
  }
}

/** Rethrow a statechart's refusal as it was thrown. */
export function passRefusal(err: unknown): void {
  if (err instanceof ActRefused) throw err.refusal;
}

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
  /** test: the selectors appended to the test command (none: the whole suite). */
  select?: string[];
  /** share/revoke: the endpoint, `<service>.<port>`. */
  endpoint?: string;
  /** share: how many days the link lasts. */
  days?: number;
  /** revoke: one link, by id. */
  link?: string;
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
  select: "strings",
  endpoint: "string",
  days: "number",
  link: "string",
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

/**
 * A test runner's `SOVA_OUT` (§app.project-services/test): counts when it wrote numeric `passed` and `failed`,
 * with optional `errors`, `skipped` and `failures` (at most 50, each message cut to 2000); null otherwise.
 */
export function readTestOut(file: string): { passed: number; failed: number; errors: number; skipped: number; failures: TestFailure[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const passed = n(o.passed);
  const failed = n(o.failed);
  if (passed === null || failed === null) return null;
  const failures: TestFailure[] = [];
  for (const f of Array.isArray(o.failures) ? o.failures : []) {
    if (failures.length >= FAILURES_MAX) break;
    if (!f || typeof f !== "object" || typeof (f as { name?: unknown }).name !== "string") continue;
    const x = f as Record<string, unknown>;
    failures.push({
      name: String(x.name).slice(0, 500),
      ...(typeof x.message === "string" ? { message: x.message.slice(0, FAILURE_MESSAGE_MAX) } : {}),
      ...(typeof x.file === "string" ? { file: x.file.slice(0, 500) } : {}),
      ...(n(x.line) !== null ? { line: n(x.line)! } : {}),
    });
  }
  return { passed, failed, errors: n(o.errors) ?? 0, skipped: n(o.skipped) ?? 0, failures };
}

// ---- the engine -----------------------------------------------------------------------------------

export interface EngineDeps {
  driver: Driver;
  git?: GitRun;
  portOwner?: (port: number) => PortOwner;
  /** Run a container engine command (`docker rm -f …`); tests fake it. */
  containerExec?: (engine: string, args: string[]) => Promise<number>;
  /** Ask a container engine (`docker port …`, `inspect`, `ps`) and read its output; tests fake it. */
  containerQuery?: ContainerQuery;
  /** Poll interval for readiness waits. */
  pollMs?: number;
  /** The checkout the running server was loaded from (§app.project-services/self-host); tests set it. */
  selfCheckout?: () => string | null;
  /** Why this server's hosted sessions are busy, or null; tests fake it. */
  hostBusy?: () => string | null;
  /** The registered project whose root this is, or null (§app.project-services/share); tests fake it. */
  projectIdOf?: (root: string) => Promise<string | null>;
  /** Every port this Sova process binds or names (server/project-previews.ts sovaPorts); tests fake it. */
  sovaPorts?: () => Promise<ReadonlySet<number>>;
  /** An adopted unit's status, read only (§app.project-services/adopt); tests fake it. */
  adoptedStatus?: (unit: string) => Promise<AdoptedStatus>;
  /** Schedule an adopted unit's gated restart: null when scheduled, else why not; tests fake it. */
  scheduleRestart?: (unit: string, mainPid: number | null) => Promise<string | null>;
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
  extra: Partial<Pick<VerbResult, "instances" | "lines" | "checks" | "conform" | "tests" | "links">>;
  /** The caller's abort (a cancelled tool call): a test run is stopped with it. */
  signal?: AbortSignal;
}

/** Who holds a port, as one service sees it: nobody, its own, or someone it must not touch. */
/** `unreadable`: held by a listener this user can't read and no container claims (root's docker-proxy reads so): not provably foreign. */
export type PortClaim = { held: false } | { held: true; own: boolean; who: string; unreadable?: true };

/** The scope a process runs in: an instance, or the project's shared services. */
interface Scope {
  id: string;
  project: string;
  checkout: string;
  branch: string | null;
  slot: number;
  ports: Record<string, Record<string, number>>;
  data: Record<string, string>;
  /** Its confined run, or "ended" when the run it belongs to is over (nothing of it may start). */
  confine: Confinement | "ended" | null;
  /** The project's shared services' scope. */
  shared?: boolean;
}

/** Whether a definition runs any process (a cmd service, a setup step, a data or probe hook), rather than only static folders. */
const runsProcesses = (def: ProjectDef) => def.services.some((s) => s.static === undefined) || def.setup.length > 0 || def.data.some((d) => d.kind === "hook") || !!def.hooks.probe;

const scopeOf = (rec: InstanceRecord): Scope => ({
  id: rec.id,
  project: rec.project,
  checkout: rec.checkout,
  branch: rec.branch,
  slot: rec.slot,
  ports: rec.ports,
  data: rec.data,
  confine: rec.confined ? (confinementOf(rec.confined) ?? "ended") : null,
});

/** The confined run a caller acts in, if any. */
const confineOf = (c: Caller): Confinement | null => (c.kind === "conform" && c.confine ? c.confine : null);

export class ProjectEngine {
  readonly driver: Driver;
  private readonly git: GitRun;
  /** Who listens on a port of this host (conform reads it too). */
  readonly portOwner: (port: number) => PortOwner;
  private readonly containerExec: (engine: string, args: string[]) => Promise<number>;
  private readonly containerQuery: ContainerQuery;
  private readonly pollMs: number;
  private readonly selfCheckout: () => string | null;
  private readonly hostBusy: () => string | null;
  private readonly projectIdOf: (root: string) => Promise<string | null>;
  private readonly sovaPorts: () => Promise<ReadonlySet<number>>;
  private readonly adoptedStatus: (unit: string) => Promise<AdoptedStatus>;
  private readonly scheduleRestart: (unit: string, mainPid: number | null) => Promise<string | null>;
  private sharedChain = new Map<string, Promise<unknown>>();
  /** The conformance runner (server/project-services/conform.ts), wired at startup. */
  conformer: ((body: unknown, caller: Caller) => Promise<VerbResult>) | null = null;

  constructor(deps: EngineDeps) {
    this.driver = deps.driver;
    this.git = deps.git ?? realGit;
    this.portOwner = deps.portOwner ?? ((p) => hostPortOwner(p));
    this.containerExec =
      deps.containerExec ??
      ((engine, args) =>
        new Promise((done) => {
          execFile(engine, args, { timeout: 60_000 }, (err) => done(err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127) : 0));
        }));
    this.containerQuery =
      deps.containerQuery ??
      ((engine, args) =>
        new Promise((done) => {
          execFile(engine, args, { timeout: 30_000, encoding: "utf8" }, (err, stdout) =>
            done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127) : 0, stdout: String(stdout ?? "") }),
          );
        }));
    this.pollMs = deps.pollMs ?? 250;
    this.selfCheckout = deps.selfCheckout ?? serverCheckout;
    this.hostBusy = deps.hostBusy ?? (() => hostedBusy());
    this.projectIdOf =
      deps.projectIdOf ??
      (async (root) => {
        const { listProjects } = await import("../projects/spaces");
        return listProjects().find((p) => p.root === root)?.id ?? null;
      });
    this.sovaPorts = deps.sovaPorts ?? (async () => (await import("../project-previews")).sovaPorts());
    this.adoptedStatus = deps.adoptedStatus ?? ((unit) => adoptedStatus(unit));
    this.scheduleRestart = deps.scheduleRestart ?? ((unit, pid) => scheduleRestart(unit, pid));
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

  /** `spec` as it runs in `scope`: as it is, or inside the scope's confined run (§app.project-services/confined). */
  private async inScope<T extends UnitSpec>(scope: Scope, spec: T): Promise<T> {
    const c = scope.confine;
    if (!c) return spec;
    if (c === "ended") throw new VerbFailure("not-approved", `${scope.id} belonged to a confined conformance run that has ended: nothing of it starts again`);
    // Its own writable state: the checkout and data dir (a shared service's: a data dir of the run's own, never the main checkout).
    const dataDir = dataRootOf(scope.id);
    mkdirSync(dataDir, { recursive: true });
    try {
      const w = await c.wrap({ argv: spec.argv, cwd: spec.cwd, env: spec.env, checkout: scope.shared ? dataDir : scope.checkout, dataDir, tmpKey: scope.id });
      c.units.add(spec.unit);
      return { ...spec, argv: w.argv, env: w.env };
    } catch (err) {
      throw new VerbFailure("start-failed", `confining ${spec.unit} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Who listens on `port` as `s` in `scope` sees it: inside its confined run, or on this host (a static service is served here). */
  private ownerIn(scope: Scope, s?: ServiceDecl): (port: number) => PortOwner {
    const c = scope.confine;
    if (c && c !== "ended" && s?.static === undefined) return (p) => c.portOwner(p);
    return this.portOwner;
  }

  // ---- entry --------------------------------------------------------------------------------------

  /** Run one verb for `caller`. Every outcome is a result, but the project overseer's refused act, which throws as the statechart refused it. */
  async run(verb: string, body: unknown, caller: Caller, opts: { signal?: AbortSignal } = {}): Promise<VerbResult> {
    const run: Run = { verb: (isVerb(verb) ? verb : "status") as AnyVerb, caller, req: {}, project: null, rec: null, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {}, ...(opts.signal ? { signal: opts.signal } : {}) };
    let release: (() => void) | null = null;
    if (verb === "conform" && this.conformer) return this.conformer(body, caller);
    try {
      if (!isVerb(verb)) throw new VerbFailure("invalid-request", `unknown verb "${verb}"`);
      run.req = parseRequest(body);
      if ((RESERVED_VERBS as readonly string[]).includes(verb)) throw new VerbFailure("unsupported", `${verb} is reserved and not supported yet`);
      await this.resolveTarget(run);
      if (run.verb === "teardown" && !run.rec) return await this.result(run);
      this.authorize(run);
      // Every check a share makes runs before its act: a refused share never reaches the statechart.
      if (run.verb === "share") await this.shareChecks(run);
      const outcome = await actFor(caller, run.verb, run.rec?.id ?? null, run.verb === "share" ? { endpoint: run.req.endpoint!, ...(run.req.days !== undefined ? { days: run.req.days } : {}) } : undefined);
      if (outcome && "held" in outcome) {
        run.steps.push({ id: "share", kind: "link", result: "skipped", ms: 0, detail: outcome.held });
        return await this.result(run);
      }
      if (outcome && "done" in outcome) {
        // The act's effect made the link (shareFromAct): read back, never made twice.
        run.extra.links = linksOf(run.rec!.id, { withUrl: false }).filter((l) => l.id === outcome.done.id);
        run.steps.push({ id: "share", kind: "link", result: "done", ms: 0, detail: `shared ${run.req.endpoint}` });
        return await this.result(run);
      }
      if (!(READ_VERBS as readonly string[]).includes(verb) && verb !== "conform" && verb !== "revoke") {
        const lock = tryLock(instanceLockFile(run.project!, this.targetKey(run)));
        if ("heldBy" in lock) throw new VerbFailure("busy", `another verb is running on this instance (pid ${lock.heldBy}); try again when it ends`);
        release = lock.release;
        // Re-read under the lock: the holder before us may have changed it.
        if (run.rec) run.rec = readRegistry().instances.find((i) => i.id === run.rec!.id) ?? null;
      }
      await this.dispatch(run);
      return await this.result(run);
    } catch (err) {
      passRefusal(err);
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
    if (run.verb === "revoke" && req.link) {
      const of = instanceOfLink(req.link);
      if (!of) throw new VerbFailure("not-found", `no share link ${req.link}`);
      if (req.instance && req.instance !== of) throw new VerbFailure("not-found", `share link ${req.link} is not ${req.instance}'s`);
      req.instance = of;
    }
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
      if (run.verb === "create" || run.verb === "up" || run.verb === "test") {
        const target = await this.targetCheckout(run);
        (run as Run & { target?: string }).target = target.checkout;
        run.rec = reg.instances.find((i) => i.project === run.project && i.checkout === target.checkout) ?? null;
      } else if (["down", "apply", "reset", "teardown", "logs", "share", "revoke"].includes(run.verb)) {
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
    if (!d.ok) throw new VerbFailure("unsupported", `${d.detail}: this host can't run a project's processes`);
  }

  /** A confined run acting on its own instances (or making one), which run unapproved, only inside it (§app.project-services/confined). */
  private confinedRun(run: Run): boolean {
    const c = confineOf(run.caller);
    return !!c && (!run.rec || run.rec.confined === c.runId);
  }

  /** The definition, valid and approved, or the refusal. */
  private need(run: Run, approved = true): ProjectDef {
    if (run.defError) throw new VerbFailure("invalid-definition", run.defError.message);
    if (!run.def) throw new VerbFailure("invalid-definition", `no ${CONTRACT_FILE}`);
    if (approved && !run.approved && !this.confinedRun(run))
      throw new VerbFailure("not-approved", `this definition (${run.defHash}) is not approved on this host: the operator approves it (sova-project approve --project ${run.project} --def-hash ${run.defHash})`);
    return run.def;
  }

  // ---- who may call what (§app.project-services/callers) --------------------------------------------

  /**
   * Sova hosting itself (§app.project-services/self-host): on the server's own checkout, a verb that
   * stops or restarts slot 0 is the operator's, confirmed, and never while a hosted session is busy.
   */
  private selfHosted(run: Run): void {
    this.adoptedSlot0(run);
    const rec = run.rec;
    if (!rec || rec.slot !== 0 || !["apply", "down", "reset", "teardown"].includes(run.verb)) return;
    const self = this.selfCheckout();
    if (!self || self !== run.project || this.adoptedIn(run)) return;
    const what = `${run.verb} of the main checkout stops or restarts the Sova server's own checkout (${self})`;
    if (run.caller.kind !== "operator") throw new VerbFailure("needs-confirm", `${what}: the operator does it, confirmed (sova-project ${run.verb} … --confirm)`);
    if (!run.req.confirm) throw new VerbFailure("needs-confirm", `${what}: confirm it (sova-project ${run.verb} … --confirm)`);
    const busy = this.hostBusy();
    if (busy) throw new VerbFailure("busy", `${what}, and ${busy}: try again once they are idle`);
  }

  /** The service slot 0 adopts when `run` aims at slot 0 (its instance, or the main checkout before one exists), else null (§app.project-services/adopt). */
  private adoptedIn(run: Run): ServiceDecl | null {
    const s = run.def ? adoptedService(run.def) : null;
    if (!s) return null;
    const slot0 = run.rec ? run.rec.slot === 0 : (run as Run & { target?: string }).target === run.project;
    return slot0 ? s : null;
  }

  /**
   * An adopted slot 0 (§app.project-services/adopt): Sova never starts or stops its unit, so up, down,
   * reset and teardown are refused; apply, which schedules its restart, keeps the self-host rule for
   * every caller and project: the operator, confirmed, and never while a hosted session is busy.
   */
  private adoptedSlot0(run: Run): void {
    const s = this.adoptedIn(run);
    if (!s) return;
    const unit = s.adopt!.unit;
    if (["up", "down", "reset", "teardown"].includes(run.verb))
      throw new VerbFailure("refused-slot0", `slot 0's ${s.name} is the adopted unit ${unit}, which Sova never starts or stops: apply schedules its restart (the operator, confirmed)`);
    if (run.verb !== "apply") return;
    const what = `apply of slot 0 restarts the adopted unit ${unit}`;
    if (run.caller.kind !== "operator") throw new VerbFailure("needs-confirm", `${what}: the operator does it, confirmed (sova-project apply … --confirm, or Apply on the project's Branches tab)`);
    if (!run.req.confirm) throw new VerbFailure("needs-confirm", `${what}: confirm it (sova-project apply … --confirm)`);
    const busy = this.hostBusy();
    if (busy) throw new VerbFailure("busy", `${what}, and ${busy}: try again once they are idle`);
  }

  private authorize(run: Run): void {
    this.selfHosted(run);
    const { caller, verb } = run;
    const sharedNamed = verb === "down" && !!run.req.services?.length && !!run.def && run.req.services.some((n) => run.def!.services.find((s) => s.name === n)?.scope === "shared");
    const confirmShared = "stopping a shared service stops it for every instance of the project: the operator does it (sova-project down … --confirm)";
    // A copy with an active share link (§app.project-services/share): its down is confirmed, by the operator only.
    const linked = verb === "down" && !!run.rec ? linksOf(run.rec.id, { activeOnly: true }).length : 0;
    const confirmLinked = `this copy has ${linked} active share link${linked === 1 ? "" : "s"}, which will show the not-running page while it is down: the operator confirms it (sova-project down … --confirm), or revoke the link first`;
    if (verb === "share") {
      if (caller.kind === "operator" && !run.req.confirm)
        throw new VerbFailure("needs-confirm", "a share link lets anyone who has it use this copy as if they were on this computer: confirm it (sova-project share … --confirm)");
      if (caller.kind === "overseer") throw new VerbFailure("needs-confirm", OVERSEER_SHARE_REFUSAL);
      if (caller.kind === "session") throw new VerbFailure("forbidden", "a coding session never shares a copy: the operator does, from the project's Branches tab");
      if (caller.kind === "conform") throw new VerbFailure("forbidden", "conformance never shares a copy");
    }
    if (caller.kind === "operator") {
      if (sharedNamed && !run.req.confirm) throw new VerbFailure("needs-confirm", confirmShared);
      if (linked && !run.req.confirm) throw new VerbFailure("needs-confirm", confirmLinked);
      return;
    }
    if (caller.kind === "conform") return;
    if (caller.kind === "system") {
      if (verb !== "apply" && !(READ_VERBS as readonly string[]).includes(verb)) throw new VerbFailure("forbidden", `Sova runs only apply on its own (${caller.id}), never ${verb}`);
      return;
    }
    const project = run.project!;
    const read = (READ_VERBS as readonly string[]).includes(verb);
    if (caller.kind === "project-overseer" || caller.kind === "session") {
      if (caller.root !== project) throw new VerbFailure("forbidden", `this caller acts only on its own project${caller.root ? ` (${caller.root})` : ""}`);
    }
    if (read) return;
    const createdByCaller = !!run.rec && run.rec.createdBy === callerTag(caller);
    if (sharedNamed) throw new VerbFailure("needs-confirm", confirmShared);
    if (linked) throw new VerbFailure("needs-confirm", confirmLinked);
    if (caller.kind === "overseer") {
      if ((verb === "reset" || verb === "teardown") && run.rec && !createdByCaller)
        throw new VerbFailure("needs-confirm", `${verb} of an instance you did not create (${run.rec.createdBy}'s) is the operator's: ask them to run it`);
      return;
    }
    if (caller.kind === "project-overseer") {
      // Its level is its statechart's act (run() sends it once these checks pass).
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
      case "test":
        return this.test(run);
      case "share":
        return this.share(run);
      case "revoke":
        return this.revoke(run);
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
    const r = await this.driver.runOnce(await this.inScope(scope, spec));
    // The supervisor's own failure: the hook never ran, so it has no exit.
    if (r.launchError) throw new VerbFailure("hook-failed", `${stepId} could not be started: ${r.launchError}`, { step: stepId });
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

  /** `precheck` refuses a definition before anything is made (test: one that declares no test command). */
  private async create(run: Run, precheck?: (def: ProjectDef) => void): Promise<InstanceRecord> {
    const project = run.project!;
    if (run.rec) {
      const def = this.need(run);
      precheck?.(def);
      await this.supervised(def);
      await this.provisionUnlessAdopted(run, def, run.rec);
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
    precheck?.(def);
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
          ...(confineOf(run.caller) ? { confined: confineOf(run.caller)!.runId } : {}),
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
    await this.provisionUnlessAdopted(run, def, run.rec);
    return run.rec;
  }

  /** An adopted slot 0 runs no setup and no data step: its unit is set up outside Sova (§app.project-services/adopt). */
  private async provisionUnlessAdopted(run: Run, def: ProjectDef, rec: InstanceRecord): Promise<void> {
    const s = rec.slot === 0 ? adoptedService(def) : null;
    if (!s) return this.provision(run, def, rec, false);
    if (def.setup.length || def.data.length) run.steps.push({ id: "setup", kind: "setup", result: "skipped", ms: 0, detail: `slot 0 is the adopted unit ${s.adopt!.unit}: nothing is set up here` });
  }

  /** Data resources (skipped when they exist) then setup steps (skipped when their fingerprint holds); `force` redoes both. */
  private async provision(run: Run, def: ProjectDef, rec: InstanceRecord, force: boolean, only?: string[]): Promise<void> {
    const scope = scopeOf(rec);
    mkdirSync(dataRootOf(rec.id), { recursive: true });
    for (const d of def.data) {
      if (only && !only.includes(d.name)) continue;
      await this.step(run, `data:${d.name}`, "data", async () => {
        if (!force && rec.data[d.name] && this.dataExists(d, rec)) return { result: "skipped", detail: rec.data[d.name] };
        const own = this.ownSource(def, rec, d);
        const ref = await this.provisionOne(def, rec, d);
        if (own && rec.data[d.name] === ref) return { result: "skipped", detail: `${ref} (its own folder: nothing copied)` };
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

  /**
   * A `dir` resource whose `from` is the resource itself (the main checkout of `"from": "${main}/<path>"`, `path` the
   * same folder): it is main's own data, never copied onto itself and never removed (§app.project-services/contract).
   */
  private ownSource(def: ProjectDef, rec: InstanceRecord, d: DataDecl | undefined): string | null {
    if (!d || d.kind !== "dir" || d.from === "empty") return null;
    const scope = scopeOf(rec);
    let src: string;
    try {
      src = render(d.from, this.vars(def, scope));
    } catch {
      return null;
    }
    const path = this.dataPath(d, scope);
    return canonical(src) === canonical(path) ? path : null;
  }

  private async provisionOne(def: ProjectDef, rec: InstanceRecord, d: DataDecl): Promise<string> {
    const scope = scopeOf(rec);
    const own = this.ownSource(def, rec, d);
    if (own) {
      if (!existsSync(own) || !statSync(own).isDirectory()) throw new VerbFailure("not-found", `data.${d.name}.from: ${own} is this checkout's own folder, and it is not there`);
      return own;
    }
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
    // Copied by the server itself, so a confined run copies only what its own processes could read (§app.project-services/confined).
    if (scope.confine === "ended") throw new VerbFailure("not-approved", `${scope.id} belonged to a confined conformance run that has ended`);
    const hidden = scope.confine?.fromRefusal(src, [rec.project, rec.checkout]);
    if (hidden) throw new VerbFailure("not-approved", `data.${d.name}.from: ${hidden}`);
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new VerbFailure("not-found", `data.${d.name}.from: ${src} is not a folder`);
    mkdirSync(path, { recursive: true });
    const code = await this.containerExecLike("cp", copyContentsArgv(src, path));
    if (code !== 0) throw new VerbFailure("hook-failed", `copying ${src} to ${path} failed (exit ${code})`);
    return path;
  }

  private containerExecLike(file: string, args: string[]): Promise<number> {
    return new Promise((done) => execFile(file, args, { timeout: 600_000 }, (err) => done(err ? 1 : 0)));
  }

  private async deprovisionOne(def: ProjectDef | null, rec: InstanceRecord, name: string): Promise<void> {
    const d = def?.data.find((x) => x.name === name);
    const ref = rec.data[name];
    // The checkout's own data, copied from nowhere else: kept, whatever asks (reset of the main checkout).
    if (def && this.ownSource(def, rec, d)) {
      delete rec.data[name];
      this.save(rec);
      return;
    }
    if (d?.kind === "hook") await this.hook(def!, scopeOf(rec), `data-${d.name}-deprovision`, d.deprovision, d.timeout, "deprovision");
    else if (ref && isAbsolute(ref) && (ref.startsWith(dataRootOf(rec.id) + "/") || ref.startsWith(rec.checkout + "/"))) rmSync(ref, { recursive: true, force: true });
    delete rec.data[name];
    this.save(rec);
  }

  // ---- services ----------------------------------------------------------------------------------------

  private kindOf(s: ServiceDecl): ServiceView["kind"] {
    return s.static !== undefined ? "static" : s.container ? "container" : "process";
  }

  /**
   * The project's shared services' scope. A confined run has its own, with its own units (never the host's shared
   * ones), run from the checkout of the instance that needs them: the run's ref, not the main checkout's files.
   */
  private sharedScope(def: ProjectDef, project: string, confine: Scope["confine"] = null, from?: string): Scope {
    const runOf = confine && confine !== "ended" ? confine.runId : null;
    return { id: runOf ? `${sharedIdOf(project)}-${runOf}` : sharedIdOf(project), project, checkout: runOf && from ? from : project, branch: null, slot: 0, ports: {}, data: {}, confine, shared: true };
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
    // Inside a confined run, through its anchor: the run's ports are not on this host.
    const c = scope.confine && scope.confine !== "ended" ? scope.confine : null;
    if (s.ready && "http" in s.ready) {
      const port = ports[s.ready.http]!;
      return { probe: `http :${port}${s.ready.path}`, ok: c ? await c.http(port, s.ready.path) : await httpOk(port, s.ready.path), ms: Date.now() - t0 };
    }
    const portName = s.ready && "tcp" in s.ready ? s.ready.tcp : Object.keys(ports)[0];
    if (portName !== undefined) {
      const port = ports[portName]!;
      return { probe: `tcp :${port}`, ok: c ? await c.tcp(port) : await tcpOpen(port), ms: Date.now() - t0 };
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
        // Ready only once every declared port is its own too: one opened after the probed one (an nREPL after
        // the HTTP server) is waited for; one a foreign process holds fails at once.
        const ports = p.ok ? await this.portsUnheld(def, scope, s) : { foreign: null, waiting: [] };
        if (ports.foreign) throw new VerbFailure("port-held", `${ports.foreign}; Sova never stops it`, { service: s.name });
        if (p.ok && !ports.waiting.length && (!bare || Date.now() - started >= 1_000)) return { result: "done", detail: p.probe };
        if (Date.now() > until)
          throw new VerbFailure("not-ready", `${s.name} was not ready within ${timeoutSec}s (${p.probe}${p.ok ? ` answered, but nothing listens on ${ports.waiting.join(", ")}` : ""})`, { service: s.name });
        await sleep(this.pollMs);
      }
    });
  }

  /**
   * `s`'s declared ports nothing listens on yet, and the first one a provably foreign holder has (null: none). A
   * listener this user can't read that no container claims counts as listening: it may be the service's own
   * engine's proxy before the engine reports the port, and up's start already refused a foreign holder.
   */
  private async portsUnheld(def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<{ foreign: string | null; waiting: string[] }> {
    const waiting: string[] = [];
    for (const [k, port] of Object.entries(this.allPorts(def, scope)[s.name] ?? {})) {
      const c = await this.claimOf(def, scope, s, port);
      if (!c.held) waiting.push(`${s.name}.${k} (${port})`);
      else if (!c.own && !c.unreadable) return { foreign: `${s.name}.${k} needs port ${port}, which ${c.who} holds`, waiting };
    }
    return { foreign: null, waiting };
  }

  /** A holder of one of `s`'s ports that is not the instance's own refuses the start (never stopped). */
  private async preflight(def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<void> {
    for (const [k, port] of Object.entries(this.allPorts(def, scope)[s.name] ?? {})) {
      const c = await this.claimOf(def, scope, s, port);
      if (!c.held || c.own) continue;
      throw new VerbFailure("port-held", `${s.name}.${k} needs port ${port}, which ${c.who} holds; Sova never stops it`, { service: s.name });
    }
  }

  /** The container `s` runs as in `scope`, if it is a container service. */
  private containerOf(def: ProjectDef, scope: Scope, s: ServiceDecl): { engine: string; name: string } | null {
    return s.container ? { engine: s.container.engine, name: render(s.container.name, this.vars(def, scope)) } : null;
  }

  /**
   * Who holds `port` of service `s` (§app.project-services/up). Its own: its unit's process (the
   * server, for a static service), or, for a container service, its container whenever the engine
   * says it publishes the port, whatever process listens (docker-proxy, rootlessport, pasta, Docker
   * Desktop) or none at all. Anything else is foreign, named by pid or by the container of one of
   * the definition's engines that publishes the port.
   */
  private async claimOf(def: ProjectDef, scope: Scope, s: ServiceDecl, port: number): Promise<PortClaim> {
    const o = this.ownerIn(scope, s)(port);
    const unit = this.unitOf(scope.id, s.name);
    if (typeof o === "object" && (s.static !== undefined ? o.pid === process.pid : this.driver.owns(unit, o.pid))) return { held: true, own: true, who: `its own process (pid ${o.pid})` };
    if (typeof o === "object" && s.adopt && scope.slot === 0 && cgroupPids(s.adopt.unit).includes(o.pid)) return { held: true, own: true, who: `its adopted unit ${s.adopt.unit} (pid ${o.pid})` };
    const mine = this.containerOf(def, scope, s);
    if (mine && (await publishedPorts(this.containerQuery, mine.engine, mine.name)).has(port)) return { held: true, own: true, who: `its own container ${mine.name}` };
    let other: string | null = null;
    for (const engine of new Set(def.services.flatMap((x) => (x.container ? [x.container.engine] : [])))) {
      const name = await publisherOf(this.containerQuery, engine, port);
      if (name) {
        other = `container ${name}`;
        break;
      }
    }
    if (o === "none") return other ? { held: true, own: false, who: other } : { held: false };
    const pid = o === "unknown" ? "a process this user can't read" : `pid ${o.pid} (${o.cwd})`;
    return { held: true, own: false, who: other ? `${other} (${o === "unknown" ? "its listener unreadable" : `pid ${o.pid}`})` : pid, ...(o === "unknown" && !other ? { unreadable: true as const } : {}) };
  }

  /** `claimOf` for conform: a declared port of `rec`'s checkout service `service`. */
  async portClaim(rec: InstanceRecord, def: ProjectDef, service: string, port: number): Promise<PortClaim> {
    const s = def.services.find((x) => x.name === service);
    if (!s) return { held: this.ownerIn(scopeOf(rec))(port) !== "none", own: false, who: `an undeclared service ${service}` };
    return this.claimOf(def, scopeOf(rec), s, port);
  }

  /** Whether anything listens on `port` where `rec`'s processes run (its confined run, or this host). */
  portHeld(rec: InstanceRecord, port: number): boolean {
    return this.ownerIn(scopeOf(rec))(port) !== "none";
  }

  private async removeContainer(def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<void> {
    if (!s.container) return;
    const name = render(s.container.name, this.vars(def, scope));
    await this.containerExec(s.container.engine, ["rm", "-f", name]);
  }

  /** Keep the container an instance's service is about to run as in its record (a down after the service left the definition removes it by this name). */
  private noteContainer(run: Run, def: ProjectDef, scope: Scope, s: ServiceDecl): void {
    const c = this.containerOf(def, scope, s);
    const rec = run.rec;
    if (!c || !rec || rec.id !== scope.id) return;
    const was = rec.containers?.[s.name];
    if (was?.engine === c.engine && was.name === c.name) return;
    rec.containers = { ...(rec.containers ?? {}), [s.name]: c };
    this.save(rec);
  }

  /** The services `rec` still records that `def` no longer declares as checkout services (every one, with no definition). */
  private removedOf(rec: InstanceRecord, def: ProjectDef | null): string[] {
    return Object.keys(rec.desired).filter((n) => !def?.services.some((s) => s.name === n && s.scope === "checkout"));
  }

  /**
   * Stop `name`, a service `rec` records that its definition no longer declares (§app.project-services/down):
   * by its unit's name and by the container name its last start recorded, then mark it stopped.
   */
  private async stopRemoved(run: Run, rec: InstanceRecord, name: string, why: string): Promise<void> {
    const unit = this.unitOf(rec.id, name);
    const wanted = rec.desired[name] === "running";
    rec.desired[name] = "stopped";
    this.save(rec);
    await this.step(run, `stop:${name}`, "stop", async () => {
      const did: string[] = [];
      if (staticServes().some((x) => x.id === unit)) {
        await stopStaticServe(unit);
        did.push("static serve stopped");
      } else {
        const st = await this.driver.status(unit);
        if (st.state !== "missing") await this.driver.stop(unit);
        if (st.state !== "missing" && st.state !== "inactive") did.push(unit);
      }
      const c = rec.containers?.[name];
      if (c && (await this.containerExec(c.engine, ["rm", "-f", c.name])) === 0) {
        did.push(`container ${c.name} removed`);
        rec.containers = { ...rec.containers };
        delete rec.containers[name];
        this.save(rec);
      }
      return did.length || wanted ? { result: "done", detail: `${why}: ${did.join(", ") || "marked stopped"}` } : { result: "skipped", detail: why };
    });
  }

  /**
   * The project's shared services its record names that no definition declares any more
   * (§app.project-services/down): neither the main checkout's nor any registered instance's. None while
   * any of those definitions is unreadable: a branch that still declares one may be what runs it.
   */
  private sharedRemovedOf(project: string): string[] {
    const sh = readRegistry().shared.find((x) => x.project === project);
    if (!sh || !Object.keys(sh.desired).length) return [];
    const checkouts = new Set([project, ...readRegistry().instances.filter((i) => i.project === project).map((i) => i.checkout)]);
    const declared = new Set<string>();
    for (const c of checkouts) {
      let def: ProjectDef;
      try {
        def = parseDefinition(readFileSync(join(c, CONTRACT_FILE), "utf8"));
      } catch {
        return [];
      }
      for (const s of def.services) if (s.scope === "shared") declared.add(s.name);
    }
    return Object.keys(sh.desired).filter((n) => !declared.has(n));
  }

  /** Stop each shared service of `project` that is in no definition any more and still runs or is still wanted; its names. */
  private async stopSharedRemoved(run: Run, project: string): Promise<string[]> {
    const out: string[] = [];
    const id = sharedIdOf(project);
    for (const name of this.sharedRemovedOf(project)) {
      const unit = this.unitOf(id, name);
      const st = await this.driver.status(unit);
      const alive = st.state !== "missing" && st.state !== "inactive";
      const wanted = readRegistry().shared.find((x) => x.project === project)?.desired[name] === "running";
      if (!alive && !wanted) continue;
      mutateRegistry((r) => {
        const sh = r.shared.find((x) => x.project === project);
        if (sh) sh.desired[name] = "stopped";
      });
      const ports = Object.values(readRegistry().shared.find((x) => x.project === project)?.ports[name] ?? {});
      await this.step(run, `stop:${name}`, "stop", async () => {
        if (st.state !== "missing") await this.driver.stop(unit);
        // As after any stop: its ports released before anything starts on them (at most 5 s).
        for (const until = Date.now() + 5_000; ports.some((p) => this.portOwner(p) !== "none") && Date.now() < until; ) await sleep(50);
        return { result: "done", detail: `shared, no longer in any definition: ${alive ? unit : "marked stopped"}` };
      });
      out.push(name);
    }
    return out;
  }

  /** Before up or apply: stop every service the record still wants or still runs that left the definition. */
  private async stopRemovedDue(run: Run, rec: InstanceRecord, def: ProjectDef): Promise<string[]> {
    const out: string[] = [];
    for (const name of this.removedOf(rec, def)) {
      const unit = this.unitOf(rec.id, name);
      const st = staticServes().some((x) => x.id === unit) ? null : await this.driver.status(unit);
      const alive = !st || (st.state !== "missing" && st.state !== "inactive");
      if (rec.desired[name] !== "running" && !alive && !rec.containers?.[name]) continue;
      await this.stopRemoved(run, rec, name, `${name} is no longer in the definition`);
      out.push(name);
    }
    return out;
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
          if (err instanceof StaticServeError && err.code === "port-taken") await this.preflight(def, scope, s);
          throw new VerbFailure("start-failed", err instanceof Error ? err.message : String(err), { service: s.name });
        }
      }
      await this.preflight(def, scope, s);
      await this.removeContainer(def, scope, s);
      this.noteContainer(run, def, scope, s);
      const vars = this.vars(def, scope);
      const spec = await this.inScope(scope, { unit, argv: s.cmd!.map((a) => render(a, vars)), cwd: join(scope.checkout, s.cwd), env: this.env(def, scope, { service: s }) });
      try {
        await this.driver.start(spec);
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
   * After stopping its own process, wait (at most 5 s) until the service's ports have no listener
   * and its container publishes none of them: a socket can outlive its process by a moment, and an
   * engine can keep a removed container's ports a moment longer, which a start right after would
   * take for a foreign holder.
   */
  private async portsReleased(def: ProjectDef, scope: Scope, s: ServiceDecl): Promise<void> {
    const ports = Object.values(this.allPorts(def, scope)[s.name] ?? {});
    const mine = this.containerOf(def, scope, s);
    const until = Date.now() + 5_000;
    for (;;) {
      const published = mine ? await publishedPorts(this.containerQuery, mine.engine, mine.name) : new Set<number>();
      const owner = this.ownerIn(scope, s);
      if (!ports.some((p) => published.has(p) || owner(p) !== "none") || Date.now() >= until) return;
      await sleep(50);
    }
  }

  /** Bring the project's shared services `names` up, one caller at a time per project. */
  private async upShared(run: Run, def: ProjectDef, names: ServiceDecl[]): Promise<void> {
    if (!names.length) return;
    const project = run.project!;
    const confine = run.rec ? scopeOf(run.rec).confine : null;
    const chainKey = confine && confine !== "ended" ? `${project}\0${confine.runId}` : project;
    const prev = this.sharedChain.get(chainKey) ?? Promise.resolve();
    const job = prev.catch(() => undefined).then(async () => {
      const scope = this.sharedScope(def, project, confine, run.rec?.checkout);
      // A confined run's shared services are the run's alone: the registry's shared record is the host's.
      if (!confine) mutateRegistry((r) => {
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
    this.sharedChain.set(chainKey, job);
    await job;
  }

  // ---- verbs -------------------------------------------------------------------------------------------

  private async up(run: Run): Promise<void> {
    const rec = run.rec ?? (await this.create(run));
    run.rec = rec;
    const def = this.need(run);
    await this.supervised(def);
    // Without a list, every checkout service but the on-demand ones (§app.project-services/up).
    const names = run.req.services?.length ? run.req.services : def.services.filter((s) => s.scope === "checkout" && s.start === "up").map((s) => s.name);
    for (const n of names) if (!def.services.some((s) => s.name === n)) throw new VerbFailure("invalid-request", `no service "${n}"`);
    await this.bringUp(run, rec, def, names);
  }

  /** Start `names` and what they require (shared first), each waiting for its readiness; what already runs is left alone. */
  private async bringUp(run: Run, rec: InstanceRecord, def: ProjectDef, names: string[]): Promise<void> {
    const adopted = rec.slot === 0 ? adoptedService(def) : null;
    if (adopted && closureOf(def, names).some((s) => s.name === adopted.name))
      throw new VerbFailure("refused-slot0", `slot 0's ${adopted.name} is the adopted unit ${adopted.adopt!.unit}, which Sova never starts`, { service: adopted.name });
    await this.stopRemovedDue(run, rec, def);
    // The host's shared services are never a confined run's to stop.
    if (!rec.confined) await this.stopSharedRemoved(run, rec.project);
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

  /**
   * test (§app.project-services/test): bring up what the test command requires, then run it once with the
   * selectors appended, as a waited-for unit in the instance; a run that did not pass is `tests-failed`.
   */
  private async test(run: Run): Promise<void> {
    const select = run.req.select ?? [];
    const bad = selectorsProblem(select);
    if (bad) throw new VerbFailure("invalid-request", `select: ${bad}`);
    const precheck = (d: ProjectDef) => {
      if (!d.test) throw new VerbFailure("unsupported", "This project declares no test command");
    };
    if (run.def) precheck(run.def);
    const rec = run.rec ?? (await this.create(run, precheck));
    run.rec = rec;
    const def = this.need(run);
    precheck(def);
    await this.supervised(def);
    const t = def.test!;
    if (t.requires.length) await this.bringUp(run, rec, def, t.requires);
    const scope = scopeOf(rec);
    const unit = this.hookUnitOf(rec.id, "test");
    const outFile = join(dataRootOf(rec.id), ".out", "test.json");
    mkdirSync(dirname(outFile), { recursive: true });
    rmSync(outFile, { force: true });
    const vars = this.vars(def, scope);
    const env = { ...this.env(def, scope, { verb: "test", step: "test", out: outFile }), SOVA_TEST_SELECT: JSON.stringify(select) };
    const t0 = Date.now();
    const r = await this.driver.runOnce(await this.inScope<OnceSpec>(scope, { unit, argv: [...t.run.map((a) => render(a, vars)), ...select], cwd: scope.checkout, env, timeoutSec: t.timeout, ...(run.signal ? { signal: run.signal } : {}) }));
    const counts = readTestOut(outFile);
    const exit = r.code;
    const pass = !r.timedOut && !r.aborted && exit === 0 && (counts?.failed ?? 0) === 0 && (counts?.errors ?? 0) === 0;
    const report: TestsReport = {
      select,
      pass,
      passed: counts?.passed ?? null,
      failed: counts?.failed ?? null,
      errors: counts?.errors ?? null,
      skipped: counts?.skipped ?? null,
      failures: counts?.failures ?? [],
      exit,
      timedOut: r.timedOut,
      ms: r.ms,
      peakBytes: r.peakBytes ?? null,
    };
    run.extra.tests = report;
    run.extra.lines = (await this.driver.logs(unit, 100, t0)).map((l) => ({ t: l.t, service: "test", text: l.text }));
    const bad2 = counts ? counts.failed + counts.errors : 0;
    const why = r.launchError
      ? `the test command could not be started: ${r.launchError}`
      : r.timedOut
        ? `timed out after ${t.timeout}s`
        : r.aborted
          ? "the test run was stopped: the call was cancelled"
          : counts && bad2 > 0
            ? `${bad2} of ${counts.passed + bad2} failed`
            : `the test command exited with ${exit}`;
    const shown = select.length ? select.join(" ") : "the whole suite";
    run.steps.push({ id: "test", kind: "test", result: pass ? "done" : "failed", ms: r.ms, detail: pass ? `${shown}: passed${counts ? ` (${counts.passed} passed, ${counts.skipped} skipped)` : ""}` : `${shown}: ${why}` });
    if (!pass) throw new VerbFailure("tests-failed", why, { step: "test" });
  }

  private async down(run: Run): Promise<void> {
    const rec = run.rec!;
    const def = run.def;
    await this.supervised(def);
    const known = def ? serviceOrder(def) : [];
    // What the record still names that the definition no longer declares is stopped too: nothing of it comes back later.
    const removed = this.removedOf(rec, def);
    const names = run.req.services?.length ? run.req.services : [...removed, ...known.filter((s) => s.scope === "checkout").map((s) => s.name)];
    for (const n of names) if (!known.some((s) => s.name === n) && !removed.includes(n)) throw new VerbFailure("invalid-request", `no service "${n}"`);
    for (const n of removed.filter((x) => names.includes(x))) await this.stopRemoved(run, rec, n, def ? `${n} is no longer in the definition` : "definition unreadable");
    const order = [...known].reverse().filter((s) => names.includes(s.name) && !removed.includes(s.name));
    for (const s of order) {
      if (s.scope === "shared") {
        await this.stopService(run, def, this.sharedScope(def!, rec.project, scopeOf(rec).confine), s.name, s);
        if (!rec.confined) mutateRegistry((r) => {
          const sh = r.shared.find((x) => x.project === rec.project);
          if (sh) sh.desired[s.name] = "stopped";
        });
        continue;
      }
      rec.desired[s.name] = "stopped";
      this.save(rec);
      await this.stopService(run, def, scopeOf(rec), s.name, s);
    }
    if (!run.req.services?.length && !rec.confined) await this.stopSharedRemoved(run, rec.project);
  }

  private async apply(run: Run): Promise<void> {
    const rec = run.rec!;
    const def = this.need(run);
    const adopted = this.adoptedIn(run);
    if (adopted) return this.applyAdopted(run, def, rec, adopted);
    await this.supervised(def);
    const scope = scopeOf(rec);
    const names = run.req.services?.length ? run.req.services : def.services.filter((s) => s.scope === "checkout").map((s) => s.name);
    for (const n of names) if (!def.services.some((s) => s.name === n)) throw new VerbFailure("invalid-request", `no service "${n}"`);
    await this.stopRemovedDue(run, rec, def);
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
          this.noteContainer(run, def, scope, s);
          const vars = this.vars(def, scope);
          await this.driver.start(await this.inScope(scope, { unit, argv: s.cmd!.map((a) => render(a, vars)), cwd: join(scope.checkout, s.cwd), env: this.env(def, scope, { service: s }) }));
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

  /**
   * apply on an adopted slot 0 (§app.project-services/adopt): its build when declared and changed, then,
   * in place of a reload, the unit's gated restart scheduled RESTART_DELAY_SEC from now. Nothing is
   * waited for: the server can't watch a restart that may be its own.
   */
  private async applyAdopted(run: Run, def: ProjectDef, rec: InstanceRecord, s: ServiceDecl): Promise<void> {
    const unit = s.adopt!.unit;
    if (run.req.services?.length && !run.req.services.includes(s.name)) throw new VerbFailure("invalid-request", `slot 0 runs only the adopted ${s.name}`);
    const st = await this.adoptedStatus(unit);
    if (st.state === "missing") throw new VerbFailure(st.detail ? "unsupported" : "not-found", st.detail ?? `the adopted unit ${unit} is not loaded: install it first`, { service: s.name });
    if (s.build) {
      const b = s.build;
      const scope = scopeOf(rec);
      await this.step(run, `build:${s.name}`, "build", async () => {
        const argv = b.run.map((a) => render(a, this.vars(def, scope)));
        const fp = this.fingerprint(scope, argv, b.inputs);
        if (rec.prints[`build:${s.name}`] === fp) return { result: "skipped", fingerprint: fp };
        await this.supervised(def);
        await this.hook(def, scope, `build-${s.name}`, b.run, b.timeout, "apply", join(scope.checkout, s.cwd));
        rec.prints[`build:${s.name}`] = fp;
        this.save(rec);
        return { result: "done", fingerprint: fp };
      });
    }
    await this.step(run, `restart:${s.name}`, "reload", async () => {
      const why = await this.scheduleRestart(unit, st.pid);
      if (why) throw new VerbFailure("unsupported", `the restart of ${unit} could not be scheduled (${why}): nothing restarts; restart it outside Sova once nothing is busy`, { service: s.name });
      return { result: "done", detail: `restart scheduled: ${unit} restarts in ${RESTART_DELAY_SEC} s unless a session this server hosts is busy then (${restartGateLog()})` };
    });
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
        const own = this.ownSource(def, rec, d);
        if (own) return { result: "skipped", detail: `kept ${own}: its from is the folder itself` };
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
    // Its links end first, siblings included, so a later copy in this slot never answers one (§app.project-services/share).
    if (linksOf(rec.id).length)
      await this.step(run, "links", "link", async () => {
        const r = revokeLinks({ instance: rec.id });
        return r.changed ? { result: "done", detail: `revoked ${r.links.length} share link${r.links.length === 1 ? "" : "s"}` } : { result: "skipped", detail: "no active share link" };
      });
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

  // ---- share and revoke (§app.project-services/share) --------------------------------------------------

  /** The share's input as this run has it. */
  private async shareInput(run: Run) {
    const def = this.need(run);
    const rec = run.rec;
    if (!rec) throw new VerbFailure("invalid-request", "share needs an instance (or the checkout it runs)");
    return {
      rec,
      def,
      projectId: await this.projectIdOf(rec.project),
      endpoint: run.req.endpoint,
      days: run.req.days,
      // preview-links.json keeps `operator` or `session:<id>` (the project overseer's conversation), strictly.
      createdBy: run.caller.kind === "operator" ? "operator" : `session:${run.caller.id}`,
      serveOf: (s: ServiceDecl) => this.unitOf(rec.id, s.name),
    };
  }

  private async shareChecks(run: Run): Promise<void> {
    try {
      await checkShare(await this.shareInput(run));
    } catch (err) {
      if (err instanceof ShareFailure) throw new VerbFailure(err.code, err.message);
      throw err;
    }
  }

  private async share(run: Run): Promise<void> {
    try {
      const { link, changed } = await shareInstance({ ...(await this.shareInput(run)), sovaPorts: await this.sovaPorts() });
      run.steps.push({ id: "share", kind: "link", result: changed ? "done" : "skipped", ms: 0, detail: `${link.endpoint} until ${link.expiresAt}` });
      const { url, ...rest } = link;
      run.extra.links = [run.caller.kind === "operator" && url ? { ...rest, url } : rest];
    } catch (err) {
      if (err instanceof ShareFailure) throw new VerbFailure(err.code, err.message);
      throw err;
    }
  }

  private async revoke(run: Run): Promise<void> {
    const rec = run.rec;
    if (!rec) throw new VerbFailure("invalid-request", "revoke needs a link, or an instance (or the checkout it runs)");
    try {
      const r = revokeLinks(run.req.link ? { link: run.req.link } : { instance: rec.id, ...(run.req.endpoint ? { endpoint: run.req.endpoint } : {}) });
      run.steps.push({ id: "revoke", kind: "link", result: r.changed ? "done" : "skipped", ms: 0, detail: r.changed ? `revoked ${r.links.length} share link${r.links.length === 1 ? "" : "s"}` : "no active share link" });
      run.extra.links = r.links;
    } catch (err) {
      if (err instanceof ShareFailure) throw new VerbFailure(err.code, err.message);
      throw err;
    }
  }

  /** What status says about sharing a copy: its definition's endpoints, and why it can't be shared (null: it can). */
  private async shareFacts(run: Run): Promise<InstanceSummary["share"]> {
    if (!run.def) return { endpoints: [], refused: run.defError ? run.defError.message : "no definition" };
    const refused = shareRefusal(run.def) ?? ((await this.projectIdOf(run.project!)) ? null : "Only a registered project's copies can be shared.");
    return { endpoints: run.def.share?.endpoints ?? [], refused };
  }

  /** Which supervisor adapter is in use, why, and whether it serves this definition. */
  private async supervisorCheck(def: ProjectDef | null): Promise<Check> {
    const drv = await this.driver.available();
    return { id: "supervisor", ok: drv.ok || !def || !runsProcesses(def), detail: `${this.driver.id}: ${drv.detail}` };
  }

  private async status(run: Run): Promise<void> {
    run.extra.checks = [await this.supervisorCheck(run.def)];
    if (run.rec) run.extra.links = linksOf(run.rec.id, { activeOnly: true, withUrl: run.caller.kind === "operator" });
    if (run.rec || run.req.instance) return;
    // A whole project: every instance.
    const reg = readRegistry();
    const out: InstanceSummary[] = [];
    for (const rec of reg.instances.filter((i) => i.project === run.project)) {
      const sub: Run = { ...run, rec, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
      this.loadDefinition(sub, rec.checkout);
      const services = await this.observe(sub);
      out.push({
        instance: rec.id,
        slot: rec.slot,
        generation: rec.generation,
        checkout: rec.checkout,
        branch: rec.branch,
        state: this.stateOf(sub, services),
        services,
        createdBy: rec.createdBy,
        links: linksOf(rec.id, { activeOnly: true, withUrl: run.caller.kind === "operator" }),
        share: await this.shareFacts(sub),
      });
    }
    out.sort((a, b) => a.slot - b.slot);
    run.extra.instances = out;
  }

  private async logs(run: Run): Promise<void> {
    const rec = run.rec!;
    const lines = Math.min(Math.max(run.req.lines ?? 100, 1), 500);
    const names = run.req.services?.length ? run.req.services : run.def ? run.def.services.filter((s) => s.scope === "checkout").map((s) => s.name) : Object.keys(rec.desired);
    const out: LogLine[] = [];
    const adopted = rec.slot === 0 && run.def ? adoptedService(run.def) : null;
    for (const n of names) {
      // An adopted unit's journal, read as any systemd unit's (§app.project-services/adopt).
      const got = adopted?.name === n ? await new SystemdDriver().logs(adopted.adopt!.unit.replace(/\.service$/, ""), lines) : await this.driver.logs(this.unitOf(rec.id, n), lines);
      for (const l of got) out.push({ t: l.t, service: n, text: l.text });
    }
    // Oldest first: by time where the driver has it, else each service's own order.
    const stable = out.map((l, i) => ({ l, i }));
    stable.sort((a, b) => (a.l.t && b.l.t ? a.l.t.localeCompare(b.l.t) : 0) || a.i - b.i);
    run.extra.lines = stable.map((x) => x.l).slice(-lines);
  }

  private async doctor(run: Run): Promise<void> {
    const checks: Check[] = [];
    const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
    add("definition", !run.defError && !!run.def, run.defError ? run.defError.message : run.def ? `valid (${run.defHash})` : `no ${CONTRACT_FILE}`);
    const confined = !run.approved && this.confinedRun(run);
    add("approved", run.approved || confined, run.approved ? "approved on this host" : confined ? `not approved: ${run.defHash}, running confined` : `not approved: ${run.defHash ?? "no definition"}`);
    checks.push(await this.supervisorCheck(run.def));
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
      const scope: Scope = run.rec ? scopeOf(run.rec) : { id: "doctor", project: run.project!, checkout: run.project!, branch: null, slot: 0, ports: {}, data: {}, confine: null };
      for (const d of def.data)
        if (d.kind === "dir" && d.from !== "empty") {
          const src = render(d.from, this.vars(def, scope));
          add(`data:${d.name}`, existsSync(src), existsSync(src) ? `${src} exists` : `${src} doesn't exist`);
        }
      if (run.rec) {
        for (const s of def.services) {
          const sc = s.scope === "shared" ? this.sharedScope(def, run.project!, scope.confine) : scope;
          for (const [k, port] of Object.entries(this.allPorts(def, sc)[s.name] ?? {})) {
            const c = await this.claimOf(def, sc, s, port);
            add(`port:${s.name}.${k}`, !c.held || c.own, c.held ? `${port} held by ${c.who}` : `${port} free`);
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
      if (s.adopt && rec.slot === 0) {
        out.push(await this.observeAdopted(def, rec, s));
        continue;
      }
      const sc = s.scope === "shared" ? this.sharedScope(def, rec.project, scope.confine) : scope;
      const unit = this.unitOf(sc.id, s.name);
      const ports = this.allPorts(def, sc)[s.name] ?? {};
      const kind = this.kindOf(s);
      if (s.static !== undefined) {
        const serving = staticServes().some((x) => x.id === unit);
        out.push({ name: s.name, scope: s.scope, kind, state: serving ? "ready" : this.heldElsewhere(sc, s, ports) ? "external" : "stopped", unit, pid: serving ? process.pid : null, ports, ...(serving ? { ready: { probe: "serve", ok: true, ms: 0 } } : {}) });
        continue;
      }
      const st = await this.driver.status(unit);
      if (st.state === "active" || st.state === "activating") {
        const p = await this.probe(def, sc, s, unit);
        // A process service's resident memory now (a container's lives in its engine, not its unit).
        const rss = kind === "process" ? rssOf(this.driver.pids(unit)) : null;
        out.push({ name: s.name, scope: s.scope, kind, state: p.ok ? "ready" : st.state === "activating" ? "starting" : "degraded", unit, pid: st.pid, ports, ready: p, ...(rss !== null ? { rssBytes: rss } : {}) });
      } else {
        const state = st.state === "failed" ? "failed" : this.heldElsewhere(sc, s, ports) ? "external" : "stopped";
        out.push({ name: s.name, scope: s.scope, kind, state, unit, pid: null, ports, ...(st.detail && st.state === "failed" ? { detail: st.detail } : {}) });
      }
    }
    // What the definition no longer declares but still runs is never hidden (§app.project-services/status-logs).
    for (const name of this.removedOf(rec, def)) {
      const unit = this.unitOf(rec.id, name);
      const serving = staticServes().some((x) => x.id === unit);
      const st = serving ? { state: "active" as const, pid: process.pid } : await this.driver.status(unit);
      if (st.state !== "active" && st.state !== "activating") continue;
      out.push({ name, scope: "checkout", kind: serving ? "static" : rec.containers?.[name] ? "container" : "process", state: "degraded", unit, pid: st.pid, ports: rec.ports[name] ?? {}, detail: "no longer in the definition" });
    }
    for (const name of rec.confined ? [] : this.sharedRemovedOf(rec.project)) {
      const unit = this.unitOf(sharedIdOf(rec.project), name);
      const st = await this.driver.status(unit);
      if (st.state !== "active" && st.state !== "activating") continue;
      out.push({ name, scope: "shared", kind: "process", state: "degraded", unit, pid: st.pid, ports: readRegistry().shared.find((x) => x.project === rec.project)?.ports[name] ?? {}, detail: "shared, no longer in any definition" });
    }
    return out;
  }

  /** Slot 0's adopted unit as it is now, read only: its readiness on the unit's own ports, and when it started (§app.project-services/adopt). */
  private async observeAdopted(def: ProjectDef, rec: InstanceRecord, s: ServiceDecl): Promise<ServiceView> {
    const unit = s.adopt!.unit;
    const ports = { ...s.adopt!.ports };
    const st = await this.adoptedStatus(unit);
    const self = this.selfCheckout() === rec.project;
    const head = self ? serverStart().head : null;
    const about = `adopted unit${self ? " (this server)" : ""}${st.startedAt ? `, started ${st.startedAt}` : ""}${head ? ` at ${head.slice(0, 12)}` : ""}`;
    const base = { name: s.name, scope: s.scope, kind: "process" as const, unit, pid: st.pid, ports };
    if (st.state !== "active" && st.state !== "activating") return { ...base, state: st.state === "failed" ? "failed" : "stopped", detail: st.detail && st.state !== "inactive" ? `${about}: ${st.detail}` : about };
    const t0 = Date.now();
    let probe = "running";
    let ok = st.state === "active";
    const tcp = s.ready && "tcp" in s.ready ? s.ready.tcp : Object.keys(ports)[0];
    if (s.ready && "http" in s.ready) {
      probe = `http :${ports[s.ready.http]}${s.ready.path}`;
      ok = await httpOk(ports[s.ready.http]!, s.ready.path);
    } else if (tcp !== undefined) {
      probe = `tcp :${ports[tcp]}`;
      ok = await tcpOpen(ports[tcp]!);
    }
    return { ...base, state: ok ? "ready" : st.state === "activating" ? "starting" : "degraded", ready: { probe, ok, ms: Date.now() - t0 }, detail: about, ...(st.rssBytes !== null ? { rssBytes: st.rssBytes } : {}) };
  }

  private heldElsewhere(scope: Scope, s: ServiceDecl, ports: Record<string, number>): boolean {
    const owner = this.ownerIn(scope, s);
    return Object.values(ports).some((p) => owner(p) !== "none");
  }

  private stateOf(run: Run, services: ServiceView[]): InstanceState {
    const rec = run.rec;
    if (!rec) return "absent";
    const own = services.filter((s) => s.scope === "checkout");
    // An adopted slot 0's unit is always wanted: the operator runs it (§app.project-services/adopt).
    const adopted = rec.slot === 0 && run.def ? adoptedService(run.def)?.name : undefined;
    const desired = own.filter((s) => rec.desired[s.name] === "running" || s.name === adopted);
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
    const changed = run.steps.some((s) => s.result === "done" && s.kind !== "check" && s.kind !== "ready" && s.kind !== "test");
    // Only doctor's checks decide `ok`; status carries the supervisor's as a note.
    const checksOk = run.verb !== "doctor" || !run.extra.checks || run.extra.checks.every((c) => c.ok);
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

  // ---- the instance note (§app.project-services/instance-note) -------------------------------------------

  /** What the note says about `checkout`: null for a main checkout, a folder outside a project, or one with no definition. */
  async noteFacts(checkout: string): Promise<NoteFacts | null> {
    const c = canonical(checkout);
    const p = await projectOf(c);
    if (p.state !== "ok" || p.root === c) return null;
    const file = join(c, CONTRACT_FILE);
    if (!existsSync(file)) return null;
    let def: ProjectDef;
    try {
      def = parseDefinition(readFileSync(file, "utf8"));
    } catch (err) {
      return { kind: "invalid", checkout: c, problem: err instanceof Error ? err.message : String(err) };
    }
    const rec = readRegistry().instances.find((i) => i.project === p.root && i.checkout === c);
    if (!rec) return { kind: "no-instance", checkout: c };
    const scope = scopeOf(rec);
    const vars = this.vars(def, scope);
    const here = this.allPorts(def, scope);
    const main = portsFor(def, 0);
    const ports: Extract<NoteFacts, { kind: "instance" }>["ports"] = [];
    for (const s of def.services)
      for (const [k, port] of Object.entries(here[s.name] ?? {})) {
        const url = s.ready && "http" in s.ready && s.ready.http === k ? `http://127.0.0.1:${port}${s.ready.path}` : undefined;
        ports.push({ key: `${s.name}.${k}`, port, main: main[s.name]?.[k] ?? port, ...(url ? { url } : {}), shared: s.scope === "shared" });
      }
    return {
      kind: "instance",
      checkout: c,
      branch: rec.branch,
      project: rec.project,
      instance: rec.id,
      slot: rec.slot,
      approved: isApproved(rec.project, defHashOf(def)),
      ports,
      services: def.services.map((s) => ({ name: s.name, ...(s.about ? { about: render(s.about, vars) } : {}), onDemand: s.start === "on-demand" })),
      data: def.data.map((d) => ({ name: d.name, ref: rec.data[d.name] ?? this.dataPath(d, scope) })),
      test: def.test ? { smoke: def.test.smoke } : null,
    };
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
    const r = await this.driver.runOnce(
      await this.inScope<OnceSpec>(scope, {
        unit: this.hookUnitOf(scope.id, "probe"),
        argv: [...probe.run.map((a) => render(a, vars)), ...args],
        cwd: scope.checkout,
        env: this.env(run.def, scope, { verb: "conform", step: "probe" }),
        timeoutSec: probe.timeout,
      }),
    );
    return r.timedOut || r.launchError ? -1 : r.code;
  }

  /** The folders `def`'s dir resources copy, as the main checkout would render them (confined conformance checks them first). */
  dataSources(def: ProjectDef, project: string): string[] {
    const scope: Scope = { id: "conform", project, checkout: project, branch: null, slot: scratchSlotsOf(def)[0], ports: {}, data: {}, confine: null };
    return def.data.flatMap((d) => (d.kind === "dir" && d.from !== "empty" ? [render(d.from, this.vars(def, scope))] : []));
  }

  /** Container names `rec`'s definition gives its services (for leak checks). */
  containersOf(rec: InstanceRecord): { engine: string; name: string }[] {
    const run = this.bare(rec);
    if (!run.def) return [];
    const vars = this.vars(run.def, scopeOf(rec));
    const declared = run.def.services.filter((s) => s.container && s.scope === "checkout").map((s) => ({ engine: s.container!.engine, name: render(s.container!.name, vars) }));
    const recorded = Object.values(rec.containers ?? {}).filter((c) => !declared.some((d) => d.engine === c.engine && d.name === c.name));
    return [...declared, ...recorded];
  }

  // ---- reconcile (§app.project-services/reconcile) ------------------------------------------------------

  /** Bring every instance back to its desired state after a server start. Returns what it did. */
  async reconcile(): Promise<string[]> {
    const did: string[] = [];
    const reg = readRegistry();
    // This server as its own project's adopted slot 0: nothing to start, its start noted (§app.project-services/adopt).
    for (const rec of reg.instances.filter((i) => i.slot === 0 && i.project === this.selfCheckout())) {
      const s = this.bare(rec).def;
      const adopted = s ? adoptedService(s) : null;
      if (!adopted) continue;
      const { startedAt, head } = serverStart();
      did.push(`${rec.id}: ${adopted.adopt!.unit} is this server, started ${startedAt} at ${head ?? "no commit"}`);
    }
    const touched = new Set<string>();
    for (const rec of reg.instances) {
      const want = Object.entries(rec.desired);
      if (!want.length) continue;
      // A confined run ended with the server that ran it: its units are stopped, never started (§app.project-services/confined).
      if (rec.confined && !confinementOf(rec.confined)) {
        const live: string[] = [];
        for (const name of Object.keys(rec.desired)) {
          const unit = this.unitOf(rec.id, name);
          const st = await this.driver.status(unit);
          if (st.state !== "missing") await this.driver.stop(unit);
          if (st.state === "active" || st.state === "activating") live.push(name);
        }
        mutateRegistry((r) => {
          const i = r.instances.find((x) => x.id === rec.id);
          if (i) for (const n of Object.keys(i.desired)) i.desired[n] = "stopped";
        });
        did.push(`${rec.id}: stopped${live.length ? ` ${live.join(", ")}` : ""} (its confined conformance run ended)`);
        continue;
      }
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
        // Never started: a service that left the definition; its unit (and container) are stopped, and it is marked stopped.
        try {
          for (const name of await this.stopRemovedDue(run, rec, def)) did.push(`${rec.id}: stopped ${name} (no longer in the definition)`);
        } catch (err) {
          did.push(`${rec.id}: a service no longer in the definition failed to stop (${err instanceof Error ? err.message : String(err)})`);
        }
      } finally {
        lock.release();
      }
    }
    for (const sh of reg.shared) {
      const run: Run = { verb: "up", caller: { kind: "operator" }, req: {}, project: sh.project, rec: null, def: null, defError: null, defHash: null, approved: false, steps: [], extra: {} };
      try {
        for (const name of await this.stopSharedRemoved(run, sh.project)) did.push(`${sh.id}: stopped ${name} (shared, no longer in any definition)`);
      } catch (err) {
        did.push(`${sh.id}: a shared service no longer in any definition failed to stop (${err instanceof Error ? err.message : String(err)})`);
      }
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
    await this.driver.adopt?.();
    return did;
  }
}
