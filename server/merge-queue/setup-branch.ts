/**
 * A setup branch (§app.merge-queue/setup): one whose changes reach the project's pipeline, the sections of
 * `.sova/project.json` the merge queue, releases and deploys act on (`merge`, `release`, `deploy`; a service only when a merge check requires it, the rest are conformance's), or
 * the files of the project's release playbook folder. The queue checks a branch with the target's checks, not the
 * branch's own, so such a branch is offered Land only once a trial (merge.try) of its exact head passed.
 *
 * Read from Git alone, at the two commits (never a worktree's files).
 */
import type { MergeRun, MergeTrial } from "../../shared/merge-queue";
import { CONTRACT_FILE, type MergeCheckDecl, type ProjectDef } from "../../shared/project-contract";
import type { Git } from "./guard";
import { setupChangeOf, stable } from "../../pi-config/extensions/worktrees/setup-rule.ts";

// The rule itself has one home, the worktree tool's (it refuses a plain merge of a setup branch by it).
export { changedSections, changedServices, DEFAULT_RELEASE_PLAYBOOK, isSetupChange, PIPELINE_SECTIONS, releaseFolders, requiredServices, type SetupChange, setupChangeOf, stable } from "../../pi-config/extensions/worktrees/setup-rule.ts";

/** Why a branch waits when Git can't tell whether it changes the project's setup (the gate fails closed). */
export const SETUP_UNREADABLE = "Sova can't tell whether this branch changes the project's setup: try again in a moment.";
/** The gate's answer when it can't read the dry run records: never a quiet pass. */
export const TRIAL_UNREADABLE = "Sova can't confirm a passing dry run of this branch now: try again in a moment.";

/**
 * A trial's release checks: each one new or changed against the target's release section, or named for the trial,
 * runs; the rest are reported not run (unchanged). Pure.
 */
export function trialReleaseChecks(branch: readonly MergeCheckDecl[], target: readonly MergeCheckDecl[], named: readonly string[]): { run: MergeCheckDecl[]; notRun: MergeCheckDecl[] } {
  const run: MergeCheckDecl[] = [];
  const notRun: MergeCheckDecl[] = [];
  for (const c of branch) {
    const was = target.find((t) => t.id === c.id);
    (named.includes(c.id) || !was || stable(was) !== stable(c) ? run : notRun).push(c);
  }
  return { run, notRun };
}

/** A merge check's declaration as the dry run compares it: argument list, time limit, rerun rule and required services
 *  (its label and optional flag aside). Pure. */
const checkKey = (c: MergeCheckDecl): string => stable({ run: c.run, timeout: c.timeout, rerun: c.rerun, requires: [...c.requires].sort() });

const mergeChecksOf = (def: ProjectDef | null | undefined): MergeCheckDecl[] => (Array.isArray(def?.merge?.checks) ? def.merge.checks : []);

/**
 * A dry run's merge checks: each one the branch declares that is new or changed against the target's (an id the target
 * hasn't, or a different argument list, time limit, rerun rule or required services), or that requires a service the
 * branch adds or changes, runs; the rest are left out (unchanged: they run in the landing). Pure.
 */
export function dryRunMergeChecks(branch: ProjectDef | null, target: ProjectDef | null, changedSvcs: readonly string[]): { run: MergeCheckDecl[]; notRun: MergeCheckDecl[] } {
  const run: MergeCheckDecl[] = [];
  const notRun: MergeCheckDecl[] = [];
  const on = mergeChecksOf(target);
  for (const c of mergeChecksOf(branch)) {
    const was = on.find((t) => t.id === c.id);
    (!was || checkKey(was) !== checkKey(c) || c.requires.some((r) => changedSvcs.includes(r)) ? run : notRun).push(c);
  }
  return { run, notRun };
}

/**
 * Why a branch needs a dry run, from its setup change against the target, each one line with no leading capital
 * ("adds the merge check Playbook tests"), in a stable order. `playbook`: it changes the release playbook's files. Pure.
 */
