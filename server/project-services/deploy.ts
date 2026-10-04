import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  deployStepsOf,
  isDeployVerb,
  ordered,
  render,
  type DeployKind,
  type DeployPlanView,
  type DeployTargetDecl,
  type AnyVerb,
  type Check,
  type DeployDecl,
  type DeployRecordView,
  type DeployReport,
  type DeployRequestView,
  type DeployTargetView,
  type DeployVerb,
  type ErrorCode,
  type LogLine,
  type Step,
  type VerbResult,
} from "../../shared/project-contract";
import { projectOf } from "../project-root";
import { approveDeployAtRef, definitionAt, deployApprovalOf, deployHashOf, deployReview, mainBranchOf, readDeployApprovals, resolveHost, targetStanding } from "./deploy-trust";
import { callerTag, realGit, type Caller, type ProjectEngine } from "./engine";
import { realExec, SLICE } from "./drivers";
import { servicesRoot, stateHash, tryLock } from "./store";
import { defHashOf, hostVars, isApproved } from "./trust";

/**
 * The deploy verbs (§app.project-services/deploy): a target of the definition's `deploy`, never an
 * instance. deploy.status and deploy.logs read; deploy.check proves the recipe offline; deploy.plan
 * checks a commit in a fresh checkout Sova cuts and answers a plan good for 15 minutes; deploy.run
 * ships a plan (the operator's only) as a transient unit that outlives a server restart;
 * deploy.rollback undoes the last deploy the way the target declares; deploy.request is an
 * overseer's ask that the operator ship. State: `<state root>/project-services/deploy/`.
 */

type Git = typeof realGit;

export const deployRoot = () => join(servicesRoot(), "deploy");
const recordsDir = () => join(deployRoot(), "records");
const notesFile = () => join(deployRoot(), "notes.json");
const checkoutsDir = () => join(deployRoot(), "checkouts");
const checksDir = () => join(deployRoot(), "checks");
const plansDir = () => join(deployRoot(), "plans");
const logsDir = () => join(deployRoot(), "logs");
const jobsDir = () => join(deployRoot(), "jobs");
const locksDir = () => join(deployRoot(), "locks");
export const deployLogFile = (id: string) => join(logsDir(), `${id}.log`);
const lockFileOf = (root: string, target: string) => join(locksDir(), `${rootKey(root)}-${target}.lock`);
/** A plan is good for 15 minutes, once (§app.project-services/deploy-plan). */
export const PLAN_TTL_MS = 15 * 60_000;
const RUNNER = fileURLToPath(new URL("./deploy-runner.mjs", import.meta.url));
const requestsFile = () => join(deployRoot(), "requests.json");

const rootKey = (root: string) => createHash("sha256").update(root).digest("hex").slice(0, 12);
export const hash12 = (h: string) => h.replace(/^sha256:/, "").slice(0, 12);

function writeJson(file: string, v: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---- requests -----------------------------------------------------------------------------------------

export interface DeployRequest {
  project?: string;
  target?: string;
  commit?: string;
  ref?: string;
  plan?: string;
  /** The operator's typed reason to let a plan through with failing or missing tests. */
  overrideTests?: string;
  /** The operator's typed reason to let a plan through while main's tree is dirty. */
  overrideDirty?: string;
  confirm?: boolean;
  lines?: number;
  deploy?: string;
  why?: string;
  dismiss?: boolean;
}

const REQUEST_KEYS: Record<keyof DeployRequest, "string" | "number" | "boolean"> = {
  project: "string",
  target: "string",
  commit: "string",
  ref: "string",
  plan: "string",
  overrideTests: "string",
  overrideDirty: "string",
  confirm: "boolean",
  lines: "number",
  deploy: "string",
  why: "string",
  dismiss: "boolean",
};

export class DeployFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeployFailure";
  }
}

export function parseDeployRequest(body: unknown): DeployRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new DeployFailure("invalid-request", "the request is a JSON object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const want = REQUEST_KEYS[k as keyof DeployRequest];
    if (!want) throw new DeployFailure("invalid-request", `unknown request key "${k}"`);
    const ok = want === "number" ? typeof v === "number" && Number.isInteger(v) && v > 0 : typeof v === want && (want !== "string" || (v as string).trim() !== "");
    if (!ok) throw new DeployFailure("invalid-request", `"${k}" must be ${want === "number" ? "a whole number" : `a ${want}`}`);
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  for (const k of ["overrideTests", "overrideDirty", "why"] as const)
    if (typeof out[k] === "string" && (out[k] as string).length > 300) throw new DeployFailure("invalid-request", `"${k}" is at most 300 characters`);
  return out as DeployRequest;
}

// ---- who may call which deploy verb (§app.project-services/deploy-callers) ---------------------------

export const RUN_IS_OPERATORS = "Only the operator ships: run and rollback are theirs, from the project's Deploy panel or sova-project deploy.run --plan <id> --confirm.";
export const ASK_INSTEAD = "A deploy is the operator's: raise it with deploy.request {target, commit?, why}, and the operator opens its plan.";

/** Refuse `verb` for `caller` (on `root`), or return. */
export function authorizeDeploy(verb: DeployVerb, caller: Caller, root: string, req: DeployRequest): void {
  const inScope = (r: string | null) => {
    if (r !== root) throw new DeployFailure("forbidden", `this caller acts only on its own project${r ? ` (${r})` : ""}`);
  };
  if (caller.kind === "conform" || caller.kind === "system") throw new DeployFailure("forbidden", `${caller.kind === "conform" ? "conformance" : "Sova on its own"} never deploys`);
  if (caller.kind === "session" || caller.kind === "project-overseer") inScope(caller.root);
  if (verb === "deploy.status" || verb === "deploy.logs" || verb === "deploy.check") return;
  if (verb === "deploy.request") {
    if (caller.kind === "operator") {
      if (!req.dismiss) throw new DeployFailure("invalid-request", "the operator plans a deploy (deploy.plan); deploy.request {target, dismiss: true} clears an overseer's request");
      return;
    }
    if (caller.kind === "session") throw new DeployFailure("forbidden", "a coding session never asks for a deploy: tell the operator in your report");
    if (req.dismiss) throw new DeployFailure("forbidden", "only the operator clears a deploy request");
    return;
  }
  if (verb === "deploy.plan") {
    if (caller.kind === "operator" || caller.kind === "overseer") return;
    throw new DeployFailure("forbidden", caller.kind === "project-overseer" ? ASK_INSTEAD : "a coding session never plans a deploy");
  }
  // run, rollback
  if (caller.kind !== "operator") throw new DeployFailure("forbidden", caller.kind === "session" ? RUN_IS_OPERATORS : `${RUN_IS_OPERATORS} ${ASK_INSTEAD}`);
  if (!req.confirm) throw new DeployFailure("needs-confirm", verb === "deploy.run" ? "Shipping reaches every user: confirm it (sova-project deploy.run --plan <id> --confirm, or Deploy in the project's Deploy panel)." : "A rollback ships an earlier state to every user: confirm it (sova-project deploy.rollback --target <name> --confirm).");
}

