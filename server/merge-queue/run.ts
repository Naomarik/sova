/**
 * One merge run, start to verdict (server/merge-queue/contract.ts RunMerge). It owns the merge copy and nothing else:
 * it never touches the project's main checkout, the target branch or the remote.
 *
 *   copy     the copy beside the project (never under the state root), reset to the target's head
 *   merge    the pinned commit merged --no-ff (or the thread's resolution taken); a conflict ends the run
 *   setup    the definition's setup steps on the merged tree (unchanged inputs: skipped), logged
 *   install  the project's offline install, when the branch changes one of its inputs (a lockfile)
 *   docs     the approved spec drafts copied in and made official as one docs commit, before any check
 *   checks   required + picked, in order, each logged; the review step beside them, in parallel
 *   reruns   a red check's failing files again on the tip, then on the target alone in the same copy
 *
 * Every step has a log under the run's folder from its first line. A timeout, an abort or a stopped server is void.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CheckPick, MergeNote, ReviewVerdict, RunStep, RunStepKind, StepResult } from "../../shared/merge-queue";
import type { ProjectDef, StepDecl } from "../../shared/project-contract";
import { render } from "../../shared/project-contract";
import { slotLayoutOf } from "../../shared/project-slots";
import { agentRoot } from "../state-root";
import { blameCheck, blameFile, blameSetup, type CheckBlame, summarize } from "./attribute";
import { checksOf, countsOf, type CopyScope, envOf, type PlannedCheck, picksOf, planChecks, runCheck, templateVarsOf } from "./checks";
import type { RunHooks, RunInput, RunMerge, RunOutcome } from "./contract";
import { assertCopyOutsideState, CopyRefused, gitOut, gitProc, mergeCopyPath, moveCopy, prepareCopy, runProc } from "./copy";
import { reviewStep, type ReviewDeps } from "./review-step";

export interface RunDeps extends ReviewDeps {
  /** The state root and home the copy must stay out of (tests move them). */
  state?: string;
  home?: string;
  /** The spec tools' folder (sova-spec-draft.mjs): SOVA_SPEC_CORE, else the agent's extensions/spec/core. */
  specCore?: string;
  /** Brings up services a check requires, in the copy; returns the slot its ports are numbered by, and how to stop
   *  them. Absent: a check that requires services fails as a machine problem (nothing can start them). */
  services?: (o: { root: string; copy: string; names: string[]; log: (s: string) => void; signal: AbortSignal }) => Promise<{ slot: number; down: () => Promise<void> }>;
  /** The project's private-names file for the leak scan when the queue gives none (RunInput.namesFile wins). Null,
   *  or a file that doesn't exist: the scan checks secrets only and notes the push is held. */
  leakNames?: (project: { id: string; root: string }) => string | null;
}

const now = () => new Date().toISOString();
const short = (sha: string) => sha.slice(0, 7);
const tail = (s: string, n = 1) => s.trim().split("\n").slice(-n).join(" ").slice(0, 300);

/** The steps of one run: each with its own log file from its first line, every change reported to the queue. */
class Steps {
  private n = 0;
  readonly all: RunStep[] = [];
  constructor(
    private readonly dir: string,
    private readonly hooks: RunHooks,
  ) {
    mkdirSync(join(dir, "logs"), { recursive: true });
  }
  start(id: string, kind: RunStepKind, label: string, extra: Partial<RunStep> = {}): Step {
    const file = `logs/${String(++this.n).padStart(2, "0")}-${id.replace(/[^A-Za-z0-9._+-]/g, "_")}.log`;
    const step: RunStep = { id, kind, label, result: "running", startedAt: now(), ms: 0, log: file, ...extra };
    writeFileSync(join(this.dir, file), `== ${label} (${id}) · ${step.startedAt}\n`);
    this.all.push(step);
    this.hooks.step({ ...step });
    return new Step(step, join(this.dir, file), this.hooks);
  }
}
class Step {
  private readonly t0 = Date.now();
  constructor(
    readonly s: RunStep,
    readonly file: string,
    private readonly hooks: RunHooks,
  ) {}
  log = (chunk: string) => writeFileSync(this.file, chunk, { flag: "a" });
  end(result: StepResult, extra: Partial<RunStep> = {}): RunStep {
    Object.assign(this.s, extra, { result, ms: Date.now() - this.t0 });
    this.log(`\n== ${result}${this.s.detail ? `: ${this.s.detail}` : ""} · ${Math.round(this.s.ms / 1000)} s\n`);
    this.hooks.step({ ...this.s });
    return this.s;
  }
}

/** The slot a merge copy's processes number their ports by: above every copy's and conformance's. */
export const mergeSlotOf = (def: ProjectDef): number => Math.max(...slotLayoutOf(def, null).scratch) + 1;

