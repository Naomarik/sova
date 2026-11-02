/**
 * What a merge run checks, and running one check in the merge copy.
 *
 * The list comes from the TARGET's definition (never the branch's): its `merge.checks` (the required set; `optional`
 * ones only when the merge thread picks them), else its `test` command, else nothing ("unset": the queue accepts no
 * approval), or `"none"` declared (lands after a clean merge, labelled "No checks declared"). The merge thread can add
 * checks (picks), never drop one. A check with nothing to do exits 0 and writes `{skipped: "<why>"}` to SOVA_OUT.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckPick, CheckSource, ChecksDeclared, RunStep } from "../../shared/merge-queue";
import type { Argv, MergeCheckDecl, ProjectDef } from "../../shared/project-contract";
import { portsFor, render } from "../../shared/project-contract";
import { inheritedEnv } from "../project-services/env-allow";
import { runProc, type Proc } from "./copy";

/** What the project declares for its checks. */
export function checksOf(def: ProjectDef | null): ChecksDeclared {
  if (def?.merge?.checks === "none") return "none";
  if (Array.isArray(def?.merge?.checks)) return "declared";
  if (def?.test) return "test-command";
  return "unset";
}

/** One check as the run runs it: its declaration and where it came from. */
export interface PlannedCheck {
  id: string;
  label: string;
  run: Argv;
  timeoutSec: number;
  rerun: boolean;
  requires: string[];
  source: CheckSource;
  why?: string;
  /** Selectors appended to `run` (a pick that narrows a check). */
  select?: string[];
  /** The merge thread picked it: it runs with SOVA_MERGE_PICKED=1, so a check that runs only when triggered runs. */
  picked?: true;
}

const fromDecl = (c: MergeCheckDecl, source: CheckSource, why?: string, select?: string[]): PlannedCheck => ({
  id: c.id,
  label: c.label,
  run: c.run,
  timeoutSec: c.timeout,
  rerun: c.rerun,
  requires: c.requires,
  source,
  ...(why ? { why } : {}),
  ...(select?.length ? { select } : {}),
});

/**
 * The checks a run runs, in order: the required ones (declaration order), then each pick. A pick naming a required
 * check with no selectors marks it picked (source and why shown; it runs even when nothing triggers it); with
 * selectors it runs again narrowed; naming an optional check runs that check; naming nothing declared is dropped (the
 * thread can't add commands, nor drop one). `"none"` and `"unset"` give an empty list.
 */
export function planChecks(def: ProjectDef | null, picks: readonly CheckPick[] = []): PlannedCheck[] {
  const declared = checksOf(def);
  if (declared === "none" || declared === "unset") return [];
  const decls: MergeCheckDecl[] =
    declared === "declared"
      ? (def!.merge!.checks as MergeCheckDecl[])
      : [{ id: "test", label: "Tests", run: def!.test!.run, timeout: def!.test!.timeout, rerun: true, requires: def!.test!.requires }];
  const out = decls.filter((c) => !c.optional).map((c) => fromDecl(c, "required"));
  for (const p of picks) {
    const d = decls.find((c) => c.id === p.id);
    if (!d) continue;
    const select = (p.select ?? []).filter((s) => typeof s === "string" && s && !s.startsWith("-"));
    if (!d.optional && !select.length) {
      const req = out.find((c) => c.id === d.id)!;
      if (!req.picked) Object.assign(req, { source: "picked" as const, picked: true as const, ...(p.why ? { why: p.why } : {}) });
      continue;
    }
    const id = out.some((c) => c.id === d.id) ? `${d.id}+${out.filter((c) => c.id === d.id || c.id.startsWith(`${d.id}+`)).length}` : d.id;
    out.push({ ...fromDecl(d, "picked", p.why, select), picked: true, id, label: select.length ? `${d.label} (${select.length === 1 ? select[0] : `${select.length} selected`})` : d.label });
  }
  return out;
}

