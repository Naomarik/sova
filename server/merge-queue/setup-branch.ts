/**
 * A setup branch (§app.merge-queue/setup): one whose changes reach the project's pipeline, the sections of
 * `.sova/project.json` the merge queue, releases and deploys act on (`merge`, `release`, `deploy`; a service only when a merge check requires it, the rest are conformance's), or
 * the files of the project's release playbook folder. The queue checks a branch with the target's checks, not the
 * branch's own, so such a branch is offered Land only once a trial (merge.try) of its exact head passed.
 *
 * Read from Git alone, at the two commits (never a worktree's files).
 */
import type { MergeRun, MergeTrial } from "../../shared/merge-queue";
import { CONTRACT_FILE, type MergeCheckDecl } from "../../shared/project-contract";
import type { Git } from "./guard";
import { setupChangeOf, stable } from "../../pi-config/extensions/worktrees/setup-rule.ts";

// The rule itself has one home, the worktree tool's (it refuses a plain merge of a setup branch by it).
export { changedSections, changedServices, DEFAULT_RELEASE_PLAYBOOK, isSetupChange, PIPELINE_SECTIONS, releaseFolders, requiredServices, type SetupChange, setupChangeOf, stable } from "../../pi-config/extensions/worktrees/setup-rule.ts";

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

/** Why a setup branch at `commit` can't land yet, or null when a trial of that exact commit passed. Pure. */
export function untriedWhy(trials: readonly MergeTrial[] | undefined, commit: string): string | null {
  const t = trialOf(trials, commit);
  if (t?.verdict === "passed") return null;
  const head = commit.slice(0, 7);
  if (!t) return `This setup branch has no passing trial at ${head}: run a trial of it first.`;
  if (t.verdict === "running") return `This setup branch's trial at ${head} is still running: land it once it passes.`;
  return `This setup branch's trial at ${head} did not pass (${t.why ?? t.verdict}): fix it and run a trial again.`;
}

const seconds = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/** The wake a chat gets when its trial ends: the verdict, each check's result and time, and how to read a log. Pure. */
export function trialEndedText(t: MergeTrial, run: MergeRun): string {
  const what = `${t.branch ?? "the commit"} at ${t.commit.slice(0, 7)}`;
  const head = t.verdict === "passed" ? `The trial of ${what} passed: every proposed check passed in the merge copy. Nothing was saved or merged.` : `The trial of ${what} did not pass (${t.why ?? t.verdict}). Nothing was saved or merged.`;
  const lines = [head];
  for (const s of run.steps.filter((x) => x.kind === "check" || x.kind === "setup" || x.kind === "rerun-tip")) lines.push(`- ${s.label}: ${s.result}, ${seconds(s.ms)}${s.detail ? ` (${s.detail})` : ""} · merge.logs {run: "${run.id}", step: "${s.id}"}`);
  for (const c of t.notRun ?? []) lines.push(`- ${c.label}: not run (unchanged release check; name it in checks to run it)`);
  lines.push(t.verdict === "passed" ? "Land is offered on this branch at this exact commit; a new commit needs a new trial." : "Fix what failed, commit, and run merge.try again.");
  return lines.join("\n");
}