// ---- notes (the project's software feed, §app.project-runtime/standing) -------------------------------

export interface DeployNote {
  at: string;
  line: string;
}
const NOTES_MAX = 20;

export function addDeployNote(root: string, line: string, at = new Date().toISOString()): void {
  const f = readJson<{ version: 1; notes: Record<string, DeployNote[]> }>(notesFile());
  const notes = f?.version === 1 && f.notes && typeof f.notes === "object" ? f.notes : {};
  notes[root] = [{ at, line }, ...(notes[root] ?? [])].slice(0, NOTES_MAX);
  writeJson(notesFile(), { version: 1, notes });
}

/** The project's deploy notes, newest first (its software feed shows them). */
export function deployNotes(root: string): DeployNote[] {
  const f = readJson<{ version: 1; notes: Record<string, DeployNote[]> }>(notesFile());
  return f?.version === 1 ? (f.notes?.[root] ?? []) : [];
}

/**
 * The operator approves the deploy recipe `seen` at `ref` (main's HEAD, or a verb playbook's branch tip) with
 * every step of its review ticked (§app.project-services/deploy-trust); the feed says so. Throws the refusal.
 */
export async function approveDeployRecipe(root: string, seen: string, ref: string, ticked: readonly string[]): Promise<void> {
  await approveDeployAtRef(root, seen, ref, ticked);
  addDeployNote(root, `You approved the deploy recipe ${hash12(seen)} on this host.`);
}

// ---- records ------------------------------------------------------------------------------------------

/** A deploy record on disk: what deploy.status shows, plus what the runner needs to find. */
export interface DeployRecord extends DeployRecordView {
  v: 1;
  project: string;
  /** The runner's process while it runs (it writes it), so a dead one reads as interrupted. */
  pid?: number;
}

export const recordFile = (id: string) => join(recordsDir(), `${id}.json`);

export function readRecord(id: string): DeployRecord | null {
  if (!/^dp_[0-9a-f]{16}$/.test(id)) return null;
  const r = readJson<DeployRecord>(recordFile(id));
  return r?.v === 1 ? r : null;
}