export function dryRunReasons(branch: ProjectDef | null, target: ProjectDef | null, change: { sections: readonly string[]; services: readonly string[]; playbook: boolean }): string[] {
  const out: string[] = [];
  if (change.sections.includes("merge")) {
    const a = mergeChecksOf(target);
    const b = mergeChecksOf(branch);
    for (const c of b) {
      const was = a.find((t) => t.id === c.id);
      if (!was) out.push(`adds the merge check ${c.label}`);
      else if (checkKey(was) !== checkKey(c)) out.push(`changes the merge check ${c.label}`);
    }
    for (const c of a) if (!b.some((x) => x.id === c.id)) out.push(`removes the merge check ${c.label}`);
    // Anything else of the section (the other settings, a label alone, "none" against a list): the merge settings.
    const rest = (d: ProjectDef | null) => stable({ ...(d?.merge ?? {}), checks: Array.isArray(d?.merge?.checks) ? null : (d?.merge?.checks ?? null) });
    if (rest(branch) !== rest(target) || !out.length) out.push("changes the merge settings");
  }
  for (const s of change.services) out.push(`changes the service ${s} a merge check needs`);
  if (change.sections.includes("release")) {
    const a = branch?.release?.checks ?? [];
    const was = target?.release?.checks ?? [];
    let n = 0;
    for (const c of a) {
      const t = was.find((x) => x.id === c.id);
      if (!t || stable(t) !== stable(c)) {
        out.push(`changes the release check ${c.label}`);
        n++;
      }
    }
    if (!n || stable({ ...(branch?.release ?? {}), checks: null, checkIds: null }) !== stable({ ...(target?.release ?? {}), checks: null, checkIds: null })) out.push("changes the release playbook");
  } else if (change.playbook) out.push("changes the release playbook");
  if (change.sections.includes("deploy")) {
    const a = branch?.deploy?.targets ?? [];
    const b = target?.deploy?.targets ?? [];
    const names = [...new Set([...a.map((t) => t.name), ...b.map((t) => t.name)])].filter((n) => stable(a.find((t) => t.name === n) ?? null) !== stable(b.find((t) => t.name === n) ?? null));
    for (const n of names) out.push(`changes the deploy target ${n}`);
    if (!names.length) out.push("changes the deploy targets");
  }
  return [...new Set(out)];
}

/** The reasons as one line: the first, then " and {n} more". Pure. */
export const dryRunWhyLine = (reasons: readonly string[]): string => (reasons.length ? `${reasons[0]}${reasons.length > 1 ? ` and ${reasons.length - 1} more` : ""}` : "changes the project's setup");

/** One file a branch changes, as the Setup chat's proposal lists it: `setup` by the land gate's own rule. */
export type FileChange = "A" | "M" | "D" | "R";
export interface ChangedFile {
  path: string;
  status: FileChange;
  setup: boolean;
}

/**
 * Every file a branch changes against its target at `head` (from the merge base; renames as their new path), each
 * marked setup when the land gate counts it: `.sova/project.json` when its counted sections changed, and the release
 * playbook folder's files. Sorted by path; null when Git can't tell.
 */
