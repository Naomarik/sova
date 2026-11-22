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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { CheckPick, MergeNote, ReviewKitStamp, ReviewVerdict, RunRules, RunStep, RunStepKind, StepResult } from "../../shared/merge-queue";
import type { ProjectDef, StepDecl } from "../../shared/project-contract";
import { render } from "../../shared/project-contract";
import { slotLayoutOf } from "../../shared/project-slots";
import { NO_BACKGROUND_CLEANUP } from "../git-no-background";
import { SPEC_CORE } from "../spec-runner";
import { draftSpecHash } from "../spec-drafts-state";
import { readRunLogText } from "./run-logs";
import { LANDED_DRAFTS_FILE, type LandedDraftsRecord } from "./landed-drafts";
import { nothingToLandWords } from "./notices";
import { blameCheck, blameFile, blameSetup, brokenOnTarget, type CheckBlame, type RedRun, summarize } from "./attribute";
import { type CheckRun, checksOf, countsOf, type CopyScope, envOf, firstOutputLine, freshOf, isTestCheck, type PlannedCheck, picksOf, planChecks, ranNoTest, reusedWords, runCheck, templateVarsOf, testKey } from "./checks";
import type { RunHooks, RunInput, RunMerge, RunOutcome } from "./contract";
import type { FlakySeen } from "./flaky";
import { assertCopyOutsideState, CopyRefused, fillLfs, fillSubmodules, gitOut, gitProc, mergeCopyPath, modulesOf, moveCopy, prepareCopy, runProc } from "./copy";
import { reviewStep, type ReviewDeps } from "./review-step";
import { kitChangedBy, kitDeclAt, kitDiff, kitHashAt, ownFolder, ownReviewWords, readKitDecl, reviewerFixIn, reviewerProfileOf } from "./review-kit";
import { dropReviewCopy, makeScratchCopy, REVIEW_FIX_REFS } from "./scratch";
import { realGit } from "./guard";
import { removeReviewChange, reviewChangeDir, writeReviewChange } from "./review-change";
import { conflictsBetween } from "./conflicts";
import { factsOf, runScan, SCAN_STEP_ID, SCAN_STEP_LABEL, scanDetail, scanResultOf } from "./names-step";
import type { ScanResult } from "./publish-scan";
import { branchRulesOf, ruleTriggers, rulesRefusal, withUnknown } from "./rules";

export interface RunDeps extends ReviewDeps {
  /** The state root and home the copy must stay out of (tests move them). */
  state?: string;
  home?: string;
  /** The spec tools' folder (sova-spec-draft.mjs), for Sova's own tests; otherwise the running Sova's own
   *  (SPEC_CORE), never the agent dir's (its links may lead into another, older copy) nor the env's. */
  specCore?: string;
  /** Brings up services a check requires, in the copy; returns the slot its ports are numbered by, and how to stop
   *  them. Absent: a check that requires services fails as a machine problem (nothing can start them). */
  services?: (o: { root: string; copy: string; names: string[]; log: (s: string) => void; signal: AbortSignal }) => Promise<{ slot: number; down: () => Promise<void> }>;
  /** The project's private-names file for the leak scan when the queue gives none (RunInput.namesFile wins). Null,
   *  or a file that doesn't exist: the scan checks secrets only and notes the push is held. */
  leakNames?: (project: { id: string; root: string }) => string | null;
  /** How often a run looks for late picks while it waits for the review (ms); tests shorten it. */
  latePollMs?: number;
}

const now = () => new Date().toISOString();
const short = (sha: string) => sha.slice(0, 7);
/** How often a run waiting for its review looks for a late pick. */
const LATE_POLL_MS = 1000;
const pause = (ms: number) => new Promise<void>((r) => (setTimeout(r, ms) as { unref?: () => void }).unref?.());
/** "42 s", "3 min 5 s". */
const secsOf = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
};
/** At most `n` characters; a cut text ends in "…" (the full text is in the step's log). */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
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
    // A later set of steps of the same run (the scan, after the run's outcome) numbers its logs after the ones there.
    this.n = readdirSync(join(dir, "logs")).length;
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
  /** Change a running step's facts (its why), telling the screens. */
  update(extra: Partial<RunStep>): void {
    Object.assign(this.s, extra);
    this.hooks.step({ ...this.s });
  }
  /** Change an ended step's result (and detail) after the fact, keeping its time: a red check later found broken on
   *  the target reads skipped. */
  mark(result: StepResult, extra: Partial<RunStep> = {}): RunStep {
    Object.assign(this.s, extra, { result });
    this.log(`\n== now ${result}${this.s.detail ? `: ${this.s.detail}` : ""}\n`);
    this.hooks.step({ ...this.s });
    return this.s;
  }
  end(result: StepResult, extra: Partial<RunStep> = {}): RunStep {
    Object.assign(this.s, extra, { result, ms: Date.now() - this.t0 });
    this.log(`\n== ${result}${this.s.detail ? `: ${this.s.detail}` : ""} · ${Math.round(this.s.ms / 1000)} s\n`);
    this.hooks.step({ ...this.s });
    return this.s;
  }
}

/** The slot a merge copy's processes number their ports by: above every copy's and conformance's. */
/** A rerun's report says it ran no test at all (none listed in `ranFiles`, and no passed or failed test): its exit 0
 *  proves nothing. No report at all says nothing either way (a build check writes none). */
const ranNothingIn = (r: import("./checks").CheckReport | null): boolean => !!r && !(r.ranFiles?.length) && (r.passed ?? 0) + (r.failed ?? 0) === 0;

/** A release's entry (a release or its revert): every check runs fresh, the merge set as well as the release's gates. */
export const isReleaseRun = (input: Pick<RunInput, "entry" | "releaseChecks">): boolean => !!input.entry?.release || !!input.releaseChecks;

/**
 * How a check that exited 0 ends: skipped with the runner's why, else passed, with what it reused in `detail` ("412
 * ran, 568 already passed on identical code (28 re-checked)") and `reused` set (the estimate learns nothing from it).
 * A check that reused passes is never shown Skipped while the re-check sampled anything.
 */
export function passedEnd(r: Pick<CheckRun, "report">, counts: RunStep["counts"]): [StepResult, Partial<RunStep>] {
  const used = r.report?.reused;
  const words = used ? reusedWords(used) : null;
  if (used && words && (used.rechecked > 0 || used.files < used.of)) return ["passed", { counts, detail: words, reused: used.files + used.rechecked }];
  if (r.report?.skippedWhy) return ["skipped", { counts, detail: `skipped: ${r.report.skippedWhy}`, ...(used?.files ? { reused: used.files } : {}) }];
  return ["passed", { counts, ...(words ? { detail: words, reused: used!.files + used!.rechecked } : {}) }];
}

/** The step's log names each test file that wasn't run again and the run its pass came from (the run page shows the log). */
function logReused(st: Step, r: CheckRun): void {
  const used = r.report?.reused;
  if (!used || used.files + used.rechecked <= 0) return;
  const words = reusedWords(used);
  st.log(`\n== ${words}${used.at ? `; newest pass ${used.at}` : ""}${used.from ? ` (${used.from})` : ""}\n`);
  for (const f of used.list) st.log(`  reused ${f.file}${f.at ? ` · passed ${f.at}` : ""}${f.from ? ` · ${f.from}` : ""}${f.run ? ` · run ${f.run}` : ""}\n`);
  if (used.list.length < used.files) st.log(`  (${used.files - used.list.length} more not listed)\n`);
}