/** Every record of `root` (of `target`), newest first. */
export function recordsOf(root: string, target?: string): DeployRecord[] {
  let names: string[] = [];
  try {
    names = readdirSync(recordsDir()).filter((f) => /^dp_[0-9a-f]{16}\.json$/.test(f));
  } catch {
    return [];
  }
  const out: DeployRecord[] = [];
  for (const n of names) {
    const r = readJson<DeployRecord>(join(recordsDir(), n));
    if (r?.v === 1 && r.project === root && (!target || r.target === target)) out.push(r);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

export const viewOf = ({ v: _v, project: _p, pid: _pid, ...view }: DeployRecord): DeployRecordView => view;

// ---- requests (an overseer's ask) -------------------------------------------------------------------

type RequestsFile = { version: 1; requests: (DeployRequestView & { project: string })[] };

export function readRequests(): RequestsFile["requests"] {
  const f = readJson<RequestsFile>(requestsFile());
  return f?.version === 1 && Array.isArray(f.requests) ? f.requests : [];
}
function writeRequests(list: RequestsFile["requests"]): void {
  writeJson(requestsFile(), { version: 1, requests: list });
}
/** Clear `root`'s request for `target` (the operator planned it, or dismissed it). */
export function clearRequest(root: string, target: string): boolean {
  const all = readRequests();
  const keep = all.filter((r) => !(r.project === root && r.target === target));
  if (keep.length === all.length) return false;
  writeRequests(keep);
  return true;
}

// ---- the deployer --------------------------------------------------------------------------------------

/** What starts a deploy's runner as a transient unit of its own: `null` when started, else why not. */
export type Launch = (unit: string, argv: string[], cwd: string, timeoutSec: number) => Promise<string | null>;

export interface DeployerDeps {
  git?: Git;
  now?: () => number;
  /** Start the runner (default: a systemd transient unit when the engine's supervisor is systemd, else a detached session). */
  launch?: Launch;
  /** Run one check (a credential's check, a plan step) to its end: its exit and its last lines (tests fake it). */
  probe?: (unit: string, argv: string[], cwd: string, env: Record<string, string>, timeoutSec: number) => Promise<{ exit: number | null; lines: string[] }>;
  /** How often a running deploy's record is read. */
  watchMs?: number;
}

/** Everything one deploy verb run knows. */
interface DRun {
  verb: DeployVerb;
  caller: Caller;
  req: DeployRequest;
  root: string | null;
  steps: Step[];
  checks?: Check[];
  lines?: LogLine[];
  report?: DeployReport;
  defHash: string | null;
  approved: boolean;
  changed: boolean;
}

export class Deployer {
  readonly git: Git;
  readonly now: () => number;
  private readonly launchDep: Launch | undefined;
  private readonly probeDep: DeployerDeps["probe"];
  private readonly watchMs: number;
  private watching = new Map<string, ReturnType<typeof setInterval>>();
  /** Told when a deploy ends (the attention digest reads records; this only wakes it). */
  onEnded: ((r: DeployRecord) => void) | null = null;
  constructor(
    readonly engine: ProjectEngine,
    deps: DeployerDeps = {},
  ) {
    this.git = deps.git ?? realGit;
    this.now = deps.now ?? Date.now;
    this.launchDep = deps.launch;
    this.probeDep = deps.probe;
    this.watchMs = deps.watchMs ?? 1000;
  }

  /** Run one deploy verb for `caller`: every outcome is a result. */
  async run(verb: string, body: unknown, caller: Caller, _opts: { signal?: AbortSignal } = {}): Promise<VerbResult> {
    const run: DRun = { verb: (isDeployVerb(verb) ? verb : "deploy.status") as DeployVerb, caller, req: {}, root: null, steps: [], defHash: null, approved: false, changed: false };
    try {
      if (!isDeployVerb(verb)) throw new DeployFailure("invalid-request", `unknown verb "${verb}"`);
      run.req = parseDeployRequest(body);
      run.root = await this.projectRoot(run.req.project);
      authorizeDeploy(run.verb, caller, run.root, run.req);
      await this.dispatch(run);
      return this.result(run);
    } catch (err) {
      const f = err instanceof DeployFailure ? err : new DeployFailure("start-failed", err instanceof Error ? err.message : String(err));
      return this.result(run, f);
    }
  }

  private async projectRoot(path: string | undefined): Promise<string> {
    if (!path) throw new DeployFailure("invalid-request", "name the project (an absolute path inside it)");
    if (!isAbsolute(path)) throw new DeployFailure("invalid-request", "the project is an absolute path");
    const p = await projectOf(path);
    if (p.state !== "ok") throw new DeployFailure("not-found", p.state === "none" ? `no project at ${path}` : p.message);
    return p.root;
  }

  protected async dispatch(run: DRun): Promise<void> {
    switch (run.verb) {
      case "deploy.status":
        return this.status(run);
      case "deploy.check":
        return this.check(run);
      case "deploy.plan":
        return void (await this.plan(run, "deploy"));
      case "deploy.run":
        return this.runPlan(run);
      default:
        throw new DeployFailure("unsupported", `${run.verb} is not built yet`);
    }
  }

  private result(run: DRun, failure?: DeployFailure): VerbResult {
    const checksOk = run.verb !== "deploy.check" || !run.checks || run.checks.every((c) => c.ok);
    return ordered({
      v: 1,
      verb: run.verb as AnyVerb,
      project: run.root,
      instance: null,
      slot: null,
      generation: null,
      checkout: null,
      branch: null,
      ok: !failure && checksOk,
      changed: run.changed,
      state: "absent",
      steps: run.steps,
      services: [],
      data: [],
      links: [],
      ...(run.lines ? { lines: run.lines } : {}),
      ...(run.checks ? { checks: run.checks } : {}),
      ...(run.report ? { deploy: run.report } : {}),
      ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
      defHash: run.defHash,
      approved: run.approved,
      at: new Date(this.now()).toISOString(),
    });
  }

  /** Main's definition at HEAD, its deploy recipe and their hashes and approvals; refused when there is no definition. */
  protected async mainRecipe(run: DRun): Promise<{ deploy: DeployDecl | undefined; deployHash: string | null; approved: boolean; commit: string }> {
    const root = run.root!;
    const at = await definitionAt(root, "HEAD", this.git);
    if (!at.def || !at.commit) throw new DeployFailure(at.error?.startsWith("no ") ? "not-found" : "invalid-definition", `main's definition: ${at.error ?? "none"}`);
    run.defHash = defHashOf(at.def);
    run.approved = isApproved(root, run.defHash);
    const deployHash = at.def.deploy ? deployHashOf(at.def.deploy) : null;
    return { deploy: at.def.deploy, deployHash, approved: !!deployHash && !!deployApprovalOf(root, deployHash), commit: at.commit };
  }

  // ---- deploy.plan (§app.project-services/deploy-plan) ---------------------------------------------------

  /** The target in main's approved recipe, or the refusal. */
  protected async approvedTarget(run: DRun): Promise<{ deploy: DeployDecl; deployHash: string; target: DeployTargetDecl; mainBranch: string }> {
    const m = await this.mainRecipe(run);
    if (!run.req.target) throw new DeployFailure("invalid-request", "name the target");
    if (!m.deploy || !m.deployHash) throw new DeployFailure("not-found", "main's definition declares no deploy");
    const target = m.deploy.targets.find((t) => t.name === run.req.target);
    if (!target) throw new DeployFailure("not-found", `no deploy target ${run.req.target} on main (${m.deploy.targets.map((t) => t.name).join(", ")})`);
    if (!m.approved) throw new DeployFailure("not-approved", `the deploy recipe ${hash12(m.deployHash)} is not approved on this host: the operator approves it on the project's Deploy panel, each step ticked`);
    return { deploy: m.deploy, deployHash: m.deployHash, target, mainBranch: await mainBranchOf(run.root!, this.git) };
  }

  /** What a plan of `kind` runs, in order: build and steps, or the target's rollback steps. */
  private planSteps(t: DeployTargetDecl, kind: DeployKind) {
    if (kind === "rollback" && typeof t.rollback === "object" && "steps" in t.rollback) return t.rollback.steps.map((s) => ({ key: `rollback.${s.id}`, run: s.run, timeout: s.timeout }));
    return [...t.build.map((s) => ({ key: `build.${s.id}`, run: s.run, timeout: s.timeout })), ...t.steps.map((s) => ({ key: `steps.${s.id}`, run: s.run, timeout: s.timeout }))];
  }

  /** Render `t`'s argv (steps, checks, verify) for `commit` in `checkout` with this host's values; an unset host variable is named. */
  private renderTarget(root: string, t: DeployTargetDecl, kind: DeployKind, commit: string, checkout: string, branch: string) {
    const host = hostVars(root);
    const vars: Record<string, string> = { commit, target: t.name, checkout, branch };
    for (const [k, v] of Object.entries(host)) if (v !== "") vars[`host.${k}`] = v;
    const unset = new Set<string>();
    const r = (a: string) => {
      try {
        return render(a, vars);
      } catch {
        for (const m of a.matchAll(/\$\{host\.([^}]+)\}/g)) if (!vars[`host.${m[1]}`]) unset.add(m[1]!);
        return a;
      }
    };
    const steps = this.planSteps(t, kind).map((s) => ({ key: s.key, argv: s.run.map(r), timeoutSec: s.timeout }));
    const credentials = t.credentials.map((c) => ({ key: `credentials.${c.name}`, argv: c.check.map(r) }));
    const plan = kind === "deploy" ? t.plan.map((s) => ({ key: `plan.${s.id}`, argv: s.run.map(r), timeoutSec: s.timeout })) : [];
    const verify = t.verify ? { url: r(t.verify.http), expect: t.verify.expect, timeoutSec: t.verify.timeout } : null;
    const secrets: Record<string, string> = {};
    for (const c of t.credentials) if (c.kind === "env" && host[c.name]) secrets[c.name] = host[c.name]!;
    return { steps, credentials, plan, verify, secrets, unset: [...unset].sort() };
  }

  /** The digest that ties a plan to what it renders here: the steps, checks and verify with this host's values. */
  private varsHash(r: ReturnType<Deployer["renderTarget"]>): string {
    return createHash("sha256").update(JSON.stringify({ steps: r.steps, credentials: r.credentials, plan: r.plan, verify: r.verify, secrets: Object.keys(r.secrets).sort() })).digest("hex");
  }

  private envOf(t: DeployTargetDecl, commit: string, id: string): Record<string, string> {
    const e: Record<string, string> = { SOVA_V: "1", SOVA_DEPLOY_TARGET: t.name, SOVA_DEPLOY_COMMIT: commit, SOVA_DEPLOY_ID: id };
    for (const k of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"]) if (process.env[k]) e[k] = process.env[k]!;
    return e;
  }

  /** One check to its end, as a unit of its own (a credential's check, a plan step): its exit and its last lines, secrets redacted. */
  private async probeOnce(unit: string, argv: string[], cwd: string, env: Record<string, string>, timeoutSec: number, secrets: Record<string, string>): Promise<{ exit: number | null; lines: string[] }> {
    const out = this.probeDep
      ? await this.probeDep(unit, argv, cwd, env, timeoutSec)
      : await (async () => {
          const since = this.now();
          const r = await this.engine.driver.runOnce({ unit, argv, cwd, env, timeoutSec });
          const lines = (await this.engine.driver.logs(unit, 20, since).catch(() => [])).map((l) => l.text);
          return { exit: r.launchError ? null : r.timedOut ? null : r.code, lines: r.launchError ? [r.launchError, ...lines] : lines };
        })();
    return { exit: out.exit, lines: out.lines.map((l) => redactWith(secrets, l)) };
  }

  /**
   * Plan `kind` for the request's target (§app.project-services/deploy-plan): checks the commit in a fresh checkout
   * Sova cuts at it, never main's working tree, and answers a plan good for 15 minutes. Refused for good: not on the
   * target's branch, not pushed, a host value unset, a credential check or plan step failed. Refused unless the
   * operator typed a reason: the required tests failed or didn't run, main's tree is dirty.
   */
  protected async plan(run: DRun, kind: DeployKind, commitOverride?: string): Promise<DeployPlanView> {
    const root = run.root!;
    this.sweepPlans();
    const { deployHash, target: t, mainBranch } = await this.approvedTarget(run);
    if (kind === "deploy" && run.caller.kind === "operator" && clearRequest(root, t.name)) addDeployNote(root, `You opened the plan the overseer asked for: ${t.name}.`);
    const branch = t.branch ?? mainBranch;
    const checks: Check[] = [];
    run.checks = checks;
    const refuse = (code: ErrorCode, message: string): never => {
      throw new DeployFailure(code, message);
    };
    // The commit: the one asked for, else the target branch's tip.
    const want = commitOverride ?? run.req.commit ?? `refs/heads/${branch}`;
    const c = await this.git(["rev-parse", "--verify", "--quiet", `${want}^{commit}`], root);
    if (c.code !== 0) refuse("not-found", `no commit ${want} in ${root}`);
    const commit = c.stdout.trim();
    const onBranch = (await this.git(["merge-base", "--is-ancestor", commit, `refs/heads/${branch}`], root)).code === 0;
    checks.push({ id: "branch", ok: onBranch, detail: onBranch ? `${commit.slice(0, 12)} is on ${branch}` : `${commit.slice(0, 12)} is not on ${branch}, the branch ${t.name} ships from` });
    if (!onBranch) refuse("deploy-refused", checks.at(-1)!.detail);
    checks.push(await this.pushed(root, branch, commit));
    if (!checks.at(-1)!.ok) refuse("deploy-refused", checks.at(-1)!.detail);
    // Main's working tree can't ship (the checkout is fresh), but it can mislead: the operator's call.
    if (kind === "deploy") {
      const st = await this.git(["status", "--porcelain", "--untracked-files=no"], root);
      const dirty = st.stdout.split("\n").filter(Boolean).length;
      checks.push({ id: "dirty", ok: dirty === 0, detail: dirty === 0 ? "main's tree is clean" : `main's tree has ${dirty} uncommitted change${dirty === 1 ? "" : "s"}${run.req.overrideDirty ? `; let through: "${run.req.overrideDirty}"` : ""}` });
    }
    const id = randomBytes(8).toString("hex");
    const dir = await cutCheckout(this.git, root, commit, `plan-${id}`);
    let kept = false;
    try {
      const rendered = this.renderTarget(root, t, kind, commit, dir, branch);
      checks.push({ id: "host", ok: !rendered.unset.length, detail: rendered.unset.length ? `not set on this host: ${rendered.unset.join(", ")} (the operator sets them in Sova's host.json)` : "every host value the recipe reads is set" });
      if (rendered.unset.length) refuse("deploy-refused", checks.at(-1)!.detail);
      // The required tests, in a copy of the commit: setup runs as it does for any instance.
      if (kind === "deploy") checks.push(...(await this.tests(root, t, dir, run.req.overrideTests)));
      const env = this.envOf(t, commit, `plan-${id}`);
      for (const [i, cr] of rendered.credentials.entries()) {
        const p = await this.probeOnce(`sova-deploy-${stateHash()}-${id}-c${i}`, cr.argv, dir, { ...env, ...rendered.secrets }, 60, rendered.secrets);
        checks.push({ id: cr.key, ok: p.exit === 0, detail: p.exit === 0 ? `${cr.argv.join(" ")} passed` : `${cr.argv.join(" ")} ${p.exit === null ? "did not finish" : `exited with ${p.exit}`}${p.lines.length ? `: ${p.lines.slice(-3).join(" / ")}` : ""}` });
        if (p.exit !== 0) refuse("deploy-refused", `the credential check ${cr.key} failed: ${checks.at(-1)!.detail}`);
      }
      for (const [i, ps] of rendered.plan.entries()) {
        const p = await this.probeOnce(`sova-deploy-${stateHash()}-${id}-p${i}`, ps.argv, dir, { ...env, ...rendered.secrets }, ps.timeoutSec, rendered.secrets);
        checks.push({ id: ps.key, ok: p.exit === 0, detail: `${ps.argv.join(" ")} ${p.exit === 0 ? "ran" : p.exit === null ? "did not finish" : `exited with ${p.exit}`}${p.lines.length ? `: ${p.lines.slice(-5).join(" / ")}` : ""}` });
        if (p.exit !== 0) refuse("deploy-refused", `the plan step ${ps.key} failed: ${checks.at(-1)!.detail}`);
      }
      // The overridable ones, last: everything else had its say.
      const need: string[] = [];
      const testsBad = checks.find((x) => x.id === "tests" && !x.ok);
      const dirtyBad = checks.find((x) => x.id === "dirty" && !x.ok);
      if (testsBad && !run.req.overrideTests) need.push(`${testsBad.detail} (give overrideTests: your reason)`);
      if (dirtyBad && !run.req.overrideDirty) need.push(`${dirtyBad.detail} (give overrideDirty: your reason)`);
      if (need.length) refuse("needs-override", `Not planned: ${need.join("; ")}. The operator may let it through with a typed reason, which the project's feed records.`);
      if (run.caller.kind !== "operator" && (testsBad || dirtyBad)) refuse("needs-override", "only the operator lets a plan through");
      const overrides = { ...(testsBad ? { tests: run.req.overrideTests! } : {}), ...(dirtyBad ? { dirty: run.req.overrideDirty! } : {}) };
      const planId = `pl_${createHash("sha256").update(JSON.stringify([commit, deployHash, t.name, kind, this.varsHash(rendered)])).digest("hex").slice(0, 16)}`;
      const prior = readPlan(planId);
      if (prior && prior.checkout !== dir) await dropCheckout(this.git, root, prior.checkout);
      const createdAt = new Date(this.now());
      const view: DeployPlanView = {
        planId,
        project: root,
        target: t.name,
        kind,
        commit,
        deployHash,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
        checks,
        overrides,
        steps: rendered.steps.map((x) => ({ key: x.key, argv: x.argv })),
        verify: rendered.verify ? { url: rendered.verify.url, expect: rendered.verify.expect } : null,
      };
      writeJson(planFile(planId), { v: 1, ...view, checkout: dir, branch, varsHash: this.varsHash(rendered), by: byOf(run.caller), used: false });
      kept = true;
      for (const [k, why] of Object.entries(overrides))
        addDeployNote(root, `You let the plan of ${commit.slice(0, 7)} to ${t.name} through ${k === "tests" ? "without its required tests passing" : "with main's tree dirty"}: "${why}"`);
      run.report = { deployHash, approved: true, plan: view };
      run.changed = true;
      return view;
    } finally {
      if (!kept) await dropCheckout(this.git, root, dir);
    }
  }

  /** The commit is on the branch's upstream, read again from its remote (the git remote, never a deploy target). */
  private async pushed(root: string, branch: string, commit: string): Promise<Check> {
    const remote = (await this.git(["config", "--get", `branch.${branch}.remote`], root)).stdout.trim();
    const merge = (await this.git(["config", "--get", `branch.${branch}.merge`], root)).stdout.trim();
    if (!remote || !merge) return { id: "pushed", ok: false, detail: `${branch} has no upstream: push it first` };
    const f = await this.git(["fetch", "--quiet", remote, merge], root);
    if (f.code !== 0) return { id: "pushed", ok: false, detail: `${remote} could not be read (${f.stderr.trim().split("\n")[0] || `exit ${f.code}`}): nothing is planned on an unknown remote` };
    const up = (await this.git(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"], root)).stdout.trim();
    const ok = !!up && (await this.git(["merge-base", "--is-ancestor", commit, up], root)).code === 0;
    return { id: "pushed", ok, detail: ok ? `${commit.slice(0, 12)} is pushed to ${remote}` : `${commit.slice(0, 12)} is not pushed to ${remote}/${merge.replace(/^refs\/heads\//, "")}: push it first` };
  }

  /** The required tests in a copy of the commit (its setup first), torn down after: `setup` and `tests` checks. */
  private async tests(root: string, t: DeployTargetDecl, dir: string, override?: string): Promise<Check[]> {
    if (t.requires.tests === "none") return [{ id: "tests", ok: true, detail: "no tests required" }];
    const op: Caller = { kind: "operator" };
    const at = await definitionAt(root, "HEAD", this.git);
    const smoke = at.def?.test?.smoke ?? [];
    const r = await this.engine.run("test", { checkout: dir, ...(t.requires.tests === "smoke" ? { select: smoke } : {}) }, op);
    if (r.instance) await this.engine.run("teardown", { instance: r.instance }, op).catch(() => undefined);
    const setupFailed = r.steps.find((s) => s.kind === "setup" && s.result === "failed");
    const out: Check[] = [];
    if (r.steps.some((s) => s.kind === "setup")) out.push({ id: "setup", ok: !setupFailed, detail: setupFailed ? `setup ${setupFailed.id} failed: ${setupFailed.detail ?? ""}` : "setup ran in the fresh checkout" });
    const what = t.requires.tests === "smoke" ? "the smoke selection" : "the full suite";
    const tail = override ? `; let through: "${override}"` : "";
    if (r.tests?.pass) out.push({ id: "tests", ok: true, detail: `${what} passed${r.tests.passed !== null ? ` (${r.tests.passed} passed)` : ""}` });
    else if (r.tests) out.push({ id: "tests", ok: false, detail: `the required tests failed: ${what}${r.tests.failed !== null ? `, ${r.tests.failed} failed` : ""}${tail}` });
    else out.push({ id: "tests", ok: false, detail: `the required tests did not run: ${r.error?.code ?? "error"}: ${r.error?.message ?? "no result"}${tail}` });
    return out;
  }

  /** Expired plans that never ran: their checkouts removed, their files too. */
  private sweepPlans(): void {
    let names: string[] = [];
    try {
      names = readdirSync(plansDir()).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const n of names) {
      const p = readJson<StoredPlan>(join(plansDir(), n));
      if (!p || (Date.parse(p.expiresAt) > this.now() && !p.used)) continue;
      if (p.used && p.deployId && readRecord(p.deployId)?.state === "running") continue;
      void dropCheckout(this.git, p.project, p.checkout).finally(() => rmSync(join(plansDir(), n), { force: true }));
    }
  }

  // ---- deploy.run (§app.project-services/deploy-run) ------------------------------------------------------

  /** Ship a plan: the operator's, confirmed (authorizeDeploy). Answers at once with the record running. */
  private async runPlan(run: DRun): Promise<void> {
    const root = run.root!;
    if (!run.req.plan) throw new DeployFailure("invalid-request", "name the plan (deploy.plan answers its id)");
    const p = readPlan(run.req.plan);
    if (!p || p.project !== root) throw new DeployFailure("not-found", `no plan ${run.req.plan} for ${root}`);
    if (p.used) throw new DeployFailure("deploy-refused", `plan ${p.planId} already ran: plan again`);
    if (Date.parse(p.expiresAt) <= this.now()) throw new DeployFailure("deploy-refused", `plan ${p.planId} expired at ${p.expiresAt}: plan again`);
    run.req.target = p.target;
    await this.start(run, p);
  }

  /** Start `p` (a plan or a rollback's) under the target's lock, after checking it still holds. */
  protected async start(run: DRun, p: StoredPlan): Promise<DeployRecord> {
    const root = run.root!;
    const { deployHash, target: t } = await this.approvedTarget(run);
    if (deployHash !== p.deployHash) throw new DeployFailure("deploy-refused", `the deploy recipe changed since the plan (${hash12(p.deployHash)} → ${hash12(deployHash)}): plan again`);
    const rendered = this.renderTarget(root, t, p.kind, p.commit, p.checkout, p.branch);
    if (this.varsHash(rendered) !== p.varsHash) throw new DeployFailure("deploy-refused", "this host's values for the recipe changed since the plan: plan again");
    if (!existsSync(p.checkout)) throw new DeployFailure("deploy-refused", "the plan's checkout is gone: plan again");
    const running = recordsOf(root, t.name).find((r) => r.state === "running" && this.alive(r));
    if (running) throw new DeployFailure("busy", `${t.name} is deploying now (${running.id}, ${running.commit.slice(0, 7)}): one deploy at a time per target`);
    mkdirSync(locksDir(), { recursive: true });
    const lock = tryLock(lockFileOf(root, t.name));
    if ("heldBy" in lock) throw new DeployFailure("busy", `${t.name} is deploying now (pid ${lock.heldBy}): one deploy at a time per target`);
    const id = `dp_${randomBytes(8).toString("hex")}`;
    const rec: DeployRecord = {
      v: 1,
      project: root,
      id,
      target: t.name,
      kind: p.kind,
      commit: p.commit,
      planId: p.planId,
      deployHash,
      by: byOf(run.caller),
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
      state: "running",
      steps: [],
      verify: null,
      overrides: p.overrides,
    };
    writeJson(recordFile(id), rec);
    writeJson(planFile(p.planId), { ...p, used: true, deployId: id });
    mkdirSync(logsDir(), { recursive: true });
    const secretsFile = join(jobsDir(), `${id}.secrets.json`);
    writeJson(secretsFile, { values: rendered.secrets }, 0o600);
    const jobFile = join(jobsDir(), `${id}.json`);
    writeJson(jobFile, {
      id,
      recordFile: recordFile(id),
      logFile: deployLogFile(id),
      lockFile: lockFileOf(root, t.name),
      secretsFile,
      cwd: p.checkout,
      env: this.envOf(t, p.commit, id),
      steps: rendered.steps,
      verify: rendered.verify,
    });
    const total = rendered.steps.reduce((n, x) => n + x.timeoutSec, 0) + (rendered.verify?.timeoutSec ?? 0) + 120;
    const why = await this.launch(`sova-deploy-${stateHash()}-${id}`, [process.execPath, RUNNER, jobFile], p.checkout, total);
    if (why) {
      lock.release();
      rmSync(secretsFile, { force: true });
      writeJson(recordFile(id), { ...rec, state: "failed", detail: `the deploy could not start: ${why}`, endedAt: new Date(this.now()).toISOString() });
      throw new DeployFailure("deploy-failed", `the deploy could not start: ${why}`);
    }
    addDeployNote(root, `${p.kind === "rollback" ? "Rolling back" : "Deploying"} ${p.commit.slice(0, 7)} to ${t.name} (${id}).`);
    this.watch(id);
    run.report = { deployHash, approved: true, record: viewOf(rec) };
    run.changed = true;
    return rec;
  }

  private async launch(unit: string, argv: string[], cwd: string, timeoutSec: number): Promise<string | null> {
    if (this.launchDep) return this.launchDep(unit, argv, cwd, timeoutSec);
    await this.engine.driver.available().catch(() => undefined);
    if (this.engine.driver.id === "systemd") {
      const env = this.envOf({ name: "" } as DeployTargetDecl, "", "");
      const r = await realExec("systemd-run", [
        "--user",
        `--unit=${unit}`,
        `--slice=${SLICE}`,
        "--collect",
        "--quiet",
        `--working-directory=${cwd}`,
        "--property=KillMode=control-group",
        `--property=RuntimeMaxSec=${timeoutSec}`,
        ...["PATH", "HOME", "USER", "LANG", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"].filter((k) => env[k]).map((k) => `--setenv=${k}=${env[k]}`),
        "--",
        ...argv,
      ]);
      return r.code === 0 ? null : `systemd-run: ${r.stderr.trim() || `exit ${r.code}`}`;
    }
    return detachedLaunch(argv, cwd, join(logsDir(), `${unit}.runner.log`));
  }

  /** Whether a running record's runner is alive (its pid; a minute's grace before it wrote one). */
  private alive(r: DeployRecord): boolean {
    if (!r.pid) return this.now() - Date.parse(r.startedAt) < 60_000;
    try {
      process.kill(r.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Read a running deploy's record until it ends; a runner that died without saying so is marked interrupted. */
  watch(id: string): void {
    if (this.watching.has(id)) return;
    const tick = () => {
      const r = readRecord(id);
      if (!r) return this.unwatch(id);
      if (r.state === "running" && this.alive(r)) return;
      let done = r;
      if (r.state === "running") {
        done = { ...r, state: "interrupted", detail: "its runner stopped before it ended (the host restarted, or it was killed)", endedAt: new Date(this.now()).toISOString() };
        writeJson(recordFile(id), done);
        const lf = lockFileOf(r.project, r.target);
        try {
          if (readFileSync(lf, "utf8").trim() === String(r.pid ?? "")) rmSync(lf, { force: true });
        } catch {}
      }
      this.unwatch(id);
      this.ended(done);
    };
    const t = setInterval(tick, this.watchMs);
    t.unref?.();
    this.watching.set(id, t);
  }
  private unwatch(id: string): void {
    const t = this.watching.get(id);
    if (t) clearInterval(t);
    this.watching.delete(id);
  }
  /** Resolves once deploy `id` is no longer running (tests, the CLI's wait). */
  async settled(id: string, timeoutMs = 60_000): Promise<DeployRecord | null> {
    const until = this.now() + timeoutMs;
    for (;;) {
      const r = readRecord(id);
      if (!r || r.state !== "running") return r;
      if (Date.now() > until) return r;
      await new Promise((ok) => setTimeout(ok, 100));
    }
  }

  private ended(r: DeployRecord): void {
    const what = `${r.kind === "rollback" ? "The rollback of" : "The deploy of"} ${r.commit.slice(0, 7)} to ${r.target}`;
    addDeployNote(
      r.project,
      r.state === "succeeded"
        ? `${r.kind === "rollback" ? "Rolled back" : "Deployed"} ${r.commit.slice(0, 7)} to ${r.target}${r.verify ? `; ${r.verify.detail}` : ""}.`
        : r.state === "verify-failed"
          ? `${what} ran, and its verify failed: ${r.detail ?? ""}`
          : `${what} ${r.state === "interrupted" ? "was interrupted" : "failed"}: ${r.detail ?? ""}`,
      r.endedAt ?? undefined,
    );
    const p = readPlan(r.planId);
    if (p) void dropCheckout(this.git, r.project, p.checkout).finally(() => rmSync(planFile(r.planId), { force: true }));
    rmSync(join(jobsDir(), `${r.id}.json`), { force: true });
    rmSync(join(jobsDir(), `${r.id}.secrets.json`), { force: true });
    this.onEnded?.(r);
  }

  /** At server start: watch every deploy still running (its runner outlived the old server), or mark it interrupted. */
  reconcile(): string[] {
    const out: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(recordsDir()).filter((f) => /^dp_[0-9a-f]{16}\.json$/.test(f));
    } catch {
      return out;
    }
    for (const n of names) {
      const r = readJson<DeployRecord>(join(recordsDir(), n));
      if (r?.v !== 1 || r.state !== "running") continue;
      this.watch(r.id);
      out.push(`deploy ${r.id} of ${r.target} ${this.alive(r) ? "still runs: watching it" : "lost its runner: marking it interrupted"}`);
    }
    return out;
  }

  // ---- deploy.check (§app.project-services/deploy-check) ------------------------------------------------

  /**
   * The recipe at `ref` proven offline, in a fresh checkout of that commit: it parses, every step's program
   * resolves, every host variable and env credential it names is set on this host (presence, never value).
   * It runs no step and contacts no target. Checks like doctor's: `ok` false when one fails, exit 0.
   */
  private async check(run: DRun): Promise<void> {
    const root = run.root!;
    const ref = run.req.ref ?? "HEAD";
    const at = await definitionAt(root, ref, this.git);
    if (!at.commit) throw new DeployFailure("not-found", `no commit ${ref} in ${root}`);
    if (!at.def) throw new DeployFailure(at.error?.startsWith("no ") ? "not-found" : "invalid-definition", `the definition at ${ref}: ${at.error}`);
    if (!at.def.deploy) throw new DeployFailure("not-found", `the definition at ${ref} declares no deploy`);
    run.defHash = defHashOf(at.def);
    run.approved = isApproved(root, run.defHash);
    const d = at.def.deploy;
    const hash = deployHashOf(d);
    const host = hostVars(root);
    const checks: Check[] = [{ id: "schema", ok: true, detail: `the deploy recipe at ${ref} (${at.commit.slice(0, 12)}) parses: ${d.targets.length} target${d.targets.length === 1 ? "" : "s"} (${d.targets.map((t) => t.name).join(", ")})` }];
    const dir = await cutCheckout(this.git, root, at.commit, `check-${randomBytes(6).toString("hex")}`);
    try {
      const hostNames = new Set<string>();
      for (const t of d.targets) {
        const seen = new Set<string>();
        for (const s of deployStepsOf(t)) {
          for (const a of s.run) for (const m of a.matchAll(/\$\{host\.([^}]+)\}/g)) hostNames.add(m[1]!);
          const program = resolveHost(s.run[0]!, host);
          if (seen.has(program.text)) continue;
          seen.add(program.text);
          if (program.unset.length || program.text.includes("${")) {
            checks.push({ id: `program:${t.name}/${s.key}`, ok: false, detail: `its program ${s.run[0]} is a template this host can't resolve${program.unset.length ? ` (${program.unset.join(", ")} unset)` : ""}` });
            continue;
          }
          const r = resolveProgram(program.text, dir);
          checks.push({ id: `program:${t.name}/${s.key}`, ok: r.ok, detail: r.detail });
        }
        if (t.verify) for (const m of t.verify.http.matchAll(/\$\{host\.([^}]+)\}/g)) hostNames.add(m[1]!);
        for (const c of t.credentials)
          checks.push(
            c.kind === "env"
              ? { id: `credential:${t.name}/${c.name}`, ok: !!host[c.name], detail: host[c.name] ? `${c.name} is set on this host (its value is never shown)` : `${c.name} is not set on this host: the operator sets it in Sova's host.json` }
              : { id: `credential:${t.name}/${c.name}`, ok: true, detail: `${c.kind === "ssh" ? "an ssh key" : "a tool's login"}, kept by the tool: its check runs at plan, never here` },
          );
      }
      for (const n of [...hostNames].sort())
        checks.push({ id: `host:${n}`, ok: !!host[n], detail: host[n] ? `${n} is set on this host` : `${n} is not set on this host: the operator sets it in Sova's host.json` });
    } finally {
      await dropCheckout(this.git, root, dir);
    }
    run.checks = checks;
    const pass = checks.every((c) => c.ok);
    writeJson(join(checksDir(), `${rootKey(root)}-${hash12(hash)}.json`), { v: 1, project: root, ref, commit: at.commit, deployHash: hash, pass, checks, at: new Date(this.now()).toISOString() });
    run.report = { deployHash: hash, approved: !!deployApprovalOf(root, hash) };
  }

  // ---- deploy.status --------------------------------------------------------------------------------------

  private async status(run: DRun): Promise<void> {
    const root = run.root!;
    const m = await this.mainRecipe(run);
    const approvals = readDeployApprovals();
    const records = recordsOf(root);
    const requests = readRequests().filter((r) => r.project === root);
    const declared = m.deploy?.targets ?? [];
    const names = [...declared.map((t) => t.name), ...[...new Set(records.map((r) => r.target))].filter((n) => !declared.some((t) => t.name === n))];
    if (run.req.target && !names.includes(run.req.target)) throw new DeployFailure("not-found", `no deploy target ${run.req.target}${m.deploy ? "" : ": main's definition declares no deploy"}`);
    const at = m.deployHash ? approvals[root]?.[m.deployHash]?.at ?? null : null;
    const targets: DeployTargetView[] = names
      .filter((n) => !run.req.target || n === run.req.target)
      .map((name) => {
        const t = declared.find((x) => x.name === name);
        const mine = records.filter((r) => r.target === name);
        const verified = mine.find((r) => r.state === "succeeded");
        const req = requests.find((r) => r.target === name);
        return {
          name,
          about: t?.about ?? "No longer declared on main.",
          standing: targetStanding(root, m.deploy, name, approvals),
          approvedAt: at,
          last: mine[0] ? viewOf(mine[0]) : null,
          verifiedCommit: verified?.commit ?? null,
          rollback: !t ? { none: "No longer declared on main." } : typeof t.rollback === "string" ? t.rollback : "steps" in t.rollback ? "steps" : { none: t.rollback.none },
          request: req ? { id: req.id, target: req.target, commit: req.commit, why: req.why, by: req.by, at: req.at } : null,
        };
      });
    run.report = {
      deployHash: m.deployHash,
      approved: m.approved,
      targets,
      ...(m.deploy && !m.approved ? { review: deployReview(root, m.deploy, await mainBranchOf(root, this.git)) } : {}),
      ...(run.req.target ? { history: records.filter((r) => r.target === run.req.target).slice(0, 20).map(viewOf) } : {}),
    };
  }
}

// ---- fresh checkouts (never the main checkout's working tree) -------------------------------------------

/** Cut a detached worktree of `commit` under Sova's state, for a check or a plan. */
export async function cutCheckout(git: Git, root: string, commit: string, name: string): Promise<string> {
  const dir = join(checkoutsDir(), name);
  mkdirSync(checkoutsDir(), { recursive: true });
  const r = await git(["worktree", "add", "--detach", "--force", dir, commit], root);
  if (r.code !== 0) throw new DeployFailure("start-failed", `cutting a fresh checkout of ${commit.slice(0, 12)} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return dir;
}
/** Remove a checkout cut by `cutCheckout`, whatever it holds. */
export async function dropCheckout(git: Git, root: string, dir: string): Promise<void> {
  if (!dir.startsWith(checkoutsDir() + "/")) return;
  await git(["worktree", "remove", "--force", "--force", dir], root);
  rmSync(dir, { recursive: true, force: true });
  await git(["worktree", "prune"], root);
}

/** Where `program` (an argv's first word) resolves, from `cwd`, or why it doesn't. Reads only. */
export function resolveProgram(program: string, cwd: string, path = process.env.PATH ?? ""): { ok: boolean; detail: string } {
  const executable = (f: string) => {
    try {
      if (!statSync(f).isFile()) return false;
      accessSync(f, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (program.includes("/")) {
    const f = isAbsolute(program) ? program : resolve(cwd, program);
    if (executable(f)) return { ok: true, detail: isAbsolute(program) ? `${program} is executable` : `${program} is in the checkout and executable` };
    return { ok: false, detail: existsSync(f) ? `${program} is not executable` : `${program} is not ${isAbsolute(program) ? "on this host" : "in a fresh checkout of the commit"}` };
  }
  for (const d of path.split(delimiter).filter(Boolean)) if (executable(join(d, program))) return { ok: true, detail: `${program} is on PATH (${join(d, program)})` };
  return { ok: false, detail: `${program} is not on PATH` };
}

// ---- plans ------------------------------------------------------------------------------------------------

export interface StoredPlan extends DeployPlanView {
  v: 1;
  checkout: string;
  branch: string;
  varsHash: string;
  by: string;
  used: boolean;
  deployId?: string;
}
export const planFile = (id: string) => join(plansDir(), `${id}.json`);
export function readPlan(id: string): StoredPlan | null {
  if (!/^pl_[0-9a-f]{16}$/.test(id)) return null;
  const p = readJson<StoredPlan>(planFile(id));
  return p?.v === 1 ? p : null;
}

/** `text` with each secret value replaced by `[redacted:<NAME>]`. Pure. */
export function redactWith(secrets: Readonly<Record<string, string>>, text: string): string {
  return Object.entries(secrets)
    .filter(([, v]) => v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
    .reduce((t, [k, v]) => t.split(v).join(`[redacted:${k}]`), text);
}

/** Start `argv` in a session of its own that outlives this process (no systemd): null when started. */
function detachedLaunch(argv: string[], cwd: string, logFile: string): Promise<string | null> {
  return new Promise((done) => {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ["ignore", fd, fd] });
      child.once("error", (err) => done(err.message));
      child.once("spawn", () => {
        child.unref();
        done(null);
      });
    } catch (err) {
      done(err instanceof Error ? err.message : String(err));
    } finally {
      closeSync(fd);
    }
  });
}

/** The caller tag a record keeps (`operator`, `overseer:<id>` …). */
export const byOf = (c: Caller): string => callerTag(c);