export async function changedFilesOf(git: Git, root: string, base: string, head: string): Promise<ChangedFile[] | null> {
  const mb = await git(["merge-base", base, head], root);
  const from = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
  const diff = await git(["diff", "--name-status", "-M", from, head], root);
  if (diff.code !== 0) return null;
  const change = await setupChangeOf(git, root, base, head);
  const setupFiles = new Set(change?.files ?? []);
  const out: ChangedFile[] = [];
  for (const line of diff.stdout.split("\n")) {
    const parts = line.split("\t");
    const code = (parts[0] ?? "").trim();
    if (!code) continue;
    const path = (code.startsWith("R") ? parts[2] : parts[1]) ?? "";
    const status = (code[0] === "A" || code[0] === "D" || code[0] === "R" ? code[0] : "M") as FileChange;
    const setup = path === CONTRACT_FILE ? !!change && change.sections.length > 0 : setupFiles.has(path) || (code.startsWith("R") && setupFiles.has(parts[1] ?? ""));
    out.push({ path, status, setup });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The newest trial of exactly `commit`, if any. Pure. */
export function trialOf(trials: readonly MergeTrial[] | undefined, commit: string): MergeTrial | undefined {
  return (trials ?? []).find((t) => t.commit === commit);
}

/** Who stopped a dry run, in words ("you", "its chat", "a Sova restart", "a newer dry run of the branch"). Pure. */
export function stoppedByWords(st: NonNullable<MergeTrial["stopped"]> | undefined): string {
  if (!st) return "a Sova restart";
  return st.by === "operator" ? "you" : st.by === "chat" ? "its chat" : st.by === "restart" ? "a Sova restart" : "your Land, which runs its own dry run";
}

/** Why a setup branch at `commit` can't merge yet, or null when a dry run of that exact commit passed. Never "fix it":
 *  a stopped or machine's dry run says "run it again". Pure. */
export function untriedWhy(trials: readonly MergeTrial[] | undefined, commit: string): string | null {
  const t = trialOf(trials, commit);
  if (t?.verdict === "passed") return null;
  const head = commit.slice(0, 7);
  if (!t) return `This setup branch has no passing dry run at ${head}: run one first.`;
  if (t.verdict === "running") return `This setup branch's dry run at ${head} is still running: it merges once that passes.`;
  if (t.verdict === "void") return `This setup branch's dry run at ${head} was stopped by ${stoppedByWords(t.stopped)}: nothing failed. Run it again.`;
  if (t.verdict === "machine") return `This setup branch's dry run at ${head} couldn't run (${t.why ?? "the machine"}): that's the machine, not this branch. Run it again.`;
  return `This setup branch's dry run at ${head} failed: ${(t.failure?.line ?? t.why ?? "a check failed").replace(/\.$/, "")}.`;
}

const seconds = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/** The note a chat gets when a dry run ends (the chat that started it, and the branch's chat when a Land waits on it):
 *  its result, each check's result and time, and how to read a log. Never told to fix a failure the target shares,
 *  one that can't be told, a stopped dry run or a machine's. `land`: the Land that stopped it runs its own at that
 *  commit. Pure. */
export function trialEndedText(t: MergeTrial, run: MergeRun, opts: { target?: string; land?: { commit: string }; landWaits?: boolean } = {}): string {
  const branch = t.branch ?? "the commit";
  const what = `${branch} at ${t.commit.slice(0, 7)}`;
  const target = opts.target ?? "the target";
  if (t.verdict === "void" && t.stopped?.by === "superseded") {
    const at = opts.land?.commit ? ` at ${opts.land.commit.slice(0, 7)}` : "";
    return `The dry run of ${what} was stopped: the user's Land runs its own dry run of ${branch}${at}, then lands it by itself. Nothing failed; no need to start another.`;
  }
  const first = t.failure?.checks[0];
  const whose = t.failure?.whose === "master" ? `fails on ${target} too: not this branch's` : t.failure?.whose === "unclear" ? `can't tell whose failure: it fails on ${target} alone too` : "this branch's change breaks it";
  const head =
    t.verdict === "passed"
      ? `The dry run of ${what} passed: every new or changed check passed in the merge copy. Nothing was saved or merged.`
      : t.verdict === "void"
        ? `The dry run of ${what} was stopped by ${stoppedByWords(t.stopped)}: nothing failed. It needs a new dry run before it lands.`
        : t.verdict === "machine"
          ? `The dry run of ${what} couldn't run: ${t.why ?? "the merge copy couldn't run it"}: the machine, not this branch. Nothing was saved or merged.`
          : `The dry run of ${what} failed: ${first ? first.label : (t.why ?? "a check")} · ${whose}. Nothing was saved or merged.`;
  const lines = [head];
  for (const s of run.steps.filter((x) => x.kind === "check" || x.kind === "setup" || x.kind === "rerun-tip" || x.kind === "rerun-master")) lines.push(`- ${s.label}: ${s.result}, ${seconds(s.ms)}${s.detail ? ` (${s.detail})` : ""} · merge.logs {run: "${run.id}", step: "${s.id}"}`);
  for (const c of t.skipped ?? []) lines.push(`- ${c.label}: not run (unchanged merge check; it runs in the landing)`);
  for (const c of t.notRun ?? []) lines.push(`- ${c.label}: not run (unchanged release check; name it in checks to run it)`);
  if (t.verdict === "passed" && opts.landWaits) lines.push(`The user's Land stands: ${what} lands now by itself; nothing to do. Never ask them to land it.`);
  else if (t.verdict === "passed") lines.push("Land is offered on this branch at this exact commit; a new commit needs a new dry run.");
  else if (t.verdict === "void" || t.verdict === "machine") lines.push("Run it again with merge.try when the merge copy is free; nothing of the branch's needs changing for it.");
  else if (t.failure?.whose === "master" || t.failure?.whose === "unclear") lines.push("It isn't this branch's to fix: the user decides on the branch's row (Fix, Fix in New Chat, Run Dry Run Again or Land Anyway).");
  // With no Land waiting on it, this is a note: nothing to answer, nothing asked (a Land's failure comes as its own request).
  if (!opts.landWaits) lines.push("This is a note, not a request: there is nothing to answer with merge.respond. Tell your user what it found and end your turn; change nothing for it unless they ask.");
  return lines.join("\n");
}