/** An event for the queue's record (RunHooks.event, when this build has it): run, entry and branch are filled in. */
const hookEvent = (hooks: RunHooks, ev: import("../../shared/merge-queue").MergeEventInput): void => (hooks as { event?: (e: import("../../shared/merge-queue").MergeEventInput) => void }).event?.(ev);

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
  // RunInput.tryOnly (a dry run or a trial): nothing merged (tryOnce).
  return (input, hooks) => (input.tryOnly ? tryOnce(input, hooks, withServices) : runOnce(input, hooks, withServices).then((o) => withScan(input, hooks, o))).catch((err): RunOutcome => {
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

/** The outcomes whose tip may land (Land Anyway lands an unattributed or flagged one): each gets the scan step. */
const SCANNED: readonly RunOutcome["verdict"][] = ["passed", "unattributed", "review-flagged"];

/**
 * The run's last step, "Private names and secrets" (names-step.ts, §app.merge-queue/names-step), in every run whose
 * landing pushes (RunInput.scan): what the landing adds, `<base>..<tip>` in the merge copy. It never changes the
 * verdict: the queue holds a tip with hits from landing (queue.ts landTested).
 */
async function withScan(input: RunInput, hooks: RunHooks, o: RunOutcome): Promise<RunOutcome> {
  if (!input.scan || !o.tip || !o.copy || !SCANNED.includes(o.verdict) || input.signal.aborted) return o;
  const st = new Steps(input.runDir, hooks).start(SCAN_STEP_ID, "scan", SCAN_STEP_LABEL, { why: `what this landing adds (${short(input.base)}..${short(o.tip)}): private names and secrets, before anything is pushed` });
  const r = await runScan(realGit, { copy: o.copy, base: input.base, tip: o.tip, ...(input.scan.namesFile ? { namesFile: input.scan.namesFile } : {}), allowFile: input.scan.allowFile }).catch((err): ScanResult => ({ ok: false, why: `the scan stopped: ${err instanceof Error ? err.message : String(err)}`, hits: [] }));
  const facts = factsOf(r);
  st.log(`range ${input.base}..${o.tip}\n`);
  if (facts.state === "unanswered") st.log("no private names list yet: secrets only; the push waits for the names interview\n");
  for (const h of facts.hits ?? []) st.log(`${h.where} · ${h.what}\n`);
  if (facts.allowed) st.log(`${facts.allowed} match${facts.allowed === 1 ? "" : "es"} marked fine for this project, skipped\n`);
  if (facts.state === "unreadable") st.log(`${facts.why ?? ""}\n`);
  st.end(scanResultOf(facts), { detail: scanDetail(facts), scan: facts });
  return { ...o, scan: facts };
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
  let rulesShown: RunRules | undefined;
  // A clean run (asked for, or the weekly one) reuses nothing; a copy cut new had nothing to reuse.
  let clean = input.clean;
  const flakySeen: FlakySeen[] = [];
  const checksReused: { id: string; files: number }[] = [];
  const out = (o: Omit<RunOutcome, "notes" | "checks"> & { notes?: MergeNote[] }): RunOutcome => ({ ...o, notes: [...notes, ...(o.notes ?? [])], checks: checksShown, ...(rulesShown ? { rules: rulesShown } : {}), ...(flakySeen.length ? { flaky: [...flakySeen] } : {}), ...(clean ? { clean } : {}) });
  const voided = (why: string): RunOutcome => out({ verdict: "void", why });
  const copy = mergeCopyPath(project.root);
  const def = project.def;
  // Every check fresh on a clean run asked for (or the weekly one); a copy merely cut new still trusts earlier passes on
  // identical code (they are kept outside the copy).
  const fresh = (o: { rerun?: boolean; release?: boolean }): boolean => !!input.clean || freshOf(def, o);

  // 1. copy
  const cs = steps.start("copy", "copy", clean ? "Merge copy (clean)" : "Merge copy");
  try {
    assertCopyOutsideState(copy, { root: project.root, ...(deps.state ? { state: deps.state } : {}), ...(deps.home ? { home: deps.home } : {}) });
    hooks.copy?.(copy);
    cs.log(`copy: ${copy}\nbase: ${base} (${target})\n`);
    if (clean) cs.log(`clean run (${clean === "weekly" ? "the weekly one" : "asked for"}): every ignored file goes too, setup runs from nothing, every check runs fresh\n`);
    const made = await prepareCopy({ root: project.root, path: copy, base, log: cs.log, signal, ...(clean ? { clean: true } : {}), ...(deps.state ? { state: deps.state } : {}), ...(deps.home ? { home: deps.home } : {}) });
    // A copy cut new had nothing to reuse: that, rather than a weekly clean, is why (a clean run asked for stays so).
    if (made.cut && clean !== "operator") clean = "new";
    if (clean) await forgetSetup(copy);
    hooks.ranWith?.({ copy: clean ? "fresh" : "reused", ...(clean ? { clean } : {}) });
  } catch (err) {
    if (signal.aborted) return (cs.end("failed", { detail: "aborted" }), voided("aborted"));
    const why = err instanceof Error ? err.message : String(err);
    cs.log(`${why}\n`);
    cs.end("failed", { detail: why });
    return out({ verdict: "machine", why: err instanceof CopyRefused ? `refused: ${why}` : `the merge copy couldn't be made ready: ${why}` });
  }
  cs.end("passed", { detail: `${copy} at ${short(base)}${clean === "new" ? " (cut new: nothing to reuse)" : clean ? " (clean: nothing reused)" : ""}` });
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
  } else if (!input.entry.release && (input.landingPins?.includes(commit) || (await gitProc(copy, ["merge-base", "--is-ancestor", commit, base])).code === 0)) {
    // Decided here from git in the merge copy, or from an exact recorded landing, never from a row's label
    // (§app.merge-queue/run): nothing merges and only drafts can still land, on the target's own commit. Anything else,
    // a merge holding real edits included, merges as usual: it lands, conflicts, or stops below as changing nothing.
    ms.end("skipped", { detail: `${target} already has what ${short(commit)} holds` });
    mergeSha = base;
  } else {
    ms.log(`$ git merge --no-ff ${commit}\n`);
    const m = await gitProc(copy, [...NO_BACKGROUND_CLEANUP, ...NO_RERERE, "merge", "--no-ff", "--no-edit", "-m", `Merge branch '${input.entry.branch}' into ${target}`, commit], { env: ident, log: ms.log, signal });
    if (m.aborted) return (ms.end("failed", { detail: "aborted" }), voided("aborted"));
    if (m.code !== 0) {
      const files = await conflictFiles(copy, base, commit);
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
  // Merge locally as one commit (merge.squash): the merge, or the thread's resolution, becomes one commit on the target
  // holding the same tree; the docs commit folds into it below. Never a release's commit (its tag names that commit).
  const squash = squashes(def, input) && mergeSha !== base;
  if (squash) {
    const one = await squashOnto(copy, base, mergeSha, commitMessageOf(await subjectsOf(copy, base, commit), input.entry.branch, target), ident, ms.log);
    if ("error" in one) return (ms.end("failed", { detail: one.error }), out({ verdict: "machine", why: one.error, copy }));
    mergeSha = one.sha;
    ms.s.label = `Squash ${short(commit)} onto ${target}`;
  }
  if (ms.s.result === "running") ms.end("passed", { detail: squash ? `${short(mergeSha)}, one commit` : short(mergeSha) });

  // §app.merge-queue/run: a run that changes neither code nor specs stops, whatever let it through. No check, no review,
  // and the target never moves. Before the setup when no draft can land either.
  const sameTree = async (sha: string) => (await gitOut(copy, ["rev-parse", `${sha}^{tree}`])) === (await gitOut(copy, ["rev-parse", `${base}^{tree}`]));
  const nothing = (): RunOutcome => out({ verdict: "nothing", why: nothingToLandWords(target), copy });
  const carriesDrafts = !!input.draftsDir && existsSync(input.draftsDir) && readdirSync(input.draftsDir, { withFileTypes: true }).some((d) => d.isDirectory() && !d.name.startsWith("."));
  if (await sameTree(mergeSha)) {
    if (!carriesDrafts) return nothing();
    // A merge that changed nothing and only carries drafts: the target moves by the spec commit alone.
    if (mergeSha !== base && !input.resolution && !input.entry.release) {
      await gitProc(copy, [...NO_BACKGROUND_CLEANUP, "reset", "--hard", "--quiet", base]);
      mergeSha = base;
    }
  }
  hooks.merged?.(mergeSha);

  // The merged tree's submodules and LFS files, before anything reads it (a failure is the machine's: §app.merge-queue/project-shapes).
  const filled = await fillSteps(copy, steps, signal);
  if (filled) return signal.aborted ? voided("aborted") : out({ verdict: "machine", why: filled, copy, mergeSha });

  // The changed paths the checks read (SOVA_MERGE_CHANGED): the branch's against the target.
  const changed = (await gitProc(copy, ["diff", "--name-only", `${base}...${mergeSha}`])).out.split("\n").filter(Boolean);
  const changedFile = join(input.runDir, "changed.txt");
  const names = input.namesFile ?? deps.leakNames?.({ id: project.id, root: project.root }) ?? null;
  const scope: CopyScope = { project: project.root, projectId: project.id, copy, slot: mergeSlotOf(def), data: join(input.runDir, "data"), target, base, tip: mergeSha, changedFile, ...(names ? { leakNames: names } : {}) };
  mkdirSync(scope.data, { recursive: true });
  writeFileSync(changedFile, `${changed.join("\n")}\n`);

  // The folder rules are the branch's own, as they read after the merge (§app.merge-queue/rules); the check list stays
  // the target's. A branch whose own definition is refused goes back to its chat with the refusal.
  const ruled = branchRulesOf(copy, def);
  const trig = ruleTriggers(ruled.rules, changed, Array.isArray(def.merge?.checks) ? def.merge!.checks : []);
  const rulesNow = withUnknown(ruled.info, trig, target);
  rulesShown = rulesNow;
  hooks.rules?.(rulesNow);
  // So does a branch rule that names a check the target runs only with a selection, and gives none
  // (§app.merge-queue/rules): the branch's own copy of the check may say otherwise, the target's decides. The plan shows
  // the same refusal, in the same words (rules.ts rulesRefusal).
  const refusal = rulesRefusal(ruled, trig, target);
  if (refusal) return out({ verdict: "failed", blame: input.resolution ? "resolution" : "branch", why: refusal.why, copy, mergeSha });

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

  // 3. setup: a failure runs again on the merge first (a network blip is nobody's), then on the target alone.
  const failed = await runSetup({ def, scope, steps, idPrefix: "setup:", labelPrefix: "Setup: ", kind: "setup", signal });
  if (signal.aborted) return voided("aborted");
  if (failed) {
    // A time limit is never a void (§app.merge-queue/time-limit): a setup step past it is a machine failure (one retry,
    // then the queue pauses).
    if (failed.timedOut) return out({ verdict: "machine", why: `setup ${failed.failed.id} ran past its time limit (${failed.failed.timeout} s)`, copy, mergeSha });
    const again = await runSetup({ def, scope, steps, idPrefix: "rerun-tip:setup:", labelPrefix: "Setup again: ", kind: "rerun-tip", fresh: true, signal });
    if (signal.aborted) return voided("aborted");
    if (again) {
      if (again.timedOut) return out({ verdict: "machine", why: `setup ${again.failed.id} ran past its time limit (${again.failed.timeout} s)`, copy, mergeSha });
      return setupBlame(`setup (${again.failed.id})`, again.step);
    }
    notes.push({ kind: "flaky", text: `setup (${failed.failed.id}) failed, then passed on a rerun (not blocking)`, at: now() });
    flakySeen.push({ check: `setup:${failed.failed.id}`, label: `Setup: ${failed.failed.id}` });
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
    if (p.timedOut) return (is.end("failed", { detail: `timed out after ${inst.timeout} s` }), out({ verdict: "machine", why: `the install ran past its time limit (${inst.timeout} s)`, copy, mergeSha }));
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
  if (docs.kind === "refused") return out({ verdict: "failed", blame: "branch", cause: "drafts", why: docs.why, copy, mergeSha });
  if (docs.kind === "made") {
    tip = docs.sha;
    const more = (await gitProc(copy, ["diff", "--name-only", `${mergeSha}..${tip}`])).out.split("\n").filter(Boolean);
    writeFileSync(changedFile, `${[...changed, ...more].join("\n")}\n`);
    if (squash) {
      // One commit: the branch's changes and their docs together, on the target's head.
      const msg = (await gitOut(copy, ["log", "-1", "--format=%B", mergeSha])).trimEnd();
      const docsLog = steps.all.find((x) => x.id === "docs")?.log;
      const one = await squashOnto(copy, base, tip, msg, ident, (s) => docsLog && writeFileSync(join(input.runDir, docsLog), s, { flag: "a" }));
      if ("error" in one) return out({ verdict: "machine", why: one.error, copy, mergeSha });
      tip = mergeSha = one.sha;
      hooks.merged?.(mergeSha);
    }
  }
  scope.tip = tip;
  if (await sameTree(tip)) return nothing();

  // 6. checks, with the review beside them: the required ones, the folder rules' triggers, the thread's picks.
  // The plan's list when the queue worked one out (§app.merge-queue/plan); the run's own reading of the same inputs
  // should agree, and a difference is recorded, never silent. The plan's list is what runs.
  const own = planChecks(def, input.picks, input.releaseChecks, trig.picks);
  const list = input.planned ? structuredClone(input.planned) : own;
  if (input.planned) {
    const words = (l: PlannedCheck[]) => l.map((c) => `${c.id}${c.select?.length ? `(${c.select.join(",")})` : ""}`).join(" ");
    if (words(list) !== words(own)) hooks.event?.({ kind: "note", by: "queue", note: "plan-differs", step: "checks", why: `the run read its checks differently from its plan: planned ${words(list) || "none"}; read in the copy ${words(own) || "none"}. The plan's run.` });
  }
  if (rulesNow.changed?.length) hooks.event?.({ kind: "note", by: "queue", note: "rules-changed", why: `this branch changed its own rules: ${rulesNow.changed.join("; ")}` });
  const release = isReleaseRun(input);
  checksShown = picksOf(list);
  hooks.checks(checksShown);
  // q9: a pick that arrives while the run's checks run is added to this run (after the planned ones), never left for
  // a later one. `pullLate` adds each new one; a required check that already ran unpicked runs again, picked.
  const ran = new Set<string>();
  const baseOf = (id: string) => id.replace(/\+\d+$/, "");
  const pullLate = (): boolean => {
    if (!input.latePicks) return false;
    const at = now();
    let added = false;
    for (const n of planChecks(def, input.latePicks(), input.releaseChecks, trig.picks).filter((x) => x.source === "picked")) {
      const sel = JSON.stringify(n.select ?? []);
      const have = list.find((c) => baseOf(c.id) === baseOf(n.id) && JSON.stringify(c.select ?? []) === sel);
      if (have && (have.picked || !n.picked)) continue;
      if (have && !ran.has(have.id)) {
        Object.assign(have, { source: n.source, picked: true as const, ...(n.why ? { why: n.why } : {}), addedAt: at });
        added = true;
        continue;
      }
      const b = baseOf(n.id);
      const k = list.filter((c) => baseOf(c.id) === b).length;
      list.push({ ...n, id: k ? `${b}+${k}` : b, addedAt: at });
      added = true;
    }
    if (added) {
      checksShown = picksOf(list);
      hooks.checks(checksShown);
    }
    return added;
  };
  const review = input.review ? startReview({ input, copy, tip, steps, deps, def, hooks }) : null;
  const finish = async (o: RunOutcome): Promise<RunOutcome> => {
    await review?.cancel();
    return o;
  };
  if (declared === "none" && !list.length) {
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
    // tipNamed: a whole check's failures as its rerun on the tip named them (files, else test names; [] = none).
    // `runs`: the merge's and the tip rerun's exit and whether each ran a test; `marks`: their steps, re-marked skipped
    // when the check turns out broken on the target (brokenOnTarget).
    // `tests`: the bare names a rerun by name takes (the check's rerunTest), so the target alone runs only those too.
    const reds: { check: PlannedCheck; files: string[]; names?: string[]; tests?: string[]; tipNamed?: string[]; runs?: RedRun[]; marks?: Step[] }[] = [];
    const blames: CheckBlame[] = [];
    const broken: NonNullable<RunOutcome["broken"]> = [];
    // §app.merge-queue/time-limit: a check cut at its time limit (on the merge, or on its rerun there) is timed on the
    // target alone below; `overTime` the ones that run past it there too.
    const slow: { check: PlannedCheck; log: string }[] = [];
    const overTime: { check: PlannedCheck; log: string }[] = [];
    const slowMine: { check: PlannedCheck; log: string; ms: number }[] = [];
    // The run's last look for late picks: once every check has run and the review has answered (polled meanwhile). A
    // pick after this one runs the whole run again before it lands (queue.ts finish).
    const moreLate = async (): Promise<boolean> => {
      if (pullLate()) return true;
      if (review && input.latePicks) {
        let settled = false;
        void review.settled.then(() => (settled = true));
        while (!settled && !signal.aborted) {
          await Promise.race([review.settled, pause(deps.latePollMs ?? LATE_POLL_MS)]);
          if (pullLate()) return true;
        }
      }
      return pullLate();
    };
    for (let i = 0; ; i++) {
      if (i > 0 && i < list.length) pullLate();
      if (i >= list.length && !(await moreLate())) break;
      if (signal.aborted) return finish(voided("aborted"));
      const check = list[i];
      if (!check) break;
      ran.add(check.id);
      // A late pick needing a service this run didn't start: run again from the start, with it planned.
      const missing = check.requires.filter((s) => !needs.includes(s));
      if (missing.length) return finish(voided(`${check.label}, added after the run started, needs ${missing.join(", ")}: running again with it`));
      const st = steps.start(`check:${check.id}`, "check", check.label, { source: check.source, ...(check.why ? { why: check.why } : {}) });
      const r = await runCheck({ def, scope, check, stepId: check.id, logFile: st.file, fresh: fresh({ release }), signal });
      if (r.proc.aborted || signal.aborted) return finish((st.end("failed", { detail: "aborted" }), voided("aborted")));
      if (r.proc.timedOut) {
        st.end("failed", { detail: `ran past its time limit (${check.timeoutSec} s): timed on ${target} alone next` });
        slow.push({ check, log: st.s.log });
        continue;
      }
      const counts = countsOf(r.report);
      logReused(st, r);
      if (r.proc.code === 0) {
        const [result, end] = passedEnd(r, counts);
        st.end(result, end);
        // What this run reused: each check whose earlier passes on identical code stood.
        if (end.reused) {
          checksReused.push({ id: check.id, files: end.reused });
          hooks.ranWith?.({ checksReused: [...checksReused] });
        }
        continue;
      }
      st.end("failed", { counts, detail: r.failingFiles.length ? `${r.failingFiles.length} failing file${r.failingFiles.length === 1 ? "" : "s"}` : `exit ${r.proc.code}`, failures: (r.report?.failures ?? r.failingFiles.map((file) => ({ file }))).slice(0, 50) });
      // Again on the tip: what passes now is flaky. Failures named with no file (Kaocha) are told apart by name: the
      // whole check runs again and each name is followed, so a new failure isn't masked by another one red on master.
      // A reported file the merge doesn't have (a bare "handler_test.clj", nasabii) is no path to rerun or look for on
      // the target: the check's failures are then followed by name too.
      const paths = r.failingFiles.length ? await filesOn(copy, "HEAD", r.failingFiles) : [];
      // As narrow as the check can rerun: only the failing tests by name (it declares rerunTest and the report names
      // them), else only their files (rerun), else the whole check, only when the runner named no failure at all. A
      // check that named its failures but can't rerun just them isn't rerun on the tip: the whole suite never runs
      // again just to get a pass; its failures go on to the target alone.
      const tests = check.rerunTest ? [...new Set((r.report?.failingTests ?? []).map((t) => t.test).filter(Boolean))] : [];
      const byName = tests.length > 0 || paths.length < r.failingFiles.length || !r.failingFiles.length;
      const files = check.rerun && !byName ? r.failingFiles : [];
      const names = byName ? idsOf(r) : [];
      if (!tests.length && !files.length && (names.length || r.failingFiles.length)) {
        const skip = steps.start(`rerun-tip:${check.id}`, "rerun-tip", `${check.label} again`);
        skip.log(`not rerun: ${check.label} can't run only its failing tests (it declares no rerunTest${check.rerun ? "" : " and no rerun of files"}), and the whole suite never runs again just to get a pass\n`);
        skip.end("skipped", { detail: "can't rerun only the failing tests: not rerun" });
        hookEvent(hooks, { kind: "note", by: "queue", note: "not-rerun", step: `check:${check.id}`, why: `${check.label} wasn't run again on the merge: it can't run only its failing tests, and the whole suite never reruns just to get a pass` });
        reds.push(names.length ? { check, files: [], names } : { check, files: [], tipNamed: r.failingFiles, runs: [{ code: r.proc.code, noTest: ranNoTest(r) }], marks: [st] });
        continue;
      }
      const fileOfName = (n: string): string | undefined => r.report?.failures.find((f) => f.name && testKey(f.name) === n)?.file;
      const seenAs = (n: string): FlakySeen => (byName && r.report?.failingNames.length ? { check: check.id, label: check.label, name: n, ...(fileOfName(n) ? { file: fileOfName(n)! } : {}) } : { check: check.id, label: check.label, file: n });
      const again = steps.start(`rerun-tip:${check.id}`, "rerun-tip", `${check.label} again${tests.length ? ` (${tests.length} test${tests.length === 1 ? "" : "s"})` : files.length ? ` (${files.length} file${files.length === 1 ? "" : "s"})` : ""}`);
      hookEvent(hooks, { kind: "note", by: "queue", note: "narrow-rerun", step: `check:${check.id}`, why: tests.length ? `${check.label} again on the merge, only its failing test${tests.length === 1 ? "" : "s"}: ${tests.slice(0, 5).join(", ")}${tests.length > 5 ? ", …" : ""}` : files.length ? `${check.label} again on the merge, only its failing file${files.length === 1 ? "" : "s"}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}` : `${check.label} again on the merge, whole: it named no failing test or file` });
      const r2 = await runCheck({ def, scope, check, stepId: `rerun-tip:${check.id}`, logFile: again.file, ...(files.length ? { files } : {}), ...(tests.length ? { tests } : {}), fresh: fresh({ rerun: true }), signal });
      if (r2.proc.aborted || signal.aborted) return finish((again.end("failed", { detail: "aborted" }), voided("aborted")));
      if (r2.proc.timedOut) {
        again.end("failed", { detail: `ran past its time limit (${check.timeoutSec} s): timed on ${target} alone next` });
        slow.push({ check, log: again.s.log });
        continue;
      }
      // Never a pass on a guess: the rerun counts for a file only when it shows it ran it (`ranFiles`, or for a runner that
      // lists none, at least one test ran). A file it didn't run is still failing (on to the target alone), never flaky.
      const ranTip = r2.report?.ranFiles;
      const anyRan = !!r2.report && (r2.report.passed ?? 0) + (r2.report.failed ?? 0) > 0;
      const unrun = files.filter((f) => (ranTip ? !ranTip.includes(f) : !anyRan));
      // A whole or by-name rerun whose report says no test ran at all proves nothing either.
      const ranNothing = !files.length && ranNothingIn(r2.report);
      if (r2.proc.code === 0 && !unrun.length && !ranNothing) {
        again.end("passed", { detail: "passes on a rerun: flaky" });
        const each = files.length ? files : names;
        flakySeen.push(...(each.length ? each.map(seenAs) : [{ check: check.id, label: check.label }]));
        blames.push(each.length ? { id: check.id, label: check.label, files: each.map((file) => ({ file, blame: blameFile({ passesOnTip: true }) })) } : { id: check.id, label: check.label, whole: blameCheck({ passesOnTip: true }) });
        continue;
      }
      if (names.length) {
        const n2 = idsOf(r2);
        // A rerun that fails naming nothing tells nothing apart: every name is still failing.
        const stillN = n2.length ? names.filter((n) => n2.includes(n)) : names;
        const flakyN = names.filter((n) => !stillN.includes(n));
        // Names the rerun alone fails are followed too (their flakiness can't be told from one run).
        const extra = n2.filter((n) => !names.includes(n));
        again.end("failed", { detail: `${stillN.length} still failing${flakyN.length ? `, ${flakyN.length} passed` : ""}${extra.length ? `, ${extra.length} new` : ""}` });
        if (flakyN.length) blames.push({ id: check.id, label: check.label, files: flakyN.map((file) => ({ file, blame: "flaky" as const })) });
        flakySeen.push(...flakyN.map(seenAs));
        if (!stillN.length && !extra.length) continue;
        const tests2 = tests.length ? [...new Set([...tests, ...(r2.report?.failingTests ?? []).map((t) => t.test).filter(Boolean)])] : [];
        reds.push({ check, files: [], names: [...stillN, ...extra], ...(tests2.length ? { tests: tests2 } : {}) });
        continue;
      }
      // With files: the ones the rerun still names (all of them when it names none), and every one it didn't run.
      const still = files.length ? (r2.proc.code === 0 ? unrun : r2.failingFiles.length ? files.filter((f) => r2.failingFiles.includes(f) || unrun.includes(f)) : files) : [];
      const flaky = files.filter((f) => !still.includes(f));
      again.end("failed", {
        detail: files.length
          ? `${still.length} still failing${unrun.length ? ` (${unrun.length} not run by the rerun)` : ""}${flaky.length ? `, ${flaky.length} passed` : ""}`
          : r2.proc.code === 0
            ? "the rerun ran no test"
            : `exit ${r2.proc.code}`,
      });
      if (files.length && !still.length) {
        blames.push({ id: check.id, label: check.label, files: files.map((file) => ({ file, blame: "flaky" as const })) });
        flakySeen.push(...files.map(seenAs));
        continue;
      }
      reds.push({
        check,
        files: still,
        ...(files.length ? {} : { tipNamed: r2.failingFiles.length ? r2.failingFiles : namesOf(r2), runs: [{ code: r.proc.code, noTest: ranNoTest(r) }, { code: r2.proc.code, noTest: ranNoTest(r2) }], marks: [st, again] }),
      });
      if (flaky.length) blames.push({ id: check.id, label: check.label, files: flaky.map((file) => ({ file, blame: "flaky" as const })) });
      flakySeen.push(...flaky.map(seenAs));
    }
    // 7. still red: the same on the target alone, in the same copy (after the review has read the tip).
    if (reds.length || slow.length) {
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
      for (const { check, files, names, tests, tipNamed, runs, marks } of reds) {
        const onBase = files.length ? await filesOn(copy, base, files) : [];
        const absent = files.filter((f) => !onBase.includes(f));
        const st = steps.start(`rerun-master:${check.id}`, "rerun-master", `${check.label} on ${target} alone${tests?.length ? ` (${tests.length} test${tests.length === 1 ? "" : "s"})` : files.length ? ` (${onBase.length} file${onBase.length === 1 ? "" : "s"})` : ""}`);
        if (files.length && !onBase.length) {
          st.end("skipped", { detail: `${target} hasn't these test files: the branch's` });
          blames.push({ id: check.id, label: check.label, files: files.map((file) => ({ file, blame: "branch" as const })) });
          continue;
        }
        const r = await runCheck({ def, scope: baseScope, check, stepId: `rerun-master:${check.id}`, logFile: st.file, ...(files.length ? { files: onBase } : {}), ...(tests?.length ? { tests } : {}), fresh: fresh({ rerun: true }), signal });
        if (r.proc.aborted || signal.aborted) return finish((st.end("failed", { detail: "aborted" }), voided("aborted")));
        if (r.proc.timedOut) {
          // Red with the branch, and past the limit on the target alone: whose can't be told in time; the user decides.
          st.end("failed", { detail: `runs past its ${check.timeoutSec} s limit on ${target} alone: whose failure can't be told` });
          overTime.push({ check, log: st.s.log });
          continue;
        }
        if (names?.length) {
          const onT = idsOf(r);
          if (r.proc.code !== 0 && !onT.length) {
            // Red on the target naming no test: nothing to tell the names apart by; whose it is can't be told.
            st.end("failed", { detail: `fails on ${target} too, naming no test: can't tell whose failure` });
            blames.push({ id: check.id, label: check.label, whole: "unattributed" });
            continue;
          }
          if (r.proc.code === 0 && ranNothingIn(r.report)) {
            // Never a pass on a guess: a run on the target that ran no test says nothing about these names.
            st.end("passed", { detail: `the rerun on ${target} ran no test: can't tell whose failure` });
            blames.push({ id: check.id, label: check.label, unclearFiles: names });
            continue;
          }
          const failing = r.proc.code === 0 ? [] : names.filter((n) => onT.includes(n));
          st.end(r.proc.code === 0 ? "passed" : "failed", { detail: r.proc.code === 0 ? `passes on ${target}: the branch's` : `${failing.length} of ${names.length} fail on ${target} too` });
          blames.push({ id: check.id, label: check.label, files: names.map((file) => ({ file, blame: blameFile({ passesOnTip: false, onTarget: failing.includes(file) ? "fails" : "passes" }) })) });
        } else if (files.length) {
          const failing = r.proc.code === 0 ? [] : r.failingFiles.length ? onBase.filter((f) => r.failingFiles.includes(f)) : onBase;
          // Never a pass on a guess: a file counts as passing on the target only when the rerun shows it ran (it names it
          // in `ranFiles`; a runner that names none must have run some test). Else whose failure it is can't be told.
          const ran = r.report?.ranFiles;
          const someRan = !!r.report && (r.report.passed ?? 0) + (r.report.failed ?? 0) > 0;
          const unproven = onBase.filter((f) => !failing.includes(f) && (ran ? !ran.includes(f) : !someRan));
          if (unproven.length) {
            const proven = onBase.filter((f) => !unproven.includes(f));
            st.end(r.proc.code === 0 ? "passed" : "failed", { detail: `${unproven.length} of ${onBase.length} didn't run on ${target} alone: can't tell whose failure` });
            blames.push({
              id: check.id,
              label: check.label,
              unclearFiles: unproven,
              files: [...absent.map((file) => ({ file, blame: "branch" as const })), ...proven.map((file) => ({ file, blame: blameFile({ passesOnTip: false, onTarget: failing.includes(file) ? "fails" : "passes" }) }))],
            });
            continue;
          }
          st.end(r.proc.code === 0 ? "passed" : "failed", { detail: r.proc.code === 0 ? `passes on ${target}: the branch's` : `${failing.length} fail on ${target} too` });
          blames.push({ id: check.id, label: check.label, files: [...absent.map((file) => ({ file, blame: "branch" as const })), ...onBase.map((file) => ({ file, blame: blameFile({ passesOnTip: false, onTarget: failing.includes(file) ? "fails" : "passes" }) }))] });
        } else if (r.proc.code === 0 && ranNothingIn(r.report)) {
          // Never a pass on a guess: exit 0 from a run that ran no test (an empty selection on the target) proves nothing.
          st.end("passed", { detail: `the rerun on ${target} ran no test: can't tell whose failure` });
          blames.push({ id: check.id, label: check.label, whole: "unattributed", why: `can't tell whose failure: ${check.label} ran no test on ${target} alone` });
        } else if (r.proc.code === 0) {
          st.end("passed", { detail: `passes on ${target}: the branch's` });
          blames.push({ id: check.id, label: check.label, whole: blameCheck({ passesOnTip: false, onTarget: "passes" }) });
        } else {
          // Red on both: told apart only when both runs name their failures (a failure the target hasn't is the
          // branch's, whatever the counts); else it waits for the user, never landed as the target's.
          const onT = r.failingFiles.length ? r.failingFiles : namesOf(r);
          // Never on a release: it must not pass with its test gates unrun; it waits on the user as before.
          if (!release && runs && brokenOnTarget({ testCheck: isTestCheck(def, check), runs: [...runs, { code: r.proc.code, noTest: ranNoTest(r) }] })) {
            // A test check that runs no test anywhere, with the same exit each time: its command is broken on the
            // target (a bad flag, a missing selector). Not the branch's to fix: skipped for it, and flagged.
            const why = `${check.label} is broken on ${target}: no test ran (${firstOutputLine(r.proc.out) ?? `exit ${r.proc.code}`})`;
            st.end("skipped", { detail: why, broken: true });
            for (const m of marks ?? []) m.mark("skipped", { detail: `${check.label} is broken on ${target}: skipped for this branch` });
            blames.push({ id: check.id, label: check.label, whole: "broken", why });
            broken.push({ check: check.id, label: check.label, why, step: `rerun-master:${check.id}` });
          } else if (!tipNamed?.length || !onT.length) {
            st.end("failed", { detail: `fails on ${target} too, naming no tests: can't tell whose failure` });
            blames.push({ id: check.id, label: check.label, whole: "unattributed" });
          } else {
            const mine = tipNamed.filter((n) => !onT.includes(n));
            st.end("failed", { detail: `fails on ${target} too; ${mine.length} of ${tipNamed.length} only with the branch` });
            blames.push({ id: check.id, label: check.label, files: tipNamed.map((file) => ({ file, blame: mine.includes(file) ? ("branch" as const) : ("master" as const) })) });
          }
        }
      }
      // Each check cut at its time limit, timed on the target alone: fresh, with the same limit.
      for (const s of slow) {
        const { check } = s;
        const st = steps.start(`rerun-master:${check.id}`, "rerun-master", `${check.label} on ${target} alone, timed`);
        st.log(`[${check.label} ran past its ${check.timeoutSec} s limit with the branch: timing it on ${target} alone, fresh, with the same limit]\n`);
        hooks.event?.({ kind: "note", by: "queue", note: "timeout-probe", step: `check:${baseOf(check.id)}`, why: `${check.label} ran past its ${check.timeoutSec} s time limit with the branch: timing it on ${target} alone` });
        const r = await runCheck({ def, scope: baseScope, check, stepId: `rerun-master:${check.id}`, logFile: st.file, fresh: true, signal });
        if (r.proc.aborted || signal.aborted) return finish((st.end("failed", { detail: "aborted" }), voided("aborted")));
        if (r.proc.timedOut) {
          st.end("failed", { detail: `runs past its ${check.timeoutSec} s limit on ${target} alone too: not the branch's` });
          overTime.push({ check, log: st.s.log });
          continue;
        }
        st.end(r.proc.code === 0 ? "passed" : "failed", { detail: `finishes on ${target} alone in ${secsOf(r.proc.ms)} (limit ${check.timeoutSec} s${r.proc.code === 0 ? "" : `, exit ${r.proc.code}`}): the time-out is the branch's` });
        slowMine.push({ check, log: s.log, ms: r.proc.ms });
      }
    }
    const a = summarize(blames, { resolution: !!input.resolution, target });
    const flagged = broken.length ? { broken } : {};
    const at = now();
    const attributed = a.notes.map((n) => ({ ...n, at }));
    // A time-out that is the branch's goes back to its chat like any failure: the check, its limit, both times, its log.
    if (slowMine.length) {
      const slowWhy = slowMine.map((s) => `${s.check.label} ran past its ${s.check.timeoutSec} s time limit with your branch and finishes in ${secsOf(s.ms)} on ${target} alone (log: ${s.log})`).join("; ");
      return finish(out({ verdict: "failed", blame: a.verdict === "failed" ? a.blame! : input.resolution ? "resolution" : "branch", why: a.verdict === "failed" ? `${a.why}; ${slowWhy}` : slowWhy, notes: attributed, copy, mergeSha, tip, ...(a.targetRed.length ? { targetRed: a.targetRed } : {}), ...flagged }));
    }
    if (a.verdict === "failed") return finish(out({ verdict: "failed", blame: a.blame!, why: a.why!, notes: attributed, copy, mergeSha, tip, ...(a.targetRed.length ? { targetRed: a.targetRed } : {}), ...flagged }));
    // Past the limit on the target alone too: not the branch's. The queue pauses at once and asks the user.
    if (overTime.length) {
      const why = overTime.map((o) => `${o.check.label} runs past its ${o.check.timeoutSec} s time limit on ${target} alone too (log: ${o.log})`).join("; ");
      return finish(out({ verdict: "machine", blame: "machine", why, overTime: overTime.map((o) => ({ check: baseOf(o.check.id), label: o.check.label, limitSec: o.check.timeoutSec })), notes: attributed, copy, mergeSha, tip }));
    }
    const r = review ? await review.result : null;
    if (a.verdict === "unattributed") {
      // Waits for the user (Land Anyway lands `tip`); a blocking review still says so first.
      return reviewed(r, out({ verdict: "unattributed", why: a.why!, notes: attributed, copy, mergeSha, tip, targetRed: a.targetRed, unclear: a.unclear.map((u) => ({ check: u.id, label: u.label, step: `rerun-master:${u.id}`, why: u.why })), ...flagged }));
    }
    return reviewed(r, out({ verdict: "passed", notes: attributed, copy, mergeSha, tip, ...(a.targetRed.length ? { targetRed: a.targetRed } : {}), ...(broken.length ? { why: broken.map((b) => b.why).join("; ") } : {}), ...flagged }));
  } finally {
    await services?.down().catch(() => undefined);
  }
}

/**
 * A dry run (merge.setup dryRun; RunInput.tryOnly): the checks a project is about to declare, run on the target itself,
 * merging nothing. The copy reset to `base`, setup, then the checks `input.project.def` declares (the user's unsaved
 * answer), each failure run once more (a pass then is noted flaky). No review, no attribution: a red here is the
 * project's own, never a branch's. A trial (merge.try, `trialOf`) of a branch or commit runs the landing's docs step
 * after setup, before any check, and judges whose a red check is (trialWhose). Outcome: passed (noChecks when "none"), failed with the failing step's label,
 * machine or void.
 */
async function tryOnce(input: RunInput, hooks: RunHooks, deps: RunDeps): Promise<RunOutcome> {
  const { project, base, signal } = input;
  const target = project.target;
  // A trial (merge.try) runs on the setup branch's head, not the target: its words say whose it is.
  const where = input.trialOf ? `${input.trialOf} at ${short(base)}` : `${target} itself`;
  const steps = new Steps(input.runDir, hooks);
  const notes: MergeNote[] = [];
  let checksShown: CheckPick[] = [];
  const out = (o: Omit<RunOutcome, "notes" | "checks">): RunOutcome => ({ ...o, notes, checks: checksShown });
  const voided = (why: string) => out({ verdict: "void", why });
  const copy = mergeCopyPath(project.root);
  const def = project.def;
  const cs = steps.start("copy", "copy", "Merge copy");
  try {
    assertCopyOutsideState(copy, { root: project.root, ...(deps.state ? { state: deps.state } : {}), ...(deps.home ? { home: deps.home } : {}) });
    hooks.copy?.(copy);
    cs.log(`copy: ${copy}\nbase: ${base} (${input.trialOf ?? target}), nothing merged\n`);
    await prepareCopy({ root: project.root, path: copy, base, log: cs.log, signal, ...(deps.state ? { state: deps.state } : {}), ...(deps.home ? { home: deps.home } : {}) });
  } catch (err) {
    if (signal.aborted) return (cs.end("failed", { detail: "aborted" }), voided("aborted"));
    const why = err instanceof Error ? err.message : String(err);
    cs.end("failed", { detail: why });
    return out({ verdict: "machine", why: err instanceof CopyRefused ? `refused: ${why}` : `the merge copy couldn't be made ready: ${why}` });
  }
  cs.end("passed", { detail: `${copy} at ${short(base)}` });
  if (!def) return out({ verdict: "machine", why: `${target} has no readable .sova/project.json`, copy });
  const declared = checksOf(def);
  if (declared === "unset") return out({ verdict: "machine", why: "no checks given to try", copy });
  const filled = await fillSteps(copy, steps, signal);
  if (filled) return signal.aborted ? voided("aborted") : out({ verdict: "machine", why: filled, copy });
  const changedFile = join(input.runDir, "changed.txt");
  // A trial runs every check in full: every tracked file of the commit reads as changed, and each check as picked.
  writeFileSync(changedFile, input.trialOf ? `${(await gitOut(copy, ["ls-tree", "-r", "--name-only", "HEAD"]).catch(() => "")).trim()}\n` : "\n");
  const names = input.namesFile ?? deps.leakNames?.({ id: project.id, root: project.root }) ?? null;
  const scope: CopyScope = { project: project.root, projectId: project.id, copy, slot: mergeSlotOf(def), data: join(input.runDir, "data"), target, base, tip: base, changedFile, ...(names ? { leakNames: names } : {}) };
  mkdirSync(scope.data, { recursive: true });
  const failed = await runSetup({ def, scope, steps, idPrefix: "setup:", labelPrefix: "Setup: ", kind: "setup", signal });
  if (signal.aborted) return voided("aborted");
  if (failed) {
    if (failed.timedOut) return voided(`setup ${failed.failed.id} timed out`);
    const again = await runSetup({ def, scope, steps, idPrefix: "rerun-tip:setup:", labelPrefix: "Setup again: ", kind: "rerun-tip", fresh: true, signal });
    if (signal.aborted) return voided("aborted");
    if (again && input.trialOf && input.trialTarget) {
      // Setup failing on the commit and on the target too is the machine's: the dry run couldn't run, nobody blamed.
      const t = input.trialTarget;
      const mv = steps.start("rerun-master:copy", "rerun-master", `Copy to ${target} alone`);
      let onTarget: Awaited<ReturnType<typeof runSetup>> | "unmoved" = "unmoved";
      try {
        await moveCopy({ path: copy, commit: t.head, log: mv.log, signal });
        mv.end("passed", { detail: short(t.head) });
        onTarget = await runSetup({ def: t.def, scope: { ...scope, tip: t.head, base: t.head }, steps, idPrefix: "rerun-master:setup:", labelPrefix: `Setup on ${target} alone: `, kind: "rerun-master", fresh: true, signal });
      } catch (err) {
        mv.end("failed", { detail: String(err instanceof Error ? err.message : err) });
      }
      if (signal.aborted) return voided("aborted");
      if (onTarget) return out({ verdict: "machine", why: `setup (${again.failed.id}) fails on ${where} and on ${target} alone`, copy });
      const line = `Setup (${again.failed.id}) fails at ${short(input.commit)}. This branch's change breaks it.`;
      return out({ verdict: "failed", why: line, copy, trialFailure: { kind: "dry-run", commit: input.commit, whose: "branch", line, checks: [{ id: `setup:${again.failed.id}`, label: `Setup (${again.failed.id})`, step: again.step.id, whose: "branch" }] } });
    }
    if (again) return out({ verdict: "failed", why: `setup (${again.failed.id}) fails on ${where} (log: ${again.step.log})`, copy });
    notes.push({ kind: "flaky", text: `setup (${failed.failed.id}) failed, then passed on a rerun`, at: now() });
  }
  // A dry run of a branch or commit (§app.project-setup/trial): the landing's own docs step, before any check, so the
  // checks judge the spec as it will be once the branch lands. The docs commit stays in the copy: nothing is kept.
  if (input.trialOf) {
    const own = input.draftsFromCommit && !input.draftsDir ? await committedDrafts(copy, input.runDir) : undefined;
    const docs = await makeDocs({ input: own ? { ...input, draftsDir: own } : input, copy, steps, ident: await identityEnv(copy), deps, signal });
    if (own) rmSync(own, { recursive: true, force: true });
    if (signal.aborted) return voided("aborted");
    if (docs.kind === "machine") return out({ verdict: "machine", why: docs.why, copy });
    if (docs.kind === "refused") return out({ verdict: "failed", blame: "branch", cause: "drafts", why: docs.why, copy, trialFailure: { kind: "dry-run", commit: input.commit, whose: "branch", line: docs.why, checks: [{ id: "docs", label: "Spec docs", step: "docs", whose: "branch" }] } });
    if (docs.kind === "made") {
      scope.tip = docs.sha;
      writeFileSync(changedFile, `${(await gitOut(copy, ["ls-tree", "-r", "--name-only", "HEAD"]).catch(() => "")).trim()}\n`);
    }
  }
  const list = planChecks(def, input.picks, input.releaseChecks).map((c) => (input.trialOf ? { ...c, picked: true as const } : c));
  checksShown = picksOf(list);
  hooks.checks(checksShown);
  if (declared === "none" && !list.length) return out({ verdict: "passed", noChecks: true, copy });
  let services: { slot: number; down: () => Promise<void> } | null = null;
  try {
    const needs = [...new Set(list.flatMap((c) => c.requires))];
    if (needs.length) {
      const ss = steps.start("services", "setup", `Start ${needs.join(", ")}`);
      if (!deps.services) return (ss.end("failed", { detail: "nothing here can start services" }), out({ verdict: "machine", why: `the checks need ${needs.join(", ")} running, and nothing here can start them`, copy }));
      try {
        services = await deps.services({ root: project.root, copy, names: needs, log: ss.log, signal });
        scope.slot = services.slot;
        ss.end("passed", { detail: `slot ${services.slot}` });
      } catch (err) {
        ss.end("failed", { detail: String(err instanceof Error ? err.message : err) });
        return signal.aborted ? voided("aborted") : out({ verdict: "machine", why: `couldn't start ${needs.join(", ")}: ${err instanceof Error ? err.message : err}`, copy });
      }
    }
    const red: string[] = [];
    // A dry run's checks still red after their rerun, with what each named (for whose failure and the Fix line).
    const reds: { check: PlannedCheck; step: string; tests: { file?: string; name?: string; message?: string }[]; named: string[]; first?: string }[] = [];
    for (const check of list) {
      const st = steps.start(`check:${check.id}`, "check", check.label, { source: check.source });
      const r = await runCheck({ def, scope, check, stepId: check.id, logFile: st.file, fresh: freshOf(def, { release: isReleaseRun(input) }), signal });
      if (r.proc.aborted || signal.aborted) return (st.end("failed", { detail: "aborted" }), voided("aborted"));
      if (r.proc.timedOut) return (st.end("failed", { detail: `timed out after ${check.timeoutSec} s` }), out({ verdict: "failed", why: `${check.label} timed out after ${check.timeoutSec} s on ${where}`, copy }));
      logReused(st, r);
      if (r.proc.code === 0) {
        st.end(...passedEnd(r, countsOf(r.report)));
        continue;
      }
      st.end("failed", { counts: countsOf(r.report), detail: `exit ${r.proc.code}`, failures: (r.report?.failures ?? []).slice(0, 50) });
      const again = steps.start(`rerun-tip:${check.id}`, "rerun-tip", `${check.label} again`);
      const r2 = await runCheck({ def, scope, check, stepId: `rerun-tip:${check.id}`, logFile: again.file, fresh: freshOf(def, { rerun: true }), signal });
      if (r2.proc.aborted || signal.aborted) return (again.end("failed", { detail: "aborted" }), voided("aborted"));
      if (r2.proc.code === 0 && !ranNothingIn(r2.report)) {
        again.end("passed", { detail: "passes on a rerun: flaky" });
        notes.push({ kind: "flaky", text: `${check.label} failed, then passed on a rerun`, at: now() });
      } else {
        again.end("failed", { detail: r2.proc.code === 0 ? "the rerun ran no test" : `exit ${r2.proc.code}` });
        red.push(check.label);
        const tests = (r2.report?.failures ?? r.report?.failures ?? (r2.failingFiles.length ? r2.failingFiles : r.failingFiles).map((file) => ({ file }))).slice(0, 50);
        const first = firstOutputLine(r2.proc.out) ?? firstOutputLine(r.proc.out);
        reds.push({ check, step: `rerun-tip:${check.id}`, tests, named: r2.failingFiles.length ? r2.failingFiles : namesOf(r2), ...(first ? { first } : {}) });
      }
    }
    if (red.length && input.trialOf) {
      const failure = await trialWhose({ input, deps, copy, scope, steps, reds, signal });
      if (signal.aborted) return voided("aborted");
      return out({ verdict: "failed", why: failure.line, copy, trialFailure: failure });
    }
    if (red.length) return out({ verdict: "failed", why: `${red.join(", ")} fail${red.length === 1 ? "s" : ""} on ${where}`, copy });
    return out({ verdict: "passed", copy });
  } finally {
    await services?.down().catch(() => undefined);
  }
}

/**
 * Whose a dry run's red checks are, as a landing tells it (§app.project-setup/trial): each one the target also declares
 * runs on the target's head alone, in the same copy, with the target's own definition of it. Passing there: the
 * branch's change breaks it; failing there with every name the branch's failed too (or naming none on either side):
 * the target's too; failing with names the target hasn't: the branch's. A check the target doesn't have is the
 * branch's alone; setup failing on the target, or a rerun that ran no test, can't tell.
 */
async function trialWhose(o: {
  input: RunInput;
  deps: RunDeps;
  copy: string;
  scope: CopyScope;
  steps: Steps;
  reds: { check: PlannedCheck; step: string; tests: { file?: string; name?: string; message?: string }[]; named: string[]; first?: string }[];
  signal: AbortSignal;
}): Promise<NonNullable<RunOutcome["trialFailure"]>> {
  const { input, copy, steps, reds, signal } = o;
  const target = input.project.target;
  const t = input.trialTarget;
  const checks: NonNullable<RunOutcome["trialFailure"]>["checks"] = reds.map((r) => ({ id: r.check.id, label: r.check.label, step: r.step, whose: "branch" as const, ...(r.tests.length ? { tests: r.tests } : {}) }));
  const shared = t ? reds.filter((r) => Array.isArray(t.def.merge?.checks) && t.def.merge.checks.some((c) => c.id === r.check.id)) : [];
  if (t && shared.length) {
    const mv = steps.start("rerun-master:copy", "rerun-master", `Copy to ${target} alone`);
    let moved = true;
    try {
      await moveCopy({ path: copy, commit: t.head, log: mv.log, signal });
      mv.end("passed", { detail: short(t.head) });
    } catch (err) {
      mv.end("failed", { detail: String(err instanceof Error ? err.message : err) });
      moved = false;
    }
    const baseScope: CopyScope = { ...o.scope, tip: t.head, base: t.head };
    const setupFailed = moved && !signal.aborted ? await runSetup({ def: t.def, scope: baseScope, steps, idPrefix: "rerun-master:setup:", labelPrefix: `Setup on ${target} alone: `, kind: "rerun-master", signal }) : null;
    for (const r of shared) {
      const c = checks.find((x) => x.id === r.check.id)!;
      if (signal.aborted) break;
      if (!moved || setupFailed) {
        c.whose = "unclear";
        continue;
      }
      const planned = planChecks(t.def, [{ id: r.check.id, label: r.check.label, source: "picked", why: "whose failure" }]).find((x) => x.id === r.check.id);
      if (!planned) continue;
      const st = steps.start(`rerun-master:${r.check.id}`, "rerun-master", `${r.check.label} on ${target} alone`);
      const rr = await runCheck({ def: t.def, scope: baseScope, check: { ...planned, picked: true as const }, stepId: `rerun-master:${r.check.id}`, logFile: st.file, fresh: freshOf(t.def, { rerun: true }), signal });
      if (rr.proc.aborted || signal.aborted) {
        st.end("failed", { detail: "aborted" });
        break;
      }
      if (rr.proc.code === 0 && ranNothingIn(rr.report)) {
        st.end("passed", { detail: `the run on ${target} ran no test: can't tell whose failure` });
        c.whose = "unclear";
      } else if (rr.proc.code === 0) {
        st.end("passed", { detail: `passes on ${target}: the branch's` });
        c.whose = "branch";
      } else {
        const onT = rr.failingFiles.length ? rr.failingFiles : namesOf(rr);
        const mine = r.named.filter((n) => !onT.includes(n));
        c.whose = r.named.length && onT.length && mine.length ? "branch" : r.named.length && !onT.length ? "unclear" : "master";
        st.end("failed", { detail: c.whose === "master" ? `fails on ${target} too` : c.whose === "branch" ? `fails on ${target} too; ${mine.length} of ${r.named.length} only with the branch` : `fails on ${target} too, naming no tests: can't tell whose failure` });
      }
    }
  }
  const whose: "branch" | "master" | "unclear" = checks.some((c) => c.whose === "branch") ? "branch" : checks.some((c) => c.whose === "unclear") ? "unclear" : "master";
  const lead = checks.find((c) => c.whose === whose) ?? checks[0]!;
  const sha = short(input.commit);
  const names = (lead.tests ?? []).map((x) => x.name ?? x.file).filter((x): x is string => !!x);
  const first = reds.find((r) => r.check.id === lead.id)?.first;
  const fails = names.length ? `${names.length} failing test${names.length === 1 ? "" : "s"} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""})` : (first ?? "it printed nothing");
  const words = whose === "branch" ? "This branch's change breaks it." : whose === "master" ? `Fails on ${target} too: not this branch's.` : `Can't tell whose failure: it fails on ${target} alone too.`;
  const more = checks.length > 1 ? ` (and ${checks.length - 1} more check${checks.length === 2 ? "" : "s"})` : "";
  return { kind: "dry-run", commit: input.commit, whose, line: `${lead.label} fails at ${sha}${more}: ${fails}. ${words}`, checks };
}

/** The run's outcome with the review's verdict folded in. */
function reviewed(r: ReviewResult | null, o: RunOutcome): RunOutcome {
  if (!r) return o;
  if (!r.ok) return { ...o, verdict: "machine", blame: "reviewer", why: `the review couldn't finish: ${r.why}` };
  const v = r.verdict;
  if (v.verdict === "ok") return { ...o, review: v };
  if (v.verdict === "notes") return { ...o, review: v, notes: [...o.notes, { kind: "review", text: clip(v.text ?? "review notes", 300), at: v.at }] };
  return { ...o, review: v, verdict: "review-flagged", why: `review flagged: ${clip(v.text ?? "", 200)}` };
}

type ReviewResult = { ok: true; verdict: ReviewVerdict } | { ok: false; why: string };

function startReview(o: { input: RunInput; copy: string; tip: string; steps: Steps; deps: RunDeps; def: ProjectDef; hooks: RunHooks }): { result: Promise<ReviewResult>; settled: Promise<void>; cancel: () => Promise<void> } {
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
    // The branch's own kit (the merge copy is at the merged tip): what it declares, its hash, and whether the branch
    // changed it (§app.merge-queue/review-kit).
    const { decl, problems } = await readKitDecl(join(o.copy, kit));
    for (const p of problems) st.log(`review kit: ${p} (left out)\n`);
    const fixes = o.def.merge?.reviewFixes === true && !o.input.entry.release;
    const changed = await kitChangedBy(o.copy, o.input.base, o.tip, kit);
    // A shell the target's kit doesn't give: the branch gave it to its own reviewer, said as plainly.
    const shellByBranch = !!changed.length && !!decl.tools?.includes("shell") && !(await kitDeclAt(o.copy, o.input.base, kit)).tools?.includes("shell");
    const stamp: ReviewKitStamp = { path: kit, hash: (await kitHashAt(o.copy, o.tip, kit)) ?? "", ...(Object.keys(decl).length ? { decl } : {}), ...(fixes ? { fixes: true as const } : {}), ...(changed.length ? { changed } : {}), ...(shellByBranch ? { shellByBranch: true as const } : {}) };
    if (changed.length) {
      st.log(`${ownReviewWords(changed)}${shellByBranch ? "; this branch gave its reviewer a shell" : ""}\n${await kitDiff(o.copy, o.input.base, o.tip, kit)}\n`);
      st.update({ why: `review kit ${kit}; ${ownReviewWords(changed)}${shellByBranch ? "; this branch gave its reviewer a shell" : ""}` });
    }
    o.hooks.review?.(stamp);
    const event = (ev: { what: "started" | "kit-changed" | "fixed" | "verdict"; why: string; model?: string; sha?: string; verdict?: ReviewVerdict["verdict"] }) =>
      (o.hooks as { event?: (e: import("../../shared/merge-queue").MergeEventInput) => void }).event?.({ kind: "review", by: "reviewer", step: "review", kit: stamp.hash, ...ev });
    if (changed.length) event({ what: "kit-changed", why: `${ownReviewWords(changed)}${shellByBranch ? "; this branch gave its reviewer a shell" : ""}` });
    // A reviewer that can run or write works in a folder of its own, never the merge copy the checks run in: at the
    // tip, or at the branch's commit when it may fix (its commits there are its fix).
    const own = ownFolder(decl, fixes) ? { at: fixes ? o.input.commit : o.tip, fixes } : undefined;
    let folder = o.copy;
    if (own) {
      try {
        folder = await makeScratchCopy(realGit, { root: o.input.project.root, entry: o.input.entry.id, base: own.at, kind: "review" });
        st.log(`reviewer's own folder: ${folder} at ${own.at.slice(0, 12)}\n`);
      } catch (err) {
        const why = `couldn't make the reviewer's own folder: ${err instanceof Error ? err.message : String(err)}`;
        st.end("failed", { detail: why });
        return { ok: false as const, why };
      }
    }
    // Sova writes the change it reads (a read-only reviewer has no shell), and removes it when the review ends.
    const changeDir = reviewChangeDir(o.input.runDir);
    let r: ReviewResult;
    try {
      const change = await writeReviewChange(o.copy, o.input.base, o.tip, changeDir, ctl.signal);
      const kitModel = decl.model || decl.thinking ? { ...(decl.model ? { model: decl.model } : {}), ...(decl.thinking ? { thinking: decl.thinking } : {}) } : undefined;
      const step = await reviewStep(
        { awaitReview: o.input.awaitReview, runId: o.input.runId, projectId: o.input.project.id, root: o.input.project.root, copy: folder, base: o.input.base, commit: o.tip, branch: o.input.entry.branch, kit, target: o.input.project.target, change, log: st.log, signal: ctl.signal, decl, profile: reviewerProfileOf(decl, fixes), ...(kitModel ? { kitModel } : {}), ...(own ? { own } : {}), ...(decl.tools?.includes("shell") || fixes ? { shell: true } : {}) },
        o.deps,
      );
      if (step.ok) {
        if (step.model) stamp.model = step.model;
        if (step.thinking) stamp.thinking = step.thinking;
        if (step.limited) stamp.limited = step.limited;
        o.hooks.review?.(stamp);
        event({ what: "started", why: `The review ran with kit ${kit} (${stamp.hash.slice(0, 7) || "no hash"})${stamp.model ? ` on ${stamp.model}` : ""}${decl.passes && decl.passes > 1 ? `, ${decl.passes} reviewers` : ""}${step.limited ? `; ${step.limited}` : ""}`, ...(stamp.model ? { model: stamp.model } : {}) });
        let verdict: ReviewVerdict = { ...step.verdict, kit: structuredClone(stamp) };
        // The fixer's commits on top of the branch's commit are its fix: taken with a blocking verdict only, pinned
        // under a hidden ref until the queue puts it on the branch (its folder goes when the review ends).
        if (own?.fixes && !step.limited) {
          const fix = await reviewerFixIn(folder, o.input.commit);
          if (fix && "none" in fix) st.log(`${fix.none}\n`);
          else if (fix && verdict.verdict !== "blocking") st.log(`the reviewer committed ${fix.commit.slice(0, 7)} with a ${verdict.verdict} verdict: only a blocking verdict's fix is taken, so it was left out\n`);
          else if (fix) {
            const pin = await gitProc(o.input.project.root, ["update-ref", `${REVIEW_FIX_REFS}${o.input.entry.id}`, fix.commit]);
            if (pin.code === 0) {
              verdict = { ...verdict, fix };
              event({ what: "fixed", why: `The reviewer fixed its blocking findings itself: commit ${fix.commit.slice(0, 7)}`, sha: fix.commit });
              st.log(`the reviewer's fix: ${fix.commit}\n`);
            } else st.log(`couldn't keep the reviewer's fix ${fix.commit.slice(0, 7)}: ${pin.out.trim().split("\n")[0]}\n`);
          }
        }
        event({ what: "verdict", why: `The review's verdict: ${verdict.verdict}${verdict.summary ? `: ${clip(verdict.summary, 200)}` : ""}`, verdict: verdict.verdict, ...(stamp.model ? { model: stamp.model } : {}) });
        r = { ok: true, verdict };
      } else r = step;
    } catch (err) {
      r = { ok: false, why: `couldn't write the change for the reviewer: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      removeReviewChange(changeDir);
      if (own) await dropReviewCopy(realGit, o.input.project.root, o.input.entry.id);
    }
    if (r.ok) st.end(r.verdict.verdict === "blocking" ? "failed" : "passed", { detail: `${r.verdict.verdict}${r.verdict.fix ? ` (fixed by the reviewer: ${r.verdict.fix.commit.slice(0, 7)})` : ""}${r.verdict.text ? `: ${clip(r.verdict.text, 200)}` : ""}` });
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

/** The failing tests a check run names without a file (its SOVA_OUT failures' names), when it named no file. */
const namesOf = (r: { failingFiles: string[]; report: { failingNames: string[] } | null }): string[] => (r.failingFiles.length ? [] : (r.report?.failingNames ?? []));

/** The failures a run names when followed by name: its test names, else the files it reports (as reported). */
const idsOf = (r: { failingFiles: string[]; report: { failingNames: string[] } | null }): string[] => (r.report?.failingNames.length ? r.report.failingNames : r.failingFiles);

/** Every merge in the copy (beside NO_BACKGROUND_CLEANUP): never git rerere (a user's rerere.enabled + autoupdate would
 *  stage a recorded resolution silently and leave no unmerged path: a conflict must reach the thread and the user). */
const NO_RERERE: readonly string[] = ["-c", "rerere.enabled=false", "-c", "rerere.autoupdate=false"];

/** The files a failed merge conflicts in: the index's unmerged paths, else git's own merge of the two commits (a merge
 *  that failed with nothing unmerged, as a recorded resolution staged by some config leaves it, is still a conflict). */
async function conflictFiles(copy: string, a: string, b: string): Promise<string[]> {
  const u = (await gitProc(copy, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
  if (u.length) return u;
  const t = await conflictsBetween(copy, a, b);
  return "files" in t ? t.files : [];
}

/** The thread's resolution, taken: as is when its first parent is the target's head, else with the target merged in. */
/**
 * The copy's submodules and Git LFS files, each its own step (kind copy, ids "submodules" and "lfs"), only when the
 * tree at HEAD has them. → why it failed (the machine's, never the branch's), or null.
 */
async function fillSteps(copy: string, steps: Steps, signal: AbortSignal): Promise<string | null> {
  const has = await modulesOf(copy, "HEAD");
  const each: [boolean, string, string, typeof fillSubmodules][] = [
    [has.submodules, "submodules", "Submodules", fillSubmodules],
    [has.lfs, "lfs", "Large files (LFS)", fillLfs],
  ];
  for (const [on, id, label, fill] of each) {
    if (!on) continue;
    const st = steps.start(id, "copy", label);
    try {
      await fill({ path: copy, log: st.log, signal });
      st.end("passed");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      st.end("failed", { detail: signal.aborted ? "aborted" : why });
      return why;
    }
  }
  return null;
}

/** Whether this run lands as one commit: the project merges locally with `merge.squash`, and it isn't a release's. */
export function squashes(def: ProjectDef | null, input: Pick<RunInput, "entry" | "tryOnly" | "releaseChecks">): boolean {
  if (def?.merge?.squash !== true || input.tryOnly || isReleaseRun(input)) return false;
  const how = input.entry.approval.via ?? input.entry.approval.how ?? "local";
  return how === "local";
}

/** The branch's own commit subjects (oldest first) the merge brings onto `base`, merges left out. */
async function subjectsOf(copy: string, base: string, commit: string): Promise<string[]> {
  const r = await gitProc(copy, ["log", "--reverse", "--no-merges", "--format=%s", `${base}..${commit}`]);
  return r.code === 0 ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * A one-commit landing's message: the branch's only subject, or its name with every subject listed (the newest 50).
 * Pure.
 */
export function commitMessageOf(subjects: readonly string[], branch: string, target: string): string {
  if (subjects.length === 1) return `${subjects[0]}\n\nLanded from ${branch} onto ${target} as one commit.`;
  const shown = subjects.slice(-50);
  return `Land ${branch} onto ${target} (${subjects.length} commit${subjects.length === 1 ? "" : "s"})\n\n${shown.map((s) => `- ${s}`).join("\n")}${subjects.length > shown.length ? `\n- … ${subjects.length - shown.length} older` : ""}`;
}

/** One commit on `base` holding `of`'s tree, the copy moved to it (its work tree is that tree already). */
async function squashOnto(copy: string, base: string, of: string, message: string, ident: Record<string, string>, log: (s: string) => void): Promise<{ sha: string } | { error: string }> {
  log(`$ git commit-tree ${short(of)}^{tree} -p ${short(base)} (one commit)\n`);
  const c = await gitProc(copy, [...NO_BACKGROUND_CLEANUP, "commit-tree", `${of}^{tree}`, "-p", base, "-m", message], { env: ident, log });
  const sha = c.out.trim().split("\n").pop() ?? "";
  if (c.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { error: `the one-commit landing couldn't be made: ${tail(c.out)}` };
  const r = await gitProc(copy, [...NO_BACKGROUND_CLEANUP, "reset", "--hard", "--quiet", sha], { log });
  if (r.code !== 0) return { error: `the merge copy couldn't move to the one commit: ${tail(r.out)}` };
  return { sha };
}

async function takeResolution(copy: string, base: string, resolution: string, log: (s: string) => void, env: Record<string, string>, signal: AbortSignal): Promise<{ sha: string } | { conflict: string[] } | { error: string }> {
  const first = (await gitProc(copy, ["rev-parse", "--verify", "-q", `${resolution}^1`])).out.trim();
  const co = await gitProc(copy, ["checkout", "--detach", "--force", resolution], { log, signal });
  if (co.code !== 0) return { error: `the resolution ${short(resolution)} can't be checked out: ${tail(co.out)}` };
  if (first === base) return { sha: (await gitOut(copy, ["rev-parse", "HEAD"])) };
  log(`its first parent ${short(first)} isn't the target's head: merging ${short(base)} into it\n`);
  const m = await gitProc(copy, [...NO_BACKGROUND_CLEANUP, ...NO_RERERE, "merge", "--no-ff", "--no-edit", base], { env, log, signal });
  if (m.code !== 0) {
    const files = await conflictFiles(copy, resolution, base);
    await gitProc(copy, ["merge", "--abort"], { log });
    return files.length ? { conflict: files } : { error: `git merge failed: ${tail(m.out)}` };
  }
  return { sha: await gitOut(copy, ["rev-parse", "HEAD"]) };
}

/** The docs step: the approved drafts copied into the copy and made official as one commit, before any check. */
async function makeDocs(o: { input: RunInput; copy: string; steps: Steps; ident: Record<string, string>; deps: RunDeps; signal: AbortSignal }): Promise<{ kind: "none" } | { kind: "made"; sha: string } | { kind: "refused"; why: string } | { kind: "machine"; why: string }> {
  const src = o.input.draftsDir;
  const snapshot = src && existsSync(src) ? readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort() : [];
  const st = o.steps.start("docs", "docs", "Spec docs");
  // Only the branch's own drafts land: an untracked one it carries, or a tracked one it adds or changes. A tracked
  // draft the target already has (a project that commits its drafts) is never landed, changed or deleted here.
  // A dry run's base is the tried commit itself: the branch's own are told against the target's head, as at landing.
  const names = await ownDrafts(o.copy, o.input.tryOnly ? (o.input.trialTarget?.head ?? o.input.base) : o.input.base, o.input.commit, snapshot);
  const others = snapshot.filter((n) => !names.includes(n));
  if (others.length) st.log(`not the branch's (tracked, unchanged by it): ${others.length} draft${others.length === 1 ? "" : "s"}${others.length <= 10 ? ` (${others.join(", ")})` : ""}\n`);
  if (!names.length) {
    st.end("skipped", { detail: o.input.entry.approval.withoutSpecs ? "landing without its specs" : others.length ? "no spec drafts of the branch's own" : "no spec drafts" });
    return { kind: "none" };
  }
  if (!existsSync(join(o.copy, ".sova", "spec", "claims"))) {
    st.end("failed", { detail: "the target has no .sova/spec to land drafts into" });
    return { kind: "refused", why: `spec drafts (${names.join(", ")}) but ${o.input.project.target} has no .sova/spec` };
  }
  const core = o.deps.specCore ?? SPEC_CORE;
  const tool = join(core, "sova-spec-draft.mjs");
  if (!existsSync(tool)) {
    st.end("failed", { detail: `no spec tools at ${core}` });
    return { kind: "machine", why: `the spec tools aren't at ${core}, so the drafts can't be made official` };
  }
  // The drafts folder holds exactly the branch's drafts while land runs (land takes every draft it finds); the
  // target's tracked drafts come back from git afterwards, untouched.
  const dest = join(o.copy, ".sova", "spec", "drafts");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const n of names) {
    st.log(`copying draft ${n}\n`);
    cpSync(join(src!, n), join(dest, n), { recursive: true });
  }
  const restore = async () => {
    rmSync(dest, { recursive: true, force: true });
    if ((await gitProc(o.copy, ["cat-file", "-e", "HEAD:.sova/spec/drafts"])).code === 0) await gitProc(o.copy, ["checkout", "HEAD", "--", ".sova/spec/drafts"], { log: st.log });
  };
  try {
    return await landDrafts(o, st, names, tool);
  } finally {
    await restore();
  }
}

/** A bare commit's dry run: the drafts committed in it (the copy is at that commit), copied out file by file so no
 *  untracked draft of any folder rides along. undefined: it commits none. */
async function committedDrafts(copy: string, runDir: string): Promise<string | undefined> {
  const prefix = ".sova/spec/drafts/";
  const files = (await gitProc(copy, ["ls-files", "-z", "--", prefix])).out.split("\0").filter((f) => f.startsWith(prefix));
  if (!files.length) return undefined;
  const dir = join(runDir, "drafts");
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const to = join(dir, f.slice(prefix.length));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(copy, f), to);
  }
  return dir;
}

/** Of `snapshot`'s draft names, the branch's own: untracked in both the target and the pinned commit, or changed by
 *  the branch since its merge base with the target. */
export async function ownDrafts(copy: string, base: string, commit: string, snapshot: readonly string[]): Promise<string[]> {
  if (!snapshot.length) return [];
  const mb = (await gitProc(copy, ["merge-base", base, commit])).out.trim() || base;
  const tracked = (rev: string, n: string) => gitProc(copy, ["cat-file", "-e", `${rev}:.sova/spec/drafts/${n}`]).then((r) => r.code === 0);
  const out: string[] = [];
  for (const n of snapshot) {
    if (!(await tracked(base, n)) && !(await tracked(commit, n)) && !(await tracked(mb, n))) {
      out.push(n);
      continue;
    }
    const d = await gitProc(copy, ["diff", "--name-only", `${mb}..${commit}`, "--", `.sova/spec/drafts/${n}`]);
    if (d.out.trim()) out.push(n);
  }
  return out;
}

async function landDrafts(o: { input: RunInput; copy: string; ident: Record<string, string>; signal: AbortSignal }, st: Step, names: string[], tool: string): Promise<{ kind: "none" } | { kind: "made"; sha: string } | { kind: "refused"; why: string } | { kind: "machine"; why: string }> {
  const a = o.input.entry.approval;
  const dry = !!o.input.tryOnly;
  const by = dry ? "the merge queue (a dry run, never landed)" : a.by === "typed" ? "the user (land it, typed in the branch's chat)" : "the user (Land)";
  const verification = dry
    ? `Made official in the merge copy for a dry run of ${o.input.trialOf ?? o.input.entry.branch} at ${short(o.input.commit)}: never landed, published or kept (run ${o.input.runId})`
    : `Made official by the merge queue: ${o.input.entry.branch} at ${short(o.input.commit)}, approved ${a.at.slice(0, 16).replace("T", " ")}; committed before the run's checks (run ${o.input.runId})`;
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
    return { kind: "refused", why: `your spec drafts don't fit, so nothing was made official: ${f.join("; ").slice(0, 400)}. Fix them in your drafts (no commit needed) and answer the request: your user's Land stands.` };
  }
  const paths = (j.paths ?? []).filter((x): x is string => typeof x === "string" && x.startsWith(".sova/spec/") && !x.startsWith(".sova/spec/drafts/"));
  if (!paths.length) {
    st.end("skipped", { detail: "land wrote no spec file" });
    return { kind: "none" };
  }
  const add = await gitProc(o.copy, ["add", "--", ...paths], { log: st.log });
  if (add.code !== 0) return (st.end("failed", { detail: tail(add.out) }), { kind: "machine", why: `staging the docs failed: ${tail(add.out)}` });
  const subject = String(j.commitMessage?.subject || `Spec: land ${names.join(", ")}`);
  const c = await gitProc(o.copy, [...NO_BACKGROUND_CLEANUP, "commit", "--no-verify", "-m", subject, "-m", String(j.commitMessage?.body || verification), "-m", `Sova-Spec-Landing: merge-queue ${o.input.runId}`], { env: o.ident, log: st.log });
  if (c.code !== 0) return (st.end("failed", { detail: tail(c.out) }), { kind: "machine", why: `committing the docs failed: ${tail(c.out)}` });
  const sha = await gitOut(o.copy, ["rev-parse", "HEAD"]);
  // A dry run lands nothing: no record for the branch folder's drafts.
  if (!dry) keepLandedDrafts(o.input.runDir, o.copy, sha, names, st.log);
  st.end("passed", { detail: `${short(sha)}: ${subject}` });
  return { kind: "made", sha };
}

/** What the docs step made official, kept in the run folder (its merge copy's drafts are put back right after); the
 *  queue writes it onto the branch folder's drafts only once the target is at the tested tip (landed-drafts.ts). */
function keepLandedDrafts(runDir: string, copy: string, commit: string, names: readonly string[], log: (s: string) => void): void {
  const dir = join(copy, ".sova", "spec", "drafts");
  const drafts: LandedDraftsRecord["drafts"] = {};
  for (const n of names) {
    const hash = draftSpecHash(dir, n);
    if (!hash) continue;
    let promotions: unknown[] = [];
    try {
      const d = JSON.parse(readFileSync(join(dir, n, "draft.json"), "utf8")) as { promotions?: unknown };
      if (Array.isArray(d.promotions)) promotions = d.promotions;
    } catch {
      /* no receipt to copy: the landing marker alone */
    }
    drafts[n] = { hash, promotions };
  }
  try {
    writeFileSync(join(runDir, LANDED_DRAFTS_FILE), JSON.stringify({ commit, drafts } satisfies LandedDraftsRecord, null, 2) + "\n");
  } catch (err) {
    log(`couldn't keep what landed for the branch folder's drafts: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** The run folder's step logs, for merge.logs: the step's lines (newest last), at most `lines`. */
export function stepLog(runDir: string, step: Pick<RunStep, "log">, lines = 200): string[] {
  try {
    const all = (readRunLogText(runDir, step.log) ?? "").split("\n");
    return all.slice(Math.max(0, all.length - lines));
  } catch {
    return [];
  }
}

