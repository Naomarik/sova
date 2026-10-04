import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  deployStepsOf,
  isDeployVerb,
  ordered,
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
import { servicesRoot } from "./store";
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

export interface DeployerDeps {
  git?: Git;
  now?: () => number;
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
  constructor(
    readonly engine: ProjectEngine,
    deps: DeployerDeps = {},
  ) {
    this.git = deps.git ?? realGit;
    this.now = deps.now ?? Date.now;
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

/** The caller tag a record keeps (`operator`, `overseer:<id>` …). */
export const byOf = (c: Caller): string => callerTag(c);
