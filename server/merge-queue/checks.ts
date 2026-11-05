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
export function planChecks(def: ProjectDef | null, picks: readonly CheckPick[] = [], release: readonly MergeCheckDecl[] = []): PlannedCheck[] {
  const declared = checksOf(def);
  if (declared === "unset") return [];
  if (declared === "none") return withRelease([], release);
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
  return withRelease(out, release);
}

/** A release entry's gating checks (the release section's, resolved), after the merge set, in order; one the list
 *  already runs in full (a required merge check the release names again) runs once. */
function withRelease(out: PlannedCheck[], release: readonly MergeCheckDecl[]): PlannedCheck[] {
  for (const c of release) {
    const have = out.find((x) => x.id === c.id && !x.select);
    if (have) continue;
    out.push({ ...fromDecl(c, "release"), why: "a release gate", picked: true });
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

/** The share of would-be-reused test files a landing's check re-runs anyway (at least one: the runner's rule). */
export const REUSE_SAMPLE = "0.05";

/**
 * Whether a check runs fresh (SOVA_FRESH=1: reuse nothing, still record its passes): a rerun on the tip or on the
 * target alone (each exists to get new evidence), every check of a release entry (its own gates and the merge set
 * alike), and every check when the project file turns reuse off (`merge.reuse: false`). Pure.
 */
export function freshOf(def: ProjectDef | null, o: { rerun?: boolean; release?: boolean }): boolean {
  return !!o.rerun || !!o.release || def?.merge?.reuse === false;
}

/** What a check's process is told about reuse: fresh, or the re-check share. Never for a setup or install step. */
export const reuseEnvOf = (fresh: boolean): Record<string, string> => (fresh ? { SOVA_FRESH: "1" } : { SOVA_REUSE_SAMPLE: REUSE_SAMPLE });

export function envOf(def: ProjectDef, s: CopyScope, extra: { step?: string; out?: string; picked?: boolean; fresh?: boolean } = {}): Record<string, string> {
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
    ...(extra.fresh !== undefined ? reuseEnvOf(extra.fresh) : {}),
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
  /** Every failing test's name (uncapped, unique, as testKey reads it), for a runner that names tests but no file
   *  (Kaocha). */
  failingNames: string[];
  /** The test files the runner says it actually ran (`ranFiles`), when it says so; absent from a runner that doesn't. */
  ranFiles?: string[];
  /** Test files that already passed on identical code and weren't run again (SOVA_OUT `reused`), when any. */
  reused?: ReusedReport;
  notes: string[];
}

/** SOVA_OUT's `reused`: `files` of the `of` selected weren't run (an earlier pass on identical code stands), `rechecked`
 *  more would have been and ran anyway (the random re-check); `at`/`from` the newest source; `list` each one's source. */
export interface ReusedReport {
  files: number;
  of: number;
  rechecked: number;
  at?: string;
  from?: string;
  list: { file: string; at?: string; from?: string; run?: string }[];
}

/** SOVA_OUT's `reused`, read leniently; null when absent or unreadable. */
function readReused(v: unknown): ReusedReport | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
  const files = n(o.files);
  const of = n(o.of);
  if (files === null || of === null || files > of) return null;
  const str = (x: unknown, max = 200) => (typeof x === "string" && x ? x.slice(0, max) : undefined);
  const list: ReusedReport["list"] = [];
  for (const x of Array.isArray(o.list) ? o.list.slice(0, 5000) : []) {
    if (!x || typeof x !== "object") continue;
    const y = x as Record<string, unknown>;
    const file = str(y.file, 500);
    if (!file) continue;
    const at = str(y.at);
    const from = str(y.from);
    const run = str(y.run);
    list.push({ file, ...(at ? { at } : {}), ...(from ? { from } : {}), ...(run ? { run } : {}) });
  }
  const at = str(o.at);
  const from = str(o.from);
  return { files, of, rechecked: Math.min(n(o.rechecked) ?? 0, of - files), ...(at ? { at } : {}), ...(from ? { from } : {}), list };
}

/**
 * A passed check's detail when it reused passes: "412 ran, 568 already passed on identical code (28 re-checked)".
 * The two split the selection: "ran" the files with no pass on identical code, "already passed" every file with one,
 * the re-checked ones (which ran again) among them. Null when nothing was reused. Pure.
 */
export function reusedWords(r: Pick<ReusedReport, "files" | "of" | "rechecked">): string | null {
  if (r.files <= 0 && r.rechecked <= 0) return null;
  const ran = Math.max(0, r.of - r.files - r.rechecked);
  const hits = r.files + r.rechecked;
  return `${ran} ran, ${hits} already passed on identical code${r.rechecked ? ` (${r.rechecked} re-checked)` : ""}`;
}

/**
 * A failing test's name as compared across runs: the runner's verdict word and the file:line it points at dropped, so
 * the same test failing on the merge and on the target reads as one even when the branch moved its lines, and two
 * assertions of one test are one failure. "FAIL in (app.access-test/account-sign-in) (access_test.clj:74)" (Kaocha)
 * → "app.access-test/account-sign-in".
 */
export function testKey(name: string): string {
  let s = name.trim().replace(/^(?:FAIL(?:ED)?|ERROR|not ok \d+)\s*(?:in\b|-)?\s*/i, "");
  // A trailing location: " (file.ext:12)", " (file.ext:12:3)", or ":12" / ":12:3" glued to the name.
  s = s.replace(/\s*\([^()]*:\d+(?::\d+)?\)\s*$/, "").replace(/:\d+(?::\d+)?$/, "").trim();
  const wrapped = /^\(([^()]+)\)$/.exec(s);
  return (wrapped ? wrapped[1]!.trim() : s) || name.trim();
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
  const failingNames = [...new Set((Array.isArray(o.failures) ? o.failures : []).flatMap((f) => (f && typeof f === "object" && typeof (f as Record<string, unknown>).name === "string" && (f as Record<string, unknown>).name ? [testKey(String((f as Record<string, unknown>).name).slice(0, 500))] : [])).filter(Boolean))];
  const skippedWhy = typeof o.skipped === "string" && o.skipped ? o.skipped.slice(0, 300) : undefined;
  const ranFiles = Array.isArray(o.ranFiles) ? [...new Set(o.ranFiles.filter((f): f is string => typeof f === "string" && !!f))] : undefined;
  const reused = readReused(o.reused);
  return {
    passed: n(o.passed),
    failed: n(o.failed),
    // A string `skipped` is the why; the skipped-test count then rides in `skippedTests` (never lost).
    skipped: typeof o.skipped === "number" ? n(o.skipped) : n(o.skippedTests),
    ...(skippedWhy ? { skippedWhy } : {}),
    failures,
    failingFiles,
    failingNames,
    ...(ranFiles ? { ranFiles } : {}),
    ...(reused ? { reused } : {}),
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

/**
 * The command that reruns `check` on named test files. A check that is the project's own test command (`test.run`,
 * found whole inside the check's command, after any wrapper such as `nice`) with selection flags after it is rerun as
 * that command alone with the files: the flags select files (Sova's `--integration --landing --base …` drops a group
 * file the change doesn't trigger, named or not), and a rerun asks for exactly the files that failed. Any other check
 * gets the files appended to its own command and selectors.
 */
export function rerunArgvOf(def: ProjectDef, check: Pick<PlannedCheck, "run" | "select">, rendered: readonly string[]): string[] {
  const test = def.test?.run ?? [];
  if (test.length && test.length < check.run.length) {
    for (let i = 0; i + test.length <= check.run.length; i++) {
      if (test.every((a, j) => check.run[i + j] === a)) return i + test.length < check.run.length ? rendered.slice(0, i + test.length) : [...rendered, ...(check.select ?? [])];
    }
  }
  return [...rendered, ...(check.select ?? [])];
}

/**
 * A test check: one whose command is the project's own test command (`test.run`, found whole inside the check's
 * command, after any wrapper such as `nice`, with any selection flags after it: the same reading rerunArgvOf makes).
 * Only such a check is ever "broken on the target" (it ran no test at all, everywhere): a build or typecheck that
 * fails on both sides keeps its own rules. A project with no `test.run` has no test check. Pure.
 */
export function isTestCheck(def: Pick<ProjectDef, "test"> | null, check: Pick<PlannedCheck, "run">): boolean {
  const test = def?.test?.run ?? [];
  if (!test.length || test.length > check.run.length) return false;
  for (let i = 0; i + test.length <= check.run.length; i++) if (test.every((a, j) => check.run[i + j] === a)) return true;
  return false;
}

/** A failed run that shows it ran no test: its report counts none and names no failing file or test. No report shows
 *  nothing (a crash midway, or a runner that writes none: real failures may be in there). */
export function ranNoTest(r: Pick<CheckRun, "failingFiles" | "report">): boolean {
  if (!r.report || r.failingFiles.length || r.report.failingNames.length || r.report.ranFiles?.length) return false;
  return (r.report.passed ?? 0) + (r.report.failed ?? 0) === 0;
}

/** The first line a run printed that isn't the runner's own framing (the log's `$ …` and `[…]` lines): its error. */
export function firstOutputLine(out: string): string | undefined {
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith("$ ") && !/^\[.*\]$/.test(line)) return line.slice(0, 200);
  }
  return undefined;
}

/** Run `check` (with `files` appended, for a rerun) in the copy, its output appended to `logFile`. */
export async function runCheck(o: {
  def: ProjectDef;
  scope: CopyScope;
  check: PlannedCheck;
  stepId: string;
  logFile: string;
  files?: string[];
  /** SOVA_FRESH=1 (freshOf); else SOVA_REUSE_SAMPLE. */
  fresh: boolean;
  signal?: AbortSignal;
}): Promise<CheckRun> {
  const vars = templateVarsOf(o.def, o.scope);
  const rendered = o.check.run.map((a) => render(a, vars));
  const argv = o.files?.length ? [...rerunArgvOf(o.def, o.check, rendered), ...o.files] : [...rendered, ...(o.check.select ?? [])];
  const out = `${o.logFile}.out.json`;
  rmSync(out, { force: true });
  mkdirSync(dirname(o.logFile), { recursive: true });
  const log = (s: string) => writeFileSync(o.logFile, s, { flag: "a" });
  log(`$ ${argv.join(" ")}\n`);
  log(o.fresh ? "[fresh: every test file runs (SOVA_FRESH=1)]\n" : `[passes from identical code may stand; ${Number(REUSE_SAMPLE) * 100}% of them re-checked (SOVA_REUSE_SAMPLE=${REUSE_SAMPLE})]\n`);
  const proc = await runProc(argv, { cwd: o.scope.copy, env: envOf(o.def, o.scope, { step: o.stepId, out, picked: !!o.check.picked, fresh: o.fresh }), timeoutMs: o.check.timeoutSec * 1000, ...(o.signal ? { signal: o.signal } : {}), log });
  log(`\n[exit ${proc.code}${proc.timedOut ? `, timed out after ${o.check.timeoutSec} s` : ""}${proc.aborted ? ", aborted" : ""}, ${Math.round(proc.ms / 1000)} s]\n`);
  const report = readCheckOut(out);
  const failingFiles = report?.failingFiles.length ? report.failingFiles : proc.code !== 0 ? failingFilesIn(proc.out) : [];
  return { proc, report, failingFiles };
}

/** The step's counts as the run shows them. */
export const countsOf = (r: CheckReport | null): RunStep["counts"] => (r ? { passed: r.passed, failed: r.failed, skipped: r.skipped } : null);