/** The CheckPick list the queue shows (hooks.checks). */
export const picksOf = (list: readonly PlannedCheck[]): CheckPick[] =>
  list.map((c) => ({ id: c.id, label: c.label, source: c.source, ...(c.why ? { why: c.why } : {}), ...(c.select ? { select: c.select } : {}) }));

// ---- environment ----------------------------------------------------------------------------------

/** What a check inherits from the server: the engine's own allow-list (no secret, no chat or repository variable;
 *  the XDG homes and mise's settings, so its mise is the server's), plus where the agent dir and spec tools are. */
const CHECK_EXTRA = ["PI_CODING_AGENT_DIR", "SOVA_SPEC_CORE", "SOVA_RUNTIME", "SOVA_BUN"];

/** The facts a run gives its processes and templates. */
export interface CopyScope {
  project: string;
  /** The project's id. */
  projectId: string;
  copy: string;
  /** The slot whose ports the copy's processes may use (above every copy's and conformance's). */
  slot: number;
  /** A folder of the run's own for data and SOVA_DATA (under the state root: records, never the copy). */
  data: string;
  target: string;
  base: string;
  tip?: string;
  /** The file listing the changed paths. */
  changedFile?: string;
  /** This project's private-names file for the leak scan (SOVA_LEAK_NAMES); absent: none set up. */
  leakNames?: string;
}

export function templateVarsOf(def: ProjectDef, s: CopyScope): Record<string, string> {
  const v: Record<string, string> = {
    slot: String(s.slot),
    instance: `merge-${s.projectId}`,
    project: s.project,
    checkout: s.copy,
    main: s.project,
    branch: "",
    data: s.data,
    "merge.base": s.base,
    "merge.tip": s.tip ?? "HEAD",
    "merge.target": s.target,
  };
  for (const d of def.data) v[`data.${d.name}`] = d.kind === "dir" && d.path ? join(s.copy, d.path) : join(s.data, d.name);
  for (const [svc, ps] of Object.entries(portsFor(def, s.slot))) for (const [k, n] of Object.entries(ps)) v[`ports.${svc}.${k}`] = String(n);
  for (const h of def.host) v[`host.${h}`] ??= "";
  return v;
}