// ---- setup ----------------------------------------------------------------------------------------

/** The copy's setup cache: each step's fingerprint at its last success, kept in the copy's own git dir. */
async function cacheFile(copy: string): Promise<string> {
  return join(await gitOut(copy, ["rev-parse", "--path-format=absolute", "--git-dir"]), "sova-merge-setup.json");
}
function readCache(file: string): Record<string, string> {
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
function fingerprint(copy: string, argv: string[], inputs: string[]): string {
  const parts = [JSON.stringify(argv)];
  for (const f of inputs) {
    try {
      parts.push(`${f}:${createHash("sha256").update(readFileSync(join(copy, f))).digest("hex")}`);
    } catch {
      parts.push(`${f}:missing`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/** Run every setup step (each skipped while its argv and inputs are unchanged, unless `fresh`). → the failed step, or null. */
async function runSetup(o: {
  def: ProjectDef;
  scope: CopyScope;
  steps: Steps;
  idPrefix: string;
  labelPrefix: string;
  kind: RunStepKind;
  fresh?: boolean;
  signal: AbortSignal;
}): Promise<{ failed: StepDecl; step: RunStep; timedOut: boolean; aborted: boolean } | null> {
  const file = await cacheFile(o.scope.copy);
  const cache = o.fresh ? {} : readCache(file);
  const vars = templateVarsOf(o.def, o.scope);
  for (const decl of o.def.setup) {
    const argv = decl.run.map((a) => render(a, vars));
    const fp = fingerprint(o.scope.copy, argv, decl.inputs);
    const st = o.steps.start(`${o.idPrefix}${decl.id}`, o.kind, `${o.labelPrefix}${decl.id}`);
    if (cache[decl.id] === fp) {
      st.log("unchanged since the last run (same command, same inputs)\n");
      st.end("skipped", { detail: "unchanged since the last run" });
      continue;
    }
    st.log(`$ ${argv.join(" ")}\n`);
    const p = await runProc(argv, { cwd: o.scope.copy, env: envOf(o.def, o.scope, { step: `setup:${decl.id}` }), timeoutMs: decl.timeout * 1000, signal: o.signal, log: st.log });
    if (p.code === 0) {
      cache[decl.id] = fp;
      writeFileSync(file, JSON.stringify(cache));
      st.end("passed");
      continue;
    }
    delete cache[decl.id];
    writeFileSync(file, JSON.stringify(cache));
    const step = st.end("failed", { detail: p.aborted ? "aborted" : p.timedOut ? `timed out after ${decl.timeout} s` : `exit ${p.code}: ${tail(p.out)}` });
    return { failed: decl, step, timedOut: p.timedOut, aborted: p.aborted };
  }
  return null;
}

/** Forget every cached setup step (after an install changed what setup made). */
async function forgetSetup(copy: string): Promise<void> {
  writeFileSync(await cacheFile(copy), "{}");
}

// ---- the run --------------------------------------------------------------------------------------

export function makeRunMerge(deps: RunDeps = {}): RunMerge {
  // Services a check needs start through the server's project engine unless the caller gives another way.
  const withServices: RunDeps = { services: lazyEngineServices(), ...deps };
  return (input, hooks) => runOnce(input, hooks, withServices).catch((err): RunOutcome => {
    // Never a throw: anything unexpected is the machine's, never the branch's.
    return { verdict: "machine", why: `the run stopped: ${err instanceof Error ? err.message : String(err)}`, notes: [], checks: [] };
  });
}

/**
 * `services` through the project engine: the copy run as an instance of its own (`up` of the services a check needs,
 * on the engine's own slot and ports), stopped (`down`) after the checks. A refusal (over the copy limit, a port
 * taken) is the machine's, never the branch's.
 */
export function engineServices(engine: { run: (verb: string, body: unknown, caller: { kind: "operator" }) => Promise<{ ok: boolean; instance: string | null; slot: number | null; error?: { code: string; message: string } }> }): NonNullable<RunDeps["services"]> {
  return async ({ copy, names, log }) => {
    log(`up ${names.join(", ")} in ${copy}\n`);
    const r = await engine.run("up", { checkout: copy, services: names }, { kind: "operator" });
    if (!r.ok || !r.instance || r.slot === null) throw new Error(r.error ? `${r.error.code}: ${r.error.message}` : "the engine started nothing");
    log(`instance ${r.instance}, slot ${r.slot}\n`);
    const instance = r.instance;
    return {
      slot: r.slot,
      down: async () => {
        const d = await engine.run("down", { instance }, { kind: "operator" });
        log(`down ${instance}: ${d.ok ? "stopped" : d.error?.message ?? "failed"}\n`);
      },
    };
  };
}

/** engineServices over the server's own engine (server/project-services/routes.ts), loaded on first use. */
function lazyEngineServices(): NonNullable<RunDeps["services"]> {
  return async (o) => engineServices((await import("../project-services/routes")).projectEngine())(o);
}

/** The default run: services through the server's engine, the reviewer the server wires (review-step.ts). */
export const runMerge: RunMerge = makeRunMerge();

async function runOnce(input: RunInput, hooks: RunHooks, deps: RunDeps): Promise<RunOutcome> {
  const { project, base, commit, signal } = input;
  const target = project.target;
  const steps = new Steps(input.runDir, hooks);
  const notes: MergeNote[] = [];
  let checksShown: CheckPick[] = [];
  const out = (o: Omit<RunOutcome, "notes" | "checks"> & { notes?: MergeNote[] }): RunOutcome => ({ ...o, notes: [...notes, ...(o.notes ?? [])], checks: checksShown });
  const voided = (why: string): RunOutcome => out({ verdict: "void", why });
  const copy = mergeCopyPath(project.root);
  const def = project.def;

  // 1. copy
  const cs = steps.start("copy", "copy", "Merge copy");
  try {
    assertCopyOutsideState(copy, { root: project.root, ...(deps.state ? { state: deps.state } : {}), ...(deps.home ? { home: deps.home } : {}) });
    hooks.copy?.(copy);
    cs.log(`copy: ${copy}\nbase: ${base} (${target})\n`);
    await prepareCopy({ root: project.root, path: copy, base, log: cs.log, signal, ...(deps.state ? { state: deps.state } : {}), ...(deps.home ? { home: deps.home } : {}) });
  } catch (err) {
    if (signal.aborted) return (cs.end("failed", { detail: "aborted" }), voided("aborted"));
    const why = err instanceof Error ? err.message : String(err);
    cs.log(`${why}\n`);
    cs.end("failed", { detail: why });
    return out({ verdict: "machine", why: err instanceof CopyRefused ? `refused: ${why}` : `the merge copy couldn't be made ready: ${why}` });
  }
  cs.end("passed", { detail: `${copy} at ${short(base)}` });
  if (!def) return out({ verdict: "machine", why: `${target} has no readable .sova/project.json`, copy });
  const declared = checksOf(def);
  if (declared === "unset") return out({ verdict: "machine", why: "this project hasn't said what to check (not set up)", copy });

  // 2. merge
  const ms = steps.start("merge", "merge", input.resolution ? "Take the conflict resolution" : `Merge ${short(commit)} onto ${target}`);
  const ident = await identityEnv(copy);
  let mergeSha: string;
  if (input.resolution) {
    const r = await takeResolution(copy, base, input.resolution, ms.log, ident, signal);
    if ("conflict" in r) return (ms.end("failed", { detail: `conflicts in ${r.conflict.length} file(s)` }), out({ verdict: "conflict", why: `the resolution conflicts with ${target} in ${r.conflict.join(", ")}`, conflict: { files: r.conflict }, copy }));
    if ("error" in r) return signal.aborted ? (ms.end("failed", { detail: "aborted" }), voided("aborted")) : (ms.end("failed", { detail: r.error }), out({ verdict: "machine", why: r.error, copy }));
    mergeSha = r.sha;
  } else {
    if ((await gitProc(copy, ["merge-base", "--is-ancestor", commit, base])).code === 0) {
      ms.end("failed", { detail: `${target} already has ${short(commit)}` });
      return out({ verdict: "failed", blame: "branch", why: `nothing to land: ${target} already has ${short(commit)}`, copy });
    }
    ms.log(`$ git merge --no-ff ${commit}\n`);
    const m = await gitProc(copy, ["merge", "--no-ff", "--no-edit", "-m", `Merge branch '${input.entry.branch}' into ${target}`, commit], { env: ident, log: ms.log, signal });
    if (m.aborted) return (ms.end("failed", { detail: "aborted" }), voided("aborted"));
    if (m.code !== 0) {
      const files = (await gitProc(copy, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
      await gitProc(copy, ["merge", "--abort"], { log: ms.log });
      if (files.length) {
        ms.end("failed", { detail: `conflicts in ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 4).join(", ")}` });
        return out({ verdict: "conflict", why: `conflicts with ${target} in ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""}`, conflict: { files }, copy });
      }
      ms.end("failed", { detail: tail(m.out) });
      return out({ verdict: "machine", why: `git merge failed: ${tail(m.out)}`, copy });
    }
    mergeSha = await gitOut(copy, ["rev-parse", "HEAD"]);
  }
  ms.end("passed", { detail: short(mergeSha) });
  hooks.merged?.(mergeSha);

  // The changed paths the checks read (SOVA_MERGE_CHANGED): the branch's against the target.
  const changed = (await gitProc(copy, ["diff", "--name-only", `${base}...${mergeSha}`])).out.split("\n").filter(Boolean);
  const changedFile = join(input.runDir, "changed.txt");
  const names = input.namesFile ?? deps.leakNames?.({ id: project.id, root: project.root }) ?? null;
  const scope: CopyScope = { project: project.root, projectId: project.id, copy, slot: mergeSlotOf(def), data: join(input.runDir, "data"), target, base, tip: mergeSha, changedFile, ...(names ? { leakNames: names } : {}) };
  mkdirSync(scope.data, { recursive: true });
  writeFileSync(changedFile, `${changed.join("\n")}\n`);

  // Whose is a setup failure: rerun setup on the target alone, from nothing cached.
  const setupBlame = async (what: string, failedStep: RunStep): Promise<RunOutcome> => {
    const back = steps.start(`rerun-master:${failedStep.id}`, "rerun-master", `${failedStep.label} on ${target} alone`);
    try {
      await moveCopy({ path: copy, commit: base, log: back.log, signal });
    } catch (err) {
      back.end("failed", { detail: String(err instanceof Error ? err.message : err) });
      return signal.aborted ? voided("aborted") : out({ verdict: "machine", why: `couldn't move the copy back to ${target}`, copy });
    }
    back.end("passed", { detail: `copy at ${short(base)}` });
    const again = await runSetup({ def, scope: { ...scope, tip: base }, steps, idPrefix: "rerun-master:setup:", labelPrefix: `Setup on ${target} alone: `, kind: "rerun-master", fresh: true, signal });
    if (signal.aborted) return voided("aborted");
    const blame = blameSetup(again ? "fails" : "passes");
    if (blame === "machine") return out({ verdict: "machine", blame: "machine", why: `${what} fails on ${target} alone too (${again!.failed.id}); not your branch's`, copy, mergeSha });
    return out({ verdict: "failed", blame: input.resolution ? "resolution" : "branch", why: `${what} fails with your branch and passes on ${target} alone (log: ${failedStep.log})`, copy, mergeSha });
  };

  // 3. setup
  const failed = await runSetup({ def, scope, steps, idPrefix: "setup:", labelPrefix: "Setup: ", kind: "setup", signal });
  if (signal.aborted) return voided("aborted");
  if (failed) {
    if (failed.timedOut) return voided(`setup ${failed.failed.id} timed out`);
    return setupBlame(`setup (${failed.failed.id})`, failed.step);
  }

  // 4. install, when the branch changes what it reads
  const inst = def.merge?.install;
  const instHits = inst ? changed.filter((p) => inst.inputs.includes(p)) : [];
  if (inst && instHits.length) {
    const is = steps.start("install", "install", "Install dependencies (offline)", { why: `${instHits.join(", ")} changed` });
    const argv = inst.run.map((a) => render(a, templateVarsOf(def, scope)));
    is.log(`$ ${argv.join(" ")}\n`);
    await forgetSetup(copy);
    const p = await runProc(argv, { cwd: copy, env: envOf(def, scope, { step: "install" }), timeoutMs: inst.timeout * 1000, signal, log: is.log });
    if (p.aborted) return (is.end("failed", { detail: "aborted" }), voided("aborted"));
    if (p.timedOut) return (is.end("failed", { detail: `timed out after ${inst.timeout} s` }), voided("the install timed out"));
    if (p.code !== 0) {
      is.end("failed", { detail: `exit ${p.code}: ${tail(p.out)}` });
      // The target alone needs no install (its own dependencies are what setup made): the change is the branch's.
      return out({ verdict: "failed", blame: input.resolution ? "resolution" : "branch", why: `the offline install fails with your branch's dependency change (${instHits.join(", ")}); ${target} alone needs none. If a new package isn't in the store yet, install it once in the project (log: ${is.s.log})`, copy, mergeSha });
    }
    is.end("passed");
  }

  // 5. docs
  let tip = mergeSha;
  const docs = await makeDocs({ input, copy, steps, ident, deps, signal });
  if (signal.aborted) return voided("aborted");
  if (docs.kind === "machine") return out({ verdict: "machine", why: docs.why, copy, mergeSha });
  if (docs.kind === "refused") return out({ verdict: "failed", blame: "branch", why: docs.why, copy, mergeSha });
  if (docs.kind === "made") {
    tip = docs.sha;
    const more = (await gitProc(copy, ["diff", "--name-only", `${mergeSha}..${tip}`])).out.split("\n").filter(Boolean);
    writeFileSync(changedFile, `${[...changed, ...more].join("\n")}\n`);
  }
  scope.tip = tip;

  // 6. checks, with the review beside them
  const list = planChecks(def, input.picks);
  checksShown = picksOf(list);
  hooks.checks(checksShown);
  const review = input.review ? startReview({ input, copy, tip, steps, deps, def }) : null;
  const finish = async (o: RunOutcome): Promise<RunOutcome> => {
    await review?.cancel();
    return o;
  };
  if (declared === "none") {
    const r = review ? await review.result : null;
    return reviewed(r, out({ verdict: "passed", tip, mergeSha, copy, noChecks: true, notes: [{ kind: "no-checks", text: "No checks declared: landed after a clean merge", at: now() }] }));
  }
  let services: { slot: number; down: () => Promise<void> } | null = null;
  try {
    const needs = [...new Set(list.flatMap((c) => c.requires))];
    if (needs.length) {
      const ss = steps.start("services", "setup", `Start ${needs.join(", ")}`);
      if (!deps.services) {
        ss.end("failed", { detail: "nothing here can start services in the merge copy" });
        return finish(out({ verdict: "machine", why: `the checks need ${needs.join(", ")} running, and nothing here can start them`, copy, mergeSha, tip }));
      }
      try {
        services = await deps.services({ root: project.root, copy, names: needs, log: ss.log, signal });
        scope.slot = services.slot;
        ss.end("passed", { detail: `slot ${services.slot}` });
      } catch (err) {
        ss.end("failed", { detail: String(err instanceof Error ? err.message : err) });
        return finish(signal.aborted ? voided("aborted") : out({ verdict: "machine", why: `couldn't start ${needs.join(", ")} in the merge copy: ${err instanceof Error ? err.message : err}`, copy, mergeSha, tip }));
      }
    }
    const reds: { check: PlannedCheck; files: string[] }[] = [];
    const blames: CheckBlame[] = [];
    for (const check of list) {
      const st = steps.start(`check:${check.id}`, "check", check.label, { source: check.source, ...(check.why ? { why: check.why } : {}) });
      const r = await runCheck({ def, scope, check, stepId: check.id, logFile: st.file, signal });
      if (r.proc.aborted || signal.aborted) return finish((st.end("failed", { detail: "aborted" }), voided("aborted")));
      if (r.proc.timedOut) return finish((st.end("failed", { detail: `timed out after ${check.timeoutSec} s` }), voided(`${check.label} timed out after ${check.timeoutSec} s`)));
      const counts = countsOf(r.report);
      if (r.proc.code === 0) {
        st.end(r.report?.skippedWhy ? "skipped" : "passed", { counts, ...(r.report?.skippedWhy ? { detail: `skipped: ${r.report.skippedWhy}` } : {}) });
        continue;
      }
      st.end("failed", { counts, detail: r.failingFiles.length ? `${r.failingFiles.length} failing file${r.failingFiles.length === 1 ? "" : "s"}` : `exit ${r.proc.code}`, failures: (r.report?.failures ?? r.failingFiles.map((file) => ({ file }))).slice(0, 50) });
      // Again on the tip: what passes now is flaky.
      const files = check.rerun ? r.failingFiles : [];
      const again = steps.start(`rerun-tip:${check.id}`, "rerun-tip", `${check.label} again${files.length ? ` (${files.length} file${files.length === 1 ? "" : "s"})` : ""}`);
      const r2 = await runCheck({ def, scope, check, stepId: `rerun-tip:${check.id}`, logFile: again.file, ...(files.length ? { files } : {}), signal });
      if (r2.proc.aborted || signal.aborted) return finish((again.end("failed", { detail: "aborted" }), voided("aborted")));
      if (r2.proc.timedOut) return finish((again.end("failed", { detail: "timed out" }), voided(`${check.label} timed out on its rerun`)));
      if (r2.proc.code === 0) {
        again.end("passed", { detail: "passes on a rerun: flaky" });
        blames.push(files.length ? { id: check.id, label: check.label, files: files.map((file) => ({ file, blame: blameFile({ passesOnTip: true }) })) } : { id: check.id, label: check.label, whole: blameCheck({ passesOnTip: true }) });
        continue;
      }
      // With files: the ones the rerun still names (all of them when it names none).
      const still = files.length ? (r2.failingFiles.length ? files.filter((f) => r2.failingFiles.includes(f)) : files) : [];
      const flaky = files.filter((f) => !still.includes(f));
      again.end("failed", { detail: files.length ? `${still.length} still failing${flaky.length ? `, ${flaky.length} passed` : ""}` : `exit ${r2.proc.code}` });
      if (files.length && !still.length) {
        blames.push({ id: check.id, label: check.label, files: files.map((file) => ({ file, blame: "flaky" as const })) });
        continue;
      }
      reds.push({ check, files: still });
      if (flaky.length) blames.push({ id: check.id, label: check.label, files: flaky.map((file) => ({ file, blame: "flaky" as const })) });
    }
    // 7. still red: the same on the target alone, in the same copy (after the review has read the tip).
    if (reds.length) {
      if (review) await review.settled;
      const mv = steps.start("rerun-master:copy", "rerun-master", `Copy to ${target} alone`);
      try {
        await moveCopy({ path: copy, commit: base, log: mv.log, signal });
      } catch (err) {
        mv.end("failed", { detail: String(err instanceof Error ? err.message : err) });
        return finish(signal.aborted ? voided("aborted") : out({ verdict: "machine", why: `couldn't move the copy to ${target} to tell whose failure it is`, copy, mergeSha, tip }));
      }
      mv.end("passed", { detail: short(base) });
      const baseScope: CopyScope = { ...scope, tip: base };
      writeFileSync(changedFile, "\n");
      const sf = await runSetup({ def, scope: baseScope, steps, idPrefix: "rerun-master:setup:", labelPrefix: `Setup on ${target} alone: `, kind: "rerun-master", signal });
      if (signal.aborted) return finish(voided("aborted"));
      if (sf) return finish(out({ verdict: "machine", blame: "machine", why: `setup (${sf.failed.id}) fails on ${target} alone, so whose failure it is can't be told`, copy, mergeSha, tip }));
      for (const { check, files } of reds) {
        const onBase = files.length ? await filesOn(copy, base, files) : [];
        const absent = files.filter((f) => !onBase.includes(f));
        const st = steps.start(`rerun-master:${check.id}`, "rerun-master", `${check.label} on ${target} alone${files.length ? ` (${onBase.length} file${onBase.length === 1 ? "" : "s"})` : ""}`);
        if (files.length && !onBase.length) {
          st.end("skipped", { detail: `${target} hasn't these test files: the branch's` });
          blames.push({ id: check.id, label: check.label, files: files.map((file) => ({ file, blame: "branch" as const })) });
          continue;
        }
        const r = await runCheck({ def, scope: baseScope, check, stepId: `rerun-master:${check.id}`, logFile: st.file, ...(files.length ? { files: onBase } : {}), signal });
        if (r.proc.aborted || signal.aborted) return finish((st.end("failed", { detail: "aborted" }), voided("aborted")));
        if (r.proc.timedOut) return finish((st.end("failed", { detail: "timed out" }), voided(`${check.label} timed out on ${target} alone`)));
        if (files.length) {
          const failing = r.proc.code === 0 ? [] : r.failingFiles.length ? onBase.filter((f) => r.failingFiles.includes(f)) : onBase;
          st.end(r.proc.code === 0 ? "passed" : "failed", { detail: r.proc.code === 0 ? `passes on ${target}: the branch's` : `${failing.length} fail on ${target} too` });
          blames.push({ id: check.id, label: check.label, files: [...absent.map((file) => ({ file, blame: "branch" as const })), ...onBase.map((file) => ({ file, blame: blameFile({ passesOnTip: false, onTarget: failing.includes(file) ? "fails" : "passes" }) }))] });
        } else {
          st.end(r.proc.code === 0 ? "passed" : "failed", { detail: r.proc.code === 0 ? `passes on ${target}: the branch's` : `fails on ${target} too` });
          blames.push({ id: check.id, label: check.label, whole: blameCheck({ passesOnTip: false, onTarget: r.proc.code === 0 ? "passes" : "fails" }) });
        }
      }
    }
    const a = summarize(blames, { resolution: !!input.resolution, target });
    const at = now();
    const attributed = a.notes.map((n) => ({ ...n, at }));
    if (a.verdict === "failed") return finish(out({ verdict: "failed", blame: a.blame!, why: a.why!, notes: attributed, copy, mergeSha, tip, ...(a.targetRed.length ? { targetRed: a.targetRed } : {}) }));
    const r = review ? await review.result : null;
    return reviewed(r, out({ verdict: "passed", notes: attributed, copy, mergeSha, tip, ...(a.targetRed.length ? { targetRed: a.targetRed } : {}) }));
  } finally {
    await services?.down().catch(() => undefined);
  }
}

/** The run's outcome with the review's verdict folded in. */
function reviewed(r: ReviewResult | null, o: RunOutcome): RunOutcome {
  if (!r) return o;
  if (!r.ok) return { ...o, verdict: "machine", blame: "reviewer", why: `the review couldn't finish: ${r.why}` };
  const v = r.verdict;
  if (v.verdict === "ok") return { ...o, review: v };
  if (v.verdict === "notes") return { ...o, review: v, notes: [...o.notes, { kind: "review", text: (v.text ?? "review notes").slice(0, 300), at: v.at }] };
  return { ...o, review: v, verdict: "review-flagged", why: `review flagged: ${(v.text ?? "").slice(0, 200)}` };
}

type ReviewResult = { ok: true; verdict: ReviewVerdict } | { ok: false; why: string };

function startReview(o: { input: RunInput; copy: string; tip: string; steps: Steps; deps: RunDeps; def: ProjectDef }): { result: Promise<ReviewResult>; settled: Promise<void>; cancel: () => Promise<void> } {
  const kit = o.def.merge?.review;
  const st = o.steps.start("review", "review", "Review", { why: kit ? `review kit ${kit}` : undefined });
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  o.input.signal.addEventListener("abort", onAbort, { once: true });
  let done = false;
  const result: Promise<ReviewResult> = (async () => {
    if (!kit || !existsSync(join(o.copy, kit))) {
      st.end("skipped", { detail: kit ? `no review kit at ${kit} on ${o.input.project.target}` : "no review kit declared" });
      return { ok: true as const, verdict: { verdict: "ok" as const, commit: o.tip, at: now(), text: "no review kit" } };
    }
    const r = await reviewStep({ runId: o.input.runId, projectId: o.input.project.id, root: o.input.project.root, copy: o.copy, base: o.input.base, commit: o.tip, branch: o.input.entry.branch, kit, target: o.input.project.target, log: st.log, signal: ctl.signal }, o.deps);
    if (r.ok) st.end(r.verdict.verdict === "blocking" ? "failed" : "passed", { detail: `${r.verdict.verdict}${r.verdict.text ? `: ${r.verdict.text.slice(0, 200)}` : ""}` });
    else st.end("failed", { detail: r.why });
    return r;
  })().finally(() => {
    done = true;
    o.input.signal.removeEventListener("abort", onAbort);
  });
  return {
    result,
    settled: result.then(() => undefined),
    cancel: async () => {
      if (done) return;
      ctl.abort();
      await result.catch(() => undefined);
    },
  };
}

/** The test files of `files` that exist at `rev`. */
async function filesOn(copy: string, rev: string, files: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) if ((await gitProc(copy, ["cat-file", "-e", `${rev}:${f}`])).code === 0) out.push(f);
  return out;
}

/** Who commits in the copy: the repository's own identity, else Sova's. */
async function identityEnv(copy: string): Promise<Record<string, string>> {
  const name = (await gitProc(copy, ["config", "user.name"])).out.trim();
  const email = (await gitProc(copy, ["config", "user.email"])).out.trim();
  if (name && email) return {};
  return { GIT_AUTHOR_NAME: name || "Sova merge queue", GIT_AUTHOR_EMAIL: email || "merge-queue@sova.invalid", GIT_COMMITTER_NAME: name || "Sova merge queue", GIT_COMMITTER_EMAIL: email || "merge-queue@sova.invalid" };
}

/** The thread's resolution, taken: as is when its first parent is the target's head, else with the target merged in. */
async function takeResolution(copy: string, base: string, resolution: string, log: (s: string) => void, env: Record<string, string>, signal: AbortSignal): Promise<{ sha: string } | { conflict: string[] } | { error: string }> {
  const first = (await gitProc(copy, ["rev-parse", "--verify", "-q", `${resolution}^1`])).out.trim();
  const co = await gitProc(copy, ["checkout", "--detach", "--force", resolution], { log, signal });
  if (co.code !== 0) return { error: `the resolution ${short(resolution)} can't be checked out: ${tail(co.out)}` };
  if (first === base) return { sha: (await gitOut(copy, ["rev-parse", "HEAD"])) };
  log(`its first parent ${short(first)} isn't the target's head: merging ${short(base)} into it\n`);
  const m = await gitProc(copy, ["merge", "--no-ff", "--no-edit", base], { env, log, signal });
  if (m.code !== 0) {
    const files = (await gitProc(copy, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
    await gitProc(copy, ["merge", "--abort"], { log });
    return files.length ? { conflict: files } : { error: `git merge failed: ${tail(m.out)}` };
  }
  return { sha: await gitOut(copy, ["rev-parse", "HEAD"]) };
}

/** The docs step: the approved drafts copied into the copy and made official as one commit, before any check. */
async function makeDocs(o: { input: RunInput; copy: string; steps: Steps; ident: Record<string, string>; deps: RunDeps; signal: AbortSignal }): Promise<{ kind: "none" } | { kind: "made"; sha: string } | { kind: "refused"; why: string } | { kind: "machine"; why: string }> {
  const src = o.input.draftsDir;
  const names = src && existsSync(src) ? readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort() : [];
  const st = o.steps.start("docs", "docs", "Spec docs");
  if (!names.length) {
    st.end("skipped", { detail: o.input.entry.approval.withoutSpecs ? "landing without its specs" : "no spec drafts" });
    return { kind: "none" };
  }
  if (!existsSync(join(o.copy, ".sova", "spec", "manifest.json"))) {
    st.end("failed", { detail: "the target has no .sova/spec to land drafts into" });
    return { kind: "refused", why: `spec drafts (${names.join(", ")}) but ${o.input.project.target} has no .sova/spec` };
  }
  const core = o.deps.specCore ?? process.env.SOVA_SPEC_CORE ?? join(agentRoot(), "extensions", "spec", "core");
  const tool = join(core, "sova-spec-draft.mjs");
  if (!existsSync(tool)) {
    st.end("failed", { detail: `no spec tools at ${core}` });
    return { kind: "machine", why: `the spec tools aren't at ${core}, so the drafts can't be made official` };
  }
  const dest = join(o.copy, ".sova", "spec", "drafts");
  mkdirSync(dest, { recursive: true });
  for (const n of names) {
    st.log(`copying draft ${n}\n`);
    cpSync(join(src!, n), join(dest, n), { recursive: true });
  }
  const a = o.input.entry.approval;
  const by = a.by === "typed" ? "the user (land it, typed in the branch's chat)" : "the user (Land)";
  const verification = `Made official by the merge queue: ${o.input.entry.branch} at ${short(o.input.commit)}, approved ${a.at.slice(0, 16).replace("T", " ")}; committed before the run's checks (run ${o.input.runId})`;
  const argv = [process.execPath, tool, "land", "--commit", "HEAD", "--by", by, "--verification", verification, "--write", "--root", o.copy, "--json"];
  st.log(`$ ${argv.slice(1).join(" ")}\n`);
  const p = await runProc(argv, { cwd: o.copy, env: { ...process.env as Record<string, string> }, timeoutMs: 300_000, signal: o.signal, log: st.log });
  if (p.aborted) return (st.end("failed", { detail: "aborted" }), { kind: "machine", why: "aborted" });
  let j: { exit?: number; written?: boolean; nothingToLand?: boolean; paths?: unknown[]; findings?: { id?: string; draft?: string; code?: string; message?: string }[]; commitMessage?: { subject?: string; body?: string } } | null = null;
  try {
    j = JSON.parse(p.out.slice(p.out.indexOf("{")));
  } catch {
    /* no answer */
  }
  if (!j || typeof j.exit !== "number") {
    st.end("failed", { detail: `the draft tool gave no answer (exit ${p.code})` });
    return { kind: "machine", why: `the spec draft tool gave no answer (exit ${p.code})` };
  }
  if (j.nothingToLand) {
    st.end("skipped", { detail: "every draft is already official" });
    return { kind: "none" };
  }
  if (j.exit !== 0 || !j.written) {
    const f = (j.findings ?? []).slice(0, 6).map((x) => `${x.id ?? x.draft ?? ""} ${x.code ?? ""}: ${x.message ?? ""}`.trim());
    st.end("failed", { detail: `drafts don't fit: ${f.join("; ").slice(0, 300)}` });
    return { kind: "refused", why: `your spec drafts don't fit, so nothing was made official: ${f.join("; ").slice(0, 400)}. Fix them in your drafts (no commit needed) and approve again.` };
  }
  const paths = (j.paths ?? []).filter((x): x is string => typeof x === "string" && x.startsWith(".sova/spec/") && !x.startsWith(".sova/spec/drafts/"));
  if (!paths.length) {
    st.end("skipped", { detail: "land wrote no spec file" });
    return { kind: "none" };
  }
  const add = await gitProc(o.copy, ["add", "--", ...paths], { log: st.log });
  if (add.code !== 0) return (st.end("failed", { detail: tail(add.out) }), { kind: "machine", why: `staging the docs failed: ${tail(add.out)}` });
  const subject = String(j.commitMessage?.subject || `Spec: land ${names.join(", ")}`);
  const c = await gitProc(o.copy, ["commit", "--no-verify", "-m", subject, "-m", String(j.commitMessage?.body || verification), "-m", `Sova-Spec-Landing: merge-queue ${o.input.runId}`], { env: o.ident, log: st.log });
  if (c.code !== 0) return (st.end("failed", { detail: tail(c.out) }), { kind: "machine", why: `committing the docs failed: ${tail(c.out)}` });
  const sha = await gitOut(o.copy, ["rev-parse", "HEAD"]);
  st.end("passed", { detail: `${short(sha)}: ${subject}` });
  return { kind: "made", sha };
}

/** The run folder's step logs, for merge.logs: the step's lines (newest last), at most `lines`. */
export function stepLog(runDir: string, step: Pick<RunStep, "log">, lines = 200): string[] {
  try {
    const all = readFileSync(join(runDir, step.log), "utf8").split("\n");
    return all.slice(Math.max(0, all.length - lines));
  } catch {
    return [];
  }
}