export function envOf(def: ProjectDef, s: CopyScope, extra: { step?: string; out?: string; picked?: boolean } = {}): Record<string, string> {
  const e: Record<string, string> = inheritedEnv(process.env, CHECK_EXTRA);
  Object.assign(e, {
    SOVA_V: "1",
    SOVA_PROJECT: s.project,
    SOVA_INSTANCE: `merge-${s.projectId}`,
    SOVA_SLOT: String(s.slot),
    SOVA_CHECKOUT: s.copy,
    SOVA_MAIN: s.project,
    SOVA_BRANCH: "",
    SOVA_DATA: s.data,
    SOVA_VERB: "merge",
    SOVA_MERGE_BASE: s.base,
    SOVA_MERGE_TIP: s.tip ?? "HEAD",
    SOVA_MERGE_TARGET: s.target,
    ...(s.changedFile ? { SOVA_MERGE_CHANGED: s.changedFile } : {}),
    // Each project's own names: never another project's, never the server's.
    SOVA_LEAK_NAMES: s.leakNames ?? join(s.data, "no-private-names.json"),
    ...(extra.step ? { SOVA_STEP: extra.step } : {}),
    ...(extra.out ? { SOVA_OUT: extra.out } : {}),
    ...(extra.picked ? { SOVA_MERGE_PICKED: "1" } : {}),
  });
  for (const [svc, ps] of Object.entries(portsFor(def, s.slot))) for (const [k, n] of Object.entries(ps)) e[`SOVA_PORT_${svc.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = String(n);
  return e;
}

// ---- a check's report -----------------------------------------------------------------------------

export interface CheckReport {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** Nothing to do: why. */
  skippedWhy?: string;
  failures: { name?: string; file?: string; message?: string }[];
  /** Every failing test file, when the runner names them (uncapped). */
  failingFiles: string[];
  notes: string[];
}

/** SOVA_OUT as a check wrote it; null when it wrote nothing readable. Lenient: a runner writes what it can. */
export function readCheckOut(file: string): CheckReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
  const failures: CheckReport["failures"] = [];
  for (const f of Array.isArray(o.failures) ? o.failures.slice(0, 50) : []) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    const one = { ...(str(x.name, 500) ? { name: str(x.name, 500)! } : {}), ...(str(x.file, 500) ? { file: str(x.file, 500)! } : {}), ...(str(x.message, 2000) ? { message: str(x.message, 2000)! } : {}) };
    if (Object.keys(one).length) failures.push(one);
  }
  const listed = Array.isArray(o.failingFiles) ? o.failingFiles.filter((f): f is string => typeof f === "string" && !!f) : [];
  const failingFiles = [...new Set(listed.length ? listed : failures.flatMap((f) => (f.file ? [f.file] : [])))];
  const skippedWhy = typeof o.skipped === "string" && o.skipped ? o.skipped.slice(0, 300) : undefined;
  return {
    passed: n(o.passed),
    failed: n(o.failed),
    skipped: typeof o.skipped === "number" ? n(o.skipped) : null,
    ...(skippedWhy ? { skippedWhy } : {}),
    failures,
    failingFiles,
    notes: Array.isArray(o.notes) ? o.notes.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 10) : [],
  };
}

/** A test file a runner's own output names as failing, when it wrote no SOVA_OUT (node:test, run-tests' FAIL lines). */
export function failingFilesIn(output: string): string[] {
  const files = new Set<string>();
  const re = /(?:test at |✖ |not ok \d+ - |^\s*FAIL )(?:file:\/\/)?(\S+?\.test\.[cm]?[jt]sx?)\b/gm;
  for (const m of output.matchAll(re)) if (!m[1]!.startsWith("/")) files.add(m[1]!.replace(/^\.\//, ""));
  return [...files];
}

// ---- running one ----------------------------------------------------------------------------------

export interface CheckRun {
  proc: Proc;
  report: CheckReport | null;
  /** The files it names as failing (SOVA_OUT, else its output). */
  failingFiles: string[];
}

/** Run `check` (with `files` appended, for a rerun) in the copy, its output appended to `logFile`. */
export async function runCheck(o: {
  def: ProjectDef;
  scope: CopyScope;
  check: PlannedCheck;
  stepId: string;
  logFile: string;
  files?: string[];
  signal?: AbortSignal;
}): Promise<CheckRun> {
  const vars = templateVarsOf(o.def, o.scope);
  const argv = [...o.check.run.map((a) => render(a, vars)), ...(o.check.select ?? []), ...(o.files ?? [])];
  const out = `${o.logFile}.out.json`;
  rmSync(out, { force: true });
  mkdirSync(dirname(o.logFile), { recursive: true });
  const log = (s: string) => writeFileSync(o.logFile, s, { flag: "a" });
  log(`$ ${argv.join(" ")}\n`);
  const proc = await runProc(argv, { cwd: o.scope.copy, env: envOf(o.def, o.scope, { step: o.stepId, out, picked: !!o.check.picked }), timeoutMs: o.check.timeoutSec * 1000, ...(o.signal ? { signal: o.signal } : {}), log });
  log(`\n[exit ${proc.code}${proc.timedOut ? `, timed out after ${o.check.timeoutSec} s` : ""}${proc.aborted ? ", aborted" : ""}, ${Math.round(proc.ms / 1000)} s]\n`);
  const report = readCheckOut(out);
  const failingFiles = report?.failingFiles.length ? report.failingFiles : proc.code !== 0 ? failingFilesIn(proc.out) : [];
  return { proc, report, failingFiles };
}

/** The step's counts as the run shows them. */
export const countsOf = (r: CheckReport | null): RunStep["counts"] => (r ? { passed: r.passed, failed: r.failed, skipped: r.skipped } : null);
